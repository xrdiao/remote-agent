// Minimal X11 client for iconifying a top-level window (Electron builds used by the
// supported apps expose no window-management methods over CDP). Speaks just enough of
// the protocol over /tmp/.X11-unix/XN to query the root tree, read _NET_WM_PID and
// window names, and send a WM_CHANGE_STATE IconicState client message to the WM.
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const pad4 = n => (4 - (n % 4)) % 4;

function readXauthority(display) {
  const files = [];
  if (process.env.XAUTHORITY) files.push(process.env.XAUTHORITY);
  files.push(path.join(os.homedir(), '.Xauthority'));
  for (const f of files) {
    let buf;
    try { buf = fs.readFileSync(f); } catch { continue; }
    let off = 0;
    while (off + 8 <= buf.length) {
      const family = buf.readUInt16BE(off);
      const addrLen = buf.readUInt16BE(off + 2); const addr = buf.subarray(off + 4, off + 4 + addrLen); off += 4 + addrLen;
      const numLen = buf.readUInt16BE(off); const num = buf.subarray(off + 2, off + 2 + numLen).toString(); off += 2 + numLen;
      const nameLen = buf.readUInt16BE(off); const name = buf.subarray(off + 2, off + 2 + nameLen).toString(); off += 2 + nameLen;
      const dataLen = buf.readUInt16BE(off); const data = buf.subarray(off + 2, off + 2 + dataLen); off += 2 + dataLen;
      if (num === display && name === 'MIT-MAGIC-COOKIE-1') return { name, data };
    }
  }
  return null;
}

class X11 {
  static async connect() {
    const display = (process.env.DISPLAY || ':0').replace(/^.*?:/, '').replace(/\..*$/, '');
    const sock = `/tmp/.X11-unix/X${display}`;
    const auth = readXauthority(display);
    const req = Buffer.alloc(12);
    req[0] = 0x6c; // little-endian
    req.writeUInt16LE(11, 2); req.writeUInt16LE(0, 4);
    const name = auth?.name || '', data = auth?.data || Buffer.alloc(0);
    req.writeUInt16LE(name.length, 6); req.writeUInt16LE(data.length, 8);
    const hello = Buffer.concat([req, Buffer.from(name), Buffer.alloc(pad4(name.length)), data, Buffer.alloc(pad4(data.length))]);
    const x = new X11();
    x.seq = 0;
    x.pending = new Map();
    x.buf = Buffer.alloc(0);
    await new Promise((resolve, reject) => {
      x.sock = net.createConnection(sock);
      x.sock.once('error', reject);
      x.sock.on('data', d => x.onData(d));
      x.sock.write(hello);
      x.ready = () => resolve();
      x.readyErr = reject;
      // Never leave callers hanging on a dead/silent socket: any close or error
      // after connect rejects every in-flight request.
      x.sock.on('close', () => x.fail(new Error('X11 socket closed')));
      x.sock.on('error', e => x.fail(e));
    });
    return x;
  }

  fail(err) {
    for (const p of this.pending.values()) p(err);
    this.pending.clear();
    if (this.ready) { const r = this.readyErr; this.ready = null; this.readyErr = null; this.err = String(err); r(err); }
  }

  onData(d) {
    this.buf = Buffer.concat([this.buf, d]);
    for (;;) {
      if (this.buf.length < 8) return;
      if (this.ready) {
        const status = this.buf[0];
        const extra = this.buf.readUInt16LE(6) * 4;
        if (this.buf.length < 8 + extra) return;
        this.idBase = status === 1 ? this.buf.readUInt32LE(12) : 0;
        this.idMask = status === 1 ? this.buf.readUInt32LE(16) : 0;
        if (status === 1) {
          const vendorLen = this.buf.readUInt16LE(24);
          const numFormats = this.buf[29];
          // screen block starts after vendor string + pixmap formats; root is its first field
          const screenOff = 40 + vendorLen + pad4(vendorLen) + numFormats * 8;
          this.root = this.buf.readUInt32LE(screenOff);
        } else this.root = 0;
        this.err = status === 1 ? null : 'X11 setup rejected';
        const ready = this.ready; this.ready = null; this.readyErr = null;
        this.buf = this.buf.subarray(8 + extra);
        ready();
        continue;
      }
      const kind = this.buf[0];
      const len = kind === 1 ? 32 + this.buf.readUInt32LE(4) * 4 : 32;
      if (this.buf.length < len) return;
      const pkt = this.buf.subarray(0, len);
      this.buf = this.buf.subarray(len);
      if (kind === 1) {
        const seq = pkt.readUInt16LE(2);
        const p = this.pending.get(seq);
        if (p) { this.pending.delete(seq); p(pkt); }
      } else if (kind === 0) {
        const seq = pkt.readUInt16LE(2);
        const p = this.pending.get(seq);
        if (p) { this.pending.delete(seq); p(new Error(`X11 error ${pkt[1]}`)); }
      }
    }
  }

