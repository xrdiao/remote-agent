import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { zipFiles, extractZip } from './archive.mjs';
import { validLocalName, localFilePath, copyAfterReservedRename, copyAfterLinkFailure } from './platform.mjs';

const inside = (parent, child) => {
  const relative = path.relative(parent, child);
  return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
};
async function exists(file) {
  try { await fsp.lstat(file); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
function leafName(name) {
  if (!validLocalName(name) || path.basename(name) !== name) throw new Error('请输入文件或文件夹名称');
  return name;
}
export function collisionPath(original, suffix) {
  const ext = path.extname(original);
  return localFilePath(path.join(path.dirname(original), `${path.basename(original, ext)} (${suffix})${ext}`));
}
async function destination(directory, name, mode) {
  const original = path.join(directory, leafName(name));
  let target = original, suffix = 1;
  while (await exists(target)) {
    if (mode === 'skip') return null;
    if (mode === 'replace') return target;
    target = collisionPath(original, suffix++);
  }
  return target;
}

async function moveWithoutReplace(source, target, stat) {
  if (stat.isDirectory()) {
    try { await fsp.mkdir(target); }
    catch (error) { if (error.code === 'EEXIST') return false; throw error; }
    try {
      try { await fsp.rename(source, target); return true; }
      catch (error) {
        if (!copyAfterReservedRename(error.code)) throw error;
      }
      await fsp.cp(source, target, { recursive: true, force: false, errorOnExist: true, verbatimSymlinks: true });
    } catch (error) {
      // Remove only the empty directory we reserved. Keep any contents if copying was interrupted.
      await fsp.rmdir(target).catch(() => {});
      throw error;
    }
  } else {
    try {
      try { await fsp.link(source, target); }
      catch (error) {
        if (!copyAfterLinkFailure(error.code, stat.isFile())) throw error;
        if (stat.isSymbolicLink()) await fsp.symlink(await fsp.readlink(source), target);
        else await fsp.copyFile(source, target, fs.constants.COPYFILE_EXCL);
      }
    } catch (error) { if (error.code === 'EEXIST') return false; throw error; }
  }
  await fsp.rm(source, { recursive: stat.isDirectory() });
  return true;
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
    let staging = '', staged = '', backup = '', sourceStaged = false, installed = false, preserveStaging = false, target;
    try {
      const filename = action === 'extract' ? path.basename(source, path.extname(source)) : source ? path.basename(source) : name;
      if (action === 'extract' && path.extname(source).toLowerCase() !== '.zip') throw new Error('当前支持解压 ZIP 文件');
      target = await destination(directory, filename, mode);
      if (!target) { results.push({ source, ok: true, skipped: true }); continue; }
      const checked = source ? [source] : action === 'zip' ? sources : [];
      for (const file of checked) {
        if (inside(target, file) || (await fsp.lstat(file)).isDirectory() && inside(await fsp.realpath(file), target))
          throw new Error('目标不能是源文件本身或源文件夹的子目录');
      }
      if (action === 'move' && mode !== 'replace') {
        const stat = await fsp.lstat(source);
        while (target && !await moveWithoutReplace(source, target, stat)) target = await destination(directory, filename, mode);
        results.push(target ? { source, path: target, ok: true } : { source, ok: true, skipped: true });
        continue;
      }
      const replacing = mode === 'replace' && await exists(target);
      if (replacing || action === 'zip' || action === 'extract') {
        staging = await fsp.mkdtemp(path.join(directory, '.remote-agent-'));
        staged = path.join(staging, 'new');
      }
      const output = staged || target;
      if (action === 'zip') await pipeline(zipFiles(sources, true), fs.createWriteStream(output, { flags: 'wx' }));
      else if (action === 'extract') { await fsp.mkdir(output); await extractZip(source, output); }
      else if (action === 'create-file') await fsp.writeFile(output, '', { flag: 'wx' });
      else if (action === 'create-folder') await fsp.mkdir(output);
      else if (action === 'copy') await fsp.cp(source, output, { recursive: true, force: false, errorOnExist: true });
      else if (action === 'move') {
        try { await fsp.rename(source, output); sourceStaged = !!staged; }
        catch (error) {
          if (error.code !== 'EXDEV') throw error;
          await fsp.cp(source, output, { recursive: true, force: false, errorOnExist: true });
          if (!staged) await fsp.rm(source, { recursive: true });
        }
      }
      if (staged) {
        if (replacing) {
          const previous = path.join(staging, 'previous');
          await fsp.rename(target, previous);
          backup = previous;
        }
        await fsp.rename(staged, target);
        installed = true;
        if (action === 'move' && !sourceStaged) {
          try { await fsp.rm(source, { recursive: true }); }
          catch (error) { preserveStaging = true; throw error; }
        }
      }
      results.push({ source, path: target, ok: true });
    } catch (error) {
      let message = error.message;
      if (!installed) {
        const restore = [];
        if (backup) restore.push(fsp.rename(backup, target));
        if (sourceStaged) restore.push(fsp.rename(staged, source));
        const outcomes = await Promise.allSettled(restore);
        preserveStaging = outcomes.some(result => result.status === 'rejected');
      }
      if (preserveStaging) message += '；原有数据保留在 ' + staging;
      results.push({ source, path: target, ok: false, error: message });
    } finally { if (staging && !preserveStaging) await fsp.rm(staging, { recursive: true, force: true }); }
  }
  return { directory, results };
}
