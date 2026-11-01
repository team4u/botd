import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canSubmitMessage,
  consumeSubmittedAttachments,
  consumeSubmittedDraft,
  createUploadTaskTracker,
  startUploadTask,
  finishUploadTask,
  resetUploadTasksOnSessionChange,
  isUploadResultValid,
} from '../apps/web/src/utils/input-uploads.js';

test('1. 上传时快捷键提交与提交按钮均被阻止 (Shortcut submit blocked while uploading)', () => {
  // 正常情况下：有文本且未在上传中，允许提交
  assert.equal(
    canSubmitMessage({
      content: 'hello bot',
      hasAttachments: false,
      disabled: false,
      sending: false,
      uploadingCount: 0,
      isUploading: false,
    }),
    true,
    '未上传且有内容时应允许提交'
  );

  // 上传中：即使有输入文本，提交也被阻止（快捷键与按钮复用该 guard）
  assert.equal(
    canSubmitMessage({
      content: 'hello bot',
      hasAttachments: false,
      disabled: false,
      sending: false,
      uploadingCount: 1,
      isUploading: true,
    }),
    false,
    '正在上传单文件时必须阻止提交'
  );

  // 上传中：通过 ref 同步计数值（即使 state 尚未完成重新渲染）也能立即拦截
  assert.equal(
    canSubmitMessage({
      content: 'hello bot',
      hasAttachments: false,
      uploadingCount: 1,
      isUploading: false,
    }),
    false,
    'uploadingCount > 0 时必须同步拦截'
  );

  // 纯附件消息在上传期间也不允许提交
  assert.equal(
    canSubmitMessage({
      content: '',
      hasAttachments: true,
      uploadingCount: 1,
      isUploading: true,
    }),
    false,
    '存在附件但仍在上传其他附件时必须阻止提交'
  );

  // 编辑态在上传期间同样被阻止
  assert.equal(
    canSubmitMessage({
      content: 'edited content',
      hasAttachments: false,
      uploadingCount: 1,
      isUploading: true,
      isEditing: true,
    }),
    false,
    '编辑消息时如果存在上传任务也必须阻止提交'
  );

  // 编辑态上传完成后恢复可提交
  assert.equal(
    canSubmitMessage({
      content: 'edited content',
      hasAttachments: false,
      uploadingCount: 0,
      isUploading: false,
      isEditing: true,
    }),
    true,
    '编辑态无上传任务且有内容时允许提交'
  );
});

test('2. 多批上传一个结束仍阻止提交 (Multi-batch upload keeps submit blocked until all batches finish)', () => {
  const tracker = createUploadTaskTracker(1);
  assert.equal(tracker.activeCount, 0);

  // 触发第一批文件上传（例如连续粘贴/选择）
  const batch1 = startUploadTask(tracker);
  assert.equal(tracker.activeCount, 1);
  assert.equal(
    canSubmitMessage({
      content: 'batch testing',
      hasAttachments: false,
      uploadingCount: tracker.activeCount,
    }),
    false,
    '第一批上传中阻止提交'
  );

  // 触发第二批文件上传
  const batch2 = startUploadTask(tracker);
  assert.equal(tracker.activeCount, 2);
  assert.equal(
    canSubmitMessage({
      content: 'batch testing',
      hasAttachments: false,
      uploadingCount: tracker.activeCount,
    }),
    false,
    '两批上传中阻止提交'
  );

  // 第一批上传完成并回调 finishUploadTask
  const result1 = finishUploadTask(tracker, batch1.generation);
  assert.equal(result1.valid, true);
  assert.equal(tracker.activeCount, 1, '第一批结束后仍有 1 个任务在运行');

  // 此时仍有第二批在上传，快捷键与提交必须依然被阻止，不能提前放行
  assert.equal(
    canSubmitMessage({
      content: 'batch testing',
      hasAttachments: false,
      uploadingCount: tracker.activeCount,
    }),
    false,
    '第一批结束但第二批未完成时必须依然阻止提交'
  );

  // 第二批上传完成
  const result2 = finishUploadTask(tracker, batch2.generation);
  assert.equal(result2.valid, true);
  assert.equal(tracker.activeCount, 0, '所有批次均已完成');

  // 全部批次完成后方可提交
  assert.equal(
    canSubmitMessage({
      content: 'batch testing',
      hasAttachments: false,
      uploadingCount: tracker.activeCount,
    }),
    true,
    '全部批次上传完成后应解除提交阻止'
  );
});

