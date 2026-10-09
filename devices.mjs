// npm run pair            → show a QR / link that pairs one new phone (valid 10 minutes, single use)
// npm run devices         → list paired devices
// npm run devices remove <id>
import qrcode from 'qrcode-terminal';
import { createPairing, appBase, listDevices, removeDevice, totpConfig } from './auth.mjs';

const [cmd = 'list', arg] = process.argv.slice(2);
const fmt = t => t ? new Date(t).toLocaleString('zh-CN', { hour12: false }) : '-';

if (cmd === 'pair') {
  const base = appBase();
  if (!base) {
    console.log('还不知道手机 App 的地址：先运行 npm run setup 设置固定地址，或先启动服务（npm run public / npm start）。');
    process.exit(1);
  }
  const { link, minutes } = createPairing(base);
  console.log(`\n用手机扫码，或把下面的链接发到手机上打开（${minutes} 分钟内有效，只能配对一台设备）：\n`);
  qrcode.generate(link, { small: true });
  console.log(`\n${link}\n`);
  if (totpConfig()) console.log('已开启二次验证：配对时还要输入 Authenticator 里的 6 位验证码。\n');
  console.log('安卓 App：在 App 里「粘贴配对链接」，或用浏览器打开链接后点「在 App 中打开」。');
} else if (cmd === 'remove') {
  if (!arg) { console.log('用法：npm run devices remove <设备ID>'); process.exit(1); }
  console.log(removeDevice(arg) ? `已移除设备 ${arg}，它会立即断开` : `没有找到设备 ${arg}`);
} else {
  const list = listDevices();
  if (!list.length) console.log('还没有配对的设备。运行 npm run pair 添加。');
  for (const d of list) console.log(`${d.id}  ${d.name.padEnd(24)}  配对于 ${fmt(d.created)}  最近使用 ${fmt(d.lastSeen)}`);
  if (list.length) console.log('\n移除设备：npm run devices remove <设备ID>');
}
