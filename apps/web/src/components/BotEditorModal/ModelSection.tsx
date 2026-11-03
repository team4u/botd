import React from 'react';
import { Cpu, Loader2, ShieldCheck } from 'lucide-react';
import type { ProviderCatalogEntry, ModelCatalogEntry, ThinkingLevel, SubagentToolScope } from '@botd/protocol';
import { SearchableSelect } from '../SearchableSelect';
import { THINKING_LEVEL_LABELS } from './useModelCatalog';

interface ModelSectionProps {
  isSubagent: boolean;
  parentBotModel: { provider?: string; model?: string };
  catalogProviders: ProviderCatalogEntry[];
  loadingCatalog: boolean;
  // provider / model fields
  modelProvider: string;
  isCustomProvider: boolean;
  customProviderInput: string;
  setCustomProviderInput: (v: string) => void;
  onProviderSelect: (val: string) => void;
  modelId: string;
  setModelId: (v: string) => void;
  availableModels: ModelCatalogEntry[];
  currentModelMeta: ModelCatalogEntry | null;
  // thinking
  thinkingLevel: ThinkingLevel | '';
  setThinkingLevel: (v: ThinkingLevel | '') => void;
  modelThinkingLevels: Exclude<ThinkingLevel, ''>[];
  // subagent inherit model
  inheritModel: boolean;
  setInheritModel: (v: boolean) => void;
  // tool scope (subagent only)
  toolScope: SubagentToolScope;
  setToolScope: (v: SubagentToolScope) => void;
  customTools: string[];
  setCustomTools: React.Dispatch<React.SetStateAction<string[]>>;
}

/** 模型与推理 + 子代理工具权限区块（基础配置 Tab 内）。 */
export const ModelSection: React.FC<ModelSectionProps> = ({
  isSubagent,
  parentBotModel,
  catalogProviders,
  loadingCatalog,
  modelProvider,
  isCustomProvider,
  customProviderInput,
  setCustomProviderInput,
  onProviderSelect,
  modelId,
  setModelId,
  availableModels,
  currentModelMeta,
  thinkingLevel,
  setThinkingLevel,
  modelThinkingLevels,
  inheritModel,
  setInheritModel,
  toolScope,
  setToolScope,
  customTools,
  setCustomTools,
}) => (
  <>
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
          当前跟随主 BOT ({parentBotModel.provider || '—'}/{parentBotModel.model || '—'})，无需重复配置
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
                onChange={onProviderSelect}
                placeholder="请选择模型服务商"
                searchPlaceholder="搜索服务商名称 / 标识..."
                unknownValueLabel={modelProvider ? `${modelProvider}（已保存/外部服务商）` : undefined}
                customTrigger={{ id: '__custom_provider__', label: '自定义服务商...' }}
                emptyText="该节点暂无已配置的服务商，可先在设置中登录，或选择自定义服务商"
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
  </>
);