  request(opcode, payload, hasReply = true, extraByte = 0) {
    const seq = ++this.seq;
    const len = 1 + Math.ceil(payload.length / 4); // request length in 4-byte units incl. header
    const buf = Buffer.alloc(len * 4);
    buf[0] = opcode; buf[1] = extraByte;
    buf.writeUInt16LE(len, 2);
    payload.copy(buf, 4);
    return new Promise((resolve, reject) => {
      if (hasReply) this.pending.set(seq, r => (r instanceof Error ? reject(r) : resolve(r)));
      this.sock.write(buf, () => { if (!hasReply) resolve(null); });
    });
  }

  async internAtom(name) {
    const p = Buffer.alloc(4 + name.length);
    p.writeUInt16LE(name.length, 0);
    p.write(name, 4);
    const r = await this.request(16, p, true, 0); // InternAtom
    return r.readUInt32LE(8);
  }

  async queryTree(win) {
    const p = Buffer.alloc(4); p.writeUInt32LE(win, 0);
    const r = await this.request(15, p); // QueryTree
    const n = r.readUInt16LE(16);
    const children = [];
    for (let i = 0; i < n; i++) children.push(r.readUInt32LE(32 + i * 4));
    return children;
  }

  async getProperty(win, property, type) {
    const p = Buffer.alloc(20);
    p.writeUInt32LE(win, 0); p.writeUInt32LE(property, 4); p.writeUInt32LE(type, 8);
    p.writeUInt32LE(0, 12); p.writeUInt32LE(0x1000, 16); // offset, length
    const r = await this.request(20, p, true, 0); // GetProperty
    const format = r[1]; // reply byte 1 = format for GetProperty
    const valueLen = r.readUInt32LE(16);
    if (format === 32) return valueLen ? r.readUInt32LE(32) : null;
    if (format === 8) return r.subarray(32, 32 + valueLen).toString('utf8').replace(/\0+$/, '');
    return null;
  }

  async sendClientMessage(destWin, targetWin, typeAtom, format, data) {
    const ev = Buffer.alloc(32);
    ev[0] = 33; // ClientMessage
    ev[1] = format;
    ev.writeUInt32LE(targetWin, 4); ev.writeUInt32LE(typeAtom, 8);
    for (let i = 0; i < data.length; i++) ev.writeUInt32LE(data[i], 12 + i * 4);
    const p = Buffer.alloc(8 + 32);
    p.writeUInt32LE(destWin, 0); p.writeUInt32LE(0x00180000, 4); // SubstructureRedirect|SubstructureNotify
    ev.copy(p, 8);
    await this.request(25, p, false, 0); // SendEvent
  }
}

const STR_CACHE = new Map();
async function atom(x, name) {
  if (!STR_CACHE.has(name)) STR_CACHE.set(name, x.internAtom(name));
  return STR_CACHE.get(name);
}

// Iconifies the top-level window owned by `pid` whose title is `title` (exact match).
// Falls back to title-only matching when no pid match exists. Returns the X11 window
// id on success, 0 when nothing matched.
export async function x11IconifyWindow(pid, title, timeoutMs = 2000) {
  let x = null;
  const timer = new Promise(resolve => setTimeout(() => { try { x?.sock.destroy(); } catch {} resolve(0); }, timeoutMs));
  const work = (async () => {
    x = await X11.connect();
    try {
    if (!x.root) return 0;
    const PID = await atom(x, '_NET_WM_PID');
    const NAME = await atom(x, '_NET_WM_NAME');
    const UTF8 = await atom(x, 'UTF8_STRING');
    const WM_NAME = await atom(x, 'WM_NAME');
    const STRING = await atom(x, 'STRING');
    const CARDINAL = await atom(x, 'CARDINAL');
    const WM_CHANGE_STATE = await atom(x, 'WM_CHANGE_STATE');
    const children = await x.queryTree(x.root);
    let fallback = 0;
    for (const w of children) {
      const name = await x.getProperty(w, NAME, UTF8).catch(() => null) ?? await x.getProperty(w, WM_NAME, STRING).catch(() => null);
      if (name !== title) continue;
      if (pid != null) {
        const wpid = await x.getProperty(w, PID, CARDINAL).catch(() => null);
        if (wpid === pid) {
          await x.sendClientMessage(x.root, w, WM_CHANGE_STATE, 32, [3, 0, 0, 0, 0]);
          return w;
        }
        fallback = w; // title matches but owner pid unknown/different — keep as last resort
      } else fallback = w;
    }
    if (fallback) {
      await x.sendClientMessage(x.root, fallback, WM_CHANGE_STATE, 32, [3, 0, 0, 0, 0]);
      return fallback;
    }
    return 0;
    } finally {
      x.sock.destroy();
    }
  })();
  return Promise.race([work.catch(() => 0), timer]);
}
