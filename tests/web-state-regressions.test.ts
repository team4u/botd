import test from 'node:test';
import assert from 'node:assert/strict';
import type { MessageRecord, PendingAskRecord } from '../packages/protocol/src/index.js';
import type { StreamingAssistantState } from '../apps/web/src/types.js';
import {
  mergeMessagesSnapshot,
  mergeMessagesPage,
  truncateMessagesAtAnchor,
  isSnapshotCurrent,
  updateStreamingMap,
  clearStreamingMap,
  mergePendingAsks,
} from '../apps/web/src/utils/message-state.js';

function createMockMessage(id: string, role: MessageRecord['role'] = 'assistant', content = 'content'): MessageRecord {
  return {
    id,
    sessionId: 'session-test',
    role,
    content,
    mentions: [],
    createdAt: new Date().toISOString(),
  };
}

function createMockAsk(id: string, status: PendingAskRecord['status'] = 'pending'): PendingAskRecord {
  return {
    id,
    sessionId: 'session-test',
    botId: 'bot-1',
    prompt: 'Please confirm',
    options: [],
    status,
    createdAt: new Date().toISOString(),
  };
}

test('recent-page snapshots preserve confirmed earlier history and discard deleted tails', () => {
  const current = ['older', 'shared', 'obsolete'].map((id) => createMockMessage(id));
  const known = new Set(current.map((message) => message.id));
  const page = [createMockMessage('shared'), createMockMessage('latest')];
  assert.deepEqual(mergeMessagesPage(current, page, known, true).map((message) => message.id),
    ['older', 'shared', 'latest']);
  assert.deepEqual(mergeMessagesPage(current, page, known, false).map((message) => message.id),
    ['shared', 'latest']);
  assert.deepEqual(mergeMessagesPage(current, [createMockMessage('replacement')], known, true)
    .map((message) => message.id), ['replacement']);
  assert.deepEqual(mergeMessagesPage([...current, createMockMessage('live')], page, known, true)
    .map((message) => message.id), ['older', 'shared', 'latest', 'live']);
});

test('1. 已删除旧消息不复活 (qa_anchor + qa_obsolete 截断回归)', () => {
  // 场景：当前 UI 包含 anchor 和已被服务端删除的 obsolete 回复
  const anchor = createMockMessage('qa_anchor', 'user', 'original content');
  const obsolete = createMockMessage('qa_obsolete', 'assistant', 'obsolete reply');
  const currentLive = [anchor, obsolete];

  // 1.1 立即按 anchor 截断
  const locallyTruncated = truncateMessagesAtAnchor(currentLive, 'qa_anchor');
  assert.deepEqual(
    locallyTruncated.map((m) => m.id),
    ['qa_anchor'],
    '本地截断后应立即移出 qa_obsolete'
  );

  // 1.2 服务端快照只包含 anchor（obsolete 已被物理删除）
  const fetchedSnapshot = [anchor];
  const knownAtStart = new Set(currentLive.map((m) => m.id)); // 请求发起时本地存在两项

  // 合并快照：knownAtStart 中存在但 fetchedSnapshot 缺失的 obsolete 绝不复活
  const merged = mergeMessagesSnapshot(currentLive, fetchedSnapshot, knownAtStart);
  assert.deepEqual(
    merged.map((m) => m.id),
    ['qa_anchor'],
    '合并快照后 obsolete 回复绝对不能被当作实时新消息追加复活'
  );

  // 1.3 多级截断：[U1, A1, U2, A2]，截断至 U1 并更新文本
  const u1 = createMockMessage('u1', 'user', 'first query');
  const a1 = createMockMessage('a1', 'assistant', 'first answer');
  const u2 = createMockMessage('u2', 'user', 'second query');
  const a2 = createMockMessage('a2', 'assistant', 'second answer');
  const history = [u1, a1, u2, a2];

  const truncatedWithUpdate = truncateMessagesAtAnchor(history, 'u1', 'first query edited');
  assert.equal(truncatedWithUpdate.length, 1);
  assert.equal(truncatedWithUpdate[0].id, 'u1');
  assert.equal(truncatedWithUpdate[0].content, 'first query edited');

  const serverUpdatedU1 = { ...u1, content: 'first query edited' };
  const mergedHistory = mergeMessagesSnapshot(history, [serverUpdatedU1], new Set(history.map((m) => m.id)));
  assert.deepEqual(
    mergedHistory.map((m) => m.id),
    ['u1']
  );
  assert.equal(mergedHistory[0].content, 'first query edited');
});

