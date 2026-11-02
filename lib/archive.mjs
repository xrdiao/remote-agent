import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import yazl from 'yazl';

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
  const script = `import sys, zipfile, pathlib
with zipfile.ZipFile(sys.argv[1]) as archive:
    for entry in archive.infolist():
        name = pathlib.PurePosixPath(entry.filename)
        if name.is_absolute() or '..' in name.parts:
            raise ValueError('ZIP 中的路径超出目标文件夹')
    archive.extractall(sys.argv[2])
`;
  return new Promise((resolve, reject) => {
    const child = spawn('python3', ['-c', script, file, directory], { stdio: ['ignore', 'ignore', 'pipe'] });
    let error = '';
    child.stderr.on('data', chunk => { error += chunk; });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(new Error(error.trim() || `解压失败（退出码 ${code}）`)));
  });
}
