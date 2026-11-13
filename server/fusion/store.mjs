import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../../lib/auth.mjs';

export class FusionStore {
  constructor(file = path.join(DATA_DIR, 'fusion.json')) {
    this.file = file;
    this.data = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { version: 2, owners: {} };
    if (this.data.version !== 2) throw new Error('Fusion 状态版本不匹配');
  }
  write(value = this.data) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = this.file + '.pending';
    fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
    fs.renameSync(temporary, this.file);
  }
  replace(controller, next) {
    const owner = this.data.owners[controller.deviceId];
    const value = { ...this.data, owners: { ...this.data.owners, [controller.deviceId]: { ...owner,
      runs: owner.runs.map(row => row.id === controller.id ? next : row) } } };
    this.write(value);
    for (const key of Object.keys(controller)) if (!Object.hasOwn(next, key)) delete controller[key];
    Object.assign(controller, next);
    owner.runs = owner.runs.map(row => row.id === controller.id ? controller : row);
    return controller;
  }
}

export const fusionStore = new FusionStore();
