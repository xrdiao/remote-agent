// Watches every Cursor window and tells paired phones when an Agent finishes or is waiting for a decision.
// Delivery: Web Push (iPhone home-screen app, browsers) and a server-sent event stream (the Android app).
import fs from 'node:fs';
import path from 'node:path';
import webpush from 'web-push';
import { DATA_DIR, listDevices, updateDevice } from './auth.mjs';

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

const watching = (deviceId, targetId) => [...viewers].some(v => v.deviceId === deviceId && v.visible && v.targetId === targetId);
const wanted = () => streams.size > 0 || listDevices().some(d => d.push);

/* ---------- delivery ---------- */

// event.en holds the English title/body for devices whose app is set to English.
export async function deliver(event, onlyDevice = null) {
  const { en, ...zh } = event;
  for (const d of listDevices()) {
    if (onlyDevice ? d.id !== onlyDevice : watching(d.id, event.win)) continue;
    const payload = JSON.stringify(d.lang === 'en' && en ? { ...zh, ...en } : zh);
    for (const s of streams) if (s.deviceId === d.id) s.res.write(`data: ${payload}\n\n`);
    if (!d.push) continue;
    try {
      await webpush.sendNotification(d.push, payload, { TTL: 3600, urgency: 'high' });
    } catch (e) {
      // 404/410: the browser dropped the subscription (app removed, permission revoked).
      if (e.statusCode === 404 || e.statusCode === 410) updateDevice(d.id, { push: null });
      else console.log(`!! 推送到「${d.name}」失败：${e.statusCode || ''} ${e.body || e.message}`);
    }
  }
}

/* ---------- window watcher ---------- */

const windowName = title => {
  const host = /\[SSH: ([^\]]+)\]/.exec(title)?.[1];
  const folder = title.replace(/\s*\[SSH: [^\]]+\]\s*$/, '').split(' — ').pop().replace(/^●\s*/, '').trim() || title;
  return host ? `${folder} · ${host}` : folder;
};

function check(win, w, s) {
  const first = !w.seen;
  w.seen = true;
  const name = windowName(win.title);

  if (s.waiting !== w.waiting) { w.waiting = s.waiting; w.waitPolls = 0; w.told = first; }
  if (s.waiting && !w.told && ++w.waitPolls >= WAIT_POLLS) {
    w.told = true;
    deliver({ kind: 'waiting', win: win.id, title: `等你确认 · ${name}`, body: s.waitingText || 'Agent 在等你确认',
      en: { title: `Needs your OK · ${name}`, body: s.waitingText || 'The Agent is waiting for you' } });
  }

  if (s.busy) { w.busy = true; w.idle = 0; return; }
  if (!w.busy || ++w.idle < IDLE_POLLS) return;
  w.busy = false;
  if (!s.waiting) deliver({ kind: 'done', win: win.id, title: `已完成 · ${name}`, body: s.last || 'Agent 已停止',
    en: { title: `Done · ${name}`, body: s.last || 'The Agent has stopped' } });
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
        const s = await w.cdp.evaluate(probe);
        if (s) check(win, w, s);
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
