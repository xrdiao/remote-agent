import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readState } from '../lib/auth.mjs';
import { relayAutostart as posixAutostart } from '../lib/platform/posix.mjs';
import { relayAutostart as windowsAutostart } from '../lib/platform/windows.mjs';
import { PORT, TUNNEL, PUBLISH_REPO } from './config.mjs';
import { findTunnelPid } from './publish/tunnel.mjs';

const cwd = fileURLToPath(new URL('..', import.meta.url));
const configure = process.platform === 'win32' ? windowsAutostart : posixAutostart;
const relayEnv = ['PATH', 'CDP_URL', 'DEVIN_CDP_URL', 'CODEX_CDP_URL', 'OPENCODE_URL',
  'CDP_PORT', 'DEVIN_CDP_PORT', 'CODEX_CDP_PORT', 'CODE_BIN', 'CODEX_BIN', 'CODEX_HOME', 'VSCODE_EXTENSIONS',
  'CR_ALLOWED_ORIGINS', 'CR_PAGES_BRANCH', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY'];

function launchSettings() {
  // The pairing launcher can supply a separate quick tunnel to a LAN relay.
  const quick = /^https:\/\/[a-z0-9-]+\.trycloudflare\.com(?:\/|$)/i.test(readState().relayUrl || '');
  const tunnel = TUNNEL || (quick && !!findTunnelPid());
  const keys = [...relayEnv, ...relayEnv.filter(key => key.endsWith('_PROXY')).map(key => key.toLowerCase())];
  const env = Object.fromEntries(keys.filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
  Object.assign(env, { PORT: String(PORT), CR_TUNNEL_ADDRESS_ONLY: '1', GH_PROMPT_DISABLED: '1' });
  if (process.env.HOST) env.HOST = process.env.HOST;
  return { cwd, node: process.execPath, env, args: [path.join(cwd, 'server', 'index.mjs'),
    ...(tunnel ? ['--tunnel'] : []), ...(PUBLISH_REPO ? ['--publish=' + PUBLISH_REPO] : [])] };
}

let pending = Promise.resolve();
export function relayAutostart(enabled) {
  if (enabled === undefined) return pending.then(() => configure());
  const change = pending.then(() => configure(enabled, launchSettings)).then(state => {
    if (state.enabled !== enabled) throw new Error('系统未确认自启动设置');
    return state;
  });
  pending = change.then(() => undefined, () => undefined);
  return change;
}
