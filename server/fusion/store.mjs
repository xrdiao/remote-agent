import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DATA_DIR } from '../../lib/auth.mjs';
import { IS_WIN } from '../../lib/platform.mjs';

export class FusionStore {
  constructor(file = path.join(DATA_DIR, 'fusion.json')) {
    this.directory = file + '.runs';
    this.sequence = 0;
    this.data = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { version: 2, owners: {} };
    if (this.data.version !== 2) throw new Error('Fusion 状态版本不匹配');
    if (!fs.existsSync(this.directory)) return;
    const latest = new Map();
    for (const entry of fs.readdirSync(this.directory).filter(name => name.endsWith('.json'))) {
      const { sequence, current, run } = JSON.parse(fs.readFileSync(path.join(this.directory, entry), 'utf8'));
      const owner = this.data.owners[run.deviceId] ||= { current: '', runs: [] };
      const index = owner.runs.findIndex(row => row.id === run.id);
      if (index < 0) owner.runs.push(run);
      else owner.runs[index] = run;
      if (sequence > (latest.get(run.deviceId) || 0)) {
        owner.current = current;
        latest.set(run.deviceId, sequence);
      }
      this.sequence = Math.max(this.sequence, sequence);
    }
  }
  write(run) {
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const key = createHash('sha256').update(JSON.stringify([run.deviceId, run.id])).digest('hex');
    const file = path.join(this.directory, key + '.json'), temporary = file + '.pending';
    const sequence = this.sequence + 1;
    fs.writeFileSync(temporary, JSON.stringify({ sequence, current: this.data.owners[run.deviceId].current, run }), { mode: 0o600 });
    try { fs.renameSync(temporary, file); }
    catch (error) {
      if (!IS_WIN || error.code !== 'EPERM') throw error;
      // Windows can reject an atomic replacement transiently after closing the file.
      fs.renameSync(temporary, file);
    }
    this.sequence = sequence;
  }
  replace(controller, next) {
    this.write(next);
    for (const key of Object.keys(controller)) if (!Object.hasOwn(next, key)) delete controller[key];
    Object.assign(controller, next);
  }
}

export const fusionStore = new FusionStore();
