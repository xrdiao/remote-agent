const locks = new Map();
const exclusive = new Map();
const key = (app, id) => app + ':' + String(id).replace(/^(cursor|devin|codex):/, '');
export function leaseWindow(app, id, owner, block = false) {
  const k = key(app, id);
  if (block && exclusive.has(k) && exclusive.get(k) !== owner) throw new Error('窗口正在执行另一项批量操作');
  const holders = locks.get(k) || new Map();
  if (block && [...holders.keys()].some(holder => holder !== owner)) throw new Error('窗口正在执行操作，请稍后重试');
  holders.set(owner, (holders.get(owner) || 0) + 1);
  locks.set(k, holders);
  if (block) exclusive.set(k, owner);
  return () => { const n = holders.get(owner) - 1; if (n) holders.set(owner, n); else holders.delete(owner); if (!holders.size) locks.delete(k); if (block) exclusive.delete(k); };
}
export const windowLeased = (app, id) => locks.has(key(app, id));
export const windowOperationLocked = (app, id, owner) => exclusive.has(key(app, id)) && exclusive.get(key(app, id)) !== owner;
