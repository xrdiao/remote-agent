// npm run 2fa            → turn on authenticator-app verification (Google Authenticator, Microsoft Authenticator, ...)
// npm run 2fa off        → turn it off
// npm run 2fa status
import os from 'node:os';
import readline from 'node:readline/promises';
import qrcode from 'qrcode-terminal';
import { totpConfig, newTotpSecret, totpUri, checkTotp, enableTotp, disableTotp } from './auth.mjs';

const cmd = process.argv[2] || 'on';
const cfg = totpConfig();
const rule = days => days ? `配对新设备时，以及每台设备每 ${days} 天验证一次` : '只在配对新设备时验证';

if (cmd === 'status') {
  console.log(cfg ? `二次验证：已开启（${rule(cfg.everyDays)}）` : '二次验证：未开启（运行 npm run 2fa 开启）');
  process.exit(0);
}
if (cmd === 'off') {
  disableTotp();
  console.log('已关闭二次验证。');
  process.exit(0);
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
if (cfg && !/^y/i.test(await rl.question(`已经开启了（${rule(cfg.everyDays)}）。要重新绑定 Authenticator 吗？(y/N) `))) process.exit(0);

const secret = newTotpSecret();
console.log('\n1. 手机打开 Authenticator（Google / Microsoft Authenticator 等），扫描下面的二维码：\n');
qrcode.generate(totpUri(secret, os.hostname().replace(/\.local$/, '')), { small: true });
console.log(`\n   扫不了的话，手动输入密钥：${secret}\n`);

let ok = false;
for (let i = 0; i < 3 && !ok; i++) {
  ok = checkTotp(secret, await rl.question('2. 输入 Authenticator 显示的 6 位数字确认：'));
  if (!ok) console.log('   不对，注意要输入当前显示的那组数字。');
}
if (!ok) { console.log('没有开启。'); process.exit(1); }

const answer = (await rl.question('3. 多少天要求每台设备重新验证一次？（直接回车 = 30 天；输入 0 = 只在配对新设备时验证）')).trim();
const everyDays = answer === '' ? 30 : Math.max(0, parseInt(answer, 10) || 0);
enableTotp(secret, everyDays);
console.log(`\n已开启二次验证：${rule(everyDays)}。已配对的设备从现在开始计时。`);
rl.close();
