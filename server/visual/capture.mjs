import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn, execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {DATA_DIR} from '../../lib/auth.mjs';

const run = promisify(execFile);
const dir = path.dirname(fileURLToPath(import.meta.url));
const stateFile = path.join(DATA_DIR, 'visual.json');
const plotting = /python|figure|matplotlib|isaac|omniverse|mujoco|gazebo|rviz|pybullet|vtk|plot|simulate|simulation|open3d|仿真|绘图/i;
const editor = /(?:visual studio code|cursor|devin|codex)/i;
export const wayland = process.platform === 'linux' && (process.env.XDG_SESSION_TYPE === 'wayland' || !!process.env.WAYLAND_DISPLAY);
function saved() { return fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : {}; }
function save(value) { fs.writeFileSync(stateFile, JSON.stringify(value), {mode: 0o600}); }

export async function visualWindows() {
  if (wayland) return [];
  let text;
  if (process.platform === 'win32') {
    const script = fs.readFileSync(path.join(dir, 'windows.ps1'), 'utf8');
    text = (await run('powershell.exe', ['-NoProfile', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')])).stdout;
  } else if (process.platform === 'linux') {
    text = (await run('/usr/bin/python3', [path.join(dir, 'linux.py'), 'list'])).stdout;
  } else throw new Error('绘图与仿真窗口查看目前支持 Windows 和 Linux');
  return JSON.parse(text.trim() || '[]').filter(w => plotting.test(`${w.title} ${w.process} ${w.class || ''}`) && !editor.test(`${w.title} ${w.process} ${w.class || ''}`));
}

function jpegSize(buf) {
  for (let i = 2; i + 8 < buf.length;) {
    if (buf[i] !== 255) break;
    const marker = buf[i + 1];
    if ([192, 193, 194].includes(marker)) return {h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7)};
    i += 2 + buf.readUInt16BE(i + 2);
  }
  throw new Error('无法读取窗口画面尺寸');
}

class VisualCapture {
  viewers = new Set();
  state = {state: 'idle', title: '', message: '请选择绘图或仿真窗口'};
  frame = null;
  child = null;
  subscribe(session) { this.viewers.add(session); this.publish(session); }
  unsubscribe(session) { this.viewers.delete(session); if (!this.viewers.size) this.stop(); }
  publish(session) {
    session.emit({t: 'visual', ...this.state, wayland});
    if (this.frame && this.state.state === 'live') session.emit({t: 'frame', ...this.frame, visual: true});
  }
  update(state) { this.state = {...this.state, ...state}; for (const viewer of this.viewers) viewer.emit({t: 'visual', ...this.state, wayland}); }
  sendFrame(frame) {
    this.frame = frame;
    for (const viewer of this.viewers) if (viewer.visible && viewer.client.bufferedAmount < 2 * 1024 * 1024) viewer.emit({t: 'frame', ...frame, visual: true});
  }
  stop() { const child = this.child; this.child = null; child?.kill(); this.frame = null; this.state = {...this.state, state: 'idle'}; }
  async restore() {
    if (this.child) return;
    const value = saved();
    if (wayland && value.restoreToken) return this.start('restore');
    if (!wayland && value.id && (await visualWindows()).some(w => w.id === value.id)) return this.start(value.id);
  }
  async start(id) {
    let target;
    if (!wayland) {
      target = (await visualWindows()).find(w => w.id === id);
      if (!target) throw new Error('绘图或仿真窗口已关闭，请重新选择');
    }
    this.stop();
    this.update({state: wayland ? 'permission' : 'starting', title: target?.title || '', message: wayland ? '需要在电脑端选择并授权绘图或仿真窗口' : '正在读取窗口画面…'});
    const args = wayland ? [path.join(dir, 'linux.py'), 'capture', stateFile, id === 'restore' ? 'restore' : 'select']
      : ['-hide_banner', '-loglevel', 'error', '-f', process.platform === 'win32' ? 'gdigrab' : 'x11grab', '-framerate', '8', ...(process.platform === 'linux' ? ['-window_id', target.id] : []), '-i', process.platform === 'win32' ? `hwnd=${target.id}` : process.env.DISPLAY,
        '-an', '-vf', "scale='min(1280,iw)':-2", '-c:v', 'mjpeg', '-q:v', '5', '-threads', '1', '-f', 'image2pipe', 'pipe:1'];
    const child = spawn(wayland ? '/usr/bin/python3' : 'ffmpeg', args, {stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true});
    this.child = child;
    if (!wayland) save({...saved(), id: target.id});
    let buffer = Buffer.alloc(0), error = '';
    child.stderr.on('data', chunk => { error = (error + chunk.toString()).slice(-2000); });
    child.on('error', e => { if (this.child === child) this.update({state: 'error', message: `窗口捕获工具启动失败：${e.message}`}); });
    child.on('close', () => {
      if (this.child !== child) return;
      this.child = null; this.frame = null;
      this.update({state: this.state.state === 'permission' ? 'permission' : 'error', message: error || this.state.message || '窗口共享已结束，请重新选择'});
    });
    child.stdout.on('data', chunk => {
      if (this.child !== child) return;
      try {
      buffer = Buffer.concat([buffer, chunk]);
      if (wayland) {
        let end;
        while ((end = buffer.indexOf(10)) >= 0) {
          const line = buffer.subarray(0, end).toString(); buffer = buffer.subarray(end + 1);
          const value = JSON.parse(line);
          if (value.frame) this.sendFrame({data: value.frame, w: value.w, h: value.h});
          else this.update(value);
        }
      } else {
        let end;
        while ((end = buffer.indexOf(Buffer.from([255, 217]))) >= 0) {
          const jpeg = buffer.subarray(0, end + 2); buffer = buffer.subarray(end + 2);
          if (this.state.state !== 'live') this.update({state: 'live', message: ''});
          this.sendFrame({data: jpeg.toString('base64'), ...jpegSize(jpeg)});
        }
      }
      } catch (e) {
        this.stop();
        this.update({state: 'error', message: '窗口画面读取失败：' + e.message});
      }
    });
  }
}
export const visualCapture = new VisualCapture();
