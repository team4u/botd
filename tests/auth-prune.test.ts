import assert from 'node:assert/strict';
import test from 'node:test';
import { AuthManager } from '../apps/hub/src/auth.js';

test('配对失败后 IP 退避生效，期满后记录被清理', { timeout: 60_000 }, () => {
  const auth = new AuthManager();
  const { code } = auth.createPairingCode('user-1');
  const ip = '203.0.113.7';

  // 首次失败：进入 1s 退避
  auth.recordPairingFailure(ip, code);
  assert.ok(auth.pairingBackoffRemainingMs(ip) > 0);

  // 退避期满后，创建新配对码会触发 prune，过期 IP 记录应被清掉
  // （回归：旧条件 entry.count === 0 恒 false，记录永不清理）
  const ipEntry = (auth as unknown as { ipFailures: Map<string, { count: number; blockedUntil: number }> }).ipFailures;
  const blockedUntil = ipEntry.get(ip)!.blockedUntil;
  ipEntry.get(ip)!.blockedUntil = Date.now() - 1; // 模拟封禁期满
  assert.equal(auth.pairingBackoffRemainingMs(ip), 0);

  auth.createPairingCode('user-1'); // 内部调用 pruneExpiredPairingCodes
  assert.equal(ipEntry.has(ip), false, '退避期满的 IP 记录应被清理');
});
