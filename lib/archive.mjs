import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import yazl from 'yazl';
import { findBin, IS_WIN } from './platform.mjs';
import { windowsInvalidName } from './platform/windows.mjs';

export function zipFiles(files, compress = false) {
  const zip = new yazl.ZipFile();
  let active;
  zip.on('error', error => zip.outputStream.destroy(error));
  zip.outputStream.on('close', () => active?.destroy());
  async function add(file, name) {
    if (zip.outputStream.destroyed) return;
    const stat = await fsp.lstat(file);
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      zip.addEmptyDirectory(name, { mtime: stat.mtime });
      for (const entry of await fsp.readdir(file)) await add(path.join(file, entry), name + '/' + entry);
    } else if (stat.isFile()) {
      zip.addReadStreamLazy(name, { size: stat.size, mtime: stat.mtime, compress }, callback => {
        if (zip.outputStream.destroyed) return callback(new Error('归档已取消'));
        active = fs.createReadStream(file);
        callback(null, active);
      });
    }
  }
  (async () => {
    const names = new Set();
    for (const file of files) {
      let name = path.basename(file) || 'root', suffix = 1;
      while (names.has(name)) name = `${path.basename(file) || 'root'} (${suffix++})`;
      names.add(name);
      await add(await fsp.realpath(file), name);
    }
    zip.end();
  })().catch(error => zip.outputStream.destroy(error));
  return zip.outputStream;
}

export function extractZip(file, directory) {
  const nameRules = IS_WIN ? [windowsInvalidName.source] : [];
  const script = `import os, pathlib, re, sys, zipfile
invalid_name = re.compile(sys.argv[3], re.IGNORECASE) if len(sys.argv) > 3 else None
targets = {}
with zipfile.ZipFile(sys.argv[1]) as archive:
    for entry in archive.infolist():
        name = pathlib.PurePosixPath(entry.orig_filename if invalid_name else entry.filename)
        if name.is_absolute() or '..' in name.parts:
            raise ValueError('ZIP 中的路径超出目标文件夹')
        if invalid_name:
            parts = name.parts
            if not parts or any(invalid_name.search(part) for part in parts):
                raise ValueError(f'ZIP 中文件名不符合 Windows 规则：{entry.orig_filename!r}')
            target = tuple(os.path.normcase(part) for part in parts)
            for length in range(1, len(parts) + 1):
                key = target[:length]
                directory = length < len(parts) or entry.is_dir()
                previous = targets.get(key)
                if previous and (not directory or previous != (parts[:length], True)):
                    raise ValueError(f'ZIP 中文件路径在 Windows 上冲突：{entry.orig_filename!r}')
                targets[key] = (parts[:length], directory)
    archive.extractall(sys.argv[2])
`;
  return new Promise((resolve, reject) => {
    const child = spawn(findBin('python'), ['-c', script, file, directory, ...nameRules], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let error = '';
    child.stderr.on('data', chunk => { error += chunk; });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(new Error(error.trim() || `解压失败（退出码 ${code}）`)));
  });
}
