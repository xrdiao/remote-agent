import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { findBin } from '../../lib/platform.mjs';
import { publishRecord, opensEntry } from '../../lib/auth.mjs';
import { PUBLISH_REPO, PAGES_BRANCH, APP_DIR } from '../config.mjs';
import { MIME } from '../http/static.mjs';
import { appUrl, offerFirstPairing } from '../util.mjs';

export function run(cmd, args, input) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd === 'gh' ? findBin('gh') : cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { err += d; });
    p.on('error', reject);
    p.on('close', code => code === 0 ? resolve(out.trim()) : reject(new Error(err.trim() || `${cmd} exited ${code}`)));
    p.stdin.end(input ?? '');
  });
}

export const gitBlobSha = buf => crypto.createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');

export async function putFile(name, buf, sha, repo = PUBLISH_REPO) {
  const body = { message: `update ${name}`, content: buf.toString('base64'), ...(PAGES_BRANCH ? { branch: PAGES_BRANCH } : {}), ...(sha ? { sha } : {}) };
  await run('gh', ['api', '-X', 'PUT', `repos/${repo}/contents/${name}`, '--input', '-'], JSON.stringify(body));
}

export async function remoteShas(repo = PUBLISH_REPO) {
  const spec = [`repos/${repo}/git/trees/${PAGES_BRANCH || 'HEAD'}?recursive=1`, '--jq', '.tree[] | select(.type=="blob") | [.path, .sha] | @tsv'];
  const out = await run('gh', ['api', ...spec]).catch(() => '');
  return new Map(out.split('\n').filter(Boolean).map(l => l.split('\t')));
}

export function appFiles(dir = APP_DIR, prefix = '') {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const abs = path.join(dir, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    if (fs.statSync(abs).isDirectory()) out.push(...appFiles(abs, rel));
    else if (MIME[path.extname(name)] && rel !== 'url.json') out.push(rel);
  }
  return out;
}

// Keeps the GitHub Pages copy of the app identical to app/, uploading only files that changed.
async function syncApp() {
  const remote = await remoteShas();
  let changed = 0;
  for (const name of appFiles()) {
    const buf = fs.readFileSync(path.join(APP_DIR, name));
    if (remote.get(name) === gitBlobSha(buf)) continue;
    await putFile(name, buf, remote.get(name));
    changed++;
  }
  if (changed) console.log(`已同步 ${changed} 个 App 文件到 GitHub Pages`);
}

async function readUrlDoc() {
  const q = PAGES_BRANCH ? `?ref=${encodeURIComponent(PAGES_BRANCH)}` : '';
  try {
    const meta = JSON.parse(await run('gh', ['api', `repos/${PUBLISH_REPO}/contents/url.json${q}`]));
    const text = Buffer.from(String(meta.content || '').replace(/\n/g, ''), 'base64').toString('utf8');
    return { sha: meta.sha, json: JSON.parse(text) };
  } catch (e) {
    if (/404|Not Found/i.test(String(e.message || e))) return { sha: null, json: null };
    throw e;
  }
}

function registryWith(existing, mine) {
  let others = [];
  if (existing?.v === 3 && Array.isArray(existing.computers)) {
    others = existing.computers.filter(c => c && c.id && c.id !== mine.id && c.iv && c.data);
  } else if (existing?.v === 2 && existing.iv && existing.data && !opensEntry(existing)) {
    const id = crypto.createHash('sha256').update(String(existing.data)).digest().subarray(0, 8).toString('hex');
    others = [{ id, name: existing.name || '另一台电脑', iv: existing.iv, data: existing.data, updated: existing.updated }];
  }
  const computers = [...others, mine].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return { v: 3, computers };
}

// Writes this computer's tunnel address into the shared url.json without removing the others.
export async function publishUrl(url, { syncAppFiles = true, offerPairing = true } = {}) {
  try {
    const mine = publishRecord(url);
    let lastErr = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      const cur = await readUrlDoc();
      try {
        await putFile('url.json', Buffer.from(JSON.stringify(registryWith(cur.json, mine)) + '\n'), cur.sha);
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
        if (!/409|does not match|sha/i.test(String(e.message))) break;
      }
    }
    if (lastErr) throw lastErr;
    console.log(`已发布最新地址（GitHub Pages 约 1 分钟后生效）。手机 App 固定地址：${appUrl()}`);
  } catch (e) {
    console.log(`!! 发布地址失败：${e.message}`);
    return false;
  }
  if (syncAppFiles) {
    try { await syncApp(); }
    catch (e) { console.log(`!! 同步 App 文件失败：${e.message}`); }
  }
  if (offerPairing) offerFirstPairing();
  return true;
}
