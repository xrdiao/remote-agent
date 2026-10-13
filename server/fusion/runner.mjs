import { fusionViewers, fusionHistory, fusionWorkers } from './state.mjs';
import { FUSION_OWNER } from './owner.mjs';

export class FusionRunner {
  constructor(deviceId, fusionRun, key) {
    this.deviceId = deviceId;
    this.fusionRun = fusionRun;
    this.fusionSaved = fusionHistory[deviceId] ||= { current: '', runs: [] };
    this.app = this.windowId = this.targetId = 'fusion';
    this.threadId = fusionRun.id;
    this.fusionWorkerKey = key;
    // Matches the defaults the old fake-Session worker carried, since borrowed side
    // contexts read them through the owner.
    this.visible = true;
    this.mode = 'chat';
    this.sel = 0;
  }

  emit(obj) {
    for (const viewer of fusionViewers) {
      if (viewer.deviceId === this.deviceId &&
          viewer.app === 'fusion' &&
          viewer.fusionRun?.id === this.fusionRun.id) {
        viewer.emit(obj);
      }
    }
  }
}
Object.assign(FusionRunner.prototype, FUSION_OWNER);
