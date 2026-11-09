import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { parseOffice } from 'officeparser';

const run = promisify(execFile);
const textTypes = new Set(['.txt', '.md', '.csv', '.json', '.log', '.sh', '.yaml', '.yml', '.xml', '.html', '.css',
  '.py', '.js', '.ts', '.jsx', '.tsx', '.cpp', '.c', '.h', '.rs', '.go', '.toml', '.ini']);
const images = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
const documents = new Set(['.pdf', '.doc', '.docx', '.xlsx', '.pptx']);

async function parseDocument(file) {
  const ast = await parseOffice(file, { ocr: false, extractAttachments: false });
  if (!ast.toText().trim()) return '';
  if (ast.type === 'xlsx') ast.content = ast.content.flatMap(sheet => [
    { type: 'paragraph', children: [{ type: 'text', text: `工作表：${sheet.metadata.sheetName}` }] }, sheet,
  ]);
  return (await ast.to('md', { includeImages: false })).value;
}

async function documentText(file, extension) {
  if (extension !== '.doc') return parseDocument(file.path);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ra-opencode-doc-'));
  try {
    await run('libreoffice', [`-env:UserInstallation=${pathToFileURL(path.join(directory, 'profile')).href}`,
      '--headless', '--convert-to', 'docx', '--outdir', directory, file.path], { windowsHide: true });
    const converted = path.join(directory, path.basename(file.path, path.extname(file.path)) + '.docx');
    return await parseDocument(converted);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
}

export async function openCodeAttachment(file) {
  const extension = path.extname(file.name).toLowerCase();
  const image = images[extension] || (file.type?.startsWith('image/') ? file.type : '');
  if (image) return { type: 'file', mime: image, filename: file.name,
    url: `data:${image};base64,${(await fs.readFile(file.path)).toString('base64')}` };
  let text;
  if (textTypes.has(extension)) text = await fs.readFile(file.path, 'utf8');
  else if (documents.has(extension)) {
    text = await documentText(file, extension);
    if (!text.trim()) throw new Error(`${file.name} 没有可提取的文字，请将扫描页或图片作为图片发送`);
  } else throw new Error(`OpenCode 不支持读取此文件类型：${extension || file.name}`);
  return { type: 'file', mime: 'text/plain', filename: file.name,
    url: 'data:text/plain;base64,' + Buffer.from(`附件：${file.name}\n${text}`).toString('base64') };
}
