import qrcode from 'qrcode-terminal';
import { PUBLISH_REPO, loadConfig, PORT } from './config.mjs';
import { appBase, createPairing, listDevices, resolveAppEntry } from '../lib/auth.mjs';
import { runPairingWindow } from '../lib/pairing-window.mjs';

// Until a first device exists, print a pairing QR so a fresh install works without extra commands.
export function offerFirstPairing() {
  if (listDevices().length) return;
  const base = appBase();
  if (!base) return;
  const pairing = createPairing(base);
  printQr(`还没有配对的设备。用各入口扫码申请，在自动打开的电脑配对窗口核对批准（${pairing.minutes} 分钟内有效；过期后运行 npm run pair）`, pairing.link);
  runPairingWindow(pairing, PORT, { handleSignals: false }).catch(error => console.error(error.message));
}

function printQr(label, url) {
  console.log(`\n${label}：${url}`);
  qrcode.generate(url, { small: true });
}

export function appUrl() {
  return resolveAppEntry({ ...loadConfig(), publishRepo: PUBLISH_REPO });
}
