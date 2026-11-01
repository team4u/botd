/**
 * 消息提交参数与守卫判定
 */
export interface CanSubmitParams {
  content: string;
  hasAttachments: boolean;
  disabled?: boolean;
  sending?: boolean;
  uploadingCount?: number;
  isUploading?: boolean;
  isEditing?: boolean;
}

/**
 * 统一提交守卫：检查输入内容、附件、禁用态、发送态以及真实上传状态。
 * 供快捷键（Ctrl/Cmd+Enter）和提交按钮共同复用。
 */
export function canSubmitMessage({
  content,
  hasAttachments,
  disabled = false,
  sending = false,
  uploadingCount = 0,
  isUploading = false,
  isEditing = false,
}: CanSubmitParams): boolean {
  if (disabled || sending) return false;
  if (isUploading || uploadingCount > 0) return false;
  const hasText = content.trim().length > 0;
  if (isEditing) {
    return hasText;
  }
  return hasText || hasAttachments;
}

/** 附件客户端预检体积上限：与服务端 MAX_ARTIFACT_BYTES（15MB）对齐，超限免整只 Base64 进内存即被 413 拒 */
export const MAX_UPLOAD_FILE_BYTES = 15 * 1024 * 1024;

/**
 * 上传前客户端大小预检：超限直接返回错误文案（不发起读取/上传），未超限返回 null。
 */
export function validateUploadFile(
  file: { name: string; size: number },
  maxBytes: number = MAX_UPLOAD_FILE_BYTES,
): string | null {
  if (file.size > maxBytes) {
    const maxMb = Math.floor(maxBytes / 1024 / 1024);
    return `附件「${file.name}」超过 ${maxMb}MB 上限（当前 ${file.size} 字节），已跳过上传`;
  }
  return null;
}

/**
 * 校验异步上传结果是否有效。
 * 用于防范：
 * 1. 上传期间切换到其他会话；
 * 2. 切走后又切回同一会话的 ABA 竞态（通过 generation 计数识别）。
 */
export function isUploadResultValid(
  taskGeneration: number,
  currentGeneration: number,
  taskSessionId?: string,
  currentSessionId?: string,
): boolean {
  if (taskGeneration !== currentGeneration) {
    return false;
  }
  if (taskSessionId !== undefined && currentSessionId !== undefined) {
    return taskSessionId === currentSessionId;
  }
  return true;
}

/**
 * 消费当次提交的附件列表，保留发送期间后续新增的附件。
 */
export function consumeSubmittedAttachments<T extends { id?: string }>(
  currentAttachments: T[],
  submittedAttachments: T[],
): T[] {
  if (!submittedAttachments || submittedAttachments.length === 0) {
    return currentAttachments;
  }
  if (!currentAttachments || currentAttachments.length === 0) {
    return [];
  }

  const submittedIds = new Set<string>();
  const submittedItems = new Set<T>();

  for (const item of submittedAttachments) {
    if (item && item.id) {
      submittedIds.add(item.id);
    } else if (item) {
      submittedItems.add(item);
    }
  }

  return currentAttachments.filter((item) => {
    if (item && item.id && submittedIds.has(item.id)) {
      return false;
    }
    if (submittedItems.has(item)) {
      return false;
    }
    return true;
  });
}

/**
 * 消费当次提交的消息草稿，保留发送期间用户追加或修改的新内容。
 */
export function consumeSubmittedDraft(
  currentContent: string,
  submittedContent: string,
): string {
  if (currentContent === submittedContent) {
    return '';
  }
  if (currentContent.trim() === submittedContent.trim()) {
    return '';
  }
  if (submittedContent.length > 0 && currentContent.startsWith(submittedContent)) {
    return currentContent.slice(submittedContent.length);
  }
  const trimmed = submittedContent.trim();
  if (trimmed.length > 0 && currentContent.startsWith(trimmed)) {
    const remainder = currentContent.slice(trimmed.length);
    if (remainder.trim().length === 0) {
      return '';
    }
    return remainder;
  }
  return currentContent;
}

/**
 * 上传任务与会话版本追踪器
 */
export interface UploadTaskTracker {
  generation: number;
  activeCount: number;
}

export function createUploadTaskTracker(initialGeneration = 0): UploadTaskTracker {
  return {
    generation: initialGeneration,
    activeCount: 0,
  };
}

export function startUploadTask(tracker: UploadTaskTracker): { generation: number; activeCount: number } {
  tracker.activeCount++;
  return { generation: tracker.generation, activeCount: tracker.activeCount };
}

export function finishUploadTask(
  tracker: UploadTaskTracker,
  taskGeneration: number,
): { valid: boolean; activeCount: number } {
  if (taskGeneration !== tracker.generation) {
    return { valid: false, activeCount: tracker.activeCount };
  }
  tracker.activeCount = Math.max(0, tracker.activeCount - 1);
  return { valid: true, activeCount: tracker.activeCount };
}

export function resetUploadTasksOnSessionChange(tracker: UploadTaskTracker): void {
  tracker.generation++;
  tracker.activeCount = 0;
}
