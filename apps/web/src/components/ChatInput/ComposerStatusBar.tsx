import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Brain, ChevronDown, FolderClosed, Loader2, Search, Sparkles, Zap } from 'lucide-react';
import type { BotConfig, ModelCatalog, ThinkingLevel } from '@botd/protocol';
import { THINKING_LEVELS } from '@botd/protocol';
import { api } from '../../api';

/** 模型简称：截取 modelId 中有辨识度的短段（如 claude-sonnet-4-5 / glm-4.6） */
function shortModelLabel(modelId: string): string {
  if (!modelId) return '未设置';
  return modelId.length > 24 ? `${modelId.slice(0, 22)}…` : modelId;
}

const THINKING_SHORT_LABELS: Record<Exclude<ThinkingLevel, ''>, string> = {
  off: '思考: off',
  minimal: '思考: minimal',
  low: '思考: low',
  medium: '思考: medium',
  high: '思考: high',
  xhigh: '思考: xhigh',
  max: '思考: max',
};

interface ComposerStatusBarProps {
  /** 当前主控 BOT（模型/思考档位的秒切目标） */
  currentBot: BotConfig;
  /** 点击 /compact 芯片：向输入框插入压缩命令 */
  onCompact?: () => void;
  /** 点击 /new 芯片：向输入框插入新话题命令 */
  onNewTopic?: () => void;
}

/**
 * 输入框底栏微操舱：模型秒切、思考档位秒切、工作区路径徽章与快捷指令芯片。
 * 模型/档位变更走 api.updateBot 增量保存，本地乐观更新显示，失败时回滚。
 */