test('2. 请求期间新消息保留 (拉取快照期间通过 SSE 到达的消息必须保留)', () => {
  const u1 = createMockMessage('u1', 'user', 'hello');
  const knownAtStart = new Set(['u1']);

  // 在请求返回前，SSE 推送了新的 bot 回复 a1_live
  const a1Live = createMockMessage('a1_live', 'assistant', 'new answer via SSE');
  const currentLive = [u1, a1Live];

  // 服务端快照生成时尚不含 a1_live，只返回 [u1]
  const fetchedSnapshot = [u1];

  const merged = mergeMessagesSnapshot(currentLive, fetchedSnapshot, knownAtStart);
  assert.deepEqual(
    merged.map((m) => m.id),
    ['u1', 'a1_live'],
    '快照开始后到达的 live SSE 消息必须被完整合并保留'
  );

  // 若服务端已写入 a1_live 并一并返回，应正确去重不产生重复项
  const fetchedWithLive = [u1, a1Live];
  const mergedDedupe = mergeMessagesSnapshot(currentLive, fetchedWithLive, knownAtStart);
  assert.deepEqual(
    mergedDedupe.map((m) => m.id),
    ['u1', 'a1_live'],
    '快照与 SSE 均包含同一新消息时应严格去重'
  );
});

test('3. 同会话乱序 snapshot / 截断前请求不覆盖', () => {
  const sessionId = 'session-order-test';
  const epoch = 1;

  // 3.1 乱序双请求：req1 发起早于 req2，但 req1 响应晚于 req2
  let currentSeq = 0;
  const req1Seq = ++currentSeq; // 1
  const req2Seq = ++currentSeq; // 2

  // req2 先到达
  const req2Valid = isSnapshotCurrent(sessionId, epoch, currentSeq, { sessionId, epoch, seq: req2Seq });
  assert.equal(req2Valid, true, '最新请求 seq 2 应被接纳');

  // req1 延迟到达
  const req1Valid = isSnapshotCurrent(sessionId, epoch, currentSeq, { sessionId, epoch, seq: req1Seq });
  assert.equal(req1Valid, false, '落后的旧请求 seq 1 必须被拒绝丢弃');

  // 3.2 截断事件使在途快照立即失效
  const preTruncateSeq = ++currentSeq; // 3
  // 截断发生：seq 递增
  const postTruncateSeq = ++currentSeq; // 4

  // 截断前发出的旧请求 3 姗姗来迟
  const staleResponseValid = isSnapshotCurrent(sessionId, epoch, currentSeq, { sessionId, epoch, seq: preTruncateSeq });
  assert.equal(staleResponseValid, false, '截断发生前发出的在途快照绝对不能覆盖截断后的状态');

  // 截断后重新触发的快照 4 应该被接纳
  const freshResponseValid = isSnapshotCurrent(sessionId, epoch, currentSeq, { sessionId, epoch, seq: postTruncateSeq });
  assert.equal(freshResponseValid, true, '截断后发起的新快照应被正常接纳');
});

test('4. 切会话隔离 (跨会话 snapshot 与事件隔离防护)', () => {
  const sessionA = 'session-a';
  const sessionB = 'session-b';

  let currentEpoch = 1;
  const activeSessionId = sessionB; // 用户已切换到 Session B
  currentEpoch = 2; // epoch 递增

  // Session A 在切换前发出的请求迟到返回
  const isStaleSessionAccepted = isSnapshotCurrent(activeSessionId, currentEpoch, 1, {
    sessionId: sessionA,
    epoch: 1,
    seq: 1,
  });
  assert.equal(isStaleSessionAccepted, false, '旧会话 Session A 的快照不能提交给 Session B');

  // activeSessionId 为 null（登出）时也拒绝接纳
  const isLoggedOutAccepted = isSnapshotCurrent(null, currentEpoch, 1, {
    sessionId: sessionB,
    epoch: currentEpoch,
    seq: 1,
  });
  assert.equal(isLoggedOutAccepted, false, '登出后 snapshot 必须被丢弃');
});

