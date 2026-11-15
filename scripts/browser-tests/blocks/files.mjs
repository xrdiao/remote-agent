import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { attr, by } from '../context.mjs';

const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
async function sample(c) {
  const root = path.resolve(c.directory, 'files'); await fs.mkdir(path.join(root, 'empty folder'), { recursive: true });
  const file = path.join(root, '中文 sample.txt'), hidden = path.join(root, '.hidden.txt');
  if (!c.data.has('files')) {
    await fs.writeFile(file, c.marker + '\n文件原始字节\n'); await fs.writeFile(hidden, 'hidden');
    c.data.set('files', { root, file, hidden });
  }
  return c.data.get('files');
}
async function browse(c, root) {
  await c.b.home(); await c.b.click('#ovLevels [data-v="projects"]');
  await c.b.click(`[data-ov="computer-editor"]${by('data-id', c.computer)}`);
  await c.b.fill('#computerFilePath', root); await c.b.click('#computerFilePathForm button[type="submit"]');
  await c.b.wait(`computerFiles?.directory?.path===${attr(root.replaceAll(path.sep, '/'))}&&!computerFiles.message`, '文件目录读取');
}
async function transferPath(c, root) {
  await c.b.click('#transferPathButton'); await c.b.fill('#transferPath', root); await c.b.click('#transferPathForm button');
  await c.b.wait(`(transferPicker||transferDirectory)?.path===${attr(root.replaceAll(path.sep, '/'))}`, '传输目录');
}
async function transferChoose(c, files) {
  if (await c.b.read('transferSelection.size>0')) await c.b.click('#transferClear');
  for (const file of files) {
    const entry = await c.b.wait(`(()=>{const index=transferDirectory?.entries.findIndex(e=>e.path===${attr(file.replaceAll(path.sep, '/'))});return index>=0?{index}:null})()`, '文件操作目标出现');
    await c.b.click(by('data-transfer-check', entry.index));
  }
}
async function transferOperation(c, selector, name) {
  if (name) await c.b.dialog(name, () => c.b.click(selector)); else await c.b.click(selector);
  await c.b.wait("!transferFileOperation&&document.getElementById('transferStatus').textContent==='文件操作已完成'", '文件操作及目录刷新回执');
}

