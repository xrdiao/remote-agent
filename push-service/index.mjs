// iOS push relay: keeps APNs tokens off the user's relay. The app registers its token here and gets {pushId, secret};
// the relay later posts notifications to /v1/send with those credentials.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import http2 from 'node:http2';
import path from 'node:path';

const env = process.env;
const required = ['APNS_KEY_FILE', 'APNS_KEY_ID', 'APNS_TEAM_ID', 'APNS_TOPIC', 'DATA_DIR'];
const missing = required.filter(k => !env[k]);
if (missing.length) {
  console.error(`缺少环境变量：${missing.join(', ')}（见 push-service/README.md）`);
  process.exit(1);
}
const config = {
  port: Number(env.PORT || 8787),
  host: env.HOST || '127.0.0.1',
  keyId: env.APNS_KEY_ID,
  teamId: env.APNS_TEAM_ID,
  topic: env.APNS_TOPIC,
  defaultEnv: env.APNS_ENV || 'production',
  dataDir: env.DATA_DIR,
};
if (!['production', 'sandbox'].includes(config.defaultEnv)) {
  console.error('APNS_ENV 只能是 production 或 sandbox');
  process.exit(1);
}
const apnsKey = fs.readFileSync(env.APNS_KEY_FILE, 'utf8');
crypto.createPrivateKey(apnsKey);

const LIMIT = 8 * 1024;
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const ENVS = ['production', 'sandbox'];
const HOSTS = { production: 'https://api.push.apple.com', sandbox: 'https://api.sandbox.push.apple.com' };
const DEAD_REASONS = ['BadDeviceToken', 'DeviceTokenNotForTopic'];

/* ---------- storage ---------- */

const file = path.join(config.dataDir, 'registrations.json');
fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
let regs = {};
try { regs = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }

function save() {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(regs), { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

const sha = s => crypto.createHash('sha256').update(s).digest();
const secretOk = (reg, secret) => typeof secret === 'string' && crypto.timingSafeEqual(sha(secret), Buffer.from(reg.secretHash, 'hex'));
const lookup = pushId => (typeof pushId === 'string' && Object.hasOwn(regs, pushId)) ? regs[pushId] : null;

/* ---------- rate limits (fixed windows, in memory) ---------- */

const windows = new Map();
function hit(key, limit, ms) {
  const now = Date.now();
  let w = windows.get(key);
  if (!w || now >= w.reset) { w = { count: 0, reset: now + ms }; windows.set(key, w); }
  return ++w.count <= limit;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, w] of windows) if (now >= w.reset) windows.delete(k);
}, MIN).unref();

/* ---------- APNs ---------- */

