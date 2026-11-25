import { createHash } from 'node:crypto';

export const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const digestId = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export const operationId = value => typeof value === 'string'
  && /^\d{13}-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);

export const fileActions = Object.freeze(['list-files', 'read-file', 'create-file', 'save-file']);
export const terminalActions = Object.freeze(['open-terminal', 'read-terminal', 'send-terminal', 'interrupt-terminal', 'close-terminal']);
export const workspaceActions = Object.freeze([...fileActions, ...terminalActions]);

export class RaCoreError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}

export function fields(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key)))
    throw new RaCoreError(400, 'invalid_request');
}

export function actionArgs(action, args) {
  const file = fileActions.includes(action);
  const hasText = ['create-file', 'save-file', 'send-terminal'].includes(action);
  fields(args, [...(file ? ['path'] : []), ...(hasText ? ['text'] : [])]);
  const path = args.path ?? (action === 'list-files' ? '.' : undefined);
  if (file && (typeof path !== 'string' || !path || Buffer.byteLength(path) > 1024
    || /[\\\u0000-\u001f\u007f]/.test(path) || /^[a-z]:/i.test(path)
    || (path !== '.' || action !== 'list-files') && path.split('/').some(part => !part || part === '.' || part === '..')))
    throw new RaCoreError(400, 'invalid_workspace_path');
  const { text } = args;
  if (hasText && (typeof text !== 'string' || text.includes('\0') || Buffer.byteLength(text) > (file ? 32 * 1024 : 8192)
    || !file && (!text.trim() || /[\x00-\x08\x0b-\x1f\x7f]/.test(text))))
    throw new RaCoreError(400, 'invalid_workspace_text');
  return { ...(file ? { path } : {}), ...(hasText ? { text } : {}) };
}

const size = value => Number.isSafeInteger(value) && value >= 0;
const entryTypes = ['directory', 'file', 'symlink', 'other'];

export function peerResult(action, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (action === 'list-files') {
    const { entries, truncated } = value;
    if (typeof truncated !== 'boolean' || !Array.isArray(entries) || entries.length > 128
      || entries.some(entry => typeof entry?.name !== 'string' || entry.name.length > 1024 || !entryTypes.includes(entry.type))) return null;
    return { summary: { entryCount: entries.length, truncated }, data: { entries: entries.map(({ name, type }) => ({ name, type })), truncated } };
  }
  if (fileActions.includes(action)) {
    if (!size(value.size)) return null;
    if (action !== 'read-file') return { summary: { size: value.size } };
    if (typeof value.text !== 'string' || typeof value.truncated !== 'boolean') return null;
    return { summary: { size: value.size, truncated: value.truncated }, data: { text: value.text } };
  }
  if (action === 'close-terminal') return value.closed === true ? { summary: { closed: true } } : null;
  if (action === 'send-terminal' || action === 'interrupt-terminal')
    return value.sent === true ? { summary: { sent: true } } : null;
  if (typeof value.exited !== 'boolean') return null;
  const summary = { exited: value.exited, ...(Number.isSafeInteger(value.exitCode) ? { exitCode: value.exitCode } : {}) };
  if (action === 'open-terminal') return { summary };
  if (action !== 'read-terminal' || typeof value.output !== 'string' || typeof value.truncated !== 'boolean') return null;
  return { summary: { ...summary, truncated: value.truncated }, data: { output: value.output } };
}
