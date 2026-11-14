import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { IS_WIN, normPath, localFilePath, localFileUri, uriFilePath, pathKey, samePath, validLocalName, projectPathAllowed, projectParent, projectDrives, nativeLauncher } from '../lib/platform.mjs';
import { parseAgentRef } from '../lib/shared-rules.mjs';
import { PAGE_SRC } from '../server/page/build.mjs';
import * as windowsFiles from '../server/http/transfer/windows.mjs';
import * as posixFiles from '../server/http/transfer/posix.mjs';
import '../app/js/shared-rules.js';

export const read = file => fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
export function fragment(source, start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a + start.length);
  assert(a >= 0 && b > a, start);
  return source.slice(a, b);
}
export function createPageContext(extra) {
  const context = vm.createContext({ RemoteAgentRules: globalThis.RemoteAgentRules,
    filePlatform: (extra?.IS_WIN ?? IS_WIN) ? windowsFiles : posixFiles,
    IS_WIN, normPath, localFilePath, localFileUri, uriFilePath, pathKey, samePath, validLocalName, parseAgentRef,
    projectPathAllowed, projectParent, projectDrives, nativeLauncher,
    rememberSessionStatuses: () => {}, storedSessionStatus: () => null,
    getComputedStyle: () => ({ visibility: 'visible' }), ...extra });
  context.importScripts = (...files) => files.forEach(file => vm.runInContext(read('app/' + file.split('?')[0]), context));
  return context;
}
export function nativePage(document, extra = {}, expose = '') {
  const source = PAGE_SRC.replace('  return { historyAtStart,', `  return { ${expose ? expose + ',' : ''} historyAtStart,`);
  const context = createPageContext({ document, window: {}, crypto: crypto.webcrypto, CSS: { escape: value => value }, ...extra });
  return vm.runInContext(source, context);
}
