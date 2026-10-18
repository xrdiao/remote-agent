import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { IS_WIN } from '../lib/platform.mjs';
import { Cdp } from './cdp.mjs';
import { EDITORS } from './config.mjs';

export async function listWindows(report = null, app = null) {
  const lists = await Promise.all(EDITORS.filter(ed => !app || ed.app === app).map(async ed => {
    try {
      if (ed.app === 'codex') {
        const pages = await codexWindows(ed.url, !!report);
        report?.push({ app: ed.app, windows: pages.length, address: ed.url });
        if (!pages.length) return [];
        // Several VS Code windows are agents inside one Codex entry, not separate phone windows.
        return [{ id: 'codex', title: 'Codex', ws: pages[0].ws, port: ed.url, app: 'codex', kind: 'local' }];
      }
      const targets = await (await fetch(`${ed.url}/json/list`, { signal: AbortSignal.timeout(1500) })).json();
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
  return apps.map(app => wins.find(w => w.app === app && w.id === current) || wins.find(w => w.app === app))
    .map(({ id, kind, app }) => ({ id, title: { cursor: 'Cursor', devin: 'Devin', codex: 'Codex', fusion: 'Fusion' }[app] || app, kind, app }));
}


// Each VS Code window has its own Codex sidebar. The phone shows one Codex window and lists these as agents.
export const codexViewIds = new Map();
export const codexContextFiles = new Map();

export function codexContext(thread) {
  if (!thread) return null;
  const sessions = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions');
  let file = codexContextFiles.get(thread);
  if (!file) {
    const relative = fs.readdirSync(sessions, { recursive: true }).find(name => name.endsWith(`-${thread}.jsonl`));
    if (!relative) return null;
    file = path.join(sessions, relative);
    codexContextFiles.set(thread, file);
  }
  const lines = fs.readFileSync(file, 'utf8').trimEnd().split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const row = JSON.parse(lines[i]);
    if (row.type !== 'event_msg' || row.payload.type !== 'token_count' || !row.payload.info) continue;
    const info = row.payload.info;
    if (!info.model_context_window) return null;
    return { pct: Math.round(Math.min(100, info.last_token_usage.total_tokens / info.model_context_window * 100)), basis: 'used' };
  }
  return null;
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

export async function codexWindows(base, reportErrors = false) {
  let targets = [];
  try {
    targets = await (await fetch(`${base}/json/list`, { signal: AbortSignal.timeout(1500) })).json();
  } catch (error) {
    if (reportErrors) throw error;
    return [];
  }
  const pages = targets.filter(t => t.type === 'page' && /workbench/.test(t.url || ''));
  const viewByKey = new Map();
  for (const v of targets) {
    if (!v.webSocketDebuggerUrl || !/extensionId=openai\.chatgpt/.test(v.url || '') || !/purpose=webviewView/.test(v.url || '')) continue;
    const key = /[?&]id=([^&]+)/.exec(v.url || '')?.[1];
    if (key) viewByKey.set(key, v.webSocketDebuggerUrl);
  }
  const out = [];
  for (const p of pages) {
    let key = codexViewIds.get(p.id);
    if (!key || !viewByKey.has(key)) {
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