export const ComposerStatusBar: React.FC<ComposerStatusBarProps> = ({
  currentBot,
  onCompact,
  onNewTopic,
}) => {
  // 乐观 UI 状态：null 表示跟随 currentBot 真实值
  const [modelOverride, setModelOverride] = useState<{ provider: string; modelId: string } | null>(null);
  const [thinkingOverride, setThinkingOverride] = useState<ThinkingLevel | null>(null);
  const [savingModel, setSavingModel] = useState(false);
  const [savingError, setSavingError] = useState<string | null>(null);

  // 模型选择浮层
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [thinkingMenuOpen, setThinkingMenuOpen] = useState(false);
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null);
  const [loadingCatalog, setLoadingCatalog] = useState(false);
  const [modelSearch, setModelSearch] = useState('');

  const modelMenuRef = useRef<HTMLDivElement>(null);
  const thinkingMenuRef = useRef<HTMLDivElement>(null);
  const modelSearchInputRef = useRef<HTMLInputElement>(null);

  const modelProvider = modelOverride?.provider ?? currentBot.modelProvider;
  const modelId = modelOverride?.modelId ?? currentBot.modelId;
  const thinkingLevel = (thinkingOverride ?? currentBot.thinkingLevel ?? 'medium') as Exclude<ThinkingLevel, ''>;

  // 切换 BOT 时清空乐观覆盖与浮层
  useEffect(() => {
    setModelOverride(null);
    setThinkingOverride(null);
    setSavingError(null);
    setModelMenuOpen(false);
    setThinkingMenuOpen(false);
    setModelSearch('');
  }, [currentBot.id]);

  // 打开模型浮层时拉取目录（带 fallback），并聚焦搜索框
  useEffect(() => {
    if (!modelMenuOpen) return;
    let active = true;
    setLoadingCatalog(true);
    api
      .getModelCatalog(currentBot.nodeId || undefined)
      .then((data) => {
        if (active) setCatalog(data);
      })
      .catch(() =>
        api
          .getModelCatalog()
          .then((data) => {
            if (active) setCatalog(data);
          })
          .catch(() => {}),
      )
      .finally(() => {
        if (active) setLoadingCatalog(false);
      });
    setTimeout(() => modelSearchInputRef.current?.focus(), 30);
    return () => {
      active = false;
    };
  }, [modelMenuOpen, currentBot.nodeId]);

  // 点击外部关闭两个浮层
  useEffect(() => {
    if (!modelMenuOpen && !thinkingMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (modelMenuOpen && !modelMenuRef.current?.contains(target)) setModelMenuOpen(false);
      if (thinkingMenuOpen && !thinkingMenuRef.current?.contains(target)) setThinkingMenuOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [modelMenuOpen, thinkingMenuOpen]);

  // 已配置 provider 的模型扁平列表（带 provider 维度），供搜索选择
  const catalogModels = useMemo(() => {
    const providers = catalog?.providers || [];
    const configured = providers.filter((p) => p.configured || p.credentialType);
    return configured.flatMap((p) =>
      (p.models || []).map((m) => ({ providerId: p.id, providerName: p.name, model: m })),
    );
  }, [catalog]);

  const filteredCatalogModels = useMemo(() => {
    if (!modelSearch.trim()) return catalogModels;
    const q = modelSearch.trim().toLowerCase();
    return catalogModels.filter(
      (entry) =>
        entry.model.id.toLowerCase().includes(q) ||
        entry.model.name.toLowerCase().includes(q) ||
        entry.providerId.toLowerCase().includes(q),
    );
  }, [catalogModels, modelSearch]);

  /** 保存 BOT：仅提交变更字段（systemMd 未传时后端保留原值），成功保留乐观值，失败回滚 */
  const persistBot = async (patch: { modelProvider?: string; modelId?: string; thinkingLevel?: ThinkingLevel }) => {
    setSavingError(null);
    const prevOverride = { model: modelOverride, thinking: thinkingOverride };
    setSavingModel(true);
    try {
      await api.updateBot(currentBot.id, patch as any);
    } catch (err: any) {
      // 失败回滚乐观值
      setModelOverride(prevOverride.model);
      setThinkingOverride(prevOverride.thinking);
      setSavingError(err?.message || '保存失败');
    } finally {
      setSavingModel(false);
    }
  };

  const selectModel = (providerId: string, selectedModelId: string) => {
    setModelOverride({ provider: providerId, modelId: selectedModelId });
    setModelMenuOpen(false);
    setModelSearch('');
    void persistBot({ modelProvider: providerId, modelId: selectedModelId });
  };

  const selectThinking = (level: Exclude<ThinkingLevel, ''>) => {
    setThinkingOverride(level);
    setThinkingMenuOpen(false);
    void persistBot({ thinkingLevel: level });
  };

  const workspaceDir: string | undefined = (currentBot as any).workspaceDir;
  const workspaceName = workspaceDir
    ? workspaceDir.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || workspaceDir
    : null;

  return (
    <div className="flex items-center gap-1.5 flex-wrap text-[11px] text-zinc-400 dark:text-zinc-500">
      {/* 模型秒切胶囊 */}
      <div className="relative" ref={modelMenuRef}>
        <button
          type="button"
          onClick={() => {
            setModelMenuOpen((v) => !v);
            setThinkingMenuOpen(false);
          }}
          className="inline-flex items-center gap-1 h-6 px-2 rounded-full border border-zinc-200/80 dark:border-zinc-800 bg-white dark:bg-zinc-900/60 font-mono text-zinc-600 dark:text-zinc-300 hover:border-zinc-300 hover:text-zinc-900 dark:hover:border-zinc-700 dark:hover:text-zinc-100 transition-colors cursor-pointer max-w-[13rem]"
          title={`模型：${modelProvider} / ${modelId}${modelOverride ? '（保存中/已切换）' : '，点击秒切模型'}`}
          aria-haspopup="listbox"
          aria-expanded={modelMenuOpen}
        >
          <Zap className="w-3 h-3 text-zinc-400 dark:text-zinc-500 shrink-0" />
          <span className="truncate">{shortModelLabel(modelId)}</span>
          {savingModel ? (
            <Loader2 className="w-3 h-3 animate-spin-fast shrink-0" />
          ) : (
            <ChevronDown className="w-3 h-3 shrink-0 opacity-60" />
          )}
        </button>

        {modelMenuOpen && (
          <div className="absolute bottom-full left-0 mb-1.5 w-72 bg-white dark:bg-zinc-900 rounded-xl shadow-xl border border-zinc-200 dark:border-zinc-800 z-40 overflow-hidden animate-in fade-in slide-in-from-bottom-2">
            <div className="p-2 border-b border-zinc-100 dark:border-zinc-800">
              <div className="flex items-center gap-1.5 px-2 py-1 rounded-lg bg-zinc-100 dark:bg-zinc-800/70">
                <Search className="w-3.5 h-3.5 text-zinc-400 dark:text-zinc-500 shrink-0" />
                <input
                  ref={modelSearchInputRef}
                  value={modelSearch}
                  onChange={(e) => setModelSearch(e.target.value)}
                  placeholder="搜索模型..."
                  className="w-full bg-transparent text-xs text-zinc-700 dark:text-zinc-200 placeholder-zinc-400 focus:outline-none"
                />
              </div>
            </div>
            <div className="max-h-64 overflow-y-auto p-1">
              {loadingCatalog && (
                <div className="py-4 flex items-center justify-center gap-2 text-xs text-zinc-400 dark:text-zinc-500">
                  <Loader2 className="w-3.5 h-3.5 animate-spin-fast" />
                  <span>加载模型目录...</span>
                </div>
              )}
              {!loadingCatalog && filteredCatalogModels.length === 0 && (
                <div className="py-4 text-center text-xs text-zinc-400 dark:text-zinc-500">
                  {catalog ? '没有匹配的模型' : '模型目录不可用'}
                </div>
              )}
              {!loadingCatalog &&
                filteredCatalogModels.map(({ providerId, providerName, model }) => {
                  const isCurrent = providerId === modelProvider && model.id === modelId;
                  return (
                    <button
                      key={`${providerId}/${model.id}`}
                      type="button"
                      onClick={() => selectModel(providerId, model.id)}
                      className={`w-full text-left px-2.5 py-1.5 rounded-lg transition-colors cursor-pointer ${
                        isCurrent
                          ? 'bg-blue-50 dark:bg-blue-950/50 text-blue-900 dark:text-blue-200'
                          : 'hover:bg-zinc-50 dark:hover:bg-zinc-800 text-zinc-700 dark:text-zinc-300'
                      }`}
                      role="option"
                      aria-selected={isCurrent}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-mono text-[11px] truncate">{model.id}</span>
                        {isCurrent && <span className="text-[10px] shrink-0 text-blue-500">当前</span>}
                      </div>
                      <div className="text-[10px] text-zinc-400 dark:text-zinc-500 truncate">
                        {providerName || providerId}
                        {model.reasoning ? ' · 支持思考' : ''}
                        {model.contextWindow ? ` · ${Math.round(model.contextWindow / 1000)}k ctx` : ''}
                      </div>
                    </button>
                  );
                })}
            </div>
          </div>
        )}
      </div>

      {/* 思考档位秒切胶囊 */}
      <div className="relative" ref={thinkingMenuRef}>
        <button
          type="button"
          onClick={() => {
            setThinkingMenuOpen((v) => !v);
            setModelMenuOpen(false);
          }}
          className="inline-flex items-center gap-1 h-6 px-2 rounded-full border border-zinc-200/80 dark:border-zinc-800 bg-white dark:bg-zinc-900/60 text-zinc-600 dark:text-zinc-300 hover:border-zinc-300 hover:text-zinc-900 dark:hover:border-zinc-700 dark:hover:text-zinc-100 transition-colors cursor-pointer"
          title="推理强度：点击秒切思考档位"
          aria-haspopup="listbox"
          aria-expanded={thinkingMenuOpen}
        >
          <Brain className="w-3 h-3 text-zinc-400 dark:text-zinc-500 shrink-0" />
          <span className="font-mono">{THINKING_SHORT_LABELS[thinkingLevel] || thinkingLevel}</span>
          <ChevronDown className="w-3 h-3 shrink-0 opacity-60" />
        </button>

        {thinkingMenuOpen && (
          <div className="absolute bottom-full left-0 mb-1.5 w-40 bg-white dark:bg-zinc-900 rounded-xl shadow-xl border border-zinc-200 dark:border-zinc-800 z-40 overflow-hidden p-1 animate-in fade-in slide-in-from-bottom-2" role="listbox">
            {THINKING_LEVELS.filter(Boolean).map((level) => {
              const isCurrent = level === thinkingLevel;
              return (
                <button
                  key={level}
                  type="button"
                  onClick={() => selectThinking(level as Exclude<ThinkingLevel, ''>)}
                  className={`w-full text-left px-2.5 py-1.5 rounded-lg text-xs font-mono transition-colors cursor-pointer ${
                    isCurrent
                      ? 'bg-blue-50 dark:bg-blue-950/50 text-blue-900 dark:text-blue-200'
                      : 'hover:bg-zinc-50 dark:hover:bg-zinc-800 text-zinc-700 dark:text-zinc-300'
                  }`}
                  role="option"
                  aria-selected={isCurrent}
                >
                  {level}
                  {isCurrent && <span className="ml-1.5 text-[10px] text-blue-500">当前</span>}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* 工作区路径微徽章 */}
      {workspaceName && (
        <span
          className="inline-flex items-center gap-1 h-6 px-2 rounded-full border border-zinc-200/80 dark:border-zinc-800 bg-white dark:bg-zinc-900/60 text-zinc-500 dark:text-zinc-400 max-w-[10rem]"
          title={workspaceDir}
        >
          <FolderClosed className="w-3 h-3 shrink-0" />
          <span className="truncate font-mono">{workspaceName}</span>
        </span>
      )}

      {/* 保存失败提示 */}
      {savingError && (
        <span className="text-amber-600 dark:text-amber-400 truncate" title={savingError}>
          切换失败：{savingError}
        </span>
      )}

      {/* 快捷指令芯片 */}
      <div className="ml-auto flex items-center gap-1.5">
        {onCompact && (
          <button
            type="button"
            onClick={onCompact}
            className="inline-flex items-center gap-1 h-6 px-2 rounded-full border border-zinc-200/80 dark:border-zinc-800 text-zinc-500 dark:text-zinc-400 hover:border-zinc-300 hover:text-zinc-800 dark:hover:border-zinc-700 dark:hover:text-zinc-200 transition-colors cursor-pointer font-mono"
            title="压缩当前会话上下文（/compact）"
          >
            <Sparkles className="w-3 h-3 shrink-0" />
            /compact
          </button>
        )}
        {onNewTopic && (
          <button
            type="button"
            onClick={onNewTopic}
            className="inline-flex items-center gap-1 h-6 px-2 rounded-full border border-zinc-200/80 dark:border-zinc-800 text-zinc-500 dark:text-zinc-400 hover:border-zinc-300 hover:text-zinc-800 dark:hover:border-zinc-700 dark:hover:text-zinc-200 transition-colors cursor-pointer font-mono"
            title="开启新话题（/new）"
          >
            <ChevronDown className="w-3 h-3 shrink-0 rotate-[-90deg]" />
            /new
          </button>
        )}
      </div>
    </div>
  );
};
