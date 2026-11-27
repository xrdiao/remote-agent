import { createHash } from 'node:crypto';
import { awaitCdpRead, cdpRead } from '../../cdp.mjs';
import { appPlans } from '../../agent/primitives.mjs';
import { codexAccountKey, codexBackend } from '../../codex/state.mjs';
import { nativeTargets, nativeWindowAt } from '../../native-windows.mjs';
import { helpersCall } from '../../page/build.mjs';

export const accountPlan = value => {
  const plan = value?.account?.planType || '';
  return plan.charAt(0).toUpperCase() + plan.slice(1);
};
export const accountStamp = value => value?.account ? createHash('sha256').update(codexAccountKey(value)).digest('hex') : '';

export function desktopCodexSource(preferred) {
  const targets = nativeTargets().filter(win => win.app === 'codex');
  const target = targets.find(win => (win.pageId || win.id) === preferred) || targets[0];
  return target && nativeWindowAt(target.ws);
}

async function desktopCodexAccount(preferred) {
  const source = desktopCodexSource(preferred);
  if (!source) return null;
  await source.connect();
  const account = await source.cdp.evaluate(helpersCall('refreshCodexUsage(false, true)'), { timeout: 8500 });
  if (!account) throw new Error('Codex 窗口仍在读取账号，请稍后重试');
  return account;
}

export async function ensureBackendAccount(s) {
  const expected = await desktopCodexAccount(s.codexAccountWindowId);
  const account = await codexBackend.alignAccount(expected);
  if (!account.account && account.requiresOpenaiAuth) throw new Error('请先在电脑端登录 Codex');
  return account;
}

export function codexAccountMetadata(value) {
  return { account: accountStamp(value), plan: accountPlan(value) };
}

export const chatGptAccountIdentified = account => account?.account?.type === 'chatgpt' && account.userId
  && account.workspaceRouting?.chatgptAccountId;
export const sameChatGptAccount = (a, b) => chatGptAccountIdentified(a) && codexAccountKey(a) === codexAccountKey(b);

async function codexUsageData(readAccount, readLimits, publish = () => {}, accountChanged = () => false) {
  const account = await readAccount();
  if (!account) throw new Error('Codex 账号尚未加载');
  const metadata = codexAccountMetadata(account);
  if (account.account?.type !== 'chatgpt') {
    publish(metadata);
    return { ...metadata, missing: true, detail: '当前账号未提供 ChatGPT 额度', limits: [], quota: [] };
  }
  cdpRead.getStore()?.throwIfAborted();
  const result = await readLimits();
  if (!result) throw new Error('Codex 未返回额度');
  const workspace = account.workspaceRouting?.chatgptAccountId;
  if (result.accountId && !workspace) throw new Error('无法确认 Codex 额度与当前工作区一致');
  const conflict = result.accountId && workspace && result.accountId !== workspace;
  if (conflict || accountChanged()) {
    const current = await readAccount();
    if (codexAccountKey(current) !== codexAccountKey(account)) {
      publish(codexAccountMetadata(current));
      throw new Error('Codex 账号已切换，请重新读取额度');
    }
    if (conflict) throw new Error('Codex 返回的额度属于其他账号');
  }
  const snapshot = result.rateLimitsByLimitId?.codex || result.rateLimits;
  const limits = [snapshot?.primary, snapshot?.secondary].filter(row => Number.isFinite(row?.usedPercent)).map(row => ({
    label: row.windowDurationMins === 10080 ? '每周限制' : row.windowDurationMins === 300 ? '5 小时限制' : '额度限制',
    kind: 'limit', basis: 'remaining', pct: 100 - row.usedPercent,
    reset: row.resetsAt ? new Date(row.resetsAt * 1000).toLocaleString('zh-CN') : '',
  }));
  publish(metadata);
  return { ...metadata, updated: Date.now(), missing: !limits.length, limits, quota: [],
    ...(!limits.length ? { detail: 'Codex 未返回可用的额度周期' } : {}) };
}

export function backendCodexUsage(publish, expectedAccount, observeAccount) {
  let generation, revision;
  const readAccount = async () => {
    const account = await awaitCdpRead(codexBackend.account());
    if (expectedAccount && !sameChatGptAccount(account, expectedAccount))
      throw new Error('Codex 后台与桌面账号不一致');
    observeAccount?.(account);
    return account;
  };
  return codexUsageData(readAccount, () => {
    generation = codexBackend.client.generation;
    revision = codexBackend.accountRevision;
    return awaitCdpRead(codexBackend.client.request('account/rateLimits/read', {}));
  }, publish, () => {
    if (!codexBackend.client.ready || codexBackend.client.generation !== generation) throw new Error('Codex 后台额度连接已变化');
    return codexBackend.accountRevision !== revision;
  });
}

export function publishCodexAccount(session, metadata) {
  if (session.codexAccount?.account !== metadata.account) session.codexModelCatalog = null;
  session.codexAccount = metadata;
  appPlans.codex = metadata.plan;
  session.emit({ t: 'codexAccount', sel: session.selectionKey(), ...metadata });
}

export function readCodexUsage(cdp, publish, expectedAccount) {
  return (async () => {
    const snapshot = await cdp.evaluate(helpersCall('refreshCodexUsage("snapshot", true)'), { timeout: 30000 });
    if (!snapshot) throw new Error('Codex 账号尚未加载或已切换');
    let first = true;
    return codexUsageData(async () => {
      const account = first ? snapshot.account
        : await cdp.evaluate(helpersCall('refreshCodexUsage(false)'), { timeout: 8500 });
      first = false;
      if (expectedAccount && !sameChatGptAccount(account, expectedAccount))
        throw new Error('Codex 桌面与后台账号不一致');
      return account;
    }, () => {
      if (snapshot.failed) throw new Error('Codex 桌面额度 RPC 请求失败');
      return snapshot.limits;
    }, publish, () => snapshot.changed);
  })();
}
