import React, { useState, useEffect, useRef } from 'react';
import { X, Bot, Users, Sparkles, Loader2 } from 'lucide-react';
import type { BotConfig, SessionMode, CreateSessionInput } from '@botd/protocol';
import { CheckList } from './CheckList.js';

export interface CreateSessionDraft {
  groupTitle: string;
  groupMode: SessionMode;
  groupLeadBotId: string;
  groupMemberBotIds: string[];
  parallelRoundtable: boolean;
  error: string | null;
}

export function createDefaultSessionDraft(bots: BotConfig[]): CreateSessionDraft {
  const firstBot = bots[0];
  return {
    groupTitle: 'AI 协同群聊',
    groupMode: 'lead',
    groupLeadBotId: firstBot ? firstBot.id : '',
    groupMemberBotIds: bots.slice(0, 3).map((b) => b.id),
    parallelRoundtable: false,
    error: null,
  };
}

export interface ResolveCreateSessionStepParams {
  isOpen: boolean;
  wasOpen: boolean;
  initialized: boolean;
  currentDraft: CreateSessionDraft;
  bots: BotConfig[];
}

export interface ResolveCreateSessionStepResult {
  shouldUpdate: boolean;
  nextInitialized: boolean;
  nextDraft: CreateSessionDraft;
}

export function resolveCreateSessionStep({
  isOpen,
  wasOpen,
  initialized,
  currentDraft,
  bots,
}: ResolveCreateSessionStepParams): ResolveCreateSessionStepResult {
  if (!isOpen) {
    return {
      shouldUpdate: false,
      nextInitialized: false,
      nextDraft: currentDraft,
    };
  }

  // 1. 初次打开或首次从异步加载中拿到可用 bots 时初始化一次
  if (!wasOpen || !initialized) {
    if (bots.length > 0) {
      return {
        shouldUpdate: true,
        nextInitialized: true,
        nextDraft: createDefaultSessionDraft(bots),
      };
    }
    return {
      shouldUpdate: false,
      nextInitialized: false,
      nextDraft: currentDraft,
    };
  }

  // 2. 弹窗已处于打开中：后台轮询新数组引用或在线状态刷新，绝对不能重设整份草稿
  if (bots.length > 0) {
    const validIds = new Set(bots.map((b) => b.id));
    let leadBotId = currentDraft.groupLeadBotId;
    let leadChanged = false;
    if (leadBotId && !validIds.has(leadBotId)) {
      leadBotId = bots[0]?.id || '';
      leadChanged = true;
    }

    const filteredMembers = currentDraft.groupMemberBotIds.filter((id) => validIds.has(id));
    const finalMembers = leadChanged && leadBotId && !filteredMembers.includes(leadBotId)
      ? [...filteredMembers, leadBotId]
      : filteredMembers;

    const membersChanged =
      finalMembers.length !== currentDraft.groupMemberBotIds.length ||
      finalMembers.some((id, idx) => id !== currentDraft.groupMemberBotIds[idx]);

    if (leadChanged || membersChanged) {
      return {
        shouldUpdate: true,
        nextInitialized: true,
        nextDraft: {
          ...currentDraft,
          groupLeadBotId: leadBotId,
          groupMemberBotIds: finalMembers,
        },
      };
    }
  }

  return {
    shouldUpdate: false,
    nextInitialized: true,
    nextDraft: currentDraft,
  };
}

interface CreateSessionModalProps {
  isOpen: boolean;
  bots: BotConfig[];
  nodeMap: Map<string, { name: string; status: 'online' | 'offline' }>;
  onClose: () => void;
  onCreateSession: (input: CreateSessionInput) => Promise<void>;
}

