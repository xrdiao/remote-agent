import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const FRAGMENTS = [
  'common.js', 'devin-composer.js', 'devin.js', 'menus.js', 'chat-extract.js', 'composer.js', 'controls.js',
  'agents.js', 'terminal.js', 'settings.js', 'terminal-dump.js', 'codex.js', 'fusion-tools.js', 'session-actions.js', 'compatibility.js', 'exports.js',
];
const sources = FRAGMENTS.map(f => fs.readFileSync(path.join(DIR, f), 'utf8').replace(/\s+$/, ''));
const DEVIN_COMPOSER_SRC = sources[FRAGMENTS.indexOf('devin-composer.js')];
const PAGE_SRC = '((remoteContext = null) => {\n' + sources.join('\n') + '\n})()';
const helpersCall = (call, context = null) => `${context ? PAGE_SRC.slice(0, -2) + '(' + JSON.stringify(context) + ')' : PAGE_SRC}.${call}`;
export { PAGE_SRC, helpersCall, DEVIN_COMPOSER_SRC };
