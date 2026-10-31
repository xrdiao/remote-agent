import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import yazl from 'yazl';
import { listDevices, needsTotp } from '../../lib/auth.mjs';
import { json, readBody, SECURITY_HEADERS, corsHeaders } from './static.mjs';
import { readFile, writeTextFile } from '../../lib/files.mjs';
import { highlightText } from '../../lib/highlight.mjs';
import { pdfUrl, videoUrl } from './video.mjs';

const downloads = new Map();
const localPath = value => path.resolve(value || os.homedir());

export async function transferApi(req, res, route, device) {
  const query = new URL(req.url, 'http://localhost').searchParams;
  let temporary = '';
  try {
    if (route === '/api/transfer/list' && req.method === 'GET') {
      const browsing = query.get('browse') === '1', atRoots = query.get('roots') === '1';
      const roots = process.platform === 'win32'
        ? (await Promise.all('ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map(async c => { const drive = c + ':\\'; try { await fsp.access(drive); return drive; } catch { return null; } }))).filter(Boolean)
        : ['/'];
      if (atRoots && process.platform === 'win32') return json(req, res, 200, { path: '', parent: null, os: process.platform, roots, entries: roots.map(root => ({ name: root, path: root, directory: true, selectable: true })) });
      const directory = atRoots ? '/' : browsing ? path.resolve(query.get('base') || os.homedir(), query.get('path') || '.') : localPath(query.get('path'));
      if (browsing && (await fsp.stat(directory)).isFile()) return json(req, res, 200, { file: directory });
      const entries = await fsp.readdir(directory, { withFileTypes: true });
      const rows = await Promise.all(entries.map(async entry => {
        const file = path.join(directory, entry.name);
        try {
          const stat = await fsp.stat(file);
          return { name: entry.name, path: file, directory: stat.isDirectory(), size: stat.size, link: entry.isSymbolicLink(), selectable: stat.isDirectory() || stat.isFile() };
        } catch { return { name: entry.name, path: file, selectable: false }; }
      }));
      rows.sort((a, b) => Number(!!b.directory) - Number(!!a.directory) || a.name.localeCompare(b.name));
      let parent = path.dirname(directory);
      if ((browsing || atRoots) && parent === directory) parent = process.platform === 'win32' ? '' : null;
      return json(req, res, 200, { path: directory, parent, home: os.homedir(), roots, entries: rows, os: process.platform });
    }
    if (route === '/api/transfer/preview' && req.method === 'GET') {
      const file = localPath(query.get('path')), stat = await fsp.stat(file);
      const info = { name: path.basename(file), path: file, size: stat.size };
      if (/\.mp4$/i.test(file)) return json(req, res, 200, { ...info, video: videoUrl(file, device.id) });
      if (/\.pdf$/i.test(file)) return json(req, res, 200, { ...info, pdf: pdfUrl(file, device.id) });
      const body = await readFile(file, stat.size);
      const hl = body.text ? await highlightText(body.text, file, query.get('theme') === 'light' ? 'light-plus' : 'dark-plus').catch(() => null) : null;
      return json(req, res, 200, { ...info, ...body, editable: body.text != null && !body.truncated, ...(hl ? { hl } : {}) });
    }
    if (route === '/api/transfer/save' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req, 4 * 1024 * 1024));
      const file = await fsp.realpath(localPath(body.path));
      const size = await writeTextFile(file, body.text);
      return json(req, res, 200, { ok: true, path: body.path, size });
    }
    if (route === '/api/transfer/download' && req.method === 'POST') {
      const { paths } = JSON.parse(await readBody(req, 1024 * 1024));
      if (!Array.isArray(paths) || !paths.length) throw Error('请选择文件或文件夹');
      const files = [...new Set(paths.map(localPath))];
      const stats = await Promise.all(files.map(file => fsp.stat(file)));
      if (stats.some(s => !s.isFile() && !s.isDirectory())) throw Error('只能下载普通文件或文件夹');
      const archive = files.length > 1 || stats[0].isDirectory();
      const name = archive ? `RemoteAgent-${new Date().toISOString().replace(/[:.]/g, '-')}.zip` : path.basename(files[0]);
      for (const [id, grant] of downloads) if (grant.expires < Date.now()) downloads.delete(id);
      const id = crypto.randomUUID();
      downloads.set(id, { files, archive, name, deviceId: device.id, expires: Date.now() + 30 * 60 * 1000 });
      return json(req, res, 200, { url: '/api/transfer/get/' + id, name });
    }
    if (route === '/api/transfer/upload' && req.method === 'POST') {
      const directory = localPath(query.get('directory'));
      const relative = query.get('name') || '';
      if (!relative || relative.includes('\\') || relative.includes('\0') || path.posix.isAbsolute(relative) || relative.split('/').some(p => !p || p === '.' || p === '..') || /^[A-Za-z]:/.test(relative)) throw Error('文件路径无效');
      const mode = query.get('mode');
      if (!['rename', 'replace', 'skip'].includes(mode)) throw Error('请选择同名文件的处理方式');
      let target = path.join(directory, ...relative.split('/'));
      await fsp.mkdir(path.dirname(target), { recursive: true });
      const original = target;
      let suffix = 1;
      while (mode !== 'replace') {
        try {
          const handle = await fsp.open(target, 'wx');
          await handle.close();
          break;
        } catch (error) {
          if (error.code !== 'EEXIST') throw error;
          if (mode === 'skip') { req.resume(); return json(req, res, 200, { skipped: true, path: target }); }
          const ext = path.extname(original);
          target = path.join(path.dirname(original), `${path.basename(original, ext)} (${suffix++})${ext}`);
        }
      }
      temporary = path.join(path.dirname(target), '.remote-agent-' + crypto.randomUUID() + '.upload');
      try {
        await pipeline(req, fs.createWriteStream(temporary, { flags: 'wx', mode: 0o600 }));
        await fsp.rename(temporary, target);
        temporary = '';
      } catch (error) {
        if (mode !== 'replace') await fsp.unlink(target).catch(() => {});
        throw error;
      }
      return json(req, res, 200, { path: target, size: (await fsp.stat(target)).size });
    }
    return json(req, res, 404, { error: 'not found' });
  } catch (error) {
    if (temporary) await fsp.unlink(temporary).catch(() => {});
    if (!res.destroyed) return json(req, res, 400, { error: error.message });
  }
}

