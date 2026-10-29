// Repo sanity checks, run by `npm run check`:
//   1. node --check on every .mjs/.js the project owns.
//   2. Protocol: message types the frontend sends must be handled by the server,
//      and message types the server emits must be handled by the frontend.
//   3. The injected page-helper script must compile and export exactly the names
//      in scripts/page-exports.json.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rel = p => path.relative(ROOT, p);

let failures = 0;
const fail = msg => { failures++; console.error(`FAIL ${msg}`); };

// Frontend sends types built dynamically (ternaries / string concat).
const SEND_EXTRA = new Set(['codexPick', 'fusionModel']);
// Server emits that the extraction sees but the frontend does not dispatch on.
const EMIT_OK = new Set([]);

const SKIP_DIRS = new Set(['node_modules', '.git', 'android', '_shots', 'screenshots', '.codegraph', '.runtime']);
const isFragment = p => /(^|[\\/])server[\\/]page[\\/].+\.js$/.test(p);

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      if (p === path.join(ROOT, 'app', 'katex')) continue;
      yield* walk(p);
    } else if (/\.(mjs|js|html)$/.test(e.name)) {
      yield p;
    }
  }
}

const all = [...walk(ROOT)];
const jsFiles = all.filter(p => /\.(mjs|js)$/.test(p));
const appFiles = all.filter(p => rel(p).startsWith('app' + path.sep));
const serverFiles = jsFiles.filter(p => !rel(p).startsWith('app' + path.sep) && !rel(p).startsWith('scripts' + path.sep));

/* 1. syntax */
for (const f of jsFiles) {
  if (isFragment(f)) continue; // server/page/*.js are closure fragments, not standalone modules
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
  } catch (e) {
    fail(`node --check ${rel(f)}: ${String(e.stderr || e.message).trim().split('\n')[0]}`);
  }
}
console.log(`ok   syntax: ${jsFiles.filter(f => !isFragment(f)).length} files`);

/* 2. protocol */
const grab = (files, re) => {
  const out = new Set();
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    for (const m of src.matchAll(re)) out.add(m[1]);
  }
  return out;
};

