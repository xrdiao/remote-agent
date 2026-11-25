import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { computerId } from '../../lib/auth.mjs';
import { localFilePath } from '../../lib/platform.mjs';
import { ConversationRef } from './binding.mjs';

export class SourceRef {
  constructor(capability, { binding, root = '', host = '', project = binding?.windowId || '' } = {}) {
    Object.assign(this, { computerId: computerId(), app: binding?.app || '', threadId: binding?.threadId || '',
      selection: binding?.key || '', project, root, host, capability });
    Object.freeze(this);
  }
}

export async function conversationTerminalSource(session, selection, runAdapterMethod) {
  const binding = ConversationRef.capture(session);
  if (!binding.bindingReady) throw new Error('当前会话项目尚未确认，暂时无法新建终端');
  if (selection !== binding.key) throw new Error('会话已切换，请从当前会话新建终端');
  // The project readers only need native identity and transports from the captured binding.
  const reader = Object.freeze({ ...binding, currentRoots() { return runAdapterMethod(this, 'currentRoots'); } });
  const project = await runAdapterMethod(reader, 'terminalProject');
  if (!project?.root) throw new Error('未读取到唯一项目目录，暂时无法新建终端');
  return new SourceRef('conversation-terminal', { binding, root: project.root, host: project.host });
}

export async function projectWritablePath(source, file) {
  const [root, target] = await Promise.all([source.root, file].map(async value => localFilePath(await realpath(localFilePath(value)))));
  const relative = path.relative(root, target);
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative))
    throw new Error('只能修改当前项目里的文件');
  return target;
}
