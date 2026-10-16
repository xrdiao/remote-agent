import crypto from 'node:crypto';
import fs from 'node:fs';
import { listDevices, needsTotp } from '../../lib/auth.mjs';
import { SECURITY_HEADERS, corsHeaders } from './static.mjs';

const key = crypto.randomBytes(32);
const sign = value => crypto.createHmac('sha256', key).update(value).digest('base64url');

// A scoped, short-lived URL lets native video controls seek without exposing the device token.
export function videoUrl(file, deviceId) {
  const data = Buffer.from(JSON.stringify({ file, deviceId, expires: Date.now() + 30 * 60 * 1000 })).toString('base64url');
  return `/api/video/${data}.${sign(data)}`;
}

export function videoGrant(ticket) {
  const [data, signature] = ticket.split('.');
  if (!data || !signature || signature !== sign(data)) return null;
  try {
    const grant = JSON.parse(Buffer.from(data, 'base64url').toString());
    const device = listDevices().find(d => d.id === grant.deviceId);
    return grant.expires > Date.now() && device && !needsTotp(device) ? grant : null;
  } catch { return null; }
}

export function serveVideo(req, res, grant) {
  let stat;
  try { stat = fs.statSync(grant.file); } catch { res.writeHead(404).end(); return; }
  const size = stat.size;
  const headers = { ...SECURITY_HEADERS, ...corsHeaders(req), 'content-type': 'video/mp4', 'accept-ranges': 'bytes' };
  let start = 0, end = size - 1;
  const range = req.headers.range;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match || (!match[1] && !match[2])) { res.writeHead(416, { ...headers, 'content-range': `bytes */${size}` }).end(); return; }
    if (!match[1]) start = Math.max(0, size - Number(match[2]));
    else { start = Number(match[1]); if (match[2]) end = Math.min(end, Number(match[2])); }
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) {
      res.writeHead(416, { ...headers, 'content-range': `bytes */${size}` }).end(); return;
    }
    headers['content-range'] = `bytes ${start}-${end}/${size}`;
  }
  res.writeHead(range ? 206 : 200, { ...headers, 'content-length': end - start + 1 });
  if (req.method === 'HEAD') { res.end(); return; }
  const stream = fs.createReadStream(grant.file, { start, end });
  res.on('close', () => stream.destroy());
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}
