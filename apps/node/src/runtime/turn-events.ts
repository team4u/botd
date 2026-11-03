import type { AgentSession } from '@earendil-works/pi-coding-agent';
import type { ToolCallRecord, TurnBlock } from '@botd/protocol';
import { extractToolSummary, extractToolOutputPreview, extractToolUiSpec, sanitizeToolArgs } from './tool-preview.js';

/**
 * 会话事件记录器：订阅 AgentSession 事件流，把思考 / 文本 / 工具调用整理成
 * 交错时间线 blocks 与 toolCalls 列表，并通过回调实时外发。
 *
 * 同一套记录器服务三条路径——主会话回合、子代理（subagent）时间线、跨回合 resume 追问——
 * 记录器只往传入的目标数组写入，输出位置由调用方决定。
 */

/** 记录输出目标：主会话用独立数组，子代理用 run 记录上的 blocks / toolCalls */
export interface RecorderTarget {
  blocks: TurnBlock[];
  toolCalls: ToolCallRecord[];
}

export interface TurnEventRecorderOptions {
  /** 思考事件回调（供主会话推流；子代理路径不需要） */
  onThinking?: (payload: { delta?: string; status: 'running' | 'done'; durationMs?: number }) => void;
  /** 文本增量回调（仅主会话推流使用） */
  onText?: (delta: string) => void;
  /** 工具事件回调（主会话推流 / 子代理记录刷新） */
  onTool?: (payload: { status: 'running' | 'done' | 'error'; toolCall: ToolCallRecord; outputPreview?: string; durationMs?: number }) => void;
  /**
   * 跨 assistant 消息的文本是否补段落分隔（\n\n）。
   * 主会话直连公屏需要；子代理时间线按块原样拼接，不需要。
   */
  paragraphBetweenMessages?: boolean;
  /**
   * 文本块是否在 assistant 消息结束时封口（下一条消息另起一块）。
   * 子代理时间线用（原始行为：message_end 打 closed 标记）；主会话不用。
   */
  splitTextBlocksOnMessageEnd?: boolean;
}

interface RunningToolEntry {
  index: number;
  blockIndex: number;
  startMs: number;
  summary?: string;
  args?: Record<string, unknown>;
}

export class TurnEventRecorder {
  private readonly target: RecorderTarget;
  private readonly opts: TurnEventRecorderOptions & { paragraphBetweenMessages: boolean };
  private readonly runningTools = new Map<string, RunningToolEntry>();
  private readonly runningBlocks = new Map<string, Extract<TurnBlock, { type: 'tool' }>>();
  private thinkingStartMs: number | null = null;
  private thinkingBlock: Extract<TurnBlock, { type: 'thinking' }> | null = null;
  /** 文本块封口标记（splitTextBlocksOnMessageEnd 用） */
  private textBlockClosed = false;

  // 跨 assistant 消息的文本补段落分隔只能依赖 message_start 事件标记边界。
  // 严禁用 event.message 引用比较判定“新消息”——pi 每次 message_update 都会传
  // 新快照对象（引用必然不同），会把同一条消息的相邻 chunk 误判成两条消息，
  // 在 chunk 之间插入 \n\n，撕裂 markdown 块级结构（blockquote/表格/代码块被拦腰截断）。
  private hasPriorAssistantText = false;
  private currentAssistantHasText = false;

  constructor(target: RecorderTarget, opts: TurnEventRecorderOptions = {}) {
    this.target = target;
    this.opts = { paragraphBetweenMessages: false, splitTextBlocksOnMessageEnd: false, ...opts };
  }

  /** 订阅会话；返回取消函数 */
  attach(session: AgentSession): () => void {
    return session.subscribe((event: any) => this.handle(event));
  }

