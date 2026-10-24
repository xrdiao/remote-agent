// Runs inside the desktop page (injected via toString). Emits only whitelisted tags with escaped text, never raw DOM HTML.
  const workspaceTrustState = () => {
    // An open trust editor in the granted state still matches the dialog regex
    // ("You trust the authors of the files ..."), so treat it as trusted, not required.
    const granted = [...document.querySelectorAll('.workspace-trust-editor.trusted')].some(vis);
    const dialogs = [...document.querySelectorAll('.monaco-dialog-box, [role="dialog"]')].filter(vis);
    const dialog = granted ? null : dialogs.find(e => /trust the authors|信任.*作者/i.test(e.innerText || ''));
    const editor = [...document.querySelectorAll('.workspace-trust-editor')].find(vis);
    const area = dialog || editor;
    const buttons = area ? [...area.querySelectorAll('button, .monaco-button, [role="button"]')].filter(vis) : [];
    const point = el => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; };
    const trust = buttons.find(b => /^(Yes, I trust the authors|Trust(?: Folder| Workspace)?|是，我信任|信任(?:此)?(?:文件夹|工作区|作者)?)/i.test((b.innerText || b.getAttribute('aria-label') || '').trim()));
    const decline = buttons.find(b => /^(No, I don.t trust|Don.t Trust|不.*信任|否)/i.test((b.innerText || b.getAttribute('aria-label') || '').trim()));
    const restricted = [...document.querySelectorAll('.statusbar-item, .monaco-workbench .banner')].find(e => vis(e) && /Restricted Mode|限制模式|受限模式/i.test(e.innerText || e.getAttribute('aria-label') || ''));
    return { required: !granted && (!!dialog || !!restricted || !!trust), trust: point(trust), decline: point(decline), manage: point(restricted) };
  };
  // Codex draws inside a same-origin iframe. Cursor and Devin use this page.
  const doc = document.getElementById('active-frame')?.contentDocument || document;
  const vis = e => { const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0; };
  const esc = s => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const SKIP = /ui-collapsible-header|md-clickable-code|output-preview|codicon-find|widget-close|model-picker/;
  const ACTION = /^(run|skip|allow|accept|reject|deny|approve|keep|undo|continue|stop|cancel|build|retry|try again|yes|no\b|运行|跳过|允许|接受|拒绝|继续|停止|取消|再试一次)/i;
  const RETRY_LABEL = /^(Retry|Try(?: again)?|重试|再试一次)$/i;
  const CAPACITY_ERROR = /(?:at capacity|容量不足|模型容量)/i;
  const BLOCK = new Set(['P', 'UL', 'OL', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'BLOCKQUOTE', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TD', 'TH', 'DIV']);
  const INLINE = new Set(['STRONG', 'B', 'EM', 'I', 'CODE', 'DEL']);
  const CODE_BLOCK = '.composer-code-block-container, .composer-message-codeblock, .ui-code-block, pre, [data-markdown-copy="code-block"]';
  const FILE_REF = 'code.md-inline-path-filename-like';

  // Edit/read tool cards keep the absolute path in the header's title; fall back to the shown file name.
  const toolFile = el => {
    const titled = [...el.querySelectorAll('[title]')].map(e => e.getAttribute('title')).find(t => /^(\/|~\/|[A-Za-z]:\\)\S+$/.test(t));
    return titled || el.querySelector('.ui-edit-tool-call__filename')?.innerText.trim() || null;
  };

  // Older Cursor builds mark each transcript row with data-flat-index; Cursor 1.x Composer
  // chats use data-message-index. The Agents window in current builds uses data-message-kind
  // instead, and past bubbles contain their own editors.
  const ITEM_SEL = '[data-flat-index], [data-message-index], [data-message-kind], [data-turn-key], [role=group][aria-label="User message"], [role=group][aria-label="Devin message"]';
  const COMPOSER = '.aislash-editor-input, .ui-prompt-input-editor__input, .ProseMirror';
  const inItem = el => !!el.closest(ITEM_SEL);
  const itemKey = el => {
    const existing = el.dataset.flatIndex || el.dataset.turnKey || el.dataset.messageId || el.querySelector('[data-message-id]')?.dataset.messageId;
    if (existing) return existing;
    const messageIndex = el.getAttribute('data-message-index');
    if (messageIndex != null) return `mi${messageIndex}`;
    const acp = el.closest?.('[role="log"][aria-label="Session transcript"]')
      ? el.closest('[data-acp-msg-index]')?.getAttribute('data-acp-msg-index') : null;
    if (acp != null) return `acp${acp}`;
    if (el.getAttribute('data-side')) {
      const i = [...doc.querySelectorAll('[role=group][data-side]')].indexOf(el);
      return i >= 0 ? `d${i}` : '';
    }
    if (!el.dataset.remoteItem) el.dataset.remoteItem = crypto.randomUUID();
    return `remote:${el.dataset.remoteItem}`;
  };
  const itemByKey = (panel, key) => [...panel.querySelectorAll(`${ITEM_SEL}, [data-remote-item]`)].find(el => itemKey(el) === key) || panel.querySelector(`[data-flat-index="${CSS.escape(key)}"], [data-message-id="${CSS.escape(key)}"], [data-turn-key="${CSS.escape(key)}"]`);

  const findPanel = () => {
    const real = [...doc.querySelectorAll(COMPOSER)].filter(e => vis(e) && !e.closest(ITEM_SEL));
    const base = real.length ? real : [...doc.querySelectorAll(COMPOSER)].filter(vis);
    // Cursor's Agents window can show several cards at once; read the card the sidebar marks selected.
    const selId = doc.querySelector('[data-sidebar-item-key] [data-active="true"]')?.closest('[data-sidebar-item-key]')?.getAttribute('data-sidebar-item-key')?.slice(4);
    const eds = selId ? [...base].sort((a, b) => (a.closest('[data-glass-agent-id]')?.getAttribute('data-glass-agent-id') === selId ? 0 : 1) - (b.closest('[data-glass-agent-id]')?.getAttribute('data-glass-agent-id') === selId ? 0 : 1)) : base;
    for (const ed of eds) {
      let p = ed;
      while (p && !p.querySelector(ITEM_SEL)) p = p.parentElement;
      if (p) return p;
    }
    // Devin's prompt is not a Cursor composer. The first message's parent is only that
    // bubble, so climb until every visible message sits in one transcript.
    const items = [...doc.querySelectorAll(ITEM_SEL)].filter(vis);
    if (!items.length) return null;
    let p = items[0].parentElement;
    for (let i = 0; i < 14 && p?.parentElement && !items.every(it => p.contains(it)); i++) p = p.parentElement;
    return p;
  };

  const isPermissionButton = b => b.getAttribute('data-composer-navigation-target') === 'permissions' || b.getAttribute('aria-label') === 'Change permissions';
  const buttonsIn = (root, strict) => [...root.querySelectorAll('button, [role=button], .anysphere-button, .anysphere-secondary-button, .composer-run-button, .composer-skip-button')]
    .filter(b => vis(b) && !isPermissionButton(b) && !b.closest('.human-message-action-slot') && !SKIP.test(b.className) && !b.parentElement.closest('button, [role=button]'))
    .map(b => ({ el: b, label: ((b.innerText || '').trim() || b.getAttribute('aria-label') || b.title || '').split('\n')[0].slice(0, 30) }))
    .filter(x => x.label && x.label !== 'Shell command options' && (!strict || ACTION.test(x.label)))
    .filter((x, i, rows) => !root.hasAttribute('data-turn-key') || x.label !== 'Copy message' || !rows.slice(0, i).some(b => b.label === x.label));

  // Cursor paints syntax colors as oklch(). Keep only a #hex that differs from the parent.
  const hex = (r, g, b) => '#' + [r, g, b].map(n => Math.round(Math.min(1, Math.max(0, n)) * 255).toString(16).padStart(2, '0')).join('');
  const gamma = x => x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055;
  const cssColor = c => {
    const rgb = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(c || '');
    if (rgb) return hex(rgb[1] / 255, rgb[2] / 255, rgb[3] / 255);
    const ok = /oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)/.exec(c || '');
    if (!ok) return '';
    const L = +ok[1], C = +ok[2], H = +ok[3] * Math.PI / 180;
    const a = C * Math.cos(H), b = C * Math.sin(H);
    const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
    const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
    const s_ = L - 0.0894841775 * a - 1.2914855480 * b;
    const l = l_ ** 3, m = m_ ** 3, s = s_ ** 3;
    return hex(
      gamma(+4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
      gamma(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
      gamma(-0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s),
    );
  };
  const colorAttr = el => {
    const col = cssColor(getComputedStyle(el).color);
    const parent = cssColor(getComputedStyle(el.parentElement || el).color);
    return col && parent && col !== parent ? ` style="color:${col}"` : '';
  };

  // devin: also keep links (http/https only) and h6 for Devin's markdown renderer; Cursor never sets it.
  const clean = (node, devin = false) => {
    let out = '';
    for (const n of node.childNodes) {
      if (n.nodeType === 3) { out += esc(n.textContent); continue; }
      if (n.nodeType !== 1) continue;
      if (n.matches('.katex-display, .katex-block')) {
        const tex = (n.querySelector('annotation')?.textContent || '').trim();
        if (tex) { out += `<div class="math" data-tex="${esc(tex)}">${esc(tex)}</div>`; continue; }
      }
      if (n.matches('.katex')) {
        const tex = (n.querySelector('annotation')?.textContent || '').trim();
        if (tex) { out += `<span class="math" data-tex="${esc(tex)}">${esc(tex)}</span>`; continue; }
      }
      if (n.matches(CODE_BLOCK) || n.getAttribute('data-markdown-copy') === 'code-block') {
        const content = n.querySelector('code') || n.querySelector('.ui-code-block-content') || n;
        const lines = [...content.querySelectorAll('.view-line')];
        const plainLine = el => (el.innerText || '').replace(/\u00a0/g, ' ').replace(/\n/g, '');
        const plain = (lines.length ? lines.map(plainLine).join('\n') : (content.innerText || '').replace(/\u00a0/g, ' ')).replace(/\n$/, '');
        const body = (lines.length ? lines.map(l => clean(l)).join('\n') : esc(plain));
        out += `<div class="codebox"><textarea class="src" hidden readonly>${esc(plain)}</textarea><pre>${body}</pre></div>`;
        continue;
      }
      const href = n.tagName === 'A' ? n.getAttribute('href') || '' : '';
      const localHref = /^(?:file:\/\/|\/|~\/|[A-Za-z]:[\\/]|\.{1,2}\/)/.test(href)
        || (!/^[A-Za-z][\w+.-]*:/.test(href) && /\.[A-Za-z0-9]{1,10}(?:#L\d+(?:-L?\d+)?)?$/.test(href));
      const filePath = n.getAttribute('data-file-reference') === 'true'
        ? n.getAttribute('data-prompt-link-href') || n.getAttribute('data-markdown-copy-text')
        : n.matches(FILE_REF) ? n.innerText.trim()
        : localHref ? (href.startsWith('file://') ? decodeURIComponent(new URL(href).pathname) + new URL(href).hash : href) : null;
      if (filePath) {
        out += `<code data-file="${esc(filePath)}"${colorAttr(n)}>${esc(n.getAttribute('data-prompt-link-label') || n.innerText.trim())}</code>`;
        continue;
      }
      if (n.getAttribute('data-markdown-copy') === 'inline-code') {
        out += `<code>${esc((n.innerText || '').trim())}</code>`;
        continue;
      }
      const tag = n.tagName;
      if (['STYLE', 'SCRIPT', 'BUTTON', 'svg', 'SVG', 'IMG'].includes(tag)) continue;
      if (tag === 'BR') { out += '<br>'; continue; }
      if (tag === 'HR') { out += '<hr>'; continue; }
      if (tag === 'A' && /^https?:\/\//i.test(n.getAttribute('href') || '')) {
        out += `<a href="${esc(n.getAttribute('href'))}">${clean(n)}</a>`;
        continue;
      }
      if (devin && tag === 'A' && /^https?:\/\//i.test(n.getAttribute('href') || '')) {
        out += `<a href="${esc(n.getAttribute('href'))}" target="_blank" rel="noopener noreferrer">${clean(n, devin)}</a>`;
        continue;
      }
      const inner = clean(n, devin);
      const t = tag.toLowerCase();
      const paint = colorAttr(n);
      const block = BLOCK.has(tag) || (devin && tag === 'H6');
      out += block || INLINE.has(tag) ? `<${t}${paint}>${inner}</${t}>` : (paint && inner ? `<span${paint}>${inner}</span>` : inner);
    }
    return out;
  };

  // Devin's code blocks are line divs (no .view-line); keep line breaks and drop the copy chrome.
  const blockText = node => {
    if (node.nodeType === 3) return node.textContent;
    if (node.nodeType !== 1) return '';
    if (/^(BUTTON|SVG|STYLE|SCRIPT)$/.test(node.tagName) || node.getAttribute('role') === 'button') return '';
    if (node.tagName === 'BR') return '\n';
    const inner = [...node.childNodes].map(blockText).join('');
    return /^(DIV|P|LI|TR|PRE)$/.test(node.tagName) ? inner + '\n' : inner;
  };
  const devinRich = root => {
    const c = root.cloneNode(true);
    c.querySelectorAll('[data-md-code-block]').forEach(b => {
      const pre = document.createElement('pre');
      pre.textContent = blockText(b).replace(/\u00a0/g, ' ').replace(/\n+$/, '');
      b.replaceWith(pre);
    });
    return clean(c, true);
  };

  const summary = el => {
    const head = (el.querySelector('.ui-tool-call-card__header, .ui-collapsible-header, [class*="header"]') || el).cloneNode(true);
    head.querySelectorAll('button, [role=button], .anysphere-button, .anysphere-secondary-button, .composer-run-button, .composer-skip-button, kbd').forEach(b => b.remove());
    return (head.textContent || '').trim().replace(/\s*\n\s*/g, ' · ').slice(0, 240);
  };

  // Cursor keeps thinking text mounted inside the collapsible. Devin's "Thought for …"
  // block and the older chat thinking box drop the body until the header is opened.
