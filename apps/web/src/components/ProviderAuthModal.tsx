import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  X,
  KeyRound,
  ExternalLink,
  Copy,
  Check,
  AlertCircle,
  CheckCircle2,
  Loader2,
  Eye,
  EyeOff,
  ArrowRight,
  ShieldAlert,
} from 'lucide-react';
import { api } from '../api';
import type {
  ProviderAuthType,
  ProviderLoginState,
  ProviderLoginEvent,
  ProviderLoginPrompt,
} from '@botd/protocol';

interface ProviderAuthModalProps {
  isOpen: boolean;
  nodeId: string;
  nodeName: string;
  providerId: string;
  providerName: string;
  authMethod: {
    type: ProviderAuthType;
    label: string;
    interactive: boolean;
    subscription: boolean;
  };
  onClose: () => void;
  onSuccess: () => void;
}

function isSafeUrl(url?: string): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

export const ProviderAuthModal: React.FC<ProviderAuthModalProps> = ({
  isOpen,
  nodeId,
  nodeName,
  providerId,
  providerName,
  authMethod,
  onClose,
  onSuccess,
}) => {
  const [loginState, setLoginState] = useState<ProviderLoginState | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  // Prompt input state
  const [promptValue, setPromptValue] = useState('');
  const [showSecret, setShowSecret] = useState(false);
  const [submittingPrompt, setSubmittingPrompt] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  const activeLoginIdRef = useRef<string | null>(null);
  const pollTimerRef = useRef<any>(null);
  const isMountedRef = useRef(true);
  const epochRef = useRef(0);
  const revisionRef = useRef(0);
  const pollingRef = useRef(false);
  const onSuccessRef = useRef(onSuccess);
  onSuccessRef.current = onSuccess;

  const copyToClipboard = (text: string, label: string) => {
    if (navigator?.clipboard?.writeText) {
      navigator.clipboard
        .writeText(text)
        .then(() => {
          if (isMountedRef.current) setCopiedKey(label);
        })
        .catch(() => setError('浏览器未允许复制，请手动选择并复制'));
    } else {
      setError('当前浏览器环境无法自动复制，请手动选择并复制');
    }
    setTimeout(() => {
      if (isMountedRef.current) setCopiedKey(null);
    }, 2000);
  };

  const stopPolling = useCallback(() => {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  // Poll login state
  const pollLoginState = useCallback(
    async (loginId: string) => {
      if (pollingRef.current) return;
      pollingRef.current = true;
      const epoch = epochRef.current;
      const revision = revisionRef.current;
      try {
        const state = await api.getProviderLogin(nodeId, loginId);
        if (
          !isMountedRef.current ||
          activeLoginIdRef.current !== loginId ||
          epoch !== epochRef.current ||
          revision !== revisionRef.current
        )
          return;
        setLoginState(state);

        if (state.status === 'success') {
          stopPolling();
          onSuccessRef.current();
        } else if (state.status === 'error' || state.status === 'cancelled') {
          stopPolling();
          if (state.error) {
            setError(state.error);
          }
        }
      } catch (err: any) {
        if (!isMountedRef.current || epoch !== epochRef.current) return;
        if (err?.status === 404 || err?.status === 401) {
          stopPolling();
          setLoginState((previous) =>
            previous ? { ...previous, status: 'error', prompt: undefined } : previous
          );
        }
        setError(err?.message || '暂时无法连接节点，正在重试');
      } finally {
        if (epoch === epochRef.current) pollingRef.current = false;
      }
    },
    [nodeId, stopPolling]
  );

  // Start login when modal opens
  useEffect(() => {
    isMountedRef.current = true;
    if (!isOpen) {
      stopPolling();
      setLoginState(null);
      setError(null);
      activeLoginIdRef.current = null;
      return;
    }

    let active = true;
    let ownedLoginId: string | null = null;
    const epoch = ++epochRef.current;
    revisionRef.current++;
    pollingRef.current = false;
    activeLoginIdRef.current = null;
    setLoading(true);
    setError(null);
    setLoginState(null);
    setPromptValue('');
    setShowSecret(false);
    setCancelling(false);

    Promise.resolve()
      .then(() => (active ? api.startProviderLogin(nodeId, providerId, authMethod.type) : null))
      .then((state) => {
        if (!state) return;
        ownedLoginId = state.id;
        if (!active || !isMountedRef.current || epoch !== epochRef.current) {
          if (state.status === 'pending')
            void api.cancelProviderLogin(nodeId, state.id).catch(() => {});
          return;
        }
        setLoginState(state);
        activeLoginIdRef.current = state.id;

        // If prompt has select options, default to first option
        if (state.prompt?.type === 'select' && state.prompt.options?.[0]) {
          setPromptValue(state.prompt.options[0].id);
        }

        if (state.status === 'pending') {
          // Start polling every 1.5s
          pollTimerRef.current = setInterval(() => {
            if (activeLoginIdRef.current) {
              pollLoginState(activeLoginIdRef.current);
            }
          }, 1500);
        } else if (state.status === 'success') {
          onSuccessRef.current();
        } else if (state.status === 'error') {
          setError(state.error || '登录启动失败');
        }
      })
      .catch((err: any) => {
        if (!active || !isMountedRef.current) return;
        setError(err?.message || '发起登录交互失败，请确认节点在线');
      })
      .finally(() => {
        if (active && isMountedRef.current) {
          setLoading(false);
        }
      });

    return () => {
      active = false;
      isMountedRef.current = false;
      epochRef.current++;
      stopPolling();
      if (ownedLoginId) void api.cancelProviderLogin(nodeId, ownedLoginId).catch(() => {});
    };
  }, [isOpen, nodeId, providerId, authMethod.type, pollLoginState, stopPolling]);

  // When prompt changes, reset prompt input if needed
  useEffect(() => {
    if (loginState?.prompt) {
      if (loginState.prompt.type === 'select') {
        setPromptValue(loginState.prompt.options?.[0]?.id || '');
      } else {
        setPromptValue('');
      }
      setShowSecret(false);
    }
  }, [loginState?.prompt?.id]);

  if (!isOpen) return null;

  const handlePromptSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!loginState || !loginState.prompt || submittingPrompt) return;
    revisionRef.current++;
    setSubmittingPrompt(true);
    setError(null);
    try {
      const nextState = await api.respondProviderLogin(
        nodeId,
        loginState.id,
        loginState.prompt.id,
        promptValue
      );
      if (!isMountedRef.current) return;
      revisionRef.current++;
      setLoginState(nextState);
      setPromptValue('');
      if (nextState.status === 'success') {
        stopPolling();
        onSuccessRef.current();
      } else if (nextState.status === 'error') {
        stopPolling();
        setError(nextState.error || '回复失败');
      }
    } catch (err: any) {
      setError(err?.message || '提交回复失败，请重试');
    } finally {
      setSubmittingPrompt(false);
    }
  };

  const handleCancel = async () => {
    if (cancelling) return;
    setCancelling(true);
    stopPolling();
    const loginId = activeLoginIdRef.current || loginState?.id;
    if (loginId && nodeId) {
      try {
        await api.cancelProviderLogin(nodeId, loginId);
      } catch {
        // ignore cancel error
      }
    }
    onClose();
  };

  const renderEventItem = (event: ProviderLoginEvent, index: number) => {
    switch (event.type) {
      case 'info':
        return (
          <div
            key={index}
            className="p-3 bg-zinc-50 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl text-xs text-zinc-700 dark:text-zinc-300 space-y-1.5"
          >
            <p className="whitespace-pre-wrap">{event.message}</p>
            {event.links && event.links.length > 0 && (
              <div className="flex flex-wrap gap-2 pt-1">
                {event.links.map((link, lIdx) => {
                  const safe = isSafeUrl(link.url);
                  return safe ? (
                    <a
                      key={lIdx}
                      href={link.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-zinc-900 dark:text-zinc-100 underline text-xs font-medium hover:text-zinc-600 dark:hover:text-zinc-300"
                    >
                      <span>{link.label || link.url}</span>
                      <ExternalLink className="w-3 h-3" />
                    </a>
                  ) : (
                    <span key={lIdx} className="text-zinc-500 dark:text-zinc-400 text-xs">
                      {link.label || link.url}
                    </span>
                  );
                })}
              </div>
            )}
          </div>
        );

      case 'auth_url': {
        const safe = isSafeUrl(event.url);
        return (
          <div key={index} className="p-3.5 bg-zinc-50 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-zinc-900 dark:text-zinc-100 flex items-center gap-1.5">
                <ExternalLink className="w-3.5 h-3.5 text-zinc-700 dark:text-zinc-300" />
                <span>授权认证链接</span>
              </span>
              <button
                type="button"
                onClick={() => copyToClipboard(event.url, `auth-url-${index}`)}
                className="text-[11px] text-zinc-700 dark:text-zinc-300 hover:text-zinc-900 dark:hover:text-zinc-100 flex items-center gap-1 px-2 py-0.5 rounded bg-zinc-200/80 dark:bg-zinc-800 hover:bg-zinc-200 dark:hover:bg-zinc-700 transition-colors"
              >
                {copiedKey === `auth-url-${index}` ? (
                  <>
                    <Check className="w-3 h-3 text-emerald-600 dark:text-emerald-400" />
                    <span>已复制</span>
                  </>
                ) : (
                  <>
                    <Copy className="w-3 h-3" />
                    <span>复制链接</span>
                  </>
                )}
              </button>
            </div>
            {event.instructions && (
              <p className="text-xs text-zinc-700 dark:text-zinc-300 whitespace-pre-wrap">{event.instructions}</p>
            )}
            {safe ? (
              <div className="pt-1">
                <a
                  href={event.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center justify-center gap-1.5 w-full py-2 px-3 bg-zinc-900 hover:bg-zinc-800 text-white dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white rounded-xl text-xs font-semibold shadow-xs transition-colors"
                >
                  <span>在浏览器中打开授权页面</span>
                  <ExternalLink className="w-3.5 h-3.5" />
                </a>
              </div>
            ) : (
              <p className="text-xs text-rose-600 dark:text-rose-400 font-mono break-all">{event.url}</p>
            )}
          </div>
        );
      }

      case 'device_code': {
        const safeUri = isSafeUrl(event.verificationUri);
        return (
          <div key={index} className="p-4 bg-zinc-50 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-zinc-900 dark:text-zinc-100">设备验证码</span>
              {event.expiresInSeconds && (
                <span className="text-[10px] text-zinc-500 dark:text-zinc-400 font-mono">
                  有效期: {event.expiresInSeconds}s
                </span>
              )}
            </div>

            <div className="flex items-center justify-between p-3 bg-white dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 rounded-xl shadow-xs">
              <span className="text-xl font-mono font-bold tracking-widest text-zinc-900 dark:text-zinc-100 select-all">
                {event.userCode}
              </span>
              <button
                type="button"
                onClick={() => copyToClipboard(event.userCode, 'user-code')}
                className="px-3 py-1.5 bg-zinc-100 dark:bg-zinc-800 hover:bg-zinc-200 dark:hover:bg-zinc-700 text-zinc-800 dark:text-zinc-200 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-colors"
              >
                {copiedKey === 'user-code' ? (
                  <>
                    <Check className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
                    <span>已复制</span>
                  </>
                ) : (
                  <>
                    <Copy className="w-3.5 h-3.5" />
                    <span>复制代码</span>
                  </>
                )}
              </button>
            </div>

            <div className="text-xs text-zinc-600 dark:text-zinc-400 space-y-1">
              <p>请前往以下验证网址并输入上方设备码：</p>
              {safeUri ? (
                <a
                  href={event.verificationUri}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-zinc-900 dark:text-zinc-100 hover:underline font-mono break-all font-medium"
                >
                  <span>{event.verificationUri}</span>
                  <ExternalLink className="w-3 h-3 shrink-0" />
                </a>
              ) : (
                <span className="font-mono text-zinc-700 dark:text-zinc-300 break-all">{event.verificationUri}</span>
              )}
            </div>
          </div>
        );
      }

      case 'progress':
        return (
          <div
            key={index}
            className="p-3 bg-zinc-50 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl flex items-center gap-2.5 text-xs text-zinc-600 dark:text-zinc-400"
          >
            <Loader2 className="w-4 h-4 text-zinc-700 dark:text-zinc-300 animate-spin shrink-0" />
            <span className="flex-1">{event.message}</span>
          </div>
        );

      default:
        return null;
    }
  };

  const renderPromptForm = (prompt: ProviderLoginPrompt) => {
    return (
      <form
        onSubmit={handlePromptSubmit}
        className="p-4 bg-zinc-50 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl space-y-3"
      >
        <div>
          <label className="block text-xs font-semibold text-zinc-900 dark:text-zinc-100 mb-1">
            {prompt.message}
          </label>
        </div>

        {prompt.type === 'text' && (
          <input
            type="text"
            aria-label={prompt.message}
            value={promptValue}
            onChange={(e) => setPromptValue(e.target.value)}
            placeholder={prompt.placeholder || '请输入...'}
            disabled={submittingPrompt}
            className="w-full px-3 py-2 text-base sm:text-xs bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded-xl focus:outline-none focus:ring-1 focus:ring-zinc-900 dark:focus:ring-zinc-400 text-zinc-800 dark:text-zinc-200 placeholder-zinc-400 dark:placeholder-zinc-500"
            autoFocus
          />
        )}

        {prompt.type === 'secret' && (
          <div className="relative">
            <input
              type={showSecret ? 'text' : 'password'}
              aria-label={prompt.message}
              value={promptValue}
              onChange={(e) => setPromptValue(e.target.value)}
              placeholder={prompt.placeholder || '请输入敏感信息/密钥...'}
              disabled={submittingPrompt}
              className="w-full pl-3 pr-10 py-2 text-base sm:text-xs bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded-xl focus:outline-none focus:ring-1 focus:ring-zinc-900 dark:focus:ring-zinc-400 font-mono text-zinc-800 dark:text-zinc-200 placeholder-zinc-400 dark:placeholder-zinc-500"
              autoFocus
            />
            <button
              type="button"
              onClick={() => setShowSecret(!showSecret)}
              className="absolute inset-y-0 right-0 pr-3 flex items-center text-zinc-400 hover:text-zinc-600 dark:text-zinc-500 dark:hover:text-zinc-300"
              aria-label={showSecret ? '隐藏' : '显示'}
            >
              {showSecret ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
            </button>
          </div>
        )}

        {prompt.type === 'manual_code' && (
          <div className="space-y-1.5">
            <textarea
              aria-label={prompt.message}
              value={promptValue}
              onChange={(e) => setPromptValue(e.target.value)}
              placeholder={prompt.placeholder || '请在此粘贴授权回调页面 URL 或授权 Code...'}
              disabled={submittingPrompt}
              rows={3}
              className="w-full p-2.5 text-base sm:text-xs bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded-xl focus:outline-none focus:ring-1 focus:ring-zinc-900 dark:focus:ring-zinc-400 font-mono leading-relaxed resize-none text-zinc-800 dark:text-zinc-200 placeholder-zinc-400 dark:placeholder-zinc-500"
              autoFocus
            />
            <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
              提示：浏览器重定向后若出现连接失败页面，可直接将地址栏完整 URL 复制并粘贴到上方。
            </p>
          </div>
        )}

        {prompt.type === 'select' && (
          <div className="space-y-2">
            {prompt.options && prompt.options.length > 0 ? (
              prompt.options.map((opt) => (
                <label
                  key={opt.id}
                  className={`flex items-start gap-2.5 p-2.5 rounded-xl border text-xs cursor-pointer transition-colors ${
                    promptValue === opt.id
                      ? 'bg-zinc-100 dark:bg-zinc-800 border-zinc-400 dark:border-zinc-600 text-zinc-900 dark:text-zinc-100 font-medium'
                      : 'bg-white dark:bg-zinc-950 border-zinc-200 dark:border-zinc-800 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-900'
                  }`}
                >
                  <input
                    type="radio"
                    name="prompt-select"
                    value={opt.id}
                    checked={promptValue === opt.id}
                    onChange={(e) => setPromptValue(e.target.value)}
                    className="mt-0.5 text-zinc-900 dark:text-zinc-100 border-zinc-300 dark:border-zinc-700 focus:ring-zinc-800 dark:focus:ring-zinc-400 dark:bg-zinc-900"
                  />
                  <div>
                    <div className="font-semibold">{opt.label}</div>
                    {opt.description && (
                      <p className="text-[11px] text-zinc-500 dark:text-zinc-400 mt-0.5">{opt.description}</p>
                    )}
                  </div>
                </label>
              ))
            ) : (
              <input
                type="text"
                value={promptValue}
                onChange={(e) => setPromptValue(e.target.value)}
                placeholder="请输入选项..."
                className="w-full px-3 py-2 text-base sm:text-xs bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded-xl text-zinc-800 dark:text-zinc-200 placeholder-zinc-400 dark:placeholder-zinc-500"
              />
            )}
          </div>
        )}

        <div className="flex items-center justify-end gap-2 pt-1">
          <button
            type="submit"
            disabled={submittingPrompt}
            className="px-4 py-2 bg-zinc-900 hover:bg-zinc-800 disabled:bg-zinc-300 text-white dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white dark:disabled:bg-zinc-800 dark:disabled:text-zinc-600 rounded-xl text-xs font-semibold flex items-center gap-1.5 shadow-xs transition-colors"
          >
            {submittingPrompt ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <ArrowRight className="w-3.5 h-3.5" />
            )}
            <span>提交回复</span>
          </button>
        </div>
      </form>
    );
  };

  const isPending = loginState?.status === 'pending';
  const isSuccess = loginState?.status === 'success';
  const isCancelled = loginState?.status === 'cancelled';

  return (
    <div
      className="fixed inset-0 z-60 bg-black/50 dark:bg-black/70 backdrop-blur-xs flex items-end sm:items-center justify-center p-0 sm:p-4 overflow-hidden animate-in fade-in"
      role="dialog"
      aria-modal="true"
      aria-labelledby="auth-modal-title"
    >
      <div className="bg-white dark:bg-zinc-950 rounded-t-2xl sm:rounded-2xl shadow-2xl border border-zinc-200 dark:border-zinc-800 max-w-lg w-full overflow-hidden flex flex-col max-h-[92dvh] sm:max-h-[88vh]">
        {/* Mobile pull indicator */}
        <div className="sm:hidden pt-2.5 pb-1 flex justify-center shrink-0">
          <div className="w-9 h-1 rounded-full bg-zinc-300 dark:bg-zinc-700" />
        </div>

        {/* Header */}
        <div className="px-5 sm:px-6 py-3.5 border-b border-zinc-200/80 dark:border-zinc-800/80 flex items-center justify-between shrink-0 bg-zinc-50/60 dark:bg-zinc-900/60">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-xl bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900 flex items-center justify-center shadow-xs">
              <KeyRound className="w-4 h-4" />
            </div>
            <div>
              <h2 id="auth-modal-title" className="text-sm sm:text-base font-semibold text-zinc-900 dark:text-zinc-100">
                {authMethod.type === 'oauth' ? 'OAuth 授权登录' : '本地 API Key 交互配置'}
              </h2>
              <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
                目标服务商: <strong className="text-zinc-700 dark:text-zinc-300">{providerName}</strong> ({providerId}) · 节点:{' '}
                <strong className="text-zinc-700 dark:text-zinc-300">{nodeName}</strong>
              </p>
            </div>
          </div>
          <button
            onClick={handleCancel}
            className="p-1.5 text-zinc-400 hover:text-zinc-700 dark:text-zinc-500 dark:hover:text-zinc-200 rounded-lg hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
            aria-label="关闭对话框"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content body */}
        <div className="p-4 sm:p-6 overflow-y-auto space-y-4 flex-1">
          {error && (
            <div className="p-3 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900/60 text-rose-700 dark:text-rose-300 text-xs rounded-xl flex items-start gap-2">
              <AlertCircle className="w-4 h-4 text-rose-500 dark:text-rose-400 shrink-0 mt-0.5" />
              <div className="flex-1 whitespace-pre-wrap">{error}</div>
            </div>
          )}

          {loading ? (
            <div className="py-12 flex flex-col items-center justify-center text-zinc-400 dark:text-zinc-500 gap-2.5">
              <Loader2 className="w-6 h-6 animate-spin text-zinc-600 dark:text-zinc-400" />
              <p className="text-xs font-medium text-zinc-600 dark:text-zinc-400">正在与节点建立 SDK 认证会话...</p>
            </div>
          ) : (
            <>
              {/* Login State Banner */}
              {isSuccess && (
                <div className="p-4 bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-900/60 rounded-xl flex items-center gap-3 text-emerald-800 dark:text-emerald-300 text-xs">
                  <CheckCircle2 className="w-5 h-5 text-emerald-600 dark:text-emerald-400 shrink-0" />
                  <div>
                    <div className="font-bold">认证成功！</div>
                    <p className="text-emerald-700 dark:text-emerald-400 mt-0.5">
                      凭据已成功写入节点 <code>~/.botd/.agent/auth.json</code>，后续推理可直接使用。
                    </p>
                  </div>
                </div>
              )}

              {isCancelled && (
                <div className="p-3 bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-xl text-xs text-zinc-600 dark:text-zinc-400">
                  认证流程已取消。
                </div>
              )}

              {/* Polling / Pending status indicator */}
              {isPending && !loginState?.prompt && (
                <div className="p-3 bg-zinc-50 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl flex items-center gap-2.5 text-xs text-zinc-700 dark:text-zinc-300">
                  <Loader2 className="w-4 h-4 text-zinc-600 dark:text-zinc-400 animate-spin shrink-0" />
                  <span>正在等待浏览器端授权完成或节点回调响应...</span>
                </div>
              )}

              {/* Events history */}
              {loginState?.events && loginState.events.length > 0 && (
                <div className="space-y-2.5">
                  <span className="text-[11px] font-semibold text-zinc-500 dark:text-zinc-400 uppercase tracking-wider block">
                    交互流程详情
                  </span>
                  {loginState.events.map((evt, idx) => renderEventItem(evt, idx))}
                </div>
              )}

              {/* Active prompt */}
              {isPending && loginState?.prompt && renderPromptForm(loginState.prompt)}

              <div className="p-3 bg-zinc-50 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl flex items-start gap-2 text-[11px] text-zinc-500 dark:text-zinc-400">
                <ShieldAlert className="w-4 h-4 text-zinc-400 dark:text-zinc-500 shrink-0 mt-0.5" />
                <span>凭据保存在所选节点。授权完成后，此页面仅接收登录状态。</span>
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 sm:px-6 py-3 border-t border-zinc-200/80 dark:border-zinc-800/80 bg-zinc-50/60 dark:bg-zinc-900/60 flex items-center justify-between shrink-0">
          <div className="text-[11px] text-zinc-500 dark:text-zinc-400">
            {isPending && (
              <span className="flex items-center gap-1.5 text-zinc-700 dark:text-zinc-300 font-medium">
                <span className="w-2 h-2 rounded-full bg-zinc-800 dark:bg-zinc-200 animate-pulse" />
                <span>正在等待授权完成...</span>
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {isSuccess ? (
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 dark:bg-emerald-500 dark:hover:bg-emerald-600 text-white rounded-xl text-xs font-semibold shadow-xs transition-colors"
              >
                完成
              </button>
            ) : (
              <button
                type="button"
                onClick={handleCancel}
                disabled={cancelling}
                className="px-4 py-2 text-xs font-medium text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded-xl transition-colors"
              >
                {isPending ? '取消认证' : '关闭'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
