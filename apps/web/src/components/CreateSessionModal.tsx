import React, { useState, useEffect, useMemo, useRef } from 'react';
import { X, Bot, Loader2, FolderGit2 } from 'lucide-react';
import type { BotConfig, CreateSessionInput } from '@botd/protocol';
import { orderBotsAsTree } from '../utils/bots.js';
import { resolveCreateSessionStep, fetchNodeSpaces, type CreateSessionDraft, type NodeSpaceEntry } from '../create-session-draft.js';


interface CreateSessionModalProps {
  isOpen: boolean;
  bots: BotConfig[];
  nodeMap: Map<string, { name: string; status: 'online' | 'offline' }>;
  onClose: () => void;
  onCreateSession: (input: CreateSessionInput) => Promise<void>;
  /** 已有会话列表：提取已绑定的 workspaceDir 作为快捷选择芯片 */
  sessions?: Array<{ workspaceDir?: string }>;
}

export const CreateSessionModal: React.FC<CreateSessionModalProps> = ({
  isOpen,
  bots,
  nodeMap,
  onClose,
  onCreateSession,
  sessions,
}) => {
  const [title, setTitle] = useState<string>('');
  const [leadBotId, setLeadBotId] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 项目 Space（工作区目录）：可手输或从节点扫描的 Git 仓库中快选
  const [workspaceDir, setWorkspaceDir] = useState<string>('');
  const [nodeSpaces, setNodeSpaces] = useState<NodeSpaceEntry[]>([]);

  const initializedRef = useRef(false);
  const wasOpenRef = useRef(false);

  const draftRef = useRef<CreateSessionDraft>({
    title,
    leadBotId,
    error,
  });
  draftRef.current = {
    title,
    leadBotId,
    error,
  };

  useEffect(() => {
    const step = resolveCreateSessionStep({
      isOpen,
      wasOpen: wasOpenRef.current,
      initialized: initializedRef.current,
      currentDraft: draftRef.current,
      bots,
    });

    wasOpenRef.current = isOpen;
    initializedRef.current = step.nextInitialized;

    if (step.shouldUpdate) {
      setTitle(step.nextDraft.title);
      setLeadBotId(step.nextDraft.leadBotId);
      setError(step.nextDraft.error);
      // 重置草稿时同步清空 Space 选择，避免残留上一个会话的目录
      setWorkspaceDir('');
    }
  }, [isOpen, bots]);

  // 弹窗打开且已选中主控智能体时，扫描其节点本地的 Git 仓库作为 Space 快选项（静默容错）
  const spacesNodeId = isOpen && leadBotId ? bots.find((b) => b.id === leadBotId)?.nodeId || '' : '';
  useEffect(() => {
    if (!spacesNodeId) {
      setNodeSpaces([]);
      return;
    }
    let active = true;
    fetchNodeSpaces(spacesNodeId).then((spaces) => {
      if (active) setNodeSpaces(spaces);
    });
    return () => {
      active = false;
    };
  }, [spacesNodeId]);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!leadBotId) {
      setError('请选择智能体');
      return;
    }

    const selectedBot = bots.find((b) => b.id === leadBotId);
    const finalTitle = title.trim() || selectedBot?.name || leadBotId;

    setLoading(true);
    try {
      await onCreateSession({
        title: finalTitle,
        leadBotId,
        workspaceDir: workspaceDir.trim() || undefined,
      } as CreateSessionInput);
      onClose();
    } catch (err: any) {
      setError(err?.message || '创建会话失败');
    } finally {
      setLoading(false);
    }
  };

  /** 已用项目空间去重列表：从已有会话提取非空 workspaceDir（含尾部斜杠规范化） */
  const usedWorkspaceDirs = useMemo((): Array<{ path: string; name: string; branch?: string; isGitRepo: boolean }> => {
    const dirs = new Map<string, { path: string; name: string; isGitRepo: boolean }>(); // dir -> 展示名
    for (const s of sessions || []) {
      const raw = (s as { workspaceDir?: string }).workspaceDir;
      const dir = typeof raw === 'string' ? raw.trim().replace(/\/+$/, '') : '';
      if (dir) dirs.set(dir, { path: dir, name: dir.split('/').filter(Boolean).pop() || dir, isGitRepo: false });
    }
    for (const b of bots) {
      const raw = (b as { workspaceDir?: string }).workspaceDir;
      const dir = typeof raw === 'string' ? raw.trim().replace(/\/+$/, '') : '';
      if (dir) dirs.set(dir, { path: dir, name: dir.split('/').filter(Boolean).pop() || dir, isGitRepo: false });
    }
    return [...dirs.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [sessions, bots]);

  /** 快选某个项目 Space：填入目录；若标题仍是默认 Bot 名则智能改为项目名 */
  const handlePickSpace = (space: NodeSpaceEntry) => {
    setWorkspaceDir(space.path);
    const selectedBot = bots.find((b) => b.id === leadBotId);
    const defaultTitle = selectedBot?.name || leadBotId;
    if (!title.trim() || title.trim() === defaultTitle) {
      setTitle(space.name);
    }
  };

  const orderedBots = orderBotsAsTree(bots);

  return (
    <div
      className="fixed inset-0 z-50 bg-black/40 dark:bg-black/70 backdrop-blur-xs flex items-end sm:items-center justify-center p-0 sm:p-4 overflow-y-auto animate-in fade-in"
      role="dialog"
      aria-modal="true"
      aria-labelledby="create-session-title"
    >
      <div className="bg-white dark:bg-zinc-950 rounded-t-2xl sm:rounded-2xl shadow-2xl border border-zinc-200/80 dark:border-zinc-800/80 w-full sm:max-w-md overflow-hidden flex flex-col max-h-[90dvh]">
        {/* 移动端手柄条 */}
        <div className="w-10 h-1 bg-zinc-300 dark:bg-zinc-700 rounded-full mx-auto my-2 sm:hidden shrink-0" />

        {/* 头部标题与关闭按钮 */}
        <div className="px-5 py-3.5 sm:px-6 sm:py-4 border-b border-zinc-100 dark:border-zinc-800/60 flex items-center justify-between shrink-0">
          <h2 id="create-session-title" className="text-sm sm:text-base font-semibold text-zinc-900 dark:text-zinc-100">
            新建会话
          </h2>
          <button
            onClick={onClose}
            className="p-1.5 text-zinc-400 dark:text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300 rounded-lg hover:bg-zinc-100 dark:hover:bg-zinc-800 cursor-pointer"
            aria-label="关闭对话框"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* 表单内容 */}
        <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-4">
          {error && (
            <div className="p-3 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900/60 text-rose-700 dark:text-rose-300 text-xs rounded-xl" role="alert">
              {error}
            </div>
          )}

          {bots.length === 0 ? (
            <div className="py-8 text-center text-zinc-400 dark:text-zinc-500 text-xs">
              <Bot className="w-8 h-8 text-zinc-300 dark:text-zinc-600 mx-auto mb-2" />
              <p>暂无可用智能体，请先在「节点与 BOT 管理」中接入节点并创建成员。</p>
            </div>
          ) : (
            <>
              <div>
                <label htmlFor="create-session-bot" className="block text-xs font-semibold text-zinc-700 dark:text-zinc-300 mb-1.5">
                  选择智能体
                </label>
                <select
                  id="create-session-bot"
                  value={leadBotId}
                  onChange={(e) => {
                    const nextId = e.target.value;
                    setLeadBotId(nextId);
                    const b = bots.find((bot) => bot.id === nextId);
                    if (b && !title.trim()) {
                      setTitle(b.name || b.id);
                    }
                  }}
                  className="w-full h-8 px-2.5 text-xs bg-zinc-50 dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 rounded-lg text-zinc-800 dark:text-zinc-100 focus:bg-white dark:focus:bg-zinc-900 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                >
                  {orderedBots.map((bot) => {
                    const node = nodeMap.get(bot.nodeId);
                    const isOffline = node?.status === 'offline';
                    const prefix = bot.parentBotId ? '  └ ' : '';
                    return (
                      <option key={bot.id} value={bot.id}>
                        {prefix}{bot.name || bot.id} ({bot.id}){isOffline ? ' [离线]' : ''}
                      </option>
                    );
                  })}
                </select>
              </div>

              <div>
                <label htmlFor="create-session-title-input" className="block text-xs font-semibold text-zinc-700 dark:text-zinc-300 mb-1.5">
                  会话标题（可选）
                </label>
                <input
                  id="create-session-title-input"
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="留空默认使用智能体名称"
                  className="w-full h-8 px-2.5 text-xs bg-zinc-50 dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 rounded-lg text-zinc-800 dark:text-zinc-100 placeholder:text-zinc-400 dark:placeholder:text-zinc-500 focus:bg-white dark:focus:bg-zinc-900 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
              </div>

              {/* 项目 Space：绑定工作区目录，会话将直接在该仓库下工作 */}
              <div>
                <label htmlFor="create-session-workspace-input" className="block text-xs font-semibold text-zinc-700 dark:text-zinc-300 mb-1.5">
                  项目空间（可选）
                </label>
                <input
                  id="create-session-workspace-input"
                  type="text"
                  value={workspaceDir}
                  onChange={(e) => setWorkspaceDir(e.target.value)}
                  placeholder="绑定真实项目目录，如 /root/code/botd"
                  className="w-full h-8 px-2.5 text-xs bg-zinc-50 dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 rounded-lg font-mono text-zinc-800 dark:text-zinc-100 placeholder:text-zinc-400 dark:placeholder:text-zinc-500 focus:bg-white dark:focus:bg-zinc-900 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
                {(nodeSpaces.length > 0 || usedWorkspaceDirs.length > 0) && (
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {[...nodeSpaces, ...usedWorkspaceDirs]
                      .filter((space, idx, all) => all.findIndex((s) => s.path === space.path) === idx)
                      .map((space) => {
                      const selected = workspaceDir.trim() === space.path;
                      return (
                        <button
                          key={space.path}
                          type="button"
                          onClick={() => handlePickSpace(space)}
                          title={space.path}
                          className={`inline-flex items-center gap-1 px-2 py-1 text-[11px] rounded-full border transition-colors cursor-pointer ${
                            selected
                              ? 'bg-indigo-50 dark:bg-indigo-950/60 border-indigo-300 dark:border-indigo-800 text-indigo-700 dark:text-indigo-300'
                              : 'bg-zinc-50 dark:bg-zinc-900 border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800'
                          }`}
                        >
                          {space.isGitRepo && <FolderGit2 className="w-3 h-3" />}
                          <span>{space.name}</span>
                          {space.branch && (
                            <span className="text-zinc-400 dark:text-zinc-500 font-mono">({space.branch})</span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                )}
                <p className="mt-1 text-[11px] text-zinc-400 dark:text-zinc-500">
                  绑定后智能体将直接在该仓库下执行命令、加载项目 AGENTS.md，并基于该仓库创建子代理 Worktree。
                </p>
              </div>
            </>
          )}

          {/* 底部操作区 */}
          <div className="pt-3 flex items-center justify-end gap-2 border-t border-zinc-100 dark:border-zinc-800/60 pb-[max(1rem,env(safe-area-inset-bottom,0px))]">
            <button
              type="button"
              onClick={onClose}
              disabled={loading}
              className="px-4 py-2 text-xs font-medium text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded-lg cursor-pointer"
            >
              取消
            </button>
            <button
              type="submit"
              disabled={loading || bots.length === 0}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-300 dark:disabled:bg-blue-900/50 dark:disabled:text-blue-300/50 text-white text-xs font-semibold rounded-lg shadow-xs flex items-center gap-1.5 cursor-pointer"
            >
              {loading && <Loader2 className="w-3.5 h-3.5 animate-spin-fast" />}
              <span>立即创建</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
