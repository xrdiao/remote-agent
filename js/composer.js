/* ---------- composer ---------- */
const text = $('text');
let questionCompose = null;
const drafts = new Map(), draftMentions = new Map();
const dirtyDrafts = new Set();
const inputHistory = new Map(), chatInputCache = new Map(), terminalInputHistory = new Map();
let inputRecall = null;
function endInputRecall() {
  if (inputRecall) inputRecall.history.delete(inputRecall.key);
  inputRecall = null;
}
function chatInputKey(chat = lastChat) { return [currentComputer()?.id || '', viewSel, 'chat', chat?.thread || ''].join('|'); }
function rememberInputHistory(chat) {
  if (!chat) return;
  const key = chatInputKey(chat), rows = new Map(chatInputCache.get(key) || []);
  for (const it of chat.items || []) if (it.k === 'human' && it.t?.trim()) { rows.delete(it.i); rows.set(it.i, it.t); }
  chatInputCache.set(key, [...rows].slice(-10));
}
const pendingSends = new Map(), draftVersions = new Map();
// Optimistic echoes: the sent message/queue row is drawn immediately, then dropped when the real item arrives in a chat update.
let pendingEchoes = [];
function echoTextMatches(it, t) {
  const s = (it.t || '').trim(), x = t.trim();
  return s === x || s.startsWith(x + '\n\n附加文件（')
    || s.replace(/(?:^|\n)\[(?:图片|附件) \d+\](?:\n\[(?:图片|附件) \d+\])*$/, '').trim() === x;
}
function pushEcho(requestId, text, kind) {
  pendingEchoes.push({ requestId, text, kind, at: Date.now(), sel: viewSel });
  queueChatRender();
}
let inputRevision = 0;
let draftEpoch = '';
let draftRevision = 0, draftAckRevision = 0, pendingDesktopDraft = null;
let activeDraft = '';
function sendReceipt(value) {
  const requestId = [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, '0')).join('');
  if (mode === 'chat') {
    clearTimeout(draftPushTimer);
    draftEpoch = requestId;
  }
  const targetThread = viewSel.split('|').pop() || '';
  const candidate = queuedChat?.sel === viewSel ? queuedChat.chat : lastChat;
  const latest = candidate?.thread === targetThread ? candidate : null;
  pendingSends.set(requestId, { requestId, draft: activeDraft, text: value, computer: currentComputer()?.id || '', mode, version: draftVersions.get(activeDraft) || 0, revision: inputRevision,
    ...(mode === 'chat' ? { scope: messageScope(), thread: targetThread, before: new Set((latest?.items || []).filter(it => it.k === 'human').map(it => it.i)),
      beforeQueues: new Set((latest?.queued || []).map(it => it.id)), queuedSameText: (latest?.queued || []).filter(it => echoTextMatches(it, value)).length } : {}) });
  return { requestId, draft: activeDraft, draftEpoch };
}
function confirmSent(m, render = true) {
  if (m.pending) {
    const sent = pendingSends.get(m.requestId);
    if (sent && m.message) {
      sent.confirmationError = m.message;
      const echo = pendingEchoes.find(p => p.requestId === m.requestId);
      if (echo) echo.unknown = true;
      if (render) queueChatRender();
    }
    if (sent && sent.computer === (currentComputer()?.id || '') && sent.draft === draftKey()) {
      if (m.message) status('发送结果未确认：' + m.message, false);
      else if (!sent.confirmationError && ['正在发送…', '正在确认电脑端接收…', '连接已断开，发送结果待确认'].includes(pendingStatus)) status('正在确认电脑端接收…');
    }
    return;
  }
  const echo = pendingEchoes.find(p => p.requestId === m.requestId);
  if (echo) {
    echo.confirmed = true;
    if (m.messageId) echo.messageId = m.messageId;
    if (m.queueId) echo.queueId = m.queueId;
    if (m.queued !== undefined) echo.kind = m.queued ? 'queue' : 'chat';
    if (render) queueChatRender();
  }
  const sent = pendingSends.get(m.requestId);
  if (!sent) return;
  pendingSends.delete(m.requestId);
  if (sent.mode === 'terminal') terminalInputHistory.clear();
  for (const key of inputHistory.keys()) if (key.startsWith(sent.draft + '|')) inputHistory.delete(key);
  if (drafts.get(sent.draft) === sent.text && (draftVersions.get(sent.draft) || 0) === sent.version) { drafts.delete(sent.draft); draftMentions.delete(sent.draft); }
  const here = (currentComputer()?.id || '') === sent.computer && mode === sent.mode && (draftKey() === sent.draft || m.sel === viewSel);
  if (here && (['正在发送…', '正在确认电脑端接收…', '连接已断开，发送结果待确认'].includes(pendingStatus) || $('msg').textContent === '发送结果未确认：' + sent.confirmationError) && ![...pendingSends.values()].some(p => p.draft === activeDraft)) {
    status(m.queued ? 'Agent 正在运行，已加入排队，这一轮结束后自动发送' : '已发送');
  }
  if (here && inputRevision === sent.revision && text.value === sent.text) {
    drafts.delete(activeDraft); draftMentions.delete(activeDraft);
    text.value = ''; MN.mentions = []; MN.value = ''; autosize(); mirroredDraft = '';
    dirtyDrafts.delete(activeDraft); queueDraftSync();
  } else if (here && sent.mode === 'chat' && inputRevision !== sent.revision) {
    draftRevision++; pendingDesktopDraft = null;
    dirtyDrafts.add(activeDraft); queueDraftSync();
  }
  if (sent.mode === 'chat') {
    submittedMessages.push({ ...sent, messageId: m.messageId, queueId: m.queueId, sentAt: m.sentAt || Date.now() });
    if (here && lastChat && render) queueChatRender();
  }
}
function failPendingSend(requestId, message = '发送失败，请重试', report = true) {
  const sent = pendingSends.get(requestId);
  if (!sent) return;
  pendingSends.delete(requestId);
  const hadEcho = pendingEchoes.some(p => p.requestId === requestId);
  pendingEchoes = pendingEchoes.filter(p => p.requestId !== requestId);
  if (hadEcho) queueChatRender();
  if (sent && (currentComputer()?.id || '') === sent.computer && draftKey() === sent.draft && text.value === '') {
    text.value = sent.text; autosize();
  }
  if (report && (currentComputer()?.id || '') === sent.computer && draftKey() === sent.draft) status(message, false);
}
function disconnectPendingSends() {
  if (queueEditRequest) receiveQueueEdit({ ...queueEditRequest, ok: false, error: '连接已断开，操作结果待确认，编辑内容已保留' });
  for (const sent of pendingSends.values()) {
    const echo = pendingEchoes.find(p => p.requestId === sent.requestId);
    if (echo) echo.unknown = true;
    if ((currentComputer()?.id || '') === sent.computer && draftKey() === sent.draft) status('连接已断开，发送结果待确认');
  }
  if (pendingEchoes.length) queueChatRender();
}
function reconcileSent(chat) {
  if (currentApp === 'codex') return; // Codex receipts come from the relay's native message source.
  const matched = new Set(submittedMessages.filter(sent => sent.scope === messageScope() && (!sent.thread || sent.thread === chat.thread))
    .flatMap(sent => [sent.messageId, sent.queueId].filter(Boolean)));
  for (const [requestId, sent] of pendingSends) {
    if (sent.mode !== 'chat' || sent.scope !== messageScope() || (sent.thread && sent.thread !== chat.thread)) continue;
    const queued = (chat.queued || []).find(it => !sent.beforeQueues.has(it.id) && !matched.has(it.id) && it.t?.trim() === sent.text.trim().slice(0, 4000));
    if (queued) { matched.add(queued.id); confirmSent({ requestId, queueId: queued.id, messageId: queued.messageId, sel: viewSel, queued: true }, false); continue; }
    if (sent.queuedSameText) continue;
    const item = chat.items.find(it => receiptMatchesHuman(it, sent) && !matched.has(it.i) && !it.nativeIds?.some(id => matched.has(id)) && !messageTimes.has(generationKey(chat) + '|' + it.i));
    if (item) { matched.add(item.i); confirmSent({ requestId, messageId: item.i, sel: viewSel, queued: false, sentAt: item.sentAt || Date.now() }, false); }
  }
}
function receiptMatchesHuman(it, receipt) {
  if (it.k !== 'human' || receipt.before.has(it.i) || (it.nativeIds || []).some(id => receipt.beforeQueues.has(id))) return false;
  if (receipt.messageId) return it.i === receipt.messageId;
  if (receipt.queueId && it.nativeIds?.length) return it.nativeIds.includes(receipt.queueId);
  return echoTextMatches(it, receipt.text);
}
function receiveQueueDone(m) {
  receiveQueueEdit(m);
  if (!m.ok || m.sel !== viewSel || m.action === 'read') return;
  const removed = new Set();
  for (const echo of pendingEchoes) {
    if (echo.sel !== viewSel || !(m.echoes || []).includes(echo.requestId)) continue;
    if (m.action === 'edit' && currentApp !== 'devin') {
      echo.text = m.text;
      if (m.queueId) echo.queueId = m.queueId;
      if (m.messageId) echo.messageId = m.messageId;
      const receipt = submittedMessages.find(row => row.requestId === echo.requestId);
      if (receipt) Object.assign(receipt, { text: m.text, ...(m.queueId && { queueId: m.queueId }), ...(m.messageId && { messageId: m.messageId }) });
    } else if (m.action !== 'send') removed.add(echo.requestId);
  }
  pendingEchoes = pendingEchoes.filter(row => !removed.has(row.requestId));
  for (let n = submittedMessages.length - 1; n >= 0; n--) if (removed.has(submittedMessages[n].requestId)) submittedMessages.splice(n, 1);
  queueChatRender();
}
function draftKey() { return [currentComputer()?.id || '', viewSel, mode, ...(questionCompose?.sel === viewSel && mode === 'chat' ? [questionCompose.id] : [])].join('|'); }
function saveDraft() { if (activeDraft) { drafts.set(activeDraft, text.value); draftMentions.set(activeDraft, MN.mentions.slice()); } }
function restoreDraft() {
  endInputRecall(); clearTimeout(draftPushTimer); activeDraft = draftKey();
  pendingDesktopDraft = null;
  text.value = drafts.get(activeDraft) || ''; MN.mentions = draftMentions.get(activeDraft)?.slice() || [];
  draftRevision++; queueDraftSync();
  MN.value = text.value; mentionHide(); autosize();
}
function recordDraftEdit() {
  inputRevision++; draftRevision++; pendingDesktopDraft = null;
  dirtyDrafts.add(activeDraft);
  draftVersions.set(activeDraft, (draftVersions.get(activeDraft) || 0) + 1);
  autosize(); saveDraft();
}
function queueDraftSync() {
  clearTimeout(draftPushTimer);
  draftPushTimer = setTimeout(() => {
    if (!windowReady || questionCompose || composing || mode !== 'chat' || currentApp === 'fusion' || MN.mentions.length) return;
    send({ t: 'draft', ...(dirtyDrafts.has(activeDraft) ? { text: text.value } : {}), draftEpoch, revision: draftRevision });
  }, 400);
}
function receiveDraft(m) {
  if (questionCompose || m.sel !== viewSel || m.draftEpoch !== draftEpoch || m.revision !== draftRevision) return;
  if (m.t === 'draftAck') {
    if (m.ok && m.read) { draftAckRevision = m.revision; receiveDraft({ ...m, t: 'draft' }); }
    else if (m.ok && text.value === m.text) { draftAckRevision = m.revision; mirroredDraft = m.text; dirtyDrafts.delete(activeDraft); }
    return;
  }
  if ([...pendingSends.values()].some(sent => sent.draft === activeDraft && sent.revision !== inputRevision)) return;
  if (draftAckRevision !== draftRevision || MN.mentions.length) return;
  if (composing || document.activeElement === text) { pendingDesktopDraft = m; return; }
  pendingDesktopDraft = null;
  if (text.value !== m.text) {
    const selection = [text.selectionStart, text.selectionEnd, text.selectionDirection];
    text.value = m.text;
    text.setSelectionRange(...selection); MN.value = m.text; autosize(); saveDraft();
  }
  mirroredDraft = m.text;
}
function autosize() {
  const oldHeight = text.offsetHeight;
  const field = text.parentElement, fieldHeight = field.style.height;
  // Measure without temporarily shrinking the composer and clamping the chat's scrollTop.
  field.style.height = field.offsetHeight + 'px';
  text.style.height = 'auto'; text.style.height = text.scrollHeight + 'px';
  field.style.height = fieldHeight;
  updateMathPrev(); updateComposeCompact();
  if (text.offsetHeight !== oldHeight) noteChatLayoutChange();
  if (questionCompose?.sel === viewSel && document.body.classList.contains('kb')) fitViewport();
}
function recallInput(direction, input = text) {
  if (mode !== 'chat') return;
  const chat = input === text ? lastChat : chatBySel.get(chatCacheKey(viewSel));
  const cacheKey = chatInputKey(chat ?? null), key = cacheKey + (input === text ? '' : '|overview');
  const mn = composerMentionState(input);
  let state = inputHistory.get(key);
  if (!state) {
    if (direction > 0) return;
    rememberInputHistory(chat);
    const rows = (chatInputCache.get(cacheKey) || []).map(([, value]) => value);
    if (!rows.length) return status('当前会话暂无已发送内容');
    state = { rows, index: rows.length, draft: input.value, mentions: mn.mentions.slice(), selection: [input.selectionStart, input.selectionEnd, input.selectionDirection] };
    inputHistory.set(key, state);
  }
  state.index = Math.max(0, Math.min(state.rows.length, state.index + direction));
  const atDraft = state.index === state.rows.length;
  input.value = atDraft ? state.draft : state.rows[state.index];
  mn.mentions = atDraft ? state.mentions.slice() : [];
  mn.value = input.value;
  if (atDraft) input.setSelectionRange(...state.selection);
  else input.setSelectionRange(input.value.length, input.value.length);
  // The synthetic input saves the recalled text without ending history browsing.
  inputRecall = null;
  mentionHide(input); input.dispatchEvent(new Event('input', { bubbles: true }));
  if (atDraft) inputHistory.delete(key);
  else inputRecall = { history: inputHistory, key };
}
$('inputPrev').onclick = () => recallInput(-1);
$('inputNext').onclick = () => recallInput(1);
let draftPushTimer = 0;
text.addEventListener('input', e => {
  endInputRecall();
  syncMentions(text.value, e);
  recordDraftEdit();
  queueDraftSync();
});
// ---- "@" mentions (Devin): the relay drives Devin's own typeahead, so a mention ends up as a real chip ----
// Typing "@" (or "@file:ser") asks for the list; tapping a row puts "@label" into the text. When the message is
// sent, the relay types the text and, at each "@label", lets Devin's typeahead insert the chip.
const MN = { seq: 0, timer: 0, q: null, root: false, mentions: [], used: '', value: '' };
const composerMentionStates = new Map();
let mentionInput = text, mentionSerial = 0;
function composerInput() { return ovToolInput() || text; }
function composerMentionState(input = text) {
  if (input === text) return MN;
  const key = input.dataset.ovInput;
  if (!composerMentionStates.has(key)) composerMentionStates.set(key, { seq: 0, timer: 0, q: null, root: false, mentions: [], used: '', value: '', revision: 0 });
  return composerMentionStates.get(key);
}
function composerMentionBox(input) { return input === text ? $('mentionBox') : input.closest('.ov-card').querySelector('.ov-mentions'); }
function composerRevision(input) { return input === text ? inputRevision : composerMentionState(input).revision; }
function insertComposerText(value, input = composerInput(), start = input.selectionStart, end = input.selectionEnd) {
  input.setRangeText(value, start, end, 'end');
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.focus();
}
function mentionToken(input = composerInput()) {
  if (input === text && questionCompose || mode !== 'chat' || !supportsCapability('fileReferences', currentApp === 'devin' || currentApp === 'codex')) return null;
  const caret = input.selectionStart ?? input.value.length;
  const value = input.value, head = value.slice(0, caret);
  const end = (() => { let i = caret; while (i < value.length && !/[\s@]/.test(value[i])) i++; return i; })();
  if (currentApp === 'codex') {
    const m = /(^|\s)([@/])([^\s@]*)$/.exec(head);
    return m ? { start: caret - m[3].length - 1, caret, end, q: m[3], trigger: m[2] } : null;
  }
  const m = /(^|\s)@([^\s@]*)$/.exec(head);
  return m ? { start: caret - m[2].length - 1, caret, end, q: m[2], trigger: '@' } : null;
}
function mentionHide(input = text) {
  const mn = composerMentionState(input);
  clearTimeout(mn.timer);
  mn.q = null;
  mn.parent = null;
  mn.seq = ++mentionSerial;
  composerMentionBox(input).hidden = true;
  updateComposeCompact();
}
function mentionAsk(o, input = composerInput()) {
  if (input !== composerInput()) return;
  const mn = composerMentionState(input);
  mentionInput = input;
  mn.seq = ++mentionSerial;
  const token = mentionToken(input);
  mn.request = { sel: viewSel, revision: composerRevision(input), value: input.value, caret: input.selectionStart };
  send({ t: 'mentionQuery', seq: mn.seq, trigger: token?.trigger || '@',
    text: input.value, start: token?.start ?? input.selectionStart, caret: input.selectionStart, ...o });
  const box = composerMentionBox(input);
  if (box.hidden) { box.innerHTML = '<div class="mnHint">加载中…</div>'; box.hidden = false; updateComposeCompact(); }
}
function mentionUpdate(input = composerInput()) {
  const mn = composerMentionState(input);
  mentionInput = input;
  const t = mentionToken(input);
  if (!t) return mentionHide(input);
  const queryKey = `${t.trigger || '@'}${t.q}|${t.start}|${t.caret}|${composerRevision(input)}`;
  if (queryKey === mn.q) return;
  clearTimeout(mn.timer);
  mn.q = queryKey;
  mn.seq = ++mentionSerial;
  mn.timer = setTimeout(() => mentionAsk({ q: t.q }, input), currentApp === 'codex' ? 150 : 220);
  if (currentApp === 'codex' && !composerMentionBox(input).hidden) {
    const hint = composerMentionBox(input).querySelector('.mnHint');
    if (hint) hint.textContent = '搜索中…';
    else composerMentionBox(input).insertAdjacentHTML('afterbegin', '<div class="mnHint">搜索中…</div>');
  }
  if (composerMentionBox(input).hidden) { composerMentionBox(input).innerHTML = '<div class="mnHint">加载中…</div>'; composerMentionBox(input).hidden = false; updateComposeCompact(); }
}
text.addEventListener('input', () => mentionUpdate(text));
$('mentionBox').addEventListener('pointerdown', e => { if (e.pointerType === 'mouse') e.preventDefault(); });
document.addEventListener('pointerdown', e => {
  if (!composerMentionBox(mentionInput)?.hidden && !e.target.closest('#mentionBox, #text, .ov-mentions, [data-ov-input]')) mentionHide(mentionInput);
}, { passive: true });
function onMentions(m) {
  const input = mentionInput, mn = composerMentionState(input);
  if (input !== composerInput()) return;
  if (m.sel !== viewSel || m.seq !== mn.seq) return;
  if (!mn.request || mn.request.sel !== viewSel || mn.request.revision !== composerRevision(input)
    || mn.request.value !== input.value || mn.request.caret !== input.selectionStart) return;
  const t = mentionToken(input);
  if (!m.submenu && !t) return mentionHide(input);
  mn.parent = m.parent || null;
  const box = composerMentionBox(input);
  if (m.prefix) {
    // A category was chosen: the token becomes "@terminal:" and the list below is what that category offers.
    input.setRangeText(m.prefix, t.start, t.end, 'end');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    mn.q = m.prefix.slice(1);
    mn.used = mn.q;
  } else mn.used = m.q;
  mn.root = !!m.root;
  box.innerHTML = m.rows.length
    ? m.rows.map((r, i) => `<button class="mnRow${m.root ? ' cat' : ''}" data-mi="${i}"><b>${esc(r.label)}</b>${r.sub ? `<small>${esc(r.sub)}</small>` : ''}</button>`).join('')
    : '<div class="mnHint">没有匹配的结果</div>';
  box.hidden = false;
  box._rows = m.rows;
  updateComposeCompact();
}
function pickMention(e, input = composerInput()) {
  const mn = composerMentionState(input);
  const b = e.target.closest('[data-mi]');
  const r = b && composerMentionBox(input)._rows?.[Number(b.dataset.mi)];
  const t = mentionToken(input);
  if (!r || (!t && !mn.parent)) return;
  if (mn.root) return mentionAsk({ cat: r.label }, input);
  if (currentApp === 'codex' && (r.key === 'context-action:pick-local-files' || (r.section === 'context-actions' && r.label === 'Files and folders'))) {
    return openCodexFilePicker(t, input);
  }
  const command = currentApp === 'codex' && (mn.parent || r.section === 'commands' || r.section === 'context-actions' || r.section === 'plugins' || r.section === 'apps');
  if (command) {
    if (t) input.setRangeText('', t.start, t.end, 'end');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const parent = mn.parent;
    mentionHide(input);
    mn.request = { sel: viewSel, revision: composerRevision(input), value: input.value, caret: input.selectionStart };
    send({
      t: 'codexPick', key: r.key, label: r.label, section: r.section || '',
      seq: mn.seq, text: input.value, start: input.selectionStart, caret: input.selectionStart,
      q: mn.used || '', parentKey: parent?.key || '', parentLabel: parent?.label || '', parentQ: parent?.q || mn.used || '',
    });

    return;
  }
  if (!t) return;
  const trigger = t.trigger || '@';
  const token = `${trigger}${r.label}`;
  input.setRangeText(token + (/\s/.test(input.value[t.end] || '') ? '' : ' '), t.start, t.end, 'end');
  // From a category ("@file:") the relay must type the file's name too, or Devin only lists its default entries.
  const q = mn.used.endsWith(':') && !r.label.startsWith(mn.used) ? mn.used + r.label : (mn.used || r.label.split(' ')[0]);
  mn.mentions.push({ token, q, label: r.label, sub: r.sub || '', key: r.key || '', section: r.section || '', trigger, at: t.start });
  mn.value = input.value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  mentionHide(input);
  input.focus();
}
$('mentionBox').addEventListener('click', e => pickMention(e, text));
// Mentions still present in the text, in the order they appear.
const mentionsFor = (v, input = text) => { const ms = takeMentions(v, input); return ms.length ? { mentions: ms } : {}; };
function matchedMentions(v, input = text) {
  const mn = composerMentionState(input);
  const used = new Set(), list = [];
  for (const mention of mn.mentions) {
    let at = Number.isInteger(mention.at) && v.slice(mention.at, mention.at + mention.token.length) === mention.token ? mention.at : -1;
    if (at < 0 || used.has(at)) {
      at = v.indexOf(mention.token);
      while (at >= 0 && used.has(at)) at = v.indexOf(mention.token, at + 1);
    }
    if (at < 0 || used.has(at)) continue;
    used.add(at); list.push({ ...mention, at });
  }
  return list.sort((a, b) => a.at - b.at);
}
function takeMentions(v, input = text) { return matchedMentions(v, input).map(({ at, ...mention }) => mention); }
function syncMentions(v, event = null, input = text) {
  const mn = composerMentionState(input);
  const old = mn.value, delta = v.length - old.length;
  if (old !== v && old) {
    let from = 0, oldEnd = old.length, newEnd = v.length;
    while (from < oldEnd && from < newEnd && old[from] === v[from]) from++;
    while (oldEnd > from && newEnd > from && old[oldEnd - 1] === v[newEnd - 1]) { oldEnd--; newEnd--; }
    if (event?.inputType?.startsWith('delete') && Number.isInteger(input.selectionStart)) {
      from = Math.min(input.selectionStart, old.length);
      oldEnd = Math.min(old.length, from + old.length - v.length);
    }
    mn.mentions = mn.mentions.filter(mention => {
      const end = mention.at + mention.token.length;
      if (end <= from) return true;
      if (mention.at >= oldEnd) { mention.at += delta; return true; }
      return false;
    });
  }
  mn.mentions = matchedMentions(v, input); mn.value = v;
}
text.addEventListener('select', () => mentionUpdate(text));
document.addEventListener('selectionchange', () => { if (document.activeElement === composerInput()) mentionUpdate(composerInput()); });
text.addEventListener('focus', () => {
  updateComposeCompact();
  fitViewport();
  setTimeout(fitViewport, 60);
  setTimeout(fitViewport, 320);
});
text.addEventListener('blur', () => {
  if (pendingDesktopDraft) receiveDraft(pendingDesktopDraft);
  setTimeout(fitViewport, 60);
  updateComposeCompact();
});
// Devin while its turn runs: Queue (default, Enter) or Send now (interrupts the turn, after confirmation).
let chatBusy = false;
function devinBusySplit() { return mode === 'chat' && currentApp === 'devin' && supportsCapability('queue') && supportsCapability('steer') && chatBusy; }
function cursorBusyQueue() { return mode === 'chat' && currentApp === 'cursor' && supportsCapability('queue') && chatBusy; }
function codexFollow() {
  const follow = lastChat?.codex?.follow;
  return mode === 'chat' && currentApp === 'codex' && chatBusy && (follow === 'queue' || follow === 'steer') ? follow : '';
}
$('stop').onclick = async () => {
  const sel = viewSel;
  if (!await ask('停止 Agent？\n它这一轮正在做的事会中断。', '停止')) return;
  if (sel !== viewSel || send({ t: 'stop' }) === false) return;
  if (currentApp !== 'fusion') for (const [id, pending] of pendingSends) {
    if (pending.mode === 'chat' && pending.scope === messageScope() && (!pending.thread || pending.thread === lastChat?.thread)) failPendingSend(id, '', false);
  }
  status('正在停止…');
};
function updateSendMode() {
  if (typeof updateVoiceButton === 'function') updateVoiceButton();
  const answering = mode === 'chat' && questionCompose?.sel === viewSel;
  const split = !answering && devinBusySplit();
  const follow = answering ? '' : codexFollow();
  const queue = !answering && (cursorBusyQueue() || follow === 'queue');
  const label = answering ? '提交回答' : mode === 'terminal' ? '发送到终端' : split || queue ? '排队' : follow === 'steer' ? '立即追加' : '发送';
  if ($('send').textContent !== label) $('send').textContent = label;
  $('sendNow').hidden = !split && !follow;
  $('sendNow').textContent = follow === 'steer' ? '改为排队' : '立即追加';
  if (split) $('sendNow').textContent = '立即发送';
  document.body.classList.toggle('sendSplit', split || !!follow);
  updateComposeCompact();
}

