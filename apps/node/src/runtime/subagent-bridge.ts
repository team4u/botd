import type { AgentSession } from '@earendil-works/pi-coding-agent';
import type { SubagentRunRecord } from '@botd/protocol';
import type { HubStreamSink } from './hub-stream.js';
import { toSubagentPayload } from './hub-stream.js';
import { TurnEventRecorder } from './turn-events.js';
import { getGlobalSubagentManager } from '../commands.js';

/**
 * pi-subagents 事件桥接：把子代理生命周期事件（created/started/completed/failed/steered）
 * 与子代理会话的工具/思考/文本流实时转发到 Hub，并维护本回合的 SubagentRunRecord 映射。
 *
 * 主 BOT 未挂载子代理扩展时 createSubagentBridge 静默返回 undefined。
 */

/** 生命周期事件携带的子代理基础字段（来自 pi-subagents 扩展） */
interface LifecycleEvent {
  id?: string;
  type?: string;
  description?: string;
  status?: string;
  result?: string;
  error?: string;
  durationMs?: number;
  toolUses?: number;
  phase?: string;
  childSessionId?: string;
}

/** 全局 manager 里的一条子代理记录（含会话与文件，供实时订阅与跨回合 resume） */
interface ManagerRecord {
  id: string;
  type: string;
  description: string;
  status: string;
  result?: string;
  error?: string;
  toolUses: number;
  startedAt: number;
  completedAt?: number;
  sessionFile?: string;
  session?: AgentSession;
}

function peekManagerRecord(id: string): ManagerRecord | undefined {
  try {
    return getGlobalSubagentManager()?.getRecord?.(id) as ManagerRecord | undefined;
  } catch {
    return undefined;
  }
}

export interface SubagentBridge {
  /** 本回合全部子代理运行记录（runId → record） */
  readonly runs: Map<string, SubagentRunRecord>;
  /** 推送 / 更新一条子代理记录并转发到 Hub */
  emit(run: SubagentRunRecord, patch?: Partial<SubagentRunRecord>): void;
  /** 撤销全部事件订阅 */
  dispose(): void;
}

export interface SubagentBridgeOptions {
  sessionId: string;
  botId: string;
  sink: HubStreamSink;
  /** runId → 子代理会话文件与身份（跨回合 resume 追问时重开同一上下文） */
  sessionFiles: Map<string, { sessionFile: string; subagentId: string; task: string }>;
}

