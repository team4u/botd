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
  Search,
  Lock,
  Users,
  ShieldCheck,
} from 'lucide-react';
import { api } from '../api';
import { SearchableSelect } from './SearchableSelect';
import { CheckList } from './CheckList';
import { ConfirmDialog } from './ConfirmDialog';
import type {
  BotConfig,
  NodeWithBots,
  SaveBotInput,
  ModelCatalog,
  ProviderCatalogEntry,
  ModelCatalogEntry,
  ThinkingLevel,
  SubagentColor,
  SubagentToolScope,
  SubagentIsolation,
} from '@botd/protocol';

export interface BotEditorModalProps {
  isOpen: boolean;
  /** Owning node, fixed by the entry point — bots are created/edited in node context. */
  node: NodeWithBots | null;
  bot?: BotConfig | null;
  parentBot?: BotConfig | null;
  initialTab?: 'basic' | 'system' | 'memory';
  onClose: () => void;
  onSaved: () => void;
}

export interface ResolveBotEditorOpenStepParams {
  isOpen: boolean;
  wasOpen?: boolean;
  bot?: BotConfig | null;
  parentBot?: BotConfig | null;
}

export function resolveBotEditorOpenStep(params: ResolveBotEditorOpenStepParams) {
  const isSubagent = Boolean(params.bot?.parentBotId || params.parentBot?.id);
  const parentBotId = params.bot?.parentBotId || params.parentBot?.id;
  return {
    isSubagent,
    parentBotId,
  };
}

export const SUBAGENT_COLOR_OPTIONS: { id: SubagentColor; label: string; bg: string }[] = [
  { id: 'blue', label: '蓝色', bg: 'bg-blue-500' },
  { id: 'purple', label: '紫色', bg: 'bg-purple-500' },
  { id: 'red', label: '红色', bg: 'bg-red-500' },
  { id: 'emerald', label: '翡翠绿', bg: 'bg-emerald-500' },
  { id: 'amber', label: '琥珀橙', bg: 'bg-amber-500' },
  { id: 'cyan', label: '青色', bg: 'bg-cyan-500' },
  { id: 'pink', label: '粉色', bg: 'bg-pink-500' },
  { id: 'indigo', label: '靛蓝', bg: 'bg-indigo-500' },
];

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

/**
 * 记忆保存 Dirty Check：
 * - 新建 Bot：仅当用户填了非空记忆时才额外发 PUT（后端 saveBot 已默认建空 MEMORY.md）；
 * - 编辑 Bot：仅当用户实际改动记忆内容时才保存，避免旧快照冲掉后台新写入的记忆。
 */
export function shouldSaveBotMemory(
  isEditing: boolean,
  memoryMd: string,
  initialMemoryMd: string | null,
): boolean {
  if (!isEditing) {
    return memoryMd.trim().length > 0;
  }
  return initialMemoryMd !== null && memoryMd !== initialMemoryMd;
}