/* One presentation controller owns the idle text and compact composer.
   Portrait folds on explicit choice or question focus; landscape keeps its idle capsule. */
let composeCompactTimer = 0, composerEngaged = false, composerPortraitCollapsed = false, composerPointerPending = false;
const portraitComposer = () => mode === 'chat' && !document.body.classList.contains('land');
function questionComposerFocused() {
  const focused = document.activeElement;
  return focused?.matches('#qnBar input, #qnBar textarea, #qnBar select') && !focused.disabled;
}
function micHeld() { return $('mic')?.classList.contains('on') || (typeof voiceSession !== 'undefined' && !!voiceSession); }
function micPressing() { return $('mic')?.classList.contains('on') || (typeof voiceSession !== 'undefined' && !!voiceSession?.held); }
function composeIdleWanted() {
  const focused = document.activeElement;
  return mode === 'chat' && focused !== text && !composerEngaged && !composing
    && !focused?.matches('#qnBar input, #qnBar textarea, #qnBar select')
    && $('mentionBox').hidden && $('fusionWelcome').hidden
    && !document.getElementById('imageEditor')?.open && !micHeld();
}
function endComposerEditing() {
  composerEngaged = false;
  const focused = document.activeElement;
  if (focused === text || focused?.matches('#qnBar input, #qnBar textarea, #qnBar select')) focused.blur();
  updateComposeCompact();
}
function composerLayoutBusy() {
  return chatTouching || chatMomentum || chatScrolling || turnNavPointer?.dragging || $('sheet').classList.contains('open');
}
// Only where vertical room is scarce, judged by the window's actual shape rather than the reported
// orientation (foldables disagree on what "portrait" means): a tall phone window keeps its tools,
// while foldable cover screens (~1.3–1.5 tall:wide), landscape phones, tablets and unfolded inners collapse.
const composeCompactAllowed = () => window.innerHeight / window.innerWidth < 1.6;
window.addEventListener('resize', () => updateComposeCompact());
function composeCompactWanted() {
  // Both callers have already checked composeIdleWanted().
  return composeCompactAllowed() && !text.value.trim() && !$('attachments').children.length;
}
function setComposerPresentation(idle, compact) {
  const oldCompact = document.body.classList.contains('composeCompact');
  if (oldCompact === compact && document.body.classList.contains('composeIdle') === idle) return;
  const stick = isFollowingBottom();
  const foot = document.querySelector('footer');
  const h0 = foot.offsetHeight;
  if (idle && !stick && !atBottom()) {
    const style = getComputedStyle(text);
    const idleHeight = Math.max(parseFloat(style.minHeight), parseFloat(style.fontSize) * 2.9 + 12);
    const reduction = compact ? h0 : Math.max(0, text.offsetHeight - idleHeight);
    if (list.scrollHeight - list.scrollTop - list.clientHeight < reduction) return;
  }
  noteChatLayoutChange();
  document.body.classList.toggle('composeIdle', idle);
  document.body.classList.toggle('composeCompact', compact);
  const fold = $('composerFold');
  const label = I18N.tr(compact ? '展开输入框' : '收起输入框');
  fold.setAttribute('aria-expanded', String(!compact));
  fold.setAttribute('aria-label', label);
  fold.title = label;
  if (!idle) autosize();
  const h1 = foot.offsetHeight;
  if (stick) requestChatScroll();
  if (h0 !== h1 && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    foot.animate([{ height: h0 + 'px', overflow: 'hidden' }, { height: h1 + 'px' }], { duration: 200, easing: 'cubic-bezier(.2,.8,.2,1)' });
  }
}
function setComposeCompact(on) { setComposerPresentation(on, on); }
function setComposerFold(on) {
  composerPointerPending = false;
  composerPortraitCollapsed = on;
  endComposerEditing();
  composerEngaged = true;
  updateComposeCompact();
}
$('composerFold').onclick = () => setComposerFold(!document.body.classList.contains('composeCompact'));
function updateComposeCompact() {
  if (portraitComposer() && (composerPortraitCollapsed || questionComposerFocused())) {
    clearTimeout(composeCompactTimer); composeCompactTimer = 0;
    setComposerPresentation(false, true);
    return;
  }
  // Explicit/question folding is immediate and does not use the idle delay.
  if (document.body.classList.contains('composeCompact') && !document.body.classList.contains('composeIdle')) {
    if (portraitComposer() && composerPointerPending) return;
    clearTimeout(composeCompactTimer); composeCompactTimer = 0;
    setComposerPresentation(false, false);
  }
  if (composeIdleWanted()) {
    if (composerLayoutBusy()) return;
    const compact = !portraitComposer() && composeCompactWanted();
    if (document.body.classList.contains('composeIdle') && (!compact || document.body.classList.contains('composeCompact'))) {
      clearTimeout(composeCompactTimer); composeCompactTimer = 0;
      setComposerPresentation(true, compact);
      return;
    }
    if (composeCompactTimer) return;
    composeCompactTimer = setTimeout(() => {
      composeCompactTimer = 0;
      if (composeIdleWanted() && !composerLayoutBusy()) setComposerPresentation(true, !portraitComposer() && composeCompactWanted());
    }, 1500);
  } else {
    clearTimeout(composeCompactTimer); composeCompactTimer = 0;
    if (!micPressing()) setComposerPresentation(false, false);
  }
}
// Capture-phase so it runs before controls that re-appear under the same tap.
// In compact: taps outside +/mic/stop only expand the composer (the field ignores pointer events
// while compact, so no keyboard yet); a second tap in the field then focuses it natively.
document.querySelector('.composerBox').addEventListener('click', e => {
  if (portraitComposer()) return;
  if (document.body.classList.contains('composeCompact')) {
    if (e.target.closest('#add, #mic, #stop')) return;
    e.preventDefault(); e.stopPropagation();
    composerPointerPending = false;
    clearTimeout(composeCompactTimer); composeCompactTimer = 0;
    composerEngaged = true;
    setComposeCompact(false);
    return;
  }
}, true);
// A tap on the composer's own controls is still "using the composer": keep it engaged so the
// 1.5 s grace can't collapse it mid-interaction (file picker, attach/model sheet open).
// Tapping elsewhere disengages. While compact, don't re-evaluate here — expanding at
// pointerdown would move controls under the finger; the click handler above handles it.
document.addEventListener('pointerdown', e => {
  composerPointerPending = !!e.target.closest('footer, #qnBar');
  if (e.target.closest('#sheet, #shade, #imageEditor')) return;
  const inside = !!e.target.closest('footer') && !e.target.closest('#send, #sendNow');
  if (inside === composerEngaged) return;
  composerEngaged = inside;
  if (!document.body.classList.contains('composeCompact') && !e.target.closest('button')) updateComposeCompact();
}, true);
document.addEventListener('pointercancel', () => {
  if (!composerPointerPending) return;
  composerPointerPending = false;
  updateComposeCompact();
});
for (const event of ['pointerup', 'keyup']) $('mic').addEventListener(event, () => queueMicrotask(updateComposeCompact));
document.addEventListener('focusin', e => {
  if (e.target.matches('#qnBar input, #qnBar textarea, #qnBar select')) updateComposeCompact();
});
document.addEventListener('focusout', e => {
  if (e.target.matches('#qnBar input, #qnBar textarea, #qnBar select')) queueMicrotask(updateComposeCompact);
});
document.addEventListener('click', e => {
  composerPointerPending = false;
  if (e.target.closest('footer')) {
    if (!e.target.closest('#mic')) queueMicrotask(updateComposeCompact);
    return;
  }
  if (e.target.closest('#sheet, #shade, #imageEditor, #qnBar input, #qnBar textarea, #qnBar select')) return;
  if (portraitComposer() && e.target.closest('[data-question-compose]')) return;
  endComposerEditing();
});
$('fusionProject').onclick = () => { status('正在读取项目…'); send({ t: 'fusionProjects' }); };
$('fusionA').onclick = () => send({ t: 'fusionSides', side: 'a' });
$('fusionB').onclick = () => send({ t: 'fusionSides', side: 'b' });
for (const side of ['a', 'b']) $('fusionModel' + side.toUpperCase()).onclick = () => {
  status(lastChat?.fusion?.[side] ? `读取 ${side.toUpperCase()} 的模型…` : `正在选择 ${side.toUpperCase()} Agent…`);
  if (lastChat?.fusion?.[side]) requestFusionModel(side);
  else send({ t: 'fusionSides', side });
};
$('fusionBar').onclick = e => {
  const b = e.target.closest('[data-fusion-act]');
  if (!b) return;
  if (b.dataset.fusionAct === 'history') return send({ t: 'fusionHistory' });
  if (b.dataset.fusionAct === 'new') return send({ t: 'fusionNew' });
  if (b.dataset.fusionAct === 'go') return send({ t: 'fusionGo' });
  send({ t: 'fusionDecide', kind: b.dataset.fusionAct });
};
$('send').onclick = () => {
  if (mode === 'chat' && questionCompose?.sel === viewSel) return submitQuestionCompose();
  if (mode === 'chat' && pendingImageUploads()) return status('图片尚未上传完成；失败图片请重试或删除', false);
  const v = text.value;
  if (currentApp === 'fusion' && lastChat?.fusion?.busy) return status('Fusion 正在进行');
  if (!v.trim() && !$('attachments').children.length) return;
  saveDraft();
  const follow = codexFollow();
  const when = devinBusySplit() || cursorBusyQueue() || follow === 'queue' ? 'queue' : follow === 'steer' ? 'now' : '';
  const receipt = sendReceipt(v);
  if (mode === 'chat') { status('正在发送…'); pushEcho(receipt.requestId, v, when === 'queue' || (!when && chatBusy) ? 'queue' : 'chat'); }
  const sent = mode === 'terminal' ? send({ t: 'termSend', text: v, ...receipt })
    : send({ t: 'send', text: v, submit: true, ...receipt, ...(when ? { when } : {}), ...mentionsFor(v) });
  if (sent === false) failPendingSend(receipt.requestId);
  if (mode === 'chat') jumpToLatest();
};
$('sendNow').onclick = async () => {
  if (pendingImageUploads()) return status('图片尚未上传完成；失败图片请重试或删除', false);
  const v = text.value;
  if (!v.trim() && !$('attachments').children.length) return;
  saveDraft();
  const follow = codexFollow();
  const steer = !follow || follow === 'queue';
  if (!await ask(steer ? '立即追加到当前任务？' : '改为排队，等当前任务结束后再发送？', steer ? '立即追加' : '排队')) return;
  status('正在发送…');
  const receipt = sendReceipt(v);
  pushEcho(receipt.requestId, v, steer ? 'chat' : 'queue');
  if (send({ t: 'send', text: v, submit: true, ...receipt, when: steer ? 'now' : 'queue', ...mentionsFor(v) }) === false) failPendingSend(receipt.requestId);
  jumpToLatest();
};
$('insertNewline').addEventListener('pointerdown', e => e.preventDefault());
$('insertNewline').onclick = () => {
  insertComposerText('\n', text);
};
// Enter sends. Shift+Enter keeps a newline. Ignore Enter that is confirming an IME candidate.
// beforeinput's line-break event often has no shiftKey, so remember it from keydown.
let composing = false;
let shiftEnter = false;
text.addEventListener('compositionstart', () => { endInputRecall(); composing = true; updateComposeCompact(); });
text.addEventListener('compositionend', () => { setTimeout(() => { composing = false; updateComposeCompact(); queueDraftSync(); }, 0); });
function submitOnEnter(e, input = text) {
  const state = input === text ? { shiftEnter, composing } : composerMentionState(input);
  if (state.shiftEnter || e.shiftKey || e.isComposing || state.composing) return;
  e.preventDefault();
  if (input === text) $('send').click();
  else ovSubmit(input.dataset.ovInput);
}
text.addEventListener('keydown', e => {
  if (['ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'].includes(e.key)) endInputRecall();
  if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    if (!e.altKey || e.isComposing || composing || e.keyCode === 229 || !$('mentionBox').hidden) return;
    if (e.ctrlKey || e.metaKey || e.shiftKey || text.selectionStart !== text.selectionEnd) return endInputRecall();
    if (mode !== 'chat' && mode !== 'terminal') return;
    e.preventDefault();
    const direction = e.key === 'ArrowUp' ? -1 : 1;
    if (mode === 'chat') recallInput(direction);
    else send({ t: 'termHistory', direction });
    return;
  }
  if (e.key !== 'Enter') return;
  shiftEnter = e.shiftKey;
  submitOnEnter(e);
});
text.addEventListener('keyup', e => { if (e.key === 'Enter') shiftEnter = false; });
text.addEventListener('beforeinput', e => {
  if (e.inputType === 'insertLineBreak' || e.inputType === 'insertParagraph') submitOnEnter(e);
});
$('pickTerms').onclick = () => { status('正在读取终端列表…'); send({ t: 'terminals' }); };
$('newTerm').onclick = () => { status('正在新建终端…'); send({ t: 'newTerminal' }); };
$('termEmptyNew').onclick = () => { status('正在新建终端…'); send({ t: 'newTerminal' }); };
$('termInt').onclick = () => send({ t: 'key', key: 'Ctrl+c', focus: 'terminal' });
function recallTerminal(m) {
  if (mode !== 'terminal' || m.sel !== viewSel) return;
  const key = [currentComputer()?.id || '', m.sel, m.id].join('|');
  let state = terminalInputHistory.get(key);
  if (!state) {
    if (m.direction > 0) return;
    if (!m.commands.length) return status('当前终端暂无可读取的命令历史');
    state = { rows: m.commands, index: m.commands.length, draft: text.value, selection: [text.selectionStart, text.selectionEnd, text.selectionDirection] };
    terminalInputHistory.set(key, state);
  }
  state.index = Math.max(0, Math.min(state.rows.length, state.index + m.direction));
  const atDraft = state.index === state.rows.length;
  text.value = atDraft ? state.draft : state.rows[state.index];
  if (atDraft) text.setSelectionRange(...state.selection);
  else text.setSelectionRange(text.value.length, text.value.length);
  autosize(); saveDraft();
  if (atDraft) terminalInputHistory.delete(key);
  inputRecall = atDraft ? null : { history: terminalInputHistory, key };
}
document.querySelectorAll('[data-termkey]').forEach(b => b.onclick = () => {
  const direction = b.dataset.termkey === 'ArrowUp' ? -1 : b.dataset.termkey === 'ArrowDown' ? 1 : 0;
  if (direction) send({ t: 'termHistory', direction });
  else send({ t: 'key', key: b.dataset.termkey, focus: 'terminal' });
});

