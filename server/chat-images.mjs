import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../lib/auth.mjs';

const directory = path.join(DATA_DIR, 'chat-images');

function imageReference(source) {
  const data = /^data:image\/([a-z0-9.+-]+);base64,([\s\S]+)$/i.exec(source);
  if (!data) return source;
  const id = crypto.createHash('sha256').update(source).digest('hex') + '.' + data[1];
  const file = path.join(directory, id);
  if (!fs.existsSync(file)) {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(file, Buffer.from(data[2], 'base64'));
  }
  return 'chat-image:' + id;
}

export function chatForWire(chat) {
  return { ...chat, items: chat.items.map(({ imageSources, ...item }) =>
    item.images?.length ? { ...item, images: item.images.map(imageReference) } : item) };
}

export function readChatImage(id) {
  if (!/^[a-f0-9]{64}\.[a-z0-9.+-]+$/i.test(id)) return null;
  const file = path.join(directory, id);
  return fs.existsSync(file) ? { file, type: 'image/' + id.slice(65) } : null;
}
