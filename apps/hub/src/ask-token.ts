import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Context } from 'hono';
import type { GroupRouter } from './group-router.js';
import type { HubDatabase } from './db.js';
import { renderErrorHtml, renderResponseHtml } from './ask-page.js';

const ASK_SECRET_SETTING_KEY = 'ask_secret';

/**
 * 解析 ask 回调签名密钥：环境变量优先，其次 settings 表持久化值，
 * 都没有则生成 64 位 hex 随机密钥并落库（重启后不变，避免历史推送链接失效）。
 */
export function resolveAskSecret(db: HubDatabase): string {
  const fromEnv = process.env.BOTD_ASK_SECRET;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  const stored = db.getSetting<string>(ASK_SECRET_SETTING_KEY);
  if (stored && stored.length > 0) return stored;
  const generated = randomBytes(32).toString('hex');
  db.setSetting(ASK_SECRET_SETTING_KEY, generated);
  return generated;
}

export function signAskToken(sessionId: string, askId: string, secret: string): string {
  return createHmac('sha256', secret).update(`${sessionId}:${askId}`).digest('hex');
}

export function verifyAskToken(sessionId: string, askId: string, token: string, secret: string): boolean {
  if (!token || typeof token !== 'string') return false;
  const expected = signAskToken(sessionId, askId, secret);
  const expectedBuf = Buffer.from(expected, 'utf8');
  const actualBuf = Buffer.from(token, 'utf8');
  if (expectedBuf.length !== actualBuf.length) return false;
  return timingSafeEqual(expectedBuf, actualBuf);
}

/** 公开免登录的 botd ask 外部一键确认回调（GET 跳转页 + POST 表单/JSON 同构） */
export function createAskRespondHandler(router: GroupRouter, askSecret: string) {
  return async (c: Context) => {
    // 路由声明保证 askId 存在；断言仅收窄类型
    const askId = c.req.param('askId') as string;
    let sessionId: string | undefined;
    let answer: string | undefined;
    let token: string | undefined;

    if (c.req.method === 'POST') {
      const body = await c.req.json().catch(() => null);
      if (body && typeof body === 'object') {
        sessionId = typeof body.sessionId === 'string' ? body.sessionId : undefined;
        answer = typeof body.answer === 'string' ? body.answer : undefined;
        token = typeof body.token === 'string' ? body.token : undefined;
      }
    }

    const query = c.req.query();
    if (!sessionId && query.sessionId) sessionId = query.sessionId;
    if (!answer && query.answer) answer = query.answer;
    if (!token && query.token) token = query.token;

    const accept = c.req.header('accept') || '';
    const wantsHtml = accept.includes('text/html');

    if (!sessionId || !answer || !token) {
      if (wantsHtml) {
        return c.html(renderErrorHtml('参数不完整', '缺少必要的确认参数 (sessionId, answer, token)'), 400);
      }
      return c.json({ error: 'Missing required parameters: sessionId, answer, token' }, 400);
    }

    const trimmedAnswer = answer.trim();

    if (!verifyAskToken(sessionId, askId, token, askSecret)) {
      if (wantsHtml) {
        return c.html(renderErrorHtml('鉴权失败', '回调 Token 无效或已过期'), 403);
      }
      return c.json({ error: 'Invalid or expired token' }, 403);
    }

    // 选项非空时强制答案在选项内，防止伪造 token 后提交任意文本
    const pendingAsk = router.getPendingAsks(sessionId).find((a) => a.id === askId);
    if (pendingAsk && pendingAsk.status === 'pending' && pendingAsk.options.length > 0
      && !pendingAsk.options.includes(trimmedAnswer)) {
      if (wantsHtml) {
        return c.html(renderErrorHtml('无效选项', '答案不在可选项列表中'), 400);
      }
      return c.json({ error: 'Answer must be one of the ask options' }, 400);
    }

    const resolved = router.respondToAsk(sessionId, askId, trimmedAnswer);
    if (!resolved) {
      if (wantsHtml) {
        return c.html(renderErrorHtml('请求失效', '该确认请求不存在、已超时或已被其他用户处理'), 404);
      }
      return c.json({ error: 'Ask not found or already answered' }, 404);
    }

    if (wantsHtml) {
      return c.html(renderResponseHtml(trimmedAnswer));
    }
    return c.json({ ok: true, ask: resolved });
  };
}
