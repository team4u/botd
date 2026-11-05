import type { Hono } from 'hono';
import type { UserRecord } from '@botd/protocol';
import type { HubDatabase } from '../db.js';
import type { AuthManager } from '../auth.js';
import type { SseHub } from '../sse.js';
import type { NodeConnectionManager } from '../ws-hub.js';
import type { ArtifactService } from '../artifact-service.js';
import type { HubDurableRuntime } from '../harness/hub-harness.js';

export type HubApp = Hono<{ Variables: { user: UserRecord; viaNode?: boolean } }>;

/**
 * 旧 GroupRouter 的最小兼容占位：trigger-service.ts（并行重构中）仍以此为参数类型。
 * 语义上已全部收敛到 Durable 主线（由 index.ts 注入最小实现），随 trigger-service
 * 的重构一并删除。
 */
export interface GroupRouter {
  canRunBot(sessionId: string, botId: string): boolean;
  handleUserMessage(sessionId: string, messageId: string, content: string, commandInfo?: { commandText: string; targetBotId?: string }): void;
  handleWakeup(sessionId: string, botId: string, wakeupMessage: string, replyToBotId?: string, options?: { noTurn?: boolean }): Promise<void>;
}

/** 路由模块共享的 Hub 装配依赖 */
export interface HubContext {
  db: HubDatabase;
  auth: AuthManager;
  connections: NodeConnectionManager;
  sseHub: SseHub;
  artifacts: ArtifactService;
  /** Super-agent 持久运行时（Router/Worker 会话）；已打开时可直接携带，路由优先使用。 */
  durableRuntime?: HubDurableRuntime;
  /**
   * Super-agent 持久运行时（Router/Worker 会话）。`createHub` 保持同步，
   * 运行时懒加载：首次调用 `getDurableRuntime()` 时打开并同步 Bot 分身。
   */
  getDurableRuntime?: () => Promise<HubDurableRuntime>;
  /**
   * 热同步分身：Bot/Skill/Extension/Provider 凭据变更后触发，把 Hub SQLite
   * 权威存储的最新配置推送到已打开的持久运行时（未打开时为空操作）。
   */
  refreshDurablePersonas?: () => Promise<void>;
}
