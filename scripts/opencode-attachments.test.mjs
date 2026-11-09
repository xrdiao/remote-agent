import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { openCodeAttachment } from '../server/opencode/attachments.mjs';
import { createDocuments } from './fixtures/opencode-documents.mjs';

const root = await fs.mkdtemp(path.resolve('_shots/opencode-attachment-test-'));
const files = await createDocuments(root);
test.after(() => fs.rm(root, { recursive: true, force: true }));
const read = async extension => {
  const part = await openCodeAttachment({ name: '附件.' + extension.toUpperCase(), path: files[extension] });
  assert.equal(part.mime, 'text/plain');
  return Buffer.from(part.url.split(',')[1], 'base64').toString('utf8');
};

test('OpenCode reads every Excel worksheet, Chinese shared strings, inline strings and cached formula values', async () => {
  const text = await read('xlsx');
  for (const value of ['First', '第二表', '姓名', '张三', '金额', '17', 'CHECK', 'ZEBRA_731', '3']) assert(text.includes(value), value);
});

test('OpenCode extracts Word paragraphs and tables, all PowerPoint slides and PDF text', async () => {
  const word = await read('docx');
  assert.match(word, /WORD_TOKEN_732/); assert.match(word, /TABLE_TOKEN_733/);
  const slides = await read('pptx');
  assert.match(slides, /FIRST_SLIDE_734/); assert.match(slides, /SECOND_SLIDE_735/);
  assert.match(await read('pdf'), /PDF_TOKEN_736/);
});

test('OpenCode text and source files preserve UTF-8 contents while images remain native image parts', async () => {
  const text = await read('txt'); assert.match(text, /文本验证 TEXT_TOKEN_737\n第二行/);
  const source = await openCodeAttachment({ name: 'source.JSON', path: files.txt });
  assert.equal(source.mime, 'text/plain');
  const image = await openCodeAttachment({ name: 'PHOTO.PNG', path: files.png, type: 'application/octet-stream' });
  assert.equal(image.mime, 'image/png');
  assert.deepEqual(Buffer.from(image.url.split(',')[1], 'base64'), await fs.readFile(files.png));
});

test('OpenCode rejects unreadable or unsupported files instead of creating binary model parts', async () => {
  await assert.rejects(openCodeAttachment({ name: 'bad.xlsx', path: files.txt }));
  await assert.rejects(openCodeAttachment({ name: 'unsupported.bin', path: files.txt }), /不支持/);
  await assert.rejects(openCodeAttachment({ name: 'missing.txt', path: path.join(root, 'missing') }), /ENOENT/);
  const emptyPDF = path.join(root, 'empty.pdf');
  await fs.writeFile(emptyPDF, (await fs.readFile(files.pdf, 'utf8')).replace('PDF_TOKEN_736', ' '.repeat(13)));
  await assert.rejects(openCodeAttachment({ name: 'empty.pdf', path: emptyPDF }), /没有可提取的文字/);
});
