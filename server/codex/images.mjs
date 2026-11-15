import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { localFilePath } from '../../lib/platform.mjs';

export function generatedImageSource(item) {
  if (item.failure || item.status !== 'completed') return null;
  if (item.savedPath) return localFilePath(item.savedPath);
  if (item.fileId) return 'codex-file:' + item.fileId;
  const result = item.result?.trim();
  if (!result) return null;
  return /^(?:data:image\/|https?:\/\/|file:\/\/)/i.test(result) || path.isAbsolute(localFilePath(result))
    ? result : 'data:image/png;base64,' + result;
}

export async function readCodexImage(fileId, { readAuth = () => fs.readFile(path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'auth.json'), 'utf8'), request = fetch } = {}) {
  const { tokens } = JSON.parse(await readAuth());
  if (!tokens?.access_token) throw new Error('读取 Codex 生成图片需要本机的 ChatGPT 登录授权');
  const response = await request('https://chatgpt.com/backend-api/files/download/' + encodeURIComponent(fileId), {
    headers: { authorization: 'Bearer ' + tokens.access_token, 'ChatGPT-Account-Id': tokens.account_id },
  });
  if (!response.ok) throw new Error('Codex 图片下载地址读取失败：HTTP ' + response.status);
  const result = await response.json();
  if (!result.download_url) throw new Error('Codex 未返回图片下载地址');
  const image = await request(result.download_url);
  if (!image.ok) throw new Error('Codex 图片下载失败：HTTP ' + image.status);
  const type = image.headers.get('content-type')?.split(';')[0];
  if (!type?.startsWith('image/')) throw new Error('Codex 返回的内容不是图片');
  return `data:${type};base64,${Buffer.from(await image.arrayBuffer()).toString('base64')}`;
}
