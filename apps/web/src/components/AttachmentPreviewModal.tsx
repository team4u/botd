import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  X,
  Download,
  Copy,
  Check,
  Loader2,
  FileWarning,
  ChevronLeft,
  ChevronRight,
  Eye,
} from 'lucide-react';
import type { MessageAttachment } from '@botd/protocol';
import { Markdown } from './Markdown';
import { copyText } from '../utils/clipboard';
import { formatFileSize } from './MessageItem';

/** 文本类预览的体积上限（超出仅提供下载，避免拉爆浏览器） */
const MAX_TEXT_PREVIEW_BYTES = 2 * 1024 * 1024;
/** 音视频预览的体积上限（超出仅提供下载） */
const MAX_MEDIA_PREVIEW_BYTES = 100 * 1024 * 1024;

type PreviewKind = 'image' | 'audio' | 'video' | 'pdf' | 'text' | 'none';

/** 依据 MIME 类型与体积判断预览方式（none = 仅下载） */
function classifyPreview(att: MessageAttachment): PreviewKind {
  const mime = (att.mimeType || '').toLowerCase();
  const size = att.sizeBytes || 0;

  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('audio/') && size <= MAX_MEDIA_PREVIEW_BYTES) return 'audio';
  if (mime.startsWith('video/') && size <= MAX_MEDIA_PREVIEW_BYTES) return 'video';
  if (mime === 'application/pdf' && size <= MAX_MEDIA_PREVIEW_BYTES) return 'pdf';

  const looksText =
    mime.startsWith('text/') ||
    mime === 'application/json' ||
    mime === 'application/xml' ||
    mime === 'application/javascript' ||
    mime === 'application/yaml' ||
    /\.(md|markdown|txt|log|json|ya?ml|toml|ini|csv|tsv|xml|html?|css|scss|js|jsx|mjs|cjs|ts|tsx|py|rb|go|rs|java|kt|c|h|cpp|hpp|cs|php|sh|bash|zsh|fish|sql|graphql|env|gitignore|dockerfile)$/i.test(
      att.filename || ''
    );
  if (looksText && size <= MAX_TEXT_PREVIEW_BYTES) return 'text';

  return 'none';
}

/** 文本预览的语法高亮语言（供代码级文本走 pre 渲染参考） */
function isMarkdown(att: MessageAttachment): boolean {
  const mime = (att.mimeType || '').toLowerCase();
  return (
    mime === 'text/markdown' ||
    /(\.md|\.markdown)$/i.test(att.filename || '')
  );
}

interface AttachmentPreviewModalProps {
  /** 待预览的附件列表（支持左右切换） */
  attachments: MessageAttachment[];
  /** 初始聚焦的附件下标 */
  initialIndex: number;
  onClose: () => void;
}

