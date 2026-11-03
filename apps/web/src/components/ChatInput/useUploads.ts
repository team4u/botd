import { useCallback, useRef, useState } from 'react';
import type { MessageAttachment } from '@botd/protocol';
import { api } from '../../api';
import {
  createUploadTaskTracker,
  finishUploadTask,
  isUploadResultValid,
  resetUploadTasksOnSessionChange,
  startUploadTask,
  validateUploadFile,
} from '../../utils/input-uploads';

interface UseUploadsParams {
  sessionId?: string;
  setValidationNotice: (notice: string | null) => void;
}

/**
 * 待发送附件（图片/文件）：上传为会话产物后暂存，随消息一并发送。
 * 通过任务计数与会话 generation 跟踪，防异步多批并发与切会话 ABA 竞态。
 */
export function useUploads({ sessionId, setValidationNotice }: UseUploadsParams) {
  const [pendingAttachments, setPendingAttachments] = useState<MessageAttachment[]>([]);
  const uploadTrackerRef = useRef(createUploadTaskTracker(0));
  const [uploadingCount, setUploadingCount] = useState(0);
  const uploadingFile = uploadingCount > 0;
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 始终读取最新会话 ID：上传期间切换会话时用于丢弃过期结果
  const currentSessionIdRef = useRef(sessionId);
  currentSessionIdRef.current = sessionId;

  // 会话切换由调用方调用：重置上传任务与待发送附件
  const resetOnSessionChange = useCallback(() => {
    resetUploadTasksOnSessionChange(uploadTrackerRef.current);
    setUploadingCount(0);
    setPendingAttachments([]);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  }, []);

  // 上传单个文件为会话产物并加入待发送附件列表；上传失败以输入框 notice 提示
  const uploadFiles = useCallback(
    async (files: FileList | File[]) => {
      const sessionIdForUpload = currentSessionIdRef.current;
      if (!sessionIdForUpload) {
        setValidationNotice('当前无有效会话，无法上传附件');
        return;
      }
      const list = Array.from(files);
      if (list.length === 0) return;

      const { generation: taskGen } = startUploadTask(uploadTrackerRef.current);
      setUploadingCount(uploadTrackerRef.current.activeCount);

      try {
        for (const file of list) {
          // 客户端大小预检：超限跳过该文件并提示，不读取进内存也不上传
          const sizeError = validateUploadFile(file);
          if (sizeError) {
            setValidationNotice(sizeError);
            continue;
          }

          const contentBase64 = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => {
              const result = reader.result;
              if (typeof result !== 'string') {
                reject(new Error('读取文件失败'));
                return;
              }
              // dataURL 去掉 "data:*;base64," 前缀，仅保留 Base64 载荷
              const idx = result.indexOf(',');
              resolve(idx >= 0 ? result.slice(idx + 1) : result);
            };
            reader.onerror = () => reject(new Error('读取文件失败'));
            reader.readAsDataURL(file);
          });

          // 上传前再检查一次会话与 generation 是否有效
          if (
            !isUploadResultValid(
              taskGen,
              uploadTrackerRef.current.generation,
              sessionIdForUpload,
              currentSessionIdRef.current
            )
          ) {
            return;
          }

          const uploaded = await api.uploadArtifact(sessionIdForUpload, {
            filename: file.name,
            mimeType: file.type || undefined,
            contentBase64,
          });

          // 防竞态：上传期间切换会话（或切走再切回 ABA）则丢弃结果
          if (
            !isUploadResultValid(
              taskGen,
              uploadTrackerRef.current.generation,
              sessionIdForUpload,
              currentSessionIdRef.current
            )
          ) {
            return;
          }

          setPendingAttachments((prev) => [
            ...prev,
            {
              id: uploaded.id,
              filename: uploaded.filename,
              mimeType: uploaded.mimeType || file.type || 'application/octet-stream',
              sizeBytes: uploaded.sizeBytes ?? file.size,
              url: uploaded.url,
            },
          ]);
        }
      } catch (err: any) {
        if (
          isUploadResultValid(
            taskGen,
            uploadTrackerRef.current.generation,
            sessionIdForUpload,
            currentSessionIdRef.current
          )
        ) {
          setValidationNotice(err?.message || '附件上传失败，请重试');
        }
      } finally {
        const { valid, activeCount } = finishUploadTask(uploadTrackerRef.current, taskGen);
        if (valid) {
          setUploadingCount(activeCount);
        }
      }
    },
    [setValidationNotice]
  );

  return {
    // state
    pendingAttachments,
    setPendingAttachments,
    uploadingCount,
    uploadingFile,
    // refs
    uploadTrackerRef,
    fileInputRef,
    // actions
    resetOnSessionChange,
    uploadFiles,
  };
}
