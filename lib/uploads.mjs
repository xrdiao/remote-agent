import fs from 'node:fs';
import path from 'node:path';

export const uploads = new Map();
export const pendingUploads = sel => [...uploads].filter(([, file]) => file.pending && file.sel === sel);
export const uploadAttachments = sel => pendingUploads(sel).map(([id, file]) => ({ id, name: file.name, size: file.size }));

export function removeUpload(id) {
  const file = uploads.get(id);
  if (!file) return;
  fs.rmSync(path.dirname(file.path), { recursive: true, force: true });
  uploads.delete(id);
}
