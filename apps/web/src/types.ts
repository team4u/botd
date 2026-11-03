import type { BotConfig, BotdUiSpec, NodeRecord, TurnBlock } from '@botd/protocol';

export type MainViewTab = 'chat' | 'nodes';

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
  /** 工具自定义视图插槽（tool.view）：流式 tool_status 事件携带的合法 BotdUiSpec */
  uiSpec?: BotdUiSpec;
  updatedAt: number;
}

export interface StreamingAssistantState {
  botId: string;
  delta: string;
  tools: ToolExecutionState[];
  blocks?: TurnBlock[];
}

/** 扩展挂件（composer.widget 插槽）：输入框上方/下方的常驻声明式 UI 或文本行 */
export interface ExtensionWidgetState {
  key: string;
  botId: string;
  lines?: string[];
  uiSpec?: BotdUiSpec;
  placement: 'aboveEditor' | 'belowEditor';
  updatedAt: number;
}

/** 会话级扩展 UI 状态（ctx.ui 桥接）：status 徽标 / workingMessage / 常驻挂件 */
export interface SessionExtensionUiState {
  /** key -> statusText */
  statuses: Record<string, { botId: string; text: string }>;
  /** botId -> workingMessage */
  workingMessages: Record<string, string>;
  /** key -> widget */
  widgets: Record<string, ExtensionWidgetState>;
}

export const EMPTY_EXTENSION_UI_STATE: SessionExtensionUiState = {
  statuses: {},
  workingMessages: {},
  widgets: {},
};

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
