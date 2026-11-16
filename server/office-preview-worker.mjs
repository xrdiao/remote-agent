import { readFile } from 'node:fs/promises';
import { parseDocument } from './opencode/attachments.mjs';

// Check the ZIP directory without inflating any entry. Parsing stays outside relay.
function checkArchive(bytes) {
  let end = bytes.length - 22;
  const minimum = Math.max(0, end - 65535);
  while (end >= minimum && !(bytes.readUInt32LE(end) === 0x06054b50
    && end + 22 + bytes.readUInt16LE(end + 20) === bytes.length)) end--;
  if (end < minimum) throw new Error('无效的 Office 压缩包');
  const count = bytes.readUInt16LE(end + 10), size = bytes.readUInt32LE(end + 12);
  let offset = bytes.readUInt32LE(end + 16), total = 0;
  const limit = offset + size;
  if (bytes.readUInt32LE(end + 4) !== 0 || bytes.readUInt16LE(end + 8) !== count
    || count > 4096 || limit !== end) throw new Error('Office 压缩包结构或条目数超出预览限制');
  for (let i = 0; i < count; i++) {
    if (offset + 46 > limit || bytes.readUInt32LE(offset) !== 0x02014b50) throw new Error('Office 压缩包目录损坏');
    total += bytes.readUInt32LE(offset + 24);
    if (total > 64 * 1024 * 1024) throw new Error('Office 解压内容超过 64 MB，请下载原文件查看');
    offset += 46 + bytes.readUInt16LE(offset + 28) + bytes.readUInt16LE(offset + 30) + bytes.readUInt16LE(offset + 32);
  }
  if (offset !== limit) throw new Error('Office 压缩包目录损坏');
}

try {
  const file = process.argv[2], bytes = await readFile(file);
  if (bytes.length > 20 * 1024 * 1024) throw new Error('Office 预览限 20 MB');
  checkArchive(bytes);
  const text = await parseDocument(bytes);
  if (Buffer.byteLength(text) > 1024 * 1024) throw new Error('Office 正文超过预览限制，请下载原文件查看');
  process.stdout.write(JSON.stringify({ text }));
} catch (error) {
  process.stderr.write(error.message);
  process.exitCode = 1;
}