const sent = grab(appFiles, /(?:send|sendQuestion)\(\{\s*t:\s*'([A-Za-z]+)'/g);
for (const t of SEND_EXTRA) sent.add(t);
// Server-handled types come from the route table; auth/ack are handled inside ws.mjs itself.
const { ROUTES } = await import(pathToFileURL(path.join(ROOT, 'server', 'routes.mjs')));
const handled = new Set([...Object.keys(ROUTES), 'auth', 'ack']);
const missingHandlers = [...sent].filter(t => !handled.has(t));
if (missingHandlers.length) fail(`frontend sends but server never handles: ${missingHandlers.join(', ')}`);
else console.log(`ok   protocol: ${sent.size} sent types all handled`);

const emitted = new Set([
  ...grab(serverFiles, /emit\(\{\s*t:\s*'([A-Za-z]+)'/g),
  ...grab(serverFiles, /JSON\.stringify\(\{\s*t:\s*'([A-Za-z]+)'/g),
]);
const frontendHandled = new Set([
  ...grab(appFiles, /\.t === '([A-Za-z]+)'/g),
  ...grab(appFiles, /case '([A-Za-z]+)'/g),
]);
const unhandled = [...emitted].filter(t => !frontendHandled.has(t) && !EMIT_OK.has(t));
if (unhandled.length) fail(`server emits but frontend never handles: ${unhandled.join(', ')}`);
else console.log(`ok   protocol: ${emitted.size} emitted types all handled`);

/* 3. page-helper exports */
async function pageSource() {
  try {
    const m = await import(pathToFileURL(path.join(ROOT, 'server', 'page', 'build.mjs')));
    if (m.PAGE_SRC) return m.PAGE_SRC;
  } catch {}
  return null;
}

const src = await pageSource();
if (!src) {
  fail('page helper source not found (server/page/build.mjs)');
} else {
  try {
    new Function(src); // compile only — running it needs a DOM
    console.log('ok   page helpers compile');
  } catch (e) {
    fail(`page helpers do not compile: ${e.message}`);
  }
  const matches = [...src.matchAll(/return\s*\{([\s\S]*?)\};/g)];
  const names = matches.length ? [...matches[matches.length - 1][1].matchAll(/[A-Za-z_$][\w$]*/g)].map(m => m[0]) : [];
  const want = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'page-exports.json'), 'utf8'));
  if (JSON.stringify(names) !== JSON.stringify(want)) {
    const extra = names.filter(n => !want.includes(n));
    const gone = want.filter(n => !names.includes(n));
    fail(`page exports differ: +${extra.join(',') || '∅'} -${gone.join(',') || '∅'}`);
  } else {
    console.log(`ok   page exports: ${names.length} helpers`);
  }
}

/* 4. missing imports */
// A refactor that drops an import line only fails at runtime (ReferenceError). Every call `name(`
// where `name` is exported by a project module must be imported in that file, or bound by a local
// declaration, parameter, destructured binding, method shorthand or catch clause. Only .mjs files
// are scanned; server/page fragments are .js and are skipped by the extension filter.
const modFiles = [];
for (const d of ['server', 'lib', 'cli', 'scripts'])
  for (const p of walk(path.join(ROOT, d))) if (p.endsWith('.mjs')) modFiles.push(p);

// Comments and string/template contents are blanked (${ } keeps its code), so literals can
// neither fake a call nor hide one. Positions are preserved.
function stripCode(src) {
  const out = src.split('');
  const blank = i => { if (out[i] !== '\n') out[i] = ' '; };
  const scanStr = (i, q) => {
    blank(i++);
    while (i < src.length) {
      if (src[i] === '\\') { blank(i++); if (i < src.length) blank(i++); continue; }
      if (src[i] === q) { blank(i++); return i; }
      if (q === '`' && src[i] === '$' && src[i + 1] === '{') { i = scan(i + 2, '}'); continue; }
      blank(i++);
    }
    return i;
  };
  const scan = (i, end) => {
    let depth = 0;
    while (i < src.length) {
      const c = src[i], c2 = src[i + 1];
      if (end && depth === 0 && c === end) return i + 1;
      if (c === '{') depth++;
      else if (c === '}') depth--;
      if (c === '/' && c2 === '/') { while (i < src.length && src[i] !== '\n') blank(i++); continue; }
      if (c === '/' && c2 === '*') {
        blank(i); blank(i + 1); i += 2;
        while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) blank(i++);
        blank(i); if (i + 1 < src.length) blank(i + 1); i += 2;
        continue;
      }
      if (c === "'" || c === '"' || c === '`') { i = scanStr(i, c); continue; }
      i++;
    }
    return i;
  };
  scan(0, null);
  return out.join('');
}

// Balanced bracket group starting at s[i] === open → [innerText, index just past the closer].
const groupAt = (s, i, open, close) => {
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    if (s[j] === open) depth++;
    else if (s[j] === close && --depth === 0) return [s.slice(i + 1, j), j + 1];
  }
  return [s.slice(i + 1), s.length];
};
const IDENT = '[A-Za-z_$][\\w$]*';
const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'with', 'function', 'class', 'return', 'else', 'do',
  'try', 'finally', 'throw', 'new', 'typeof', 'await', 'async', 'delete', 'void', 'in', 'of', 'instanceof', 'case', 'yield']);
// Identifiers bound by a destructuring pattern or parameter list; property names before `:` are not bindings.
const collectBinds = (text, set) => {
  for (const m of text.matchAll(new RegExp(IDENT, 'g')))
    if (!/^\s*:/.test(text.slice(m.index + m[0].length))) set.add(m[0]);
};

const exported = new Set();
const strippedSrc = modFiles.map(f => stripCode(fs.readFileSync(f, 'utf8')));
modFiles.forEach((f, n) => {
  const s = strippedSrc[n];
  for (const m of s.matchAll(new RegExp(`(?:^|[^\\w$])export\\s+(?:async\\s+)?(?:function\\s*\\*?|const|let|var|class)\\s+(${IDENT})`, 'g'))) exported.add(m[1]);
  for (const m of s.matchAll(/(?:^|[^\w$])export\s*\{([^}]*)\}/g))
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop();
      if (new RegExp(`^${IDENT}$`).test(name)) exported.add(name);
    }
});

