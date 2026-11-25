/* Optimistic delivery and local SEND receipts. */
const pendingSends = new Map();
// Optimistic echoes: the sent message/queue row is drawn immediately, then dropped when the real item arrives in a chat update.
let pendingEchoes = [];
function echoTextMatches(it, t) {
  const s = (it.t || '').trim(), x = t.trim();
  return s === x || s.startsWith(x + '\n\n附加文件（')
    || RemoteAgentRules.withoutAttachmentLabels(s).trim() === x;
}
function echoInSelection(echo) { return echo.computer === (currentComputer()?.id || '') && echo.sel === viewSel; }
function pushEcho(requestId, text, kind) {
  const images = desktopAttachments.map(file => file.preview).filter(Boolean);
  pendingEchoes.push({ requestId, text, kind, images, at: Date.now(), sel: viewSel, computer: currentComputer()?.id || '' });
  queueChatRender();
}
function composerSendMatches(sent, value = text.value) {
  return sent.computer === (currentComputer()?.id || '')
    && sent.mode === mode && sent.draft === activeDraft && sent.version === (draftVersions.get(activeDraft) || 0)
    && sent.text === value && sent.mentions === JSON.stringify(mentionsFor(value))
    && desktopAttachments.every(file => sent.attachmentIds.includes(file.id));
}
function pendingComposerSend(value = text.value) {
  if (mode !== 'chat' || currentApp === 'fusion' || questionCompose?.sel === viewSel) return;
  return [...pendingSends.values()].find(sent => composerSendMatches(sent, value));
}
function updateComposerSendAvailability() {
  if (mode !== 'terminal') $('send').disabled = $('sendNow').disabled = !windowReady || !!pendingComposerSend();
}
function sendReceipt(value, terminal) {
  if (pendingComposerSend(value)) return null;
  const requestId = [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, '0')).join('');
  if (mode === 'chat') {
    clearTimeout(draftPushTimer);
    draftRevision++;
    pendingDesktopDraft = null;
    draftEpoch = requestId;
  }
  const targetThread = viewSel.split('|').pop() || '';
  const candidate = queuedChat?.sel === viewSel ? queuedChat.chat : lastChat;
  const latest = candidate?.thread === targetThread ? candidate : null;
  pendingSends.set(requestId, { requestId, terminal, state: 'pending', draft: activeDraft, text: value, computer: currentComputer()?.id || '', app: currentApp, mode, version: draftVersions.get(activeDraft) || 0, revision: inputRevision,
    mentions: JSON.stringify(mentionsFor(value)), attachmentIds: desktopAttachments.map(file => file.id),
    imageCount: currentApp === 'devin' ? desktopAttachments.filter(file => file.preview).length : 0,
    ...(mode === 'chat' ? { scope: messageScope(), thread: targetThread, before: new Set((latest?.items || []).filter(it => it.k === 'human').map(it => it.i)),
      beforeQueues: new Set((latest?.queued || []).map(it => it.id)), queuedSameText: (latest?.queued || []).filter(it => echoTextMatches(it, value)).length } : {}) });
  document.dispatchEvent(new Event('composer-state'));
  return { requestId, draft: activeDraft, draftEpoch };
}
function rememberSentInput(sent, receipt) {
  const thread = receipt.sel?.split('|').pop() || sent.thread || '';
  const key = [sent.computer, sent.app, thread].join('|');
  const rows = (sentInputCache.get(key) || []).filter(row => row.requestId !== sent.requestId);
  rows.push({ requestId: sent.requestId, ids: [...new Set([receipt.messageId, receipt.queueId].filter(Boolean))], text: sent.text });
  sentInputCache.set(key, rows.slice(-10));
}
function confirmSent(m, render = true, computer = currentComputer()?.id || '') {
  const sent = pendingSends.get(m.requestId);
  if (!sent || sent.computer !== computer) return;
  applyReceiptSelection(sent, m);
  const here = computer === (currentComputer()?.id || '') && mode === sent.mode && draftKey() === sent.draft;
  if (m.pending) {
    sent.state = m.message ? 'unknown' : 'pending';
    if (m.message) {
      sent.confirmationError = m.message;
      const echo = pendingEchoes.find(p => p.requestId === m.requestId);
      if (echo) echo.unknown = true;
      if (render && here) queueChatRender();
    }
    if (here) {
      if (m.message) status('发送结果未确认：' + m.message, false);
      else if (!sent.confirmationError && ['正在发送…', '正在确认电脑端接收…', '连接已断开，发送结果待确认'].includes(pendingStatus)) status('正在确认电脑端接收…');
    }
    return;
  }
  const echo = pendingEchoes.find(p => p.requestId === m.requestId);
  if (echo && m.hasUserMessage === false) {
    pendingEchoes = pendingEchoes.filter(row => row !== echo);
    if (render && here) queueChatRender();
  } else if (echo) {
    echo.confirmed = true;
    if (m.messageId) echo.messageId = m.messageId;
    if (m.queueId) echo.queueId = m.queueId;
    if (m.queued !== undefined) echo.kind = m.queued ? 'queue' : 'chat';
    if (render && here) queueChatRender();
  }
  sent.state = 'confirmed';
  pendingSends.delete(m.requestId);
  if (sent.mode === 'chat' && sent.app === 'codex' && (m.messageId || m.queueId)) rememberSentInput(sent, m);
  for (const key of inputHistory.keys()) if (key.startsWith(sent.draft + '|')) inputHistory.delete(key);
  const unchanged = sent.mode === 'chat' && currentApp !== 'fusion' ? composerSendMatches(sent)
    : (draftVersions.get(activeDraft) || 0) === sent.version && text.value === sent.text;
  if (computer === (currentComputer()?.id || '') && mode === 'chat' && sent.mode === 'chat'
      && (m.sel === viewSel || m.materializedFrom === viewSel) && m.consumedUploadIds?.length) {
    const consumed = new Set(m.consumedUploadIds);
    renderAttachments(desktopAttachments.filter(file => !consumed.has(file.id)));
  }
  if ((!here || unchanged) && drafts.get(sent.draft) === sent.text && (draftVersions.get(sent.draft) || 0) === sent.version) {
    drafts.delete(sent.draft); draftMentions.delete(sent.draft);
    if (sent.mode === 'chat') dirtyDrafts.add(sent.draft);
  }
  if (here && (['正在发送…', '正在确认电脑端接收…', '连接已断开，发送结果待确认'].includes(pendingStatus) || $('msg').textContent === '发送结果未确认：' + sent.confirmationError) && ![...pendingSends.values()].some(p => p.draft === activeDraft)) {
    status(m.queued ? m.message || 'Agent 正在运行，已加入排队，这一轮结束后自动发送' : '已发送');
  }
  if (here && unchanged) {
    if (sent.mode === 'chat') { draftRevision++; pendingDesktopDraft = null; }
    drafts.delete(activeDraft); draftMentions.delete(activeDraft);
    text.value = ''; MN.mentions = []; MN.value = ''; mentionHide(text); autosize(); mirroredDraft = '';
    if (sent.mode === 'chat') dirtyDrafts.add(activeDraft);
    else dirtyDrafts.delete(activeDraft);
    queueDraftSync();
  } else if (here && sent.mode === 'chat' && !unchanged) {
    draftRevision++; pendingDesktopDraft = null;
    dirtyDrafts.add(activeDraft); queueDraftSync();
  }
  if (sent.mode === 'chat') {
    submittedMessages.push({ ...sent, messageId: m.messageId, queueId: m.queueId, sentAt: m.sentAt || Date.now() });
    if (here && lastChat && render) queueChatRender();
  }
  document.dispatchEvent(new Event('composer-state'));
}
function receiveSendFailure(message, computer, report = !message.cancelled) {
  const sent = pendingSends.get(message.requestId);
  if (!sent || sent.computer !== computer) return;
  applyReceiptSelection(sent, message);
  failPendingSend(message.requestId, message.message || '发送失败，请重试', report, computer);
}
function failPendingSend(requestId, message = '发送失败，请重试', report = true, computer = currentComputer()?.id || '') {
  const sent = pendingSends.get(requestId);
  if (!sent || sent.computer !== computer) return;
  pendingSends.delete(requestId);
  const hadEcho = pendingEchoes.some(p => p.requestId === requestId && echoInSelection(p));
  pendingEchoes = pendingEchoes.filter(p => p.requestId !== requestId);
  if (hadEcho) queueChatRender();
  if ((currentComputer()?.id || '') === sent.computer && draftKey() === sent.draft) {
    if (text.value === '' && (draftVersions.get(activeDraft) || 0) === sent.version) { text.value = sent.text; autosize(); saveDraft(); }
    if (sent.mode === 'chat') queueDraftSync();
  }
  if (report && (currentComputer()?.id || '') === sent.computer && draftKey() === sent.draft) status(message, false);
  document.dispatchEvent(new Event('composer-state'));
}
function disconnectPendingSends(computer = currentComputer()?.id || '') {
  if (queueEditRequest?.computer === computer)
    receiveQueueEdit({ ...queueEditRequest, ok: false, error: '连接已断开，操作结果待确认，编辑内容已保留' }, computer);
  for (const sent of pendingSends.values()) {
    if (sent.computer !== computer) continue;
    sent.state = 'unknown';
    const echo = pendingEchoes.find(p => p.requestId === sent.requestId);
    if (echo) echo.unknown = true;
    if ((currentComputer()?.id || '') === sent.computer && draftKey() === sent.draft) status('连接已断开，发送结果待确认');
  }
  if (pendingEchoes.some(echoInSelection)) queueChatRender();
}
function reconcileSent(chat) {
  if (currentApp === 'codex' || currentApp === 'opencode') return;
  const matched = new Set(submittedMessages.filter(sent => sent.scope === messageScope() && (!sent.thread || sent.thread === chat.thread))
    .flatMap(sent => [sent.messageId, sent.queueId].filter(Boolean)));
  for (const [requestId, sent] of pendingSends) {
    if (sent.mode !== 'chat' || sent.scope !== messageScope() || (sent.thread && sent.thread !== chat.thread)) continue;
    const queued = (chat.queued || []).find(it => !sent.beforeQueues.has(it.id) && !matched.has(it.id)
      && (it.imageCount || 0) >= sent.imageCount && it.t?.trim() === sent.text.trim().slice(0, 4000));
    if (queued) { matched.add(queued.id); confirmSent({ requestId, queueId: queued.id, messageId: queued.messageId, sel: viewSel, queued: true }, false); continue; }
    if (sent.queuedSameText) continue;
    const item = chat.items.find(it => receiptMatchesHuman(it, sent) && !matched.has(it.i) && !it.nativeIds?.some(id => matched.has(id)) && !messageTimes.has(generationKey(chat) + '|' + it.i));
    if (item) { matched.add(item.i); confirmSent({ requestId, messageId: item.i, sel: viewSel, queued: false, sentAt: item.sentAt || Date.now() }, false); }
  }
}
function receiptMatchesHuman(it, receipt) {
  if (it.k !== 'human' || receipt.before.has(it.i) || (it.nativeIds || []).some(id => receipt.beforeQueues.has(id))) return false;
  if ((it.images?.length || 0) < (receipt.imageCount || 0)) return false;
  if (receipt.messageId) return it.i === receipt.messageId;
  if (receipt.queueId && it.nativeIds?.length) return it.nativeIds.includes(receipt.queueId);
  return echoTextMatches(it, receipt.text);
}
function receiveQueueDone(m) {
  receiveQueueEdit(m);
  if (!m.ok || m.sel !== viewSel || m.action === 'read') return;
  if (currentApp === 'codex' && m.action === 'edit') {
    const key = [currentComputer()?.id || '', currentApp, viewSel.split('|').pop() || ''].join('|');
    for (const row of sentInputCache.get(key) || []) if ((m.echoes || []).includes(row.requestId)) {
      row.text = m.text;
      row.ids = [...new Set([...row.ids, m.messageId, m.queueId].filter(Boolean))];
    }
  }
  const removed = new Set();
  for (const echo of pendingEchoes) {
    if (!echoInSelection(echo) || !(m.echoes || []).includes(echo.requestId)) continue;
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
function applyReceiptSelection(sent, message) {
  if (!sent || !message.materializedFrom || sent.app !== 'opencode') return;
  materializeComposerDraft(sent.computer, message.materializedFrom, message.sel);
}
function materializeComposerDraft(computer, from, to) {
  if (!from || !to || from === to) return;
  const previous = [computer, from, 'chat'].join('|'), next = [computer, to, 'chat'].join('|');
  if (drafts.get(next) || draftMentions.get(next)?.length || draftVersions.get(next)) return;
  const viewingPrevious = activeDraft === previous;
  const viewingNext = activeDraft === next;
  const moved = drafts.has(previous);
  if (moved) {
    drafts.set(next, drafts.get(previous));
    draftMentions.set(next, draftMentions.get(previous) || []);
    draftVersions.set(next, draftVersions.get(previous) || 0);
    drafts.delete(previous);
    draftMentions.delete(previous);
    draftVersions.delete(previous);
    if (dirtyDrafts.delete(previous)) dirtyDrafts.add(next);
  }
  for (const sent of pendingSends.values()) if (sent.draft === previous) {
    sent.draft = next;
    sent.thread = to.split('|').at(-1);
  }
  for (const echo of pendingEchoes) if (echo.computer === computer && echo.sel === from) echo.sel = to;
  if (viewingPrevious) activeDraft = next;
  if (viewingNext && moved && !text.value) restoreDraft();
}
