// Behind cloudflared every request arrives from loopback; only then trust its client-IP header.
export function clientIp(req) {
  const remote = req.socket.remoteAddress || '';
  const loopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
  return (loopback && req.headers['cf-connecting-ip']) || remote;
}

const failures = new Map();
let globalFailures = [];
const PER_IP_LIMIT = 5, GLOBAL_LIMIT = 20, LOCK_MS = 15 * 60 * 1000;
let nextCleanup = 0;

function recentFailures(ip, now) {
  globalFailures = globalFailures.filter(t => now - t < LOCK_MS);
  if (now >= nextCleanup) {
    for (const [key, times] of failures) {
      const active = times.filter(t => now - t < LOCK_MS);
      if (active.length) failures.set(key, active);
      else failures.delete(key);
    }
    nextCleanup = now + LOCK_MS;
  }
  const mine = (failures.get(ip) || []).filter(t => now - t < LOCK_MS);
  if (mine.length) failures.set(ip, mine);
  else failures.delete(ip);
  return mine;
}

export function lockedOut(ip) {
  const mine = recentFailures(ip, Date.now());
  return mine.length >= PER_IP_LIMIT || globalFailures.length >= GLOBAL_LIMIT;
}

export function recordFailure(ip) {
  const now = Date.now();
  failures.set(ip, [...recentFailures(ip, now), now]);
  globalFailures.push(now);
  console.log(`!! 验证失败 ip=${ip}（15 分钟内：本 IP ${failures.get(ip).length} 次，总计 ${globalFailures.length} 次）`);
}
