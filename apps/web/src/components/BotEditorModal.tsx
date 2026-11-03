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
  KeyRound,
  Search,
} from 'lucide-react';
import { api } from '../api';
import { CheckList } from './CheckList';
import type {
  BotConfig,
  NodeWithBots,
  SaveBotInput,
  ModelCatalogEntry,
  ThinkingLevel,
  SubagentColor,
  SubagentToolScope,
  SubagentIsolation,
} from '@botd/protocol';
import {
  DEFAULT_MEMORY_MD,
  DEFAULT_SYSTEM_MD,
  shouldSaveBotMemory,
} from './BotEditorModal/shared';
import { clampThinkingLevel, deriveModelThinkingLevels, useModelCatalog } from './BotEditorModal/useModelCatalog';
import { EnvEditorSection, type EnvPair } from './BotEditorModal/EnvEditorSection';
import { ModelSection } from './BotEditorModal/ModelSection';
import { IdentitySection } from './BotEditorModal/IdentitySection';

// 保持既有测试与调用方从主文件导入纯函数/常量
export { resolveBotEditorOpenStep, SUBAGENT_COLOR_OPTIONS, shouldSaveBotMemory } from './BotEditorModal/shared';
export type { ResolveBotEditorOpenStepParams } from './BotEditorModal/shared';
export { DEFAULT_SYSTEM_MD, DEFAULT_MEMORY_MD } from './BotEditorModal/shared';

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

const DEFAULT_CUSTOM_TOOLS = ['read', 'grep', 'find', 'ls', 'bash', 'edit', 'write'];

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
  const [customTools, setCustomTools] = useState<string[]>(DEFAULT_CUSTOM_TOOLS);
  const [isolation, setIsolation] = useState<SubagentIsolation>('off');

  // 技能搜索：实时过滤，已勾选技能始终可见
  const [skillSearch, setSkillSearch] = useState('');

  // Env (secrets) editor state
  const [envPairs, setEnvPairs] = useState<EnvPair[]>([]);
  const [envLoaded, setEnvLoaded] = useState(false);

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

  const { loadingCatalog, catalogError, catalogProviders } = useModelCatalog(isOpen, nodeId);

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
  const modelThinkingLevels = useMemo(() => deriveModelThinkingLevels(currentModelMeta), [currentModelMeta]);

  // Clamp selected level when the model changes and no longer supports it
  useEffect(() => {
    if (!thinkingLevel || modelThinkingLevels.length === 0) return;
    const next = clampThinkingLevel(thinkingLevel, modelThinkingLevels);
    if (next !== null) {
      setThinkingLevel(next);
    }
  }, [modelThinkingLevels]);

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
          : DEFAULT_CUSTOM_TOOLS
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
        setCustomTools(DEFAULT_CUSTOM_TOOLS);
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
        setCustomTools(DEFAULT_CUSTOM_TOOLS);
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

  if (!isOpen) return null;

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
                  <IdentitySection
                    isSubagent={isSubagent}
                    node={node}
                    id={id}
                    setId={setId}
                    isEditing={isEditing}
                    name={name}
                    setName={setName}
                    description={description}
                    setDescription={setDescription}
                    color={color}
                    setColor={setColor}
                    visibility={visibility}
                    setVisibility={setVisibility}
                  />

                  {/* Model Provider & Model Section - Visual Noise Reduced */}
                  <ModelSection
                    isSubagent={isSubagent}
                    parentBotModel={{
                      provider: parentBot?.modelProvider || bot?.modelProvider,
                      model: parentBot?.modelId || bot?.modelId,
                    }}
                    catalogProviders={catalogProviders}
                    loadingCatalog={loadingCatalog}
                    modelProvider={modelProvider}
                    isCustomProvider={isCustomProvider}
                    customProviderInput={customProviderInput}
                    setCustomProviderInput={setCustomProviderInput}
                    onProviderSelect={handleProviderSelect}
                    modelId={modelId}
                    setModelId={setModelId}
                    availableModels={availableModels}
                    currentModelMeta={currentModelMeta}
                    thinkingLevel={thinkingLevel}
                    setThinkingLevel={setThinkingLevel}
                    modelThinkingLevels={modelThinkingLevels}
                    inheritModel={inheritModel}
                    setInheritModel={setInheritModel}
                    toolScope={toolScope}
                    setToolScope={setToolScope}
                    customTools={customTools}
                    setCustomTools={setCustomTools}
                  />

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
                    <EnvEditorSection
                      envPairs={envPairs}
                      setEnvPairs={setEnvPairs}
                      apiDelete={
                        isEditing && bot?.id && node?.status === 'online'
                          ? { botId: bot.id }
                          : null
                      }
                      onError={(message) => setError(message)}
                      showOfflineHint={isEditing && node?.status !== 'online'}
                    />
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
  );
};
