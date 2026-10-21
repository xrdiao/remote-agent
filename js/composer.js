/* ---------- composer ---------- */
const text = $('text');
let questionCompose = null;
const drafts = new Map(), draftMentions = new Map();
const inputHistory = new Map(), chatInputCache = new Map(), terminalInputHistory = new Map();
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
  // Right after a sel switch lastChat can still be the previous conversation; counting its
  // matching items would leave a stale `before` that the new chat can never exceed.
  const selThread = viewSel.split('|').pop() || '';
  const sameChat = selThread ? lastChat?.thread === selThread : !lastChat?.thread;
  const before = sameChat ? (lastChat?.items || []).filter(it => it.k === 'human' && echoTextMatches(it, text)).length : 0;
  pendingEchoes.push({ requestId, text, kind, at: Date.now(), sel: viewSel, before });
  queueChatRender();
}
let inputRevision = 0;
let draftEpoch = '';
let activeDraft = '';
function sendReceipt(value) {
  const requestId = [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, '0')).join('');
  if (mode === 'chat') {
    clearTimeout(draftPushTimer);
    draftEpoch = requestId;
  }
  pendingSends.set(requestId, { draft: activeDraft, text: value, computer: currentComputer()?.id || '', mode, version: draftVersions.get(activeDraft) || 0, revision: inputRevision,
    ...(mode === 'chat' ? { scope: messageScope(), thread: lastChat?.thread || '', before: new Set((lastChat?.items || []).filter(it => it.k === 'human').map(it => it.i)) } : {}) });
  return { requestId, draft: activeDraft, draftEpoch };
}
function confirmSent(m) {
  const echo = pendingEchoes.find(p => p.requestId === m.requestId);
  if (echo) { echo.confirmed = true; if (m.queued !== undefined) echo.kind = m.queued ? 'queue' : 'chat'; queueChatRender(); }
  const sent = pendingSends.get(m.requestId);
  if (!sent) return;
  pendingSends.delete(m.requestId);
  if (sent.mode === 'terminal') terminalInputHistory.clear();
  for (const key of inputHistory.keys()) if (key.startsWith(sent.draft + '|')) inputHistory.delete(key);
  if (drafts.get(sent.draft) === sent.text && (draftVersions.get(sent.draft) || 0) === sent.version) { drafts.delete(sent.draft); draftMentions.delete(sent.draft); }
  const here = (currentComputer()?.id || '') === sent.computer && mode === sent.mode && (draftKey() === sent.draft || m.sel === viewSel);
  if (here && pendingStatus === '正在发送…' && ![...pendingSends.values()].some(p => p.draft === activeDraft)) {
    status(m.queued ? 'Agent 正在运行，已加入排队，这一轮结束后自动发送' : '已发送');
  }
  if (here && inputRevision === sent.revision && text.value === sent.text) {
    drafts.delete(activeDraft); draftMentions.delete(activeDraft);
    text.value = ''; MN.mentions = []; autosize(); mirroredDraft = '';
  }
  if (sent.mode === 'chat') {
    submittedMessages.push({ ...sent, sentAt: m.sentAt || Date.now() });
    if (here && lastChat) queueChatRender();
  }
}
function reconcileSent(chat) {
  const matched = new Set();
  for (const [requestId, sent] of pendingSends) {
    if (sent.mode !== 'chat' || sent.scope !== messageScope() || (sent.thread && sent.thread !== chat.thread)) continue;
    const item = chat.items.find(it => it.k === 'human' && !matched.has(it.i) && !messageTimes.has(generationKey(chat) + '|' + it.i) && !sent.before.has(it.i) && echoTextMatches(it, sent.text));
    if (item) { matched.add(item.i); confirmSent({ requestId, sel: viewSel, queued: false, sentAt: item.sentAt || Date.now() }); }
  }
}
function draftKey() { return [currentComputer()?.id || '', viewSel, mode, ...(questionCompose?.sel === viewSel && mode === 'chat' ? [questionCompose.id] : [])].join('|'); }
function saveDraft() { if (activeDraft) { drafts.set(activeDraft, text.value); draftMentions.set(activeDraft, MN.mentions.slice()); } }
function restoreDraft() { activeDraft = draftKey(); text.value = drafts.get(activeDraft) || ''; MN.mentions = draftMentions.get(activeDraft)?.slice() || []; mentionHide(); autosize(); }
function autosize() { text.style.height = 'auto'; text.style.height = text.scrollHeight + 'px'; updateMathPrev(); updateComposeCompact(); }
function recallInput(direction) {
  if (mode !== 'chat') return;
  const key = chatInputKey();
  let state = inputHistory.get(key);
  if (!state) {
    if (direction > 0) return;
    rememberInputHistory(lastChat);
    const rows = (chatInputCache.get(key) || []).map(([, value]) => value);
    if (!rows.length) return status('当前会话暂无已发送内容');
    state = { rows, index: rows.length, draft: text.value, mentions: MN.mentions.slice() };
    inputHistory.set(key, state);
  }
  state.index = Math.max(0, Math.min(state.rows.length, state.index + direction));
  const atDraft = state.index === state.rows.length;
  text.value = atDraft ? state.draft : state.rows[state.index];
  MN.mentions = atDraft ? state.mentions.slice() : [];
  text.setSelectionRange(text.value.length, text.value.length);
  mentionHide(); text.dispatchEvent(new Event('input', { bubbles: true }));
  if (atDraft) inputHistory.delete(key);
}
$('inputPrev').onclick = () => recallInput(-1);
$('inputNext').onclick = () => recallInput(1);
let draftPushTimer = 0;
text.addEventListener('input', () => {
  inputRevision++; draftVersions.set(activeDraft, (draftVersions.get(activeDraft) || 0) + 1); autosize(); saveDraft();
  clearTimeout(draftPushTimer);
  draftPushTimer = setTimeout(() => {
    if (questionCompose || composing || mode !== 'chat' || currentApp === 'fusion' || MN.mentions.length) return;
    send({ t: 'draft', text: text.value, draftEpoch });
  }, 400);
});
// ---- "@" mentions (Devin): the relay drives Devin's own typeahead, so a mention ends up as a real chip ----
// Typing "@" (or "@file:ser") asks for the list; tapping a row puts "@label" into the text. When the message is
// sent, the relay types the text and, at each "@label", lets Devin's typeahead insert the chip.
const MN = { seq: 0, timer: 0, q: null, root: false, mentions: [], used: '' };
function mentionToken() {
  if (questionCompose || mode !== 'chat' || (currentApp !== 'devin' && currentApp !== 'codex')) return null;
  const caret = text.selectionStart ?? text.value.length;
  const head = text.value.slice(0, caret);
  if (currentApp === 'codex') {
    const m = /(^|\s)([@/])([^\s@]*)$/.exec(head);
    return m ? { start: caret - m[3].length - 1, caret, q: m[3], trigger: m[2] } : null;
  }
  const m = /(^|\s)@([^\s@]*)$/.exec(head);
  return m ? { start: caret - m[2].length - 1, caret, q: m[2], trigger: '@' } : null;
}
function mentionHide() {
  clearTimeout(MN.timer);
  MN.q = null;
  MN.parent = null;
  MN.seq++;
  $('mentionBox').hidden = true;
  updateComposeCompact();
}
function mentionAsk(o) {
  MN.seq++;
  const token = mentionToken();
  send({ t: 'mentionQuery', seq: MN.seq, trigger: token?.trigger || '@', ...o });
  const box = $('mentionBox');
  if (box.hidden) { box.innerHTML = '<div class="mnHint">加载中…</div>'; box.hidden = false; updateComposeCompact(); }
}
function mentionUpdate() {
  const t = mentionToken();
  clearTimeout(MN.timer);
  if (!t) return mentionHide();
  const queryKey = (t.trigger || '@') + t.q;
  if (queryKey === MN.q) return;
  MN.q = queryKey;
  if (currentApp === 'codex') MN.seq++;
  MN.timer = setTimeout(() => mentionAsk({ q: t.q }), currentApp === 'codex' ? 150 : 220);
  if (currentApp === 'codex' && !$('mentionBox').hidden) {
    const hint = $('mentionBox').querySelector('.mnHint');
    if (hint) hint.textContent = '搜索中…';
    else $('mentionBox').insertAdjacentHTML('afterbegin', '<div class="mnHint">搜索中…</div>');
  }
  if ($('mentionBox').hidden) { $('mentionBox').innerHTML = '<div class="mnHint">加载中…</div>'; $('mentionBox').hidden = false; updateComposeCompact(); }
}
text.addEventListener('input', mentionUpdate);
$('mentionBox').addEventListener('pointerdown', e => { if (e.pointerType === 'mouse') e.preventDefault(); });
document.addEventListener('pointerdown', e => {
  if (!$('mentionBox').hidden && !e.target.closest('#mentionBox, #text')) mentionHide();
}, { passive: true });
function onMentions(m) {
  if (!m.submenu && m.seq !== MN.seq) return;
  const t = mentionToken();
  if (!m.submenu && !t) return mentionHide();
  MN.parent = m.parent || null;
  const box = $('mentionBox');
  if (m.prefix) {
    // A category was chosen: the token becomes "@terminal:" and the list below is what that category offers.
    text.setRangeText(m.prefix, t.start, t.caret, 'end');
    autosize();
    MN.q = m.prefix.slice(1);
    MN.used = MN.q;
  } else MN.used = m.q;
  MN.root = !!m.root;
  box.innerHTML = m.rows.length
    ? m.rows.map((r, i) => `<button class="mnRow${m.root ? ' cat' : ''}" data-mi="${i}"><b>${esc(r.label)}</b>${r.sub ? `<small>${esc(r.sub)}</small>` : ''}</button>`).join('')
    : '<div class="mnHint">没有匹配的结果</div>';
  box.hidden = false;
  box._rows = m.rows;
  updateComposeCompact();
}
$('mentionBox').addEventListener('click', e => {
  const b = e.target.closest('[data-mi]');
  const r = b && $('mentionBox')._rows?.[Number(b.dataset.mi)];
  const t = mentionToken();
  if (!r || (!t && !MN.parent)) return;
  if (MN.root) return mentionAsk({ cat: r.label });
  if (currentApp === 'codex' && (r.key === 'context-action:pick-local-files' || (r.section === 'context-actions' && r.label === 'Files and folders'))) {
    status('继续输入文件名，从列表里选择');
    return;
  }
  const command = currentApp === 'codex' && (MN.parent || r.section === 'commands' || r.section === 'context-actions' || r.section === 'plugins' || r.section === 'apps');
  if (command) {
    if (t) text.setRangeText('', t.start, t.caret, 'end');
    autosize();
    const parent = MN.parent;
    mentionHide();
    send({
      t: 'codexPick', key: r.key, label: r.label, section: r.section || '',
      q: MN.used || '', parentKey: parent?.key || '', parentLabel: parent?.label || '', parentQ: parent?.q || MN.used || '',
    });
    return;
  }
  if (!t) return;
  const trigger = t.trigger || '@';
  const token = `${trigger}${r.label}`;
  text.setRangeText(token + ' ', t.start, t.caret, 'end');
  // From a category ("@file:") the relay must type the file's name too, or Devin only lists its default entries.
  const q = MN.used.endsWith(':') && !r.label.startsWith(MN.used) ? MN.used + r.label : (MN.used || r.label.split(' ')[0]);
  MN.mentions.push({ token, q, label: r.label, sub: r.sub || '', key: r.key || '', section: r.section || '', trigger });
  autosize();
  mentionHide();
  text.focus();
});
// Mentions still present in the text, in the order they appear.
const mentionsFor = v => { const ms = takeMentions(v); return ms.length ? { mentions: ms } : {}; };
function takeMentions(v) {
  const list = MN.mentions.map(m => ({ ...m, at: v.indexOf(m.token) })).filter(m => m.at >= 0).sort((a, b) => a.at - b.at).map(({ at, ...m }) => m);
  return list;
}
text.addEventListener('focus', () => {
  stickOnKeyboard = followingChat();
  fitViewport();
  setTimeout(fitViewport, 60);
  setTimeout(fitViewport, 320);
  updateComposeCompact();
});
text.addEventListener('blur', () => {
  stickOnKeyboard = false;
  setTimeout(fitViewport, 60);
  updateComposeCompact();
});
// Devin while its turn runs: Queue (default, Enter) or Send now (interrupts the turn, after confirmation).
let chatBusy = false;
function devinBusySplit() { return mode === 'chat' && currentApp === 'devin' && chatBusy; }
function codexFollow() {
  const follow = lastChat?.codex?.follow;
  return mode === 'chat' && currentApp === 'codex' && chatBusy && (follow === 'queue' || follow === 'steer') ? follow : '';
}
$('stop').onclick = async () => {
  if (!await ask('停止 Agent？\n它这一轮正在做的事会中断。', '停止')) return;
  send({ t: 'stop' }); status('正在停止…');
};
function updateSendMode() {
  if (typeof updateVoiceButton === 'function') updateVoiceButton();
  const answering = mode === 'chat' && questionCompose?.sel === viewSel;
  const split = !answering && devinBusySplit();
  const follow = answering ? '' : codexFollow();
  const label = answering ? '提交回答' : mode === 'terminal' ? '发送到终端' : split || follow === 'queue' ? '排队' : follow === 'steer' ? '立即追加' : '发送';
  if ($('send').textContent !== label) $('send').textContent = label;
  $('sendNow').hidden = !split && !follow;
  $('sendNow').textContent = follow === 'steer' ? '改为排队' : '立即追加';
  if (split) $('sendNow').textContent = '立即发送';
  document.body.classList.toggle('sendSplit', split || !!follow);
  updateComposeCompact();
}

