// Watches agent windows and tells paired phones when an Agent finishes or is waiting for a decision.
// Delivery: Web Push (browsers), APNs through push-service (iPhone app) and a server-sent event stream (the Android app).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import webpush from 'web-push';
import { DATA_DIR, computerId, listDevices, updateDevice, bindDeviceConnection } from './auth.mjs';
import { sendLive } from './live.mjs';

const POLL_MS = 3000;
// No app connection in this long: stop pushing (a phone that deleted this computer while offline never says goodbye).
const PUSH_IDLE_MS = 30 * 24 * 3600 * 1000;
// Agent stop button flickers between steps; require it gone for this many polls before calling the run finished.
const IDLE_POLLS = 2;
// Auto-run / auto-review flash Run/Skip for a few seconds before approving by themselves; a real wait lasts longer.
const WAIT_POLLS = 3;

/* ---------- Web Push keys ---------- */

function vapid() {
  const file = path.join(DATA_DIR, 'vapid.json');
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  const keys = webpush.generateVAPIDKeys();
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(keys, null, 2) + '\n', { mode: 0o600 });
  return keys;
}
const keys = vapid();
// Apple's push service rejects VAPID tokens without a mailto: or https: subject.
webpush.setVapidDetails('https://github.com/xrdiao/remote-agent', keys.publicKey, keys.privateKey);
export const pushPublicKey = () => keys.publicKey;

/* ---------- who is listening / looking ---------- */

const streams = new Set();   // { deviceId, res } from GET /api/events
const viewers = new Set();   // live app sessions: { deviceId, targetId, visible }
// "working" notifications stay up until their 'end'; track the live ones so an end can be
// synthesized when a thread vanishes and replayed to a phone that reconnects mid-run.
const activeWorking = new Map();   // `${win}|${windowId}|${threadId}` -> the working event sent
const keyOf = e => `${e.win}|${e.windowId}|${e.threadId}`;
// "end"/"done"/"waiting" that found a stream-only phone (no Web Push / APNs) disconnected: handed
// over when its stream comes back, so a finished run is still announced and its stopwatch stopped.
const MISSED_MS = 15 * 60 * 1000;
const missed = new Map();   // deviceId -> [{ event, at }]
const doneSent = new Map(); // device + thread + run -> terminal notification
const DONE_SENT_LIMIT = 4096;
let notifySeq = Date.now() * 1000;
const pushChains = new Map();
const pushLatest = new Map();
const WATCH_LOCK = path.join(DATA_DIR, 'notify-watcher.lock');

function acquireWatchLock() {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  try {
    const fd = fs.openSync(WATCH_LOCK, 'wx');
    fs.writeFileSync(fd, `${process.pid}\n`);
    fs.closeSync(fd);
    const release = () => {
      try { if (fs.readFileSync(WATCH_LOCK, 'utf8').trim() === String(process.pid)) fs.unlinkSync(WATCH_LOCK); } catch {}
    };
    process.once('exit', release);
    return release;
  } catch (error) {
    if (error.code !== 'EEXIST') return null;
    let pid = 0;
    try { pid = Number(fs.readFileSync(WATCH_LOCK, 'utf8').trim()); } catch {}
    if (pid) {
      try { process.kill(pid, 0); return null; } catch {}
    }
    try { fs.unlinkSync(WATCH_LOCK); } catch {}
    return acquireWatchLock();
  }
}

export function openEventStream(req, res, deviceId) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    'x-accel-buffering': 'no',
  });
  res.write(': connected\n\n');
  const entry = { deviceId, res, sent: new Set() };
  streams.add(entry);
  const authorization = bindDeviceConnection(deviceId, () => res.end());
  res.on('close', () => authorization.release());
  // The phone missed everything while disconnected: first what happened meanwhile (an old run's "end"
  // must not land after a newer run's "working"), then the runs that are still going.
  const dev = listDevices().find(d => d.id === deviceId);
  for (const { event: e, at } of missed.get(deviceId) || []) {
    if (Date.now() - at > MISSED_MS || (e.kind !== 'end' && watching(deviceId, e))) continue;
    const { en, ...zh } = e;
    res.write(`data: ${JSON.stringify(dev?.lang === 'en' && en ? { ...zh, ...en } : zh)}\n\n`);
  }
  missed.delete(deviceId);
  replayWorking(entry, dev);
  // Cloudflare drops connections idle for 100 s.
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  // Which phones' background notification streams are live: without one, "end"/"done" can't reach that phone.
  console.log(`[通知流] ${dev?.name || deviceId} 已连接`);
  req.on('close', () => { clearInterval(ping); streams.delete(entry); console.log(`[通知流] ${dev?.name || deviceId} 已断开`); });
}

