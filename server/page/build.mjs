import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isLocalFileReference, codeBlockHtml, elicitationFields } from '../../lib/shared-rules.mjs';
import { IS_WIN, normPath, localFilePath, pathKey, samePath, localFileUri, uriFilePath } from '../../lib/platform.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const FRAGMENTS = [
  'common.js', 'composer-target.js', 'devin-composer.js', 'devin.js', 'menus.js', 'chat-extract.js', 'composer.js', 'controls.js',
  'agents.js', 'terminal.js', 'settings.js', 'terminal-dump.js', 'codex.js', 'fusion-tools.js', 'session-actions.js', 'compatibility.js', 'exports.js',
];
const sources = FRAGMENTS.map(f => fs.readFileSync(path.join(DIR, f), 'utf8').replace(/\s+$/, ''));
const SHARED_SRC = `const IS_WIN = ${IS_WIN};
const normPath = ${normPath.toString()};
const fileURLToPath = value => {
  const uri = new URL(value);
  if (uri.hostname) throw new TypeError('File URL host must be localhost or empty on POSIX');
  if (/%2f/i.test(uri.pathname)) throw new TypeError('File URL path must not include encoded / characters');
  return decodeURIComponent(uri.pathname);
};
const localFilePath = ${localFilePath.toString()};
const pathKey = ${pathKey.toString()};
const samePath = ${samePath.toString()};
const localFileUri = ${localFileUri.toString()};
const uriFilePath = ${uriFilePath.toString()};
const RemoteAgentRules = { isLocalFileReference: ${isLocalFileReference.toString()}, codeBlockHtml: ${codeBlockHtml.toString()}, elicitationFields: ${elicitationFields.toString()} };`;
const DEVIN_COMPOSER_SRC = sources[FRAGMENTS.indexOf('devin-composer.js')];
const COMPOSER_TARGET_SRC = sources[FRAGMENTS.indexOf('composer-target.js')];
const PAGE_SRC = '((remoteContext = null) => {\n' + SHARED_SRC + '\n' + sources.join('\n') + '\n})()';
const helpersCall = (call, context = null) => `${context ? PAGE_SRC.slice(0, -2) + '(' + JSON.stringify(context) + ')' : PAGE_SRC}.${call}`;
export { PAGE_SRC, helpersCall, DEVIN_COMPOSER_SRC, COMPOSER_TARGET_SRC };