export default [
  { id: 'files.editor', title: '浏览、预览、保存并核对磁盘字节', refs: ['F10', 'W07'], mode: 'write', async run(c) {
    const { root, file } = await sample(c); await browse(c, root);
    await c.b.click(by('data-computer-path', file.replaceAll(path.sep, '/')));
    await c.b.wait(`viewing?.path===${attr(file.replaceAll(path.sep, '/'))}&&!readingFile`, '文件预览');
    c.equal(await c.b.read('viewing.text'), await fs.readFile(file, 'utf8'), '预览与磁盘原文相同');
    await c.b.click('#vEdit'); await c.b.fill('#vEditBox', c.marker + '\n已保存的编辑内容\n');
    await c.b.click('#vEdit'); await c.b.wait('!saving', '保存回执');
    const saved = await fs.readFile(file, 'utf8'); c.equal(saved, c.marker + '\n已保存的编辑内容\n', '保存落盘逐字一致');
    const mode = (await fs.stat(file)).mode & 0o777; await c.b.click('#vClose');
    return { sha256: hash(saved), mode };
  } },
  { id: 'files.hidden', title: '隐藏文件开关一致且可恢复', refs: ['F04', 'F10'], mode: 'write', async run(c) {
    const { root, hidden } = await sample(c); await browse(c, root);
    const original = await c.b.read("document.getElementById('computerFileHideHidden').checked");
    try { for (const hide of [true, false]) {
      if (await c.b.read("document.getElementById('computerFileHideHidden').checked") !== hide) await c.b.click('#computerFileHideHidden');
      c.equal(await c.b.has(by('data-computer-path', hidden.replaceAll(path.sep, '/'))), !hide, '隐藏文件显示遵循开关');
    } } finally {
      if (await c.b.read("document.getElementById('computerFileHideHidden').checked") !== original) await c.b.click('#computerFileHideHidden');
      await c.b.dismiss();
    }
    return { restored: true };
  } },
  { id: 'files.invalid-path', title: '错误目录隐藏旧文件并支持重试', refs: ['F04', 'F10'], mode: 'write', async run(c) {
    const { root, file } = await sample(c); await browse(c, root);
    const previous = by('data-computer-path', file.replaceAll(path.sep, '/'));
    c.check(await c.b.has(previous), '成功读取时显示实际测试文件');
    try {
      await c.b.fill('#computerFilePath', path.join(root, 'missing-' + c.marker));
      await c.b.click('#computerFilePathForm button[type="submit"]');
      await c.b.wait('computerFiles?.error&&!computerFiles.pending', '不存在目录的真实错误');
      c.check(!await c.b.has(previous), '失败后不能点击旧目录的文件');
      c.check(await c.b.read("document.getElementById('computerFileStatus').textContent.trim().length>0"), '实际目录错误显示在界面');
    } finally { await browse(c, root); await c.b.dismiss(); }
    return { recovered: true };
  } },
  { id: 'files.operations', title: '真实复制、同名处理、移动及中文 ZIP 往返', refs: ['F10', 'F12', 'W07', 'W08'], mode: 'write', async run(c) {
    const { root } = await sample(c), directory = path.join(root, 'operations');
    const source = path.join(directory, 'source'), destination = path.join(directory, 'copied'), moved = path.join(directory, 'moved');
    for (const folder of [source, destination, path.join(moved, '空文件夹')]) await fs.mkdir(folder, { recursive: true });
    const name = '原始 文件.txt', file = path.join(source, name), bytes = c.marker + '\n原始内容\n';
    await fs.writeFile(file, bytes); await c.b.menu('transfer'); await c.b.click('#transferDownloadTab');
    const collision = await c.b.read("document.getElementById('transferCollision').value");
    try {
      await transferPath(c, source); await transferChoose(c, [file]); await c.b.click('#transferCopy');
      await transferPath(c, destination); await c.b.select('#transferCollision', 'rename');
      await transferOperation(c, '#transferPaste'); c.equal(await fs.readFile(path.join(destination, name), 'utf8'), bytes, '复制后的字节一致');
      await transferOperation(c, '#transferPaste'); c.equal(await fs.readFile(path.join(destination, '原始 文件 (1).txt'), 'utf8'), bytes, '同名另存保留两份内容');
      await c.b.select('#transferCollision', 'skip'); await transferOperation(c, '#transferPaste');
      c.equal((await fs.readdir(destination)).length, 2, '同名跳过没有额外文件');
      await fs.writeFile(file, bytes + 'updated\n'); await c.b.select('#transferCollision', 'replace'); await transferOperation(c, '#transferPaste');
      c.equal(await fs.readFile(path.join(destination, name), 'utf8'), bytes + 'updated\n', '同名覆盖读取当前源文件');
      await transferPath(c, source); await transferChoose(c, [file]); await c.b.click('#transferCut');
      await transferPath(c, moved); await transferOperation(c, '#transferPaste');
      c.check(!(await fs.readdir(source)).includes(name), '移动完成后源文件消失');
      c.equal(await fs.readFile(path.join(moved, name), 'utf8'), bytes + 'updated\n', '移动目的文件保持字节');
      await transferChoose(c, [path.join(moved, name), path.join(moved, '空文件夹')]);
      await transferOperation(c, '#transferZip', '中文归档.zip');
      await transferChoose(c, [path.join(moved, '中文归档.zip')]); await transferOperation(c, '#transferExtract');
      const unpacked = path.join(moved, '中文归档');
      c.equal(await fs.readFile(path.join(unpacked, name), 'utf8'), bytes + 'updated\n', 'ZIP 往返保持中文路径和字节');
      c.check((await fs.stat(path.join(unpacked, '空文件夹'))).isDirectory(), 'ZIP 往返保留空目录');
    } finally {
      await c.b.select('#transferCollision', collision);
      if (await c.b.has('#transferClose')) await c.b.click('#transferClose');
    }
    return { copied: true, moved: true, collisions: ['rename', 'skip', 'replace'], zip: true };
  } },
  { id: 'files.transfer-upload', title: '真实浏览器上传、中文文件名及哈希', refs: ['F12', 'W08'], mode: 'write', async run(c) {
    const { root } = await sample(c), source = path.resolve(c.directory, '中文 upload-payload.txt');
    const bytes = Buffer.from(c.marker + '\n上传字节校验\n'); await fs.writeFile(source, bytes);
    const destination = path.join(root, 'received'); await fs.mkdir(destination, { recursive: true });
    await c.b.menu('transfer'); await c.b.click('#transferUploadTab'); await c.b.click('#transferChangeTarget');
    await transferPath(c, destination); await c.b.click('#transferUseDirectory');
    await c.b.files('#transferFileInput', [source]); await c.b.click('#transferStart');
    await c.b.wait('!transferUploading&&transferUploads.length===0', '上传完成');
    const actual = await fs.readFile(path.join(destination, path.basename(source)));
    c.equal(hash(actual), hash(bytes), '上传后的文件哈希一致'); await c.b.click('#transferClose');
    return { bytes: actual.length, sha256: hash(actual) };
  } },
  { id: 'files.download', title: '下载到浏览器后逐字节核对', refs: ['F12', 'W08'], mode: 'write', async run(c) {
    const { root, file } = await sample(c), downloads = path.resolve(c.directory, 'downloads'); await fs.mkdir(downloads, { recursive: true });
    await c.b.cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads, eventsEnabled: true });
    try {
      await c.b.menu('transfer'); await c.b.click('#transferDownloadTab'); await transferPath(c, root);
      const index = await c.b.read(`transferDirectory.entries.findIndex(e=>e.path===${attr(file.replaceAll(path.sep, '/'))})`);
      c.check(index >= 0, '下载目录包含测试文件'); await c.b.click(by('data-transfer-check', index)); await c.b.click('#transferDownload');
      const destination = path.join(downloads, path.basename(file)), deadline = Date.now() + c.options.timeout;
      let actual;
      while (Date.now() < deadline) { try { actual = await fs.readFile(destination); break; } catch (error) { if (error.code !== 'ENOENT') throw error; } await new Promise(resolve => setTimeout(resolve, 100)); }
      c.check(!!actual, '浏览器确实产生下载文件'); c.equal(hash(actual), hash(await fs.readFile(file)), '下载文件哈希正确');
      return { sha256: hash(actual), bytes: actual.length };
    } finally { await c.b.cdp.send('Browser.setDownloadBehavior', { behavior: 'default' }); if (await c.b.has('#transferClose')) await c.b.click('#transferClose'); }
  } },
  { id: 'files.media-zip', title: '图片编辑、媒体、目录上传与传输取消', refs: ['F10', 'F11', 'F12', 'S05'], mode: 'manual',
    reason: '需补验图片旋转／裁剪／撤销、PDF／视频／目录上传及真实取消窗口。files.operations 已单独覆盖普通 ZIP 往返；基础文件读写和双向哈希不代替其余子场景。' },
];
