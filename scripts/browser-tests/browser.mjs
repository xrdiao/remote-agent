import fs from 'node:fs/promises';
import { Cdp } from '../../server/cdp.mjs';

export class Unavailable extends Error {}
export const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

// Actions use the rendered DOM and CDP input. Application globals are read only.
export class Browser {
  constructor(cdp, directory, timeout = 15000) {
    this.cdp = cdp; this.directory = directory; this.timeout = timeout;
    this.events = []; this.requests = new Map(); this.steps = [];
  }
  static async connect(port, targetId, directory, timeout) {
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const target = targets.find(row => row.id === targetId);
    if (!target) throw new Error('既有配对浏览器标签已关闭');
    const cdp = new Cdp(target.webSocketDebuggerUrl); await cdp.connect();
    const browser = new Browser(cdp, directory, timeout);
    cdp.on('Runtime.exceptionThrown', event => browser.events.push({ type: 'exception', at: Date.now(),
      message: event.exceptionDetails.exception?.description || event.exceptionDetails.text }));
    cdp.on('Network.requestWillBeSent', event => {
      const url = new URL(event.request.url);
      browser.requests.set(event.requestId, { path: url.pathname, type: event.type, started: event.timestamp });
    });
    cdp.on('Network.loadingFinished', event => {
      const request = browser.requests.get(event.requestId);
      if (request) browser.events.push({ type: 'request', ...request, bytes: event.encodedDataLength,
        durationMs: Math.round((event.timestamp - request.started) * 1000) });
      browser.requests.delete(event.requestId);
    });
    cdp.on('Network.loadingFailed', event => {
      const request = browser.requests.get(event.requestId);
      browser.events.push({ type: 'network-error', path: request?.path, cancelled: !!event.canceled, message: event.errorText });
      browser.requests.delete(event.requestId);
    });
    cdp.on('Network.webSocketFrameReceived', event => {
      if (event.response.opcode !== 1) return;
      let message;
      try { message = JSON.parse(event.response.payloadData); } catch { return; }
      if (message.t === 'draftAck') browser.events.push({ type: 'draft-ack', at: Date.now(),
        sel: message.sel, epoch: message.draftEpoch, revision: message.revision, ok: message.ok });
    });
    await cdp.send('Runtime.enable'); await cdp.send('Network.enable'); await cdp.send('Page.enable');
    if (process.platform === 'win32') await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    return browser;
  }
  read(expression) { return this.cdp.evaluate(expression); }
  async wait(expression, label, timeout = this.timeout, failure) {
    const deadline = Date.now() + timeout;
    do {
      const error = failure?.();
      if (error) throw error;
      const value = await this.read(expression);
      if (value) return value;
      await pause(100);
    } while (Date.now() < deadline);
    throw new Error(`${label}超时（${timeout}ms）`);
  }
  async has(selector) {
    return this.read(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});return !!e&&e.getClientRects().length>0&&getComputedStyle(e).visibility!=='hidden'})()`);
  }
  async position(selector, options = {}) {
    const closed = await this.read(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}),out=[];for(let p=e?.parentElement;p;p=p.parentElement)if(p.tagName==='DETAILS'&&!p.open&&!p.querySelector(':scope>summary')?.contains(e)){const parts=[];for(let n=p;n&&n!==document.body;n=n.parentElement)parts.unshift(n.tagName.toLowerCase()+':nth-child('+([...n.parentElement.children].indexOf(n)+1)+')');out.unshift('body>'+parts.join('>')+'>summary')}return out})()`);
    for (const summary of closed) await this.click(summary);
    await this.wait(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});return !!e&&e.getClientRects().length>0})()`, `控件 ${selector}`);
    const point = await this.wait(`(async()=>{const e=document.querySelector(${JSON.stringify(selector)});
      if(!e||e.disabled||e.getAttribute('aria-disabled')==='true')return null;
      e.scrollIntoView({block:'nearest',inline:'nearest'});await new Promise(requestAnimationFrame);
      const r=e.getBoundingClientRect(),left=Math.max(0,r.left),right=Math.min(innerWidth,r.right),top=Math.max(0,r.top),bottom=Math.min(innerHeight,r.bottom);
      const points=${options.edge ? '[{x:left+2,y:top+2}]' : '[.5,.85,.15].flatMap(fy=>[.5,.85,.15].map(fx=>({x:left+(right-left)*fx,y:top+(bottom-top)*fy})))'};
      const point=points.find(p=>e.contains(document.elementFromPoint(p.x,p.y)));
      return point||null})()`, `控件可点击 ${selector}`);
    return point;
  }
  async settled() {
    await this.read('(async()=>{await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame);return true})()');
    await this.wait(`!document.getAnimations().some(a=>a.playState==='running'&&Number.isFinite(a.effect?.getComputedTiming().endTime))`, '页面过渡结束');
  }
  async click(selector, options = {}) {
    const point = await this.position(selector, options);
    this.steps.push({ action: 'click', selector });
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased'])
      await this.cdp.send('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 });
    await this.settled();
  }
  async key(key, modifiers = 0) {
    const codes = { Enter: ['Enter', 13], Escape: ['Escape', 27], Backspace: ['Backspace', 8], Tab: ['Tab', 9], ArrowUp: ['ArrowUp', 38], ArrowDown: ['ArrowDown', 40] };
    const [code, vk] = codes[key] || ['Key' + key.toUpperCase(), key.toUpperCase().charCodeAt(0)];
    for (const type of ['rawKeyDown', 'keyUp']) await this.cdp.send('Input.dispatchKeyEvent',
      { type, key, code, windowsVirtualKeyCode: vk, modifiers });
  }
  async hold(selector) {
    const point = await this.position(selector);
    this.steps.push({ action: 'hold', selector });
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
    await pause(800);
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
    await this.settled();
  }
  async dialog(value, action) {
    let resolve, reject;
    const answered = new Promise((yes, no) => { resolve = yes; reject = no; });
    const timer = setTimeout(() => reject(new Error('原生确认框未出现')), this.timeout);
    this.cdp.on('Page.javascriptDialogOpening', () => {
      this.cdp.send('Page.handleJavaScriptDialog', { accept: value !== false, promptText: typeof value === 'string' ? value : '' }).then(resolve, reject);
    });
    try { await Promise.all([action(), answered]); }
    finally { clearTimeout(timer); this.cdp.handlers.delete('Page.javascriptDialogOpening'); }
  }
  async fill(selector, value) {
    await this.click(selector); await this.key('a', 2);
    if (value) await this.cdp.send('Input.insertText', { text: value }); else await this.key('Backspace');
    this.steps.push({ action: 'fill', selector, length: value.length });
  }
  async select(selector, value) {
    await this.read(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('选择框不存在');
      if(![...e.options].some(o=>o.value===${JSON.stringify(value)}&&!o.disabled))throw Error('原生候选不存在');
      e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('change',{bubbles:true}));return true})()`);
    this.steps.push({ action: 'select', selector });
  }
  async files(selector, paths) {
    const { root } = await this.cdp.send('DOM.getDocument');
    const { nodeId } = await this.cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector });
    if (!nodeId) throw new Error(`文件输入不存在: ${selector}`);
    await this.cdp.send('DOM.setFileInputFiles', { nodeId, files: paths });
    this.steps.push({ action: 'upload', selector, count: paths.length });
  }
  async dismiss() {
    const unexpected = [];
    if (await this.has('#askNo')) { unexpected.push('confirmation'); await this.click('#askNo'); }
    if (await this.has('#sheet.open')) await this.click('#shade', { edge: true });
    if (await this.has('#viewer.open #vClose')) { unexpected.push('file-preview'); await this.click('#vClose'); }
    if (await this.has('[data-ov="batch-exit"]')) { unexpected.push('batch-selection'); await this.click('[data-ov="batch-exit"]'); }
    return unexpected;
  }
  async home() {
    await this.dismiss();
    if (await this.read("document.body.classList.contains('conv')")) {
      await this.click('#ovBack'); await this.wait("!document.body.classList.contains('conv')", '返回主页');
    }
  }
  async menu(action) {
    await this.dismiss();
    await this.click(await this.read("document.body.classList.contains('conv')") ? '#menuBtn' : '#ovMenu');
    if (action) await this.click(`#sheet [data-act="${action}"]`);
  }
  async viewport(width, height) {
    await this.cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    await this.wait(`innerWidth===${width}&&innerHeight===${height}`, '视口调整');
  }
  async snapshot() {
    return this.read(`({version:APP_VERSION,app:currentApp,computer:currentComputer()?.id,sel:viewSel,mode,
      ready:windowReady,thread:lastChat?.thread,project:currentProject,busy:!!lastChat?.busy,
      pending:pendingSends.size,draftLength:text.value.length,items:lastChat?.items?.length||0,
      notice:document.getElementById('msg').textContent,opening:ovOpening?{phase:ovOpening.phase,message:ovOpening.message}:null,
      conversation:document.body.classList.contains('conv'),sheet:sheetKind,width:innerWidth,height:innerHeight})`);
  }
  async screenshot(name) {
    // User transcripts and credentials are not evidence artifacts.
    await this.read(`(()=>{const e=document.createElement('style');e.id='raQaMask';e.textContent='#items,#text,#qnBar,.ov-last,.ov-q,#sheet input,#sheet textarea{visibility:hidden!important}';document.head.append(e);return true})()`);
    try {
      const result = await this.cdp.send('Page.captureScreenshot', { format: 'png' });
      await fs.writeFile(`${this.directory}/${name}.png`, Buffer.from(result.data, 'base64'));
      return name + '.png';
    } finally { await this.read("document.getElementById('raQaMask')?.remove();true"); }
  }
  close() { this.cdp.close(); }
}
