import { createHash } from 'node:crypto';
import { localFilePath } from '../../../lib/platform.mjs';
import { awaitCdpRead, cdpRead } from '../../cdp.mjs';
import { codexBackend, CODEX_BACKEND } from '../../codex/state.mjs';
import { nativeTargets, nativeWindowAt } from '../../native-windows.mjs';
import { helpersCall } from '../../page/build.mjs';
import { assertNativeProject, readNativeContext } from './native-task-adapter.mjs';

const NATIVE_LIMIT = 120;

// Output only the MCP transcript fields, before copying native desktop data over CDP.
function projectHistory(chat, threadId, readStatus = false) {
  if (chat?.thread !== threadId || !Array.isArray(chat.items)) return null;
  const roles = { human: 'user', assistant: 'assistant', notice: 'status' };
  const messages = [];
  const ids = new Set();
  for (const item of chat.items) {
    if (!Object.hasOwn(roles, item.k) || typeof item.i !== 'string' || !item.i || ids.has(item.i)) continue;
    ids.add(item.i);
    const text = String(item.t ?? '');
    messages.push({ id: item.i, role: roles[item.k], text: text.slice(0, 8000),
      ...(Number.isFinite(item.sentAt) ? { sent_at: item.sentAt } : {}),
      ...(text.length > 8000 ? { text_truncated: true } : {}) });
  }
  const state = readStatus && chat._nativeState?.thread === threadId ? chat._nativeState : null;
  const known = !!state?.waiting || !!state?.run?.id && state.run.status !== 'unknown';
  return { messages, nativeEarlier: Boolean(chat.earlier || chat._historyEarlier),
    ...(known ? { nativeStatus: { busy: !!state.busy, waiting: state.waiting || '', status_known: true } } : {}) };
}

async function readBackend(row) {
  const id = row.threadId;
  await codexBackend.client.connect();
  const thread = codexBackend.hasWriter(id) ? codexBackend.threads.get(id) : await codexBackend.readNativeThread(id);
  assertNativeProject(thread && { threadId: thread.id, cwd: localFilePath(thread.cwd) }, row.workspace, id);
  return projectHistory(codexBackend.chat(id, NATIVE_LIMIT, thread, new Set()), id);
}

async function readDesktop(row) {
  const targets = nativeTargets().filter(target => target.app === row.app && (target.pageId || target.id) === row.windowId);
  const source = targets.length === 1 && nativeWindowAt(targets[0].ws);
  if (!source) return null;
  const { app, threadId, workspace } = row;
  const cdp = source.cdp;
  await source.connect();
  const context = await readNativeContext(cdp, app, threadId);
  assertNativeProject(context, workspace, threadId);
  const id = JSON.stringify(threadId);
  const read = app === 'codex' ? helpersCall(`extract(false, [], ${NATIVE_LIMIT})`, context)
    : helpersCall(`nativeSessionInfo(${JSON.stringify(app)}, ${id}, 'history')`);
  const result = await cdp.evaluate(`(async () => (${projectHistory.toString()})(await ${read}, ${id}, ${app === 'codex'}))()`);
  assertNativeProject(await readNativeContext(cdp, app, threadId), workspace, threadId);
  return result;
}

export async function readSessionHistory(row, { limit = 30, before }) {
  const binding = createHash('sha256').update(JSON.stringify([row.app, row.windowId, row.threadId, row.workspace])).digest('hex');
  let anchor;
  if (before !== undefined) {
    try {
      const cursor = JSON.parse(Buffer.from(before, 'base64url').toString());
      if (cursor.binding !== binding || typeof cursor.anchor !== 'string' || !cursor.anchor) throw Error();
      anchor = cursor.anchor;
    } catch { throw Error('invalid_history_cursor'); }
  }
  let transcript;
  try {
    transcript = await cdpRead.run(AbortSignal.timeout(20000), () =>
      awaitCdpRead(row.app === 'codex' && row.windowId === CODEX_BACKEND ? readBackend(row) : readDesktop(row)));
  } catch (error) {
    if (error.code === 'native_project_context_mismatch') throw error;
  }
  if (!transcript) return { history_status: 'unavailable', messages: [], next_before: null, native_earlier: null };
  const { messages, nativeEarlier } = transcript;
  const end = anchor === undefined ? messages.length : messages.findIndex(message => message.id === anchor);
  if (end < 0) throw Error('history_cursor_expired');
  const start = Math.max(0, end - limit);
  const page = messages.slice(start, end);
  const turnStart = Math.max(0, messages.findLastIndex(message => message.role === 'user'));
  return {
    ...transcript.nativeStatus,
    history_status: 'available', preview_only: false,
    messages: page, next_before: start > 0
      ? Buffer.from(JSON.stringify({ binding, anchor: page[0].id })).toString('base64url') : null,
    native_earlier: nativeEarlier,
    last: (messages.findLast(message => message.role === 'assistant')?.text || '').slice(-600),
    text: messages.slice(turnStart).filter(message => message.role !== 'status').map(message => message.text).join('\n\n').slice(-600),
  };
}
