import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SubagentRunRecord, ToolCallRecord, TurnBlock } from '@botd/protocol';
import { api } from '../api';
import { onGlobalEvent } from '../events';

/**
 * Super-agent 全双工后台工作单元（Worker / Workflow / Speculative）状态管理。
 *
 * 数据来源按优先级合并：
 * 1. 专用 workers 端点（GET /api/sessions/:id/workers，权威数据源）
 * 2. 既有 subagents 列表端点 / 最近已落库消息中的 subagentRuns（优雅回退）
 * 3. SSE `subagent_status` 实时事件（与 1/2 以 workerId 对齐热更新）
 *
 * 控制指令（steer / stop / spawn）先打专用 workers 端点，失败时回退到
 * 既有 subagents 的 interact / stop 端点，保证新旧后端都能驱动。
 */

/** 后台工作单元类型：worker（常驻工作器）/ workflow（工作流）/ speculative（投机预执行） */
export type SuperAgentWorkerKind = 'worker' | 'workflow' | 'speculative';

/** 后台工作单元状态机：pending → running ⇄ waiting → completed / failed / aborted */
export type SuperAgentWorkerStatus =
  | 'pending'
  | 'running'
  | 'waiting'
  | 'completed'
  | 'failed'
  | 'aborted';

/** 全双工指令模式：steer（运行中插话）/ followUp（结束后继续追问） */
export type SuperAgentWorkerSteerMode = 'steer' | 'followUp';

export interface SuperAgentWorkerItem {
  workerId: string;
  /** 该 worker 对应的独立子会话（workflow 步骤派生；本地 worker 为空字符串） */
  conversationId: string;
  parentSessionId: string;
  botId: string;
  botName?: string;
  title: string;
  kind: SuperAgentWorkerKind;
  status: SuperAgentWorkerStatus;
  /** 执行所在计算节点 */
  nodeId?: string;
  cwd?: string;
  /** Git worktree 隔离目录（独立分支执行） */
  worktreePath?: string;
  /** 订阅的直通线程键（Pass-through 路由，如 github:pr#42） */
  threadKeys?: string[];
  /** 工作流当前阶段（如 Verify） */
  phase?: string;
  currentTool?: string;
  toolUses?: number;
  startedAt: string;
  updatedAt?: string;
  summary?: string;
  /** 交错执行时间线（思考/工具/文本，与主对话 blocks 同构） */
  blocks?: TurnBlock[];
  toolCalls?: ToolCallRecord[];
  /** 历次人工指令（steer / followUp） */
  steers?: { message: string; createdAt: string }[];
}

export interface SpawnBackgroundWorkerInput {
  title: string;
  task: string;
  worktree?: boolean;
  threadKey?: string;
}

export interface UseSuperAgentWorkersResult {
  /** 本会话全部后台工作单元：活跃（pending/running/waiting）在前，其后按最近更新倒序 */
  workers: SuperAgentWorkerItem[];
  activeCount: number;
  selectedWorker: SuperAgentWorkerItem | null;
  setSelectedWorkerId: (id: string | null) => void;
  steerWorker: (
    workerId: string,
    message: string,
    mode?: SuperAgentWorkerSteerMode
  ) => Promise<boolean>;
  stopWorker: (workerId: string) => Promise<boolean>;
  spawnBackgroundWorker: (input: SpawnBackgroundWorkerInput) => Promise<boolean>;
}

/** pending / running / waiting 视为活跃（计入全双工运行中徽标与轮询加速） */
export function isWorkerActive(status: SuperAgentWorkerStatus): boolean {
  return status === 'pending' || status === 'running' || status === 'waiting';
}

