  const codexSubmitError = (requestId, message) => {
    (window.__remoteAgentSubmitErrors ||= []).push({ requestId, message });
    doc.defaultView.dispatchEvent(new doc.defaultView.Event('remote-agent-submit-error'));
  };
  const codexQueueConfirmRequests = () => {
    const thread = codexVisibleThread();
    if (!thread || remoteContext && remoteContext.threadId !== thread) return [];
    for (const dialog of [...doc.querySelectorAll('[role="dialog"]')].filter(vis)) {
      const props = codexFiberProps(dialog, Infinity).find(p => p.open === true
        && Number.isInteger(p.queuedMessageCount) && typeof p.onClearQueue === 'function'
        && typeof p.onSubmit === 'function' && typeof p.onOpenChange === 'function');
      if (!props) continue;
      const requestId = window.__remoteAgentCodexSubmitRequests?.get(thread) || '';
      const act = (action, cancel = false) => () => {
        window.__remoteAgentCodexSubmitRequests?.delete(thread);
        if (cancel && requestId) codexSubmitError(requestId, '已取消发送，内容已保留');
        return action();
      };
      return [{ id: 'queue-confirm:' + JSON.stringify([thread, requestId]), dialog,
        text: `旧队列因中断而暂停，共 ${props.queuedMessageCount} 条。发送本条消息时如何处理？`, fields: [],
        buttons: [
          { label: '保留队列并发送', action: act(props.onSubmit) },
          { label: '清空队列并发送', action: act(props.onClearQueue) },
          { label: '取消发送', action: act(() => props.onOpenChange(false), true) },
        ] }];
    }
    return [];
  };
  const codexDispatchReceiptKey = (thread, requestId) => 'remote-agent:codex-dispatch:' + JSON.stringify([thread, requestId]);
  const codexDispatchClientId = (thread, requestId) =>
    doc.defaultView.sessionStorage.getItem(codexDispatchReceiptKey(thread, requestId));
  const submitCodexMessage = async (follow = '', dispatch = false, requestId = '', expectedThread, trackClientId = false) => {
    const editor = codexPromptEl();
    const target = codexComposerProps(editor, expectedThread);
    const props = target?.find(p => typeof p.handleSubmit === 'function' && 'submitDisabled' in p);
    if (!props || props.submitDisabled || props.isInteractionBlocked || props.interactionsEnabled === false) return false;
    const thread = codexComposerThread(target) ?? expectedThread ?? codexThread();
    if (typeof props.conversationId === 'string' && props.conversationId !== thread) return false;
    let submit = props.handleSubmit;
    if (follow || trackClientId) {
      // The button handler receives a DOM event and fixes the primary action.
      // Its memoized native submit callback accepts explicit Queue/Steer.
      const callbacks = new Set();
      for (const fiber of codexFibers(editor)) for (const values of fiber.updateQueue?.memoCache?.data || [])
        for (let i = 1; i < values.length; i++) if (values[i] === props.handleSubmit && typeof values[i - 1] === 'function')
          callbacks.add(values[i - 1]);
      if (callbacks.size !== 1) return false;
      submit = [...callbacks][0];
    }
    if (dispatch) {
      if (target.find(p => p.composerController)?.composerController.getText() == null) return false;
      const submissions = window.__remoteAgentCodexSubmissions ||= new Set();
      const requests = window.__remoteAgentCodexSubmitRequests ||= new Map();
      const router = !thread && requestId && codexRootProps().find(p => typeof p.value?.router?.navigate === 'function')?.value.router;
      const location = router?.state?.location;
      const clear = () => { if (requests.get(thread) === requestId) requests.delete(thread); };
      if (requestId) requests.set(thread, requestId);
      const options = { ...(follow ? { followUpSubmitAction: follow } : {}), ...(requestId ? {
        ...(trackClientId ? { ownMessageTiming: {
          // Native binds its allocated message identity before dispatching.
          // The webview outlives the relay, including a relay restart while the ACK is pending.
          bind(clientId, threadId) {
            if (threadId !== thread || typeof clientId !== 'string' || !clientId)
              throw new Error('Codex 原生提交身份不一致');
            const key = codexDispatchReceiptKey(thread, requestId);
            const storage = doc.defaultView.sessionStorage;
            const previous = storage.getItem(key);
            if (previous && previous !== clientId) throw new Error('Codex 原生提交已绑定其他消息');
            storage.setItem(key, clientId);
            doc.defaultView.dispatchEvent(new doc.defaultView.Event('remote-agent-chat-update'));
          },
          cancel() {},
        } } : {}),
        onSubmitted: () => {
          const next = router?.state?.location, created = next?.state?.submittedThreadId;
          if (next !== location && typeof created === 'string'
              && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(created)
              && next.pathname?.split('/').at(-1) === created) {
            const first = window.__remoteAgentCodexFirstSubmissions ||= new Map();
            first.set(requestId, created);
            if (first.size > 16) first.delete(first.keys().next().value);
            doc.defaultView.dispatchEvent(new doc.defaultView.Event('remote-agent-first-submission'));
          }
          clear();
        },
        onNotSent: () => { clear(); codexSubmitError(requestId, 'Codex 未提交这条消息，内容已保留'); },
      } : {}) };
      const pending = Promise.resolve().then(() => submit(options)).catch(error => {
        clear(); codexSubmitError(requestId, String(error?.message || error));
      }).finally(() => submissions.delete(pending));
      submissions.add(pending);
      return true;
    }
    await submit(follow ? { followUpSubmitAction: follow } : undefined);
    return true;
  };