export const BotEditorModal: React.FC<BotEditorModalProps> = ({
  isOpen,
  node,
  bot,
  parentBot,
  initialTab,
  onClose,
  onSaved,
}) => {
  const isEditing = Boolean(bot);
  const isSubagent = Boolean(bot?.parentBotId || parentBot?.id);
  const resolvedParentBotId = bot?.parentBotId || parentBot?.id || '';

  // Tabs
  const [activeTab, setActiveTab] = useState<'basic' | 'system' | 'memory'>(initialTab || 'basic');

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
  const [visibility, setVisibility] = useState<'private' | 'team'>('private');
  const [systemMd, setSystemMd] = useState(DEFAULT_SYSTEM_MD);
  const [memoryMd, setMemoryMd] = useState('');
  // 打开弹窗时拉取到的记忆初始快照：保存时做 Dirty Check，未改动不回写
  const [initialMemoryMd, setInitialMemoryMd] = useState<string | null>(null);

  // Subagent-specific fields
  const [color, setColor] = useState<SubagentColor>('blue');
  const [inheritModel, setInheritModel] = useState<boolean>(true);
  const [inheritSkills, setInheritSkills] = useState<boolean>(true);
  const [toolScope, setToolScope] = useState<SubagentToolScope>('all');
  const [customTools, setCustomTools] = useState<string[]>(['read', 'grep', 'find', 'ls', 'bash', 'edit', 'write']);
  const [isolation, setIsolation] = useState<SubagentIsolation>('off');

  // 技能搜索：实时过滤，已勾选技能始终可见
  const [skillSearch, setSkillSearch] = useState('');

  // Env (secrets) editor state
  interface EnvPair {
    key: string;
    value: string;
    visible?: boolean;
  }
  const [envPairs, setEnvPairs] = useState<EnvPair[]>([]);
  const [envLoaded, setEnvLoaded] = useState(false);
  // env 单键删除确认
  const [envDeleteIndex, setEnvDeleteIndex] = useState<number | null>(null);
  const [deletingEnvKey, setDeletingEnvKey] = useState(false);

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

  // 技能搜索过滤：匹配项 + 已勾选项始终保留（防搜索时丢失勾选状态不可见）
  const enabledSkillSet = useMemo(() => new Set(enabledSkills), [enabledSkills]);
  const filteredSkills = useMemo(() => {
    const q = skillSearch.trim().toLowerCase();
    if (!q) return availableSkills;
    return availableSkills.filter(
      (skill) => skill.toLowerCase().includes(q) || enabledSkillSet.has(skill)
    );
  }, [availableSkills, skillSearch, enabledSkillSet]);

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
    setActiveTab(initialTab || 'basic');

    if (bot) {
      setId(bot.id);
      setName(bot.name);
      setDescription(bot.description || '');
      setModelProvider(bot.modelProvider);
      setModelId(bot.modelId);
      setThinkingLevel(bot.thinkingLevel || '');
      setEnabledSkills(bot.enabledSkills || []);
      setEnabledExtensions(bot.enabledExtensions || []);
      setVisibility(bot.visibility === 'team' ? 'team' : 'private');
      setIsCustomProvider(false);
      setCustomProviderInput('');
      setColor(bot.color || 'blue');
      setInheritModel(bot.inheritModel ?? Boolean(bot.parentBotId));
      setInheritSkills(bot.inheritSkills ?? Boolean(bot.parentBotId));
      setToolScope(bot.toolScope || 'all');
      setCustomTools(
        bot.customTools && bot.customTools.length > 0
          ? bot.customTools
          : ['read', 'grep', 'find', 'ls', 'bash', 'edit', 'write']
      );
      setIsolation(bot.isolation || 'off');

      // Load SYSTEM.md and MEMORY.md
      setLoadingFiles(true);
      setSystemMd('');
      setMemoryMd('');
      // Load env vars (secrets) when node is online; env panel edits are best-effort
      setEnvPairs([]);
      setEnvLoaded(false);
      const envPromise =
        !bot.parentBotId && node && node.status === 'online'
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
          setInitialMemoryMd(mem.content);
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
      if (parentBot) {
        setModelProvider(parentBot.modelProvider || '');
        setModelId(parentBot.modelId || '');
        setThinkingLevel(parentBot.thinkingLevel || 'medium');
        setColor('blue');
        setInheritModel(true);
        setInheritSkills(true);
        setToolScope('all');
        setCustomTools(['read', 'grep', 'find', 'ls', 'bash', 'edit', 'write']);
        setIsolation('off');
        setSystemMd(`# 角色定位\n你是一个隶属于 @${parentBot.id} 的专业子代理。\n\n## 职责与规范\n1. 专注于指派的子任务，结论清晰、要点明确。\n2. 遵循所属主 BOT 的工作规范与原则。\n`);
      } else {
        setModelProvider('');
        setModelId('');
        setThinkingLevel('medium');
        setColor('blue');
        setInheritModel(false);
        setInheritSkills(false);
        setToolScope('all');
        setCustomTools(['read', 'grep', 'find', 'ls', 'bash', 'edit', 'write']);
        setIsolation('off');
        setSystemMd(DEFAULT_SYSTEM_MD);
      }
      setEnabledSkills([]);
      setEnabledExtensions([]);
      setVisibility('private');
      setIsCustomProvider(false);
      setCustomProviderInput('');
      setMemoryMd('');
      setInitialMemoryMd(null);
      setEnvPairs([]);
      setEnvLoaded(false);
      setLoadingFiles(false);
    }
    setSkillSearch('');

    return () => {
      current = false;
    };
  }, [isOpen, bot?.id, parentBot?.id, initialTab]);

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

  // Env (secrets) helpers
  const addEnvPair = () => {
    setEnvPairs((prev) => [...prev, { key: '', value: '', visible: false }]);
  };

  const removeEnvPair = (index: number) => {
    setEnvPairs((prev) => prev.filter((_, i) => i !== index));
  };

  // 单键删除：先确认；已落盘的 bot（isEditing 且在线）调 API 删除并回写返回 env，否则纯本地移除
  const confirmRemoveEnvPair = async () => {
    if (envDeleteIndex === null) return;
    const pair = envPairs[envDeleteIndex];
    if (!pair) {
      setEnvDeleteIndex(null);
      return;
    }
    const cleanKey = pair.key.trim();
    const canCallApi = isEditing && Boolean(bot?.id) && node?.status === 'online' && cleanKey !== '';

    if (canCallApi) {
      setDeletingEnvKey(true);
      try {
        const res = await api.deleteBotEnvKey(bot!.id, cleanKey);
        setEnvPairs(
          Object.entries(res.env || {}).map(([key, value]) => ({ key, value, visible: false }))
        );
        setEnvLoaded(true);
        setEnvDeleteIndex(null);
      } catch (err: any) {
        setError(err?.message || '删除环境变量失败');
      } finally {
        setDeletingEnvKey(false);
      }
    } else {
      removeEnvPair(envDeleteIndex);
      setEnvDeleteIndex(null);
    }
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

    const effectiveProvider =
      isSubagent && inheritModel
        ? (parentBot?.modelProvider || bot?.modelProvider || modelProvider || 'openai').trim().toLowerCase()
        : isCustomProvider
        ? customProviderInput.trim().toLowerCase()
        : modelProvider.trim().toLowerCase();

    if (!effectiveProvider || !/^[a-zA-Z0-9_-]+$/.test(effectiveProvider)) {
      setError('请输入有效的模型服务商标识 (英文字母、数字、下划线及短横线)');
      setActiveTab('basic');
      return;
    }

    const effectiveModel =
      isSubagent && inheritModel
        ? (parentBot?.modelId || bot?.modelId || modelId || 'gpt-4o').trim()
        : modelId.trim();

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
      enabledSkills: isSubagent && inheritSkills ? [] : enabledSkills,
      enabledExtensions,
      visibility,
      systemMd,
      ...(isSubagent
        ? {
            parentBotId: resolvedParentBotId,
            inheritModel,
            inheritSkills,
            color,
            toolScope,
            customTools: toolScope === 'custom' ? customTools : undefined,
            isolation,
          }
        : {}),
    };

    try {
      if (isEditing) {
        await api.updateBot(botInput.id, botInput);
      } else {
        await api.createBot(botInput);
      }
      if (shouldSaveBotMemory(isEditing, memoryMd, initialMemoryMd)) {
        await api.saveBotMemory(botInput.id, memoryMd);
      }

      // Persist env vars (secrets): only for primary bots (not subagents)
      if (!isSubagent && (envPairs.length > 0 || (isEditing && envLoaded))) {
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
    <>
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
                {isSubagent
                  ? isEditing
                    ? `编辑子代理 · @${id}`
                    : `新建子代理 (隶属: ${parentBot?.name || resolvedParentBotId})`
                  : isEditing
                  ? `编辑智能体: ${bot?.name} (@${bot?.id})`
                  : '新建智能体'}
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
                  {/* Subagent color picker */}
                  {isSubagent && (
                    <div>
                      <label className="block text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-1.5">
                        徽标颜色
                      </label>
                      <div className="flex items-center gap-2">
                        {SUBAGENT_COLOR_OPTIONS.map((c) => (
                          <button
                            key={c.id}
                            type="button"
                            onClick={() => setColor(c.id)}
                            title={c.label}
                            aria-label={c.label}
                            className={`w-5 h-5 rounded-full ${c.bg} transition-all cursor-pointer ${
                              color === c.id
                                ? 'ring-2 ring-offset-2 ring-zinc-900 dark:ring-zinc-100 ring-offset-white dark:ring-offset-zinc-950 scale-110'
                                : 'opacity-60 hover:opacity-100 hover:scale-105'
                            }`}
                          />
                        ))}
                      </div>
                    </div>
                  )}

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

                  {/* Visibility setting */}
                  <div>
                    <label className="block text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-1">
                      可见范围
                    </label>
                    <div className="grid grid-cols-2 gap-2">
                      <button
                        type="button"
                        onClick={() => setVisibility('private')}
                        className={`h-8 px-2.5 text-xs rounded-lg font-medium border flex items-center justify-center gap-1.5 transition-colors cursor-pointer ${
                          visibility === 'private'
                            ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900 border-transparent'
                            : 'border-zinc-200 dark:border-zinc-800 text-zinc-600 dark:text-zinc-400 hover:bg-zinc-50 dark:hover:bg-zinc-900'
                        }`}
                      >
                        <Lock className="w-3.5 h-3.5" />
                        <span>仅自己可见</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => setVisibility('team')}
                        className={`h-8 px-2.5 text-xs rounded-lg font-medium border flex items-center justify-center gap-1.5 transition-colors cursor-pointer ${
                          visibility === 'team'
                            ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900 border-transparent'
                            : 'border-zinc-200 dark:border-zinc-800 text-zinc-600 dark:text-zinc-400 hover:bg-zinc-50 dark:hover:bg-zinc-900'
                        }`}
                      >
                        <Users className="w-3.5 h-3.5" />
                        <span>团队共享</span>
                      </button>
                    </div>
                    <p className="mt-1 text-[11px] text-zinc-400 dark:text-zinc-500">
                      {visibility === 'team'
                        ? '团队成员可将此 BOT 拉入群聊、发起单聊或子任务委派'
                        : '仅限节点创建者本人可见与使用'}
                    </p>
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

                    {isSubagent && (
                      <div className="grid grid-cols-2 gap-2">
                        <button
                          type="button"
                          onClick={() => setInheritModel(true)}
                          className={`h-8 px-2.5 text-xs rounded-lg font-medium border flex items-center justify-center gap-1.5 transition-colors cursor-pointer ${
                            inheritModel
                              ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900 border-transparent'
                              : 'border-zinc-200 dark:border-zinc-800 text-zinc-600 dark:text-zinc-400 hover:bg-zinc-50 dark:hover:bg-zinc-900'
                          }`}
                        >
                          <span>跟随主 BOT 模型</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => setInheritModel(false)}
                          className={`h-8 px-2.5 text-xs rounded-lg font-medium border flex items-center justify-center transition-colors cursor-pointer ${
                            !inheritModel
                              ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900 border-transparent'
                              : 'border-zinc-200 dark:border-zinc-800 text-zinc-600 dark:text-zinc-400 hover:bg-zinc-50 dark:hover:bg-zinc-900'
                          }`}
                        >
                          <span>单独指定模型</span>
                        </button>
                      </div>
                    )}

                    {isSubagent && inheritModel ? (
                      <div className="p-3 bg-white/70 dark:bg-zinc-950/70 border border-zinc-200 dark:border-zinc-800 rounded-xl text-xs text-zinc-600 dark:text-zinc-400">
                        当前跟随主 BOT ({parentBot?.modelProvider || bot?.modelProvider || '—'}/{parentBot?.modelId || bot?.modelId || '—'})，无需重复配置
                      </div>
                    ) : (
                      <>
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
                      </>
                    )}
                  </div>

                  {/* Subagent Execution Boundary (Tool Permissions) */}
                  {isSubagent && (
                    <div className="p-3.5 sm:p-4 bg-zinc-50/70 dark:bg-zinc-900/70 border border-zinc-200/90 dark:border-zinc-800/90 rounded-2xl space-y-3">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-semibold text-zinc-900 dark:text-zinc-100 flex items-center gap-1.5">
                          <ShieldCheck className="w-3.5 h-3.5 text-zinc-700 dark:text-zinc-300" />
                          <span>工具权限</span>
                        </span>
                      </div>

                      {/* 工具权限 */}
                      <div className="space-y-1.5">
                        <div className="grid grid-cols-3 gap-2">
                          <button
                            type="button"
                            onClick={() => setToolScope('all')}
                            className={`h-8 px-2 text-xs rounded-lg font-medium border flex items-center justify-center transition-colors cursor-pointer ${
                              toolScope === 'all'
                                ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900 border-transparent'
                                : 'border-zinc-200 dark:border-zinc-800 text-zinc-600 dark:text-zinc-400 hover:bg-zinc-50 dark:hover:bg-zinc-900'
                            }`}
                          >
                            全量读写
                          </button>
                          <button
                            type="button"
                            onClick={() => setToolScope('readonly')}
                            className={`h-8 px-2 text-xs rounded-lg font-medium border flex items-center justify-center transition-colors cursor-pointer ${
                              toolScope === 'readonly'
                                ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900 border-transparent'
                                : 'border-zinc-200 dark:border-zinc-800 text-zinc-600 dark:text-zinc-400 hover:bg-zinc-50 dark:hover:bg-zinc-900'
                            }`}
                          >
                            仅只读分析
                          </button>
                          <button
                            type="button"
                            onClick={() => setToolScope('custom')}
                            className={`h-8 px-2 text-xs rounded-lg font-medium border flex items-center justify-center transition-colors cursor-pointer ${
                              toolScope === 'custom'
                                ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900 border-transparent'
                                : 'border-zinc-200 dark:border-zinc-800 text-zinc-600 dark:text-zinc-400 hover:bg-zinc-50 dark:hover:bg-zinc-900'
                            }`}
                          >
                            自定义
                          </button>
                        </div>
                        {toolScope === 'readonly' && (
                          <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
                            禁止修改或写入文件，适合审稿/架构/顾问角色
                          </p>
                        )}
                        {toolScope === 'custom' && (
                          <div className="p-2.5 bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded-lg space-y-2 mt-2">
                            <span className="text-[11px] font-medium text-zinc-600 dark:text-zinc-400">勾选允许调用的工具：</span>
                            <div className="flex flex-wrap gap-2.5">
                              {['read', 'grep', 'find', 'ls', 'bash', 'edit', 'write'].map((tool) => (
                                <label key={tool} className="flex items-center gap-1.5 text-xs font-mono text-zinc-700 dark:text-zinc-300 cursor-pointer">
                                  <input
                                    type="checkbox"
                                    checked={customTools.includes(tool)}
                                    onChange={(e) => {
                                      if (e.target.checked) {
                                        setCustomTools((prev) => [...prev, tool]);
                                      } else {
                                        setCustomTools((prev) => prev.filter((t) => t !== tool));
                                      }
                                    }}
                                    className="rounded border-zinc-300 dark:border-zinc-700 text-zinc-900 dark:text-zinc-100 focus:ring-zinc-900 w-3.5 h-3.5"
                                  />
                                  <span>{tool}</span>
                                </label>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  {/* Enabled Skills (searchable) */}
                  <div>
                    {isSubagent && (
                      <div className="mb-2">
                        <label className="block text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-1">
                          技能配置
                        </label>
                        <div className="grid grid-cols-2 gap-2">
                          <button
                            type="button"
                            onClick={() => setInheritSkills(true)}
                            className={`h-8 px-2 text-xs rounded-lg font-medium border flex items-center justify-center gap-1 transition-colors cursor-pointer ${
                              inheritSkills
                                ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900 border-transparent'
                                : 'border-zinc-200 dark:border-zinc-800 text-zinc-600 dark:text-zinc-400 hover:bg-zinc-50 dark:hover:bg-zinc-900'
                            }`}
                          >
                            继承主 BOT 全部技能
                          </button>
                          <button
                            type="button"
                            onClick={() => setInheritSkills(false)}
                            className={`h-8 px-2 text-xs rounded-lg font-medium border flex items-center justify-center transition-colors cursor-pointer ${
                              !inheritSkills
                                ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900 border-transparent'
                                : 'border-zinc-200 dark:border-zinc-800 text-zinc-600 dark:text-zinc-400 hover:bg-zinc-50 dark:hover:bg-zinc-900'
                            }`}
                          >
                            仅勾选专属技能
                          </button>
                        </div>
                      </div>
                    )}

                    {isSubagent && inheritSkills ? (
                      <div className="p-3 bg-zinc-50/70 dark:bg-zinc-900/70 border border-zinc-200 dark:border-zinc-800 rounded-xl text-xs text-zinc-500 dark:text-zinc-400">
                        当前设置继承主 BOT 的全部技能，运行子任务时自动共享主 BOT 技能库。
                      </div>
                    ) : (
                      <>
                        <div className="relative mb-1.5">
                          <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-400 dark:text-zinc-500 pointer-events-none" />
                          <input
                            type="text"
                            value={skillSearch}
                            onChange={(e) => setSkillSearch(e.target.value)}
                            placeholder="搜索技能…"
                            aria-label="搜索技能"
                            className="w-full h-8 pl-8 pr-7 text-xs bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded-lg focus:outline-none focus:ring-1 focus:ring-zinc-900 dark:focus:ring-zinc-400 text-zinc-800 dark:text-zinc-200 placeholder:text-zinc-400 dark:placeholder:text-zinc-500"
                          />
                          {skillSearch && (
                            <button
                              type="button"
                              onClick={() => setSkillSearch('')}
                              className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-zinc-600 dark:text-zinc-500 dark:hover:text-zinc-300 text-xs p-0.5"
                              aria-label="清空搜索"
                            >
                              ×
                            </button>
                          )}
                        </div>
                        <CheckList
                          label={skillSearch.trim() ? `启用技能（已勾选始终显示）` : '启用技能'}
                          variant="grid"
                          countUnit="项"
                          emptyText={
                            skillSearch.trim()
                              ? '未找到匹配的技能（已勾选的技能会始终显示）'
                              : '当前节点暂无可用技能，可在节点卡片中添加。'
                          }
                          options={filteredSkills.map((skill) => ({ id: skill, data: skill }))}
                          selected={enabledSkills}
                          onChange={setEnabledSkills}
                          renderItem={(skill) => <span className="font-mono truncate">{skill}</span>}
                        />
                      </>
                    )}
                  </div>

                  {/* Env (Secrets) editor */}
                  {isSubagent ? (
                    <div className="p-3.5 bg-zinc-50/70 dark:bg-zinc-900/70 border border-zinc-200/90 dark:border-zinc-800/90 rounded-2xl flex items-center gap-2 text-xs text-zinc-600 dark:text-zinc-400">
                      <KeyRound className="w-4 h-4 text-zinc-500 shrink-0" />
                      <span>环境变量自动共享自所属主 BOT (@{resolvedParentBotId})</span>
                    </div>
                  ) : (
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
                                onClick={() => setEnvDeleteIndex(index)}
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
                  )}

                  {/* Enabled Extensions */}
                  <CheckList
                    label="启用扩展"
                    variant="grid"
                    countUnit="项"
                    description="启用后，扩展注册的命令会自动出现在聊天的 / 菜单中。需要终端界面的命令暂不支持在网页执行。"
                    emptyText="当前节点暂无可用扩展，可在节点卡片中安装添加。"
                    options={availableExtensions.map((ext) => ({ id: ext, data: ext }))}
                    selected={enabledExtensions}
                    onChange={setEnabledExtensions}
                    renderItem={(ext) => <span className="font-mono truncate">{ext}</span>}
                  />
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
                    智能体在会话中可通过文件工具自主维护 MEMORY.md 索引与 memory/*.md 主题记忆。你也可以在此直接查阅或修订核心记忆。
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
              <span>{isEditing ? '保存修改' : (isSubagent ? '创建子代理' : '创建智能体')}</span>
            </button>
          </div>
        </form>
      </div>
    </div>

    {/* 单键删除环境变量确认 */}
    <ConfirmDialog
      isOpen={envDeleteIndex !== null}
      title="删除环境变量"
      message={
        <>
          删除环境变量{' '}
          <span className="font-mono font-medium text-zinc-800 dark:text-zinc-200">
            {envDeleteIndex !== null ? (envPairs[envDeleteIndex]?.key?.trim() || '（未命名）') : ''}
          </span>
          ？该 BOT 的此配置将被移除。
        </>
      }
      confirmText="删除"
      danger
      busy={deletingEnvKey}
      onConfirm={confirmRemoveEnvPair}
      onClose={() => setEnvDeleteIndex(null)}
    />
    </>
  );
};
