import React, { useState, useEffect } from 'react';
import {
  X,
  Share2,
  Copy,
  Check,
  ExternalLink,
  RefreshCw,
  Trash2,
  Loader2,
  AlertCircle,
  Globe,
} from 'lucide-react';
import type { SessionShareRecord } from '@botd/protocol';
import { api } from '../api';
import { copyText } from '../utils/clipboard';

interface ShareSessionModalProps {
  sessionId: string;
  onClose: () => void;
}

export const ShareSessionModal: React.FC<ShareSessionModalProps> = ({
  sessionId,
  onClose,
}) => {
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [share, setShare] = useState<SessionShareRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    api
      .getSessionShare(sessionId)
      .then((res) => {
        if (active) {
          setShare(res.share);
        }
      })
      .catch((err: unknown) => {
        if (active) {
          setError(err instanceof Error ? err.message : '获取分享状态失败');
        }
      })
      .finally(() => {
        if (active) {
          setLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, [sessionId]);

  const shareUrl = share ? `${window.location.origin}/?share=${share.token}` : '';

  const handleCreate = async () => {
    setActionLoading(true);
    setError(null);
    try {
      const record = await api.createSessionShare(sessionId);
      setShare(record);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : '创建分享链接失败');
    } finally {
      setActionLoading(false);
    }
  };

  const handleRegenerate = async () => {
    setActionLoading(true);
    setError(null);
    try {
      const record = await api.createSessionShare(sessionId, true);
      setShare(record);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : '重新生成分享链接失败');
    } finally {
      setActionLoading(false);
    }
  };

  const handleRevoke = async () => {
    setActionLoading(true);
    setError(null);
    try {
      await api.revokeSessionShare(sessionId);
      setShare(null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : '撤销分享链接失败');
    } finally {
      setActionLoading(false);
    }
  };

  const handleCopy = async () => {
    if (!shareUrl) return;
    const ok = await copyText(shareUrl);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleOpenNewTab = () => {
    if (!shareUrl) return;
    window.open(shareUrl, '_blank', 'noopener,noreferrer');
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="share-modal-title"
      className="fixed inset-0 z-50 bg-black/40 backdrop-blur-xs flex items-center justify-center p-4 animate-in fade-in"
    >
      <div className="w-full max-w-md bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl shadow-xl flex flex-col overflow-hidden">
        {/* 顶部标题栏 */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-100 dark:border-zinc-800">
          <div className="flex items-center gap-2">
            <Share2 className="w-4 h-4 text-zinc-600 dark:text-zinc-400" />
            <h2 id="share-modal-title" className="text-sm sm:text-base font-semibold text-zinc-900 dark:text-zinc-100">
              分享对话
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className="h-8 w-8 rounded-lg hover:bg-zinc-100 dark:hover:bg-zinc-800 text-zinc-500 flex items-center justify-center transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* 主体内容 */}
        <div className="p-4 space-y-3.5">
          {error && (
            <div className="flex items-start gap-2 p-2.5 rounded-lg bg-rose-50 dark:bg-rose-950/40 border border-rose-200/80 dark:border-rose-900/60 text-xs text-rose-700 dark:text-rose-300">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          {loading ? (
            <div className="flex flex-col items-center justify-center py-8 text-zinc-400">
              <Loader2 className="w-5 h-5 animate-spin mb-2" />
              <span className="text-xs">加载分享状态…</span>
            </div>
          ) : !share ? (
            <div className="space-y-3 py-1">
              <div className="flex items-start gap-3 p-3 rounded-lg bg-zinc-50 dark:bg-zinc-800/50 border border-zinc-200/70 dark:border-zinc-800 text-zinc-600 dark:text-zinc-300">
                <Globe className="w-4 h-4 shrink-0 text-zinc-500 mt-0.5" />
                <div className="text-xs leading-relaxed">
                  创建公开分享链接后，任何拥有该链接的人均可在浏览器中免登录只读查看此对话的完整回放、模型推理思考轨迹与生成产物。
                </div>
              </div>

              <div className="flex justify-end pt-1">
                <button
                  type="button"
                  onClick={handleCreate}
                  disabled={actionLoading}
                  className="h-8 px-3 rounded-lg text-xs font-medium bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900 hover:opacity-90 disabled:opacity-50 transition-all flex items-center gap-1.5 cursor-pointer"
                >
                  {actionLoading ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Share2 className="w-3.5 h-3.5" />
                  )}
                  <span>创建公开分享链接</span>
                </button>
              </div>
            </div>
          ) : (
            <div className="space-y-3 py-1">
              <div>
                <label className="text-xs font-medium text-zinc-700 dark:text-zinc-300 block mb-1.5">
                  公开只读回放链接
                </label>
                <div className="relative">
                  <input
                    type="text"
                    readOnly
                    value={shareUrl}
                    onClick={(e) => (e.target as HTMLInputElement).select()}
                    className="h-8 px-2.5 text-xs rounded-lg bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 text-zinc-800 dark:text-zinc-200 font-mono w-full select-all focus:outline-hidden"
                  />
                </div>
                <div className="text-[11px] text-zinc-400 dark:text-zinc-500 mt-1">
                  任何人持此链接均可免登录查看对话回放及附件
                </div>
              </div>

              {/* 操作按钮栏 */}
              <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-zinc-100 dark:border-zinc-800">
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={handleCopy}
                    className="h-8 px-2.5 rounded-lg text-xs font-medium bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900 hover:opacity-90 transition-all flex items-center gap-1.5 cursor-pointer"
                  >
                    {copied ? (
                      <>
                        <Check className="w-3.5 h-3.5 text-emerald-400 dark:text-emerald-600" />
                        <span>已复制</span>
                      </>
                    ) : (
                      <>
                        <Copy className="w-3.5 h-3.5" />
                        <span>复制链接</span>
                      </>
                    )}
                  </button>

                  <button
                    type="button"
                    onClick={handleOpenNewTab}
                    className="h-8 px-2.5 rounded-lg text-xs font-medium bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-200 dark:hover:bg-zinc-700 transition-colors flex items-center gap-1.5 cursor-pointer"
                  >
                    <ExternalLink className="w-3.5 h-3.5" />
                    <span>新标签页打开</span>
                  </button>
                </div>

                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={handleRegenerate}
                    disabled={actionLoading}
                    title="重置分享 Token，使旧链接立即失效"
                    className="h-8 px-2.5 rounded-lg text-xs font-medium bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-200 dark:hover:bg-zinc-700 disabled:opacity-50 transition-colors flex items-center gap-1.5 cursor-pointer"
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${actionLoading ? 'animate-spin' : ''}`} />
                    <span>重新生成</span>
                  </button>

                  <button
                    type="button"
                    onClick={handleRevoke}
                    disabled={actionLoading}
                    title="彻底撤销分享"
                    className="h-8 px-2.5 rounded-lg text-xs font-medium text-rose-600 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/40 border border-transparent hover:border-rose-200 dark:hover:border-rose-900/60 disabled:opacity-50 transition-colors flex items-center gap-1.5 cursor-pointer"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    <span>撤销分享</span>
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
