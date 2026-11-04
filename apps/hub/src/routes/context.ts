import type { Hono } from 'hono';
import type { UserRecord } from '@botd/protocol';
import type { HubDatabase } from '../db.js';
import type { AuthManager } from '../auth.js';
import type { SseHub } from '../sse.js';
import type { NodeConnectionManager } from '../ws-hub.js';
import type { GroupRouter } from '../group-router.js';
import type { ArtifactService } from '../artifact-service.js';
import type { HubDurableRuntime } from '../harness/hub-harness.js';

export type HubApp = Hono<{ Variables: { user: UserRecord; viaNode?: boolean } }>;

/** 路由模块共享的 Hub 装配依赖 */
export interface HubContext {
  db: HubDatabase;
  auth: AuthManager;
  connections: NodeConnectionManager;
  router: GroupRouter;
  sseHub: SseHub;
  artifacts: ArtifactService;
  /** Super-agent 持久运行时（Router/Worker 会话）；已打开时可直接携带，路由优先使用。 */
  durableRuntime?: HubDurableRuntime;
  /**
   * Super-agent 持久运行时（Router/Worker 会话）。`createHub` 保持同步，
   * 运行时懒加载：首次调用 `getDurableRuntime()` 时打开并同步 Bot 分身。
   */
  getDurableRuntime?: () => Promise<HubDurableRuntime>;
}
