import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { zipFiles } from '../../lib/archive.mjs';
import { listDevices, needsTotp } from '../../lib/auth.mjs';
import { json, readBody, SECURITY_HEADERS, corsHeaders } from './static.mjs';
import { buildFilePreview } from '../file-preview.mjs';
import { collisionPath } from '../../lib/file-actions.mjs';
import { IS_WIN, pathKey } from '../../lib/platform.mjs';
import { transferDigestBlockSize } from '../../lib/shared-rules.mjs';
import { verifyBodyDigest } from '../../lib/device-proof.mjs';

const downloads = new Map();
export const filePlatform = await import(IS_WIN ? './transfer/windows.mjs' : './transfer/posix.mjs');
const localPath = filePlatform.localPath;

async function existingDirectory(directory) {
  for (;;) {
    try {
      if ((await fsp.stat(directory)).isDirectory()) return directory;
      throw new Error('上传目标的上级路径不是目录');
    } catch (error) {
      if (error.code !== 'ENOENT' || path.dirname(directory) === directory) throw error;
      directory = path.dirname(directory);
    }
  }
}

async function* verifiedTransfer(req, source) {
  // SHA-256 over the concatenated SHA-256 hashes of fixed-size blocks.
  const digest = crypto.createHash('sha256');
  let block = crypto.createHash('sha256'), size = 0;
  for await (const chunk of source) {
    for (let offset = 0; offset < chunk.length;) {
      const count = Math.min(transferDigestBlockSize - size, chunk.length - offset);
      block.update(chunk.subarray(offset, offset + count));
      offset += count;
      size += count;
      if (size === transferDigestBlockSize) {
        digest.update(block.digest());
        block = crypto.createHash('sha256');
        size = 0;
      }
    }
    yield chunk;
  }
  if (size) digest.update(block.digest());
  verifyBodyDigest(req, digest.digest('base64url'));
}

export async function transferApi(req, res, route, device) {
  const query = new URL(req.url, 'http://localhost').searchParams;
  let temporary = '';
  try {
    if (route === '/api/transfer/list' && req.method === 'GET') {
      const browsing = query.get('browse') === '1', location = filePlatform.directoryLocation(query), directory = location.path;
      if (location.atRoots) return json(req, res, 200, { ...location, entries: location.roots.map(root => ({ name: root, path: root, directory: true, selectable: true })) });
      if (browsing && (await fsp.stat(directory)).isFile()) return json(req, res, 200, { file: directory });
      const entries = await fsp.readdir(directory, { withFileTypes: true });
      const entryRow = async entry => {
        const file = filePlatform.joinPath(directory, entry.name);
        try {
          const stat = await fsp.stat(file);
          return { name: entry.name, path: file, directory: stat.isDirectory(), size: stat.size, link: entry.isSymbolicLink(), selectable: stat.isDirectory() || stat.isFile() };
        } catch { return { name: entry.name, path: file, selectable: false }; }
      };
      const rows = [];
      for (let offset = 0; offset < entries.length; offset += 32)
        rows.push(...await Promise.all(entries.slice(offset, offset + 32).map(entryRow)));
      rows.sort((a, b) => Number(!!b.directory) - Number(!!a.directory) || a.name.localeCompare(b.name));
      return json(req, res, 200, { ...location, entries: rows });
    }
    if (route === '/api/transfer/preview' && req.method === 'GET') {
      const file = localPath(query.get('path')), stat = await fsp.stat(file);
      const info = { name: path.basename(file), path: file, size: stat.size };
      const body = await buildFilePreview({ path: file, size: stat.size }, device.id, () => query.get('theme') === 'light' ? 'light-plus' : 'dark-plus');
      return json(req, res, 200, { ...info, ...body });
    }
    if (route === '/api/transfer/download' && req.method === 'POST') {
      const { paths } = JSON.parse(await readBody(req, 1024 * 1024));
      if (!Array.isArray(paths) || !paths.length) throw Error('请选择文件或文件夹');
      const files = [...new Map(paths.map(value => { const file = localPath(value); return [pathKey(file), file]; })).values()];
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
      const destination = filePlatform.uploadPath(directory, relative);
      const mode = query.get('mode');
      if (!['rename', 'replace', 'skip'].includes(mode)) throw Error('请选择同名文件的处理方式');
      temporary = path.join(await existingDirectory(path.dirname(destination)), '.remote-agent-' + crypto.randomUUID() + '.upload');
      await pipeline(req, source => verifiedTransfer(req, source), fs.createWriteStream(temporary, { flags: 'wx', mode: 0o600 }));
      let target = destination;
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
          if (mode === 'skip') {
            await fsp.unlink(temporary);
            return json(req, res, 200, { skipped: true, path: target });
          }
          target = collisionPath(original, suffix++);
        }
      }
      try {
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
    res.writeHead(200, headers);
    await pipeline(zipFiles(grant.files), res);
  } catch (error) {
    if (res.headersSent) res.destroy(error);
    else json(req, res, 400, { error: error.message });
  }
}