test('3. 切会话旧结果忽略与防止 ABA 竞态 (Session switch ignores old uploads and prevents ABA race)', () => {
  const tracker = createUploadTaskTracker(1);
  const currentSessionA = 'sess-alpha';

  // 在 Session A 中启动上传
  const uploadTaskA = startUploadTask(tracker);
  assert.equal(uploadTaskA.generation, 1);
  assert.equal(tracker.activeCount, 1);

  // 用户快速切换到 Session B
  const currentSessionB = 'sess-beta';
  resetUploadTasksOnSessionChange(tracker);
  assert.equal(tracker.generation, 2, '切会话递增 generation');
  assert.equal(tracker.activeCount, 0, '切会话清空活跃上传计数');

  // 旧 Session A 的异步上传此时返回，检查其有效性
  const isValidForSessionB = isUploadResultValid(
    uploadTaskA.generation,
    tracker.generation,
    currentSessionA,
    currentSessionB
  );
  assert.equal(isValidForSessionB, false, '切到新会话后旧上传结果必须被忽略');

  // 旧任务尝试结束任务，应被识别为无效并不影响当前会话状态
  const finishOld = finishUploadTask(tracker, uploadTaskA.generation);
  assert.equal(finishOld.valid, false);
  assert.equal(tracker.activeCount, 0, '忽略旧任务后活跃计数保持为 0');

  // ABA 竞态复现：用户又切回了 Session A
  resetUploadTasksOnSessionChange(tracker);
  assert.equal(tracker.generation, 3, '切回原会话 generation 再次递增为 3');
  assert.equal(tracker.activeCount, 0);

  // 假设最初 Session A 的某个极慢异步请求现在才返回，会话名虽然也是 'sess-alpha'，但 generation 已是 3
  const isValidABA = isUploadResultValid(
    uploadTaskA.generation,
    tracker.generation,
    currentSessionA,
    currentSessionA
  );
  assert.equal(
    isValidABA,
    false,
    '虽然目标会话名与当前相同，但 generation 不匹配，必须彻底防范 ABA 竞态'
  );

  const finishABA = finishUploadTask(tracker, uploadTaskA.generation);
  assert.equal(finishABA.valid, false, 'ABA 旧任务 finish 必须返回无效');
  assert.equal(tracker.activeCount, 0);
});

test('4. 发送完成只消费当次发送的附件与草稿，不清掉后加的新内容 (Send completion preserves new attachments and draft additions)', () => {
  // --- 附件测试 ---
  const initialAtt1 = {
    id: 'att-001',
    filename: 'design.png',
    mimeType: 'image/png',
    sizeBytes: 1024,
  };
  const initialAtt2 = {
    id: 'att-002',
    filename: 'spec.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 2048,
  };
  const lateAtt3 = {
    id: 'att-003',
    filename: 'log.txt',
    mimeType: 'text/plain',
    sizeBytes: 512,
  };

  // 用户发送包含了 att-001 和 att-002
  const submittedAttachments = [initialAtt1, initialAtt2];

  // 在网络发送期间，另一张图片或上传完成的附件 lateAtt3 追加到了输入框
  const attachmentsDuringFlight = [initialAtt1, initialAtt2, lateAtt3];

  // 发送完成后，调用消费函数
  const remainingAttachments = consumeSubmittedAttachments(
    attachmentsDuringFlight,
    submittedAttachments
  );

  // 必须只消费了 att-001 与 att-002，保留 lateAtt3！
  assert.equal(remainingAttachments.length, 1);
  assert.equal(remainingAttachments[0].id, 'att-003');
  assert.equal(remainingAttachments[0].filename, 'log.txt');

  // 当没有后加附件时，正常完全清空
  assert.deepEqual(
    consumeSubmittedAttachments([initialAtt1], [initialAtt1]),
    []
  );

  // --- 草稿测试 ---
  // 1. 无新输入：发送成功后草稿正常清空
  assert.equal(consumeSubmittedDraft('hello bot', 'hello bot'), '');
  assert.equal(consumeSubmittedDraft('hello bot  ', 'hello bot'), '');

  // 2. 发送期间用户追加了新文本（如连续打字或从剪贴板粘贴文字）
  const submittedContent = 'hello bot';
  const contentWithAppendedText = 'hello bot, and please check this too';
  const remainingDraft = consumeSubmittedDraft(
    contentWithAppendedText,
    submittedContent
  );
  assert.equal(
    remainingDraft,
    ', and please check this too',
    '必须保留发送期间追加的新文本'
  );

  // 3. 发送期间用户完全替换或输入了全新的消息
  const completelyNewDraft = 'totally different message';
  const preservedDraft = consumeSubmittedDraft(
    completelyNewDraft,
    submittedContent
  );
  assert.equal(
    preservedDraft,
    'totally different message',
    '用户完全修改的草稿不能被抹掉'
  );
});
