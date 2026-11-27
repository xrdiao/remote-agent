import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { isLocalFileReference, codeBlockHtml, elicitationFields } from '../../lib/shared-rules.mjs';
import { codexFileDiff } from '../../lib/codex-diff.mjs';
import { codexInputKey } from '../../lib/codex-input.mjs';
import { IS_WIN, normPath, windowsFilePath, posixFilePath, localFilePath, pathKey, samePath, localFileUri, uriFilePath } from '../../lib/platform.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
// The transcript fragments share one closure and retain their declaration order.
const CHAT_FRAGMENTS = [
  'chat-items.js', 'chat-codex-dispatch.js', 'chat-codex-history.js', 'chat-devin-transcript.js',
  'chat-cursor-times.js', 'chat-codex-status.js', 'chat-native-items.js', 'chat-extract.js',
];
const FRAGMENTS = [
  'common.js', 'composer-target.js', 'devin-composer.js', 'devin.js', 'menus.js', CHAT_FRAGMENTS, 'composer.js', 'controls.js',
  'agents.js', 'terminal.js', 'settings.js', 'terminal-dump.js', 'codex.js', 'fusion-tools.js', 'session-actions.js', 'compatibility.js', 'exports.js',
];
const readFragment = file => fs.readFileSync(path.join(DIR, file), 'utf8');
const sources = FRAGMENTS.map(fragment =>
  (Array.isArray(fragment) ? fragment.map(readFragment).join('') : readFragment(fragment)).replace(/\s+$/, ''));
const SHARED_SRC = `const IS_WIN = ${IS_WIN};
const codexFileDiff = ${codexFileDiff.toString()};
const codexInputKey = ${codexInputKey.toString()};
const normPath = ${normPath.toString()};
const fileURLToPath = value => {
  const uri = new URL(value);
  if (uri.hostname) throw new TypeError('File URL host must be localhost or empty on POSIX');
  if (/%2f/i.test(uri.pathname)) throw new TypeError('File URL path must not include encoded / characters');
  return decodeURIComponent(uri.pathname);
};
const windowsFilePath = ${windowsFilePath.toString()};
const posixFilePath = ${posixFilePath.toString()};
const localFilePath = ${localFilePath.toString()};
const pathKey = ${pathKey.toString()};
const samePath = ${samePath.toString()};
const localFileUri = ${localFileUri.toString()};
const uriFilePath = ${uriFilePath.toString()};
const RemoteAgentRules = { isLocalFileReference: ${isLocalFileReference.toString()}, codeBlockHtml: ${codeBlockHtml.toString()}, elicitationFields: ${elicitationFields.toString()} };`;
const DEVIN_COMPOSER_SRC = sources[FRAGMENTS.indexOf('devin-composer.js')];
const COMPOSER_TARGET_SRC = sources[FRAGMENTS.indexOf('composer-target.js')];
const PAGE_FACTORY = '((remoteContext = null) => {\n' + SHARED_SRC + '\n' + sources.join('\n') + '\n})';
const PAGE_SRC = PAGE_FACTORY + '()';
const PAGE_VERSION = createHash('sha256').update(PAGE_FACTORY).digest('hex');
const helpersCall = (call, context = null) => `${context ? PAGE_SRC.slice(0, -2) + '(' + JSON.stringify(context) + ')' : PAGE_SRC}.${call}`;
export { PAGE_SRC, PAGE_FACTORY, PAGE_VERSION, helpersCall, DEVIN_COMPOSER_SRC, COMPOSER_TARGET_SRC };
