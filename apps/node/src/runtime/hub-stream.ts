import type { BirpcReturn } from 'birpc';
import type {
  BotdUiSpec,
  ExtensionUiStreamPayload,
  HubRpcFunctions,
  NodeRpcFunctions,
  SubagentRunRecord,
} from '@botd/protocol';

/**
 * Hub 推流 sink：把回合内产生的文本 / 思考 / 工具 / 子代理事件统一发往 Hub 的 onSessionStream。
 * 推流失败一律静默——实时展示丢失不应影响回合本身的结果。
 */

export type HubStream = BirpcReturn<HubRpcFunctions, NodeRpcFunctions>;

export interface SubagentStreamPayload {
  id: string;
  subagentId: string;
  task: string;
  status: 'running' | 'done' | 'error' | 'stopped';
  result?: string;
  error?: string;
  durationMs?: number;
  toolUses?: number;
  currentTool?: string;
  phase?: string;
  childSessionId?: string;
  startedAt?: string;
  blocks?: SubagentRunRecord['blocks'];
  toolCalls?: SubagentRunRecord['toolCalls'];
  steers?: SubagentRunRecord['steers'];
}

export interface HubStreamSink {
  /** 主会话文本增量 */
  text(sessionId: string, botId: string, delta: string): void;
  /** 主会话思考流状态 / 增量 */
  thinking(
    sessionId: string,
    botId: string,
    payload: { delta?: string; status: 'running' | 'done'; durationMs?: number },
  ): void;
  /** 主会话工具状态变更 */
  tool(
    sessionId: string,
    botId: string,
    payload: {
      toolCallId?: string;
      toolName: string;
      toolStatus: 'running' | 'done' | 'error';
      toolSummary?: string;
      toolArgs?: Record<string, unknown>;
      toolOutput?: string;
      toolDurationMs?: number;
      toolIsError?: boolean;
      toolUiSpec?: BotdUiSpec;
    },
  ): void;
  /** 扩展 UI 实时事件（notify / setStatus / setWorkingMessage / setWidget / setEditorText） */
  extensionUi(sessionId: string, botId: string, payload: ExtensionUiStreamPayload): void;
  /** 子代理生命周期 / 进度事件 */
  subagent(sessionId: string, botId: string, payload: SubagentStreamPayload): void;
}

export function createHubStreamSink(hubRpc: HubStream): HubStreamSink {
  const send = (event: Parameters<HubStream['onSessionStream']>[0]) => {
    try {
      // birpc 的 _call 是 async 函数：rpc 已关闭时 reject 而非同步 throw，
      // 同步 try/catch 兜不住，必须显式 .catch，否则未处理拒绝会击穿整个 daemon。
      void hubRpc.onSessionStream.asEvent(event).catch(() => {
        // 推流失败不影响回合本身
      });
    } catch {
      // 同步抛出路径（防御未来 birpc 行为变化）同样静默
    }
  };
  return {
    text(sessionId, botId, delta) {
      if (!delta) return;
      send({ sessionId, botId, deltaText: delta });
    },
    thinking(sessionId, botId, payload) {
      send({
        sessionId,
        botId,
        ...(payload.delta !== undefined ? { thinkingDelta: payload.delta } : {}),
        thinkingStatus: payload.status,
        ...(payload.durationMs !== undefined ? { thinkingDurationMs: payload.durationMs } : {}),
      });
    },
    tool(sessionId, botId, payload) {
      send({ sessionId, botId, ...payload });
    },
    extensionUi(sessionId, botId, payload) {
      send({ sessionId, botId, extensionUiEvent: payload });
    },
    subagent(sessionId, botId, payload) {
      send({ sessionId, botId, subagentEvent: payload });
    },
  };
}

/** SubagentRunRecord → 推流载荷（唯一一处字段映射，消除三份重复展开） */
export function toSubagentPayload(run: SubagentRunRecord, extra?: { error?: string }): SubagentStreamPayload {
  return {
    id: run.id,
    subagentId: run.subagentId,
    task: run.task,
    status: run.status,
    ...(run.replyFull !== undefined ? { result: run.replyFull } : {}),
    ...(extra?.error ? { error: extra.error } : {}),
    ...(run.durationMs !== undefined ? { durationMs: run.durationMs } : {}),
    ...(run.toolCount !== undefined ? { toolUses: run.toolCount } : {}),
    ...(run.currentTool !== undefined ? { currentTool: run.currentTool } : {}),
    ...(run.phase ? { phase: run.phase } : {}),
    ...(run.childSessionId ? { childSessionId: run.childSessionId } : {}),
    ...(run.startedAt ? { startedAt: run.startedAt } : {}),
    ...(run.blocks ? { blocks: run.blocks } : {}),
    ...(run.toolCalls ? { toolCalls: run.toolCalls } : {}),
    ...(run.steers ? { steers: run.steers } : {}),
  };
}