let jwtCache = null;
function providerToken(force) {
  const now = Math.floor(Date.now() / 1000);
  if (!force && jwtCache && now - jwtCache.iat < 50 * 60) return jwtCache.jwt;
  const head = Buffer.from(JSON.stringify({ alg: 'ES256', kid: config.keyId })).toString('base64url');
  const claims = Buffer.from(JSON.stringify({ iss: config.teamId, iat: now })).toString('base64url');
  const input = `${head}.${claims}`;
  const sig = crypto.sign('sha256', Buffer.from(input), { key: apnsKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  jwtCache = { iat: now, jwt: `${input}.${sig}` };
  return jwtCache.jwt;
}

const sessions = new Map();
function session(envName) {
  let s = sessions.get(envName);
  if (s && !s.closed && !s.destroyed) return s;
  s = http2.connect(HOSTS[envName]);
  const drop = () => { if (sessions.get(envName) === s) sessions.delete(envName); };
  s.on('error', drop);
  s.on('close', drop);
  s.on('goaway', () => { drop(); s.close(); });
  sessions.set(envName, s);
  return s;
}

function apnsPost(envName, headers, body) {
  return new Promise((resolve, reject) => {
    const req = session(envName).request({ ':method': 'POST', ...headers });
    let status = 0, data = '', done = false;
    const finish = (fn, v) => { if (!done) { done = true; clearTimeout(timer); fn(v); } };
    const timer = setTimeout(() => { req.close(http2.constants.NGHTTP2_CANCEL); finish(reject, new Error('APNs 超时')); }, 10000);
    req.setEncoding('utf8');
    req.on('response', h => { status = h[':status']; });
    req.on('data', c => { data += c; });
    req.on('end', () => {
      let reason = '';
      try { reason = JSON.parse(data).reason || ''; } catch {}
      finish(resolve, { status, reason });
    });
    req.on('error', e => finish(reject, e));
    req.end(body);
  });
}

// One APNs request for any push type: alerts to the app topic, liveactivity updates to the
// `<topic>.push-type.liveactivity` topic. Retries once on a thrown (connection-level) error and
// refreshes the provider token once on ExpiredProviderToken.
async function apnsSend(envName, token, topic, pushType, priority, payload, collapse) {
  const body = JSON.stringify(payload);
  const headers = {
    ':path': `/3/device/${token}`,
    'apns-topic': topic,
    'apns-push-type': pushType,
    'apns-priority': String(priority),
    'apns-expiration': String(Math.floor(Date.now() / 1000) + 3600),
    ...(collapse ? { 'apns-collapse-id': collapse } : {}),
    'content-type': 'application/json',
  };
  const post = jwt => apnsPost(envName, { ...headers, authorization: `bearer ${jwt}` }, body);
  let r;
  try {
    r = await post(providerToken(false));
  } catch {
    // NAT can drop the kept-open connection after hours of quiet; the first request on it then fails. Retry once on a new one.
    const stale = sessions.get(envName);
    if (stale) { sessions.delete(envName); stale.destroy(); }
    r = await post(providerToken(false));
  }
  if (r.status === 403 && r.reason === 'ExpiredProviderToken') r = await post(providerToken(true));
  return r;
}

/* ---------- HTTP ---------- */

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function clientIp(req) {
  const xff = String(req.headers['x-forwarded-for'] || '').split(',').map(s => s.trim()).filter(Boolean);
  return xff.at(-1) || req.socket.remoteAddress || '';
}

function json(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > LIMIT) return reject(new HttpError(413, '请求太大'));
      chunks.push(c);
    });
    req.on('error', reject);
    req.on('end', () => {
      if (size > LIMIT) return;
      try {
        const obj = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error();
        resolve(obj);
      } catch {
        reject(new HttpError(400, '请求格式不对'));
      }
    });
  });
}

const cut = (v, n) => String(v ?? '').slice(0, n);

async function register(ip, body) {
  if (!hit(`reg:${ip}`, 20, HOUR)) return [429, { error: '注册太频繁' }];
  const { token, pushId, secret } = body;
  if (typeof token !== 'string' || !/^[0-9a-f]{64,200}$/i.test(token)) return [400, { error: 'token 无效' }];
  const envName = body.env ?? config.defaultEnv;
  if (!ENVS.includes(envName)) return [400, { error: 'env 无效' }];
  const now = Date.now();
  const old = lookup(pushId);
  if (old && secretOk(old, secret)) {
    old.token = token;
    old.env = envName;
    old.updated = now;
    save();
    console.log(`[register] ${pushId.slice(0, 6)} ${envName} 更新`);
    return [200, { pushId, secret }];
  }
  const newPushId = crypto.randomBytes(16).toString('base64url');
  const newSecret = crypto.randomBytes(32).toString('base64url');
  regs[newPushId] = { token, env: envName, secretHash: sha(newSecret).toString('hex'), created: now, updated: now };
  save();
  console.log(`[register] ${newPushId.slice(0, 6)} ${envName} 新建`);
  return [200, { pushId: newPushId, secret: newSecret }];
}

async function send(ip, body) {
  const { pushId, secret } = body;
  if (typeof pushId === 'string' && !hit(`send:${pushId}`, 60, MIN)) return [429, { error: '发送太频繁' }];
  const reg = lookup(pushId);
  if (!reg) return [410, { error: 'gone' }];
  if (!secretOk(reg, secret)) return [401, { error: 'secret 无效' }];
  const d = body.data && typeof body.data === 'object' ? body.data : {};
  const data = { win: cut(d.win, 200), windowId: cut(d.windowId, 200), threadId: cut(d.threadId, 200), kind: cut(d.kind, 200) };
  const title = cut(body.title, 200), text = cut(body.body, 1000);
  const collapse = crypto.createHash('sha256').update(`${data.win}|${data.windowId}|${data.threadId}`).digest('hex').slice(0, 32);
  const payload = { aps: { alert: { title, body: text }, sound: 'default', 'thread-id': collapse }, ...data };
  const tag = pushId.slice(0, 6);
  const r = await apnsSend(reg.env, reg.token, config.topic, 'alert', 10, payload, collapse);
  if (r.status === 200) {
    console.log(`[send] ${tag} ${data.kind || '-'} ok`);
    return [200, { ok: true }];
  }
  if (r.status === 410 || (r.status === 400 && DEAD_REASONS.includes(r.reason))) {
    delete regs[pushId];
    save();
    console.log(`[send] ${tag} token 已失效（${r.reason || r.status}），已删除登记`);
    return [410, { error: 'gone' }];
  }
  console.log(`[send] ${tag} APNs ${r.status} ${r.reason}`);
  return [502, { error: r.reason || `APNs ${r.status}` }];
}

