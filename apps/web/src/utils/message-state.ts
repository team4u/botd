import type { MessageRecord, PendingAskRecord } from '@botd/protocol';
import type { StreamingAssistantState } from '../types.js';

export interface SnapshotMeta {
  sessionId: string;
  epoch: number;
  seq: number;
}

/**
 * 纯函数：将拉取到的历史快照与客户端当前实时消息合并。
 * 
 * 规则：
 * 1. 只有在快照请求发起「之后」才到达、且快照本身未包含的新 SSE / 发送消息，才作为 newerLive 保留。
 * 2. 请求发起时就已在本地存在、但在服务端返回的快照中缺失的消息，判定为已被服务端删除（截断/清空），一律丢弃，杜绝幽灵消息复活。
 * 3. 快照中已有的消息以快照内容为准（包含服务端最新编辑的 content 等）。
 */
export function mergeMessagesSnapshot(
  currentLive: MessageRecord[],
  fetchedSnapshot: MessageRecord[],
  knownLiveIdsAtStart: Set<string> | string[]
): MessageRecord[] {
  const knownSet =
    knownLiveIdsAtStart instanceof Set
      ? knownLiveIdsAtStart
      : new Set(knownLiveIdsAtStart);

  const fetchedIds = new Set(fetchedSnapshot.map((m) => m.id));

  // 仅保留请求开始后到达的新增消息
  const newerLive = currentLive.filter(
    (m) => !fetchedIds.has(m.id) && !knownSet.has(m.id)
  );

  return [...fetchedSnapshot, ...newerLive];
}

/** 最近一页只能替换已确认重叠的后缀；没有重叠时重新以服务端页为准。 */
export function mergeMessagesPage(
  currentLive: MessageRecord[],
  fetchedPage: MessageRecord[],
  knownLiveIdsAtStart: Set<string>,
  hasMore: boolean,
): MessageRecord[] {
  let prefix: MessageRecord[] = [];
  if (hasMore) {
    const positions = new Map(currentLive.map((message, index) => [message.id, index]));
    const overlap = fetchedPage.map((message) => positions.get(message.id)).find((index) => index !== undefined);
    if (overlap !== undefined) {
      const fetchedIds = new Set(fetchedPage.map((message) => message.id));
      prefix = currentLive.slice(0, overlap).filter((message) =>
        knownLiveIdsAtStart.has(message.id) && !fetchedIds.has(message.id)
      );
    }
  }
  return [...prefix, ...mergeMessagesSnapshot(currentLive, fetchedPage, knownLiveIdsAtStart)];
}

/**
 * 纯函数：按锚点消息 ID 截断消息列表（保留锚点及其之前的消息）。
 * 若提供 updatedContent，同步更新锚点消息的文本内容。
 * 若未找到 anchorMessageId，保持原数组不变。
 */
export function truncateMessagesAtAnchor(
  messages: MessageRecord[],
  anchorMessageId: string,
  updatedContent?: string
): MessageRecord[] {
  const idx = messages.findIndex((m) => m.id === anchorMessageId);
  if (idx < 0) return messages;

  const sliced = messages.slice(0, idx + 1);
  if (updatedContent !== undefined && sliced.length > 0) {
    const last = sliced[sliced.length - 1];
    sliced[sliced.length - 1] = {
      ...last,
      content: updatedContent,
    };
  }
  return sliced;
}

/**
 * 纯函数：校验快照请求是否依然合法且处于最新版本。
 * 防范会话切换、旧 epoch 竞态以及乱序落后快照覆盖。
 */
export function isSnapshotCurrent(
  activeSessionId: string | null,
  currentEpoch: number,
  currentSeq: number,
  meta: SnapshotMeta
): boolean {
  return (
    activeSessionId !== null &&
    activeSessionId === meta.sessionId &&
    currentEpoch === meta.epoch &&
    currentSeq === meta.seq
  );
}

/**
 * 纯函数：更新按 botId 索引的流式状态映射字典。
 * updater 返回 null 时移除对应 BOT 的流状态；返回新状态时就地更新。
 */
export function updateStreamingMap(
  map: Record<string, StreamingAssistantState>,
  botId: string,
  updater: (prev: StreamingAssistantState | undefined) => StreamingAssistantState | null
): Record<string, StreamingAssistantState> {
  const prev = map[botId];
  const next = updater(prev);

  if (!next && !prev) {
    return map;
  }

  const nextMap = { ...map };
  if (next) {
    nextMap[botId] = next;
  } else {
    delete nextMap[botId];
  }
  return nextMap;
}

/**
 * 纯函数：清空流式状态字典。
 */
export function clearStreamingMap(): Record<string, StreamingAssistantState> {
  return {};
}

/**
 * 纯函数：合并待响应的人机协同 asks，排除已解决或非 pending 项，保留拉取期间到达的有效 ask。
 */
export function mergePendingAsks(
  currentPending: PendingAskRecord[],
  fetchedAsks: PendingAskRecord[],
  resolvedAskIds: Set<string> | string[]
): PendingAskRecord[] {
  const resolvedSet =
    resolvedAskIds instanceof Set ? resolvedAskIds : new Set(resolvedAskIds);

  const validFetched = (fetchedAsks || []).filter(
    (a) => a.status === 'pending' && !resolvedSet.has(a.id)
  );
  const fetchedIds = new Set(validFetched.map((a) => a.id));

  const validLive = (currentPending || []).filter(
    (a) => !fetchedIds.has(a.id) && a.status === 'pending' && !resolvedSet.has(a.id)
  );

  return [...validFetched, ...validLive];
}
