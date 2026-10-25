// 文件：文档浏览、变更列表、打开与保存
import path from 'node:path';
import { workspaces, fileSize, readFile, parseRef, listProject, locateWritable, writeTextFile, resolveLocal } from '../../lib/files.mjs';
import { videoUrl, pdfUrl } from '../http/video.mjs';
import { themeFor } from '../../lib/theme.mjs';
import { highlightText } from '../../lib/highlight.mjs';
import { gitMarks, agentMarks, parseGitDiff, lastCommitMarks } from '../../lib/marks.mjs';
import { mod, pathKey } from '../../lib/platform.mjs';
import { CDP_URL, EDITORS } from '../config.mjs';
import { helpersCall } from '../page/build.mjs';

export const methods = {
  async showDocs(root, dir, host, editor = false, requestId) {
    const emit = data => this.emit({ t: 'docs', editor, requestId, ...data });
    try {
      if (!root) {
        const roots = await this.currentRoots();
        if (roots.length === 1) {
          const ws = roots[0];
          emit({ ...(await listProject(ws.root, ws.root, editor)), host: '' });
          return;
        }
        if (roots.length > 1) {
          emit({ projects: this.projectRows(roots) });
          return;
        }
        const app = this.app === 'codex' ? 'code' : this.app === 'devin' ? 'devin' : 'cursor';
        const mine = workspaces().filter(w => !w.host && (w.sources || [w.source]).includes(app));
        emit({ projects: this.projectRows(mine).slice(0, 20) });
        return;
      }
      if (host) throw new Error('只支持查看本地文件');
      const ws = this.workspaceByRoot(root, '');
      if (!ws) throw new Error('只能查看已打开过的项目');
      emit({ ...(await listProject(ws.root, dir || ws.root, editor)), host: '' });
    } catch (e) {
      emit({ error: e.message });
    }
  },


  // Opens Cursor's changed-files list if needed, runs fn, then puts the list back the way it was.
  // Devin: the rows are readable while the list is folded (display:none), so reading does not toggle it.
  // Rows can mount late, so wait for as many as the bar counts. Actions open the list, then fold it again.
  async withFiles(fn, opts) {
    return this.adapter.withFiles.call(this, fn, opts);
  },
  async listChanges() {
    return this.adapter.listChanges.call(this);
  },
  async changeAction(i, name, act) {
    return this.adapter.changeAction.call(this, i, name, act);
  },


  // Asks Cursor's own Cmd+P index where a bare file name lives, then closes the picker again.
  async quickOpen(name) {
    await this.key(mod('p'), { cdp: this.editorCdp });
    try {
      let rows = null;
      for (let i = 0; i < 6 && !rows; i++) {
        await new Promise(r => setTimeout(r, 150));
        rows = await this.editorCdp.evaluate(helpersCall('quickOpenRows()'));
      }
      if (!rows) return [];
      await this.editorCdp.send('Input.insertText', { text: name });
      let hits = [];
      for (let i = 0; i < 12; i++) {
        await new Promise(r => setTimeout(r, 250));
        hits = (await this.editorCdp.evaluate(helpersCall('quickOpenRows()')) || []).filter(r => r.name === name);
        if (hits.length) break;
      }
      return hits;
    } finally {
      await this.key('Escape', { cdp: this.editorCdp });
    }
  },
  async resolveFile(text) {
    const { p, line } = parseRef(text);
    if (!p) throw new Error('不是文件路径');
    const roots = await this.currentRoots();
    const ws = roots[0] || null;
    // Image references can be bare filenames; reuse the workspace lookup before editor search.
    if (this.app === 'devin' || /\.(?:png|jpe?g|gif|webp|svg|bmp)$/i.test(p)) {
      for (const root of roots.length ? roots : [null]) {
        try { return await resolveLocal(root, text); } catch (e) { if (this.app === 'devin' && (root === roots.at(-1) || !root)) throw e; }
      }
    }
    const isAbs = /^(\/|~\/|[a-zA-Z]:[\\/])/.test(p);
    const tried = [];
    const tryPath = async abs => {
      if (tried.includes(abs)) return null;
      tried.push(abs);
      const size = await fileSize(abs);
      return size == null ? null : { host: null, path: abs, size, line };
    };
    if (isAbs) {
      const hit = await tryPath(p);
      if (hit) return hit;
    } else if (roots.length) {
      for (const root of roots) {
        const hit = await tryPath(path.posix.join(root.root, p));
        if (hit) return hit;
      }
    }
    if (this.winTitle === 'Cursor Agents') {
      // The Agents window mixes projects, so try recently opened folders.
      for (const w of workspaces().filter(w => !w.host).slice(0, 8)) {
        const hit = await tryPath(isAbs ? p : path.posix.join(w.root, p));
        if (hit) return hit;
      }
      throw new Error(`找不到文件（可能已被删除或移动）：${p}`);
    }
    const name = path.posix.basename(p);
    const dir = path.posix.dirname(p);
    const hits = await this.quickOpen(name);
    // Prefer matches inside this workspace (relative dir) whose folder ends with the path the chat showed.
    const ranked = hits
      .map(h => ({ ...h, abs: h.dir.startsWith('/') ? path.posix.join(h.dir, name) : ws ? path.posix.join(ws.root, h.dir, name) : null }))
      .filter(h => h.abs)
      .sort((a, b) => (dir !== '.' && b.abs.endsWith('/' + p)) - (dir !== '.' && a.abs.endsWith('/' + p)) || a.dir.startsWith('/') - b.dir.startsWith('/'));
    for (const h of ranked) {
      const hit = await tryPath(h.abs);
      if (hit) return hit;
    }
    throw new Error(`找不到文件（可能已被删除或移动）：${p}`);
  },


  // The desktop app's own colour theme, cached process-wide per app (theme.mjs
  // themeFor); falls back to a shiki builtin matching the phone's light/dark
  // choice (sent via {t:'appTheme'}).
  async fileTheme() {
    const port = Number(new URL(EDITORS.find(e => e.app === this.app)?.url || CDP_URL).port);
    const theme = await themeFor(this.app, { port });
    return theme || (this.dark === false ? 'light-plus' : 'dark-plus');
  },
  async fileMarks(f, text, reviewDiff = '', fromChanges = false) {
    if (reviewDiff) {
      const marks = /^@@ /m.test(reviewDiff) ? parseGitDiff(reviewDiff) : agentMarks(new Map([[0, {
        kind: 'edit', f: f.path,
        diff: reviewDiff.split('\n').filter(l => /^[ +\-]/.test(l) && !/^---|^\+\+\+/.test(l)).map(l => [l[0], l.slice(1)]),
      }]]), f.path, text);
      return { marks, markSource: 'agent', diff: reviewDiff };
    }
    if (f.host) return null;
    const changes = this.app === 'codex' ? await this.cdp.evaluate(helpersCall('codexChanges()')) : null;
    const normalized = p => path.posix.normalize(pathKey(p));
    const diff = changes?.files.find(file => normalized(file.name) === normalized(f.path) || normalized(f.path).endsWith('/' + normalized(file.name)))?.diff;
    const git = await gitMarks(f.path).catch(() => null);
    if (git) {
      if (git.newFile) return { marks: { add: [], mod: [], del: [] }, markSource: 'git', newFile: true, diff };
      if (git.add.length || git.mod.length || git.del.length) {
        return { marks: { add: git.add, mod: git.mod, del: git.del }, markSource: 'git', diff };
      }
    }
    const agent = await this.adapter.fileAgentMarks.call(this, f, text, changes, diff);
    if (agent) return agent;
    if (git?.newFile) return { marks: { add: [], mod: [], del: [] }, markSource: 'git', newFile: true };
    // Devin's review panel still lists files whose changes were already committed; fall back
    // to the last commit touching the file (only for opens from the changes sheet).
    if (fromChanges) {
      const last = await lastCommitMarks(f.path).catch(() => null);
      if (last?.newFile) return { marks: { add: [], mod: [], del: [] }, markSource: 'commit', newFile: true, commit: last.commit, subject: last.subject };
      if (last) return { marks: { add: last.add, mod: last.mod, del: last.del }, markSource: 'commit', commit: last.commit, subject: last.subject };
    }
    return null;
  },
  async openFile(text, reviewDiff = '', fromChanges = false, requestId) {
    const emit = data => this.emit({ requestId, ...data });
    if (this.app === 'codex') {
      const run = (await this.cdp.evaluate(helpersCall('codexFacts()')))?.view?.run || '';
      if (run && !/local|本地/i.test(run)) {
        emit({ t: 'file', error: '当前执行位置不是本机，不能把远程路径当成电脑上的文件打开', name: path.posix.basename(parseRef(text).p) });
        return;
      }
    }
    emit({ t: 'file', loading: true, name: path.posix.basename(parseRef(text).p) });
    try {
      const f = await this.resolveFile(text);
      if (/\.mp4$/i.test(f.path) && !f.host) {
        emit({ t: 'file', name: path.basename(f.path), path: f.path, size: f.size, video: videoUrl(f.path, this.deviceId) });
        return;
      }
      if (/\.pdf$/i.test(f.path) && !f.host) {
        emit({ t: 'file', name: path.basename(f.path), path: f.path, size: f.size, pdf: pdfUrl(f.path, this.deviceId) });
        return;
      }
      const body = await readFile(f.path, f.size);
      let hl = null;
      if (body.text) {
        const theme = await this.fileTheme();
        hl = await highlightText(body.text, f.path, theme).catch(() => null);
      }
      emit({ t: 'file', name: path.posix.basename(f.path), path: f.path, host: f.host, size: f.size, line: f.line, editable: body.text != null && !body.truncated, ...body, ...(hl ? { hl } : {}) });
      // Gutter marks come afterwards — the git calls shouldn't hold the first paint.
      if (body.text) {
        this.fileMarks(f, body.text, reviewDiff, fromChanges).then(marked => {
          if (marked?.marks || marked?.newFile || marked?.diff) emit({ t: 'fileMarks', path: f.path, host: f.host, ...(marked?.marks ? { marks: marked.marks, markSource: marked.markSource } : {}), ...(marked?.newFile ? { newFile: true } : {}), ...(marked?.diff ? { diff: marked.diff } : {}), ...(marked?.commit ? { commit: marked.commit, subject: marked.subject } : {}) });
        }).catch(() => {});
      }
    } catch (e) {
      emit({ t: 'file', error: e.message, name: path.posix.basename(parseRef(text).p) });
    }
  },
  async saveFile(filePath, text, host, requestId) {
    try {
      if (host) throw new Error('只支持修改本地文件');
      const loc = locateWritable(filePath);
      if (!loc) throw new Error('只能修改已打开过的项目里的文件');
      const size = await writeTextFile(loc.path, text);
      this.emit({ t: 'saved', requestId, ok: true, path: filePath, host: '', size });
    } catch (e) {
      this.emit({ t: 'saved', requestId, ok: false, error: e.message, path: filePath, host: host || '' });
    }
  }
};
