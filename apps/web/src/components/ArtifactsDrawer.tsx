import React, { useEffect, useState } from 'react';
import {
  X,
  Download,
  Loader2,
  PackageOpen,
  Image as ImageIcon,
  Music,
  Video,
  FileText,
  FileCode,
} from 'lucide-react';
import type { ArtifactRecord, BotConfig, MessageAttachment } from '@botd/protocol';
import { api } from '../api';
import { onGlobalEvent } from '../events';
import { formatFileSize } from '../message-format';
import { AttachmentPreviewModal } from './AttachmentPreviewModal';

/** 相对时间：刚刚 / N 分钟前 / N 小时前 / N 天前，超过 7 天退化为本地日期 */
function formatRelativeTime(iso: string): string {
  const time = new Date(iso).getTime();
  if (Number.isNaN(time)) return iso;
  const diff = Date.now() - time;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`;
  return new Date(time).toLocaleDateString();
}

/** 依据 MIME 类型挑选文件图标 */
function artifactIcon(mimeType: string) {
  const mime = (mimeType || '').toLowerCase();
  if (mime.startsWith('image/')) return ImageIcon;
  if (mime.startsWith('audio/')) return Music;
  if (mime.startsWith('video/')) return Video;
  if (/(json|xml|javascript|yaml|x-sh|x-python|html|css)/.test(mime)) return FileCode;
  return FileText;
}

interface ArtifactsDrawerProps {
  isOpen: boolean;
  sessionId: string;
  botMap: Map<string, BotConfig>;
  onClose: () => void;
}

/**
 * 会话产物抽屉：右侧滑入面板，列出本会话全部 artifact 文件产物。
 * 打开时全量拉取，随后通过全局 SSE artifact_created 实时追加（by id 去重）。
 */
export const ArtifactsDrawer: React.FC<ArtifactsDrawerProps> = ({
  isOpen,
  sessionId,
  botMap,
  onClose,
}) => {
  const [artifacts, setArtifacts] = useState<ArtifactRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);

  // 切换会话 / 关闭抽屉时清空本地缓存，避免串会话闪现
  useEffect(() => {
    setArtifacts([]);
    setLoadError(null);
    setPreviewIndex(null);
  }, [sessionId]);

  // 打开时全量拉取（重新打开也刷新，抽屉关闭期间新增的产物一次补齐）
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    api
      .listSessionArtifacts(sessionId)
      .then((list) => {
        if (cancelled) return;
        // 按创建时间倒序（新产物在前），与后端返回顺序解耦
        const sorted = [...list].sort(
          (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
        );
        setArtifacts((prev) => {
          const seen = new Set(prev.map((x) => x.id));
          // 拉取结果与实时追加结果合并去重（by id）
          const merged = [...prev];
          for (const item of sorted) {
            if (!seen.has(item.id)) merged.push(item);
          }
          return merged.sort(
            (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
          );
        });
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        setLoadError(message || '加载产物列表失败');
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen, sessionId]);

  // 实时追加：仅本会话的 artifact_created，by id 去重后按时间倒序插入
  useEffect(() => {
    if (!isOpen) return;
    const unsubscribe = onGlobalEvent((e) => {
      if (e.type !== 'artifact_created' || e.sessionId !== sessionId) return;
      const artifact = e.artifact;
      setArtifacts((prev) => {
        if (prev.some((x) => x.id === artifact.id)) return prev;
        const next = [...prev, artifact];
        next.sort(
          (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
        );
        return next;
      });
    });
    return unsubscribe;
  }, [isOpen, sessionId]);

  // Esc 关闭
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  // 构造 AttachmentPreviewModal 兼容对象（url 指向产物直链）
  const toPreviewAttachment = (a: ArtifactRecord): MessageAttachment => ({
    id: a.id,
    filename: a.filename,
    mimeType: a.mimeType,
    sizeBytes: a.sizeBytes,
    url: `/api/artifacts/${a.id}/content`,
  });

  return (
    <>
      {/* 遮罩：点击关闭 */}
      <div
        className="fixed inset-0 z-40 bg-black/30 dark:bg-black/50"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* 右侧滑入面板 */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label="会话产物"
        className="fixed inset-y-0 right-0 z-40 w-[min(24rem,90vw)] bg-white dark:bg-zinc-950 border-l border-zinc-200/90 dark:border-zinc-800/90 shadow-xl flex flex-col animate-in fade-in slide-in-from-right duration-200"
      >
        <div className="flex items-center justify-between gap-2 px-4 h-13 sm:h-14 border-b border-zinc-200/80 dark:border-zinc-800/80 shrink-0">
          <h2 className="text-sm sm:text-base font-semibold text-zinc-900 dark:text-zinc-100 truncate">
            会话产物
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            title="关闭 (Esc)"
            className="p-1.5 rounded-lg text-zinc-400 hover:text-zinc-600 dark:text-zinc-500 dark:hover:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-1.5">
          {loading && artifacts.length === 0 ? (
            <div className="py-16 flex flex-col items-center justify-center gap-2 text-zinc-400 dark:text-zinc-500">
              <Loader2 className="w-5 h-5 animate-spin-fast text-blue-600 dark:text-blue-400" />
              <p className="text-xs">正在加载产物列表...</p>
            </div>
          ) : loadError && artifacts.length === 0 ? (
            <div className="py-16 flex flex-col items-center justify-center gap-2 text-zinc-400 dark:text-zinc-500 text-center px-4">
              <PackageOpen className="w-6 h-6" />
              <p className="text-xs text-rose-500 dark:text-rose-400">{loadError}</p>
            </div>
          ) : artifacts.length === 0 ? (
            <div className="py-16 flex flex-col items-center justify-center gap-2 text-zinc-400 dark:text-zinc-500 text-center px-4">
              <PackageOpen className="w-8 h-8" />
              <p className="text-xs leading-relaxed">
                本会话暂无产物。智能体通过 artifact 命令上传的文件会出现在这里。
              </p>
            </div>
          ) : (
            artifacts.map((a) => {
              const Icon = artifactIcon(a.mimeType);
              const senderName = a.senderBotId ? botMap.get(a.senderBotId)?.name : undefined;
              const downloadUrl = `/api/artifacts/${a.id}/content`;
              return (
                <div
                  key={a.id}
                  className="group flex items-center gap-2.5 px-2.5 py-2 rounded-lg border border-zinc-200/80 dark:border-zinc-800/80 hover:border-zinc-300 dark:hover:border-zinc-700 hover:bg-zinc-50 dark:hover:bg-zinc-900 transition-colors"
                >
                  <button
                    type="button"
                    onClick={() => setPreviewIndex(artifacts.findIndex((x) => x.id === a.id))}
                    title={`预览 ${a.filename}`}
                    className="flex items-center gap-2.5 flex-1 min-w-0 text-left cursor-pointer"
                  >
                    <div className="w-8 h-8 rounded-lg bg-zinc-100 dark:bg-zinc-900 border border-zinc-200/80 dark:border-zinc-800 flex items-center justify-center text-zinc-500 dark:text-zinc-400 shrink-0">
                      <Icon className="w-4 h-4" />
                    </div>
                    <div className="flex flex-col min-w-0 gap-0.5">
                      <span className="text-xs font-medium text-zinc-900 dark:text-zinc-100 truncate">
                        {a.filename}
                      </span>
                      <span className="text-[11px] text-zinc-400 dark:text-zinc-500 truncate">
                        {senderName || '节点'}
                        {' · '}
                        {formatRelativeTime(a.createdAt)}
                        {a.sizeBytes > 0 && (
                          <>
                            {' · '}
                            <span className="font-mono">{formatFileSize(a.sizeBytes)}</span>
                          </>
                        )}
                      </span>
                    </div>
                  </button>
                  <a
                    href={downloadUrl}
                    download={a.filename}
                    title={`下载 ${a.filename}`}
                    aria-label={`下载 ${a.filename}`}
                    className="p-1.5 rounded-lg text-zinc-400 hover:text-zinc-600 dark:text-zinc-500 dark:hover:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors shrink-0"
                  >
                    <Download className="w-3.5 h-3.5" />
                  </a>
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* 预览复用附件预览弹窗（z-50，盖过抽屉） */}
      {previewIndex !== null && artifacts[previewIndex] && (
        <AttachmentPreviewModal
          attachments={artifacts.map(toPreviewAttachment)}
          initialIndex={previewIndex}
          onClose={() => setPreviewIndex(null)}
        />
      )}
    </>
  );
};
