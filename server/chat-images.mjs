import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../lib/auth.mjs';
import { Cdp } from './cdp.mjs';
import { helpersCall } from './page/build.mjs';

const directory = path.join(DATA_DIR, 'chat-images');
const reading = new Map();

function imageReference(source, wsUrl = '') {
  const data = /^data:image\/([a-z0-9.+-]+);base64,([\s\S]+)$/i.exec(source);
  if (!data) {
    if (!wsUrl || source.startsWith('chat-image:')) return source;
    const id = crypto.createHash('sha256').update(wsUrl + '\n' + source).digest('hex') + '.source';
    const file = path.join(directory, id);
    if (!fs.existsSync(file)) {
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ wsUrl, source }), { mode: 0o600 });
    }
    return 'chat-image:' + id;
  }
  const id = crypto.createHash('sha256').update(source).digest('hex') + '.' + data[1];
  const file = path.join(directory, id);
  if (!fs.existsSync(file)) {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(file, Buffer.from(data[2], 'base64'));
  }
  return 'chat-image:' + id;
}

export function chatForWire(chat, wsUrl = '') {
  return { ...chat, items: chat.items.map(({ imageSources, ...item }) =>
    item.images?.length ? { ...item, images: item.images.map(source => imageReference(source, wsUrl)) } : item) };
}

export async function readChatImage(id) {
  if (!/^[a-f0-9]{64}\.[a-z0-9.+-]+$/i.test(id)) return null;
  const file = path.join(directory, id);
  if (id.endsWith('.source') && fs.existsSync(file)) {
    const source = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (source.image) return readChatImage(source.image);
    if (!reading.has(id)) reading.set(id, (async () => {
      const cdp = new Cdp(source.wsUrl);
      try {
        await cdp.connect();
        const data = await cdp.evaluate(helpersCall(`codexImage(${JSON.stringify(source.source)})`), { timeout: 60000 });
        const image = imageReference(data).slice('chat-image:'.length);
        fs.writeFileSync(file, JSON.stringify({ image }), { mode: 0o600 });
        return readChatImage(image);
      } finally { cdp.close(); }
    })().finally(() => reading.delete(id)));
    return reading.get(id);
  }
  return fs.existsSync(file) ? { file, type: 'image/' + id.slice(65) } : null;
}
