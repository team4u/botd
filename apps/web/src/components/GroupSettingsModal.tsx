import React, { useState, useEffect, useRef } from 'react';
import { X, Users, Sparkles, Loader2, Save } from 'lucide-react';
import type { SessionRecord, SessionMode, BotConfig, CreateSessionInput } from '@botd/protocol';
import { CheckList } from './CheckList.js';

export interface GroupSettingsDraft {
  title: string;
  mode: SessionMode;
  leadBotId: string;
  memberBotIds: string[];
  parallelRoundtable: boolean;
  error: string | null;
}

export function initGroupSettingsDraft(
  session: SessionRecord,
  bots: BotConfig[] = []
): GroupSettingsDraft {
  const leadBotId = session.leadBotId || (bots[0]?.id ?? '');
  return {
    title: session.title,
    mode: session.mode,
    leadBotId,
    memberBotIds: session.memberBotIds || (leadBotId ? [leadBotId] : []),
    parallelRoundtable: session.parallelRoundtable ?? false,
    error: null,
  };
}

export interface ResolveGroupSettingsStepParams {
  isOpen: boolean;
  lastInitializedSessionId: string | null;
  currentSession: SessionRecord;
  currentDraft: GroupSettingsDraft;
  bots: BotConfig[];
}

export interface ResolveGroupSettingsStepResult {
  shouldUpdate: boolean;
  nextInitializedSessionId: string | null;
  nextDraft: GroupSettingsDraft;
}

export function resolveGroupSettingsStep({
  isOpen,
  lastInitializedSessionId,
  currentSession,
  currentDraft,
  bots,
}: ResolveGroupSettingsStepParams): ResolveGroupSettingsStepResult {
  // 关弹窗：重置初始化记录，不更新草稿
  if (!isOpen) {
    return {
      shouldUpdate: false,
      nextInitializedSessionId: null,
      nextDraft: currentDraft,
    };
  }

  // 弹窗打开 或 切换了被编辑的 session.id：以编辑对象 ID 为初始化边界
  if (lastInitializedSessionId !== currentSession.id) {
    return {
      shouldUpdate: true,
      nextInitializedSessionId: currentSession.id,
      nextDraft: initGroupSettingsDraft(currentSession, bots),
    };
  }

  // 弹窗对同一 session 保持打开（SSE产生新 session 对象、后台轮询 bots 等）
  // 首次异步到达 bots 且当前草稿尚未有 leadBotId 时可补填
  let updatedDraft = currentDraft;
  let draftModified = false;

  if (!updatedDraft.leadBotId && bots.length > 0) {
    const fallbackLead = bots[0].id;
    updatedDraft = {
      ...updatedDraft,
      leadBotId: fallbackLead,
      memberBotIds: updatedDraft.memberBotIds.includes(fallbackLead)
        ? updatedDraft.memberBotIds
        : [...updatedDraft.memberBotIds, fallbackLead],
    };
    draftModified = true;
  }

  // 数据中被删 BOT 合理处理，但不能因为后台 refresh 重设整份草稿
  if (bots.length > 0) {
    const validIds = new Set(bots.map((b) => b.id));
    let leadBotId = updatedDraft.leadBotId;
    let leadChanged = false;
    if (leadBotId && !validIds.has(leadBotId)) {
      leadBotId = bots[0]?.id || '';
      leadChanged = true;
    }

    const filteredMembers = updatedDraft.memberBotIds.filter((id) => validIds.has(id));
    const finalMembers = leadChanged && leadBotId && !filteredMembers.includes(leadBotId)
      ? [...filteredMembers, leadBotId]
      : filteredMembers;

    const membersChanged =
      finalMembers.length !== updatedDraft.memberBotIds.length ||
      finalMembers.some((id, idx) => id !== updatedDraft.memberBotIds[idx]);

    if (leadChanged || membersChanged) {
      updatedDraft = {
        ...updatedDraft,
        leadBotId,
        memberBotIds: finalMembers,
      };
      draftModified = true;
    }
  }

  if (draftModified) {
    return {
      shouldUpdate: true,
      nextInitializedSessionId: currentSession.id,
      nextDraft: updatedDraft,
    };
  }

  // 相同数据刷新/SSE新对象/在线状态变化：完全不覆盖草稿
  return {
    shouldUpdate: false,
    nextInitializedSessionId: currentSession.id,
    nextDraft: currentDraft,
  };
}

