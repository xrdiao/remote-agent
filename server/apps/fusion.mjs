import { newFusionRun } from '../fusion/state.mjs';

// Fusion orchestrates native agents; their model/approval capabilities belong to each side.
export const capabilities = {
  model: false, effort: false, fast: false,
  queue: false, steer: false, queueEdit: false,
  questions: false, approvals: false, attachments: false, fileReferences: false,
  editor: false, terminal: false, settings: false, usage: true,
  fork: false, extraActions: false,
};

export const adapter = {
  async attach(req) {
    this.detach();
    this.clearViewState();
    this.app = this.targetId = this.windowId = 'fusion';
    this.threadId = '';
    this.selectedThread = undefined;
    this.winTitle = 'Fusion';
    if (!this.fusionRun) this.fusionRun = newFusionRun();
    this.threadId = this.fusionRun.id;
    this.emit({ t: 'attached', id: 'fusion', title: 'Fusion', app: 'fusion', appName: 'Fusion', project: '', windowId: 'fusion', threadId: this.threadId, sel: this.selectionKey(), initial: req.initial === true });
    this.fusionEmit();
    if (this.fusionRun.a || this.fusionRun.b) { await this.fusionCatalog(); this.fusionEmit(); }
  },
  newChat() { return this.fusionOpenHistory(''); },
  listAgents() { return this.fusionListHistory(); },
  openAgent(id) { return this.fusionOpenHistory(id); },
  sendMessage(text) { return this.fusionUserSend(text); },
  stopAgent() { return this.fusionStop(); },
  pollChat() { return this.fusionEmit(); },
};
