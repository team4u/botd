import React, { useState, useEffect, useMemo } from 'react';
import {
  X,
  Bot,
  Save,
  Loader2,
  Sparkles,
  Brain,
  Cpu,
  AlertCircle,
  Info,
  Server,
  KeyRound,
  Plus,
  Trash2,
  Eye,
  EyeOff,
} from 'lucide-react';
import { api } from '../api';
import { SearchableSelect } from './SearchableSelect';
import type {
  BotConfig,
  NodeWithBots,
  SaveBotInput,
  ModelCatalog,
  ProviderCatalogEntry,
  ModelCatalogEntry,
  ThinkingLevel,
} from '@botd/protocol';

interface BotEditorModalProps {
  isOpen: boolean;
  /** Owning node, fixed by the entry point — bots are created/edited in node context. */
  node: NodeWithBots | null;
  bot?: BotConfig | null;
  onClose: () => void;
  onSaved: () => void;
}

const DEFAULT_SYSTEM_MD = `# 角色定位
你是一个专业、严谨且遵循 UNIX 哲学的 AI 智能助手。

## 协作规范
1. 在群聊中通过 @<botId> 呼叫其他成员协同，不输出冗余客套话。
2. 遇到需要执行系统操作或外部工具时，善用所属 Node 提供的本地命令与已启用的技能。
3. 结论清晰、要点明确。
`;

const DEFAULT_MEMORY_MD = `## 核心背景与偏好记忆
- 用户环境：多节点协作系统
- 约定：公屏输出结构化结论，保持严谨简洁
`;

