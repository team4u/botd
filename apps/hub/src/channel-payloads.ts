import { createHmac } from 'node:crypto';
import type { NotificationChannelKind, NotificationEventKind, SessionSseEvent } from '@botd/protocol';
import { signAskToken } from './ask-callback.js';

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
    // 签名必须使用 ask 实际所在的会话（事件源会话），否则免登录回调无法命中
    const token = signAskToken(sessionId, ask.id, askSecret);
    const respondUrls: Record<string, string> = {};
    for (const opt of ask.options) {
      respondUrls[opt] = `${baseUrl}/api/public/asks/${encodeURIComponent(ask.id)}/respond?sessionId=${encodeURIComponent(sessionId)}&answer=${encodeURIComponent(opt)}&token=${token}`;
    }

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
          options: ask.options,
          expiresAt: ask.expiresAt,
        },
        respondUrls,
      };
    }

    if (kind === 'feishu') {
      const optionsText = ask.options.length > 0
        ? `\n\n请直接点击链接确认选项：\n` + ask.options.map((opt) => `👉 ${opt}：${respondUrls[opt]}`).join('\n')
        : '';
      const text = `[botd 交互确认] @${ask.botId} 请求用户输入：\n${ask.prompt}${optionsText}`;
      return {
        msg_type: 'text',
        content: { text },
      };
    }

    if (kind === 'slack') {
      const optionsText = ask.options.length > 0
        ? `\n\n请直接点击选项链接确认：\n` + ask.options.map((opt) => `• <${respondUrls[opt]}|${opt}>`).join('\n')
        : '';
      const text = `[botd 交互确认] *@${ask.botId}* 请求用户确认：\n${ask.prompt}${optionsText}`;
      return {
        text,
      };
    }

    if (kind === 'telegram') {
      const optionsText = ask.options.length > 0
        ? `\n\n*请点击选项链接确认：*\n` + ask.options.map((opt) => `• [${opt}](${respondUrls[opt]})`).join('\n')
        : '';
      const text = `*【botd 交互确认】* @${ask.botId} 请求用户确认：\n${ask.prompt}${optionsText}`;
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