// A 'working' skipped while the phone watched that thread is handed over once it stops watching
// (app in the background, another thread, socket gone); until its 'end', at most once per stream.
function replayWorking(entry, dev) {
  for (const [key, e] of activeWorking) {
    if (entry.sent.has(key) || watching(entry.deviceId, e)) continue;
    dev ||= listDevices().find(d => d.id === entry.deviceId);
    const { en, ...zh } = e;
    entry.res.write(`data: ${JSON.stringify(dev?.lang === 'en' && en ? { ...zh, ...en } : zh)}\n\n`);
    entry.sent.add(key);
  }
}

export function closeEventStreams(deviceId) {
  for (const s of streams) if (s.deviceId === deviceId) { s.res.end(); streams.delete(s); }
}

export const addViewer = v => viewers.add(v);
export const removeViewer = v => viewers.delete(v);

// A phone that is looking at this exact thread does not need a push for it.
// Another thread, even in the same Codex window, still notifies.
const watching = (deviceId, event) => [...viewers].some(v => {
  if (v.deviceId !== deviceId || v.notifyVisible === false || Date.now() - (v.notifyPresenceAt || 0) > 45000) return false;
  if (event.threadId) return v.windowId === event.windowId && v.threadId === event.threadId;
  return v.targetId === event.win;
});
const wanted = () => streams.size > 0 || listDevices().some(d => (d.push || d.apns) && d.pushEnabled !== false);

/* ---------- delivery ---------- */

// event.en holds the English title/body for devices whose app is set to English.
const staleWarned = new Set();
export async function deliver(event, onlyDevice = null) {
  event = { computer: computerId(), ...event };
  if (!event.seq) event = { ...event, seq: ++notifySeq, createdAt: event.createdAt || Date.now() };
  else if (!event.createdAt) event = { ...event, createdAt: Date.now() };
  const { en, dedupe, ...zh } = event;
  if (event.kind === 'end') for (const s of streams) s.sent.delete(keyOf(event));
  if (event.kind === 'working') {
    for (const [deviceId, list] of missed) {
      const rest = list.filter(item => keyOf(item.event) !== keyOf(event));
      if (rest.length) missed.set(deviceId, rest); else missed.delete(deviceId);
    }
  }
  // Pass 1 is fully synchronous and reaches every device's SSE stream in order; the slow
  // awaited pushes (pass 2) can then never delay an 'end' behind a 'working' on another device.
  const pushes = [];
  for (const d of listDevices()) {
    const skip = onlyDevice ? d.id !== onlyDevice : event.kind !== 'end' && event.kind !== 'tasks' && watching(d.id, event);
    const mine = [...streams].filter(s => s.deviceId === d.id);
    if (event.kind !== 'test' && (mine.length || skip && watching(d.id, event))) console.log(`[事件] ${event.kind} → ${d.name}：${skip ? '手机正在看这个会话，已跳过' : `${mine.length} 条连接`}`);
    const msg = d.lang === 'en' && en ? { ...zh, ...en } : zh;
    // Long-gone devices get no pushes (Web Push, APNs, Live Activities); the pairing and the SSE streams stay.
    // lastSeen is stamped on connect, so a session that has stayed open for weeks counts as present too.
    const idle = Date.now() - (d.lastSeen || d.created || 0) > PUSH_IDLE_MS && ![...viewers].some(v => v.deviceId === d.id);
    if (idle && (d.push || d.apns) && !staleWarned.has(d.id)) {
      staleWarned.add(d.id);
      console.log(`[推送] 「${d.name}」30 天未连接，已停止推送`);
    }
    // Live Activities update even while the phone is watching: iOS hides an app's own activity in the foreground anyway.
    if (!idle && d.apns && d.pushEnabled !== false && !onlyDevice) sendLive(d, event, msg);
    if (skip) {
      if (event.kind === 'working') for (const s of mine) s.sent.delete(keyOf(event));
      continue;
    }
    if (event.kind === 'done' && dedupe) {
      const key = `${d.id}|${keyOf(event)}|${dedupe}`;
      if (doneSent.has(key)) continue;
      doneSent.set(key, Date.now());
      if (doneSent.size > DONE_SENT_LIMIT) doneSent.delete(doneSent.keys().next().value);
    }
    const payload = JSON.stringify(msg);
    for (const s of mine) {
      s.res.write(`data: ${payload}\n\n`);
      if (event.kind === 'working') s.sent.add(keyOf(event));
    }
    if (!mine.length && !onlyDevice && !d.push && !d.apns && ['end', 'done', 'waiting'].includes(event.kind)) {
      const list = (missed.get(d.id) || []).filter(m => Date.now() - m.at < MISSED_MS && keyOf(m.event) !== keyOf(event));
      missed.set(d.id, [...list, { event, at: Date.now() }].slice(-19));
    }
    if (mine.length || d.pushEnabled === false || ['working', 'end', 'tasks'].includes(event.kind)) continue;
    pushes.push({ d, payload, msg, idle });
  }
  for (const { d, payload, msg, idle } of pushes) {
    if (idle) continue;
    const chainKey = `${d.id}|${keyOf(event)}`;
    const seq = Number(event.seq) || 0;
    if (seq && seq < (pushLatest.get(chainKey) || 0)) continue;
    if (seq) pushLatest.set(chainKey, seq);
    const previous = pushChains.get(chainKey) || Promise.resolve();
    const run = previous.catch(() => {}).then(async () => {
      if (seq && seq < (pushLatest.get(chainKey) || seq)) return;
      if (d.push) {
        try {
          await webpush.sendNotification(d.push, payload, { TTL: 120, urgency: 'high' });
        } catch (e) {
          // 404/410: the browser dropped the subscription (app removed, permission revoked).
          if (e.statusCode === 404 || e.statusCode === 410) updateDevice(d.id, { push: null });
          else console.log(`!! 推送到「${d.name}」失败：${e.statusCode || ''} ${e.body || e.message}`);
        }
      }
      if (d.apns) await sendApns(d, msg, event);
    });
    pushChains.set(chainKey, run);
    run.finally(() => {
      if (pushChains.get(chainKey) === run) pushChains.delete(chainKey);
      if (pushLatest.get(chainKey) === seq) pushLatest.delete(chainKey);
    });
  }
}

