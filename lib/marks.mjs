// Which lines of the opened file were modified, for the phone viewer's gutter bars.
// Source 1: `git diff -U0 HEAD` for files inside a work tree. Source 2 (Devin):
// the transcript's edit-item diffs matched back onto the current file text.
import { execFile } from 'node:child_process';
import path from 'node:path';
import { normPath, findBin } from './platform.mjs';

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

const GIT = findBin('git');

function runGit(args, cwd) {
  return new Promise(resolve => {
    execFile(GIT, args, { cwd, timeout: 3000, maxBuffer: 2 * 1024 * 1024 },
      (err, stdout) => resolve(err ? null : String(stdout)));
  });
}

// Membership probes (rev-parse per dir, ls-files per file) are spawn-heavy on
// Windows (~100 ms each); results are stable enough to reuse for 30 s.
const GIT_MEMO = new Map();
const memo = (key, ms, fn) => {
  const hit = GIT_MEMO.get(key);
  if (hit && Date.now() - hit.t < ms) return hit.p;
  const p = fn();
  GIT_MEMO.set(key, { t: Date.now(), p });
  if (GIT_MEMO.size > 200) GIT_MEMO.delete(GIT_MEMO.keys().next().value);
  return p;
};

// Marks for a local file inside a git work tree; null when not a repo / git fails.
export async function gitMarks(filePath) {
  const cwd = path.dirname(path.resolve(filePath));
  const base = path.basename(filePath);
  const inside = await memo(`rp|${cwd}`, 30000, () => runGit(['rev-parse', '--is-inside-work-tree'], cwd));
  if (!inside || inside.trim() !== 'true') return null;
  const tracked = await memo(`ls|${cwd}|${base}`, 30000, () => runGit(['ls-files', '--error-unmatch', '--', base], cwd));
  if (tracked === null) return { add: [], mod: [], del: [], newFile: true };
  const diff = await runGit(['diff', '--no-color', '-U0', 'HEAD', '--', base], cwd);
  if (diff == null || !diff.trim()) return { add: [], mod: [], del: [] };
  return parseGitDiff(diff);
}

// Files whose change was already committed leave a clean work tree, so nothing
// marks them. Fall back to the last commit touching the file.
export async function lastCommitMarks(filePath) {
  const cwd = path.dirname(path.resolve(filePath));
  const base = path.basename(filePath);
  const out = await runGit(['log', '-1', '-p', '-M', '--follow', '-U0', '--no-color', '--format=%H%n%s', '--', base], cwd);
  if (!out || !out.trim()) return null;
  const lines = out.split('\n');
  const sha = lines[0], subject = lines[1] || '';
  const i = out.indexOf('diff --git');
  if (i < 0) return null;
  const patch = out.slice(i);
  if (/^new file mode/m.test(patch)) return { add: [], mod: [], del: [], newFile: true, commit: sha.slice(0, 7), subject };
  const marks = parseGitDiff(patch);
  if (!marks.add.length && !marks.mod.length && !marks.del.length) return null;
  return { ...marks, commit: sha.slice(0, 7), subject };
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
  const base = path.basename(normPath(filePath)).toLowerCase();
  const norm = normPath(filePath).toLowerCase();
  const edits = [...(items?.values?.() || [])]
    .filter(it => it?.kind === 'edit' && Array.isArray(it.diff))
    .filter(it => {
      const f = normPath(it.f || '').toLowerCase();
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
