import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { zipFiles, extractZip } from './archive.mjs';

const inside = (parent, child) => child === parent || child.startsWith(parent + path.sep);
async function exists(file) {
  try { await fsp.lstat(file); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
function leafName(name) {
  if (!name || name === '.' || name === '..' || name.includes('\0') || path.basename(name) !== name) throw new Error('请输入文件或文件夹名称');
  return name;
}
async function destination(directory, name, mode) {
  const original = path.join(directory, leafName(name));
  let target = original, suffix = 1;
  while (await exists(target)) {
    if (mode === 'skip') return null;
    if (mode === 'replace') return target;
    const ext = path.extname(original);
    target = path.join(directory, `${path.basename(original, ext)} (${suffix++})${ext}`);
  }
  return target;
}

export async function fileAction({ action, directory, paths = [], name = '', mode = 'rename' }) {
  if (!['create-file', 'create-folder', 'copy', 'move', 'zip', 'extract'].includes(action)) throw new Error('未知文件操作');
  if (!['rename', 'skip', 'replace'].includes(mode)) throw new Error('请选择同名文件的处理方式');
  directory = await fsp.realpath(directory);
  if (!(await fsp.stat(directory)).isDirectory()) throw new Error('目标不是文件夹');
  const sources = [...new Set(paths.map(file => path.resolve(file)))];
  if (!action.startsWith('create-') && !sources.length) throw new Error('请选择文件或文件夹');
  const inputs = action.startsWith('create-') || action === 'zip' ? [''] : sources;
  const results = [];
  for (const source of inputs) {
    let temporary = '', target;
    try {
      const filename = action === 'extract' ? path.basename(source, path.extname(source)) : source ? path.basename(source) : name;
      if (action === 'extract' && path.extname(source).toLowerCase() !== '.zip') throw new Error('当前支持解压 ZIP 文件');
      target = await destination(directory, filename, mode);
      if (!target) { results.push({ source, ok: true, skipped: true }); continue; }
      const checked = source ? [source] : action === 'zip' ? sources : [];
      for (const file of checked) {
        if (target === file || (await fsp.lstat(file)).isDirectory() && inside(await fsp.realpath(file), target))
          throw new Error('目标不能是源文件本身或源文件夹的子目录');
      }
      if (action === 'zip') {
        temporary = path.join(directory, '.remote-agent-' + crypto.randomUUID() + '.zip');
        await pipeline(zipFiles(sources, true), fs.createWriteStream(temporary, { flags: 'wx' }));
      } else if (action === 'extract') {
        temporary = await fsp.mkdtemp(path.join(directory, '.remote-agent-extract-'));
        await extractZip(source, temporary);
      }
      if (mode === 'replace') await fsp.rm(target, { recursive: true, force: true });
      if (temporary) { await fsp.rename(temporary, target); temporary = ''; }
      else if (action === 'create-file') await fsp.writeFile(target, '', { flag: 'wx' });
      else if (action === 'create-folder') await fsp.mkdir(target);
      else if (action === 'copy') await fsp.cp(source, target, { recursive: true, force: false, errorOnExist: true });
      else if (action === 'move') {
        try { await fsp.rename(source, target); }
        catch (error) {
          if (error.code !== 'EXDEV') throw error;
          await fsp.cp(source, target, { recursive: true, force: false, errorOnExist: true });
          await fsp.rm(source, { recursive: true });
        }
      }
      results.push({ source, path: target, ok: true });
    } catch (error) { results.push({ source, path: target, ok: false, error: error.message }); }
    finally { if (temporary) await fsp.rm(temporary, { recursive: true, force: true }); }
  }
  return { directory, results };
}