// The push service signs and sends to APNs; this relay only holds its url and the pushId/secret pair.
async function sendApns(d, msg, event) {
  try {
    const r = await fetch(d.apns.url + '/v1/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pushId: d.apns.pushId, secret: d.apns.secret, title: msg.title, body: msg.body,
        data: { computer: event.computer, win: event.win, windowId: event.windowId, threadId: event.threadId, kind: event.kind, seq: event.seq, createdAt: event.createdAt } }),
      signal: AbortSignal.timeout(10000),
    });
    // 410: the iPhone uninstalled the app or revoked permission.
    if (r.status === 410) updateDevice(d.id, { apns: null });
    else if (!r.ok) console.log(`!! 推送到「${d.name}」失败：APNs ${r.status} ${(await r.json().catch(() => ({}))).error || ''}`);
  } catch (e) {
    console.log(`!! 推送到「${d.name}」失败：${e.message}`);
  }
}

/* ---------- window watcher ---------- */

// The app name is shown separately, so drop the editor's own " - Cursor" suffix from the title.
const windowName = (full, app = '') => {
  const suffix = app ? new RegExp(`\\s+[-—–]\\s+${app}$`, 'i') : null;
  // Titles look like "<editor> - <folder> - Cursor"; after stripping the app keep just the folder part.
  const title = suffix?.test(full) ? full.replace(suffix, '').split(' - ').pop() : full;
  const host = /\[SSH: ([^\]]+)\]/.exec(title)?.[1];
  const folder = title.replace(/\s*\[SSH: [^\]]+\]\s*$/, '').split(' — ').pop().replace(/^●\s*/, '').trim() || title;
  return host ? `${folder} · ${host}` : folder;
};

// Devin notifications can be answered in place: reply, pick a single-choice option, accept the file changes.
// The ids are handled by the relay's POST /api/act; the Android app supplies the labels.
const extras = (s, done) => s.devin
  ? { reply: true, actions: [...(s.actions || []), ...(done && s.changed > 0 ? [{ id: 'acceptAll' }] : [])] }
  : {};

// A delivered 'working' outlives its thread state: if the thread disappears before its 'end',
// the phone would keep the stopwatch running, so deliver one for the remembered event.
const clearWorking = w => {
  if (!w.workingEvent) return;
  activeWorking.delete(keyOf(w.workingEvent));
  w.workingEvent = null;
};
const endWorking = w => {
  const e = w.workingEvent;
  clearWorking(w);
  if (e) deliver({ win: e.win, windowId: e.windowId, threadId: e.threadId, kind: 'end', terminal: true });
};

