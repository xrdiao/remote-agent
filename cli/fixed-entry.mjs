// Shared personal Pages setup. Discovery is read-only; creation requires an explicit answer.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, readConfig, normalizeAppUrl } from '../lib/auth.mjs';
import { appFiles, putFile, remoteShas, gitBlobSha, run } from '../server/publish/pages.mjs';
import { APP_DIR } from '../server/config.mjs';
import { findBin } from '../lib/platform.mjs';

const api = async endpoint => JSON.parse(await run('gh', ['api', endpoint]));
async function optionalApi(endpoint) {
  try { return await api(endpoint); }
  catch (error) { if (/404|Not Found/i.test(error.message)) return null; throw error; }
}
async function entryFor(repo, { inspectApp = false } = {}) {
  const meta = await optionalApi(`repos/${repo}`);
  if (!meta) return null;
  if (!meta.permissions?.push) throw new Error(`当前 GitHub 账号没有 ${repo} 的发布权限`);
  const pages = await optionalApi(`repos/${repo}/pages`);
  const url = normalizeAppUrl(pages?.html_url);
  if (!url || !pages.source?.branch || pages.source.path !== '/') return null;
  if (inspectApp) {
    const index = await optionalApi(`repos/${repo}/contents/index.html?ref=${encodeURIComponent(pages.source.branch)}`);
    const html = Buffer.from(index?.content || '', 'base64').toString('utf8');
    if (!html.includes('js/core.js') || !html.includes('js/gate.js')) return null;
  }
  return { publishRepo: repo, pagesBranch: pages.source.branch, appUrl: url };
}
export async function discoverFixedEntry(config = readConfig()) {
  if (config.publishRepo) {
    const entry = await entryFor(config.publishRepo);
    if (!entry) throw new Error(`已配置 ${config.publishRepo}，但其固定入口尚未启用，请检查 GitHub Pages 设置`);
    return entry;
  }
  const login = (await api('user')).login;
  const repos = await run('gh', ['api', '--paginate', 'user/repos?per_page=100&affiliation=owner', '--jq',
    `.[] | select(.has_pages == true and .owner.login == "${login}") | .full_name`]);
  for (const repo of repos.split('\n').filter(Boolean)) {
    const entry = await entryFor(repo, { inspectApp: true });
    if (entry) return entry;
  }
  return null;
}
function saveEntry(entry) {
  const config = readConfig();
  if (Object.entries(entry).every(([key, value]) => config[key] === value)) return;
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(DATA_DIR, 'config.json'), JSON.stringify({ ...config, ...entry }, null, 2) + '\n', { mode: 0o600 });
}
export async function ensureFixedEntry({ ask, interactive }) {
  try { await run('gh', ['--version']); }
  catch { throw new Error('个人固定入口需要 GitHub CLI：Ubuntu 执行 sudo apt install gh，然后重新运行'); }
  try { await run('gh', ['auth', 'status']); }
  catch {
    console.log('需要登录自己的 GitHub 账号，以检查并更新个人固定入口。');
    if (interactive(findBin('gh'), ['auth', 'login']).status !== 0) throw new Error('GitHub 登录未完成，请运行 gh auth login 后重试');
  }
  console.log('正在检查已有的个人固定入口…');
  const existing = await discoverFixedEntry();
  if (existing) {
    saveEntry(existing);
    console.log(`沿用个人固定入口：${existing.appUrl}`);
    return existing;
  }
  if (!/^y/i.test(await ask('没有找到个人固定入口。要在自己的 GitHub 上创建吗？(y/n)', 'y'))) {
    console.log('本次使用临时隧道入口；以后可重新运行设置固定入口。');
    return null;
  }
  const login = (await api('user')).login;
  const name = await ask('个人入口仓库名', 'remote-agent');
  if (!/^[\w.-]+$/.test(name)) throw new Error('仓库名只能包含字母、数字、下划线、点和连字符');
  const repo = `${login}/${name}`;
  let meta = await optionalApi(`repos/${repo}`);
  if (meta) {
    const entry = await entryFor(repo, { inspectApp: true });
    if (entry) { saveEntry(entry); console.log(`沿用个人固定入口：${entry.appUrl}`); return entry; }
    throw new Error(`${repo} 已存在且不是可复用的 Remote Agent 入口，请重试并选择另一个仓库名`);
  }
  await run('gh', ['repo', 'create', repo, '--public', '--description', 'My Remote Agent phone app']);
  meta = await api(`repos/${repo}`);
  const remote = await remoteShas(repo, '');
  for (const file of appFiles()) {
    const data = fs.readFileSync(path.join(APP_DIR, file));
    if (remote.get(file) !== gitBlobSha(data)) await putFile(file, data, remote.get(file), repo, '');
  }
  await run('gh', ['api', '-X', 'POST', `repos/${repo}/pages`, '-f', `source[branch]=${meta.default_branch}`, '-f', 'source[path]=/']);
  const entry = await entryFor(repo);
  if (!entry) throw new Error('Pages 已请求创建，地址尚未就绪，请稍后重新运行');
  saveEntry(entry);
  console.log(`个人固定入口：${entry.appUrl}`);
  return entry;
}
