import { createHash, createHmac, randomBytes, randomInt, scryptSync, timingSafeEqual } from 'node:crypto';

export interface PairingEntry {
  userId: string;
  expiresAt: number;
  used: boolean;
  /** 连续失败次数：达到阈值后配对码作废（防暴破） */
  failedAttempts: number;
}

const TOKEN_COOKIE = 'botd_token';
const TOKEN_MAX_AGE_SECONDS = 604800; // 7 days

/** 单个配对码连续失败达到该次数即作废 */
const PAIRING_MAX_FAILURES = 5;
/** IP 失败退避的起始时长与上限（指数递增） */
const PAIRING_BACKOFF_BASE_MS = 1_000;
const PAIRING_BACKOFF_MAX_MS = 5 * 60_000;

export class AuthManager {
  private authSecret: string;
  private pairingCodes = new Map<string, PairingEntry>();
  /** 按 IP 的失败计数（内存级，重启清零）与封禁截止时间 */
  private ipFailures = new Map<string, { count: number; blockedUntil: number }>();

  constructor(initialSecret?: string) {
    this.authSecret = initialSecret || randomBytes(32).toString('hex');
  }

  getSecret(): string {
    return this.authSecret;
  }

  hashPassword(password: string): string {
    const salt = randomBytes(16);
    const key = scryptSync(password, salt, 64);
    return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
  }

  verifyPassword(password: string, stored: string): boolean {
    const parts = stored.split('$');
    if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
    const salt = Buffer.from(parts[1], 'hex');
    const expected = Buffer.from(parts[2], 'hex');
    if (salt.length === 0 || expected.length !== 64) return false;
    const actual = scryptSync(password, salt, 64);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  issueToken(userId: string, tokenEpoch = 0): { token: string; maxAgeSeconds: number } {
    const expiresAtMs = Date.now() + TOKEN_MAX_AGE_SECONDS * 1000;
    const hmac = createHmac('sha256', this.authSecret).update(`${userId}.${expiresAtMs}.${tokenEpoch}`).digest('hex');
    return {
      token: `${userId}.${expiresAtMs}.${tokenEpoch}.${hmac}`,
      maxAgeSeconds: TOKEN_MAX_AGE_SECONDS,
    };
  }

  /**
   * 校验 Cookie token：HMAC 覆盖 userId.expiresAt.epoch，并比对库里当前 epoch
   * （getExpectedTokenEpoch 默认返回 0；改密后 epoch 递增，旧 token 立即失效）。
   */
  verifyCookie(
    cookieHeader: string | null | undefined,
    getExpectedTokenEpoch: (userId: string) => number = () => 0
  ): { userId: string } | undefined {
    if (!cookieHeader) return undefined;
    const cookies = cookieHeader.split(';').map((s) => s.trim());
    for (const c of cookies) {
      if (!c.startsWith(`${TOKEN_COOKIE}=`)) continue;
      const token = c.slice(TOKEN_COOKIE.length + 1);
      const parts = token.split('.');
      if (parts.length !== 4) return undefined;
      const [userId, expiresAtStr, epochStr, hmac] = parts;
      const expiresAtMs = Number(expiresAtStr);
      if (!Number.isFinite(expiresAtMs) || Date.now() > expiresAtMs) return undefined;
      if (getExpectedTokenEpoch(userId) !== Number(epochStr)) return undefined;
      const expected = createHmac('sha256', this.authSecret).update(`${userId}.${expiresAtStr}.${epochStr}`).digest('hex');
      const actualBuf = Buffer.from(hmac, 'utf8');
      const expectedBuf = Buffer.from(expected, 'utf8');
      if (actualBuf.length !== expectedBuf.length || !timingSafeEqual(actualBuf, expectedBuf)) return undefined;
      return { userId };
    }
    return undefined;
  }

  private pruneExpiredPairingCodes(): void {
    const now = Date.now();
    for (const [code, entry] of this.pairingCodes.entries()) {
      if (entry.used || now > entry.expiresAt) {
        this.pairingCodes.delete(code);
      }
    }
    // 顺带清理失效的 IP 退避记录，防止 Map 无限增长
    for (const [ip, entry] of this.ipFailures.entries()) {
      if (entry.count === 0 && now > entry.blockedUntil) {
        this.ipFailures.delete(ip);
      }
    }
  }

  /** 按来源 IP 计算当前退避剩余毫秒；封禁中返回正数，否则 0 */
  pairingBackoffRemainingMs(ip: string): number {
    const entry = this.ipFailures.get(ip);
    if (!entry) return 0;
    return Math.max(0, entry.blockedUntil - Date.now());
  }

  /** 配对码校验失败时记账：IP 指数退避 + 配对码连续失败计数（超限作废） */
  recordPairingFailure(ip: string, code: string): void {
    const entry = this.pairingCodes.get(code);
    if (entry) {
      entry.failedAttempts++;
      if (entry.failedAttempts >= PAIRING_MAX_FAILURES) {
        this.pairingCodes.delete(code);
      }
    }

    const now = Date.now();
    const ipEntry = this.ipFailures.get(ip) ?? { count: 0, blockedUntil: 0 };
    if (now < ipEntry.blockedUntil) {
      // 封禁期内继续失败：只计数，不重置退避窗口（避免持续拖长）
      ipEntry.count++;
    } else {
      ipEntry.count++;
      const backoff = Math.min(PAIRING_BACKOFF_BASE_MS * 2 ** (ipEntry.count - 1), PAIRING_BACKOFF_MAX_MS);
      ipEntry.blockedUntil = now + backoff;
    }
    this.ipFailures.set(ip, ipEntry);
  }

  /** 配对成功后清除该 IP 的失败退避 */
  clearPairingFailures(ip: string): void {
    this.ipFailures.delete(ip);
  }

  createPairingCode(userId: string): { code: string; expiresAt: string } {
    this.pruneExpiredPairingCodes();

    const now = Date.now();
    let code: string;
    let attempts = 0;

    do {
      code = randomInt(100000, 1000000).toString();
      attempts++;
      const existing = this.pairingCodes.get(code);
      if (!existing || existing.used || now > existing.expiresAt) {
        break;
      }
    } while (attempts < 100);

    const expiresAtMs = now + 10 * 60 * 1000;
    this.pairingCodes.set(code, {
      userId,
      expiresAt: expiresAtMs,
      used: false,
      failedAttempts: 0,
    });

    return {
      code,
      expiresAt: new Date(expiresAtMs).toISOString(),
    };
  }

  /** 只读校验配对码（不消费）：返回归属用户 id，无效/过期/已用返回 undefined */
  peekPairingCodeOwner(code: string): string | undefined {
    const entry = this.pairingCodes.get(code);
    if (!entry || entry.used || Date.now() > entry.expiresAt) return undefined;
    return entry.userId;
  }

  consumePairingCode(code: string): string | undefined {
    const entry = this.pairingCodes.get(code);
    if (!entry) return undefined;
    if (entry.used) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.pairingCodes.delete(code);
      return undefined;
    }
    entry.used = true;
    return entry.userId;
  }

  hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  verifyNodeToken(token: string, tokenHash: string): boolean {
    const computed = this.hashToken(token);
    const computedBuf = Buffer.from(computed, 'utf8');
    const hashBuf = Buffer.from(tokenHash, 'utf8');
    if (computedBuf.length !== hashBuf.length) return false;
    return timingSafeEqual(computedBuf, hashBuf);
  }
}
