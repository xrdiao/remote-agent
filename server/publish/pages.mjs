import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { findBin } from '../../lib/platform.mjs';
import { publishRecord, opensEntry } from '../../lib/auth.mjs';
import { PUBLISH_REPO, PAGES_BRANCH, APP_DIR } from '../config.mjs';
import { MIME } from '../http/static.mjs';
import { appUrl, offerFirstPairing } from '../util.mjs';

export function run(cmd, args, input, { signal } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd === 'gh' ? findBin('gh') : cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], signal });
    let out = '', err = '';
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { err += d; });
    p.on('error', reject);
    p.on('close', code => code === 0 ? resolve(out.trim()) : reject(new Error(err.trim() || `${cmd} exited ${code}`)));
    p.stdin.end(input ?? '');
  });
}

export const gitBlobSha = buf => crypto.createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');

export async function putFile(name, buf, sha, repo = PUBLISH_REPO, branch = PAGES_BRANCH, { signal } = {}) {
  const body = { message: `update ${name}`, content: buf.toString('base64'), ...(branch ? { branch } : {}), ...(sha ? { sha } : {}) };
  await run('gh', ['api', '-X', 'PUT', `repos/${repo}/contents/${name}`, '--input', '-'], JSON.stringify(body), { signal });
}

export async function remoteShas(repo = PUBLISH_REPO, branch = PAGES_BRANCH) {
  const spec = [`repos/${repo}/git/trees/${branch || 'HEAD'}?recursive=1`, '--jq', '.tree[] | select(.type=="blob") | [.path, .sha] | @tsv'];
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
async function syncApp(signal) {
  const api = async (suffix, body) => JSON.parse(await run('gh', ['api', ...(body ? ['-X', 'POST'] : []), `repos/${PUBLISH_REPO}/${suffix}`, ...(body ? ['--input', '-'] : [])], body && JSON.stringify(body), { signal }));
  const branch = PAGES_BRANCH || (await api('')).default_branch;
  const files = appFiles().map(name => {
    const buf = fs.readFileSync(path.join(APP_DIR, name));
    return { path: name, mode: '100644', type: 'blob', sha: gitBlobSha(buf), buf };
  });
  const uploaded = new Set();
  for (let attempt = 0; attempt < 4; attempt++) {
    const head = await api(`git/ref/heads/${branch}`);
    const commit = await api(`git/commits/${head.object.sha}`);
    const remote = new Map((await api(`git/trees/${commit.tree.sha}?recursive=1`)).tree.map(row => [row.path, row.sha]));
    const changed = files.filter(file => file.sha !== remote.get(file.path));
    if (!changed.length) return;
    for (const file of changed) {
      if (uploaded.has(file.sha)) continue;
      await api('git/blobs', { content: file.buf.toString('base64'), encoding: 'base64' });
      uploaded.add(file.sha);
    }
    const tree = await api('git/trees', { base_tree: commit.tree.sha, tree: changed.map(({ buf, ...row }) => row) });
    const next = await api('git/commits', { message: 'Update app', tree: tree.sha, parents: [head.object.sha] });
    try {
      await run('gh', ['api', '-X', 'PATCH', `repos/${PUBLISH_REPO}/git/refs/heads/${branch}`, '--input', '-'], JSON.stringify({ sha: next.sha, force: false }), { signal });
      console.log(`已同步 ${changed.length} 个 App 文件到 GitHub Pages`);
      return;
    } catch (error) {
      if (attempt === 3 || !/409|422|not.*fast.forward|reference update failed/i.test(error.message)) throw error;
    }
  }
}

async function readUrlDoc(signal) {
  const q = PAGES_BRANCH ? `?ref=${encodeURIComponent(PAGES_BRANCH)}` : '';
  try {
    const meta = JSON.parse(await run('gh', ['api', `repos/${PUBLISH_REPO}/contents/url.json${q}`], undefined, { signal }));
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
export async function publishUrl(url, { syncAppFiles = true, offerPairing = true, signal } = {}) {
  try {
    const mine = publishRecord(url);
    let lastErr = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      const cur = await readUrlDoc(signal);
      try {
        await putFile('url.json', Buffer.from(JSON.stringify(registryWith(cur.json, mine)) + '\n'), cur.sha, PUBLISH_REPO, PAGES_BRANCH, { signal });
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
    if (!signal?.aborted) console.log(`!! 发布地址失败：${e.message}`);
    return false;
  }
  if (syncAppFiles) {
    try { await syncApp(signal); }
    catch (e) { if (!signal?.aborted) console.log(`!! 同步 App 文件失败：${e.message}`); return false; }
  }
  if (offerPairing) offerFirstPairing();
  return true;
}