export async function serveTransfer(req, res, ticket) {
  const grant = downloads.get(ticket);
  const device = grant && listDevices().find(d => d.id === grant.deviceId);
  if (!grant || grant.expires <= Date.now() || !device || needsTotp(device)) return json(req, res, 401, { error: '下载链接已过期或设备授权失效，请重新选择下载' });
  const headers = { ...SECURITY_HEADERS, ...corsHeaders(req), 'content-type': grant.archive ? 'application/zip' : 'application/octet-stream', 'content-disposition': `attachment; filename="download${grant.archive ? '.zip' : ''}"; filename*=UTF-8''${encodeURIComponent(grant.name).replace(/'/g, '%27')}` };
  try {
    if (!grant.archive) {
      const stat = await fsp.stat(grant.files[0]);
      res.writeHead(200, { ...headers, 'content-length': stat.size });
      await pipeline(fs.createReadStream(grant.files[0]), res);
      return;
    }
    const zip = new yazl.ZipFile();
    let active = null;
    res.on('close', () => { zip.outputStream.destroy(); active?.destroy(); });
    zip.on('error', () => res.destroy());
    zip.outputStream.on('error', () => res.destroy());
    res.writeHead(200, headers);
    zip.outputStream.pipe(res);
    async function add(file, name) {
      if (res.destroyed) return;
      const stat = await fsp.lstat(file);
      // Links are not followed when walking folders, so archives cannot recurse through link cycles.
      if (stat.isSymbolicLink()) return;
      if (stat.isDirectory()) {
        zip.addEmptyDirectory(name, { mtime: stat.mtime });
        for (const entry of await fsp.readdir(file)) await add(path.join(file, entry), name + '/' + entry);
      } else if (stat.isFile()) {
        zip.addReadStreamLazy(name, { size: stat.size, mtime: stat.mtime, compress: false }, callback => {
          if (res.destroyed) return callback(Error('下载已取消'));
          active = fs.createReadStream(file);
          callback(null, active);
        });
      }
    }
    const names = new Set();
    for (const file of grant.files) {
      let name = path.basename(file) || 'root', suffix = 1;
      while (names.has(name)) name = `${path.basename(file) || 'root'} (${suffix++})`;
      names.add(name);
      await add(await fsp.realpath(file), name);
    }
    zip.end();
  } catch (error) {
    if (res.headersSent) res.destroy(error);
    else json(req, res, 400, { error: error.message });
  }
}
