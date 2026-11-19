import { newPeerJobId, peerStatus, sendPeerTask } from '../server/peer/access.mjs';

const [action = 'status', target, task, grant, ...jobIds] = process.argv.slice(2);
try {
  if (action === 'status') console.log(JSON.stringify(peerStatus(), null, 2));
  else {
    if (!['start', 'read', 'cancel'].includes(action) || !target || !task || !grant || jobIds.length > 1 || (!jobIds.length && action !== 'start'))
      throw new Error('用法：npm run peer -- status | start <目标电脑 ID> <预设任务> <授权编号> [任务号] | read/cancel <目标电脑 ID> <预设任务> <授权编号> <任务号>');
    const id = jobIds[0] || newPeerJobId();
    if (action === 'start') console.error(`任务号：${id}`);
    console.log(JSON.stringify(await sendPeerTask({ action, target, task, grant, id }), null, 2));
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
