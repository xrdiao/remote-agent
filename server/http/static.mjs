import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { APP_DIR, ALLOWED_ORIGINS } from '../config.mjs';
import { verifyBodyDigest } from '../../lib/device-proof.mjs';

const verifiedBodies = new WeakMap();

export function readBody(req, limit = 4096) {
  if (verifiedBodies.has(req)) return Promise.resolve(verifiedBodies.get(req));
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => { body += c; if (body.length > limit) { reject(new Error('too large')); req.destroy(); } });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

export async function verifyBufferedBody(req, limit = 4096) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit * 3) throw new Error('请求内容过大');
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks, size);
  verifyBodyDigest(req, crypto.createHash('sha256').update(bytes).digest('base64url'));
  const body = bytes.toString('utf8');
  if (body.length > limit) throw new Error('请求内容过大');
  verifiedBodies.set(req, body);
}

// Same-origin (app served by this relay) or the user's own GitHub Pages app.
export function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  if (ALLOWED_ORIGINS.has(origin)) return true;
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}

export const SECURITY_HEADERS = {
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'cache-control': 'no-store',
};

export const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.bcmap': 'application/octet-stream',
  '.pfb': 'application/octet-stream',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2',
};

export function corsHeaders(req) {
  const origin = req.headers.origin;
  if (!origin || !originAllowed(req)) return {};
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-headers': 'content-type, authorization, x-ra-proof',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-max-age': '600',
    vary: 'Origin',
  };
}

export function json(req, res, status, obj) {
  res.writeHead(status, { ...SECURITY_HEADERS, ...corsHeaders(req), 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}

export function serveApp(res, name) {
  let rel;
  try { rel = decodeURIComponent(String(name)).replace(/^\/+/, ''); } catch { return false; }
  if (!/^(?:vendor\/(?:jsQR\.js|xterm\.(?:js|css|LICENSE\.txt))|pdfjs\/(?:(?:cmaps|standard_fonts|wasm)\/)?[A-Za-z0-9._-]+|katex\/fonts\/[A-Za-z0-9._-]+|katex\/[A-Za-z0-9._-]+|(?:js|markdown-it)\/[A-Za-z0-9._-]+|[A-Za-z0-9._-]+)$/.test(rel)) return false;
  const file = path.join(APP_DIR, rel);
  const type = MIME[path.extname(file)];
  if (!type || !file.startsWith(APP_DIR + path.sep) || !fs.existsSync(file)) return false;
  res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': type });
  fs.createReadStream(file).pipe(res);
  return true;
}

export async function readJson(req) {
  try {
    const body = JSON.parse(await readBody(req));
    return body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  } catch { return {}; }
}
