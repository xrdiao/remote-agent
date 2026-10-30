import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { IS_WIN } from '../lib/platform.mjs';
import { Cdp } from './cdp.mjs';
import { EDITORS } from './config.mjs';

const targetReads = new Map();
function editorTargets(base) {
  if (!targetReads.has(base)) targetReads.set(base,
    fetch(`${base}/json/list`, { signal: AbortSignal.timeout(1500) }).then(r => r.json()).finally(() => targetReads.delete(base)));
  return targetReads.get(base);
}

export async function listWindows(report = null, app = null) {
  const lists = await Promise.all(EDITORS.filter(ed => !app || ed.app === app).map(async ed => {
    try {
      if (ed.app === 'codex') {
        const pages = await codexWindows(ed.url, !!report, '', false);
        report?.push({ app: ed.app, windows: pages.length, address: ed.url });
        if (!pages.length) return [];
        // Several VS Code windows are agents inside one Codex entry, not separate phone windows.
        return [{ id: 'codex', title: 'Codex', ws: pages[0].ws, port: ed.url, app: 'codex', kind: 'local' }];
      }
      const targets = await editorTargets(ed.url);
      const found = targets
        .filter(t => t.type === 'page' && /workbench/.test(t.url))
        .map(t => ({
          id: `${ed.app}:${t.id}`,
          title: t.title,
          ws: t.webSocketDebuggerUrl,
          port: ed.url,
          app: ed.app,
          kind: t.title === 'Cursor Agents' ? 'agents' : /\[SSH: /.test(t.title) ? 'ssh' : 'local',
        }));
      report?.push({ app: ed.app, windows: found.length, address: ed.url });
      return found;
    } catch (error) {
      report?.push({ app: ed.app, windows: 0, address: ed.url, error: String(error), timeout: error.name === 'TimeoutError' });
      return [];
    }
  }));
  const wins = lists.flat();
  if (!wins.length) throw new Error('连不上 Cursor、Devin 或 Codex。Cursor 用调试端口 9222，Devin 用 ./scripts/start-devin.sh（端口 9223），Codex 用 ./scripts/start-codex.sh（端口 9224）');
  wins.push({ id: 'fusion', title: 'Fusion', ws: '', port: '', app: 'fusion', kind: 'local' });
  return wins;
}

export function phoneWindows(wins, current) {
  const apps = [...new Set(wins.map(w => w.app))];
  return apps.map(app => {
    const rows = wins.filter(w => w.app === app);
    const row = rows.find(w => w.id === current) || rows[0];
    return { id: row.id, title: { cursor: 'Cursor', devin: 'Devin', codex: 'Codex', fusion: 'Fusion' }[app] || app,
      kind: row.kind, app, windowIds: rows.map(w => w.id) };
  });
}


// Each VS Code window has its own Codex sidebar. The phone shows one Codex window and lists these as agents.
export const codexViewIds = new Map();
export const codexContextFiles = new Map();
const codexContextChecks = new Map();
const codexContextReads = new Map();
const codexContextCache = new Map();
const codexHome = () => process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const codexSessionNames = directory => fs.readdir(directory, { recursive: true });
const codexSessionFile = (name, thread) => name.endsWith(`-${thread}.jsonl`) || path.basename(name).includes(`-${thread}_`) && name.endsWith('.jsonl');

export async function codexSessionStates(ids, nativePaths) {
  const directories = ['sessions', 'archived_sessions'].map(name => path.join(codexHome(), name));
  if (!nativePaths.length || nativePaths.some(file => !directories.some(directory => {
    const relative = path.relative(directory, file);
    return relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
  }))) throw new Error('Codex 原生会话路径与本机会话目录不一致，无法核对缺失记录');
  const names = [];
  for (const directory of directories) {
    try { names.push(await codexSessionNames(directory)); }
    catch (error) {
      if (error.code !== 'ENOENT' || error.path !== directory) throw error;
      names.push([]);
    }
  }
  return new Map(ids.map(id => [id, names[0].some(name => codexSessionFile(name, id)) ? 'active'
    : names[1].some(name => codexSessionFile(name, id)) ? 'archived' : 'deleted']));
}

export function codexContext(thread) {
  if (!thread) return null;
  if (!codexContextReads.has(thread)) {
    const read = readCodexContext(thread).finally(() => codexContextReads.delete(thread));
    codexContextReads.set(thread, read);
  }
  return codexContextReads.get(thread);
}

async function readCodexContext(thread) {
  const sessions = path.join(codexHome(), 'sessions');
  let file = codexContextFiles.get(thread);
  const now = Date.now();
  if (!file || now - (codexContextChecks.get(thread) || 0) >= 5000) {
    const names = (await codexSessionNames(sessions)).filter(name => codexSessionFile(name, thread));
    const files = await Promise.all(names.map(async name => ({ name, modified: (await fs.stat(path.join(sessions, name))).mtimeMs })));
    const relative = files.sort((a, b) => b.modified - a.modified)[0]?.name;
    if (!relative) return null;
    file = path.join(sessions, relative);
    codexContextFiles.set(thread, file);
    codexContextChecks.set(thread, now);
  }
  const handle = await fs.open(file, 'r');
  try {
    const stat = await handle.stat();
    const signature = `${file}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    const cached = codexContextCache.get(thread);
    if (cached?.signature === signature) return cached.context;
    const context = await readCodexContextTail(handle, stat.size);
    codexContextCache.set(thread, { signature, context });
    return context;
  } finally {
    await handle.close();
  }
}

async function readCodexContextTail(handle, size) {
  let position = size;
  let fragments = [];
  let tail = true;
  const readLine = () => {
    const line = (fragments.length === 1 ? fragments[0] : Buffer.concat(fragments.reverse())).toString('utf8').trim();
    fragments = [];
    if (!line) return undefined;
    let row;
    try { row = JSON.parse(line); } catch (error) {
      // The last record can still be in the middle of an append.
      if (tail && error instanceof SyntaxError) return undefined;
      throw error;
    }
    if (row.type !== 'event_msg' || row.payload.type !== 'token_count' || !row.payload.info) return undefined;
    const info = row.payload.info;
    if (!info.model_context_window) return null;
    return { pct: Math.round(Math.min(100, info.last_token_usage.total_tokens / info.model_context_window * 100)), basis: 'used' };
  };
  while (position > 0) {
    const length = Math.min(64 * 1024, position);
    position -= length;
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(buffer, 0, length, position);
    let end = bytesRead;
    while (end > 0) {
      const newline = buffer.lastIndexOf(10, end - 1);
      if (newline < 0) break;
      fragments.push(buffer.subarray(newline + 1, end));
      const context = readLine();
      if (context !== undefined) return context;
      tail = false;
      end = newline;
    }
    if (end > 0) fragments.push(buffer.subarray(0, end));
  }
  return fragments.length ? readLine() ?? null : null;
}

export function codexFolder(title) {
  if (IS_WIN) title = String(title || '').replace(/\s+\[(?:Administrator|Administer)\]$/i, '');
  const parts = String(title || '').replace(/\s+-\s+Visual Studio Code$/, '').split(' - ').map(s => s.trim()).filter(Boolean);
  if (parts[0] === 'Welcome' && parts.length > 1) return parts[parts.length - 1];
  return (parts.length > 1 ? parts[parts.length - 1] : parts[0]) || 'Codex';
}

async function webviewKey(wsUrl) {
  const cdp = new Cdp(wsUrl);
  try {
    await cdp.connect();
    const src = await cdp.evaluate(`document.querySelector('iframe[src*="extensionId=openai.chatgpt"][src*="purpose=webviewView"]')?.src || ''`);
    return /[?&]id=([^&]+)/.exec(String(src))?.[1] || '';
  } catch {
    return '';
  } finally {
    try { cdp.close(); } catch {}
  }
}

export async function codexWindows(base, reportErrors = false, pageId = '', bindViews = true) {
  let targets = [];
  try {
    targets = await editorTargets(base);
  } catch (error) {
    if (reportErrors) throw error;
    return [];
  }
  const pages = targets.filter(t => t.type === 'page' && /workbench/.test(t.url || '') && (!pageId || t.id === pageId));
  const viewByKey = new Map();
  for (const v of targets) {
    if (!v.webSocketDebuggerUrl || !/extensionId=openai\.chatgpt/.test(v.url || '') || !/purpose=webviewView/.test(v.url || '')) continue;
    const key = /[?&]id=([^&]+)/.exec(v.url || '')?.[1];
    if (key) viewByKey.set(key, v.webSocketDebuggerUrl);
  }
  const out = [];
  for (const p of pages) {
    let key = codexViewIds.get(p.id);
    if (bindViews && (!key || !viewByKey.has(key))) {
      key = await webviewKey(p.webSocketDebuggerUrl);
      if (key) codexViewIds.set(p.id, key);
    }
    out.push({
      pageId: p.id,
      title: codexFolder(p.title),
      rawTitle: p.title || '',
      ws: p.webSocketDebuggerUrl,
      chatWs: viewByKey.get(key) || null,
    });
  }
  return out;
}
