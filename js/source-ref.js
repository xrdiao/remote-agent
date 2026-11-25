/* Provenance for work that can outlive the current screen or socket. */
class SourceRef {
  constructor(computer, capability, { selection = '', app = '', windowId = '', threadId = '', project = '', root = '' } = {}) {
    Object.assign(this, {
      computerId: computer?.id || '', key: computer?.key || '', deviceId: computer?.device,
      capability, selection, app, windowId, threadId, project, root,
    });
    Object.freeze(this);
  }
  withRoot(root) {
    return new SourceRef({ id: this.computerId, key: this.key, device: this.deviceId }, this.capability, {
      selection: this.selection, app: this.app, windowId: this.windowId, threadId: this.threadId, project: this.project, root,
    });
  }
  computer() {
    return loadComputers().find(computer => this.matchesComputer(computer));
  }
  matchesComputer(computer) {
    return !!computer && this.computerId === computer.id && this.key === computer.key && this.deviceId === computer.device;
  }
  link() {
    const link = linkForComputerKey(this.key);
    return this.computer() && link?.authed && link.expectedId === this.computerId
      && link.auth.device === this.deviceId && link.socket.readyState === 1 ? link : null;
  }
  isCurrent() {
    return this.matchesComputer(currentComputer()) && (!this.selection || this.selection === viewSel);
  }
  static current(capability, conversation = true) {
    const computer = currentComputer();
    return new SourceRef(computer, capability, conversation ? {
      selection: viewSel, app: currentApp || '', windowId: computer?.windowId, threadId: computer?.threadId, project: currentProject,
    } : {});
  }
}
