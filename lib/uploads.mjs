import fs from 'node:fs';
import path from 'node:path';

export const uploads = new Map();
export const pendingUploads = sel => [...uploads].filter(([, file]) => file.pending && file.sel === sel);
export const uploadAttachments = sel => pendingUploads(sel).map(([id, file]) => ({ id, name: file.name, size: file.size }));

function saveUpload(file) {
  const { request, ...record } = file;
  const metadata = path.dirname(file.path) + '.json';
  fs.writeFileSync(metadata + '.pending', JSON.stringify(record), { mode: 0o600 });
  fs.renameSync(metadata + '.pending', metadata);
}

export function registerUpload(root, id, file) {
  fs.mkdirSync(path.join(root, id), { recursive: true, mode: 0o700 });
  uploads.set(id, file);
  saveUpload(file);
}

export function updateUpload(file, fields) {
  Object.assign(file, fields);
  saveUpload(file);
}

export function initializeUploads(root, devices) {
  if (!fs.existsSync(root)) return [];
  for (const name of fs.readdirSync(root).filter(name => name.endsWith('.json'))) {
    const id = name.slice(0, -5), record = JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
    const file = { ...record, path: path.join(root, id, record.name) };
    uploads.set(id, file);
    if (!file.complete || !fs.existsSync(file.path) || !devices.includes(file.deviceId)) removeUpload(id);
  }
  return fs.readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory() && !uploads.has(entry.name))
    .map(entry => path.join(root, entry.name));
}

export function removeDeviceUploads(root, deviceId) {
  if (fs.existsSync(root)) for (const name of fs.readdirSync(root).filter(name => name.endsWith('.json'))) {
    const id = name.slice(0, -5), record = JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
    if (record.deviceId === deviceId && !uploads.has(id)) uploads.set(id, { ...record, path: path.join(root, id, record.name) });
  }
  for (const [id, file] of uploads) if (file.deviceId === deviceId) removeUpload(id);
}

export function removeUpload(id) {
  const file = uploads.get(id);
  if (!file) return;
  uploads.delete(id);
  file.request?.destroy(new Error('上传所属设备已移除或上传已取消'));
  fs.rmSync(path.dirname(file.path), { recursive: true, force: true });
  fs.rmSync(path.dirname(file.path) + '.json', { force: true });
  fs.rmSync(path.dirname(file.path) + '.json.pending', { force: true });
}
