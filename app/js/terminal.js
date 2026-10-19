const ANSI16 = ['#1e1e1e', '#cd3131', '#0dbc79', '#e5e510', '#2472c8', '#bc3fbc', '#11a8cd', '#cccccc', '#666666', '#f14c4c', '#23d18b', '#f5f543', '#3b8eea', '#d670d6', '#29b8db', '#ffffff'];
function termColor(n) {
  if (!n) return '';
  if (n < 0) return '#' + ((-n - 1) >>> 0).toString(16).padStart(6, '0');
  const i = n - 1;
  if (i < 16) return `var(--term-ansi-${i}, ${ANSI16[i]})`;
  if (i < 232) {
    const x = i - 16;
    const q = v => v ? 55 + v * 40 : 0;
    return `rgb(${q((x / 36) | 0)},${q(((x / 6) | 0) % 6)},${q(x % 6)})`;
  }
  const g = 8 + (i - 232) * 10;
  return `rgb(${g},${g},${g})`;
}
function termStyle(f, b, fl) {
  let fg = termColor(f), bg = termColor(b);
  if (fl & 16) { const swap = fg || 'var(--term-fg)'; fg = bg || 'var(--term-bg)'; bg = swap; }
  let css = '';
  if (fg) css += `color:${fg};`;
  if (bg) css += `background:${bg};`;
  if (fl & 1) css += 'font-weight:700;';
  if (fl & 2) css += 'font-style:italic;';
  if (fl & 4) css += 'text-decoration:underline;';
  if (fl & 8) css += 'opacity:.65;';
  return css;
}
function paintTerm(text, style, caretAt) {
  const open = style ? `<span style="${style}">` : '';
  const close = style ? '</span>' : '';
  if (caretAt == null || caretAt < 0 || caretAt > text.length) return open + esc(text) + close;
  const ch = caretAt < text.length ? esc(text[caretAt]) : ' ';
  return open + esc(text.slice(0, caretAt)) + close + `<span class="caret">${ch}</span>` + open + esc(text.slice(caretAt + (caretAt < text.length ? 1 : 0))) + close;
}
function renderTermLine(line, caretAt) {
  const text = typeof line === 'string' ? line : (line?.t || '');
  const spans = typeof line === 'string' || !line?.s ? null : line.s;
  if (!spans?.length) return paintTerm(text, '', caretAt) + '\n';
  let html = '';
  for (let i = 0; i < spans.length; i++) {
    const [start, f, b, fl] = spans[i];
    const end = i + 1 < spans.length ? spans[i + 1][0] : text.length;
    if (start >= text.length || end <= start) continue;
    const from = start;
    const to = Math.min(end, text.length);
    const local = caretAt != null && caretAt >= from && caretAt <= to ? caretAt - from : null;
    html += paintTerm(text.slice(from, to), termStyle(f, b, fl), local);
  }
  return html + '\n';
}
let termLines = [], termCursor = [], termPending = null, termViewSel = '', termTouching = false;
function terminalSelection() {
  const selection = window.getSelection();
  const box = $('termText');
  return selection && !selection.isCollapsed && box.contains(selection.anchorNode) && box.contains(selection.focusNode) ? selection : null;
}
function flushTerm() {
  if (!termPending || termTouching || terminalSelection()) return;
  const pending = termPending;
  termPending = null;
  if (mode === 'terminal' && pending.sel === viewSel) renderTerm(pending.message);
}
function clearTermSelection() {
  termPending = null;
  termTouching = false;
  terminalSelection()?.removeAllRanges();
}
function renderTerm(m) {
  const box = $('termText');
  if (m.lines && termViewSel === viewSel && currentTerminal === (m.name || '') && (termTouching || terminalSelection())) {
    termPending = { message: m, sel: viewSel };
    return;
  }
  termPending = null;
  if (termViewSel !== viewSel || currentTerminal !== (m.name || '') || !m.lines) clearTermSelection();
  termViewSel = viewSel;
  $('termCopy').disabled = $('termSelectAll').disabled = !m.lines?.length;
  if (!m.lines) {
    termState = 'empty';
    box.textContent = ''; termLines = []; termCursor = [];
    updateTermEmpty();
    return;
  }
  termState = 'text';
  const stick = box.scrollHeight - box.scrollTop - box.clientHeight < 64;
  const [cy, cx] = m.cursor || [];
  currentTerminal = m.name || ''; updateTitle();
  m.lines.forEach((line, y) => {
    if (JSON.stringify(line) === JSON.stringify(termLines[y]) && y !== cy && y !== termCursor[0]) return;
    const row = document.createElement('span');
    row.innerHTML = renderTermLine(line, y === cy ? cx : null);
    if (box.children[y]) box.children[y].replaceWith(row); else box.append(row);
  });
  while (box.children.length > m.lines.length) box.lastElementChild.remove();
  termLines = m.lines; termCursor = m.cursor || [];
  updateTermEmpty();
  if (stick) box.scrollTop = box.scrollHeight;
}
document.addEventListener('selectionchange', flushTerm);
$('termText').addEventListener('touchstart', () => { termTouching = true; }, { passive: true });
for (const event of ['touchend', 'touchcancel']) $('termText').addEventListener(event, () => { termTouching = false; flushTerm(); }, { passive: true });
for (const id of ['termCopy', 'termSelectAll']) $(id).addEventListener('pointerdown', e => e.preventDefault());
$('termSelectAll').onclick = () => {
  const range = document.createRange();
  range.selectNodeContents($('termText'));
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
};
$('termCopy').onclick = async () => {
  const selected = terminalSelection();
  const value = selected ? selected.toString() : termLines.map(line => typeof line === 'string' ? line : line.t).join('\n');
  await copyText(value, $('termCopy'), false);
  terminalSelection()?.removeAllRanges();
  flushTerm();
};
$('zoom').onclick = () => setZoom(1);
$('refresh').onclick = () => send({ t: 'refresh' });
document.querySelectorAll('[data-key]').forEach(b => b.onclick = () => send({ t: 'key', key: b.dataset.key }));