function check(win, w, s) {
  const thread = s.thread || '';
  const conversation = thread || s.agentId || '';
  let nativeKey = s.runId ? `native:${s.runId}` : s.generation?.start ? `generation:${s.generation.start}` : '';
  const runAt = Number.isFinite(s.runAt) ? s.runAt : Number.isFinite(s.generation?.start) ? s.generation.start : null;
  const runIndex = Number.isFinite(s.runIndex) ? s.runIndex : null;
  const app = { cursor: 'Cursor', codex: 'Codex', devin: 'Devin' }[win.app] || '';
  const name = windowName(win.title, app);
  const threadName = s.title && s.title !== name ? s.title : '';
  const where = [app, name, threadName].filter(Boolean).join(' · ');
  const pc = os.hostname().replace(/\.local$/, '').slice(0, 24);
  const event = extra => ({
    seq: ++notifySeq,
    createdAt: Date.now(),
    win: win.app === 'codex' ? 'codex' : win.id,
    windowId: win.pageId || win.id,
    threadId: thread,
    appName: app,
    project: name,
    threadName,
    pc,
    question: s.waiting || '',
    ...extra,
  });
  const working = quiet => {
    const e = event({ kind: 'working', quiet: !!quiet, startedAt: w.startedAt || Date.now(), title: `${pc} · 工作中 · ${where}`, body: '正在工作…',
      en: { title: `${pc} · Working · ${where}`, body: 'Working…' } });
    w.workingEvent = e;
    activeWorking.set(keyOf(e), e);
    deliver(e);
  };
  // Opening a different thread is not that thread finishing. Start tracking it fresh —
  // but if the old identity still has a working notification up, end it first.
  if (w.thread !== conversation) {
    endWorking(w);
    w.thread = conversation;
    w.seen = true;
    w.busy = !!s.busy;
    w.idle = 0;
    w.waiting = s.waiting || null;
    w.waitPolls = 0;
    w.told = true;
    w.taskSig = undefined;
    w.taskShown = false;
    w.doneKey = s.busy ? '' : nativeKey;
    w.doneLast = s.busy ? '' : s.last || '';
    w.runSeq = 0;
    w.runKey = nativeKey;
    w.runAt = runAt;
    w.runIndex = runIndex;
    w.startedAt = s.busy ? Date.now() : 0;
    if (s.busy) { w.runSeq = 1; working(false); }
    return;
  }
  const older = runIndex != null && w.runIndex != null && runIndex !== w.runIndex ? runIndex < w.runIndex
    : runAt != null && w.runAt != null && runAt < w.runAt;
  if (older) return;
  if (runAt != null && runAt === w.runAt) {
    if (nativeKey.startsWith('native:devin:time:') && w.runKey?.startsWith('native:devin:acp:')) nativeKey = w.runKey;
    else if (nativeKey.startsWith('native:devin:acp:') && w.runKey?.startsWith('native:devin:time:') && w.doneKey === w.runKey) w.doneKey = nativeKey;
  }
  if (nativeKey) w.runKey = nativeKey;
  if (runAt != null) w.runAt = Math.max(w.runAt ?? runAt, runAt);
  if (runIndex != null) w.runIndex = Math.max(w.runIndex ?? runIndex, runIndex);
  if (!w.busy && !s.busy && nativeKey && !/^(native|generation):/.test(w.doneKey)) {
    w.doneKey = w.runKey = nativeKey;
    w.doneLast = s.last || '';
  }

  if (s.busy && !w.busy) {
    w.startedAt = Date.now();
    if (nativeKey && nativeKey !== w.doneKey) w.runKey = nativeKey;
    else if (!w.doneKey) { w.runSeq = (w.runSeq || 0) + 1; w.runKey = ''; }
  }

  if (s.waiting !== w.waiting) { w.waiting = s.waiting; w.waitPolls = 0; w.told = false; }
  if (s.waiting && !w.told && ++w.waitPolls >= WAIT_POLLS) {
    w.told = true;
    w.waitShown = true;
    deliver(event({ kind: 'end' }));
    clearWorking(w);
    deliver(event({ kind: 'waiting', ...extras(s, false), title: `${pc} · 等你确认 · ${where}`, body: s.waitingText || 'Agent 在等你确认',
      en: { title: `${pc} · Needs your OK · ${where}`, body: s.waitingText || 'The Agent is waiting for you' } }));
  }

  const t = s.tasks;
  if (t && t.total > 0) {
    const sig = `${t.done}/${t.total}`;
    if (sig !== w.taskSig) {
      if (w.taskSig !== undefined || (s.busy && t.done < t.total)) {
        const wasShown = w.taskShown;
        w.taskShown = true;
        deliver(event({ kind: 'tasks', done: t.done, total: t.total, current: t.current || '', title: `${pc} · 任务 ${t.done}/${t.total} · ${where}`,
          body: t.done >= t.total ? '全部任务已完成' : (t.current || '进行中'),
          en: { title: `${pc} · Tasks ${t.done}/${t.total} · ${where}`, body: t.done >= t.total ? 'All tasks done' : (t.current || 'In progress') } }));
        if (t.done >= t.total) {
          w.taskShown = false;
          if (s.busy) working(false);
        } else if (!wasShown && s.busy) {
          working(true);
        }
      }
      w.taskSig = sig;
    }
  }

  const waitCleared = w.waitShown && !s.waiting;
  if (waitCleared) w.waitShown = false;
  if (s.busy && (!w.busy || waitCleared)) working(w.taskShown);
  if (s.busy) { w.busy = true; w.idle = 0; return; }
  if (!nativeKey && /^(native|generation):/.test(w.runKey || w.doneKey)) return;
  if (!w.busy || ++w.idle < IDLE_POLLS) return;
  w.busy = false;
  w.startedAt = 0;
  deliver(event({ kind: 'end' }));
  clearWorking(w);
  if (w.taskShown && !s.waiting) {
    const [done, total] = w.taskSig.split('/').map(Number);
    deliver(event({ kind: 'tasks', stopped: true, done, total, current: '', title: `${pc} · 任务已停止 ${done}/${total} · ${where}`, body: 'Agent 已停止，任务未全部完成',
      en: { title: `${pc} · Tasks stopped ${done}/${total} · ${where}`, body: 'The Agent stopped before all tasks were done' } }));
    w.taskShown = false;
  }
  if (!s.waiting) {
    if (nativeKey && nativeKey !== w.doneKey) w.runKey = nativeKey;
    else if (w.doneKey && !nativeKey && !/^(native|generation):/.test(w.doneKey) && s.last !== w.doneLast) w.runKey = `run:${++w.runSeq}`;
    if (!w.runKey) w.runKey = nativeKey || `run:${w.runSeq || 0}`;
    const doneKey = w.runKey;
    if (doneKey !== w.doneKey) {
      w.doneKey = doneKey;
      w.doneLast = s.last || '';
      deliver(event({ kind: 'done', ...extras(s, true), title: `${pc} · 已完成 · ${where}`, body: s.last || 'Agent 已停止',
        en: { title: `${pc} · Done · ${where}`, body: s.last || 'The Agent has stopped' }, dedupe: doneKey }));
    }
  }
}

