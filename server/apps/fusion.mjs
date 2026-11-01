import { savedFusion, findFusionRun } from '../fusion/state.mjs';
import { rememberSelection } from '../../lib/auth.mjs';

export const capabilities = {
  model: false, effort: false, fast: false, queue: false, steer: false, queueEdit: false,
  questions: false, approvals: false, attachments: false, fileReferences: false,
  editor: false, terminal: false, settings: false, usage: true, fork: false, extraActions: false,
};

export const adapter = {
  attach(req) {
    const saved = savedFusion(this.deviceId);
    const selected = req.threadId ? findFusionRun(this.deviceId, req.threadId) : null;
    this.detach();
    this.clearViewState();
    this.app = this.targetId = this.windowId = 'fusion';
    this.fusionRun = selected;
    this.threadId = selected?.id || '';
    this.selectedThread = undefined;
    this.winTitle = 'Fusion';
    this.bindingReady = true;
    if (selected) {
      saved.current = selected.id;
      rememberSelection(this.deviceId, { id: 'fusion', app: 'fusion', windowId: 'fusion', threadId: selected.id, project: null });
    }
    this.emit({ t: 'attached', id: 'fusion', title: 'Fusion', app: 'fusion', appName: 'Fusion', project: selected?.project?.name || '',
      windowId: 'fusion', threadId: this.threadId, sel: this.selectionKey(), initial: req.initial === true, ready: true });
    this.fusionEmit();
  },
  listAgents() { return this.fusionWorkspace(); },
  openAgent(id) { return adapter.attach.call(this, { threadId: id }); },
  sendMessage(text, requestId) { return this.fusionUserSend(text, requestId); },
  stopAgent() { return this.fusionStop(); },
  pollChat() { return this.fusionEmit(); },
};
