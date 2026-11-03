import React from 'react';
import { Wrench, Blocks, Plus, Edit, Loader2, Share2, ChevronDown } from 'lucide-react';
import type { NodeWithBots } from '@botd/protocol';
import { POOL_PREVIEW_COUNT } from './helpers';

/** 技能库区块：可折叠的技能芯片池，支持编辑与跨节点同步。 */
export const SkillsPoolSection: React.FC<{
  node: NodeWithBots;
  isOnline: boolean;
  hasOtherOnlineNodes: boolean;
  expandedPools: Set<string>;
  onTogglePool: (key: string) => void;
  syncingSkillKey: string | null;
  onOpenNewSkill: (node: NodeWithBots) => void;
  onOpenEditSkill: (node: NodeWithBots, skillId: string) => void;
  onSyncSkill: (nodeId: string, skillId: string) => void;
}> = ({ node, isOnline, hasOtherOnlineNodes, expandedPools, onTogglePool, syncingSkillKey, onOpenNewSkill, onOpenEditSkill, onSyncSkill }) => {
  const skills = node.skills || [];
  const expanded = expandedPools.has(`${node.id}:skills`);

  return (
    <div className="border-t border-zinc-100 dark:border-zinc-800/60 p-4">
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-xs font-medium text-zinc-700 dark:text-zinc-300 flex items-center gap-1">
          <Wrench className="w-3 h-3 text-zinc-500 dark:text-zinc-400" />
          <span>技能库 ({skills.length})</span>
        </span>
        <button
          onClick={() => onOpenNewSkill(node)}
          disabled={!isOnline}
          className="text-[11px] font-medium text-zinc-700 hover:text-zinc-900 dark:text-zinc-300 dark:hover:text-zinc-100 flex items-center gap-0.5 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
          title={!isOnline ? '节点离线，无法新建技能' : '新建技能'}
        >
          <Plus className="w-3 h-3" />
          <span>新建技能</span>
        </button>
      </div>

      {skills.length > 0 ? (
        <>
          <div className="flex flex-wrap gap-1.5">
            {(expanded ? skills : skills.slice(0, POOL_PREVIEW_COUNT)).map((skill) => (
              <div
                key={skill}
                className="group inline-flex items-center bg-zinc-50 hover:bg-zinc-100 dark:bg-zinc-900 dark:hover:bg-zinc-800 border border-zinc-200 hover:border-zinc-400 dark:border-zinc-800 dark:hover:border-zinc-600 rounded-md text-[11px] font-mono text-zinc-700 dark:text-zinc-300 transition-all shadow-2xs overflow-hidden"
              >
                <button
                  type="button"
                  onClick={() => onOpenEditSkill(node, skill)}
                  disabled={!isOnline}
                  className="px-2 py-0.5 flex items-center gap-1 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                  title={isOnline ? '点击查看并编辑说明文档' : '节点离线，无法编辑'}
                >
                  <span>{skill}</span>
                  <Edit className="w-2.5 h-2.5 opacity-40 group-hover:opacity-100" />
                </button>

                {hasOtherOnlineNodes && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onSyncSkill(node.id, skill);
                    }}
                    disabled={syncingSkillKey === `${node.id}:${skill}`}
                    className="px-1.5 py-0.5 border-l border-zinc-200 dark:border-zinc-800 hover:bg-blue-50 dark:hover:bg-blue-950/50 text-zinc-400 hover:text-blue-600 dark:hover:text-blue-400 transition-colors cursor-pointer"
                    title="同步技能到其他节点"
                    aria-label={`同步技能 ${skill} 到其他节点`}
                  >
                    {syncingSkillKey === `${node.id}:${skill}` ? (
                      <Loader2 className="w-2.5 h-2.5 animate-spin-fast text-blue-500" />
                    ) : (
                      <Share2 className="w-2.5 h-2.5" />
                    )}
                  </button>
                )}
              </div>
            ))}
          </div>
          {skills.length > POOL_PREVIEW_COUNT && (
            <button
              onClick={() => onTogglePool(`${node.id}:skills`)}
              className="mt-1.5 inline-flex items-center gap-1 text-[11px] font-medium text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200 transition-colors cursor-pointer"
            >
              <span>{expanded ? '收起' : `展开全部 ${skills.length} 个`}</span>
              <ChevronDown className={`w-3 h-3 transition-transform ${expanded ? 'rotate-180' : ''}`} />
            </button>
          )}
        </>
      ) : (
        <p className="text-[11px] text-zinc-400 dark:text-zinc-500">
          暂无技能，可点击右上角新建，或由智能体通过 ad 导出生成。
        </p>
      )}
    </div>
  );
};