/* ---------- Live Activities ---------- */

const LIVE_DEAD = [...DEAD_REASONS, 'ExpiredToken'];
const LIVE_MAX_AGE = 8 * 3600 * 1000;
const LIVE_TOKEN_WAIT = 10 * MIN;

function liveAps(nowSec, kind, state, attributes, alert, dismissAt) {
  return {
    timestamp: nowSec, event: kind, 'content-state': state,
    ...(kind === 'start' ? { 'attributes-type': 'AgentActivityAttributes', attributes, alert } : {}),
    ...(kind === 'end' && dismissAt ? { 'dismissal-date': dismissAt } : {}),
  };
}

// Returns 'ok' (200), 'dead' (token unusable) or 'fail' with the APNs result for a 502.
async function livePush(reg, tag, token, kind, apsPayload, priority) {
  const r = await apnsSend(reg.env, token, `${config.topic}.push-type.liveactivity`, 'liveactivity', priority, { aps: apsPayload });
  if (r.status === 200) { console.log(`[live] ${tag} ${kind} ok`); return { res: 'ok', r }; }
  if (r.status === 410 || (r.status === 400 && LIVE_DEAD.includes(r.reason))) {
    console.log(`[live] ${tag} ${kind} 令牌已失效（${r.reason || r.status}）`);
    return { res: 'dead', r };
  }
  console.log(`[live] ${tag} APNs ${r.status} ${r.reason}`);
  return { res: 'fail', r };
}

function liveFields(body, nowSec) {
  const a = typeof body.attributes === 'object' && body.attributes ? body.attributes : {};
  const attributes = { win: cut(a.win, 200), windowId: cut(a.windowId, 200), threadId: cut(a.threadId, 200),
    app: cut(a.app, 200), project: cut(a.project, 200), thread: cut(a.thread, 200), pc: cut(a.pc, 200) };
  const s = typeof body.state === 'object' && body.state ? body.state : {};
  const state = { phase: cut(s.phase, 40), label: cut(s.label, 200), detail: cut(s.detail, 300),
    done: Math.max(0, Number(s.done) || 0), total: Math.max(0, Number(s.total) || 0),
    startedAt: Number(s.startedAt) || nowSec };
  const al = typeof body.alert === 'object' && body.alert ? body.alert : {};
  return {
    attributes, state,
    alert: { title: cut(al.title, 200), body: cut(al.body, 200) },
    priority: body.priority === 10 ? 10 : 5,
    dismissAt: Number(body.dismissAt) || 0,
  };
}

// The app uploads its push-to-start token and, per activity, its update token.
async function liveToken(ip, body) {
  if (!hit(`livetoken:${ip}`, 120, HOUR)) return [429, { error: '请求太频繁' }];
  const { pushId, secret, kind, key, token } = body;
  const reg = lookup(pushId);
  if (!reg) return [410, { error: 'gone' }];
  if (!secretOk(reg, secret)) return [401, { error: 'secret 无效' }];
  if (typeof token !== 'string' || !/^[0-9a-f]{64,200}$/i.test(token)) return [400, { error: 'token 无效' }];
  const now = Date.now();
  if (kind === 'start') {
    reg.liveStart = token;
    save();
    console.log(`[live] ${pushId.slice(0, 6)} start token`);
    return [200, { ok: true }];
  }
  if (kind !== 'update' || typeof key !== 'string' || !key || key.length > 700) return [400, { error: 'kind/key 无效' }];
  reg.live ??= {};
  const entry = reg.live[key] ??= { started: now };
  entry.token = token;
  if (entry.pending) {
    const p = entry.pending;
    const s = await livePush(reg, pushId.slice(0, 6), token, p.event,
      liveAps(Math.floor(now / 1000), p.event, p.state, p.attributes, p.alert, p.dismissAt), p.event === 'update' ? p.priority : 10);
    if (s.res === 'fail') { save(); return [502, { error: s.r.reason || `APNs ${s.r.status}` }]; }
    delete entry.pending;
    if (p.event === 'end' || s.res === 'dead') delete reg.live[key];
  }
  save();
  return [200, { ok: true }];
}

