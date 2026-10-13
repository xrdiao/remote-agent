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

const SKIP_DIRS = new Set(['node_modules', '.git', 'android']);
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

const sent = grab(appFiles, /send\(\{\s*t:\s*'([A-Za-z]+)'/g);
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

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
