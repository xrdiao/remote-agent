import { readFile } from '../lib/files.mjs';
import { highlightText } from '../lib/highlight.mjs';
import { pdfUrl, videoUrl } from './http/video.mjs';

export async function buildFilePreview(file, deviceId, theme) {
  if (!file.host && /\.mp4$/i.test(file.path)) return { video: videoUrl(file.path, deviceId) };
  if (!file.host && /\.pdf$/i.test(file.path)) return { pdf: pdfUrl(file.path, deviceId) };
  const body = await readFile(file.path, file.size);
  const hl = body.text ? await highlightText(body.text, file.path, await theme()).catch(() => null) : null;
  return { ...body, editable: body.text != null && !body.truncated, ...(hl ? { hl } : {}) };
}
