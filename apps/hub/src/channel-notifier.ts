import type { NotificationChannelRecord, NotificationEventKind, NotificationTellPolicy } from '@botd/protocol';
import type { HubDatabase } from './db.js';
import type { SseHub } from './sse.js';
import { buildEventPayload } from './channel-payloads.js';
import { mapChannelRow, VALID_TELL_POLICIES, type ChannelRow } from './channel-schema.js';
import { isSilentSkipReply } from './message-commands.js';

/** needed 策略下判定 wakeup（callback 消息）是否属于失败/错误回调 */
function isFailureCallbackMessage(content: string): boolean {
  const lower = content.toLowerCase();
  return lower.includes('❌') || lower.includes('失败') || lower.includes('failed') || lower.includes('error');
}

/** 按通道 tellPolicy 过滤事件：never 全静默；needed 仅放行 ask_request、失败回调与 failed 会话回复 */
function shouldTellChannel(
  channel: { tellPolicy?: NotificationTellPolicy },
  eventKind: NotificationEventKind,
  ctx: { isFailureCallback: boolean; sessionFailed: boolean }
): boolean {
  const policy = channel.tellPolicy && VALID_TELL_POLICIES.has(channel.tellPolicy) ? channel.tellPolicy : 'always';
  if (policy === 'never') return false;
  if (policy === 'always') return true;
  // needed：异常与审批才打扰
  if (eventKind === 'ask_request') return true;
  if (eventKind === 'wakeup') return ctx.isFailureCallback;
  if (eventKind === 'assistant_reply') return ctx.sessionFailed;
  return false;
}

/**
 * 全局内部监听器：监听会话事件并异步非阻塞推送到外部通道。
 * 支持子会话向上继承：子会话事件同时命中其父会话配置的启用通道（按通道 id 去重）。
 */
export function registerChannelNotifier(
  db: HubDatabase,
  sseHub: SseHub,
  askSecret: string,
  enqueue: (channel: NotificationChannelRecord, sessionId: string, eventKind: NotificationEventKind, payload: unknown) => void
): () => void {
  return sseHub.onBroadcast((sessionId, event) => {
    void (async () => {
      try {
        let eventKind: NotificationEventKind | undefined;
        if (event.type === 'message_created') {
          if (event.message.role === 'assistant') {
            eventKind = 'assistant_reply';
          } else if (event.message.role === 'callback') {
            eventKind = 'wakeup';
          }
        } else if (event.type === 'interaction_request') {
          eventKind = 'ask_request';
        }

        if (!eventKind) return;

        // 静默跳过原语：[PASS]/[IGNORE] 略过发言不向外部通道推送噪音通知（无论 tellPolicy 策略）
        if (eventKind === 'assistant_reply' && isSilentSkipReply(event.type === 'message_created' ? event.message.content : '')) {
          return;
        }

        // 收集事件会话及其父会话（若存在）上的启用通道，按 id 去重
        const session = db.getSession(sessionId);
        const sessionIds = [sessionId];
        if (session?.parentSessionId) {
          sessionIds.push(session.parentSessionId);
        }

        const selectStmt = db.db.prepare(
          'SELECT id, session_id, owner_id, name, kind, target_url, secret, events_json, tell_policy, enabled, last_triggered_at, created_at FROM notification_channels WHERE session_id = ? AND enabled = 1'
        );
        const seenChannelIds = new Set<string>();
        const rows: ChannelRow[] = [];
        for (const sid of sessionIds) {
          for (const row of selectStmt.all(sid) as unknown as ChannelRow[]) {
            if (seenChannelIds.has(row.id)) continue;
            seenChannelIds.add(row.id);
            rows.push(row);
          }
        }
        if (rows.length === 0) return;

        // tellPolicy 过滤上下文：wakeup 仅失败回调放行；assistant_reply 仅 failed 会话放行
        const messageContent = event.type === 'message_created' ? event.message.content : '';
        const isFailureCallback = eventKind === 'wakeup' && isFailureCallbackMessage(messageContent);
        const sessionFailed = session?.status === 'failed';

        const channels = rows
          .map(mapChannelRow)
          .filter(
            (ch) => ch.events.includes(eventKind!) && shouldTellChannel(ch, eventKind!, { isFailureCallback, sessionFailed })
          );
        if (channels.length === 0) return;

        const baseUrl =
          process.env.BOTD_PUBLIC_URL ||
          process.env.BOTD_BASE_URL ||
          `http://localhost:${process.env.BOTD_PORT || 3000}`;

        for (const channel of channels) {
          // payload 主体使用事件源会话（ask 签名 / respondUrls 必须指向事件会话）；
          // 通道归属会话（可能是父会话）作为 channelSessionId 附带，供消费方区分。
          const notifySession = channel.sessionId === sessionId ? session : db.getSession(channel.sessionId);
          const sessionTitle = notifySession?.title || channel.sessionId;
          const payload = buildEventPayload(
            channel.kind,
            eventKind,
            event,
            sessionId,
            sessionTitle,
            baseUrl,
            askSecret,
            channel.sessionId
          );
          enqueue(channel, sessionId, eventKind, payload);
        }
      } catch (err) {
        console.error('[channels] Broadcast listener error:', err);
      }
    })();
  });
}
