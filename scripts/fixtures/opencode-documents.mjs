import fs from 'node:fs/promises';
import path from 'node:path';
import yazl from 'yazl';

const xml = '<?xml version="1.0" encoding="UTF-8"?>';
const rels = entries => xml + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + entries.map(([id, type, target]) => `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"/>`).join('') + '</Relationships>';
const types = entries => xml + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' + entries.map(([name, type]) => `<Override PartName="/${name}" ContentType="${type}"/>`).join('') + '</Types>';

async function archive(file, entries) {
  const zip = new yazl.ZipFile(), chunks = [];
  for (const [name, text] of Object.entries(entries)) zip.addBuffer(Buffer.from(text), name);
  const done = new Promise((resolve, reject) => {
    zip.outputStream.on('data', data => chunks.push(data));
    zip.outputStream.once('end', resolve); zip.outputStream.once('error', reject);
  });
  zip.end(); await done; await fs.writeFile(file, Buffer.concat(chunks));
}

export async function createDocuments(directory) {
  await fs.mkdir(directory, { recursive: true });
  const files = Object.fromEntries(['xlsx', 'docx', 'pptx', 'pdf', 'txt', 'png'].map(type => [type, path.join(directory, 'attachment.' + type)]));
  await archive(files.xlsx, {
    '[Content_Types].xml': types([
      ['xl/workbook.xml', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml'],
      ['xl/worksheets/sheet1.xml', 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml'],
      ['xl/worksheets/sheet2.xml', 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml'],
      ['xl/sharedStrings.xml', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml'],
    ]),
    '_rels/.rels': rels([['rId1', 'officeDocument', 'xl/workbook.xml']]),
    'xl/workbook.xml': xml + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="First" sheetId="1" r:id="rId1"/><sheet name="第二表" sheetId="2" r:id="rId2"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': rels([['rId1', 'worksheet', 'worksheets/sheet1.xml'], ['rId2', 'worksheet', 'worksheets/sheet2.xml'], ['rId3', 'sharedStrings', 'sharedStrings.xml']]),
    'xl/sharedStrings.xml': xml + '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="2" uniqueCount="2"><si><t>姓名</t></si><si><t>张三</t></si></sst>',
    'xl/worksheets/sheet1.xml': xml + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="inlineStr"><is><t>金额</t></is></c></row><row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2"><v>17</v></c></row></sheetData></worksheet>',
    'xl/worksheets/sheet2.xml': xml + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Key</t></is></c><c r="B1" t="inlineStr"><is><t>Value</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>CHECK</t></is></c><c r="B2" t="inlineStr"><is><t>ZEBRA_731</t></is></c></row><row r="3"><c r="A3" t="inlineStr"><is><t>Formula</t></is></c><c r="B3"><f>SUM(1,2)</f><v>3</v></c></row></sheetData></worksheet>',
  });
  await archive(files.docx, {
    '[Content_Types].xml': types([['word/document.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml']]),
    '_rels/.rels': rels([['rId1', 'officeDocument', 'word/document.xml']]),
    'word/document.xml': xml + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>文档验证 WORD_TOKEN_732</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>表格内容 TABLE_TOKEN_733</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:sectPr/></w:body></w:document>',
  });
  const slide = text => xml + `<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:nvSpPr><p:cNvPr id="2" name="Text"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
  await archive(files.pptx, {
    '[Content_Types].xml': types([
      ['ppt/presentation.xml', 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml'],
      ['ppt/slides/slide1.xml', 'application/vnd.openxmlformats-officedocument.presentationml.slide+xml'],
      ['ppt/slides/slide2.xml', 'application/vnd.openxmlformats-officedocument.presentationml.slide+xml'],
    ]),
    '_rels/.rels': rels([['rId1', 'officeDocument', 'ppt/presentation.xml']]),
    'ppt/presentation.xml': xml + '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="256" r:id="rId1"/><p:sldId id="257" r:id="rId2"/></p:sldIdLst></p:presentation>',
    'ppt/_rels/presentation.xml.rels': rels([['rId1', 'slide', 'slides/slide1.xml'], ['rId2', 'slide', 'slides/slide2.xml']]),
    'ppt/slides/slide1.xml': slide('FIRST_SLIDE_734'), 'ppt/slides/slide2.xml': slide('第二页 SECOND_SLIDE_735'),
  });
  const stream = 'BT /F1 14 Tf 20 100 Td (PDF_TOKEN_736) Tj ET';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  let pdf = '%PDF-1.4\n'; const offsets = [0];
  for (const [index, value] of objects.entries()) { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${value}\nendobj\n`; }
  const start = Buffer.byteLength(pdf);
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(n => String(n).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<< /Root 1 0 R /Size 6 >>\nstartxref\n${start}\n%%EOF\n`;
  await fs.writeFile(files.pdf, pdf);
  await fs.writeFile(files.txt, '文本验证 TEXT_TOKEN_737\n第二行');
  await fs.writeFile(files.png, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j/3sAAAAASUVORK5CYII=', 'base64'));
  return files;
}