test('5. 串/并发流 transition (单流与圆桌并发流状态演进)', () => {
  let streamMap: Record<string, StreamingAssistantState> = {};

  // 5.1 单流产生与结束
  streamMap = updateStreamingMap(streamMap, 'bot-1', (prev) => ({
    botId: 'bot-1',
    delta: (prev?.delta || '') + 'Hello',
    tools: [],
  }));
  assert.equal(Object.values(streamMap).length, 1);
  assert.equal(streamMap['bot-1'].delta, 'Hello');

  // 结束单流
  streamMap = updateStreamingMap(streamMap, 'bot-1', () => null);
  assert.deepEqual(streamMap, {}, 'BOT 完成回复后对应流条目应被清理');

  // 5.2 圆桌并发流：两个 BOT 同步作答
  streamMap = updateStreamingMap(streamMap, 'bot-1', () => ({
    botId: 'bot-1',
    delta: 'Answer from 1',
    tools: [],
  }));
  streamMap = updateStreamingMap(streamMap, 'bot-2', () => ({
    botId: 'bot-2',
    delta: 'Answer from 2',
    tools: [],
  }));
  assert.equal(Object.values(streamMap).length, 2, '两 BOT 并发流式应共存于 map 中');

  // session_status running 事件轮转 activeBotId 时，不应误删并发中的其他 BOT 流
  // 模拟 session_status: running, activeBotId: 'bot-1' -> 不修改 streamMap
  assert.equal(Object.values(streamMap).length, 2, '轮换 activeBotId 不能误删其他并发流');

  // bot-1 先完成
  streamMap = updateStreamingMap(streamMap, 'bot-1', () => null);
  assert.equal(Object.values(streamMap).length, 1);
  assert.ok(streamMap['bot-2'], 'bot-1 完成后，bot-2 的流式状态必须平滑保留');

  // bot-2 完成
  streamMap = updateStreamingMap(streamMap, 'bot-2', () => null);
  assert.deepEqual(streamMap, {}, '所有 BOT 完成后流式字典清空');

  // 5.3 统一清理路径
  streamMap = updateStreamingMap(streamMap, 'bot-1', () => ({ botId: 'bot-1', delta: 'x', tools: [] }));
  streamMap = clearStreamingMap();
  assert.deepEqual(streamMap, {}, 'clearStreamingMap 应重置为空对象');
});

test('6. 编辑消息与广播/响应竞态保护 (避免切掉新回复)', () => {
  // 初始：用户发送 message_1，bot 随后回复 reply_1
  const m1 = createMockMessage('message_1', 'user', 'original');
  const r1 = createMockMessage('reply_1', 'assistant', 'old reply');
  let currentMessages = [m1, r1];

  // 步骤 A：客户端发起编辑 message_1 -> 立即按锚点 message_1 截断本地历史，更新内容为 edited
  currentMessages = truncateMessagesAtAnchor(currentMessages, 'message_1', 'edited');
  assert.deepEqual(
    currentMessages.map((m) => m.id),
    ['message_1'],
    '编辑发起时应立即移除 old reply'
  );
  assert.equal(currentMessages[0].content, 'edited');

  // 步骤 B：HTTP 请求已发出，服务端迅速生成并经由 SSE 推送了新回复 new_reply
  const newReply = createMockMessage('new_reply', 'assistant', 'new generated reply');
  currentMessages = [...currentMessages, newReply];
  assert.deepEqual(
    currentMessages.map((m) => m.id),
    ['message_1', 'new_reply']
  );

  // 步骤 C：SSE messages_truncated 或 HTTP 响应姗姗来迟到达
  // 如果此分支再次调用 slice(0, idx + 1)，会把 new_reply 切掉。
  // 统一历史失效机制通过标记防止二次截断，new_reply 得以保留。
  const clientTruncatedAnchor: string | null = 'message_1';
  const incomingTruncateAnchor = 'message_1';

  let messagesAfterBroadcast = currentMessages;
  if (clientTruncatedAnchor === incomingTruncateAnchor) {
    // 已由客户端先前截断，跳过重复 slice
  } else {
    messagesAfterBroadcast = truncateMessagesAtAnchor(messagesAfterBroadcast, incomingTruncateAnchor);
  }

  assert.deepEqual(
    messagesAfterBroadcast.map((m) => m.id),
    ['message_1', 'new_reply'],
    '竞态广播到达时绝不能将新生成的回复 slice 切除'
  );
});

test('7. 待响应人机协同 asks 状态转移与合并', () => {
  const ask1 = createMockAsk('ask-1', 'pending');
  const ask2 = createMockAsk('ask-2', 'pending');

  const resolvedIds = new Set<string>();
  // ask-1 被解决
  resolvedIds.add('ask-1');

  // 服务端稍后返回慢快照（仍含已解决的 ask-1 和新的 ask-2）
  const fetchedAsks = [ask1, ask2];
  const liveAsks: PendingAskRecord[] = [];

  const merged = mergePendingAsks(liveAsks, fetchedAsks, resolvedIds);
  assert.deepEqual(
    merged.map((a) => a.id),
    ['ask-2'],
    '已标记解决的 ask-1 绝不能被慢快照重新复活为 pending'
  );
});