// 单聊不走弹窗：侧边栏「智能体」通讯录点击即静默创建/进入默认单聊会话。
// 本弹窗仅负责群聊（主持/圆桌）创建。
export const CreateSessionModal: React.FC<CreateSessionModalProps> = ({
  isOpen,
  bots,
  nodeMap,
  onClose,
  onCreateSession,
}) => {
  // 群聊状态
  const [groupTitle, setGroupTitle] = useState<string>('');
  const [groupMode, setGroupMode] = useState<SessionMode>('lead');
  const [groupLeadBotId, setGroupLeadBotId] = useState<string>('');
  const [groupMemberBotIds, setGroupMemberBotIds] = useState<string[]>([]);
  const [parallelRoundtable, setParallelRoundtable] = useState(false);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const initializedRef = useRef(false);
  const wasOpenRef = useRef(false);

  const draftRef = useRef<CreateSessionDraft>({
    groupTitle,
    groupMode,
    groupLeadBotId,
    groupMemberBotIds,
    parallelRoundtable,
    error,
  });
  draftRef.current = {
    groupTitle,
    groupMode,
    groupLeadBotId,
    groupMemberBotIds,
    parallelRoundtable,
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
      setGroupTitle(step.nextDraft.groupTitle);
      setGroupMode(step.nextDraft.groupMode);
      setGroupLeadBotId(step.nextDraft.groupLeadBotId);
      setGroupMemberBotIds(step.nextDraft.groupMemberBotIds);
      setParallelRoundtable(step.nextDraft.parallelRoundtable);
      setError(step.nextDraft.error);
    }
  }, [isOpen, bots]);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    const trimmedTitle = groupTitle.trim();
    if (!trimmedTitle) {
      setError('请输入群聊名称');
      return;
    }
    if (groupMemberBotIds.length < 2) {
      setError('群聊至少需要选择 2 个成员');
      return;
    }
    if (!groupLeadBotId) {
      setError(groupMode === 'lead' ? '主持模式下必须指定主持人' : '圆桌模式下必须指定总结人');
      return;
    }

    const finalMembers = Array.from(new Set([...groupMemberBotIds, groupLeadBotId]));

    setLoading(true);
    try {
      await onCreateSession({
        title: trimmedTitle,
        mode: groupMode,
        leadBotId: groupLeadBotId || finalMembers[0],
        memberBotIds: finalMembers,
        ...(groupMode === 'roundtable' ? { parallelRoundtable } : {}),
      });
      onClose();
    } catch (err: any) {
      setError(err?.message || '创建群聊失败');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/40 dark:bg-black/70 backdrop-blur-xs flex items-end sm:items-center justify-center p-0 sm:p-4 overflow-y-auto animate-in fade-in"
      role="dialog"
      aria-modal="true"
      aria-labelledby="create-session-title"
    >
      <div className="bg-white dark:bg-zinc-950 rounded-t-2xl sm:rounded-2xl shadow-2xl border border-zinc-200/80 dark:border-zinc-800/80 w-full sm:max-w-lg overflow-hidden flex flex-col max-h-[90dvh]">
        {/* 移动端手柄条 */}
        <div className="w-10 h-1 bg-zinc-300 dark:bg-zinc-700 rounded-full mx-auto my-2 sm:hidden shrink-0" />

        {/* 头部标题与关闭按钮 */}
        <div className="px-5 py-3.5 sm:px-6 sm:py-4 border-b border-zinc-100 dark:border-zinc-800/60 flex items-center justify-between shrink-0">
          <h2 id="create-session-title" className="text-sm sm:text-base font-semibold text-zinc-900 dark:text-zinc-100">
            新建群聊
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
                <label htmlFor="create-group-title" className="block text-xs font-semibold text-zinc-700 dark:text-zinc-300 mb-1.5">
                  群聊名称
                </label>
                <input
                  id="create-group-title"
                  type="text"
                  value={groupTitle}
                  onChange={(e) => setGroupTitle(e.target.value)}
                  placeholder="例如：产品与架构研讨群"
                  className="w-full h-8 px-2.5 text-xs bg-zinc-50 dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 rounded-lg text-zinc-800 dark:text-zinc-100 placeholder:text-zinc-400 dark:placeholder:text-zinc-500 focus:bg-white dark:focus:bg-zinc-900 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  required
                />
              </div>

              <div>
                <span className="block text-xs font-semibold text-zinc-700 dark:text-zinc-300 mb-1.5">
                  协作模式
                </span>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => setGroupMode('lead')}
                    className={`p-3 rounded-xl border text-left transition-all cursor-pointer ${
                      groupMode === 'lead'
                        ? 'bg-amber-50/70 dark:bg-amber-950/40 border-amber-400 dark:border-amber-500 text-amber-950 dark:text-amber-100 ring-1 ring-amber-300 dark:ring-amber-900/60'
                        : 'bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 text-zinc-600 dark:text-zinc-400 hover:bg-zinc-50 dark:hover:bg-zinc-800'
                    }`}
                  >
                    <div className="font-semibold text-xs flex items-center gap-1.5 mb-1">
                      <Sparkles className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400" />
                      <span>主持模式</span>
                    </div>
                    <p className="text-[11px] text-zinc-500 dark:text-zinc-400 leading-relaxed">
                      由指定主持人优先响应，正文中可通过 @ 指定其他成员接力协作。
                    </p>
                  </button>

                  <button
                    type="button"
                    onClick={() => setGroupMode('roundtable')}
                    className={`p-3 rounded-xl border text-left transition-all cursor-pointer ${
                      groupMode === 'roundtable'
                        ? 'bg-purple-50/70 dark:bg-purple-950/40 border-purple-400 dark:border-purple-500 text-purple-950 dark:text-purple-100 ring-1 ring-purple-300 dark:ring-purple-900/60'
                        : 'bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 text-zinc-600 dark:text-zinc-400 hover:bg-zinc-50 dark:hover:bg-zinc-800'
                    }`}
                  >
                    <div className="font-semibold text-xs flex items-center gap-1.5 mb-1">
                      <Users className="w-3.5 h-3.5 text-purple-600 dark:text-purple-400" />
                      <span>圆桌模式</span>
                    </div>
                    <p className="text-[11px] text-zinc-500 dark:text-zinc-400 leading-relaxed">
                      群成员按序依次发言，最后由总结人统一归纳陈词。
                    </p>
                  </button>
                </div>
              </div>

              {groupMode === 'roundtable' && (
                <div className="p-3 bg-purple-50/50 dark:bg-purple-950/20 border border-purple-200/70 dark:border-purple-900/50 rounded-xl">
                  <label className="flex items-start gap-2.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={parallelRoundtable}
                      onChange={(e) => setParallelRoundtable(e.target.checked)}
                      className="mt-0.5 rounded border-zinc-300 dark:border-zinc-600 dark:bg-zinc-800 text-purple-600 focus:ring-purple-500 w-3.5 h-3.5 shrink-0"
                    />
                    <div>
                      <span className="block text-xs font-medium text-zinc-900 dark:text-zinc-100">
                        独立盲评并发模式（Parallel Blind Review）
                      </span>
                      <p className="text-[11px] text-zinc-500 dark:text-zinc-400 leading-relaxed">
                        开启后所有成员将并发独立作答（互不可见本轮草稿），最后由主持人汇总裁决
                      </p>
                    </div>
                  </label>
                </div>
              )}

              {/* 主持人 / 总结人选择 */}
              <div>
                <label
                  id="create-group-lead-label"
                  htmlFor="create-group-lead-select"
                  className="block text-xs font-semibold text-zinc-700 dark:text-zinc-300 mb-1.5"
                >
                  {groupMode === 'lead' ? '主持人' : '总结人'}
                </label>
                <select
                  id="create-group-lead-select"
                  aria-labelledby="create-group-lead-label"
                  value={groupLeadBotId}
                  onChange={(e) => {
                    const newLead = e.target.value;
                    setGroupLeadBotId(newLead);
                    if (!groupMemberBotIds.includes(newLead)) {
                      setGroupMemberBotIds((prev) => [...prev, newLead]);
                    }
                  }}
                  className="w-full h-8 px-2.5 text-xs bg-zinc-50 dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 rounded-lg text-zinc-800 dark:text-zinc-100 focus:bg-white dark:focus:bg-zinc-900 focus:outline-none focus:ring-2 focus:ring-amber-500"
                >
                  {bots.map((bot) => (
                    <option key={bot.id} value={bot.id}>
                      {bot.name} (@{bot.id}) - {bot.modelId}
                    </option>
                  ))}
                </select>
                <p className="text-[11px] text-zinc-400 dark:text-zinc-500 mt-1">
                  {groupMode === 'lead'
                    ? '默认由该成员先行响应并统筹分工'
                    : '所有成员按顺序依次发言后，由该成员最后总结陈词'}
                </p>
              </div>

              {/* 成员勾选列表 */}
              <CheckList
                label="参会成员"
                countUnit="个"
                emptyText="暂无可选成员"
                options={bots.map((bot) => ({ id: bot.id, data: bot }))}
                selected={groupMemberBotIds}
                onChange={setGroupMemberBotIds}
                lockedIds={groupLeadBotId ? [groupLeadBotId] : []}
                getAriaLabel={(bot: BotConfig) => `选择成员 ${bot.name}`}
                renderItem={(bot: BotConfig) => {
                  const node = nodeMap.get(bot.nodeId);
                  const isLead = bot.id === groupLeadBotId;
                  return (
                    <div className="flex items-center justify-between min-w-0 flex-1">
                      <div className="flex items-center gap-2 min-w-0">
                        <div className="min-w-0">
                          <span className="font-semibold text-xs mr-1 truncate text-zinc-900 dark:text-zinc-100">{bot.name}</span>
                          <span className="font-mono text-[11px] text-zinc-400 dark:text-zinc-500">@{bot.id}</span>
                          {isLead && (
                            <span className="ml-1.5 px-1.5 py-0.2 bg-amber-100 dark:bg-amber-900/60 text-amber-800 dark:text-amber-300 text-[11px] font-semibold rounded shrink-0">
                              {groupMode === 'lead' ? '主持人' : '总结人'}
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-1.5 text-[11px] text-zinc-400 dark:text-zinc-500 shrink-0 ml-2">
                        {node && <span>{node.name}</span>}
                        <span className="font-mono bg-zinc-100 dark:bg-zinc-800 px-1 py-0.2 rounded text-zinc-500 dark:text-zinc-400">
                          {bot.modelId}
                        </span>
                      </div>
                    </div>
                  );
                }}
              />
            </>
          )}

          {/* 底部操作区适配移动端安全边距 */}
          <div className="pt-3 flex items-center justify-end gap-2 border-t border-zinc-100 dark:border-zinc-800/60 pb-[max(1rem,env(safe-area-inset-bottom,0px))]">
            <button
              type="button"
              onClick={onClose}
              disabled={loading}
              className="px-4 py-2 text-xs font-medium text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded-xl cursor-pointer"
            >
              取消
            </button>
            <button
              type="submit"
              disabled={loading || bots.length === 0}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-300 dark:disabled:bg-blue-900/50 dark:disabled:text-blue-300/50 text-white text-xs font-semibold rounded-xl shadow-xs flex items-center gap-1.5 cursor-pointer"
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
