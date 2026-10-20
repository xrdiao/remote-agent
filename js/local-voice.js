/* Local streaming dictation. Audio has its own socket and never enters the Agent queue. */
let voiceSession = null, voiceLink = null, voiceAudio = null, voicePrepared = '', voiceCatalog = null;
let voiceInputUntil = 0, voiceInputTimer = null, voiceInputScope = '';
function voiceEnabled() { return store.get('local-voice') === 'on'; }
function voiceEngineKey() { return 'voice-engine:' + (currentComputer()?.id || base); }
function voiceEngine() { return store.get(voiceEngineKey()) || ''; }
function voiceTransportKey() { return [base, store.get('token'), voiceEngine()].join('|'); }
function voiceComposerActive() {
  return (voiceSession && voiceLive(voiceSession))
    || (document.activeElement === text && document.body.classList.contains('kb'))
    || (voiceInputScope === voiceScope() && Date.now() < voiceInputUntil);
}
function noteVoiceInput() {
  if (mode !== 'chat') return;
  voiceInputScope = voiceScope(); voiceInputUntil = Date.now() + 2000;
  clearTimeout(voiceInputTimer);
  voiceInputTimer = setTimeout(updateVoiceButton, 2000);
  updateVoiceButton();
}
function updateVoiceButton() {
  const visible = voiceEnabled() && mode === 'chat' && (!chatBusy || voiceComposerActive()) && !lastChat?.readonly;
  $('mic').hidden = !visible;
  $('mic').disabled = !windowReady;
  $('stop').hidden = mode !== 'chat' || !chatBusy || !!lastChat?.readonly || visible;
  if (!visible) cancelVoice();
  if (!voiceEnabled() || !windowReady) {
    voicePrepared = ''; closeVoiceConnection();
    if (!voiceEnabled()) closeVoiceAudio();
  } else if (mode === 'chat' && !document.hidden && voicePrepared !== voiceTransportKey()) {
    voicePrepared = voiceTransportKey();
    prepareVoiceAudio().module.catch(() => {});
    voiceConnection().ready.catch(() => {});
  }
}
function voiceScope() { return [currentComputer()?.id || '', viewSel, mode].join('|'); }
function voiceLive(session) { return voiceSession === session && session.scope === voiceScope(); }
function prepareVoiceAudio() {
  if (!voiceAudio) {
    const context = new AudioContext();
    context.suspend().catch(() => {});
    voiceAudio = { context, module: context.audioWorklet.addModule(new URL('js/voice-worklet.js?v=133', location.href)) };
  }
  return voiceAudio;
}
function closeVoiceAudio() {
  voiceAudio?.context.close().catch(() => {});
  voiceAudio = null;
}
function resetVoiceReady(link) {
  link.streamId = '';
  link.ready = new Promise((resolve, reject) => { link.resolve = resolve; link.reject = reject; });
  link.ready.catch(() => {});
}
function closeVoiceConnection() {
  const link = voiceLink;
  voiceLink = null;
  link?.socket.close();
}
function voiceConnection() {
  const key = voiceTransportKey();
  if (voiceLink?.key === key && voiceLink.socket.readyState < 2) return voiceLink;
  closeVoiceConnection();
  const socket = new WebSocket(base.replace(/^http/, 'ws') + '/voice');
  const link = voiceLink = { key, socket };
  resetVoiceReady(link);
  const engine = voiceEngine();
  socket.onopen = () => socket.send(JSON.stringify({ type: 'auth', token: store.get('token'), engine }));
  socket.onerror = () => link.reject(new Error('本机语音连接失败，请检查中继；微信内无法开麦时请用 Safari/Chrome'));
  socket.onclose = () => {
    if (voiceLink === link) voiceLink = null;
    link.reject(new Error('本机语音连接已关闭'));
    if (voiceSession?.link === link) { status('语音连接已断开，已识别文字保留在输入框', false); cancelVoice(); }
  };
  socket.onmessage = e => {
    const m = JSON.parse(e.data), session = voiceSession;
    if (m.type === 'loading' && session?.link === link) status('正在加载本机语音模型…');
    if (m.type === 'started') { link.streamId = m.id; link.resolve(link); }
    if (m.type === 'error') {
      link.reject(new Error(m.message));
      if (session?.link === link) { status(m.message, false); cancelVoice(); }
      socket.close();
    }
    if (!session || !voiceLive(session) || session.link !== link || m.id !== session.streamId) return;
    if (m.type === 'partial' || m.type === 'final') voiceText(session, m.text);
    if (m.type === 'final' && voiceLive(session)) { status(m.text ? '转录完成，可编辑后发送' : '没有识别到语音，请重试'); cancelVoice(false); }
  };
  return link;
}
function releaseVoiceMedia(session) {
  session.stream?.getTracks().forEach(track => track.stop());
  session.source?.disconnect(); session.node?.disconnect();
  session.context?.suspend().catch(() => {});
  session.stream = null; session.context = null;
}
function cancelVoice(notify = true) {
  const session = voiceSession;
  if (!session) return;
  voiceSession = null;
  clearTimeout(session.timer);
  releaseVoiceMedia(session);
  const link = session.link;
  if (session.streamId && link?.streamId === session.streamId) {
    resetVoiceReady(link);
    if (notify && link.socket.readyState === 1) link.socket.send(JSON.stringify({ type: 'cancel', id: session.streamId }));
  }
  $('mic').classList.remove('on'); $('mic').setAttribute('aria-label', '按住说话');
  updateVoiceButton();
}
function voiceText(session, value) {
  if (!voiceLive(session)) return;
  if (text.value !== session.expected) return cancelVoice();
  const inserted = value || session.selection || '';
  const separator = value && session.prefix && !/\s$/.test(session.prefix) && /^\w/.test(value) ? ' ' : '';
  text.value = session.prefix + separator + inserted + session.suffix;
  session.expected = text.value;
  text.setSelectionRange(session.prefix.length + separator.length + inserted.length, session.prefix.length + separator.length + inserted.length);
  session.writing = true;
  text.dispatchEvent(new Event('input', { bubbles: true }));
  session.writing = false;
}
async function startVoice(event) {
  if (event.button !== 0 || voiceSession || $('mic').hidden || !windowReady) return;
  event.preventDefault();
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) return status('麦克风需要 HTTPS；请使用 Safari/Chrome 打开固定入口，或使用键盘语音输入', false);
  const link = voiceConnection();
  if (!link.streamId) {
    status('语音模型正在准备，就绪后请重新按住麦克风…');
    const current = () => voiceEnabled() && link.key === voiceTransportKey() && (!voiceLink || voiceLink === link);
    try { await link.ready; if (current()) status('语音模型已就绪，请按住麦克风说话'); }
    catch (error) { if (current()) status(error.message, false); }
    return;
  }
  if (event.pointerId != null) $('mic').setPointerCapture(event.pointerId);
  const session = { scope: voiceScope(), expected: text.value, prefix: text.value.slice(0, text.selectionStart), suffix: text.value.slice(text.selectionEnd), selection: text.value.slice(text.selectionStart, text.selectionEnd), held: true };
  voiceSession = session;
  $('mic').classList.add('on'); $('mic').setAttribute('aria-label', '松开结束录音');
  status('正在连接本机语音并申请麦克风…');
  try {
    const audio = prepareVoiceAudio();
    session.context = audio.context;
    const resumed = session.context.resume();
    const media = navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }, video: false });
    media.then(stream => {
      if (voiceLive(session) && session.held) {
        session.stream = stream;
        if (session.started) status('正在准备录音…');
      } else stream.getTracks().forEach(track => track.stop());
    }, () => {});
    session.link = link;
    const started = link.ready.then(() => {
      if (!voiceLive(session) || !session.held) return;
      session.streamId = link.streamId; session.started = true;
      status(session.stream ? '正在准备录音…' : '等待麦克风授权…');
    });
    const [stream] = await Promise.all([media, started, resumed, audio.module]);
    if (!voiceLive(session) || !session.held) return;
    session.stream = stream;
    session.node = new AudioWorkletNode(session.context, 'voice-pcm', { channelCount: 1, channelCountMode: 'explicit' });
    session.source = session.context.createMediaStreamSource(stream);
    session.node.port.onmessage = e => {
      if (!voiceLive(session)) return;
      if (e.data === 'flushed') {
        releaseVoiceMedia(session);
        link.socket.send(JSON.stringify({ type: 'end' }));
        session.timer = setTimeout(() => { if (voiceLive(session)) { status('转录尚未完成，已识别文字已保留，请重试', false); cancelVoice(); } }, 20000);
      } else if (link.socket.readyState === 1) {
        if (link.socket.bufferedAmount > 128000) { status('语音网络跟不上，已识别文字已保留，请重试', false); cancelVoice(); }
        else link.socket.send(e.data);
      }
    };
    session.source.connect(session.node).connect(session.context.destination);
    status('正在听…松开结束，文字不会自动发送');
  } catch (error) {
    if (voiceLive(session)) { status(error.name === 'NotAllowedError' ? '没有麦克风权限；请在浏览器设置中允许，或使用键盘语音输入' : error.message, false); cancelVoice(); }
  }
}
function endVoice() {
  const session = voiceSession;
  if (!session?.held) return;
  session.held = false;
  $('mic').classList.remove('on'); $('mic').setAttribute('aria-label', '按住说话');
  if (!session.node) { cancelVoice(); status('录音尚未开始，请重新按住说话'); return; }
  session.stream.getTracks().forEach(track => track.stop());
  session.node.port.postMessage('flush');
  status('录音已结束，正在完成转录…');
}
async function toggleLocalVoice() {
  if (voiceEnabled()) { store.set('local-voice', null); cancelVoice(); updateVoiceButton(); return renderVoiceMenu(); }
  store.set('local-voice', 'on'); updateVoiceButton(); renderVoiceMenu();
  try {
    status('正在准备本机语音…');
    await Promise.all([voiceConnection().ready, prepareVoiceAudio().module]);
    if (voiceEnabled() && !voiceSession) status('本机语音已就绪，按住输入框右侧麦克风说话');
  } catch (error) { status(error.message, false); }
}
function renderVoiceMenu() {
  const engines = voiceCatalog?.key === voiceEngineKey() ? voiceCatalog.engines : [];
  const selected = voiceEngine() || engines[0]?.id;
  openSheet('local-voice', '<h3>语音输入</h3>'
    + `<button class="opt" data-act="localVoiceToggle" role="switch" aria-checked="${voiceEnabled()}"><span class="lbl">开启语音输入<span class="sub">按住说话，松开结束，不自动发送</span></span><span class="switch${voiceEnabled() ? ' on' : ''}" aria-hidden="true"></span></button>`
    + '<div class="pSec">语音识别引擎</div>'
    + engines.map(engine => `<button class="opt${engine.id === selected ? ' cur' : ''}" data-voice-engine="${esc(engine.id)}" role="radio" aria-checked="${engine.id === selected}" ${voiceSession ? 'disabled' : ''}><span class="lbl">${esc(engine.label)}<span class="sub">${esc(engine.detail)}</span></span>${engine.id === selected ? '<span class="tag">✓</span>' : ''}</button>`).join('')
    + (engines.length ? '' : '<p class="hint">电脑尚未安装语音引擎。</p>')
    + '<p class="hint">识别过程中请先松手，等转录完成后再切换引擎。语音仅发往配对电脑。</p><details><summary>安装语音引擎</summary><p class="hint">在电脑的 Remote Agent 目录运行，并按提示同意安装：</p><pre>npm run voice:setup</pre><p class="hint">Sherpa：CPU，中英混说，模型约 615 MB。</p><pre>npm run voice:setup -- --engine qwen</pre><p class="hint">Qwen3-ASR-1.7B：官方 vLLM 流式接口，需要 Linux / NVIDIA GPU；模型约 4 GB，运行依赖另计。安装后重新打开本列表即可。麦克风仍需 HTTPS 和浏览器授权。</p></details><button class="opt" data-act="voiceBack">← 返回菜单</button>');
}
async function showLocalVoiceMenu() {
  const key = voiceEngineKey(), target = base;
  openSheet('local-voice', '<h3>语音输入</h3><p class="hint">正在读取已安装引擎…</p>');
  try {
    const response = await api('/api/voice'), result = await response.json();
    if (!response.ok) throw new Error(result.error);
    if (sheetKind !== 'local-voice' || key !== voiceEngineKey() || target !== base) return;
    voiceCatalog = { key, engines: result.engines };
    renderVoiceMenu();
  } catch (error) {
    if (sheetKind === 'local-voice' && key === voiceEngineKey() && target === base) openSheet('local-voice', `<h3>语音输入</h3><p class="hint">${esc(error.message)}</p><button class="opt" data-act="localVoiceMenu">重新读取</button><button class="opt" data-act="voiceBack">← 返回菜单</button>`);
  }
}
async function selectVoiceEngine(id) {
  if (voiceSession) return status('请松手并等待本次转录完成后再切换引擎', false);
  if (voiceCatalog?.key !== voiceEngineKey() || !voiceCatalog.engines.some(engine => engine.id === id)) return;
  if (voiceEngine() === id) return;
  closeVoiceConnection(); voicePrepared = '';
  store.set(voiceEngineKey(), id);
  updateVoiceButton(); renderVoiceMenu();
  if (!voiceEnabled()) return;
  const link = voiceConnection();
  status('正在准备所选语音引擎…');
  try {
    await link.ready;
    if (voiceLink === link && voiceEnabled()) status('语音引擎已就绪，按住麦克风说话');
  } catch (error) { if (voiceLink === link) status(error.message, false); }
}
$('mic').addEventListener('pointerdown', startVoice);
$('mic').addEventListener('pointerup', endVoice);
function cancelVoiceGesture() { if (voiceSession) { cancelVoice(); status('录音已取消，已识别文字保留'); } }
$('mic').addEventListener('pointercancel', cancelVoiceGesture);
$('mic').addEventListener('lostpointercapture', () => { if (voiceSession?.held) cancelVoiceGesture(); });
$('mic').addEventListener('contextmenu', e => e.preventDefault());
$('mic').addEventListener('keydown', e => { if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) { e.preventDefault(); startVoice({ button: 0, preventDefault() {}, pointerId: null }); } });
$('mic').addEventListener('keyup', e => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); endVoice(); } });
text.addEventListener('input', () => { if (voiceSession && !voiceSession.writing) { cancelVoice(); status('录音已停止，可继续编辑'); } });
for (const event of ['focus', 'input']) text.addEventListener(event, noteVoiceInput);
text.addEventListener('blur', () => { if (!$('mic').hidden) noteVoiceInput(); });
window.visualViewport?.addEventListener('resize', updateVoiceButton);
window.addEventListener('resize', updateVoiceButton);
for (const id of ['send', 'sendNow']) $(id).addEventListener('click', cancelVoice, true);
function suspendVoice() { cancelVoice(); closeVoiceConnection(); closeVoiceAudio(); voicePrepared = ''; }
document.addEventListener('visibilitychange', () => { if (document.hidden) suspendVoice(); else updateVoiceButton(); });
window.addEventListener('pagehide', suspendVoice);
updateVoiceButton();
