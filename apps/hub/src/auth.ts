import { createHash, createHmac, randomBytes, randomInt, scryptSync, timingSafeEqual } from 'node:crypto';

export interface PairingEntry {
  userId: string;
  expiresAt: number;
  used: boolean;
}

const TOKEN_COOKIE = 'botd_token';
const TOKEN_MAX_AGE_SECONDS = 604800; // 7 days

export class AuthManager {
  private authSecret: string;
  private pairingCodes = new Map<string, PairingEntry>();

  constructor() {
    this.authSecret = randomBytes(32).toString('hex');
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

  issueToken(userId: string): { token: string; maxAgeSeconds: number } {
    const expiresAtMs = Date.now() + TOKEN_MAX_AGE_SECONDS * 1000;
    const hmac = createHmac('sha256', this.authSecret).update(`${userId}.${expiresAtMs}`).digest('hex');
    return {
      token: `${userId}.${expiresAtMs}.${hmac}`,
      maxAgeSeconds: TOKEN_MAX_AGE_SECONDS,
    };
  }

  verifyCookie(cookieHeader?: string | null): { userId: string } | undefined {
    if (!cookieHeader) return undefined;
    const cookies = cookieHeader.split(';').map((s) => s.trim());
    for (const c of cookies) {
      if (!c.startsWith(`${TOKEN_COOKIE}=`)) continue;
      const token = c.slice(TOKEN_COOKIE.length + 1);
      const parts = token.split('.');
      if (parts.length !== 3) return undefined;
      const [userId, expiresAtStr, hmac] = parts;
      const expiresAtMs = Number(expiresAtStr);
      if (!Number.isFinite(expiresAtMs) || Date.now() > expiresAtMs) return undefined;
      const expected = createHmac('sha256', this.authSecret).update(`${userId}.${expiresAtStr}`).digest('hex');
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
    });

    return {
      code,
      expiresAt: new Date(expiresAtMs).toISOString(),
    };
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
