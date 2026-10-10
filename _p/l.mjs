import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
const exe = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-'));
const proc = spawn(exe, ['--headless=new', '--remote-debugging-port=9788', `--user-data-dir=${prof}`, '--no-first-run', '--disable-gpu', 'about:blank'], { stdio: 'ignore' });
let targets;
for (let i = 0; i < 40; i++) { try { targets = await (await fetch('http://127.0.0.1:9788/json')).json(); if (targets.find(t => t.type === 'page')) break; } catch {} await new Promise(r => setTimeout(r, 250)); }
const ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
await new Promise(r => ws.on('open', r));
let id = 0; const pend = new Map();
ws.on('message', d => { const m = JSON.parse(d); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
  if (m.method === 'Runtime.exceptionThrown') console.log('PAGE ERROR', JSON.stringify(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text).slice(0, 300), 'line', m.params.exceptionDetails.lineNumber);
  if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type)) console.log('console.' + m.params.type, m.params.args.map(a => a.value ?? a.description).join(' ').slice(0, 200));
  if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') console.log('LOG', m.params.entry.text, m.params.entry.url || ''); });
const send = (method, params = {}) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async e => (await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result?.result?.value;
const sleep = ms => new Promise(r => setTimeout(r, ms));
await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable');
const url = process.argv[2];
await send('Page.navigate', { url });
await sleep(4000);
console.log('url', url, 'title', await ev('document.title'));
console.log('gate visible:', await ev(`getComputedStyle(document.getElementById('gate')).display`), '| gate text:', (await ev(`document.getElementById('gate').innerText.replace(/\\n+/g,' | ').slice(0,200)`)));
console.log('typeof send/authed:', await ev(`typeof send + ' ' + typeof authed + ' ' + (typeof MN)`));
console.log('sw cache:', await ev(`caches.keys().then(k=>k.join(','))`));
ws.close(); proc.kill();