  /** 直接处理单个事件（子代理路径按事件逐个投递） */
  handle(event: unknown): void {
    const e = event as any;
    if (e.type === 'message_start') {
      if (e.message?.role === 'assistant') {
        if (this.currentAssistantHasText) {
          this.hasPriorAssistantText = true;
        }
        this.currentAssistantHasText = false;
      }
      return;
    }
    if (e.type === 'message_end') {
      if (e.message?.role === 'assistant' && this.opts.splitTextBlocksOnMessageEnd) {
        this.markThinkingDone();
        this.textBlockClosed = true;
      }
      return;
    }
    if (e.type === 'message_update') {
      const ame = e.assistantMessageEvent;
      if (!ame) return;
      if (ame.type === 'thinking_start') {
        this.beginThinking('');
      } else if (ame.type === 'thinking_delta' && ame.delta) {
        this.beginThinking(ame.delta);
      } else if (ame.type === 'thinking_end') {
        this.closeThinking();
      } else if (ame.type === 'text_delta' && ame.delta) {
        this.appendText(ame.delta);
      }
      return;
    }
    if (e.type === 'tool_execution_start') {
      this.closeThinking();
      this.beginTool(e);
      return;
    }
    if (e.type === 'tool_execution_end') {
      this.closeThinking();
      this.endTool(e);
      return;
    }
  }

  /** 结束仍处于 running 的思考块（取消 / 收尾路径统一调用） */
  markThinkingDone(): void {
    if (this.thinkingBlock && this.thinkingBlock.status === 'running') {
      this.thinkingBlock.status = 'done';
      this.thinkingBlock.durationMs = Math.max(1, Date.now() - (this.thinkingStartMs ?? Date.now()));
      this.opts.onThinking?.({ status: 'done', durationMs: this.thinkingBlock.durationMs });
    }
    this.thinkingBlock = null;
    this.thinkingStartMs = null;
  }

  /**
   * 用户中止收尾：running 工具标记为 cancelled 并补全时长，保留已产生的部分输出。
   */
  markCancelled(now = Date.now()): void {
    for (const tc of this.target.toolCalls) {
      if (tc.status === 'running') tc.status = 'cancelled';
    }
    for (const b of this.target.blocks) {
      if (b.type === 'tool' && b.status === 'running') b.status = 'cancelled';
    }
    for (const [key, running] of this.runningTools.entries()) {
      const tc = this.target.toolCalls[running.index];
      if (tc && tc.status === 'cancelled' && tc.durationMs === undefined) {
        tc.durationMs = Math.max(0, now - running.startMs);
      }
      const block = this.target.blocks[running.blockIndex];
      if (block && block.type === 'tool' && block.status === 'cancelled' && block.durationMs === undefined) {
        block.durationMs = Math.max(0, now - running.startMs);
      }
      this.runningTools.delete(key);
    }
  }

  private beginThinking(initialDelta: string): void {
    if (!this.thinkingBlock || this.thinkingBlock.status !== 'running') {
      this.thinkingStartMs = Date.now();
      this.thinkingBlock = { type: 'thinking', thinking: initialDelta, status: 'running' };
      this.target.blocks.push(this.thinkingBlock);
    } else if (initialDelta) {
      this.thinkingBlock.thinking += initialDelta;
    }
    this.opts.onThinking?.({ status: 'running', ...(initialDelta ? { delta: initialDelta } : {}) });
  }

  private closeThinking(): void {
    // 静默收尾（不外发 done 事件的内部调用点由 markThinkingDone 覆盖推流场景）
    this.markThinkingDone();
  }

  private appendText(delta: string): void {
    this.markThinkingDone();
    let effective = delta;
    // 仅在跨 assistant 消息边界（由 message_start 标记）为首个 chunk 补段落分隔；
    // 同一消息内的 chunk 原样透传，不得插入任何字符。
    if (this.opts.paragraphBetweenMessages && this.hasPriorAssistantText && !this.currentAssistantHasText && effective) {
      if (effective.startsWith('\n\n')) {
        // Already starts with double newline
      } else if (effective.startsWith('\n')) {
        effective = `\n${effective}`;
      } else {
        effective = `\n\n${effective}`;
      }
    }
    if (!effective) return;
    this.currentAssistantHasText = true;
    const last = this.target.blocks[this.target.blocks.length - 1];
    if (last && last.type === 'text' && !(this.opts.splitTextBlocksOnMessageEnd && this.textBlockClosed)) {
      last.text += effective;
    } else {
      this.target.blocks.push({ type: 'text', text: effective });
      this.textBlockClosed = false;
    }
    this.opts.onText?.(effective);
  }

