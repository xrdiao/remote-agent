// Which lines of the opened file were modified, for the phone viewer's gutter bars.
// Source 1: `git diff -U0 HEAD` for files inside a work tree. Source 2 (Devin):
// the transcript's edit-item diffs matched back onto the current file text.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// Parses `git diff --no-color -U0` output for ONE file → 1-based line numbers in
// the new file. del = the line AFTER which lines were removed (0 = before line 1).
export function parseGitDiff(diff) {
  const add = new Set(), mod = new Set(), del = new Set();
  let line = 0, removed = 0, added = 0, inHunk = false;
  const flush = () => {
    const overlap = Math.min(removed, added);
    for (let i = 0; i < overlap; i++) mod.add(line + i);
    for (let i = overlap; i < added; i++) add.add(line + i);
    if (removed > added) del.add(Math.max(0, line + added - 1));
    line += added;
    removed = added = 0;
  };
  for (const row of String(diff).split('\n')) {
    const hunk = row.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (hunk) {
      flush();
      line = Number(hunk[1]) + (hunk[2] === '0' ? 1 : 0);
      inHunk = true;
    } else if (inHunk && row.startsWith('-')) removed++;
    else if (inHunk && row.startsWith('+')) added++;
    else if (inHunk && row.startsWith(' ')) { flush(); line++; }
    else if (row.startsWith('diff --git')) { flush(); inHunk = false; }
  }
  flush();
  return { add: [...add], mod: [...mod], del: [...del] };
}

const GIT = process.platform === 'win32' && fs.existsSync('C:\\Program Files\\Git\\cmd\\git.exe')
  ? 'C:\\Program Files\\Git\\cmd\\git.exe' : 'git';

function runGit(args, cwd) {
  return new Promise(resolve => {
    execFile(GIT, args, { cwd, timeout: 3000, maxBuffer: 2 * 1024 * 1024 },
      (err, stdout) => resolve(err ? null : String(stdout)));
  });
}

// Marks for a local file inside a git work tree; null when not a repo / git fails.
export async function gitMarks(filePath) {
  const cwd = path.dirname(path.resolve(filePath));
  const base = path.basename(filePath);
  const inside = await runGit(['rev-parse', '--is-inside-work-tree'], cwd);
  if (!inside || inside.trim() !== 'true') return null;
  const tracked = await runGit(['ls-files', '--error-unmatch', '--', base], cwd);
  if (tracked === null) return { add: [], mod: [], del: [], newFile: true };
  const diff = await runGit(['diff', '--no-color', '-U0', 'HEAD', '--', base], cwd);
  if (diff == null || !diff.trim()) return { add: [], mod: [], del: [] };
  return parseGitDiff(diff);
}

// ---- Devin agent-diff fallback ------------------------------------------------

const normLine = s => String(s).replace(/\s+/g, ' ').trim();

// Locates one contiguous run of '+' lines inside the current file text using the
// surrounding context (' ') lines of the same edit block to disambiguate.
// Returns the 1-based line numbers the run covers, or [] when not found.
function locateRun(fileLines, run, before, after) {
  const want = run.map(normLine);
  const at = i => {
    for (let k = 0; k < want.length; k++) if (normLine(fileLines[i + k]) !== want[k]) return false;
    const b = i - before.length, a = i + want.length;
    for (let k = 0; k < before.length; k++) if (normLine(fileLines[b + k]) !== normLine(before[k])) return false;
    for (let k = 0; k < after.length; k++) if (normLine(fileLines[a + k]) !== normLine(after[k])) return false;
    return true;
  };
  const hits = [];
  for (let i = 0; i + want.length <= fileLines.length; i++) if (at(i)) hits.push(i);
  if (hits.length !== 1) return [];
  return want.map((_, k) => hits[0] + k + 1);
}

// items: transcript history (kind:'edit', f, diff:[[type,text]...]); name: opened
// file's basename or path suffix. Marks every '+' run it can place in the text.
export function agentMarks(items, filePath, text) {
  const base = path.basename(String(filePath).replace(/\\/g, '/')).toLowerCase();
  const norm = String(filePath).replace(/\\/g, '/').toLowerCase();
  const edits = [...(items?.values?.() || [])]
    .filter(it => it?.kind === 'edit' && Array.isArray(it.diff))
    .filter(it => {
      const f = String(it.f || '').replace(/\\/g, '/').toLowerCase();
      return f === base || norm.endsWith('/' + f) || f.endsWith('/' + base);
    });
  if (!edits.length) return null;
  const fileLines = String(text).replace(/\r/g, '').split('\n');
  const add = new Set(), del = new Set();
  for (const it of edits) {
    const d = it.diff;
    let i = 0;
    while (i < d.length) {
      // Collect a change block: context '-'/removed '+'/added interleaved, flanked by ' ' lines.
      if (d[i][0] === ' ') { i++; continue; }
      const before = [];
      for (let k = i - 1; k >= 0 && d[k][0] === ' '; k--) before.unshift(d[k][1]);
      const run = [];
      let j = i;
      let removed = 0;
      while (j < d.length && d[j][0] !== ' ') {
        if (d[j][0] === '+') run.push(d[j][1]);
        else if (d[j][0] === '-') removed++;
        else if (d[j][0] === '…') break;
        j++;
      }
      const after = [];
      for (let k = j; k < d.length && d[k][0] === ' '; k++) after.push(d[k][1]);
      if (run.length) {
        const at = locateRun(fileLines, run, before, after);
        at.forEach(n => add.add(n));
        // Pure removals get a marker on the line before the deletion point.
        if (removed && !at.length && run.length === 0) { /* no anchor */ }
      } else if (removed && after.length) {
        // Pure '-' block: mark on the line just before the next context line.
        const next = normLine(after[0]);
        const at = fileLines.findIndex(l => normLine(l) === next);
        if (at > 0) del.add(at);
        else if (at === 0) del.add(0);
      }
      i = Math.max(j, i + 1);
    }
  }
  if (!add.size && !del.size) return null;
  return { add: [...add], mod: [], del: [...del] };
}