export function createSubagentBridge(
  resourceLoader: unknown,
  opts: SubagentBridgeOptions,
): SubagentBridge | undefined {
  const { sessionId, botId, sink, sessionFiles } = opts;
  const runs = new Map<string, SubagentRunRecord>();
  /** 已订阅子代理 session 工具事件的取消函数（runId → unsub） */
  const toolListeners = new Map<string, { unsub: () => void; recorder: TurnEventRecorder }>();

  const emit = (run: SubagentRunRecord, patch?: Partial<SubagentRunRecord>) => {
    if (patch) Object.assign(run, patch);
    runs.set(run.id, run);
    try {
      sink.subagent(sessionId, botId, toSubagentPayload(run));
    } catch {
      // 推流失败不影响回合本身
    }
  };

  /** 同步 runRecord 基础字段到本地映射（含跨回合 resume 的既有记录） */
  const syncRecord = (d: LifecycleEvent): SubagentRunRecord | undefined => {
    if (!d || typeof d !== 'object' || !d.id) return undefined;
    const existing = runs.get(d.id);
    const record: SubagentRunRecord = existing ?? {
      id: d.id,
      subagentId: d.type || 'agent',
      task: d.description || d.id,
      status: 'running',
      startedAt: new Date().toISOString(),
    };
    if (d.type) record.subagentId = d.type;
    if (d.description) record.task = d.description;
    if (typeof d.toolUses === 'number') record.toolCount = d.toolUses;
    if (d.phase) record.phase = d.phase;
    if (d.childSessionId) record.childSessionId = d.childSessionId;
    runs.set(d.id, record);
    return record;
  };

  /** 订阅子代理 session 的事件，实时收集交错 blocks（思考/文本流）与 toolCalls / currentTool */
  const attachToolListener = (runId: string, subSession: AgentSession) => {
    if (toolListeners.has(runId)) return;
    const record = runs.get(runId);
    if (!record) return;
    record.toolCalls ??= [];
    record.blocks ??= [];
    const recorder = new TurnEventRecorder(
      { blocks: record.blocks, toolCalls: record.toolCalls },
      {
        splitTextBlocksOnMessageEnd: true,
        onTool: () => {
          const current = runs.get(runId);
          if (!current) return;
          current.toolCount = current.toolCalls?.length;
          // 仍有 running 项则保留 currentTool，否则清空
          if (!current.toolCalls?.some((tc) => tc.status === 'running')) {
            current.currentTool = undefined;
          } else {
            const active = current.toolCalls.find((tc) => tc.status === 'running');
            current.currentTool = active?.name;
          }
          emit(current);
        },
      },
    );
    const unsub = subSession.subscribe((event: any) => recorder.handle(event));
    toolListeners.set(runId, { unsub, recorder });
  };

  const handleLifecycle = (channel: string) => (data: unknown) => {
    const d = data as LifecycleEvent;
    if (!d || typeof d !== 'object' || !d.id) return;
    const isDone = channel === 'subagents:completed' || channel === 'subagents:failed';

    const managerRecord = peekManagerRecord(d.id);
    const record = syncRecord(d)!;
    // 记录 sessionFile 供跨回合 resume 追问重开同一上下文
    if (managerRecord?.sessionFile) {
      sessionFiles.set(d.id, {
        sessionFile: managerRecord.sessionFile,
        subagentId: record.subagentId,
        task: record.task,
      });
    }

    if (channel === 'subagents:started' && managerRecord?.session) {
      attachToolListener(d.id, managerRecord.session);
    }

    // stopped/aborted 均映射为 'stopped'（用户主动停止单个子代理）
    const status: SubagentRunRecord['status'] = isDone
      ? channel === 'subagents:failed'
        ? d.status === 'stopped' || d.status === 'aborted' ? 'stopped' : 'error'
        : 'done'
      : 'running';
    record.status = status;
    if (typeof d.durationMs === 'number') record.durationMs = d.durationMs;
    if (typeof d.toolUses === 'number') record.toolCount = d.toolUses;
    if (isDone) {
      const full = String(d.result || d.error || '');
      if (full) {
        record.replyFull = full;
        record.replyPreview = full.slice(0, 200);
      }
      record.currentTool = undefined;
      const listener = toolListeners.get(d.id);
      if (listener) {
        listener.unsub();
        listener.recorder.markThinkingDone();
        toolListeners.delete(d.id);
      }
    }

    // 推流给 Hub（含 toolCalls / steers / replyFull 全量字段）
    try {
      sink.subagent(
        sessionId,
        botId,
        toSubagentPayload(record, { error: channel === 'subagents:failed' && d.error ? d.error : undefined }),
      );
      // 同步发一条 tool 状态摘要供卡片行内展示
      sink.tool(sessionId, botId, {
        toolName: `subagent:${record.subagentId}`,
        toolStatus: isDone ? 'done' : 'running',
        toolSummary: `${isDone ? (record.status === 'error' ? '[失败] ' : record.status === 'stopped' ? '[已停止] ' : '[完成] ') : ''}${record.phase ? `[${record.phase}] ` : ''}${record.task}${isDone && typeof d.durationMs === 'number' ? ` · ${Math.round(d.durationMs / 1000)}s` : ''}`,
      });
    } catch {
      // 推流失败不影响回合
    }
  };

  const handleSteered = (data: unknown) => {
    const d = data as { id?: string; message?: string };
    if (!d || typeof d !== 'object' || !d.id || typeof d.message !== 'string') return;
    const record = runs.get(d.id);
    if (!record) return;
    record.steers ??= [];
    record.steers.push({ message: d.message, timestamp: new Date().toISOString() });
    emit(record);
  };

  // 事件总线来自资源加载器（pi-subagents 扩展挂载）；主 BOT 未挂载时静默不生效
  const eventBus = (resourceLoader as unknown as {
    eventBus?: { on: (channel: string, handler: (data: unknown) => void) => () => void };
  }).eventBus;
  if (!eventBus) return undefined;

  const unsubs = [
    ...['subagents:created', 'subagents:started', 'subagents:completed', 'subagents:failed'].map((ch) =>
      eventBus.on(ch, handleLifecycle(ch)),
    ),
    eventBus.on('subagents:steered', handleSteered),
  ];

  return {
    runs,
    emit,
    dispose() {
      unsubs.forEach((u) => u());
      for (const { unsub, recorder } of toolListeners.values()) {
        unsub();
        recorder.markThinkingDone();
      }
      toolListeners.clear();
    },
  };
}
