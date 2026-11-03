import type { Hono } from 'hono';
import type { UserRecord } from '@botd/protocol';
import type { HubDatabase } from './db.js';
import type { GroupRouter } from './group-router.js';
import type { SseHub } from './sse.js';
import { ensureChannelTables } from './channel-schema.js';
import { createAskRespondHandler, resolveAskSecret } from './ask-callback.js';
import { createOutboxDeliverer } from './channel-outbox.js';
import { registerChannelNotifier } from './channel-notifier.js';
import {
  createSessionChannel,
  deleteChannel,
  listSessionChannels,
  listSessionOutbox,
  testChannel,
  updateChannel,
} from './channel-handlers.js';

/**
 * 装配通知通道模块：建表/迁移 → ask 回调密钥 → outbox 投递引擎 →
 * ask 回调路由 + 通道 CRUD 路由 → 全局广播监听。返回卸载函数。
 */
export function registerChannelRoutes(
  app: Hono<{ Variables: { user: UserRecord } }>,
  db: HubDatabase,
  router: GroupRouter,
  sseHub: SseHub,
  _getSessionOwnerId: (sessionId: string) => string | undefined
): () => void {
  ensureChannelTables(db);
  const askSecret = resolveAskSecret(db);
  const outbox = createOutboxDeliverer(db);
  const handleAskRespond = createAskRespondHandler(router, askSecret);

  // 公开免登录的 ask 一键确认回调（GET 浏览器跳转 / POST 表单）
  app.get('/api/public/asks/:askId/respond', handleAskRespond);
  app.post('/api/public/asks/:askId/respond', handleAskRespond);

  // 会话出站通道 CRUD
  app.get('/api/sessions/:id/channels', (c) => listSessionChannels(c, db, c.req.param('id')));
  app.get('/api/sessions/:id/outbox', (c) => listSessionOutbox(c, db, c.req.param('id')));
  app.post('/api/sessions/:id/channels', (c) => createSessionChannel(c, db, c.req.param('id')));
  app.patch('/api/channels/:channelId', (c) => updateChannel(c, db, c.req.param('channelId')));
  app.delete('/api/channels/:channelId', (c) => deleteChannel(c, db, c.req.param('channelId')));
  app.post('/api/channels/:channelId/test', (c) => testChannel(c, db, c.req.param('channelId')));

  // 全局事件监听：会话事件按 tellPolicy 过滤后经 outbox 推送到外部通道
  const unsubscribe = registerChannelNotifier(db, sseHub, askSecret, outbox.enqueue);

  return () => {
    outbox.stop();
    unsubscribe();
  };
}
