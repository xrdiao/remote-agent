/* Local streaming dictation. Audio has its own socket and never enters the Agent queue. */
let voiceSession = null, voiceLink = null, voiceAudio = null, voicePrepared = '';
function voiceEnabled() { return store.get('local-voice') === 'on'; }
function voiceTransportKey() { return [base, store.get('token')].join('|'); }
function updateVoiceButton() {
  const visible = voiceEnabled() && mode === 'chat' && !chatBusy && !lastChat?.readonly;
  $('mic').hidden = !visible;
  $('mic').disabled = !windowReady;
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
  socket.onopen = () => socket.send(JSON.stringify({ type: 'auth', token: store.get('token') }));
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
    const link = session.link = voiceConnection();
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
  if (voiceEnabled()) { store.set('local-voice', null); cancelVoice(); updateVoiceButton(); return showMainMenu(); }
  store.set('local-voice', 'on'); updateVoiceButton(); showMainMenu();
  try {
    const response = await api('/api/voice');
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    if (!voiceEnabled()) return;
    if (!result.installed) {
      return openSheet('local-voice-setup', '<h3>安装本机语音</h3><p>在电脑上的 Remote Agent 目录运行：</p><pre>npm run voice:setup</pre><p class="hint">程序会询问是否同意安装 CPU 识别环境和下载约 615 MB 中英混说模型。安装完成后再次按住麦克风即可；语音只发送到你配对的电脑。</p><p class="hint">麦克风需要 HTTPS 和浏览器授权。微信等容器无法使用时，请用 Safari/Chrome 或键盘语音输入。</p>');
    }
    status(result.ready ? '正在准备语音连接…' : '正在预热本机语音模型…');
    await Promise.all([voiceConnection().ready, prepareVoiceAudio().module]);
    if (voiceEnabled() && !voiceSession) status('本机语音已就绪，按住输入框右侧麦克风说话');
  } catch (error) { status(error.message, false); }
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
for (const id of ['send', 'sendNow']) $(id).addEventListener('click', cancelVoice, true);
function suspendVoice() { cancelVoice(); closeVoiceConnection(); closeVoiceAudio(); voicePrepared = ''; }
document.addEventListener('visibilitychange', () => { if (document.hidden) suspendVoice(); else updateVoiceButton(); });
window.addEventListener('pagehide', suspendVoice);
updateVoiceButton();
