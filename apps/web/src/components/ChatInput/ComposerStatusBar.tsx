import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Brain, Check, ChevronDown, Loader2, Search, Zap } from 'lucide-react';
import type { BotConfig, ModelCatalog, ModelCatalogEntry, ThinkingLevel } from '@botd/protocol';
import { api } from '../../api';
import {
  THINKING_LEVEL_LABELS,
  clampThinkingLevel,
  deriveModelThinkingLevels,
} from '../BotEditorModal/useModelCatalog';

/** 模型简称：截取 modelId 中有辨识度的短段（如 claude-sonnet-4-5 / glm-4.6） */
function shortModelLabel(modelId: string): string {
  if (!modelId) return '未设置';
  return modelId.length > 24 ? `${modelId.slice(0, 22)}…` : modelId;
}

/** 思考档位短标签：中文 + 代码（如「深度思考 high」） */
function shortThinkingLabel(level: Exclude<ThinkingLevel, ''>): string {
  return THINKING_LEVEL_LABELS[level] || level;
}

interface ComposerStatusBarProps {
  /** 当前主控 BOT（模型/思考档位的秒切目标） */
  currentBot: BotConfig;
}

/** 模型目录扁平条目：带 provider 维度，供搜索与档位推导 */
interface CatalogModelEntry {
  providerId: string;
  providerName: string;
  model: ModelCatalogEntry;
}

/**
 * 输入框底栏微操舱：模型秒切与思考档位秒切（均为模型感知，切换模型自动收敛档位）。
 * 变更走 api.updateBot 增量保存，本地乐观更新显示，失败时回滚。
 */
