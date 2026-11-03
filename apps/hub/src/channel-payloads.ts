import { createHmac } from 'node:crypto';
import type { NotificationChannelKind, NotificationEventKind, SessionSseEvent } from '@botd/protocol';
import { validateUiSpec } from '@botd/protocol';
import { signAskToken } from './ask-callback.js';

/** 声明式 UI ask 的降级摘要：从 BotdUiSpec 提取文本渠道可消费的摘要与按钮 */
export interface AskUiSummary {
  summaryLines: string[];
  buttons: string[];
  hasFormInputs: boolean;
}

/**
 * 从 previewType='ui' 的 ask 预览中提取降级摘要（飞书/Slack/Telegram 等文本渠道用）：
 * - Callout → [标题或变体] 正文；KeyValueList → 每项 key: value
 * - 表单控件（TextInput/Select/Switch/CheckboxGroup）→ [表单项] 标签，并标记 hasFormInputs
 * - Button → 按钮文案（去重），供纯按钮审批卡生成免登录一键确认链接
 * 非法 spec 静默降级为 undefined，不影响原有 options 渲染。
 */
export function extractAskUiSummary(previewType?: string, previewContent?: string): AskUiSummary | undefined {
  if (previewType !== 'ui' || !previewContent || !previewContent.trim()) return undefined;
  const validation = validateUiSpec(previewContent);
  if (!validation.ok) return undefined;

  const summaryLines: string[] = [];
  const buttons: string[] = [];
  let hasFormInputs = false;

  for (const el of Object.values(validation.spec.elements)) {
    const props = (el.props ?? {}) as Record<string, any>;
    switch (el.type) {
      case 'Callout': {
        const title = typeof props.title === 'string' && props.title
          ? props.title
          : typeof props.variant === 'string' && props.variant
            ? props.variant
            : '提示';
        if (typeof props.content === 'string') summaryLines.push(`[${title}] ${props.content}`);
        break;
      }
      case 'KeyValueList':
        if (Array.isArray(props.items)) {
          for (const item of props.items) {
            if (item && typeof item === 'object' && typeof item.key === 'string') {
              summaryLines.push(`${item.key}: ${String(item.value ?? '')}`);
            }
          }
        }
        break;
      case 'TextInput':
      case 'Select':
      case 'Switch':
      case 'CheckboxGroup':
        if (typeof props.label === 'string') summaryLines.push(`[表单项] ${props.label}`);
        hasFormInputs = true;
        break;
      case 'Button':
        if (typeof props.label === 'string' && !buttons.includes(props.label)) buttons.push(props.label);
        break;
    }
  }

  return { summaryLines, buttons, hasFormInputs };
}

/** 按通道类型构造测试推送 payload（POST /api/channels/:id/test） */
export function buildTestPayload(kind: NotificationChannelKind, sessionId: string): unknown {
  const testMsg = '[botd] 这是一条来自 botd 的通知推送测试消息 🚀';
  switch (kind) {
    case 'feishu':
      return {
        msg_type: 'text',
        content: { text: testMsg },
      };
    case 'slack':
      return {
        text: testMsg,
      };
    case 'telegram':
      return {
        text: testMsg,
        parse_mode: 'Markdown',
      };
    case 'webhook':
      return {
        event: 'assistant_reply',
        sessionId,
        sessionTitle: '测试通道推送',
        timestamp: new Date().toISOString(),
        message: {
          id: `msg_test_${Date.now()}`,
          sessionId,
          role: 'assistant',
          content: testMsg,
          mentions: [],
          createdAt: new Date().toISOString(),
        },
      };
  }
}