export const AttachmentPreviewModal: React.FC<AttachmentPreviewModalProps> = ({
  attachments,
  initialIndex,
  onClose,
}) => {
  const [index, setIndex] = useState(Math.min(Math.max(initialIndex, 0), attachments.length - 1));
  const att = attachments[index];

  const kind = useMemo(() => (att ? classifyPreview(att) : 'none'), [att]);
  const markdown = useMemo(() => (att ? isMarkdown(att) : false), [att]);

  // 文本内容（按需懒加载）
  const [text, setText] = useState<string | null>(null);
  const [textError, setTextError] = useState<string | null>(null);
  const [textLoading, setTextLoading] = useState(false);

  // 复制按钮状态
  const [copied, setCopied] = useState(false);

  // Esc 关闭 / 左右切换
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowLeft' && index > 0) setIndex(index - 1);
      if (e.key === 'ArrowRight' && index < attachments.length - 1) setIndex(index + 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [index, attachments.length, onClose]);

  // 切换附件时重置懒加载状态
  useEffect(() => {
    setText(null);
    setTextError(null);
    setCopied(false);
  }, [att?.id]);

  // 懒加载文本内容：仅在切换附件或进入文本预览时发起，加载中/已加载/已出错均不重发
  useEffect(() => {
    if (!att || kind !== 'text') return;
    let cancelled = false;
    setTextLoading(true);
    fetch(att.url)
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.text();
      })
      .then((content) => {
        if (!cancelled) {
          setText(content);
          setTextLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setTextError('内容加载失败，请尝试下载后查看');
          setTextLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [att?.id, kind]);

  const handleCopyText = useCallback(async () => {
    if (text === null) return;
    const ok = await copyText(text);
    if (ok) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    }
  }, [text]);

  const showPrev = index > 0;
  const showNext = index < attachments.length - 1;

  const iconBtn =
    'p-1.5 rounded-lg text-zinc-400 hover:text-zinc-600 dark:text-zinc-500 dark:hover:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer';

  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 dark:bg-black/80 backdrop-blur-xs flex flex-col animate-in fade-in"
      role="dialog"
      aria-modal="true"
      aria-label={`附件预览：${att?.filename ?? ''}`}
    >
      {/* 顶栏：文件名 + 操作 */}
      <div className="flex items-center gap-2 px-3 sm:px-4 h-13 sm:h-14 bg-white dark:bg-zinc-950 border-b border-zinc-200/80 dark:border-zinc-800/80 shrink-0">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <Eye className="w-4 h-4 text-zinc-400 dark:text-zinc-500 shrink-0" />
          <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100 truncate">
            {att?.filename}
          </span>
          {typeof att?.sizeBytes === 'number' && att.sizeBytes > 0 && (
            <span className="text-[11px] font-mono text-zinc-400 dark:text-zinc-500 shrink-0">
              {formatFileSize(att.sizeBytes)}
            </span>
          )}
          {attachments.length > 1 && (
            <span className="text-[11px] text-zinc-400 dark:text-zinc-500 shrink-0">
              {index + 1} / {attachments.length}
            </span>
          )}
        </div>

        {/* 文本类：一键复制全文 */}
        {kind === 'text' && text !== null && (
          <button type="button" onClick={handleCopyText} className={iconBtn} title="复制全文" aria-label="复制全文">
            {copied ? (
              <Check className="w-4 h-4 text-emerald-500 dark:text-emerald-400" />
            ) : (
              <Copy className="w-4 h-4" />
            )}
          </button>
        )}

        {/* 下载（始终可用） */}
        <a href={att?.url} download={att?.filename} className={iconBtn} title="下载" aria-label="下载">
          <Download className="w-4 h-4" />
        </a>

        <button type="button" onClick={onClose} className={iconBtn} title="关闭 (Esc)" aria-label="关闭">
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* 主体：按类型渲染 */}
      <div className="flex-1 min-h-0 relative flex items-center justify-center p-3 sm:p-6 overflow-auto">
        {kind === 'image' && (
          <img
            src={att.url}
            alt={att.filename}
            className="max-w-full max-h-full object-contain rounded-lg shadow-lg"
          />
        )}

        {kind === 'audio' && (
          <audio controls src={att.url} className="w-full max-w-xl">
            <track kind="captions" />
          </audio>
        )}

        {kind === 'video' && (
          <video controls src={att.url} className="max-w-full max-h-full rounded-lg shadow-lg">
            <track kind="captions" />
          </video>
        )}

        {kind === 'pdf' && (
          <iframe
            src={att.url}
            title={att.filename}
            className="w-full h-full rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white shadow-lg"
          />
        )}

        {kind === 'text' && (
          <div className="w-full max-w-3xl h-full min-h-0 flex flex-col">
            {textLoading && (
              <div className="flex items-center justify-center gap-2 text-zinc-400 dark:text-zinc-500 text-xs py-16">
                <Loader2 className="w-4 h-4 animate-spin" />
                <span>加载中...</span>
              </div>
            )}
            {textError && (
              <div className="flex flex-col items-center justify-center gap-2 text-zinc-400 dark:text-zinc-500 text-xs py-16">
                <FileWarning className="w-6 h-6" />
                <span>{textError}</span>
              </div>
            )}
            {text !== null &&
              (markdown ? (
                <div className="prose-botd text-left w-full rounded-xl border border-zinc-200/80 dark:border-zinc-800 bg-white dark:bg-zinc-950 p-4 sm:p-6 overflow-auto shadow-lg">
                  <Markdown>{text}</Markdown>
                </div>
              ) : (
                <pre className="prose-botd prose-botd--xs !my-0 w-full h-full text-left rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900 p-4 overflow-auto font-mono leading-relaxed text-zinc-800 dark:text-zinc-200 shadow-lg">
                  {text}
                </pre>
              ))}
          </div>
        )}

        {kind === 'none' && (
          <div className="flex flex-col items-center justify-center gap-3 text-zinc-400 dark:text-zinc-500 py-16">
            <FileWarning className="w-8 h-8" />
            <div className="text-xs">该文件类型暂不支持在线预览</div>
            <a
              href={att?.url}
              download={att?.filename}
              className="h-8 px-3 inline-flex items-center gap-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 text-white dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white text-xs font-medium transition-colors"
            >
              <Download className="w-3.5 h-3.5" />
              <span>下载文件</span>
            </a>
          </div>
        )}

        {/* 左右切换（多附件时） */}
        {showPrev && (
          <button
            type="button"
            onClick={() => setIndex(index - 1)}
            className="absolute left-2 sm:left-4 top-1/2 -translate-y-1/2 w-9 h-9 flex items-center justify-center rounded-full bg-white/90 dark:bg-zinc-900/90 border border-zinc-200 dark:border-zinc-800 shadow-lg text-zinc-600 dark:text-zinc-300 hover:bg-white dark:hover:bg-zinc-800 transition-colors cursor-pointer"
            aria-label="上一个附件"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
        )}
        {showNext && (
          <button
            type="button"
            onClick={() => setIndex(index + 1)}
            className="absolute right-2 sm:right-4 top-1/2 -translate-y-1/2 w-9 h-9 flex items-center justify-center rounded-full bg-white/90 dark:bg-zinc-900/90 border border-zinc-200 dark:border-zinc-800 shadow-lg text-zinc-600 dark:text-zinc-300 hover:bg-white dark:hover:bg-zinc-800 transition-colors cursor-pointer"
            aria-label="下一个附件"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        )}
      </div>
    </div>
  );
};