export const ComposerStatusBar: React.FC<ComposerStatusBarProps> = ({ currentBot }) => {
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
  const thinkingLevel = (thinkingOverride ?? (currentBot.thinkingLevel || 'medium')) as Exclude<ThinkingLevel, ''>;

  // BOT/节点变化即拉取目录（带 fallback）：保证先点「思考」胶囊也有目录可用，不必先开模型菜单
  useEffect(() => {
    let active = true;
    setCatalog(null);
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
    return () => {
      active = false;
    };
  }, [currentBot.id, currentBot.nodeId]);

  // 切换 BOT 时清空乐观覆盖与浮层
  useEffect(() => {
    setModelOverride(null);
    setThinkingOverride(null);
    setSavingError(null);
    setModelMenuOpen(false);
    setThinkingMenuOpen(false);
    setModelSearch('');
  }, [currentBot.id]);

  // 打开模型浮层时聚焦搜索框
  useEffect(() => {
    if (!modelMenuOpen) return;
    setTimeout(() => modelSearchInputRef.current?.focus(), 30);
  }, [modelMenuOpen]);

  // 点击/触摸外部关闭两个浮层（同时监听 mousedown 与 touchstart，覆盖移动端）
  useEffect(() => {
    if (!modelMenuOpen && !thinkingMenuOpen) return;
    const onDown = (e: Event) => {
      const target = e.target as Node;
      if (modelMenuOpen && !modelMenuRef.current?.contains(target)) setModelMenuOpen(false);
      if (thinkingMenuOpen && !thinkingMenuRef.current?.contains(target)) setThinkingMenuOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('touchstart', onDown, { passive: true });
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('touchstart', onDown);
    };
  }, [modelMenuOpen, thinkingMenuOpen]);

  // 模型扁平列表：严格只从已配置凭据的服务商提取（与设置页「已配置」同口径），
  // 绝不把未配置的 modelProvider 塞进去，也绝不回退到未配置的内置服务商
  const catalogModels = useMemo<CatalogModelEntry[]>(() => {
    const providers = catalog?.providers || [];
    const configured = providers.filter((p) => p.configured || p.credentialType);
    return configured.flatMap((p) =>
      (p.models || []).map((m) => ({ providerId: p.id, providerName: p.name, model: m })),
    );
  }, [catalog]);

  // 当前 BOT 的模型是否可用：provider/model 任一为空，或 provider 未配置凭据，都视为未就绪
  const currentProviderConfigured = useMemo(
    () => catalog?.providers.some((p) => p.id === modelProvider && (p.configured || p.credentialType)) ?? false,
    [catalog, modelProvider],
  );
  const modelMissing =
    !loadingCatalog && catalog !== null && (!modelId || !modelProvider || !currentProviderConfigured);

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

  // 当前模型元数据：先精确匹配 provider+model，再退化为仅 model 匹配
  const currentModelMeta = useMemo(() => {
    const exact = catalogModels.find(
      (e) => e.providerId === modelProvider && e.model.id === modelId,
    );
    if (exact) return exact.model;
    return catalogModels.find((e) => e.model.id === modelId)?.model ?? null;
  }, [catalogModels, modelProvider, modelId]);

  // 当前模型支持的思考档位（目录缺失时回退全量）
  const supportedThinkingLevels = useMemo(
    () => deriveModelThinkingLevels(currentModelMeta),
    [currentModelMeta],
  );

  /** 保存 BOT：仅提交变更字段（systemMd 未传时后端保留原值），成功保留乐观值，失败回滚 */
  const persistBot = async (patch: {
    modelProvider?: string;
    modelId?: string;
    thinkingLevel?: ThinkingLevel;
  }) => {
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
    // 模型感知：目标模型不支持当前思考档位时，收敛到最近的支持档位并一并保存
    const nextMeta =
      catalogModels.find(
        (e) => e.providerId === providerId && e.model.id === selectedModelId,
      )?.model ??
      catalogModels.find((e) => e.model.id === selectedModelId)?.model ??
      null;
    const nextSupported = deriveModelThinkingLevels(nextMeta);
    const clamped = clampThinkingLevel(thinkingLevel, nextSupported);
    if (clamped !== null) {
      setThinkingOverride(clamped);
      void persistBot({ modelProvider: providerId, modelId: selectedModelId, thinkingLevel: clamped });
    } else {
      void persistBot({ modelProvider: providerId, modelId: selectedModelId });
    }
  };

  const selectThinking = (level: Exclude<ThinkingLevel, ''>) => {
    setThinkingOverride(level);
    setThinkingMenuOpen(false);
    void persistBot({ thinkingLevel: level });
  };

  return (
    <div className="flex items-center gap-1.5 text-[11px] text-zinc-400 dark:text-zinc-500">
      {/* 模型秒切胶囊：未配置模型时呈现醒目琥珀色警告态，引导用户先选型 */}
      <div className="relative" ref={modelMenuRef}>
        <button
          type="button"
          onClick={() => {
            setModelMenuOpen((v) => !v);
            setThinkingMenuOpen(false);
          }}
          className={`inline-flex items-center gap-1 h-6 px-2 rounded-full border font-mono transition-colors cursor-pointer max-w-[13rem] ${
            modelMissing
              ? 'border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 hover:border-amber-400 dark:hover:border-amber-600'
              : 'border-zinc-200/80 dark:border-zinc-800 bg-white dark:bg-zinc-900/60 text-zinc-600 dark:text-zinc-300 hover:border-zinc-300 hover:text-zinc-900 dark:hover:border-zinc-700 dark:hover:text-zinc-100'
          }`}
          title={
            modelMissing
              ? `⚠️ 未配置模型：${modelProvider ? `${modelProvider}/${modelId || '未设置'}` : '未设置'}，点击选择已就绪的模型`
              : `模型：${modelProvider} / ${modelId}${modelOverride ? '（保存中/已切换）' : '，点击秒切模型'}`
          }
          aria-haspopup="listbox"
          aria-expanded={modelMenuOpen}
        >
          <Zap
            className={`w-3 h-3 shrink-0 ${
              modelMissing ? 'text-amber-500 dark:text-amber-400' : 'text-zinc-400 dark:text-zinc-500'
            }`}
          />
          <span className="truncate">{modelMissing ? '⚠️ 未配置模型' : shortModelLabel(modelId)}</span>
          {savingModel ? (
            <Loader2 className="w-3 h-3 animate-spin-fast shrink-0" />
          ) : (
            <ChevronDown className="w-3 h-3 shrink-0 opacity-60" />
          )}
        </button>

        {modelMenuOpen && (
          <div className="absolute bottom-full left-0 mb-1.5 w-[min(18rem,calc(100vw-1.5rem))] bg-white dark:bg-zinc-900 rounded-xl shadow-xl border border-zinc-200 dark:border-zinc-800 z-50 overflow-hidden animate-in fade-in slide-in-from-bottom-2">
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
                <div className="py-4 px-3 text-center text-xs text-zinc-400 dark:text-zinc-500 leading-relaxed">
                  {catalog
                    ? '暂未配置任何模型服务商凭据，请前往右上角 系统设置 → 模型服务商 配置 API Key'
                    : '模型目录不可用，请检查网络或节点状态'}
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
                        {isCurrent && (
                          <span className="flex items-center gap-0.5 text-[10px] shrink-0 text-blue-500">
                            <Check className="w-3 h-3" />
                            当前
                          </span>
                        )}
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
          title={`推理强度：${shortThinkingLabel(thinkingLevel)}（${thinkingLevel}），点击秒切思考档位`}
          aria-haspopup="listbox"
          aria-expanded={thinkingMenuOpen}
        >
          <Brain className="w-3 h-3 text-zinc-400 dark:text-zinc-500 shrink-0" />
          <span className="truncate">{shortThinkingLabel(thinkingLevel)}</span>
          <span className="font-mono text-zinc-400 dark:text-zinc-500 shrink-0">{thinkingLevel}</span>
          <ChevronDown className="w-3 h-3 shrink-0 opacity-60" />
        </button>

        {thinkingMenuOpen && (
          <div
            className="absolute bottom-full left-0 mb-1.5 w-48 bg-white dark:bg-zinc-900 rounded-xl shadow-xl border border-zinc-200 dark:border-zinc-800 z-50 overflow-hidden animate-in fade-in slide-in-from-bottom-2"
            role="listbox"
          >
            <div className="max-h-64 overflow-y-auto p-1">
              {supportedThinkingLevels.map((level) => {
                const isCurrent = level === thinkingLevel;
                return (
                  <button
                    key={level}
                    type="button"
                    onClick={() => selectThinking(level)}
                    className={`w-full text-left px-2.5 py-1.5 rounded-lg text-xs transition-colors cursor-pointer flex items-center justify-between gap-2 ${
                      isCurrent
                        ? 'bg-blue-50 dark:bg-blue-950/50 text-blue-900 dark:text-blue-200'
                        : 'hover:bg-zinc-50 dark:hover:bg-zinc-800 text-zinc-700 dark:text-zinc-300'
                    }`}
                    role="option"
                    aria-selected={isCurrent}
                  >
                    <span className="truncate">{THINKING_LEVEL_LABELS[level] || level}</span>
                    <span className="flex items-center gap-1 shrink-0">
                      <span className="font-mono text-[10px] text-zinc-400 dark:text-zinc-500">{level}</span>
                      {isCurrent && <Check className="w-3 h-3 text-blue-500" />}
                    </span>
                  </button>
                );
              })}
            </div>
            {supportedThinkingLevels.length === 1 && (
              <div className="px-2.5 py-1.5 border-t border-zinc-100 dark:border-zinc-800 text-[10px] text-zinc-400 dark:text-zinc-500">
                {`该模型仅支持 ${supportedThinkingLevels[0]} 档位`}
              </div>
            )}
          </div>
        )}
      </div>

      {/* 保存失败提示 */}
      {savingError && (
        <span className="text-amber-600 dark:text-amber-400 truncate" title={savingError}>
          切换失败：{savingError}
        </span>
      )}
    </div>
  );
};
