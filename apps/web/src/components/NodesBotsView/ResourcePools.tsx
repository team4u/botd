import React from 'react';
import { Wrench, Blocks, Plus, Edit, ChevronDown } from 'lucide-react';
import type { NodeWithBots } from '@botd/protocol';
import { POOL_PREVIEW_COUNT } from './helpers';

/** 技能库区块：可折叠的技能芯片池（Hub SQLite 权威存储，全节点共享）。 */
export const SkillsPoolSection: React.FC<{
  node: NodeWithBots;
  expandedPools: Set<string>;
  onTogglePool: (key: string) => void;
  onOpenNewSkill: (node: NodeWithBots) => void;
  onOpenEditSkill: (node: NodeWithBots, skillId: string) => void;
}> = ({ node, expandedPools, onTogglePool, onOpenNewSkill, onOpenEditSkill }) => {
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
          className="text-[11px] font-medium text-zinc-700 hover:text-zinc-900 dark:text-zinc-300 dark:hover:text-zinc-100 flex items-center gap-0.5 cursor-pointer"
          title="新建技能（存于 Hub SQLite，全节点共享）"
        >
          <Plus className="w-3 h-3" />
          <span>新建技能</span>
        </button>
      </div>

      {skills.length > 0 ? (
        <>
          <div className="flex flex-wrap gap-1.5">
            {(expanded ? skills : skills.slice(0, POOL_PREVIEW_COUNT)).map((skill) => (
              <button
                key={skill}
                type="button"
                onClick={() => onOpenEditSkill(node, skill)}
                className="group inline-flex items-center bg-zinc-50 hover:bg-zinc-100 dark:bg-zinc-900 dark:hover:bg-zinc-800 border border-zinc-200 hover:border-zinc-400 dark:border-zinc-800 dark:hover:border-zinc-600 rounded-md text-[11px] font-mono text-zinc-700 dark:text-zinc-300 transition-all shadow-2xs cursor-pointer"
                title="点击查看并编辑说明文档"
              >
                <span className="px-2 py-0.5 flex items-center gap-1">
                  <span>{skill}</span>
                  <Edit className="w-2.5 h-2.5 opacity-40 group-hover:opacity-100" />
                </span>
              </button>
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
  expandedPools: Set<string>;
  onTogglePool: (key: string) => void;
  onOpenNewExtension: (node: NodeWithBots) => void;
  onOpenEditExtension: (node: NodeWithBots, extId: string) => void;
}> = ({ node, expandedPools, onTogglePool, onOpenNewExtension, onOpenEditExtension }) => {
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
          className="text-[11px] font-medium text-zinc-700 hover:text-zinc-900 dark:text-zinc-300 dark:hover:text-zinc-100 flex items-center gap-0.5 cursor-pointer"
          title="安装或新建扩展（存于 Hub SQLite，全节点共享）"
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
                className="group px-2 py-0.5 bg-zinc-50 hover:bg-zinc-100 dark:bg-zinc-900 dark:hover:bg-zinc-800 border border-zinc-200 hover:border-zinc-400 dark:border-zinc-800 dark:hover:border-zinc-600 rounded-md text-[11px] font-mono text-zinc-700 dark:text-zinc-300 flex items-center gap-1 transition-all shadow-2xs cursor-pointer"
                title="点击查看并编辑扩展代码"
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
