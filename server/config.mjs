import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_DIR, normalizeAppUrl } from '../lib/auth.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PORT = Number(process.env.PORT || 3939);
export const HOST = process.env.HOST || '0.0.0.0';
export const CDP_URL = (process.env.CDP_URL || `http://127.0.0.1:${process.platform === 'win32' && process.env.CDP_PORT || 9222}`).replace(/\/$/, '');
export const DEVIN_CDP_URL = (process.env.DEVIN_CDP_URL || `http://127.0.0.1:${process.platform === 'win32' && process.env.DEVIN_CDP_PORT || 9223}`).replace(/\/$/, '');
export const CODEX_CDP_URL = (process.env.CODEX_CDP_URL || `http://127.0.0.1:${process.platform === 'win32' && process.env.CODEX_CDP_PORT || 9224}`).replace(/\/$/, '');
export const EDITORS = [
  { app: 'cursor', name: 'Cursor', url: CDP_URL },
  { app: 'devin', name: 'Devin', url: DEVIN_CDP_URL },
  { app: 'codex', name: 'Codex', url: CODEX_CDP_URL },
];
export const TUNNEL = process.argv.includes('--tunnel');
export const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
export const APP_DIR = path.join(__dirname, '..', 'app');

export function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { return {}; }
}

export const CONFIG = loadConfig();
export const PUBLISH_REPO = process.argv.find(a => a.startsWith('--publish='))?.slice('--publish='.length) || process.env.CR_PUBLISH_REPO || CONFIG.publishRepo || '';
export const PAGES_BRANCH = process.env.CR_PAGES_BRANCH || CONFIG.pagesBranch || '';
// The Pages app may sit on a custom domain; config.appUrl records its real address when one is known.
export const APP_ORIGIN = (() => {
  const fixed = normalizeAppUrl(CONFIG.appUrl);
  if (fixed) return new URL(fixed).origin;
  return PUBLISH_REPO ? `https://${PUBLISH_REPO.split('/')[0].toLowerCase()}.github.io` : '';
})();
export const ALLOWED_ORIGINS = new Set([APP_ORIGIN, ...(process.env.CR_ALLOWED_ORIGINS || '').split(',')].filter(Boolean));
