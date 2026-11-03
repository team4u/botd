import type { TurnBlock } from '@botd/protocol';

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
  updatedAt: number;
}

export interface StreamingAssistantState {
  botId: string;
  delta: string;
  tools: ToolExecutionState[];
  blocks?: TurnBlock[];
}