/* Compact composer: an empty, unfocused chat composer collapses to a one-line pill so
   the chat gets the vertical room back. Expanding is immediate on any interaction
   (focus, typed/restored text, attachments, mentions, recording, fusion welcome);
   collapsing waits out a 1.5 s grace so the pill never slides while a finger is in
   transit, and never while the mic is held. */
let composeCompactTimer = 0, composeExpandedAt = 0, composerEngaged = false;
function micHeld() { return $('mic')?.classList.contains('on') || (typeof voiceSession !== 'undefined' && !!voiceSession); }
// Only where vertical room is scarce, judged by the window's actual shape rather than the reported
// orientation (foldables disagree on what "portrait" means): a tall phone window keeps the full composer,
// while foldable cover screens (~1.3–1.5 tall:wide), landscape phones, tablets and unfolded inners collapse.
const composeCompactAllowed = () => window.innerHeight / window.innerWidth < 1.6;
window.addEventListener('resize', () => updateComposeCompact());
function composeCompactWanted() {
  return mode === 'chat' && composeCompactAllowed()
    && !text.value.trim() && document.activeElement !== text && !composerEngaged
    && !$('attachments').children.length
    && $('mentionBox').hidden
    && $('fusionWelcome').hidden
    && !document.getElementById('imageEditor')?.open
    && !micHeld();
}
function setComposeCompact(on) {
  if (document.body.classList.contains('composeCompact') === on) return;
  const stick = followingChat();
  const foot = document.querySelector('footer');
  const h0 = foot.offsetHeight;
  document.body.classList.toggle('composeCompact', on);
  if (!on) composeExpandedAt = performance.now();
  const h1 = foot.offsetHeight;
  if (stick) list.scrollTop = list.scrollHeight;
  if (h0 !== h1 && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    foot.animate([{ height: h0 + 'px', overflow: 'hidden' }, { height: h1 + 'px' }], { duration: 200, easing: 'cubic-bezier(.2,.8,.2,1)' });
  }
}
function updateComposeCompact() {
  if (composeCompactWanted()) {
    if (document.body.classList.contains('composeCompact') || composeCompactTimer) return;
    composeCompactTimer = setTimeout(() => {
      composeCompactTimer = 0;
      if (composeCompactWanted()) setComposeCompact(true);
    }, 1500);
  } else {
    clearTimeout(composeCompactTimer); composeCompactTimer = 0;
    if (!micHeld()) setComposeCompact(false);
    // Mic held: defer the flip; updateVoiceButton re-runs this when the gesture ends.
  }
}
// Capture-phase so it runs before controls that re-appear under the same tap.
// In compact: taps outside +/mic/stop only expand the composer (the field ignores pointer events
// while compact, so no keyboard yet); a second tap in the field then focuses it natively.
// Right after expanding, the same tap's ghost click would hit controls that were hidden
// when the finger went down — swallow it for 400 ms.
document.querySelector('.composerBox').addEventListener('click', e => {
  if (document.body.classList.contains('composeCompact')) {
    if (e.target.closest('#add, #mic, #stop')) return;
    e.preventDefault(); e.stopPropagation();
    clearTimeout(composeCompactTimer); composeCompactTimer = 0;
    composerEngaged = true;
    setComposeCompact(false);
    return;
  }
  if (performance.now() - composeExpandedAt < 400
    && e.target.closest('button') && !e.target.closest('#add, #mic, #stop')) {
    e.preventDefault(); e.stopPropagation();
  }
}, true);
// A tap on the composer's own controls is still "using the composer": keep it engaged so the
// 1.5 s grace can't collapse it mid-interaction (file picker, attach/model sheet open).
// Tapping elsewhere disengages. While compact, don't re-evaluate here — expanding at
// pointerdown would move controls under the finger; the click handler above handles it.
document.addEventListener('pointerdown', e => {
  if (e.target.closest('#sheet, #shade, #imageEditor')) return;
  const inside = !!e.target.closest('footer') && !e.target.closest('#send, #sendNow');
  if (inside === composerEngaged) return;
  composerEngaged = inside;
  if (!document.body.classList.contains('composeCompact')) updateComposeCompact();
}, true);
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
  const when = devinBusySplit() || follow === 'queue' ? 'queue' : follow === 'steer' ? 'now' : '';
  const receipt = sendReceipt(v);
  if (mode === 'chat') { status('正在发送…'); pushEcho(receipt.requestId, v, when === 'queue' || (!when && chatBusy) ? 'queue' : 'chat'); }
  if (mode === 'terminal') send({ t: 'termSend', text: v, ...receipt });
  else send({ t: 'send', text: v, submit: true, ...receipt, ...(when ? { when } : {}), ...mentionsFor(v) });
  if (mode === 'chat') list.scrollTop = list.scrollHeight;
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
  send({ t: 'send', text: v, submit: true, ...receipt, when: steer ? 'now' : 'queue', ...mentionsFor(v) });
  if (currentApp !== 'codex') { text.value = ''; autosize(); }
  list.scrollTop = list.scrollHeight;
};
$('insertNewline').addEventListener('pointerdown', e => e.preventDefault());
$('insertNewline').onclick = () => {
  text.setRangeText('\n', text.selectionStart, text.selectionEnd, 'end');
  text.dispatchEvent(new Event('input', { bubbles: true }));
  text.focus();
};
// Enter sends. Shift+Enter keeps a newline. Ignore Enter that is confirming an IME candidate.
// beforeinput's line-break event often has no shiftKey, so remember it from keydown.
let composing = false;
let shiftEnter = false;
text.addEventListener('compositionstart', () => { composing = true; });
text.addEventListener('compositionend', () => { setTimeout(() => { composing = false; }, 0); });
function submitOnEnter(e) {
  if (shiftEnter || e.shiftKey || e.isComposing || composing) return;
  e.preventDefault();
  $('send').click();
}
text.addEventListener('keydown', e => {
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
    state = { rows: m.commands, index: m.commands.length, draft: text.value };
    terminalInputHistory.set(key, state);
  }
  state.index = Math.max(0, Math.min(state.rows.length, state.index + m.direction));
  const atDraft = state.index === state.rows.length;
  text.value = atDraft ? state.draft : state.rows[state.index];
  text.setSelectionRange(text.value.length, text.value.length); autosize(); saveDraft();
  if (atDraft) terminalInputHistory.delete(key);
}
document.querySelectorAll('[data-termkey]').forEach(b => b.onclick = () => {
  const direction = b.dataset.termkey === 'ArrowUp' ? -1 : b.dataset.termkey === 'ArrowDown' ? 1 : 0;
  if (direction) send({ t: 'termHistory', direction });
  else send({ t: 'key', key: b.dataset.termkey, focus: 'terminal' });
});

