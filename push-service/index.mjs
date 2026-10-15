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

async function apnsSend(reg, collapse, payload) {
  const body = JSON.stringify(payload);
  const post = jwt => apnsPost(reg.env, {
    ':path': `/3/device/${reg.token}`,
    authorization: `bearer ${jwt}`,
    'apns-topic': config.topic,
    'apns-push-type': 'alert',
    'apns-priority': '10',
    'apns-expiration': String(Math.floor(Date.now() / 1000) + 3600),
    'apns-collapse-id': collapse,
    'content-type': 'application/json',
  }, body);
  let r = await post(providerToken(false));
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
  const r = await apnsSend(reg, collapse, payload);
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

const ROUTES = { '/v1/register': register, '/v1/send': send, '/v1/unregister': unregister };

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