/** 扩展库区块：可折叠的扩展芯片池。 */
export const ExtensionsPoolSection: React.FC<{
  node: NodeWithBots;
  isOnline: boolean;
  expandedPools: Set<string>;
  onTogglePool: (key: string) => void;
  onOpenNewExtension: (node: NodeWithBots) => void;
  onOpenEditExtension: (node: NodeWithBots, extId: string) => void;
}> = ({ node, isOnline, expandedPools, onTogglePool, onOpenNewExtension, onOpenEditExtension }) => {
  const extensions = node.extensions || [];
  const expanded = expandedPools.has(`${node.id}:exts`);

  return (
    <div className="border-t border-zinc-100 dark:border-zinc-800/60 p-4">
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-xs font-medium text-zinc-700 dark:text-zinc-300 flex items-center gap-1">
          <Blocks className="w-3 h-3 text-zinc-500 dark:text-zinc-400" />
          <span>扩展库 ({extensions.length})</span>
        </span>
        <button
          onClick={() => onOpenNewExtension(node)}
          disabled={!isOnline}
          className="text-[11px] font-medium text-zinc-700 hover:text-zinc-900 dark:text-zinc-300 dark:hover:text-zinc-100 flex items-center gap-0.5 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
          title={!isOnline ? '节点离线，无法安装扩展' : '安装或新建扩展'}
        >
          <Plus className="w-3 h-3" />
          <span>安装或新建</span>
        </button>
      </div>

      {extensions.length > 0 ? (
        <>
          <div className="flex flex-wrap gap-1.5">
            {(expanded ? extensions : extensions.slice(0, POOL_PREVIEW_COUNT)).map((ext) => (
              <button
                key={ext}
                onClick={() => onOpenEditExtension(node, ext)}
                disabled={!isOnline}
                className="group px-2 py-0.5 bg-zinc-50 hover:bg-zinc-100 dark:bg-zinc-900 dark:hover:bg-zinc-800 border border-zinc-200 hover:border-zinc-400 dark:border-zinc-800 dark:hover:border-zinc-600 rounded-md text-[11px] font-mono text-zinc-700 dark:text-zinc-300 flex items-center gap-1 transition-all shadow-2xs cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                title={isOnline ? '点击查看并编辑扩展代码' : '节点离线，无法编辑'}
              >
                <span>{ext}</span>
                <Edit className="w-2.5 h-2.5 opacity-40 group-hover:opacity-100" />
              </button>
            ))}
          </div>
          {extensions.length > POOL_PREVIEW_COUNT && (
            <button
              onClick={() => onTogglePool(`${node.id}:exts`)}
              className="mt-1.5 inline-flex items-center gap-1 text-[11px] font-medium text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200 transition-colors cursor-pointer"
            >
              <span>{expanded ? '收起' : `展开全部 ${extensions.length} 个`}</span>
              <ChevronDown className={`w-3 h-3 transition-transform ${expanded ? 'rotate-180' : ''}`} />
            </button>
          )}
        </>
      ) : (
        <p className="text-[11px] text-zinc-400 dark:text-zinc-500">
          暂无扩展插件，可点击右上角安装或新建。
        </p>
      )}
    </div>
  );
};
