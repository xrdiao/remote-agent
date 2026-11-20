import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { findBin } from '../../lib/platform.mjs';
import { publishRecord, opensEntry } from '../../lib/auth.mjs';
import { PUBLISH_REPO, PAGES_BRANCH, APP_DIR, DISCOVERY_REPO, DISCOVERY_BRANCH, DISCOVERY_TOKEN_FILE } from '../config.mjs';
import { MIME } from '../http/static.mjs';
import { appUrl, offerFirstPairing } from '../util.mjs';

export function run(cmd, args, input, { signal, env } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd === 'gh' ? findBin('gh') : cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], signal, env, windowsHide: true });
    let out = '', err = '';
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { err += d; });
    p.on('error', reject);
    p.on('close', code => code === 0 ? resolve(out.trim()) : reject(new Error(err.trim() || `${cmd} exited ${code}`)));
    p.stdin.end(input ?? '');
  });
}

export const gitBlobSha = buf => crypto.createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');

export async function putFile(name, buf, sha, repo = PUBLISH_REPO, branch = PAGES_BRANCH, options) {
  const body = { message: `update ${name}`, content: buf.toString('base64'), ...(branch ? { branch } : {}), ...(sha ? { sha } : {}) };
  await run('gh', ['api', '-X', 'PUT', `repos/${repo}/contents/${name}`, '--input', '-'], JSON.stringify(body), options);
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

function discoveryPointer() {
  if (!PUBLISH_REPO || DISCOVERY_REPO.toLowerCase() === PUBLISH_REPO.toLowerCase()
    || !/^[\w-]+\/[\w.-]+$/.test(DISCOVERY_REPO) || !/^[\w-][\w.-]*$/.test(DISCOVERY_BRANCH)) {
    throw new Error('请为地址登记指定独立的 GitHub data 仓库和分支');
  }
  return { v: 4, registry: `https://raw.githubusercontent.com/${DISCOVERY_REPO}/${DISCOVERY_BRANCH}/url.json` };
}

function entries(doc) {
  return doc?.v === 3 && Array.isArray(doc.computers)
    ? doc.computers.filter(entry => entry?.id && entry.iv && entry.data) : [];
}

// Keeps the GitHub Pages copy of the app identical to app/, uploading only files that changed.
export async function syncApp(signal, repo = PUBLISH_REPO, selectedBranch = PAGES_BRANCH) {
  const api = async (suffix, body) => JSON.parse(await run('gh', ['api', ...(body ? ['-X', 'POST'] : []), `repos/${repo}${suffix && `/${suffix}`}`, ...(body ? ['--input', '-'] : [])], body && JSON.stringify(body), { signal }));
  const branch = selectedBranch || (await api('')).default_branch;
  const blob = (name, buf) => ({ path: name, mode: '100644', type: 'blob', sha: gitBlobSha(buf), buf });
  const files = appFiles().map(name => blob(name, fs.readFileSync(path.join(APP_DIR, name))));
  const pointer = DISCOVERY_REPO && repo.toLowerCase() === PUBLISH_REPO.toLowerCase() ? discoveryPointer() : null;
  if (pointer) files.push(blob('url.json', Buffer.from(JSON.stringify(pointer) + '\n')));
  const uploaded = new Set();
  for (let attempt = 0; attempt < 4; attempt++) {
    const head = await api(`git/ref/heads/${branch}`);
    const commit = await api(`git/commits/${head.object.sha}`);
    const remote = new Map((await api(`git/trees/${commit.tree.sha}?recursive=1`)).tree.map(row => [row.path, row.sha]));
    const changed = files.filter(file => file.sha !== remote.get(file.path));
    if (!changed.length) return;
    if (changed.some(file => file.path === 'url.json')) {
      const { json: previous } = await readUrlDoc(repo, head.object.sha, { signal });
      const registryRepo = await run('gh', ['api', `repos/${DISCOVERY_REPO}`, '--jq', '.private'], undefined, { signal, env: { ...process.env, GH_HOST: 'github.com' } });
      if (registryRepo !== 'false') throw new Error('地址登记仓库必须可公开读取');
      const next = entries((await readUrlDoc(DISCOVERY_REPO, DISCOVERY_BRANCH, { signal, env: { ...process.env, GH_HOST: 'github.com' } })).json);
      const ids = new Set(next.map(entry => entry.id));
      if (!next.length || previous?.v === 2 || (previous?.v === 4 && previous.registry !== pointer.registry)
        || entries(previous).some(entry => !ids.has(entry.id))) {
        throw new Error('请先迁移已有电脑的加密地址记录，再切换网页入口');
      }
    }
    for (const file of changed) {
      if (uploaded.has(file.sha)) continue;
      await api('git/blobs', { content: file.buf.toString('base64'), encoding: 'base64' });
      uploaded.add(file.sha);
    }
    const tree = await api('git/trees', { base_tree: commit.tree.sha, tree: changed.map(({ buf, ...row }) => row) });
    const next = await api('git/commits', { message: 'Update app', tree: tree.sha, parents: [head.object.sha] });
    try {
      await run('gh', ['api', '-X', 'PATCH', `repos/${repo}/git/refs/heads/${branch}`, '--input', '-'], JSON.stringify({ sha: next.sha, force: false }), { signal });
      console.log(`已同步 ${changed.length} 个 App 文件到 GitHub Pages`);
      return;
    } catch (error) {
      if (attempt === 3 || !/409|422|not.*fast.forward|reference update failed/i.test(error.message)) throw error;
    }
  }
}

async function readUrlDoc(repo, branch, options) {
  const q = branch ? `?ref=${encodeURIComponent(branch)}` : '';
  try {
    const meta = JSON.parse(await run('gh', ['api', `repos/${repo}/contents/url.json${q}`], undefined, options));
    const text = Buffer.from(String(meta.content || '').replace(/\n/g, ''), 'base64').toString('utf8');
    return { sha: meta.sha, json: JSON.parse(text) };
  } catch (e) {
    if (/404|Not Found/i.test(String(e.message || e))) return { sha: null, json: null };
    throw e;
  }
}

function registryWith(existing, mine) {
  if (existing?.v === 4) throw new Error('网页入口已切到独立地址登记，请配置登记仓库');
  if (existing?.v === 2 && existing.iv && existing.data && !opensEntry(existing)) {
    throw new Error('旧地址记录属于另一台电脑，请先在原电脑发布 v3 地址记录，再加入当前电脑');
  }
  const computers = [...entries(existing).filter(c => c.id !== mine.id), mine].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return { v: 3, computers };
}

// Writes this computer's tunnel address into the shared url.json without removing the others.
export async function publishUrl(url, { syncAppFiles = true, offerPairing = true, signal } = {}) {
  try {
    const repo = DISCOVERY_REPO || PUBLISH_REPO, branch = DISCOVERY_REPO ? DISCOVERY_BRANCH : PAGES_BRANCH;
    const options = { signal };
    if (DISCOVERY_REPO) {
      discoveryPointer();
      const token = fs.readFileSync(DISCOVERY_TOKEN_FILE, 'utf8').trim();
      if (!token) throw new Error('独立地址登记令牌文件为空');
      options.env = { ...process.env, GH_TOKEN: token, GH_HOST: 'github.com' };
    }
    const mine = publishRecord(url);
    let lastErr = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      const cur = await readUrlDoc(repo, branch, options);
      try {
        await putFile('url.json', Buffer.from(JSON.stringify(registryWith(cur.json, mine)) + '\n'), cur.sha, repo, branch, options);
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
        if (!/409|does not match|sha/i.test(String(e.message))) break;
      }
    }
    if (lastErr) throw lastErr;
    console.log(`已登记最新地址。手机 App 固定地址：${appUrl()}`);
  } catch (e) {
    if (!signal?.aborted) console.log(`!! 发布地址失败：${e.message}`);
    return false;
  }
  if (syncAppFiles && !DISCOVERY_REPO) {
    try { await syncApp(signal); }
    catch (e) { if (!signal?.aborted) console.log(`!! 同步 App 文件失败：${e.message}`); return false; }
  }
  if (offerPairing) offerFirstPairing();
  return true;
}
