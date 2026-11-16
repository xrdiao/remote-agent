import { readFile } from '../lib/files.mjs';
import { highlightText } from '../lib/highlight.mjs';
import { pdfUrl, videoUrl } from './http/video.mjs';
import { stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const runOffice = promisify(execFile);

export async function buildFilePreview(file, deviceId, theme) {
  if (!file.host) {
    const info = await stat(file.path);
    if (!info.isFile()) throw new Error('只能预览普通文件');
    file = { ...file, size: info.size };
  }
  if (!file.host && /\.(?:zip|doc)$/i.test(file.path)) return { downloadOnly: true };
  if (!file.host && /\.mp4$/i.test(file.path)) return { video: videoUrl(file.path, deviceId) };
  if (!file.host && /\.pdf$/i.test(file.path)) return { pdf: pdfUrl(file.path, deviceId) };
  if (!file.host && /\.(?:docx|pptx|xlsx)$/i.test(file.path)) {
    if (file.size > 20 * 1024 * 1024) throw new Error('Office 预览限 20 MB，请下载原文件查看');
    try {
      const { stdout } = await runOffice(process.execPath,
        ['--max-old-space-size=192', fileURLToPath(new URL('./office-preview-worker.mjs', import.meta.url)), file.path],
        { timeout: 10000, maxBuffer: 4 * 1024 * 1024, windowsHide: true, encoding: 'utf8' });
      return { text: JSON.parse(stdout).text, editable: false };
    } catch (error) {
      throw new Error(error.killed ? 'Office 预览超时，请下载原文件查看' : 'Office 预览失败：' + (error.stderr?.trim() || error.message));
    }
  }
  const body = await readFile(file.path, file.size);
  const hl = body.text ? await highlightText(body.text, file.path, await theme()).catch(() => null) : null;
  return { ...body, editable: body.text != null && !body.truncated, ...(hl ? { hl } : {}) };
}
