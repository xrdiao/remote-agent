// Watches agent windows and tells paired phones when an Agent finishes or is waiting for a decision.
// Delivery: Web Push (browsers), APNs through push-service (iPhone app) and a server-sent event stream (the Android app).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import webpush from 'web-push';
import { DATA_DIR, listDevices, updateDevice } from './auth.mjs';
import { sendLive } from './live.mjs';

const POLL_MS = 3000;
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

export function openEventStream(req, res, deviceId) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    'x-accel-buffering': 'no',
  });
  res.write(': connected\n\n');
  const entry = { deviceId, res };
  streams.add(entry);
  // Cloudflare drops connections idle for 100 s.
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => { clearInterval(ping); streams.delete(entry); });
}

export function closeEventStreams(deviceId) {
  for (const s of streams) if (s.deviceId === deviceId) { s.res.end(); streams.delete(s); }
}

export const addViewer = v => viewers.add(v);
export const removeViewer = v => viewers.delete(v);

// A phone that is looking at this exact thread does not need a push for it.
// Another thread, even in the same Codex window, still notifies.
const watching = (deviceId, event) => [...viewers].some(v => {
  if (v.deviceId !== deviceId || !v.visible) return false;
  if (event.threadId) return v.windowId === event.windowId && v.threadId === event.threadId;
  return v.targetId === event.win;
});
const wanted = () => streams.size > 0 || listDevices().some(d => (d.push || d.apns) && d.pushEnabled !== false);

/* ---------- delivery ---------- */

// event.en holds the English title/body for devices whose app is set to English.
export async function deliver(event, onlyDevice = null) {
  const { en, ...zh } = event;
  for (const d of listDevices()) {
    const skip = onlyDevice ? d.id !== onlyDevice : event.kind !== 'end' && event.kind !== 'tasks' && watching(d.id, event);
    const mine = [...streams].filter(s => s.deviceId === d.id);
    if (event.kind !== 'test' && (mine.length || skip && watching(d.id, event))) console.log(`[事件] ${event.kind} → ${d.name}：${skip ? '手机正在看这个会话，已跳过' : `${mine.length} 条连接`}`);
    const msg = d.lang === 'en' && en ? { ...zh, ...en } : zh;
    // Live Activities update even while the phone is watching: iOS hides an app's own activity in the foreground anyway.
    if (d.apns && d.pushEnabled !== false && !onlyDevice) sendLive(d, event, msg);
    if (skip) continue;
    const payload = JSON.stringify(msg);
    for (const s of mine) s.res.write(`data: ${payload}\n\n`);
    if (d.pushEnabled === false || ['working', 'end', 'tasks'].includes(event.kind)) continue;
    if (d.push) {
      try {
        await webpush.sendNotification(d.push, payload, { TTL: 3600, urgency: 'high' });
      } catch (e) {
        // 404/410: the browser dropped the subscription (app removed, permission revoked).
        if (e.statusCode === 404 || e.statusCode === 410) updateDevice(d.id, { push: null });
        else console.log(`!! 推送到「${d.name}」失败：${e.statusCode || ''} ${e.body || e.message}`);
      }
    }
    if (d.apns) await sendApns(d, msg, event);
  }
}

// The push service signs and sends to APNs; this relay only holds its url and the pushId/secret pair.
async function sendApns(d, msg, event) {
  try {
    const r = await fetch(d.apns.url + '/v1/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pushId: d.apns.pushId, secret: d.apns.secret, title: msg.title, body: msg.body,
        data: { win: event.win, windowId: event.windowId, threadId: event.threadId, kind: event.kind } }),
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

function check(win, w, s) {
  const thread = s.thread || '';
  const conversation = thread || s.agentId || '';
  const app = { cursor: 'Cursor', codex: 'Codex', devin: 'Devin' }[win.app] || '';
  const name = windowName(win.title, app);
  const threadName = s.title && s.title !== name ? s.title : '';
  const where = [app, name, threadName].filter(Boolean).join(' · ');
  const pc = os.hostname().replace(/\.local$/, '').slice(0, 24);
  const event = extra => ({
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
  const working = quiet => deliver(event({ kind: 'working', quiet: !!quiet, startedAt: w.startedAt || Date.now(), title: `${pc} · 工作中 · ${where}`, body: '正在工作…',
    en: { title: `${pc} · Working · ${where}`, body: 'Working…' } }));
  // Opening a different thread is not that thread finishing. Start tracking it fresh.
  if (w.thread !== conversation) {
    w.thread = conversation;
    w.seen = true;
    w.busy = !!s.busy;
    w.idle = 0;
    w.waiting = s.waiting || null;
    w.waitPolls = 0;
    w.told = true;
    w.taskSig = undefined;
    w.taskShown = false;
    w.startedAt = s.busy ? Date.now() : 0;
    if (s.busy) working(false);
    return;
  }
  if (s.busy && !w.busy) w.startedAt = Date.now();

  if (s.waiting !== w.waiting) { w.waiting = s.waiting; w.waitPolls = 0; w.told = false; }
  if (s.waiting && !w.told && ++w.waitPolls >= WAIT_POLLS) {
    w.told = true;
    w.waitShown = true;
    deliver(event({ kind: 'end' }));
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
  if (!w.busy || ++w.idle < IDLE_POLLS) return;
  w.busy = false;
  w.startedAt = 0;
  deliver(event({ kind: 'end' }));
  if (w.taskShown && !s.waiting) {
    const [done, total] = w.taskSig.split('/').map(Number);
    deliver(event({ kind: 'tasks', stopped: true, done, total, current: '', title: `${pc} · 任务已停止 ${done}/${total} · ${where}`, body: 'Agent 已停止，任务未全部完成',
      en: { title: `${pc} · Tasks stopped ${done}/${total} · ${where}`, body: 'The Agent stopped before all tasks were done' } }));
    w.taskShown = false;
  }
  if (!s.waiting) deliver(event({ kind: 'done', ...extras(s, true), title: `${pc} · 已完成 · ${where}`, body: s.last || 'Agent 已停止',
    en: { title: `${pc} · Done · ${where}`, body: s.last || 'The Agent has stopped' } }));
}

// listWindows/openCdp/probe come from the relay so this module shares its CDP code.
export function startWatcher({ listWindows, openCdp, probe }) {
  const watched = new Map();   // target id -> { cdp, seen, busy, idle, waiting }
  const drop = id => { watched.get(id)?.cdp.close(); watched.delete(id); };

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
        w.cdp.onclose = () => watched.delete(win.id);
        watched.set(win.id, w);
      }
      try {
        const states = await w.cdp.evaluate(probe);
        if (!w.threads) w.threads = new Map();
        for (const s of states || []) {
          const id = s.thread || s.agentId || '';
          if (!w.threads.has(id)) w.threads.set(id, {});
          check(win, w.threads.get(id), s);
        }
      } catch {}
    }));
  };

  let running = false;
  setInterval(async () => {
    if (running) return;
    running = true;
    try { await tick(); } finally { running = false; }
  }, POLL_MS);
}