/** 活跃时秒表走表，终态冻结在 updatedAt；mm:ss，超 1 小时为 h:mm:ss */
export function formatWorkerElapsed(
  worker: Pick<SuperAgentWorkerItem, 'startedAt' | 'updatedAt' | 'status'>,
  now: number = Date.now()
): string {
  const start = Date.parse(worker.startedAt || '');
  if (!Number.isFinite(start)) return '--:--';
  const parsedEnd = Date.parse(worker.updatedAt || '');
  const end = isWorkerActive(worker.status) || !Number.isFinite(parsedEnd) ? now : parsedEnd;
  const totalSeconds = Math.max(0, Math.floor((end - start) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const mm = String(minutes).padStart(2, '0');
  const ss = String(seconds).padStart(2, '0');
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

type WorkerMap = Map<string, SuperAgentWorkerItem>;

/** 排序时间锚点：优先 updatedAt，缺失时回落 startedAt */
function workerTime(worker: SuperAgentWorkerItem): number {
  const time = Date.parse(worker.updatedAt || worker.startedAt || '');
  return Number.isFinite(time) ? time : 0;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

/** 兼容状态归一：专用端点六态 + 既有 SubagentRunRecord 四态（done/error/stopped/queued） */
function normalizeStatus(value: unknown): SuperAgentWorkerStatus {
  switch (value) {
    case 'pending':
    case 'running':
    case 'waiting':
    case 'completed':
    case 'failed':
    case 'aborted':
      return value;
    case 'queued':
      return 'pending';
    case 'done':
    case 'success':
      return 'completed';
    case 'error':
      return 'failed';
    case 'stopped':
    case 'cancelled':
    case 'canceled':
      return 'aborted';
    default:
      return 'completed';
  }
}

function normalizeKind(value: unknown): SuperAgentWorkerKind {
  if (value === 'workflow' || value === 'speculative') return value;
  return 'worker';
}

/**
 * 任意记录 → 规范 SuperAgentWorkerItem：
 * 同时兼容专用 /workers 端点载荷与既有 SubagentRunRecord 字段名。
 */
function normalizeWorker(raw: unknown, parentSessionId: string): SuperAgentWorkerItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const workerId = str(record.workerId) ?? str(record.id) ?? str(record.runId);
  if (!workerId) return null;

  const childSessionId = str(record.childSessionId);
  const threadKeys = Array.isArray(record.threadKeys)
    ? record.threadKeys.filter((key): key is string => typeof key === 'string' && Boolean(key))
    : undefined;
  const toolUses =
    typeof record.toolUses === 'number'
      ? record.toolUses
      : typeof record.toolCount === 'number'
        ? record.toolCount
        : undefined;
  const steers = Array.isArray(record.steers)
    ? record.steers
        .filter(
          (item): item is { message: string; timestamp?: string; createdAt?: string } =>
            Boolean(item) && typeof (item as { message?: unknown }).message === 'string'
        )
        .map((item) => ({
          message: item.message,
          createdAt: str(item.createdAt) ?? str(item.timestamp) ?? '',
        }))
    : undefined;

  return {
    workerId,
    conversationId: str(record.conversationId) ?? childSessionId ?? '',
    parentSessionId,
    botId: str(record.botId) ?? str(record.subagentId) ?? '',
    botName: str(record.botName) ?? str(record.subagentName),
    title: str(record.title) ?? str(record.task) ?? '后台任务',
    kind: normalizeKind(record.kind ?? (childSessionId ? 'workflow' : undefined)),
    status: normalizeStatus(record.status),
    nodeId: str(record.nodeId),
    cwd: str(record.cwd),
    worktreePath: str(record.worktreePath),
    threadKeys: threadKeys && threadKeys.length > 0 ? threadKeys : undefined,
    phase: str(record.phase),
    currentTool: str(record.currentTool),
    toolUses,
    startedAt: str(record.startedAt) ?? str(record.createdAt) ?? '',
    updatedAt: str(record.updatedAt),
    summary: str(record.summary) ?? str(record.replyPreview),
    blocks: Array.isArray(record.blocks) ? (record.blocks as TurnBlock[]) : undefined,
    toolCalls: Array.isArray(record.toolCalls) ? (record.toolCalls as ToolCallRecord[]) : undefined,
    steers,
  };
}

/** 轻量 JSON 请求：网络异常 / 非 2xx 一律收敛为 { ok: false }，由调用方回退 */
async function jsonRequest(
  path: string,
  init?: RequestInit
): Promise<{ ok: boolean; status: number; data: unknown }> {
  try {
    const response = await fetch(path, {
      credentials: 'include',
      ...init,
      ...(init?.body
        ? { headers: { 'Content-Type': 'application/json', ...(init.headers as Record<string, string> | undefined) } }
        : {}),
    });
    let data: unknown = null;
    try {
      data = await response.json();
    } catch {
      // 204 等空响应
    }
    return { ok: response.ok, status: response.status, data };
  } catch {
    return { ok: false, status: 0, data: null };
  }
}

/** 从列表载荷中提取 workers / runs 数组（兼容裸数组与 { workers: [] } 包装） */
function extractList(payload: unknown, listKey: 'workers' | 'runs'): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === 'object') {
    const wrapped = (payload as Record<string, unknown>)[listKey];
    if (Array.isArray(wrapped)) return wrapped;
  }
  return [];
}

export function useSuperAgentWorkers(sessionId: string | null): UseSuperAgentWorkersResult {
  const [workersMap, setWorkersMap] = useState<WorkerMap>(new Map());
  const [selectedWorkerId, setSelectedWorkerId] = useState<string | null>(null);

  // 回调内读取最新会话 / 工作单元快照，避免闭包过期
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;
  const workersMapRef = useRef(workersMap);
  workersMapRef.current = workersMap;

  /** 合并写入（按 workerId upsert）：新记录的非空字段覆盖旧值，数组整体以最新为准 */
  const upsertWorkers = useCallback((incoming: SuperAgentWorkerItem[]) => {
    if (incoming.length === 0) return;
    setWorkersMap((prev) => {
      const next = new Map(prev);
      for (const worker of incoming) {
        const existing = next.get(worker.workerId);
        if (!existing) {
          next.set(worker.workerId, worker);
          continue;
        }
        const patch = Object.fromEntries(
          Object.entries(worker).filter(([, value]) => value !== undefined && value !== '')
        ) as Partial<SuperAgentWorkerItem>;
        next.set(worker.workerId, { ...existing, ...patch });
      }
      return next;
    });
  }, []);

  /**
   * 刷新工作单元列表（三级回退）：
   * 专用 /workers → 既有 /subagents 列表 → 最近已落库消息的 subagentRuns。
   */
  const refresh = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (!sid) return;

    const collected = new Map<string, SuperAgentWorkerItem>();
    const ingest = (raw: unknown) => {
      const worker = normalizeWorker(raw, sid);
      if (worker) collected.set(worker.workerId, worker);
    };

    const dedicated = await jsonRequest(`/api/sessions/${encodeURIComponent(sid)}/workers`);
    if (dedicated.ok) {
      extractList(dedicated.data, 'workers').forEach(ingest);
    } else {
      const legacy = await jsonRequest(`/api/sessions/${encodeURIComponent(sid)}/subagents`);
      if (legacy.ok) {
        extractList(legacy.data, 'runs').forEach(ingest);
      } else {
        try {
          const page = await api.getSessionMessagesPage(sid, { limit: 30 });
          for (const message of page.messages) {
            (message.subagentRuns ?? []).forEach(ingest);
          }
        } catch {
          // 拉取失败保持现状，等待下一轮轮询 / SSE 事件
        }
      }
    }

    upsertWorkers(Array.from(collected.values()));
  }, [upsertWorkers]);

  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  // 会话切换：清空状态并立即探测一次
  useEffect(() => {
    setWorkersMap(new Map());
    setSelectedWorkerId(null);
    if (sessionId) void refreshRef.current();
  }, [sessionId]);

  // SSE：本会话 subagent_status 事件实时热更新对应工作单元
  useEffect(() => {
    if (!sessionId) return;
    const unsubscribe = onGlobalEvent((event) => {
      if (event.type !== 'subagent_status' || event.sessionId !== sessionId) return;
      const worker = normalizeWorker(event.run as SubagentRunRecord, sessionId);
      if (worker) upsertWorkers([worker]);
    });
    return unsubscribe;
  }, [sessionId, upsertWorkers]);

  const activeCount = useMemo(
    () => Array.from(workersMap.values()).filter((worker) => isWorkerActive(worker.status)).length,
    [workersMap]
  );

  // 轮询兜底：存在活跃工作单元时 5s，全空闲时 30s；页面隐藏时跳过
  useEffect(() => {
    if (!sessionId) return;
    const timer = window.setInterval(
      () => {
        if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
        void refreshRef.current();
      },
      activeCount > 0 ? 5000 : 30000
    );
    return () => window.clearInterval(timer);
  }, [sessionId, activeCount > 0]);

  /** 本地追加人工指令记录（后端 SSE 确认前先乐观展示） */
  const appendLocalSteer = useCallback((workerId: string, message: string) => {
    setWorkersMap((prev) => {
      const existing = prev.get(workerId);
      if (!existing) return prev;
      const next = new Map(prev);
      next.set(workerId, {
        ...existing,
        steers: [...(existing.steers ?? []), { message, createdAt: new Date().toISOString() }],
      });
      return next;
    });
  }, []);

  /** 本地标记中止（节点流事件随后到达作准） */
  const markAborted = useCallback((workerId: string) => {
    setWorkersMap((prev) => {
      const existing = prev.get(workerId);
      if (!existing) return prev;
      const next = new Map(prev);
      next.set(workerId, {
        ...existing,
        status: 'aborted',
        currentTool: undefined,
        updatedAt: new Date().toISOString(),
      });
      return next;
    });
  }, []);

  /**
   * 向后台工作单元发送指令：
   * 运行中默认 steer（插话，不打断执行），已结束默认 followUp（同一上下文继续）。
   * 专用 /workers/:id/steer 失败时回退既有 /subagents/:id/interact。
   */
  const steerWorker = useCallback(
    async (workerId: string, message: string, mode?: SuperAgentWorkerSteerMode): Promise<boolean> => {
      const sid = sessionIdRef.current;
      const text = message.trim();
      if (!sid || !workerId || !text) return false;

      const current = workersMapRef.current.get(workerId);
      const effectiveMode: SuperAgentWorkerSteerMode =
        mode ?? (current && isWorkerActive(current.status) ? 'steer' : 'followUp');

      const dedicated = await jsonRequest(
        `/api/sessions/${encodeURIComponent(sid)}/workers/${encodeURIComponent(workerId)}/steer`,
        { method: 'POST', body: JSON.stringify({ message: text, mode: effectiveMode }) }
      );
      if (dedicated.ok) {
        appendLocalSteer(workerId, text);
        return true;
      }

      try {
        await api.interactSubagent(sid, workerId, {
          message: text,
          mode: effectiveMode === 'followUp' ? 'resume' : 'steer',
        });
        appendLocalSteer(workerId, text);
        return true;
      } catch {
        return false;
      }
    },
    [appendLocalSteer]
  );

  /** 中止单个后台工作单元（不影响前台对话）。专用端点失败时回退既有 /subagents/:id/stop */
  const stopWorker = useCallback(
    async (workerId: string): Promise<boolean> => {
      const sid = sessionIdRef.current;
      if (!sid || !workerId) return false;

      const dedicated = await jsonRequest(
        `/api/sessions/${encodeURIComponent(sid)}/workers/${encodeURIComponent(workerId)}/stop`,
        { method: 'POST', body: JSON.stringify({}) }
      );
      if (dedicated.ok) {
        markAborted(workerId);
        return true;
      }

      try {
        await api.stopSubagent(sid, workerId);
        markAborted(workerId);
        return true;
      } catch {
        return false;
      }
    },
    [markAborted]
  );

  /** 派生新的后台工作单元（可选 worktree 隔离与 threadKey 直通订阅） */
  const spawnBackgroundWorker = useCallback(async (input: SpawnBackgroundWorkerInput): Promise<boolean> => {
    const sid = sessionIdRef.current;
    if (!sid || !input.title.trim() || !input.task.trim()) return false;

    const result = await jsonRequest(`/api/sessions/${encodeURIComponent(sid)}/workers`, {
      method: 'POST',
      body: JSON.stringify({
        title: input.title.trim(),
        task: input.task.trim(),
        ...(input.worktree !== undefined ? { worktree: input.worktree } : {}),
        ...(input.threadKey ? { threadKey: input.threadKey } : {}),
      }),
    });
    if (!result.ok) return false;

    await refreshRef.current();
    return true;
  }, []);

  const workers = useMemo(() => {
    const list = Array.from(workersMap.values());
    list.sort((a, b) => {
      const rankDiff = Number(isWorkerActive(b.status)) - Number(isWorkerActive(a.status));
      if (rankDiff !== 0) return rankDiff;
      return workerTime(b) - workerTime(a);
    });
    return list;
  }, [workersMap]);

  const selectedWorker = useMemo(
    () => workers.find((worker) => worker.workerId === selectedWorkerId) ?? null,
    [workers, selectedWorkerId]
  );

  return {
    workers,
    activeCount,
    selectedWorker,
    setSelectedWorkerId,
    steerWorker,
    stopWorker,
    spawnBackgroundWorker,
  };
}