export function buildEventPayload(
  kind: NotificationChannelKind,
  eventKind: NotificationEventKind,
  event: SessionSseEvent,
  sessionId: string,
  sessionTitle: string,
  baseUrl: string,
  askSecret: string,
  channelSessionId?: string
): unknown {
  const timestamp = new Date().toISOString();
  // 继承通知时（子会话事件命中父会话通道）附带 channelSessionId，便于消费方区分事件源与通道归属
  const inherited = channelSessionId && channelSessionId !== sessionId;

  if (eventKind === 'ask_request' && event.type === 'interaction_request') {
    const ask = event.ask;
    const uiSummary = extractAskUiSummary(ask.previewType, ask.previewContent);
    // 纯按钮审批卡（options 为空、按钮在 BotdUiSpec 中）用 UI 按钮补齐一键确认选项；
    // 含表单项的卡片无法用链接作答，必须引导到网页填写。
    const effectiveOptions = ask.options.length > 0
      ? ask.options
      : uiSummary && !uiSummary.hasFormInputs && uiSummary.buttons.length > 0
        ? uiSummary.buttons
        : ask.options;
    // 签名必须使用 ask 实际所在的会话（事件源会话），否则免登录回调无法命中
    const token = signAskToken(sessionId, ask.id, askSecret);
    const respondUrls: Record<string, string> = {};
    for (const opt of effectiveOptions) {
      respondUrls[opt] = `${baseUrl}/api/public/asks/${encodeURIComponent(ask.id)}/respond?sessionId=${encodeURIComponent(sessionId)}&answer=${encodeURIComponent(opt)}&token=${token}`;
    }
    // UI 卡片摘要（Callout/KeyValueList/表单项）拼在 prompt 下方，最多保留前 6 行保持消息精炼
    const uiSummaryText = uiSummary && uiSummary.summaryLines.length > 0
      ? '\n' + uiSummary.summaryLines.slice(0, 6).join('\n')
      : '';
    // 含表单项时附上网页填写入口（免登录确认链接只能提交固定选项，无法携带表单 state）
    const formEntryText = uiSummary?.hasFormInputs
      ? `\n\n该请求包含交互表单，请点击打开网页完成填写：${baseUrl}/#?s=${encodeURIComponent(sessionId)}`
      : '';

    if (kind === 'webhook') {
      return {
        event: 'ask_request',
        sessionId,
        ...(inherited ? { channelSessionId: channelSessionId! } : {}),
        sessionTitle,
        timestamp,
        ask: {
          id: ask.id,
          botId: ask.botId,
          prompt: ask.prompt,
          options: effectiveOptions,
          expiresAt: ask.expiresAt,
        },
        respondUrls,
      };
    }

    if (kind === 'feishu') {
      const optionsText = effectiveOptions.length > 0
        ? `\n\n请直接点击链接确认选项：\n` + effectiveOptions.map((opt) => `👉 ${opt}：${respondUrls[opt]}`).join('\n')
        : '';
      const text = `[botd 交互确认] @${ask.botId} 请求用户输入：\n${ask.prompt}${uiSummaryText}${formEntryText}${optionsText}`;
      return {
        msg_type: 'text',
        content: { text },
      };
    }

    if (kind === 'slack') {
      const optionsText = effectiveOptions.length > 0
        ? `\n\n请直接点击选项链接确认：\n` + effectiveOptions.map((opt) => `• <${respondUrls[opt]}|${opt}>`).join('\n')
        : '';
      const text = `[botd 交互确认] *@${ask.botId}* 请求用户确认：\n${ask.prompt}${uiSummaryText}${formEntryText}${optionsText}`;
      return {
        text,
      };
    }

    if (kind === 'telegram') {
      const optionsText = effectiveOptions.length > 0
        ? `\n\n*请点击选项链接确认：*\n` + effectiveOptions.map((opt) => `• [${opt}](${respondUrls[opt]})`).join('\n')
        : '';
      const text = `*【botd 交互确认】* @${ask.botId} 请求用户确认：\n${ask.prompt}${uiSummaryText}${formEntryText}${optionsText}`;
      return {
        text,
        parse_mode: 'Markdown',
      };
    }
  }

  // assistant_reply or wakeup
  const message = event.type === 'message_created' ? event.message : undefined;
  const content = message?.content ?? '';
  const senderBotId = message?.senderBotId;
  const originSuffix = inherited ? `（子会话 ${sessionId}）` : '';
  const prefix = eventKind === 'wakeup' ? '[botd 唤醒]' : '[botd]';
  const formattedText = `${prefix} ${senderBotId ? `@${senderBotId}: ` : ''}${content}${originSuffix}`.trim();

  if (kind === 'webhook') {
    return {
      event: eventKind,
      sessionId,
      ...(inherited ? { channelSessionId: channelSessionId! } : {}),
      sessionTitle,
      timestamp,
      message,
    };
  }

  if (kind === 'feishu') {
    return {
      msg_type: 'text',
      content: { text: formattedText },
    };
  }

  if (kind === 'slack') {
    return {
      text: formattedText,
    };
  }

  if (kind === 'telegram') {
    return {
      text: formattedText,
      parse_mode: 'Markdown',
    };
  }

  return { text: formattedText };
}

export async function sendNotificationToChannel(
  channel: { kind: NotificationChannelKind; targetUrl: string; secret?: string },
  payload: unknown
): Promise<{ ok: boolean; status: number; error?: string }> {
  try {
    const bodyStr = JSON.stringify(payload);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': 'botd-notifier/0.1.0',
    };
    if (channel.kind === 'webhook' && channel.secret) {
      const hmac = createHmac('sha256', channel.secret).update(bodyStr).digest('hex');
      headers['X-Botd-Signature'] = `sha256=${hmac}`;
    }

    const res = await fetch(channel.targetUrl, {
      method: 'POST',
      headers,
      body: bodyStr,
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      return { ok: false, status: res.status, error: `Remote returned HTTP ${res.status}` };
    }
    return { ok: true, status: res.status };
  } catch (err: any) {
    return { ok: false, status: 502, error: err?.message || 'Remote request failed' };
  }
}