modFiles.forEach((f, n) => {
  const s = strippedSrc[n];
  const imported = new Set(), local = new Set();
  for (const m of s.matchAll(/(?:^|[^\w$])import\s+([A-Za-z_$\s{},*]*?)\s+from\b/g))
    for (const id of m[1].matchAll(new RegExp(IDENT, 'g')))
      if (id[0] !== 'as' && id[0] !== 'from') imported.add(id[0]);
  // const/let/var/class: simple names, destructuring groups, and later declarators in a list.
  for (const m of s.matchAll(/(?:^|[^\w$])(?:class)\s+([A-Za-z_$][\w$]*)/g)) local.add(m[1]);
  for (const m of s.matchAll(/(?:^|[^\w$])(?:const|let|var)\s+/g)) {
    let j = m.index + m[0].length, depth = 0;
    for (; j < s.length; j++) {
      const c = s[j];
      if ('([{'.includes(c)) depth++;
      else if (')]}'.includes(c)) { if (--depth < 0) break; }
      else if (depth === 0 && c === ';') break;
    }
    let last = m.index + m[0].length;
    depth = 0;
    const head = k => {
      const part = s.slice(last, k).trimStart();
      if (part[0] === '{' || part[0] === '[') collectBinds(groupAt(part, 0, part[0], part[0] === '{' ? '}' : ']')[0], local);
      else local.add(new RegExp(`^${IDENT}`).exec(part)?.[0]);
    };
    for (let k = last; k <= j; k++) {
      const c = s[k];
      if ('([{'.includes(c)) depth++;
      else if (')]}'.includes(c)) depth--;
      if (k === j || (c === ',' && depth === 0)) { head(k); last = k + 1; }
    }
  }
  // function declarations/expressions: name + parameter bindings.
  for (const m of s.matchAll(new RegExp(`(?:^|[^\\w$])function\\s*\\*?\\s*(${IDENT})?\\s*\\(`, 'g'))) {
    if (m[1]) local.add(m[1]);
    collectBinds(groupAt(s, m.index + m[0].length - 1)[0], local);
  }
  // arrow functions: single `x =>` params and `(…​) =>` lists.
  for (const m of s.matchAll(/\)\s*=>/g)) {
    let depth = 0, j = m.index;
    for (; j >= 0; j--) { if (s[j] === ')') depth++; else if (s[j] === '(' && --depth === 0) break; }
    if (j >= 0) collectBinds(s.slice(j + 1, m.index), local);
  }
  for (const m of s.matchAll(new RegExp(`(?<![.\\w$])(${IDENT})\\s*=>`, 'g')))
    if (!KEYWORDS.has(m[1])) local.add(m[1]);
  // catch (e) bindings — not .catch(cb), whose callback would leak every identifier inside.
  for (const m of s.matchAll(/(?<![.\w$])catch\s*\(/g)) collectBinds(groupAt(s, m.index + m[0].length - 1)[0], local);
  // object/class method shorthand `name(params) {`: the name is a definition, its params are bindings.
  for (const m of s.matchAll(new RegExp(`(?<![.\\w$])(${IDENT})\\s*\\(`, 'g'))) {
    if (KEYWORDS.has(m[1])) continue;
    const [inner, end] = groupAt(s, m.index + m[0].length - 1);
    if (!/^\s*\{/.test(s.slice(end))) continue;
    local.add(m[1]);
    collectBinds(inner, local);
  }
  const miss = new Set();
  for (const m of s.matchAll(new RegExp(`(?<![.\\w$'"\`])(${IDENT})\\s*\\(`, 'g')))
    if (exported.has(m[1]) && !imported.has(m[1]) && !local.has(m[1])) miss.add(m[1]);
  if (miss.size) fail(`missing imports: ${rel(f)}: ${[...miss].sort().join(', ')}`);
});
console.log(`ok   imports: ${modFiles.length} modules`);

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
