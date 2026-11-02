import type { BotConfig, NodeRecord, TurnBlock } from '@botd/protocol';

export type MainViewTab = 'chat' | 'nodes';

/** 登录用户信息（与 Hub /api/auth/* 契约一致；协议包尚未发布，前端先行定义） */
export interface UserInfo {
  id: string;
  username: string;
  role: 'admin' | 'member';
  createdAt: string;
}

export interface ToastItem {
  id: string;
  type: 'success' | 'error' | 'info';
  message: string;
}

export interface ToolExecutionState {
  id?: string;
  toolName: string;
  status: 'running' | 'done' | 'error' | 'cancelled';
  summary?: string;
  args?: Record<string, unknown>;
  outputPreview?: string;
  durationMs?: number;
  isError?: boolean;
  updatedAt: number;
}

export interface StreamingAssistantState {
  botId: string;
  delta: string;
  tools: ToolExecutionState[];
  blocks?: TurnBlock[];
}

export interface BotWithNode extends BotConfig {
  nodeName?: string;
  nodeStatus?: NodeRecord['status'];
}

export type {
  ArtifactRecord,
  MessageAttachment,
  MessageRecord,
  PendingAskRecord,
  SessionRecord,
  SessionStatus,
  TriggerKind,
  TriggerRecord,
  CreateTriggerInput,
  TurnBlock,
} from '@botd/protocol';

