import fs from 'node:fs';
import os from 'node:os';
import { findBin, IS_WIN } from '../../lib/platform.mjs';
import { AGENT_REGISTRY } from '../apps/index.mjs';
import { codexBackend } from '../codex/state.mjs';
import { filePlatform } from '../http/transfer.mjs';
import { nativeTargets, nativeWindowAt } from '../native-windows.mjs';
import { openCode } from '../opencode/state.mjs';
import { peerId } from '../peer/access.mjs';
import { boundPeerWorkspace, peerWorkspaceBindings, peerWorkspaceGrants } from '../peer/workspace.mjs';
import { phoneTargets } from '../phone/control.mjs';
import { terminalService } from '../terminal-service.mjs';
import { fileActions, terminalActions } from './contract.mjs';

function access(file, mode) {
  try { fs.accessSync(file, mode); return true; }
  catch { return false; }
}

function localCapabilities(deviceId) {
  const live = new Set(nativeTargets().filter(win => nativeWindowAt(win.ws)?.cdp.ws?.readyState === 1).map(win => win.app));
  if (codexBackend.client.ready) live.add('codex');
  if (openCode.connected) live.add('opencode');
  const { phones, conversations } = phoneTargets(deviceId);
  const phoneReady = phones.some(phone => phone.conversation) || conversations.some(row => row.state === 'ready');
  const canStartTerminal = access(IS_WIN ? findBin('bash') : terminalService.shell, fs.constants.X_OK);
  return [
    ...Object.values(AGENT_REGISTRY).filter(agent => agent.discover).map(({ app }) =>
      ({ id: 'agent:' + app, availability: live.has(app) ? 'ready' : 'unavailable' })),
    { id: 'files', availability: access(filePlatform.localPath('.', os.homedir()), fs.constants.R_OK) ? 'ready' : 'unavailable' },
    { id: 'terminal', availability: terminalService.list().some(row => !row.exited) ? 'ready' : canStartTerminal ? 'unverified' : 'unavailable' },
    { id: 'phone', availability: phoneReady ? 'ready' : 'unavailable' },
  ];
}

export function createNodeRegistry(computerId) {
  return {
    workspace: boundPeerWorkspace,
    list(deviceId) {
      const nodes = new Map();
      const remote = id => {
        if (!nodes.has(id)) nodes.set(id, { id, kind: 'peer', knownIncomingGrants: 0, workspaces: [] });
        return nodes.get(id);
      };
      for (const { target, workspace } of peerWorkspaceBindings()) if (target !== computerId) {
        remote(target).workspaces.push({ id: workspace, state: 'registered', capabilities: [
          { id: 'files', availability: 'unverified', actions: fileActions },
          { id: 'terminal', availability: 'unverified', actions: terminalActions },
        ] });
      }
      for (const { source } of peerWorkspaceGrants()) if (peerId(source) && source !== computerId) remote(source).knownIncomingGrants++;
      return [{ id: computerId, kind: 'local', capabilities: localCapabilities(deviceId) }, ...nodes.values()];
    },
  };
}