interface GroupSettingsModalProps {
  isOpen: boolean;
  session: SessionRecord;
  bots: BotConfig[];
  nodeMap: Map<string, { name: string; status: 'online' | 'offline' }>;
  onClose: () => void;
  onUpdateSession: (sessionId: string, input: Partial<CreateSessionInput>) => Promise<void>;
}

export const GroupSettingsModal: React.FC<GroupSettingsModalProps> = ({
  isOpen,
  session,
  bots,
  nodeMap,
  onClose,
  onUpdateSession,
}) => {
  const [title, setTitle] = useState(session.title);
  const [mode, setMode] = useState<SessionMode>(session.mode);
  const [leadBotId, setLeadBotId] = useState(session.leadBotId);
  const [memberBotIds, setMemberBotIds] = useState<string[]>(session.memberBotIds || []);
  const [parallelRoundtable, setParallelRoundtable] = useState(session.parallelRoundtable ?? false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const lastInitializedSessionIdRef = useRef<string | null>(null);
  const draftRef = useRef<GroupSettingsDraft>({
    title,
    mode,
    leadBotId,
    memberBotIds,
    parallelRoundtable,
    error,
  });
  draftRef.current = {
    title,
    mode,
    leadBotId,
    memberBotIds,
    parallelRoundtable,
    error,
  };

  useEffect(() => {
    const step = resolveGroupSettingsStep({
      isOpen,
      lastInitializedSessionId: lastInitializedSessionIdRef.current,
      currentSession: session,
      currentDraft: draftRef.current,
      bots,
    });

    lastInitializedSessionIdRef.current = step.nextInitializedSessionId;

    if (step.shouldUpdate) {
      setTitle(step.nextDraft.title);
      setMode(step.nextDraft.mode);
      setLeadBotId(step.nextDraft.leadBotId);
      setMemberBotIds(step.nextDraft.memberBotIds);
      setParallelRoundtable(step.nextDraft.parallelRoundtable);
      setError(step.nextDraft.error);
    }
  }, [isOpen, session.id, session, bots]);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedTitle = title.trim();
    if (!trimmedTitle) {
      setError('群聊标题不能为空');
      return;
    }
    if (memberBotIds.length < 2) {
      setError('群聊至少需保留 2 个成员');
      return;
    }

    const finalMembers = Array.from(new Set([...memberBotIds, leadBotId]));

    setLoading(true);
    setError(null);

    try {
      await onUpdateSession(session.id, {
        title: trimmedTitle,
        mode,
        leadBotId: leadBotId || finalMembers[0],
        memberBotIds: finalMembers,
        parallelRoundtable: mode === 'roundtable' ? parallelRoundtable : false,
      });
      onClose();
    } catch (err: any) {
      setError(err?.message || '更新群设置失败');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/40 dark:bg-black/70 backdrop-blur-xs flex items-end sm:items-center justify-center p-0 sm:p-4 overflow-y-auto animate-in fade-in"
      role="dialog"
      aria-modal="true"
      aria-labelledby="group-settings-title"
    >
      <div className="bg-white dark:bg-zinc-950 rounded-t-2xl sm:rounded-2xl shadow-2xl border border-zinc-200/80 dark:border-zinc-800/80 w-full sm:max-w-lg overflow-hidden flex flex-col max-h-[90dvh]">
        {/* 移动端手柄条 */}
        <div className="w-10 h-1 bg-zinc-300 dark:bg-zinc-700 rounded-full mx-auto my-2 sm:hidden shrink-0" />

        {/* 弹窗头部 */}
        <div className="px-5 py-3.5 sm:px-6 sm:py-4 border-b border-zinc-100 dark:border-zinc-800/60 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2">
            <Users className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
            <h2 id="group-settings-title" className="text-sm sm:text-base font-semibold text-zinc-900 dark:text-zinc-100">
              群聊设置与成员管理
            </h2>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 text-zinc-400 dark:text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300 rounded-lg hover:bg-zinc-100 dark:hover:bg-zinc-800 cursor-pointer"
            aria-label="关闭对话框"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* 表单主体 */}
        <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-4">
          {error && (
            <div className="p-3 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900/60 text-rose-700 dark:text-rose-300 text-xs rounded-xl" role="alert">
              {error}
            </div>
          )}

          <div>
            <label htmlFor="edit-group-title" className="block text-xs font-semibold text-zinc-700 dark:text-zinc-300 mb-1.5">
              群聊标题
            </label>
            <input
              id="edit-group-title"
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="w-full h-8 px-2.5 text-xs bg-zinc-50 dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 rounded-lg text-zinc-800 dark:text-zinc-100 placeholder-zinc-400 dark:placeholder-zinc-500 focus:bg-white dark:focus:bg-zinc-900 focus:outline-none focus:ring-2 focus:ring-indigo-500"
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
                onClick={() => setMode('lead')}
                className={`p-3 rounded-xl border text-left transition-all cursor-pointer ${
                  mode === 'lead'
                    ? 'bg-amber-50/80 dark:bg-amber-950/40 border-amber-400 dark:border-amber-500 text-amber-950 dark:text-amber-100 ring-1 ring-amber-300 dark:ring-amber-900/60'
                    : 'bg-white dark:bg-zinc-900 border-zinc-200 dark:border-zinc-800 text-zinc-600 dark:text-zinc-400 hover:bg-zinc-50 dark:hover:bg-zinc-800'
                }`}
              >
                <div className="font-semibold text-xs flex items-center gap-1.5 mb-1">
                  <Sparkles className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400" />
                  <span>主持模式</span>
                </div>
                <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
                  指定主持人统筹，支持 @ 传麦接力。
                </p>
              </button>

              <button
                type="button"
                onClick={() => setMode('roundtable')}
                className={`p-3 rounded-xl border text-left transition-all cursor-pointer ${
                  mode === 'roundtable'
                    ? 'bg-purple-50/80 dark:bg-purple-950/40 border-purple-400 dark:border-purple-500 text-purple-950 dark:text-purple-100 ring-1 ring-purple-300 dark:ring-purple-900/60'
                    : 'bg-white dark:bg-zinc-900 border-zinc-200 dark:border-zinc-800 text-zinc-600 dark:text-zinc-400 hover:bg-zinc-50 dark:hover:bg-zinc-800'
                }`}
              >
                <div className="font-semibold text-xs flex items-center gap-1.5 mb-1">
                  <Users className="w-3.5 h-3.5 text-purple-600 dark:text-purple-400" />
                  <span>圆桌模式</span>
                </div>
                <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
                  群成员按序依次发言，最后由总结人统一归纳陈词。
                </p>
              </button>
            </div>
          </div>

          {mode === 'roundtable' && (
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

          <div>
            <label
              id="edit-group-lead-label"
              htmlFor="edit-group-lead-select"
              className="block text-xs font-semibold text-zinc-700 dark:text-zinc-300 mb-1.5"
            >
              {mode === 'lead' ? '主持人' : '总结人'}
            </label>
            <select
              id="edit-group-lead-select"
              aria-labelledby="edit-group-lead-label"
              value={leadBotId}
              onChange={(e) => {
                const val = e.target.value;
                setLeadBotId(val);
                if (!memberBotIds.includes(val)) {
                  setMemberBotIds((prev) => [...prev, val]);
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
              {mode === 'lead'
                ? '默认由该成员先行响应并统筹分工'
                : '所有成员按顺序依次发言后，由该成员最后总结陈词'}
            </p>
          </div>

          <CheckList
            label="群成员配置"
            countUnit="个"
            emptyText="暂无可选成员"
            options={bots.map((bot) => ({ id: bot.id, data: bot }))}
            selected={memberBotIds}
            onChange={setMemberBotIds}
            lockedIds={leadBotId ? [leadBotId] : []}
            getAriaLabel={(bot: BotConfig) => `选择成员 ${bot.name}`}
            renderItem={(bot: BotConfig) => {
              const node = nodeMap.get(bot.nodeId);
              const isLead = bot.id === leadBotId;
              return (
                <div className="flex items-center justify-between min-w-0 flex-1">
                  <div className="flex items-center gap-2 min-w-0">
                    <div className="min-w-0">
                      <span className="font-semibold text-xs mr-1 truncate text-zinc-900 dark:text-zinc-100">{bot.name}</span>
                      <span className="font-mono text-[11px] text-zinc-400 dark:text-zinc-500">@{bot.id}</span>
                      {isLead && (
                        <span className="ml-1.5 px-1.5 py-0.2 bg-amber-100 dark:bg-amber-900/60 text-amber-800 dark:text-amber-300 text-[11px] font-semibold rounded shrink-0">
                          {mode === 'lead' ? '主持人' : '总结人'}
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
              disabled={loading}
              className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-300 dark:disabled:bg-indigo-900/50 dark:disabled:text-indigo-300/50 text-white text-xs font-semibold rounded-xl shadow-xs flex items-center gap-1.5 cursor-pointer"
            >
              {loading ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin-fast" />
              ) : (
                <Save className="w-3.5 h-3.5" />
              )}
              <span>保存修改</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
