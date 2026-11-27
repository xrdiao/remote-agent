  const thinkingItem = (el, host, n) => {
    const title = thinkingTitleOf(el) || '思考';
    const body = thinkingPlain(el).trim();
    const base = itemKey(host && host !== el ? host : el) || `${activeThread()}:thinking:${thinkingNodes().indexOf(el)}`;
    const item = { i: `${base}:think:${n}`, k: 'thinking', t: body ? `${title}\n${body}` : title };
    if (thinkingLive(el)) item.live = true;
    return item;
  };
  const isThinking = el => el.matches('.ui-thinking-collapsible, .chat-thinking-box')
    || (el.matches('.highlight-wrapper') && /^(thinking|thoughts|thought(?: for)? )\b/i.test(thinkingTitleOf(el)));
  const thinkingInside = root => [...root.querySelectorAll(THINKING_ROOT)].filter(th => th.closest(THINKING_ROOT) === th && isThinking(th));
  const withoutThinking = el => {
    const clone = el.cloneNode(true);
    clone.querySelectorAll(THINKING_ROOT).forEach(n => n.remove());
    return clone;
  };
  // Devin user messages: rendered KaTeX would read twice through innerText (MathML + glyphs), so rebuild the
  // text with the math as $tex$ / $$tex$$ from the KaTeX annotation. Without math the plain text is unchanged.
  const devinUserText = root => {
    if (!root.querySelector('.katex')) return root.innerText.trim();
    const tex = n => (n.querySelector('annotation')?.textContent || '').trim();
    const walk = n => {
      if (n.nodeType === 3) return n.textContent;
      if (n.nodeType !== 1 || n.matches('button, style, script, svg')) return '';
      if (n.matches('.katex-display, .katex-block') && tex(n)) return `\n$$${tex(n)}$$\n`;
      if (n.matches('.katex') && tex(n)) return `$${tex(n)}$`;
      if (n.tagName === 'BR') return '\n';
      const inner = [...n.childNodes].map(walk).join('');
      return /^(P|DIV|LI|UL|OL|PRE|BLOCKQUOTE|H[1-6]|TABLE|TR)$/.test(n.tagName) ? `\n${inner}\n` : inner;
    };
    return walk(root).replace(/\u00a0/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  };
  const messageItem = (el, canonical = null, knownKey = null) => {
    const kindEl = el.matches('[data-message-kind]') ? el : el.querySelector('[data-message-kind]');
    const aria = el.getAttribute('aria-label');
    const k = aria === 'User message' ? 'human'
      : aria === 'Devin message' ? 'assistant'
      : kindEl?.dataset.messageKind || (el.querySelector('.composer-human-message, .aislash-editor-input-readonly') ? 'human'
        : el.querySelector('.anysphere-markdown-container-root') ? 'assistant' : 'other');
    const item = { i: knownKey ?? itemKey(el), k };
    const sentAt = Date.parse(el.querySelector('time[datetime]')?.getAttribute('datetime') || '');
    if (k === 'human' && Number.isFinite(sentAt)) item.sentAt = sentAt;
    if (k === 'thinking') {
      const action = (el.querySelector('.ui-collapsible-action')?.innerText || '').replace(/\s+/g, ' ').trim();
      let details = (el.querySelector('.ui-collapsible-details')?.innerText || '').replace(/\s+/g, ' ').trim();
      details = details.replace(/\b(\w+)(?:\s+\1)+\b/gi, '$1');
      const title = [action || 'Thought', details].filter(Boolean).join(' ').slice(0, 80);
      const content = el.querySelector('.ui-collapsible-content');
      const plain = (content?.textContent || '').replace(/\u00a0/g, ' ').trim();
      item.t = plain ? `${title}\n${plain}` : title;
      if (/^thinking\b/i.test(action) || el.querySelector('[data-loading]')) item.live = true;
      return item;
    }
    // Devin keeps the sender and timestamp outside the message's Markdown body.
    const readable = aria === 'User message' ? el.querySelector('.prose-main')
      : el.querySelector('.aislash-editor-input-readonly, .composer-human-message') || withoutThinking(el);
    if (k === 'human') {
      item.t = canonical?.k === k ? canonical.t : aria === 'User message' ? (readable ? devinUserText(readable) : '') : (readable.innerText || readable.textContent || '').trim();
      const images = messageImages(el);
      if (images.length) item.images = images;
    }
    else if (k === 'assistant') {
      const devinRoot = aria === 'Devin message' ? el.querySelector('.prose-main') : null;
      const md = [...el.querySelectorAll('.markdown-root, .ui-markdown, .rendered-markdown, .anysphere-markdown-container-root')].find(n => !n.closest(THINKING_ROOT));
      const body = devinRoot || md || withoutThinking(el);
      item.t = canonical?.k === k ? canonical.t : (body.innerText || body.textContent || '').trim();
      item.h = devinRoot ? devinRich(devinRoot) : md ? clean(md) : esc((withoutThinking(el).innerText || '').trim()).replace(/\n/g, '<br>');
      const images = messageImages(body);
      if (images.length) item.images = images;
    }
    else item.t = summary(withoutThinking(el));
    if (k === 'tool') {
      const f = toolFile(el); if (f) item.f = f;
      const host = el.closest('[data-message-kind="tool"]') || el;
      const row = codexFiberProps(host, 6).find(p => p.row)?.row;
      const entries = row?.items || (row?.entry ? [row.entry] : []);
      if (entries.length && entries.every(e => /^(?:shell|read|listDir|glob|grep|ripgrepSearch|search|webSearch|webFetch|getMcpTools)ToolCall$/.test(e.step?.toolCallVm?.case || e.summaryToolCase || ''))) item.execution = true;
      if (host.dataset.toolHasError === 'true' || host.dataset.toolStatus === 'error' || entries.some(e => e.step?.error)) item.keep = true;
    }
    const b = buttonsIn(el, false).filter(x => !x.el.closest(THINKING_ROOT));
    if (b.length) {
      item.b = b.map(x => x.label);
      item.actions = b.map(x => {
        if (!x.el.dataset.remoteAction) x.el.dataset.remoteAction = crypto.randomUUID();
        return x.el.dataset.remoteAction;
      });
    }
    return item;
  };

  const cursorToolItems = el => {
    const runs = buttonsIn(el, false).filter(b => /^(Run|运行)$/.test(b.label));
    if (runs.length < 2) return [messageItem(el)];
    return runs.map(({ el: button }) => {
      let card = button.parentElement;
      while (card.parentElement && card.parentElement !== el && el.contains(card.parentElement)
        && runs.filter(b => card.parentElement.contains(b.el)).length === 1) card = card.parentElement;
      const item = messageItem(card);
      item.k = 'tool';
      item.t = summary(card);
      return item;
    });
  };

  const codexVisibleThread = () => {
    const editor = [...doc.querySelectorAll('.ProseMirror')].find(vis);
    return codexComposerThread(codexFiberProps(editor, 40)) || codexAnnotationThread();
  };
  const codexAnnotationThread = () => [...doc.querySelectorAll('[data-response-annotation-conversation]')].filter(vis).at(-1)?.getAttribute('data-response-annotation-conversation') || '';
  const codexThread = () => remoteContext?.app === 'codex' ? remoteContext.threadId : codexVisibleThread();
  const attachmentRows = (ready = false) => {
    const ed = [...doc.querySelectorAll(`${COMPOSER}, [data-slate-editor="true"][contenteditable="true"]`)].filter(vis).at(-1);
    if (!ed) return [];
    let box = ed;
    for (let i = 0; i < 8 && box.parentElement; i++) box = box.parentElement;
    const cursor = ed.closest('.ai-input-full-input-box');
    if (cursor) box = cursor;
    const buttons = [...box.querySelectorAll('button[aria-label^="Remove "]')].filter(button => button.parentElement.querySelector('img'));
    if (ready) {
      const images = [...buttons.map(button => button.parentElement.querySelector('img')), ...box.querySelectorAll('.context-pill-image img')];
      return Promise.all(images.map(img => img.decode())).then(() => attachmentRows());
    }
    return [...buttons, ...box.querySelectorAll('.context-pill-image')].filter(vis).map(button => {
      const pill = button.matches('.context-pill-image');
      const img = pill ? button.querySelector('img') : button.parentElement.querySelector('img');
      const source = img?.currentSrc || img?.src || '';
      if (!button.dataset.remoteAttachment || button.__remoteAttachmentSrc !== source) {
        button.dataset.remoteAttachment = crypto.randomUUID();
        button.__remoteAttachmentSrc = source;
      }
      let preview = '';
      if (img?.complete && img.naturalWidth) {
        const canvas = doc.createElement('canvas');
        canvas.width = 96; canvas.height = Math.max(1, Math.round(96 * img.naturalHeight / img.naturalWidth));
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        preview = canvas.toDataURL('image/jpeg', 0.6);
      }
      const label = pill ? '图片' : button.getAttribute('aria-label').slice(7);
      const name = img?.alt && img.alt !== 'User attachment' ? img.alt.replace(/^User uploaded image (\d+)$/, '图片 $1') : label;
      return { id: button.dataset.remoteAttachment, name, preview };
    });
  };
  const attachmentImage = async id => {
    const row = attachmentRows().find(f => f.id === id);
    if (!row) throw new Error('图片已不在当前输入框中');
    const el = [...doc.querySelectorAll('[data-remote-attachment]')].find(e => e.dataset.remoteAttachment === id);
    const img = el.matches('.context-pill-image') ? el.querySelector('img') : el.parentElement.querySelector('img');
    await img.decode();
    const canvas = doc.createElement('canvas');
    canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
    canvas.getContext('2d').drawImage(img, 0, 0);
    return { name: row.name, data: canvas.toDataURL('image/png') };
  };
  const removeAttachment = id => {
    if (!attachmentRows().some(f => f.id === id)) return false;
    const el = [...doc.querySelectorAll('[data-remote-attachment]')].find(b => b.dataset.remoteAttachment === id);
    const button = el?.matches('.context-pill-image') ? el.querySelector('.image-pill-close-button') : el;
    if (!button) return false;
    button.click();
    return true;
  };
  const attachmentPoint = id => {
    const el = [...doc.querySelectorAll('[data-remote-attachment]')].find(e => e.dataset.remoteAttachment === id);
    return el ? center(el) : null;
  };
