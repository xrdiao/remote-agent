/* ---------- composer ---------- */
const text = $('text');
const drafts = new Map(), draftMentions = new Map();
const pendingSends = new Map(), draftVersions = new Map();
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
  const sent = pendingSends.get(m.requestId);
  if (!sent) return;
  pendingSends.delete(m.requestId);
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
function draftKey() { return [currentComputer()?.id || '', viewSel, mode].join('|'); }
function saveDraft() { if (activeDraft) { drafts.set(activeDraft, text.value); draftMentions.set(activeDraft, MN.mentions.slice()); } }
function restoreDraft() { activeDraft = draftKey(); text.value = drafts.get(activeDraft) || ''; MN.mentions = draftMentions.get(activeDraft)?.slice() || []; mentionHide(); autosize(); }
function autosize() { text.style.height = 'auto'; text.style.height = text.scrollHeight + 'px'; updateMathPrev(); }
let draftPushTimer = 0;
text.addEventListener('input', () => {
  inputRevision++; draftVersions.set(activeDraft, (draftVersions.get(activeDraft) || 0) + 1); autosize(); saveDraft();
  clearTimeout(draftPushTimer);
  draftPushTimer = setTimeout(() => {
    if (composing || mode !== 'chat' || currentApp === 'fusion' || MN.mentions.length) return;
    send({ t: 'draft', text: text.value, draftEpoch });
  }, 400);
});
// ---- "@" mentions (Devin): the relay drives Devin's own typeahead, so a mention ends up as a real chip ----
// Typing "@" (or "@file:ser") asks for the list; tapping a row puts "@label" into the text. When the message is
// sent, the relay types the text and, at each "@label", lets Devin's typeahead insert the chip.
const MN = { seq: 0, timer: 0, q: null, root: false, mentions: [], used: '' };
function mentionToken() {
  if (mode !== 'chat' || (currentApp !== 'devin' && currentApp !== 'codex')) return null;
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
}
function mentionAsk(o) {
  MN.seq++;
  const token = mentionToken();
  send({ t: 'mentionQuery', seq: MN.seq, trigger: token?.trigger || '@', ...o });
  const box = $('mentionBox');
  if (box.hidden) { box.innerHTML = '<div class="mnHint">加载中…</div>'; box.hidden = false; }
}
function mentionUpdate() {
  const t = mentionToken();
  clearTimeout(MN.timer);
  if (!t) return mentionHide();
  const queryKey = (t.trigger || '@') + t.q;
  if (queryKey === MN.q) return;
  MN.q = queryKey;
  MN.timer = setTimeout(() => mentionAsk({ q: t.q }), 220);
  if ($('mentionBox').hidden) { $('mentionBox').innerHTML = '<div class="mnHint">加载中…</div>'; $('mentionBox').hidden = false; }
}
text.addEventListener('input', mentionUpdate);
text.addEventListener('blur', () => setTimeout(mentionHide, 200));
$('mentionBox').addEventListener('pointerdown', e => e.preventDefault());
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
  stickOnKeyboard = nearBottom();
  fitViewport();
  setTimeout(fitViewport, 60);
  setTimeout(fitViewport, 320);
});
text.addEventListener('blur', () => {
  stickOnKeyboard = false;
  setTimeout(fitViewport, 60);
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
  $('stop').hidden = mode !== 'chat' || !chatBusy || !!lastChat?.readonly;
  const split = devinBusySplit();
  const follow = codexFollow();
  const label = split || follow === 'queue' ? '排队' : follow === 'steer' ? '立即追加' : '发送';
  if ($('send').textContent !== label) $('send').textContent = label;
  $('sendNow').hidden = !split && !follow;
  $('sendNow').textContent = follow === 'steer' ? '改为排队' : '立即追加';
  if (split) $('sendNow').textContent = '立即发送';
  document.body.classList.toggle('split', split || !!follow);
}
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
  const v = text.value;
  if (currentApp === 'fusion' && lastChat?.fusion?.busy) return status('Fusion 正在进行');
  if (!v.trim() && !$('attachments').children.length) return;
  saveDraft();
  const follow = codexFollow();
  const when = devinBusySplit() || follow === 'queue' ? 'queue' : follow === 'steer' ? 'now' : '';
  const receipt = sendReceipt(v);
  if (mode === 'chat') status('正在发送…');
  if (mode === 'terminal') send({ t: 'termSend', text: v, ...receipt });
  else send({ t: 'send', text: v, submit: true, ...receipt, ...(when ? { when } : {}), ...mentionsFor(v) });
  if (mode === 'chat') list.scrollTop = list.scrollHeight;
};
$('sendNow').onclick = async () => {
  const v = text.value;
  if (!v.trim() && !$('attachments').children.length) return;
  saveDraft();
  const follow = codexFollow();
  const steer = !follow || follow === 'queue';
  if (!await ask(steer ? '立即追加到当前任务？' : '改为排队，等当前任务结束后再发送？', steer ? '立即追加' : '排队')) return;
  status('正在发送…');
  send({ t: 'send', text: v, submit: true, ...sendReceipt(v), when: steer ? 'now' : 'queue', ...mentionsFor(v) });
  if (currentApp !== 'codex') { text.value = ''; autosize(); }
  list.scrollTop = list.scrollHeight;
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
document.querySelectorAll('[data-termkey]').forEach(b => b.onclick = () => send({ t: 'key', key: b.dataset.termkey, focus: 'terminal' }));

