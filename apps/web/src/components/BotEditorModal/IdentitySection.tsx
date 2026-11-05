import React from 'react';
import { Server, Lock, Users, FolderGit2 } from 'lucide-react';
import type { NodeWithBots, SubagentColor } from '@botd/protocol';
import { type NodeSpaceEntry, fetchNodeSpaces } from '../../create-session-draft.js';
import { SUBAGENT_COLOR_OPTIONS } from './shared.js';

interface IdentitySectionProps {
  isSubagent: boolean;
  node: NodeWithBots | null;
  id: string;
  setId: (v: string) => void;
  isEditing: boolean;
  name: string;
  setName: (v: string) => void;
  description: string;
  setDescription: (v: string) => void;
  color: SubagentColor;
  setColor: (c: SubagentColor) => void;
  visibility: 'private' | 'team';
  setVisibility: (v: 'private' | 'team') => void;
  /** 主 BOT 默认工作区目录（仅非子代理时编辑） */
  workspaceDir?: string;
  setWorkspaceDir?: (v: string) => void;
}

/** 基础配置 Tab 的身份区：徽标颜色、所属节点、唯一标识、名称与简介、可见范围、默认工作区。 */
export const IdentitySection: React.FC<IdentitySectionProps> = ({
  isSubagent,
  node,
  id,
  setId,
  isEditing,
  name,
  setName,
  description,
  setDescription,
  color,
  setColor,
  visibility,
  setVisibility,
  workspaceDir = '',
  setWorkspaceDir,
}) => {
  const nodeId = node?.id || '';

  // 节点本地 Git 仓库扫描（静默容错）：仅在线时尝试，作为 Space 快选芯片
  const [nodeSpaces, setNodeSpaces] = React.useState<NodeSpaceEntry[]>([]);
  React.useEffect(() => {
    if (isSubagent || !nodeId || node?.status !== 'online') {
      setNodeSpaces([]);
      return;
    }
    let active = true;
    fetchNodeSpaces(nodeId).then((spaces) => {
      if (active) setNodeSpaces(spaces);
    });
    return () => {
      active = false;
    };
  }, [isSubagent, nodeId, node?.status]);

  return (
  <>
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
    {/* Default workspace directory (primary bots only) */}
    {!isSubagent && setWorkspaceDir && (
      <div>
        <label htmlFor="bot-workspace-dir-input" className="block text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-1">
          默认工作区目录 (Space Path)
        </label>
        <input
          id="bot-workspace-dir-input"
          type="text"
          value={workspaceDir}
          aria-label="默认工作区目录"
          onChange={(e) => setWorkspaceDir(e.target.value)}
          placeholder="例如：/root/code/botd"
          className="w-full h-8 px-2.5 text-xs bg-zinc-50/80 dark:bg-zinc-900/80 border border-zinc-200 dark:border-zinc-800 rounded-lg font-mono focus:bg-white dark:focus:bg-zinc-900 focus:outline-none focus:ring-1 focus:ring-zinc-900 dark:focus:ring-zinc-400 text-zinc-800 dark:text-zinc-200 placeholder:text-zinc-400 dark:placeholder:text-zinc-500"
        />
        {nodeSpaces.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {nodeSpaces.map((space) => {
              const selected = workspaceDir.trim() === space.path;
              return (
                <button
                  key={space.path}
                  type="button"
                  onClick={() => setWorkspaceDir(space.path)}
                  title={space.path}
                  className={`inline-flex items-center gap-1 px-2 py-1 text-[11px] rounded-full border transition-colors cursor-pointer ${
                    selected
                      ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900 border-transparent'
                      : 'bg-zinc-50 dark:bg-zinc-900 border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800'
                  }`}
                >
                  {space.isGitRepo && <FolderGit2 className="w-3 h-3" />}
                  <span>{space.name}</span>
                  {space.branch && (
                    <span className="font-mono opacity-70">({space.branch})</span>
                  )}
                </button>
              );
            })}
          </div>
        )}
        <p className="mt-1 text-[11px] text-zinc-400 dark:text-zinc-500">
          绑定真实项目目录（如 /root/code/botd）后，该智能体将直接在该仓库下执行命令、自动加载项目
          AGENTS.md 并基于该仓库创建子代理 Worktree。留空则使用默认沙盒目录。
        </p>
      </div>
    )}
  </>
  );
};