async function live(ip, body) {
  const { pushId, secret, key, event } = body;
  if (typeof pushId === 'string' && !hit(`live:${pushId}`, 120, MIN)) return [429, { error: '发送太频繁' }];
  const reg = lookup(pushId);
  if (!reg) return [410, { error: 'gone' }];
  if (!secretOk(reg, secret)) return [401, { error: 'secret 无效' }];
  if (typeof key !== 'string' || !key || key.length > 700) return [400, { error: 'key 无效' }];
  if (event !== 'update' && event !== 'end') return [400, { error: 'event 无效' }];
  const now = Date.now(), nowSec = Math.floor(now / 1000);
  const tag = pushId.slice(0, 6);
  const { attributes, state, alert, priority, dismissAt } = liveFields(body, nowSec);
  reg.live ??= {};
  for (const [k, e] of Object.entries(reg.live)) if (now - (e.started || 0) > LIVE_MAX_AGE) delete reg.live[k];
  const entry = reg.live[key];
  const pending = { event, attributes, state, alert, priority, dismissAt };
  const done = (extra = {}) => { save(); return [200, { ok: true, ...extra }]; };

  if (event === 'end') {
    if (entry?.token) {
      const s = await livePush(reg, tag, entry.token, 'end', liveAps(nowSec, 'end', state, attributes, alert, dismissAt), 10);
      if (s.res === 'fail') { save(); return [502, { error: s.r.reason || `APNs ${s.r.status}` }]; }
      delete reg.live[key];
      return done(s.res === 'dead' ? { dropped: true } : {});
    }
    if (entry) { entry.pending = pending; return done({ skipped: 'pending' }); }
    return done({ skipped: 'none' });
  }

  if (entry?.token) {
    const s = await livePush(reg, tag, entry.token, 'update', liveAps(nowSec, 'update', state, attributes, alert, dismissAt), priority);
    if (s.res === 'fail') { save(); return [502, { error: s.r.reason || `APNs ${s.r.status}` }]; }
    if (s.res === 'dead') { delete reg.live[key]; return done({ dropped: true }); }
    return done();
  }
  // The start went out and the app's update token has not arrived yet: keep the latest state, never start twice.
  if (entry && now - (entry.started || 0) < LIVE_TOKEN_WAIT) { entry.pending = pending; return done({ skipped: 'pending' }); }
  if (reg.liveStart) {
    const s = await livePush(reg, tag, reg.liveStart, 'start', liveAps(nowSec, 'start', state, attributes, alert, dismissAt), 10);
    if (s.res === 'dead') { delete reg.liveStart; return done({ dropped: true }); }
    if (s.res === 'fail') return [502, { error: s.r.reason || `APNs ${s.r.status}` }];
    // The start was sent; track the key so later updates go pending while the app's update token is on its way.
    reg.live[key] = { started: now };
    return done();
  }
  return done({ skipped: 'no-start-token' });
}

async function unregister(ip, body) {
  const { pushId, secret } = body;
  const reg = lookup(pushId);
  if (!reg) return [200, { ok: true }];
  if (!secretOk(reg, secret)) return [401, { error: 'secret 无效' }];
  delete regs[pushId];
  save();
  console.log(`[unregister] ${pushId.slice(0, 6)}`);
  return [200, { ok: true }];
}

const ROUTES = { '/v1/register': register, '/v1/send': send, '/v1/unregister': unregister, '/v1/live/token': liveToken, '/v1/live': live };

const server = http.createServer(async (req, res) => {
  try {
    const ip = clientIp(req);
    const { pathname } = new URL(req.url, 'http://localhost');
    if (!hit(`ip:${ip}`, 600, MIN)) return json(res, 429, { error: '请求太频繁' });
    if (pathname === '/healthz') {
      if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' });
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('ok');
    }
    const route = Object.hasOwn(ROUTES, pathname) ? ROUTES[pathname] : null;
    if (!route) return json(res, 404, { error: 'not found' });
    if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
    const body = await readBody(req);
    const [status, out] = await route(ip, body);
    json(res, status, out);
  } catch (e) {
    if (e instanceof HttpError) {
      if (e.status === 413) res.setHeader('connection', 'close');
      return json(res, e.status, { error: e.message });
    }
    console.error(`[error] ${e.message}`);
    if (!res.headersSent) json(res, 502, { error: e.message });
  }
});

server.listen(config.port, config.host, () => {
  console.log(`push service listening on ${config.host}:${config.port}, APNS_ENV=${config.defaultEnv}`);
});