export const BotEditorModal: React.FC<BotEditorModalProps> = ({
  isOpen,
  node,
  bot,
  onClose,
  onSaved,
}) => {
  const isEditing = Boolean(bot);

  // Tabs
  const [activeTab, setActiveTab] = useState<'basic' | 'system' | 'memory'>('basic');

  // Form fields (nodeId is fixed by the node-context entry, never edited here)
  const nodeId = node?.id ?? '';
  const [id, setId] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [modelProvider, setModelProvider] = useState('');
  const [customProviderInput, setCustomProviderInput] = useState('');
  const [isCustomProvider, setIsCustomProvider] = useState(false);
  const [modelId, setModelId] = useState('');
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel | ''>('medium');
  const [enabledSkills, setEnabledSkills] = useState<string[]>([]);
  const [enabledExtensions, setEnabledExtensions] = useState<string[]>([]);
  const [systemMd, setSystemMd] = useState(DEFAULT_SYSTEM_MD);
  const [memoryMd, setMemoryMd] = useState('');

  // Env (secrets) editor state
  interface EnvPair {
    key: string;
    value: string;
    visible?: boolean;
  }
  const [envPairs, setEnvPairs] = useState<EnvPair[]>([]);
  const [envLoaded, setEnvLoaded] = useState(false);

  // Catalog state
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null);
  const [loadingCatalog, setLoadingCatalog] = useState(false);
  const [catalogError, setCatalogError] = useState<string | null>(null);

  // File loading & saving state
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Available skills on the owning node
  const availableSkills = node ? node.skills : [];
  const availableExtensions = node ? (node.extensions || []) : [];

  // Fetch catalog when selected node changes
  useEffect(() => {
    if (!isOpen) return;
    let active = true;

    setLoadingCatalog(true);
    setCatalogError(null);

    // Call /api/models/catalog?nodeId=... for selected node
    api.getModelCatalog(nodeId || undefined)
      .then((data) => {
        if (!active) return;
        setCatalog(data);
      })
      .catch((err: any) => {
        if (!active) return;
        // If node catalog fails (e.g. 503 offline), fallback to builtin catalog
        if (nodeId) {
          setCatalogError(`无法获取节点专属模型目录 (${err?.message || '503'})，已切换为全局内置目录`);
          api.getModelCatalog()
            .then((fallbackData) => {
              if (active) setCatalog(fallbackData);
            })
            .catch(() => {
              // fallback failed too
            });
        } else {
          setCatalogError(err?.message || '加载模型目录失败');
        }
      })
      .finally(() => {
        if (active) setLoadingCatalog(false);
      });

    return () => {
      active = false;
    };
  }, [isOpen, nodeId]);

  // Initialize form ONLY on modal open or bot id switch.
  // DO NOT depend on nodes prop (which refreshes every 10s via node polling)!
  useEffect(() => {
    if (!isOpen) return;
    let current = true;
    setError(null);
    setLoadFailed(false);
    setActiveTab('basic');

    if (bot) {
      setId(bot.id);
      setName(bot.name);
      setDescription(bot.description || '');
      setModelProvider(bot.modelProvider);
      setModelId(bot.modelId);
      setThinkingLevel(bot.thinkingLevel || '');
      setEnabledSkills(bot.enabledSkills || []);
      setEnabledExtensions(bot.enabledExtensions || []);
      setIsCustomProvider(false);
      setCustomProviderInput('');

      // Load SYSTEM.md and MEMORY.md
      setLoadingFiles(true);
      setSystemMd('');
      setMemoryMd('');
      // Load env vars (secrets) when node is online; env panel edits are best-effort
      setEnvPairs([]);
      setEnvLoaded(false);
      const envPromise =
        node && node.status === 'online'
          ? api
              .getBotEnv(bot.id)
              .then((res) => {
                if (!current) return;
                setEnvPairs(
                  Object.entries(res.env || {}).map(([key, value]) => ({
                    key,
                    value,
                    visible: false,
                  }))
                );
                setEnvLoaded(true);
              })
              .catch(() => {
                // env endpoint unavailable (node offline / older node): keep empty list
              })
          : Promise.resolve();
      Promise.all([api.getBotSystem(bot.id), api.getBotMemory(bot.id), envPromise])
        .then(([sys, mem]) => {
          if (!current) return;
          setSystemMd(sys.content);
          setMemoryMd(mem.content);
        })
        .catch((err: Error) => {
          if (!current) return;
          setLoadFailed(true);
          setError(err.message || '读取智能体配置文件失败，请重试');
        })
        .finally(() => {
          if (current) setLoadingFiles(false);
        });
    } else {
      setId('');
      setName('');
      setDescription('');
      setModelProvider('');
      setModelId('');
      setThinkingLevel('medium');
      setEnabledSkills([]);
      setEnabledExtensions([]);
      setIsCustomProvider(false);
      setCustomProviderInput('');
      setSystemMd(DEFAULT_SYSTEM_MD);
      setMemoryMd('');
      setEnvPairs([]);
      setEnvLoaded(false);
      setLoadingFiles(false);
    }

    return () => {
      current = false;
    };
  }, [isOpen, bot?.id]);

  // Providers list derived from catalog
  const catalogProviders: ProviderCatalogEntry[] = useMemo(() => {
    return catalog?.providers || [];
  }, [catalog]);

  // Current selected provider object
  const activeProvider = useMemo(() => {
    return catalogProviders.find((p) => p.id === modelProvider) || null;
  }, [catalogProviders, modelProvider]);

  // Models available for current provider
  const availableModels: ModelCatalogEntry[] = useMemo(() => {
    return activeProvider?.models || [];
  }, [activeProvider]);

  // Metadata of currently selected model (if it's in the catalog)
  const currentModelMeta = useMemo(() => {
    return availableModels.find((m) => m.id === modelId) || null;
  }, [availableModels, modelId]);

  // Thinking levels for the selected model: catalog metadata first, generic fallback otherwise
  const THINKING_LEVEL_LABELS: Record<Exclude<ThinkingLevel, ''>, string> = {
    off: '关闭思考',
    minimal: '极简思考',
    low: '轻度思考',
    medium: '标准思考',
    high: '深度思考',
    xhigh: '超深度思考',
    max: '最大思考',
  };
  const modelThinkingLevels = useMemo<Exclude<ThinkingLevel, ''>[]>(() => {
    const levels = currentModelMeta?.thinkingLevels?.filter(Boolean);
    if (levels && levels.length > 0) return levels as Exclude<ThinkingLevel, ''>[];
    // Fallback for models without catalog metadata (custom ids, empty catalogs)
    return ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
  }, [currentModelMeta]);

  // Clamp selected level when the model changes and no longer supports it
  useEffect(() => {
    if (thinkingLevel && modelThinkingLevels.length > 0 && !modelThinkingLevels.includes(thinkingLevel)) {
      // Pick the nearest supported level (prefer deeper, fall back shallower)
      const ORDER: Exclude<ThinkingLevel, ''>[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
      const idx = ORDER.indexOf(thinkingLevel);
      let next: Exclude<ThinkingLevel, ''> | '' = '';
      for (let i = idx; i < ORDER.length; i++) {
        if (modelThinkingLevels.includes(ORDER[i])) { next = ORDER[i]; break; }
      }
      if (!next) {
        for (let i = idx - 1; i >= 0; i--) {
          if (modelThinkingLevels.includes(ORDER[i])) { next = ORDER[i]; break; }
        }
      }
      setThinkingLevel(next || modelThinkingLevels[0]);
    }
  }, [modelThinkingLevels]);

  if (!isOpen) return null;

  // Toggle skills checkbox
  const toggleSkill = (skill: string) => {
    setEnabledSkills((prev) =>
      prev.includes(skill) ? prev.filter((s) => s !== skill) : [...prev, skill]
    );
  };

  // Toggle extensions checkbox
  const toggleExtension = (ext: string) => {
    setEnabledExtensions((prev) =>
      prev.includes(ext) ? prev.filter((e) => e !== ext) : [...prev, ext]
    );
  };

  // Env (secrets) helpers
  const addEnvPair = () => {
    setEnvPairs((prev) => [...prev, { key: '', value: '', visible: false }]);
  };

  const removeEnvPair = (index: number) => {
    setEnvPairs((prev) => prev.filter((_, i) => i !== index));
  };

  const updateEnvPair = (
    index: number,
    patch: Partial<{ key: string; value: string; visible: boolean }>
  ) => {
    setEnvPairs((prev) =>
      prev.map((pair, i) => (i === index ? { ...pair, ...patch } : pair))
    );
  };

  // Sanitize env key to legal characters: uppercase letters, digits, underscore
  const sanitizeEnvKey = (raw: string) =>
    raw
      .toUpperCase()
      .replace(/[^A-Z0-9_]/g, '_')
      .replace(/^_+/, '_');

  // Intentional provider change
  const handleProviderSelect = (val: string) => {
    if (val === '__custom_provider__') {
      setIsCustomProvider(true);
      setModelProvider('');
      setModelId('');
      return;
    }

    setIsCustomProvider(false);
    setModelProvider(val);

    // Look up the selected provider in the actual catalog
    const nextProv = catalogProviders.find((p) => p.id === val);
    if (nextProv && nextProv.models && nextProv.models.length > 0) {
      // Check if current modelId is compatible with the new provider
      const isStillCompatible = nextProv.models.some((m) => m.id === modelId);
      if (!isStillCompatible) {
        // Reset incompatible model using the actual catalog first model ID
        setModelId(nextProv.models[0].id);
      }
    } else {
      setModelId('');
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (loadingFiles || loadFailed || saving) return;
    const cleanId = id.trim();
    const cleanName = name.trim();

    if (!cleanId || !/^[a-zA-Z0-9_-]+$/.test(cleanId)) {
      setError('唯一标识仅允许英文字母、数字、下划线及短横线，例如：pm-claude');
      setActiveTab('basic');
      return;
    }
    if (!cleanName) {
      setError('请输入名称');
      setActiveTab('basic');
      return;
    }
    if (!node || !nodeId) {
      setError('缺少所属节点上下文');
      setActiveTab('basic');
      return;
    }

    const effectiveProvider = isCustomProvider
      ? customProviderInput.trim().toLowerCase()
      : modelProvider.trim().toLowerCase();

    if (!effectiveProvider || !/^[a-zA-Z0-9_-]+$/.test(effectiveProvider)) {
      setError('请输入有效的模型服务商标识 (英文字母、数字、下划线及短横线)');
      setActiveTab('basic');
      return;
    }

    const effectiveModel = modelId.trim();
    if (!effectiveModel) {
      setError('请输入或选择模型型号');
      setActiveTab('basic');
      return;
    }

    setSaving(true);
    setError(null);

    const botInput: SaveBotInput = {
      id: cleanId,
      nodeId,
      name: cleanName,
      description: description.trim(),
      modelProvider: effectiveProvider,
      modelId: effectiveModel,
      thinkingLevel: thinkingLevel || undefined,
      enabledSkills,
      enabledExtensions,
      systemMd,
    };

    try {
      if (isEditing) {
        await api.updateBot(botInput.id, botInput);
      } else {
        await api.createBot(botInput);
      }
      await api.saveBotMemory(botInput.id, memoryMd);

      // Persist env vars (secrets): overwrite mode when there is content or env was loaded before
      if (envPairs.length > 0 || (isEditing && envLoaded)) {
        const envRecord: Record<string, string> = {};
        for (const pair of envPairs) {
          const cleanKey = pair.key.trim();
          if (cleanKey) envRecord[cleanKey] = pair.value;
        }
        await api.putBotEnv(botInput.id, envRecord, false);
      }

      onSaved();
      onClose();
    } catch (err: any) {
      setError(err?.message || '保存智能体失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/50 dark:bg-black/70 backdrop-blur-xs flex items-end sm:items-center justify-center p-0 sm:p-4 overflow-hidden animate-in fade-in"
      role="dialog"
      aria-modal="true"
      aria-labelledby="bot-editor-title"
    >
      <div className="bg-white dark:bg-zinc-950 rounded-t-2xl sm:rounded-2xl shadow-2xl border border-zinc-200 dark:border-zinc-800 w-full max-w-2xl h-[92dvh] sm:h-auto sm:max-h-[90dvh] overflow-hidden flex flex-col">
        {/* Mobile pull indicator */}
        <div className="sm:hidden pt-2.5 pb-1 flex justify-center shrink-0">
          <div className="w-9 h-1 rounded-full bg-zinc-300 dark:bg-zinc-700" />
        </div>

        {/* Header */}
        <div className="px-5 sm:px-6 py-3.5 border-b border-zinc-200/80 dark:border-zinc-800/80 flex items-center justify-between shrink-0 bg-zinc-50/60 dark:bg-zinc-900/60">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-xl bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900 flex items-center justify-center shadow-xs">
              <Bot className="w-4 h-4" />
            </div>
            <div>
              <h2 id="bot-editor-title" className="text-sm sm:text-base font-semibold text-zinc-900 dark:text-zinc-100">
                {isEditing ? `编辑智能体: ${bot?.name} (@${bot?.id})` : '新建智能体'}
              </h2>
              <p className="text-[11px] text-zinc-500 dark:text-zinc-400 font-mono truncate">
                {node ? `${node.name} · ` : ''}~/.botd/bots/{id || '<唯一标识>'}/
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 text-zinc-400 hover:text-zinc-700 dark:text-zinc-500 dark:hover:text-zinc-200 rounded-lg hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
            aria-label="关闭对话框"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Tab switch - Pure Chinese, no file extension leaks */}
        <div className="flex border-b border-zinc-200/80 dark:border-zinc-800/80 bg-zinc-50/40 dark:bg-zinc-900/40 shrink-0">
          <button
            type="button"
            onClick={() => setActiveTab('basic')}
            className={`flex-1 py-2.5 sm:py-3 text-xs font-medium flex items-center justify-center gap-1.5 border-b-2 transition-colors ${
              activeTab === 'basic'
                ? 'border-zinc-900 dark:border-zinc-100 text-zinc-900 dark:text-zinc-100 bg-white dark:bg-zinc-950 font-semibold'
                : 'border-transparent text-zinc-500 dark:text-zinc-400 hover:text-zinc-800 dark:hover:text-zinc-200'
            }`}
          >
            <Cpu className="w-3.5 h-3.5" />
            <span>基础配置</span>
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('system')}
            className={`flex-1 py-2.5 sm:py-3 text-xs font-medium flex items-center justify-center gap-1.5 border-b-2 transition-colors ${
              activeTab === 'system'
                ? 'border-zinc-900 dark:border-zinc-100 text-zinc-900 dark:text-zinc-100 bg-white dark:bg-zinc-950 font-semibold'
                : 'border-transparent text-zinc-500 dark:text-zinc-400 hover:text-zinc-800 dark:hover:text-zinc-200'
            }`}
          >
            <Sparkles className="w-3.5 h-3.5" />
            <span>角色人设</span>
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('memory')}
            className={`flex-1 py-2.5 sm:py-3 text-xs font-medium flex items-center justify-center gap-1.5 border-b-2 transition-colors ${
              activeTab === 'memory'
                ? 'border-zinc-900 dark:border-zinc-100 text-zinc-900 dark:text-zinc-100 bg-white dark:bg-zinc-950 font-semibold'
                : 'border-transparent text-zinc-500 dark:text-zinc-400 hover:text-zinc-800 dark:hover:text-zinc-200'
            }`}
          >
            <Brain className="w-3.5 h-3.5" />
            <span>长期记忆</span>
          </button>
        </div>

        {/* Form Body */}
        <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-4 flex flex-col">
          {error && (
            <div className="p-3 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900/60 text-rose-700 dark:text-rose-300 text-xs rounded-xl flex items-start gap-2 shrink-0">
              <AlertCircle className="w-4 h-4 text-rose-500 dark:text-rose-400 shrink-0 mt-0.5" />
              <div className="flex-1">{error}</div>
            </div>
          )}

          {catalogError && (
            <div className="p-3 bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900/60 text-amber-800 dark:text-amber-300 text-xs rounded-xl flex items-start gap-2 shrink-0">
              <Info className="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
              <div className="flex-1">{catalogError}</div>
            </div>
          )}

          {loadingFiles ? (
            <div className="py-20 flex flex-col items-center justify-center text-zinc-400 dark:text-zinc-500 gap-2">
              <Loader2 className="w-5 h-5 animate-spin text-zinc-600 dark:text-zinc-400" />
              <p className="text-xs">正在加载配置详情与记忆文件...</p>
            </div>
          ) : (
            <>
              {/* Tab 1: Basic Config */}
              {activeTab === 'basic' && (
                <div className="space-y-4">
                  {/* Owning node (fixed context) & Bot ID */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-1">
                        所属节点
                      </label>
                      <div className="w-full h-8 px-2.5 text-xs bg-zinc-50/80 dark:bg-zinc-900/80 border border-zinc-200 dark:border-zinc-800 rounded-lg flex items-center gap-2 text-zinc-800 dark:text-zinc-200">
                        <Server
                          className={`w-3.5 h-3.5 shrink-0 ${
                            node?.status === 'online'
                              ? 'text-emerald-500'
                              : 'text-zinc-400 dark:text-zinc-500'
                          }`}
                        />
                        <span className="truncate">{node ? node.name : '—'}</span>
                        {node && (
                          <span
                            className={`text-[11px] shrink-0 ml-auto ${
                              node.status === 'online'
                                ? 'text-emerald-600 dark:text-emerald-400'
                                : 'text-zinc-400 dark:text-zinc-500'
                            }`}
                          >
                            {node.status === 'online' ? '在线' : '离线'}
                          </span>
                        )}
                      </div>
                    </div>

                    <div>
                      <label className="block text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-1">
                        唯一标识
                      </label>
                      <input
                        type="text"
                        value={id}
                        aria-label="BOT 唯一标识"
                        onChange={(e) => setId(e.target.value)}
                        placeholder="例如：pm-claude"
                        disabled={isEditing}
                        className="w-full h-8 px-2.5 text-xs bg-zinc-50/80 dark:bg-zinc-900/80 border border-zinc-200 dark:border-zinc-800 rounded-lg focus:bg-white dark:focus:bg-zinc-900 focus:outline-none focus:ring-1 focus:ring-zinc-900 dark:focus:ring-zinc-400 font-mono disabled:opacity-60 text-zinc-800 dark:text-zinc-200 placeholder-zinc-400 dark:placeholder-zinc-500"
                        required
                      />
                    </div>
                  </div>

                  {/* Name & Description */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-1">
                        名称
                      </label>
                      <input
                        type="text"
                        value={name}
                        aria-label="显示名称"
                        onChange={(e) => setName(e.target.value)}
                        placeholder="例如：产品经理 Claude"
                        className="w-full h-8 px-2.5 text-xs bg-zinc-50/80 dark:bg-zinc-900/80 border border-zinc-200 dark:border-zinc-800 rounded-lg focus:bg-white dark:focus:bg-zinc-900 focus:outline-none focus:ring-1 focus:ring-zinc-900 dark:focus:ring-zinc-400 text-zinc-800 dark:text-zinc-200 placeholder-zinc-400 dark:placeholder-zinc-500"
                        required
                      />
                    </div>

                    <div>
                      <label className="block text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-1">
                        一句话简介
                      </label>
                      <input
                        type="text"
                        value={description}
                        aria-label="角色描述"
                        onChange={(e) => setDescription(e.target.value)}
                        placeholder="例如：负责需求澄清与任务分发"
                        className="w-full h-8 px-2.5 text-xs bg-zinc-50/80 dark:bg-zinc-900/80 border border-zinc-200 dark:border-zinc-800 rounded-lg focus:bg-white dark:focus:bg-zinc-900 focus:outline-none focus:ring-1 focus:ring-zinc-900 dark:focus:ring-zinc-400 text-zinc-800 dark:text-zinc-200 placeholder-zinc-400 dark:placeholder-zinc-500"
                      />
                    </div>
                  </div>

                  {/* Model Provider & Model Section - Visual Noise Reduced */}
                  <div className="p-3.5 sm:p-4 bg-zinc-50/70 dark:bg-zinc-900/70 border border-zinc-200/90 dark:border-zinc-800/90 rounded-2xl space-y-3">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold text-zinc-900 dark:text-zinc-100 flex items-center gap-1.5">
                        <Cpu className="w-3.5 h-3.5 text-zinc-700 dark:text-zinc-300" />
                        <span>模型与推理</span>
                      </span>
                      {loadingCatalog && (
                        <span className="text-[11px] text-zinc-500 dark:text-zinc-400 flex items-center gap-1">
                          <Loader2 className="w-3 h-3 animate-spin text-zinc-600 dark:text-zinc-400" />
                          <span>同步目录中...</span>
                        </span>
                      )}
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      {/* Provider Selector */}
                      <div className="space-y-1.5">
                        <label className="block text-xs font-medium text-zinc-700 dark:text-zinc-300">
                          模型服务商
                        </label>
                        <SearchableSelect
                          options={catalogProviders.map((p) => ({
                            id: p.id,
                            label: p.name,
                            hint: `${p.id}${p.models?.length ? ` · ${p.models.length} 款` : ''}`,
                          }))}
                          value={isCustomProvider ? '' : modelProvider}
                          onChange={handleProviderSelect}
                          placeholder="请选择模型服务商"
                          searchPlaceholder="搜索服务商名称 / 标识..."
                          unknownValueLabel={modelProvider ? `${modelProvider}（已保存/外部服务商）` : undefined}
                          customTrigger={{ id: '__custom_provider__', label: '自定义服务商...' }}
                          emptyText="无匹配的服务商"
                        />
                      </div>

                      {/* Thinking Level */}
                      <div className="space-y-1.5">
                        <label className="block text-xs font-medium text-zinc-700 dark:text-zinc-300">
                          思考深度
                        </label>
                        <select
                          value={thinkingLevel}
                          aria-label="思考深度"
                          onChange={(e) => setThinkingLevel(e.target.value as ThinkingLevel | '')}
                          className="w-full h-8 px-2.5 text-xs bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded-lg focus:outline-none focus:ring-1 focus:ring-zinc-900 dark:focus:ring-zinc-400 text-zinc-800 dark:text-zinc-200"
                        >
                          <option value="" className="dark:bg-zinc-900 dark:text-zinc-100">默认（自动）</option>
                          {modelThinkingLevels.map((level) => (
                            <option key={level} value={level} className="dark:bg-zinc-900 dark:text-zinc-100">
                              {THINKING_LEVEL_LABELS[level] || level}
                            </option>
                          ))}
                        </select>
                        {currentModelMeta?.thinkingLevels && (
                          <p className="text-[11px] text-zinc-400 dark:text-zinc-500">
                            按模型 {currentModelMeta.name || currentModelMeta.id} 实际支持的等级展示
                          </p>
                        )}
                      </div>
                    </div>

                    {/* Custom Provider input if active */}
                    {isCustomProvider && (
                      <div className="p-3 bg-zinc-100/90 dark:bg-zinc-800/90 border border-zinc-200 dark:border-zinc-800 rounded-xl space-y-1">
                        <label
                          htmlFor="custom-provider-id"
                          className="block text-xs font-medium text-zinc-700 dark:text-zinc-300"
                        >
                          自定义服务商标识
                        </label>
                        <input
                          id="custom-provider-id"
                          value={customProviderInput}
                          onChange={(e) => setCustomProviderInput(e.target.value)}
                          required
                          placeholder="例如：mistral、bedrock 或节点已注册的标识"
                          className="w-full h-8 px-2.5 text-xs bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded-lg font-mono focus:outline-none focus:ring-1 focus:ring-zinc-900 dark:focus:ring-zinc-400 text-zinc-800 dark:text-zinc-200 placeholder-zinc-400 dark:placeholder-zinc-500"
                        />
                      </div>
                    )}

                    {/* Model ID Selector & Input */}
                    <div className="space-y-1.5 pt-0.5">
                      <div className="flex items-center justify-between">
                        <label className="block text-xs font-medium text-zinc-700 dark:text-zinc-300">
                          模型型号
                        </label>
                        {availableModels.length > 0 && (
                          <span className="text-[11px] text-zinc-400 dark:text-zinc-500">
                            已收录 {availableModels.length} 款型号
                          </span>
                        )}
                      </div>

                      {availableModels.length > 0 ? (
                        <SearchableSelect
                          options={availableModels.map((m) => ({
                            id: m.id,
                            label: m.name || m.id,
                            hint: m.id,
                          }))}
                          value={modelId}
                          onChange={setModelId}
                          allowCustom
                          placeholder="输入或选择模型型号"
                          searchPlaceholder="搜索或直接输入型号..."
                          emptyText="目录中无匹配型号，输入后可直接使用"
                        />
                      ) : (
                        <input
                          type="text"
                          value={modelId}
                          aria-label="模型标识"
                          onChange={(e) => setModelId(e.target.value)}
                          placeholder="输入模型型号，例如：gpt-4o、claude-3-7-sonnet"
                          className="w-full h-8 px-2.5 text-xs bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded-lg focus:outline-none focus:ring-1 focus:ring-zinc-900 dark:focus:ring-zinc-400 font-mono text-zinc-800 dark:text-zinc-200 placeholder-zinc-400 dark:placeholder-zinc-500"
                          required
                        />
                      )}

                      {/* Capability Metadata - Crisp light-gray single line */}
                      {currentModelMeta && (
                        <div className="text-[11px] text-zinc-500 dark:text-zinc-400 flex items-center gap-2 pt-1 flex-wrap">
                          <span className="font-medium text-zinc-700 dark:text-zinc-300">{currentModelMeta.name}</span>
                          {currentModelMeta.reasoning && (
                            <>
                              <span className="text-zinc-300 dark:text-zinc-700">·</span>
                              <span className="text-zinc-600 dark:text-zinc-400">支持深度思考</span>
                            </>
                          )}
                          {currentModelMeta.contextWindow && (
                            <>
                              <span className="text-zinc-300 dark:text-zinc-700">·</span>
                              <span>上下文 {Math.round(currentModelMeta.contextWindow / 1000)}k</span>
                            </>
                          )}
                          {currentModelMeta.maxTokens && (
                            <>
                              <span className="text-zinc-300 dark:text-zinc-700">·</span>
                              <span>最大输出 {currentModelMeta.maxTokens}</span>
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Enabled Skills */}
                  <div>
                    <label className="block text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-1.5">
                      启用技能（已选 {enabledSkills.length} 项）
                    </label>
                    {availableSkills.length === 0 ? (
                      <p className="text-xs text-zinc-400 dark:text-zinc-500 bg-zinc-50 dark:bg-zinc-900 p-3 rounded-xl border border-zinc-200 dark:border-zinc-800">
                        当前节点暂无可用技能，可在节点卡片中添加。
                      </p>
                    ) : (
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 border border-zinc-200 dark:border-zinc-800 rounded-xl p-2.5 bg-zinc-50/50 dark:bg-zinc-900/50 max-h-36 overflow-y-auto">
                        {availableSkills.map((skill) => {
                          const isChecked = enabledSkills.includes(skill);
                          return (
                            <label
                              key={skill}
                              className={`flex items-center gap-2 p-1.5 rounded-lg border text-[11px] cursor-pointer transition-colors ${
                                isChecked
                                  ? 'bg-indigo-50/70 dark:bg-indigo-950/40 border-indigo-300 dark:border-indigo-800 text-indigo-950 dark:text-indigo-200'
                                  : 'bg-white dark:bg-zinc-950 border-zinc-200 dark:border-zinc-800 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800'
                              }`}
                            >
                              <input
                                type="checkbox"
                                checked={isChecked}
                                onChange={() => toggleSkill(skill)}
                                className="rounded text-indigo-600 dark:text-indigo-400 border-zinc-300 dark:border-zinc-700 focus:ring-indigo-500 dark:bg-zinc-900"
                              />
                              <span className="font-mono truncate">{skill}</span>
                            </label>
                          );
                        })}
                      </div>
                    )}
                  </div>

                  {/* Env (Secrets) editor */}
                  <div className="p-3.5 sm:p-4 bg-zinc-50/70 dark:bg-zinc-900/70 border border-zinc-200/90 dark:border-zinc-800/90 rounded-2xl space-y-3">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold text-zinc-900 dark:text-zinc-100 flex items-center gap-1.5">
                        <KeyRound className="w-3.5 h-3.5 text-zinc-700 dark:text-zinc-300" />
                        <span>环境变量 (Secrets)</span>
                      </span>
                      <button
                        type="button"
                        onClick={addEnvPair}
                        className="h-7 px-2.5 text-xs font-medium rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 flex items-center gap-1 transition-colors cursor-pointer"
                      >
                        <Plus className="w-3 h-3" />
                        <span>添加变量</span>
                      </button>
                    </div>
                    <p className="text-[11px] text-zinc-500 dark:text-zinc-400 leading-relaxed">
                      注入至 bash 子进程环境（0600 隔离存储），模型仅知晓变量名 $VAR，不会暴露明文到上下文
                    </p>

                    {envPairs.length === 0 ? (
                      <p className="text-[11px] text-zinc-400 dark:text-zinc-500 bg-white/60 dark:bg-zinc-900/60 p-2 rounded-lg border border-dashed border-zinc-200 dark:border-zinc-800">
                        {isEditing && node?.status !== 'online'
                          ? '节点离线时无法读取或保存环境变量，待节点上线后重试。'
                          : '尚未配置环境变量，点击右上角「添加变量」新建。'}
                      </p>
                    ) : (
                      <div className="space-y-1.5">
                        {envPairs.map((pair, index) => (
                          <div key={index} className="flex items-center gap-1.5">
                            <input
                              type="text"
                              value={pair.key}
                              aria-label={`环境变量名 ${index + 1}`}
                              onChange={(e) => updateEnvPair(index, { key: sanitizeEnvKey(e.target.value) })}
                              placeholder="GITHUB_TOKEN"
                              className="w-2/5 h-8 px-2.5 text-xs font-mono bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded-lg focus:outline-none focus:ring-1 focus:ring-zinc-900 dark:focus:ring-zinc-400 text-zinc-800 dark:text-zinc-200 placeholder-zinc-400 dark:placeholder-zinc-500"
                            />
                            <div className="relative flex-1">
                              <input
                                type={pair.visible ? 'text' : 'password'}
                                value={pair.value}
                                aria-label={`环境变量值 ${index + 1}`}
                                onChange={(e) => updateEnvPair(index, { value: e.target.value })}
                                placeholder="••••••••"
                                autoComplete="off"
                                className="w-full h-8 pl-2.5 pr-8 text-xs font-mono bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded-lg focus:outline-none focus:ring-1 focus:ring-zinc-900 dark:focus:ring-zinc-400 text-zinc-800 dark:text-zinc-200 placeholder-zinc-400 dark:placeholder-zinc-500"
                              />
                              <button
                                type="button"
                                onClick={() => updateEnvPair(index, { visible: !pair.visible })}
                                className="absolute right-1.5 top-1/2 -translate-y-1/2 p-1 text-zinc-400 hover:text-zinc-600 dark:text-zinc-500 dark:hover:text-zinc-300 rounded transition-colors cursor-pointer"
                                aria-label={pair.visible ? '隐藏明文' : '显示明文'}
                                title={pair.visible ? '隐藏明文' : '显示明文'}
                              >
                                {pair.visible ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                              </button>
                            </div>
                            <button
                              type="button"
                              onClick={() => removeEnvPair(index)}
                              className="p-1.5 text-zinc-400 hover:text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/50 rounded-lg transition-colors cursor-pointer shrink-0"
                              aria-label={`删除变量 ${index + 1}`}
                              title="删除变量"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Enabled Extensions */}
                  <div>
                    <label className="block text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-1.5">
                      启用扩展（已选 {enabledExtensions.length} 项）
                    </label>
                    <p className="text-[11px] text-zinc-500 dark:text-zinc-400 mb-2 leading-relaxed">
                      启用后，扩展注册的命令会自动出现在聊天的 / 菜单中。需要终端界面的命令暂不支持在网页执行。
                    </p>
                    {availableExtensions.length === 0 ? (
                      <p className="text-xs text-zinc-400 dark:text-zinc-500 bg-zinc-50 dark:bg-zinc-900 p-3 rounded-xl border border-zinc-200 dark:border-zinc-800">
                        当前节点暂无可用扩展，可在节点卡片中安装添加。
                      </p>
                    ) : (
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 border border-zinc-200 dark:border-zinc-800 rounded-xl p-2.5 bg-zinc-50/50 dark:bg-zinc-900/50 max-h-36 overflow-y-auto">
                        {availableExtensions.map((ext) => {
                          const isChecked = enabledExtensions.includes(ext);
                          return (
                            <label
                              key={ext}
                              className={`flex items-center gap-2 p-1.5 rounded-lg border text-[11px] cursor-pointer transition-colors ${
                                isChecked
                                  ? 'bg-indigo-50/70 dark:bg-indigo-950/40 border-indigo-300 dark:border-indigo-800 text-indigo-950 dark:text-indigo-200'
                                  : 'bg-white dark:bg-zinc-950 border-zinc-200 dark:border-zinc-800 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800'
                              }`}
                            >
                              <input
                                type="checkbox"
                                checked={isChecked}
                                onChange={() => toggleExtension(ext)}
                                className="rounded text-indigo-600 dark:text-indigo-400 border-zinc-300 dark:border-zinc-700 focus:ring-indigo-500 dark:bg-zinc-900"
                              />
                              <span className="font-mono truncate">{ext}</span>
                            </label>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Tab 2: System Persona */}
              {activeTab === 'system' && (
                <div className="flex-1 flex flex-col space-y-2">
                  <div className="flex items-center justify-between text-xs text-zinc-500 dark:text-zinc-400">
                    <span className="font-mono text-[11px] text-zinc-400 dark:text-zinc-500 truncate">
                      ~/.botd/bots/{id || '<唯一标识>'}/SYSTEM.md
                    </span>
                    <button
                      type="button"
                      onClick={() => setSystemMd(DEFAULT_SYSTEM_MD)}
                      className="text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100 underline text-[11px] shrink-0"
                    >
                      恢复默认模板
                    </button>
                  </div>
                  <textarea
                    value={systemMd}
                    aria-label="SYSTEM.md 人设提示词"
                    onChange={(e) => setSystemMd(e.target.value)}
                    placeholder="输入智能体的角色定位、协作规范与提示词..."
                    className="w-full flex-1 min-h-[300px] p-2.5 text-xs bg-zinc-50/80 dark:bg-zinc-900/80 border border-zinc-200 dark:border-zinc-800 rounded-lg focus:bg-white dark:focus:bg-zinc-900 focus:outline-none focus:ring-1 focus:ring-zinc-900 dark:focus:ring-zinc-400 font-mono leading-relaxed text-zinc-800 dark:text-zinc-200 placeholder-zinc-400 dark:placeholder-zinc-500"
                    required
                  />
                </div>
              )}

              {/* Tab 3: Long-term Memory */}
              {activeTab === 'memory' && (
                <div className="flex-1 flex flex-col space-y-2">
                  <div className="flex items-center justify-between text-xs text-zinc-500 dark:text-zinc-400">
                    <span className="font-mono text-[11px] text-zinc-400 dark:text-zinc-500 truncate">
                      ~/.botd/bots/{id || '<唯一标识>'}/MEMORY.md
                    </span>
                    <button
                      type="button"
                      onClick={() => setMemoryMd(DEFAULT_MEMORY_MD)}
                      className="text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100 underline text-[11px] shrink-0"
                    >
                      恢复示例记忆
                    </button>
                  </div>
                  <p className="text-[11px] text-zinc-400 dark:text-zinc-500">
                    智能体在会话中可通过文件工具自主写入更新持久记忆。你也可以在此直接查阅或修订。
                  </p>
                  <textarea
                    value={memoryMd}
                    aria-label="MEMORY.md 长期记忆"
                    onChange={(e) => setMemoryMd(e.target.value)}
                    placeholder="输入智能体的跨会话长期记忆内容..."
                    className="w-full flex-1 min-h-[280px] p-2.5 text-xs bg-zinc-50/80 dark:bg-zinc-900/80 border border-zinc-200 dark:border-zinc-800 rounded-lg focus:bg-white dark:focus:bg-zinc-900 focus:outline-none focus:ring-1 focus:ring-zinc-900 dark:focus:ring-zinc-400 font-mono leading-relaxed text-zinc-800 dark:text-zinc-200 placeholder-zinc-400 dark:placeholder-zinc-500"
                  />
                </div>
              )}
            </>
          )}

          {/* Footer controls */}
          <div className="pt-2 flex items-center justify-end gap-2 border-t border-zinc-100 dark:border-zinc-800/60 shrink-0">
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              className="px-4 py-2 text-xs font-medium text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded-xl transition-colors"
            >
              取消
            </button>
            <button
              type="submit"
              disabled={saving || loadingFiles || loadFailed}
              className="px-4 py-2 bg-zinc-900 hover:bg-zinc-800 disabled:bg-zinc-300 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white dark:disabled:bg-zinc-800 dark:disabled:text-zinc-600 text-white text-xs font-semibold rounded-xl shadow-xs flex items-center gap-1.5 transition-colors"
            >
              {saving ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Save className="w-3.5 h-3.5" />
              )}
              <span>{isEditing ? '保存修改' : '创建智能体'}</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
