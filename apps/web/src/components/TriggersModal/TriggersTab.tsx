import React, { useEffect, useState } from 'react';
import {
  Zap,
  Plus,
  Trash2,
  Copy,
  Terminal,
  Loader2,
  Timer,
  CheckCircle2,
  Pencil,
  Check,
  Clock,
  Split,
} from 'lucide-react';
import { describeCronExpr } from '@botd/protocol';
import type {
  SessionRecord,
  BotConfig,
  TriggerRecord,
} from '@botd/protocol';
import { api } from '../../api';
import { ConfirmDialog } from '../ConfirmDialog';
import { TriggerForm } from './TriggerForm';
import { InboxSection } from './InboxSection';
import { copyWithToast, useUrlCopy, type AddToastFn } from './shared';

export interface TriggersTabProps {
  /** 当前 Tab 是否激活（常驻挂载保留状态，非激活时不渲染） */
  visible: boolean;
  session: SessionRecord;
  memberBots: BotConfig[];
  onAddToast: AddToastFn;
}

export const TriggersTab: React.FC<TriggersTabProps> = ({ visible, session, memberBots, onAddToast }) => {
  const [triggers, setTriggers] = useState<TriggerRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Form visibility (also reused as edit form via editingTrigger)
  const [showAddForm, setShowAddForm] = useState(false);
  const [editingTrigger, setEditingTrigger] = useState<TriggerRecord | null>(null);

  // Action loading state (toggling or deleting)
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // Run-now confirm dialog state
  const [runConfirmTrigger, setRunConfirmTrigger] = useState<TriggerRecord | null>(null);
  const [runningTrigger, setRunningTrigger] = useState(false);

  const { copiedUrlId, copyUrl } = useUrlCopy(onAddToast);

  // 弹窗打开时随组件挂载拉取最新列表
  useEffect(() => {
    fetchTriggers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id]);

  const fetchTriggers = async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await api.listSessionTriggers(session.id);
      setTriggers(list);
    } catch (err: any) {
      setError(err?.message || '获取触发器列表失败');
    } finally {
      setLoading(false);
    }
  };

  const openCreateForm = () => {
    setEditingTrigger(null);
    setShowAddForm(true);
  };

  const closeForm = () => {
    setEditingTrigger(null);
    setShowAddForm(false);
  };

  const handleStartEdit = (trigger: TriggerRecord) => {
    setEditingTrigger(trigger);
    setError(null);
    setShowAddForm(true);
  };

  const handleRunTrigger = async () => {
    if (!runConfirmTrigger || runningTrigger) return;
    setRunningTrigger(true);
    try {
      await api.runTrigger(runConfirmTrigger.id);
      onAddToast('success', '已触发，请留意会话消息');
      setRunConfirmTrigger(null);
    } catch (err: any) {
      onAddToast('error', err?.message || '触发执行失败');
    } finally {
      setRunningTrigger(false);
    }
  };

  const handleToggleEnabled = async (trigger: TriggerRecord) => {
    setTogglingId(trigger.id);
    try {
      const updated = await api.updateTrigger(trigger.id, { enabled: !trigger.enabled });
      setTriggers((prev) => prev.map((t) => (t.id === trigger.id ? updated : t)));
    } catch (err: any) {
      onAddToast('error', err?.message || '更新触发器状态失败');
    } finally {
      setTogglingId(null);
    }
  };

  const handleDeleteTrigger = async (trigger: TriggerRecord) => {
    setDeletingId(trigger.id);
    try {
      await api.deleteTrigger(trigger.id);
      setTriggers((prev) => prev.filter((t) => t.id !== trigger.id));
      if (editingTrigger?.id === trigger.id) closeForm();
      onAddToast('success', `已删除触发器「${trigger.name}」`);
    } catch (err: any) {
      onAddToast('error', err?.message || '删除触发器失败');
    } finally {
      setDeletingId(null);
    }
  };

  const handleCopyCurlCmd = (curlCmd: string) => copyWithToast(curlCmd, 'curl 命令', onAddToast);

  if (!visible) return null;

  return (
    <div className="space-y-4 animate-in fade-in">
      {error && (
        <div className="p-3 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900/60 text-rose-700 dark:text-rose-300 text-xs rounded-lg" role="alert">
          {error}
        </div>
      )}

      {/* Action bar: Add Trigger button */}
      <div className="flex items-center justify-between">
        <span className="text-xs text-zinc-500 dark:text-zinc-400">
          共配置 {triggers.length} 个自动化触发器
        </span>
        {!showAddForm && (
          <button
            type="button"
            onClick={openCreateForm}
            className="h-8 px-2.5 text-xs font-medium rounded-lg bg-zinc-900 hover:bg-zinc-800 text-white dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white flex items-center gap-1.5 transition-colors cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>新建触发器</span>
          </button>
        )}
      </div>

      {/* Create / Edit Form（key 保证新建/编辑切换与保存后重置表单状态） */}
      {showAddForm && (
        <TriggerForm
          key={editingTrigger?.id ?? 'new'}
          session={session}
          memberBots={memberBots}
          editingTrigger={editingTrigger}
          onAddToast={onAddToast}
          onClose={closeForm}
        />
      )}

      {/* Triggers list */}
      {loading ? (
        <div className="py-12 flex flex-col items-center justify-center text-zinc-400 dark:text-zinc-500 text-xs">
          <Loader2 className="w-6 h-6 animate-spin-fast mb-2" />
          <span>加载触发器中...</span>
        </div>
      ) : triggers.length === 0 ? (
        <div className="py-10 text-center text-zinc-400 dark:text-zinc-500 text-xs border border-dashed border-zinc-200 dark:border-zinc-800 rounded-xl p-6">
          <Zap className="w-8 h-8 text-zinc-300 dark:text-zinc-600 mx-auto mb-2" />
          <p className="font-medium text-zinc-700 dark:text-zinc-300 mb-1">暂无触发器</p>
          <p className="text-[11px]">点击上方「新建触发器」配置 Webhook 或定时任务自动唤醒智能体。</p>
        </div>
      ) : (
        <div className="space-y-3">
          {triggers.map((trigger) => {
            const isToggling = togglingId === trigger.id;
            const isDeleting = deletingId === trigger.id;
            const webhookUrl = trigger.token
              ? `${window.location.origin}/api/webhooks/${trigger.token}`
              : '';
            const curlCmd = webhookUrl
              ? `curl -X POST "${webhookUrl}" -H "Content-Type: application/json" -d '{"message": "触发执行"}'`
              : '';

            const cronRawExpr = trigger.cronExpr || '';
            let cronBadgeText = '';
            if (trigger.kind === 'cron') {
              if (cronRawExpr) {
                try {
                  cronBadgeText = describeCronExpr(cronRawExpr) || cronRawExpr;
                } catch {
                  cronBadgeText = cronRawExpr;
                }
              } else {
                cronBadgeText = 'Cron 定时';
              }
            }

            return (
              <div
                key={trigger.id}
                className={`p-3.5 rounded-xl border transition-all ${
                  trigger.enabled
                    ? 'bg-white dark:bg-zinc-900 border-zinc-200 dark:border-zinc-800 shadow-2xs'
                    : 'bg-zinc-50/70 dark:bg-zinc-950 border-zinc-200/70 dark:border-zinc-900 opacity-75'
                }`}
              >
                {/* Top row */}
                <div className="flex items-start justify-between gap-2 mb-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      {trigger.kind === 'webhook' && (
                        <span className="px-1.5 py-0.5 rounded text-[11px] font-medium bg-blue-50 dark:bg-blue-950/50 text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-900/60 shrink-0">
                          Webhook
                        </span>
                      )}
                      {trigger.kind === 'cron' && (
                        <span className="px-1.5 py-0.5 rounded text-[11px] font-medium bg-purple-50 dark:bg-purple-950/50 text-purple-700 dark:text-purple-300 border border-purple-200 dark:border-purple-900/60 shrink-0">
                          {cronBadgeText}
                        </span>
                      )}
                      {trigger.kind === 'once' && trigger.lastTriggeredAt && (
                        <span className="px-1.5 py-0.5 rounded text-[11px] font-medium bg-emerald-50 dark:bg-emerald-950/50 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-900/60 shrink-0 inline-flex items-center gap-1">
                          <CheckCircle2 className="w-3 h-3" />
                          已执行
                        </span>
                      )}

                      <span className="font-semibold text-xs text-zinc-900 dark:text-zinc-100 truncate">
                        {trigger.name}
                      </span>

                      <span className="text-[11px] font-mono text-zinc-400 dark:text-zinc-500 shrink-0">
                        @{trigger.botId}
                      </span>

                      {trigger.dispatchMode === 'subsession' && (
                        <span
                          className="px-1.5 py-0.5 rounded text-[11px] font-medium bg-cyan-50 dark:bg-cyan-950/50 text-cyan-700 dark:text-cyan-300 border border-cyan-200 dark:border-cyan-900/60 shrink-0 inline-flex items-center gap-1"
                          title="触发时派生独立子会话执行，隔离每次运行"
                        >
                          <Split className="w-3 h-3" />
                          派生子会话
                        </span>
                      )}

                      {trigger.skillId && (
                        <span
                          className="px-1.5 py-0.5 rounded text-[11px] font-medium font-mono bg-violet-50 dark:bg-violet-950/50 text-violet-700 dark:text-violet-300 border border-violet-200 dark:border-violet-900/60 shrink-0"
                          title="触发时自动以 /skill 启动"
                        >
                          /skill:{trigger.skillId}
                        </span>
                      )}

                      {trigger.kind === 'webhook' &&
                        trigger.eventFilter?.types &&
                        trigger.eventFilter.types.length > 0 && (
                          <span
                            className="px-1.5 py-0.5 rounded text-[11px] font-mono bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 border border-zinc-200 dark:border-zinc-700 shrink-0 max-w-full truncate"
                            title={`仅匹配事件类型：${trigger.eventFilter.types.join(', ')}`}
                          >
                            {trigger.eventFilter.types.join(', ')}
                          </span>
                        )}
                    </div>

                    {trigger.kind === 'cron' && cronRawExpr && (
                      <div className="text-[11px] font-mono text-zinc-400 dark:text-zinc-500 mt-0.5">
                        {cronRawExpr}
                      </div>
                    )}
                    {trigger.kind === 'once' && (
                      <div className="text-[11px] text-zinc-400 dark:text-zinc-500 mt-0.5 flex items-center gap-1 flex-wrap">
                        <Timer className="w-3 h-3 shrink-0" />
                        {trigger.runAt && (
                          <span className="font-mono">{new Date(trigger.runAt).toLocaleString()}</span>
                        )}
                        {!trigger.lastTriggeredAt && trigger.enabled && (
                          <span className="text-amber-600 dark:text-amber-400">等待执行</span>
                        )}
                      </div>
                    )}
                  </div>

                  {/* Switch, run, edit and delete buttons */}
                  <div className="flex items-center gap-1.5 shrink-0">
                    <button
                      type="button"
                      onClick={() => handleToggleEnabled(trigger)}
                      disabled={isToggling}
                      className={`h-7 px-2 text-[11px] font-medium rounded-lg border transition-colors cursor-pointer ${
                        trigger.enabled
                          ? 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800/60 hover:bg-emerald-100 dark:hover:bg-emerald-900/50'
                          : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-500 dark:text-zinc-400 border-zinc-200 dark:border-zinc-700 hover:bg-zinc-200 dark:hover:bg-zinc-700'
                      }`}
                      title={trigger.enabled ? '点击停用' : '点击启用'}
                    >
                      {isToggling ? (
                        <Loader2 className="w-3 h-3 animate-spin-fast" />
                      ) : trigger.enabled ? (
                        '已启用'
                      ) : (
                        '已停用'
                      )}
                    </button>

                    <button
                      type="button"
                      onClick={() => setRunConfirmTrigger(trigger)}
                      className="p-1.5 text-zinc-400 hover:text-amber-600 hover:bg-amber-50 dark:hover:bg-amber-950/50 rounded-lg transition-colors cursor-pointer"
                      title="立即触发（手动执行一次）"
                      aria-label={`立即触发 ${trigger.name}`}
                    >
                      <Zap className="w-3.5 h-3.5" />
                    </button>

                    <button
                      type="button"
                      onClick={() => handleStartEdit(trigger)}
                      className="p-1.5 text-zinc-400 hover:text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-950/50 rounded-lg transition-colors cursor-pointer"
                      title="编辑触发器"
                      aria-label={`编辑触发器 ${trigger.name}`}
                    >
                      <Pencil className="w-3.5 h-3.5" />
                    </button>

                    <button
                      type="button"
                      onClick={() => handleDeleteTrigger(trigger)}
                      disabled={isDeleting}
                      className="p-1.5 text-zinc-400 hover:text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/50 rounded-lg transition-colors cursor-pointer disabled:opacity-40"
                      title="删除触发器"
                      aria-label={`删除触发器 ${trigger.name}`}
                    >
                      {isDeleting ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin-fast text-rose-500" />
                      ) : (
                        <Trash2 className="w-3.5 h-3.5" />
                      )}
                    </button>
                  </div>
                </div>

                {/* Prompt preview */}
                <p className="text-xs text-zinc-600 dark:text-zinc-400 bg-zinc-50 dark:bg-zinc-900/60 p-2 rounded-lg border border-zinc-100 dark:border-zinc-800/80 mb-2 font-mono">
                  {trigger.prompt}
                </p>

                {/* Webhook trigger specific URL and curl copy */}
                {trigger.kind === 'webhook' && webhookUrl && (
                  <div className="mt-2 space-y-1.5 pt-2 border-t border-zinc-100 dark:border-zinc-800/60">
                    <div className="flex items-center gap-1.5">
                      <span
                        className="flex-1 min-w-0 h-8 px-2.5 text-[11px] font-mono bg-zinc-50 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg text-zinc-600 dark:text-zinc-400 truncate flex items-center select-all"
                        title={webhookUrl}
                      >
                        {webhookUrl}
                      </span>
                      <button
                        type="button"
                        onClick={() => copyUrl(trigger.id, webhookUrl)}
                        className="h-8 w-8 rounded-lg border border-zinc-200 dark:border-zinc-800 hover:bg-zinc-100 dark:hover:bg-zinc-800 text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 flex items-center justify-center shrink-0 cursor-pointer transition-colors"
                        title={copiedUrlId === trigger.id ? '已复制' : '复制 URL'}
                        aria-label="复制 Webhook URL"
                      >
                        {copiedUrlId === trigger.id ? (
                          <Check className="w-3.5 h-3.5 text-emerald-500" />
                        ) : (
                          <Copy className="w-3.5 h-3.5" />
                        )}
                      </button>
                      <button
                        type="button"
                        onClick={() => handleCopyCurlCmd(curlCmd)}
                        className="h-8 px-2.5 text-xs font-medium rounded-lg bg-zinc-900 hover:bg-zinc-800 text-white dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white flex items-center gap-1 shrink-0 cursor-pointer"
                        title="复制带载荷的 curl 命令"
                      >
                        <Terminal className="w-3 h-3" />
                        <span>复制 curl 命令</span>
                      </button>
                    </div>
                  </div>
                )}

                {/* Footer: Last triggered at */}
                {trigger.lastTriggeredAt && (
                  <div className="mt-1.5 text-[11px] text-zinc-400 dark:text-zinc-500 flex items-center gap-1">
                    <Clock className="w-3 h-3" />
                    <span>上次触发: {new Date(trigger.lastTriggeredAt).toLocaleString()}</span>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Event Inbox：最近收到的自动化事件 */}
      <InboxSection sessionId={session.id} onAddToast={onAddToast} />

      {/* Run-now confirm dialog */}
      <ConfirmDialog
        isOpen={Boolean(runConfirmTrigger)}
        title="立即触发"
        message={
          <>
            立即执行一次该触发器的指令？不会影响定时计划。
            {runConfirmTrigger && (
              <span className="block mt-1.5 text-[11px] text-zinc-500 dark:text-zinc-400">
                触发器「{runConfirmTrigger.name}」· 指令将发送给 @{runConfirmTrigger.botId}
              </span>
            )}
          </>
        }
        confirmText="立即执行"
        busy={runningTrigger}
        onConfirm={handleRunTrigger}
        onClose={() => {
          if (!runningTrigger) setRunConfirmTrigger(null);
        }}
      />
    </div>
  );
};
