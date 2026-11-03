import { streamSSE } from 'hono/streaming';
import { resolveOwnedSession } from '../http-helpers.js';
import type { HubApp, HubContext } from './context.js';

export function registerEventRoutes(app: HubApp, ctx: HubContext): void {
  const { db, sseHub } = ctx;

  app.get('/api/sessions/:id/events', async (c) => {
    const id = c.req.param('id');
    const sRes = resolveOwnedSession(c, db, id);
    if (!sRes.ok) return sRes.response;
    const session = sRes.session;

    return streamSSE(c, async (stream) => {
      // Send initial session status event
      await stream.writeSSE({
        data: JSON.stringify({
          type: 'session_status',
          sessionId: session.id,
          status: session.status,
          activeBotId: session.activeBotId,
        }),
      });

      const unsubscribe = sseHub.subscribe(id, async (event) => {
        try {
          await stream.writeSSE({
            data: JSON.stringify(event),
          });
        } catch {
          // stream aborted or error
        }
      });

      const keepalive = setInterval(async () => {
        try {
          await stream.writeSSE({
            event: 'ping',
            data: '',
          });
        } catch {
          clearInterval(keepalive);
        }
      }, 15000);

      stream.onAbort(() => {
        clearInterval(keepalive);
        unsubscribe();
      });

      await new Promise<void>((resolve) => {
        stream.onAbort(resolve);
      });
    });
  });

  // 全局 SSE（登录用户）：该用户所有会话事件 + 其节点上下线通知
  app.get('/api/events', (c) => {
    const user = c.get('user');

    return streamSSE(c, async (stream) => {
      // 首个事件：握手确认，便于客户端确认订阅已建立
      await stream.writeSSE({
        data: JSON.stringify({ type: 'hello' }),
      });

      const unsubscribe = sseHub.subscribeUser(user.id, async (event) => {
        try {
          await stream.writeSSE({
            data: JSON.stringify(event),
          });
        } catch {
          // stream aborted or error
        }
      });

      const keepalive = setInterval(async () => {
        try {
          await stream.writeSSE({
            event: 'ping',
            data: '',
          });
        } catch {
          clearInterval(keepalive);
        }
      }, 15000);

      stream.onAbort(() => {
        clearInterval(keepalive);
        unsubscribe();
      });

      await new Promise<void>((resolve) => {
        stream.onAbort(resolve);
      });
    });
  });
}
