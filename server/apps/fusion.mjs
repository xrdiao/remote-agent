import { fusionState, findFusionRun } from '../fusion/state.mjs';
import { rememberSelection } from '../../lib/auth.mjs';

export const capabilities = {
  model: false, effort: false, fast: false, queue: false, steer: false, queueEdit: false,
  questions: false, approvals: false, attachments: false, fileReferences: false,
  editor: false, terminal: false, settings: false, usage: true, fork: false, extraActions: false,
};

export const adapter = {
  async attach(req) {
    const selected = req.threadId ? findFusionRun(req.threadId) : null;
    if (selected) fusionState.select(this.deviceId, selected);
    const main = selected?.bindings.find(binding => binding.id === selected.main.bindingId);
    if (main) {
      return this.attach({ id: main.app, windowId: main.windowId, threadId: main.threadId,
        project: main.project, initial: req.initial, resume: req.resume });
    }
    this.detach();
    this.clearViewState();
    this.app = this.targetId = this.windowId = 'fusion';
    this.fusionRun = selected;
    this.threadId = selected?.id || '';
    this.selectedThread = undefined;
    this.winTitle = 'Fusion';
    this.bindingReady = true;
    if (selected) {
      rememberSelection(this.deviceId, { id: 'fusion', app: 'fusion', windowId: 'fusion', threadId: selected.id, project: null });
    }
    this.emit({ t: 'attached', id: 'fusion', title: 'Fusion', app: 'fusion', appName: 'Fusion', project: selected?.project?.name || '',
      windowId: 'fusion', threadId: this.threadId, sel: this.selectionKey(), initial: req.initial === true, ready: true });
    this.fusionEmit();
  },
  listAgents() { return this.fusionWorkspace(); },
  openAgent(id) { return adapter.attach.call(this, { threadId: id }); },
  sendMessage() { throw new Error('请先启用主 Agent，再进入原生主对话'); },
  stopAgent() { return this.fusionStop(); },
  pollChat() { return this.fusionEmit(); },
};

export const nativeCapabilities = {
  orchestrator: {
    actions: {
      stop: adapter.stopAgent,
      async sendMessage(text, submit, _when, _mentions, receipt) {
        if (submit && receipt) this.draftEpoch = receipt.draftEpoch || '';
        const queued = await adapter.sendMessage.call(this, text, receipt?.requestId);
        if (receipt) this.emit({ t: 'sent', ...receipt, queued, sentAt: Date.now(), sel: this.selectionKey() });
        return queued;
      },
    },
  },
};
