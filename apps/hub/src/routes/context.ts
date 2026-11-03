import type { Hono } from 'hono';
import type { UserRecord } from '@botd/protocol';
import type { HubDatabase } from '../db.js';
import type { AuthManager } from '../auth.js';
import type { SseHub } from '../sse.js';
import type { NodeConnectionManager } from '../ws-hub.js';
import type { GroupRouter } from '../group-router.js';
import type { ArtifactService } from '../artifact-service.js';

export type HubApp = Hono<{ Variables: { user: UserRecord; viaNode?: boolean } }>;

/** 路由模块共享的 Hub 装配依赖 */
export interface HubContext {
  db: HubDatabase;
  auth: AuthManager;
  connections: NodeConnectionManager;
  router: GroupRouter;
  sseHub: SseHub;
  artifacts: ArtifactService;
}
