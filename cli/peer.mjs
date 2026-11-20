import { newPeerJobId, peerStatus, sendPeerTask, trustWorkspacePeer } from '../server/peer/access.mjs';

const [action = 'status', ...args] = process.argv.slice(2);
const usage = '用法：npm run peer -- status | trust <对方电脑 ID> <公钥指纹> | start <目标电脑 ID> <预设任务> <授权编号> [任务号] | read/cancel <目标电脑 ID> <预设任务> <授权编号> <任务号>';
try {
  if (action === 'status') console.log(JSON.stringify(peerStatus(), null, 2));
  else if (action === 'trust') {
    if (args.length !== 2) throw new Error(usage);
    console.log(JSON.stringify(trustWorkspacePeer(...args), null, 2));
  }
  else {
    const [target, task, grant, ...jobIds] = args;
    if (!['start', 'read', 'cancel'].includes(action) || !target || !task || !grant || jobIds.length > 1 || (!jobIds.length && action !== 'start'))
      throw new Error(usage);
    const id = jobIds[0] || newPeerJobId();
    if (action === 'start') console.error(`任务号：${id}`);
    console.log(JSON.stringify(await sendPeerTask({ action, target, task, grant, id }), null, 2));
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