  private beginTool(event: any): void {
    const toolName = event.toolName as string;
    const rawArgs = event.args ?? event.input;
    const summary = extractToolSummary(toolName, rawArgs);
    const sanitizedArgs = sanitizeToolArgs(rawArgs);
    const key = event.toolCallId || `${toolName}_${this.target.toolCalls.length}`;
    const index = this.target.toolCalls.length;
    this.target.toolCalls.push({
      id: key,
      name: toolName,
      ...(sanitizedArgs ? { args: sanitizedArgs } : {}),
      ...(summary ? { summary } : {}),
      status: 'running',
    });
    const blockIndex = this.target.blocks.length;
    const toolBlock: Extract<TurnBlock, { type: 'tool' }> = {
      type: 'tool',
      id: key,
      name: toolName,
      ...(sanitizedArgs ? { args: sanitizedArgs } : {}),
      ...(summary ? { summary } : {}),
      status: 'running',
    };
    this.target.blocks.push(toolBlock);
    this.runningBlocks.set(key, toolBlock);
    this.runningTools.set(key, { index, blockIndex, startMs: Date.now(), summary, args: sanitizedArgs });
    this.opts.onTool?.({ status: 'running', toolCall: this.target.toolCalls[index] });
  }

  private endTool(event: any): void {
    const toolName = event.toolName as string;
    const key: string = event.toolCallId || toolName;
    let running = this.runningTools.get(key);
    if (running) {
      this.runningTools.delete(key);
    } else {
      // toolCallId 缺失或订阅建立前开始的调用：按工具名前缀兜底匹配
      for (const [k, r] of this.runningTools.entries()) {
        if (k.startsWith(`${toolName}_`) || k === toolName) {
          running = r;
          this.runningTools.delete(k);
          break;
        }
      }
    }
    const isError = Boolean(event.isError);
    const rawOutput = event.result !== undefined ? event.result : event.output;
    const outputPreview = extractToolOutputPreview(rawOutput, isError);
    const uiSpec = extractToolUiSpec(rawOutput);
    const durationMs = running ? Math.max(0, Date.now() - running.startMs) : undefined;

    const entry = running
      ? this.target.toolCalls[running.index]
      : [...this.target.toolCalls].reverse().find((tc) => tc.id === key || tc.name === toolName);
    if (entry) {
      entry.status = isError ? 'error' : 'done';
      if (durationMs !== undefined) entry.durationMs = durationMs;
      entry.isError = isError;
      if (outputPreview) entry.outputPreview = outputPreview;
      if (uiSpec) entry.uiSpec = uiSpec;
      // 无 start 记录时重新提取摘要/参数（与原实现一致：兜底路径补齐展示字段）
      if (!running && entry) {
        const rawArgs = event.args ?? event.input;
        if (!entry.summary) entry.summary = extractToolSummary(toolName, rawArgs);
        if (!entry.args) entry.args = sanitizeToolArgs(rawArgs);
      }
    }

    const block = running
      ? this.target.blocks[running.blockIndex]
      : this.runningBlocks.get(key) ??
        [...this.target.blocks].reverse().find(
          (b) => b.type === 'tool' && (b.id === key || b.name === toolName) && b.status === 'running',
        );
    if (block && block.type === 'tool') {
      block.status = isError ? 'error' : 'done';
      if (durationMs !== undefined) block.durationMs = durationMs;
      block.isError = isError;
      if (outputPreview) block.outputPreview = outputPreview;
      if (uiSpec) block.uiSpec = uiSpec;
    }
    this.runningBlocks.delete(key);

    const emitted: ToolCallRecord = entry ?? {
      id: key,
      name: toolName,
      ...(running?.summary ? { summary: running.summary } : {}),
      ...(running?.args ? { args: running.args } : {}),
      status: isError ? 'error' : 'done',
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(outputPreview ? { outputPreview } : {}),
      ...(uiSpec ? { uiSpec } : {}),
      isError,
    };
    this.opts.onTool?.({ status: isError ? 'error' : 'done', toolCall: emitted, outputPreview, durationMs });
  }
}
