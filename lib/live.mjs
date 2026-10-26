// iOS Live Activities for running agents: turns notify events into liveactivity pushes via the push service.
// Each tracked thread is an activity keyed `win|windowId|threadId`; updates and ends ride the same channel.
const LABELS = {
  zh: { working: '工作中', waiting: '等你确认', done: '已完成', stopped: '任务已停止' },
  en: { working: 'Working', waiting: 'Needs your OK', done: 'Done', stopped: 'Tasks stopped' },
};

export function nextLive(prev, event, msg, lang) {
  const t = LABELS[lang === 'en' ? 'en' : 'zh'];
  const base = prev ?? { phase: 'working', label: '', detail: '', done: 0, total: 0, startedAt: (event.startedAt || Date.now()) / 1000 };
  switch (event.kind) {
    case 'end':
      return event.terminal ? { event: 'end', priority: 10, dismissAt: Math.floor(Date.now() / 1000), state: { ...base, phase: 'stopped', label: t.stopped, detail: '' } } : null;
    case 'working':
      // Back from waiting/stopped: drop that phase's text (the question) instead of showing it under 工作中.
      return { event: 'update', priority: 5, state: { ...base, phase: 'working', label: t.working, detail: base.phase === 'working' ? base.detail : '', startedAt: event.startedAt ? event.startedAt / 1000 : base.startedAt } };
    case 'tasks': {
      const phase = event.stopped ? 'stopped' : base.phase === 'waiting' ? 'waiting' : 'working';
      return { event: 'update', priority: 5, state: { ...base, done: event.done || 0, total: event.total || 0, detail: msg.body, phase, label: t[phase] } };
    }
    case 'waiting':
      return { event: 'update', priority: 10, state: { ...base, phase: 'waiting', label: t.waiting, detail: msg.body } };
    case 'done':
      // Gone at once: the regular "done" notification carries the result (and covers phones without Live Activities).
      return { event: 'end', priority: 10, dismissAt: Math.floor(Date.now() / 1000), state: { ...base, phase: 'done', label: t.done, detail: msg.body } };
    default: return null;
  }
}

const states = new Map();   // `${deviceId}|${key}` -> latest content-state
const chains = new Map();   // same -> in-flight promise, serializing updates per activity

async function doSendLive(d, event, msg, key, mapKey) {
  const next = nextLive(states.get(mapKey) || null, event, msg, d.lang);
  if (!next) return;
  if (next.event === 'end') states.delete(mapKey);
  else states.set(mapKey, next.state);
  const r = await fetch(`${d.apns.url}/v1/live`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      pushId: d.apns.pushId, secret: d.apns.secret, key, event: next.event, state: next.state,
      attributes: { computer: event.computer, win: event.win, windowId: event.windowId, threadId: event.threadId, app: event.appName, project: event.project, thread: event.threadName, pc: event.pc },
      alert: { title: msg.title, body: msg.body },
      priority: next.priority, dismissAt: next.dismissAt,
    }),
    signal: AbortSignal.timeout(10000),
  });
  if (r.status === 410) {
    // The iPhone uninstalled the app or re-registered elsewhere.
    const { updateDevice } = await import('./auth.mjs');
    updateDevice(d.id, { apns: null });
  } else if (!r.ok) {
    console.log(`!! 实时活动「${d.name}」失败：${r.status} ${(await r.json().catch(() => ({}))).error || ''}`);
  }
}

// check() fires deliver() without awaiting; serialize per activity so an 'end' can't jump ahead of its updates.
export function sendLive(d, event, msg) {
  const key = `${event.computer}|${event.win}|${event.windowId}|${event.threadId}`;
  const mapKey = `${d.id}|${key}`;
  const run = (chains.get(mapKey) || Promise.resolve()).then(() => doSendLive(d, event, msg, key, mapKey)).catch(e => {
    console.log(`!! 实时活动「${d.name}」失败：${e.message}`);
  });
  chains.set(mapKey, run);
  run.finally(() => { if (chains.get(mapKey) === run) chains.delete(mapKey); });
}
