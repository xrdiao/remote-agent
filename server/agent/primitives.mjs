import { DEVIN_COMPOSER_SRC, COMPOSER_TARGET_SRC } from '../page/build.mjs';

// Cursor's chat composer is a ProseMirror contenteditable; selectors ordered from most to least specific.
export const FOCUS_COMPOSER = `(() => {
  // Codex draws its prompt inside a same-origin iframe. Cursor and Devin use this page.
  const doc = document.getElementById('active-frame')?.contentDocument || document;
  ${DEVIN_COMPOSER_SRC}
  revealDevinComposer();
  ${COMPOSER_TARGET_SRC}
  const el = composerTarget(doc);
  if (!el) return null;
  el.focus();
  const range = doc.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  const sel = doc.defaultView.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  return true;
})()`;


export const cursorUsage = { data: null, initial: null };
export const appPlans = {};

const quotaName = app => ({ cursor: 'Cursor', devin: 'Devin', codex: 'Codex', fusion: 'Fusion' }[app] || app || 'Agent');

export function quotaState(usage) {
  const limits = (usage?.limits || []).map(limit => {
    const raw = limit?.pct;
    const pct = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() ? Number(raw) : NaN;
    return Number.isFinite(pct) ? { ...limit, pct } : null;
  }).filter(Boolean);
  if (!limits.length || usage?.missing) return { state: 'unknown', limits: [] };
  const exhausted = limits.filter(limit => limit.basis === 'remaining' ? limit.pct <= 0 : limit.pct >= 100);
  if (exhausted.length) return { state: 'exhausted', limits, exhausted };
  const warning = limits.filter(limit => limit.basis === 'remaining' ? limit.pct <= 1 : limit.pct >= 99);
  return { state: warning.length ? 'warning' : 'ok', limits, warning };
}

export function quotaBlockedMessage(app, usage) {
  const state = quotaState(usage);
  if (state.state !== 'exhausted') return '';
  const labels = state.exhausted.map(limit => limit.label).filter(Boolean).join('、');
  return `${quotaName(app)} ${labels || '账号额度'}已用尽，请等待额度重置、升级套餐或切换账号后重试。`;
}

export function quotaErrorMessage(app, error) {
  const raw = String(error?.message || error || '').trim();
  if (!raw) return '';
  const quota = /quota|rate[ _-]*limit|usage[ _-]*limit|usage quota|exhausted|too many requests/i.test(raw);
  const denied = /permission denied[\s\S]*internal server error/i.test(raw);
  if (!quota && !denied) return '';
  return `${quotaName(app)} 账号额度或频率限制，当前请求未发送成功。请等待额度重置、升级套餐或切换账号后重试。`;
}

export async function tapCss(cdp, x, y, button = 'left') {
  const base = { x, y, button, clickCount: 1 };
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base });
}
