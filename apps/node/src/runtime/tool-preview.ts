import type { ToolCallRecord, TurnBlock } from '@botd/protocol';

/**
 * 工具调用记录的摘要提取与脱敏：从工具参数 / 输出中提炼出适合落库与流式展示的短文本。
 * 全部为纯函数，供主会话、分身时间线与 resume 追问三条路径共用。
 */

const SUMMARY_MAX_CHARS = 120;
const PREVIEW_MAX_CHARS = 4000;
const PREVIEW_HEAD_CHARS = 2200;
const PREVIEW_TAIL_CHARS = 1500;
const VALUE_MAX_DEPTH = 5;

export function extractToolSummary(toolName: string, args: any): string | undefined {
  if (!args || typeof args !== 'object') return undefined;
  if (toolName === 'bash' && typeof args.command === 'string') {
    return args.command.replace(/\s+/g, ' ').trim().slice(0, SUMMARY_MAX_CHARS);
  }
  if (['read', 'write', 'edit'].includes(toolName) && typeof args.path === 'string') {
    return args.path;
  }
  if (toolName === 'Agent') {
    const subType = args.subagent_type ?? 'agent';
    const desc = args.description ?? '';
    return desc ? `${subType}: ${desc}`.trim().slice(0, SUMMARY_MAX_CHARS) : `${subType}`;
  }
  if (toolName === 'SubagentWorkflow') {
    const summary = args.description || args.name;
    if (typeof summary === 'string') {
      return summary.replace(/\s+/g, ' ').trim().slice(0, SUMMARY_MAX_CHARS);
    }
  }
  for (const value of Object.values(args)) {
    if (typeof value === 'string') {
      const compact = value.replace(/\s+/g, ' ').trim().slice(0, 100);
      if (compact) return compact;
    }
  }
  return undefined;
}

export function extractToolOutputPreview(result: any, _isError?: boolean): string | undefined {
  if (result === null || result === undefined) return undefined;

  let rawText = '';
  if (typeof result === 'string') {
    rawText = result;
  } else if (Array.isArray(result.content)) {
    rawText = result.content
      .map((part: any) => (typeof part === 'string' ? part : part?.text || ''))
      .filter(Boolean)
      .join('\n');
  } else if (typeof result.error === 'string') {
    rawText = result.error;
  } else if (result.error && typeof result.error === 'object') {
    rawText = result.error.message || JSON.stringify(result.error);
  } else if (typeof result.errorMessage === 'string') {
    rawText = result.errorMessage;
  } else if (typeof result.message === 'string') {
    rawText = result.message;
  } else if (typeof result.output === 'string') {
    rawText = result.output;
  } else if (typeof result.stdout === 'string' || typeof result.stderr === 'string') {
    rawText = [result.stderr, result.stdout].filter(Boolean).join('\n');
  } else if (typeof result.details === 'string') {
    rawText = result.details;
  } else if (result instanceof Error) {
    rawText = result.stack || result.message;
  } else {
    try {
      rawText = JSON.stringify(result);
    } catch {
      rawText = String(result);
    }
  }

  const trimmed = rawText.trim();
  if (!trimmed) return undefined;

  if (trimmed.length <= PREVIEW_MAX_CHARS) return trimmed;
  return `${trimmed.slice(0, PREVIEW_HEAD_CHARS)}\n...\n${trimmed.slice(-PREVIEW_TAIL_CHARS)}`;
}

export function sanitizeToolArgs(args: any, depth = 0): Record<string, unknown> | undefined {
  if (!args || typeof args !== 'object' || Array.isArray(args) || depth > VALUE_MAX_DEPTH) return undefined;
  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(args)) {
    result[key] = sanitizeToolValue(val, depth + 1);
  }
  return result;
}

function sanitizeToolValue(val: any, depth: number): unknown {
  if (typeof val === 'string') {
    if (val.length > PREVIEW_MAX_CHARS) {
      return val.slice(0, PREVIEW_MAX_CHARS) + '...(truncated)';
    }
    return val;
  }
  if (Array.isArray(val)) {
    if (depth > VALUE_MAX_DEPTH) return val.slice(0, 50);
    return val.slice(0, 100).map((item) => sanitizeToolValue(item, depth + 1));
  }
  if (val !== null && typeof val === 'object') {
    if (depth > VALUE_MAX_DEPTH) return val;
    const obj: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val)) {
      obj[k] = sanitizeToolValue(v, depth + 1);
    }
    return obj;
  }
  return val;
}

/** 供 blocks 兜底重建：从 toolCalls 生成 tool 块（与流式块同构） */
export function toolBlockFromRecord(tc: ToolCallRecord, index: number): Extract<TurnBlock, { type: 'tool' }> {
  return {
    type: 'tool',
    id: tc.id || `${tc.name}_${index}`,
    name: tc.name,
    ...(tc.args ? { args: tc.args } : {}),
    ...(tc.summary ? { summary: tc.summary } : {}),
    status: tc.status,
    ...(tc.durationMs !== undefined ? { durationMs: tc.durationMs } : {}),
    ...(tc.outputPreview !== undefined ? { outputPreview: tc.outputPreview } : {}),
    ...(tc.isError !== undefined ? { isError: tc.isError } : {}),
  };
}
