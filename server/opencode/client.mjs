import { localFilePath } from '../../lib/platform.mjs';
import { OPENCODE_URL } from '../config.mjs';
import crypto from 'node:crypto';

let lastMessageTime = 0, messageSequence = 0;
export function createMessageID() {
  const now = Date.now();
  messageSequence = now === lastMessageTime ? messageSequence + 1 : 1;
  lastMessageTime = now;
  // OpenCode 1.15.5 orders messages by its 48-bit timestamp/counter prefix.
  const prefix = BigInt.asUintN(48, BigInt(now) * 0x1000n + BigInt(messageSequence));
  return 'msg_' + prefix.toString(16).padStart(12, '0') + crypto.randomBytes(7).toString('hex');
}

export class OpenCodeClient {
  constructor(url = OPENCODE_URL) { this.url = url; }

  async request(route, { directory, query = {}, method = 'GET', body, signal, response = false } = {}) {
    const url = new URL(this.url + route);
    if (directory != null) directory = localFilePath(directory);
    for (const [key, value] of Object.entries({ directory, ...query }))
      if (value != null) url.searchParams.set(key, value);
    const result = await fetch(url, { method, signal,
      ...(body !== undefined ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) });
    if (!result.ok) throw new Error(`OpenCode ${result.status}: ${await result.text()}`);
    if (response) return result;
    return result.status === 204 ? null : result.json();
  }

  async sessions() {
    const rows = [];
    let cursor;
    do {
      const result = await this.request('/experimental/session', { query: { limit: 100, cursor }, response: true });
      rows.push(...await result.json());
      cursor = result.headers.get('x-next-cursor');
    } while (cursor);
    return rows;
  }

  async messages(id, directory, before, signal) {
    const result = await this.request(`/session/${id}/message`, { directory, query: { limit: 80, before }, signal, response: true });
    return { rows: await result.json(), before: result.headers.get('x-next-cursor') };
  }
}

export async function* readEvents(response) {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let separator;
    while ((separator = /\r?\n\r?\n/.exec(buffer))) {
      const frame = buffer.slice(0, separator.index);
      buffer = buffer.slice(separator.index + separator[0].length);
      const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
      if (data) yield JSON.parse(data);
    }
  }
}