// Read the relay's existing window source; notification delivery keeps its own event state.
export function startWatcher({ listWindows, openCdp, readStates }) {
  const releaseWatchLock = acquireWatchLock();
  if (!releaseWatchLock) {
    console.log('[通知] 已有中继负责通知 watcher，当前实例跳过');
    return;
  }
  const watched = new Map();   // target id -> { cdp, seen, busy, idle, waiting, threads }
  const drop = id => {
    const w = watched.get(id);
    if (w?.threads) for (const t of w.threads.values()) endWorking(t);
    w?.cdp.close();
    watched.delete(id);
  };

  const tick = async () => {
    if (!wanted()) { for (const id of [...watched.keys()]) drop(id); return; }
    let wins;
    try { wins = await listWindows(); } catch { return; }
    for (const id of [...watched.keys()]) if (!wins.some(w => w.id === id)) drop(id);
    await Promise.all(wins.map(async win => {
      let w = watched.get(win.id);
      if (!w) {
        try {
          w = { cdp: await openCdp(win.ws) };
        } catch { return; }
        w.cdp.onclose = () => {
          if (w.threads) for (const t of w.threads.values()) endWorking(t);
          watched.delete(win.id);
        };
        watched.set(win.id, w);
      }
      try {
        const states = await readStates(w.cdp);
        if (!w.threads) w.threads = new Map();
        const seen = new Set();
        for (const s of states || []) {
          const id = s.thread || s.agentId || '';
          seen.add(id);
          if (!w.threads.has(id)) w.threads.set(id, {});
          check(win, w.threads.get(id), s);
        }
        // A busy thread that stops being reported (session closed, id changed) would keep its
        // "working" notification forever; after ~30 s missing, end it and forget the thread.
        for (const [id, t] of w.threads) {
          if (seen.has(id)) { t.missing = 0; continue; }
          if (++t.missing >= IDLE_POLLS * 5) {
            endWorking(t);
            t.busy = false;
            t.startedAt = 0;
            w.threads.delete(id);
          }
        }
      } catch {}
    }));
  };

  let running = false;
  setInterval(async () => {
    if (running) return;
    running = true;
    try { await tick(); } finally { running = false; }
    for (const s of streams) replayWorking(s);
  }, POLL_MS);
}
