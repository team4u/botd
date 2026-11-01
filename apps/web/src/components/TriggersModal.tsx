import React, { useState, useEffect } from 'react';
import {
  X,
  Zap,
  Clock,
  Radio,
  Plus,
  Trash2,
  Copy,
  Terminal,
  Loader2,
  Timer,
  CheckCircle2,
} from 'lucide-react';
import type {
  SessionRecord,
  BotConfig,
  TriggerRecord,
  TriggerKind,
  CreateTriggerInput,
} from '@botd/protocol';
import { isValidCronExpr, describeCronExpr } from '@botd/protocol';
import { api } from '../api';

const CRON_PRESETS = [
  { expr: '*/5 * * * *', label: '每 5 分钟' },
  { expr: '*/30 * * * *', label: '每 30 分钟' },
  { expr: '0 * * * *', label: '每小时' },
  { expr: '30 9 * * *', label: '每天 09:30' },
  { expr: '0 9 * * 1-5', label: '工作日 09:30' },
] as const;

const ONCE_PRESETS = [
  { value: '5m', label: '5 分钟后' },
  { value: '15m', label: '15 分钟后' },
  { value: '30m', label: '30 分钟后' },
  { value: '1h', label: '1 小时后' },
  { value: '3h', label: '3 小时后' },
  { value: '1d', label: '1 天后' },
] as const;

/** 校验一次性延时输入：支持相对延时（30s/15m/2h/1d）或 ISO 时间 */
function parseOnceRunAt(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // Relative delay: e.g. 30s, 15m, 2h, 1d (also combined like 1h30m)
  const relMatch = trimmed.match(/^(\d+(?:\d|h|m|s|d)?(?=[hmsd])[hmsd]*)+$/i);
  if (relMatch) {
    let seconds = 0;
    const unitMatches = trimmed.toLowerCase().match(/\d+[hmsd]/g);
    if (unitMatches && unitMatches.length > 0) {
      for (const part of unitMatches) {
        const n = parseInt(part, 10);
        if (Number.isNaN(n)) return null;
        const unit = part.slice(-1);
        if (unit === 's') seconds += n;
        else if (unit === 'm') seconds += n * 60;
        else if (unit === 'h') seconds += n * 3600;
        else if (unit === 'd') seconds += n * 86400;
      }
      if (seconds <= 0) return null;
      return new Date(Date.now() + seconds * 1000).toISOString();
    }
  }

  // Absolute ISO timestamp (or plain datetime accepted by Date parser)
  const ts = new Date(trimmed).getTime();
  if (Number.isFinite(ts)) {
    return new Date(ts).toISOString();
  }
  return null;
}

export interface TriggersModalProps {
  isOpen: boolean;
  session: SessionRecord;
  memberBots: BotConfig[];
  onClose: () => void;
  onAddToast: (type: 'success' | 'error' | 'info', message: string) => void;
}

export const TriggersModal: React.FC<TriggersModalProps> = ({
  isOpen,
  session,
  memberBots,
  onClose,
  onAddToast,
}) => {
  const [triggers, setTriggers] = useState<TriggerRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // New trigger form state
  const [showAddForm, setShowAddForm] = useState(false);
  const [name, setName] = useState('');
  const [botId, setBotId] = useState(session.leadBotId || memberBots[0]?.id || '');
  const [kind, setKind] = useState<TriggerKind>('webhook');
  const [cronExpr, setCronExpr] = useState('*/30 * * * *');
  const [runAtInput, setRunAtInput] = useState('15m');
  const [prompt, setPrompt] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Action loading state (toggling or deleting)
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

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

  useEffect(() => {
    if (isOpen) {
      fetchTriggers();
      setShowAddForm(false);
      setName('');
      setPrompt('');
      setKind('webhook');
      setCronExpr('*/30 * * * *');
      setRunAtInput('15m');
      setBotId(session.leadBotId || memberBots[0]?.id || '');
    }
  }, [isOpen, session.id]);

  if (!isOpen) return null;

  const handleCopy = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      onAddToast('success', `已复制 ${label}`);
    } catch {
      onAddToast('error', `复制 ${label} 失败，请手动复制`);
    }
  };

  const trimmedCron = cronExpr.trim();
  const isCronValid = Boolean(trimmedCron && isValidCronExpr(trimmedCron));
  let cronDescription = '';
  if (isCronValid) {
    try {
      cronDescription = describeCronExpr(trimmedCron);
    } catch {
      cronDescription = '';
    }
  }

  const parsedRunAt = kind === 'once' ? parseOnceRunAt(runAtInput) : null;
  const isRunAtValid = kind !== 'once' || Boolean(parsedRunAt);

  const handleCreateTrigger = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedName = name.trim();
    const trimmedPrompt = prompt.trim();

    if (!trimmedName) {
      setError('请输入触发器名称');
      return;
    }
    if (!trimmedPrompt) {
      setError('请输入触发指令或提示词');
      return;
    }
    if (!botId) {
      setError('请选择执行指令的智能体');
      return;
    }
    if (kind === 'cron') {
      if (!trimmedCron || !isCronValid) {
        setError('无效的 Cron 表达式（标准 5 段式：分 时 日 月 周）');
        return;
      }
    }
    if (kind === 'once') {
      if (!parsedRunAt) {
        setError('无效的延时或时间（支持 30s / 15m / 2h / 1d 或 ISO 时间）');
        return;
      }
    }

    const payload: CreateTriggerInput = {
      name: trimmedName,
      botId,
      kind,
      prompt: trimmedPrompt,
      enabled: true,
      ...(kind === 'cron' ? { cronExpr: trimmedCron } : {}),
      ...(kind === 'once' && parsedRunAt ? { runAt: parsedRunAt } : {}),
    };

    setSubmitting(true);
    setError(null);

    try {
      const created = await api.createSessionTrigger(session.id, payload);
      setTriggers((prev) => [created, ...prev]);
      setShowAddForm(false);
      setName('');
      setPrompt('');
      setCronExpr('*/30 * * * *');
      onAddToast('success', `触发器「${created.name}」已创建`);
    } catch (err: any) {
      setError(err?.message || '创建触发器失败');
    } finally {
      setSubmitting(false);
    }
  };

  const handleToggleEnabled = async (trigger: TriggerRecord) => {
    setTogglingId(trigger.id);
    try {
      const updated = await api.updateTrigger(trigger.id, { enabled: !trigger.enabled });
      setTriggers((prev) => prev.map((t) => (t.id === trigger.id ? updated : t)));
      onAddToast('success', `已${updated.enabled ? '启用' : '停用'}触发器「${trigger.name}」`);
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
      onAddToast('success', `已删除触发器「${trigger.name}」`);
    } catch (err: any) {
      onAddToast('error', err?.message || '删除触发器失败');
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/40 dark:bg-black/70 backdrop-blur-xs flex items-end sm:items-center justify-center p-0 sm:p-4 overflow-y-auto animate-in fade-in"
      role="dialog"
      aria-modal="true"
      aria-labelledby="triggers-modal-title"
    >
      <div className="bg-white dark:bg-zinc-950 rounded-t-2xl sm:rounded-2xl shadow-2xl border border-zinc-200/80 dark:border-zinc-800/80 w-full sm:max-w-2xl overflow-hidden flex flex-col max-h-[90dvh]">
        {/* Mobile handle */}
        <div className="w-10 h-1 bg-zinc-300 dark:bg-zinc-700 rounded-full mx-auto my-2 sm:hidden shrink-0" />

        {/* Header */}
        <div className="px-5 py-3.5 sm:px-6 sm:py-4 border-b border-zinc-100 dark:border-zinc-800/60 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2">
            <Zap className="w-4 h-4 text-amber-500 shrink-0" />
            <h2 id="triggers-modal-title" className="text-sm sm:text-base font-semibold text-zinc-900 dark:text-zinc-100">
              会话触发器与自动化
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

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-4">
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
                onClick={() => setShowAddForm(true)}
                className="h-8 px-2.5 text-xs font-medium rounded-lg bg-zinc-900 hover:bg-zinc-800 text-white dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white flex items-center gap-1.5 transition-colors cursor-pointer"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>新建触发器</span>
              </button>
            )}
          </div>

          {/* Create Form */}
          {showAddForm && (
            <form onSubmit={handleCreateTrigger} className="p-4 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50/70 dark:bg-zinc-900/40 space-y-3.5 animate-in fade-in">
              <div className="flex items-center justify-between border-b border-zinc-200/80 dark:border-zinc-800 pb-2.5">
                <span className="text-xs font-semibold text-zinc-900 dark:text-zinc-100">
                  新建触发器
                </span>
                <button
                  type="button"
                  onClick={() => setShowAddForm(false)}
                  className="text-xs text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200"
                >
                  取消
                </button>
              </div>

              {/* Kind selector */}
              <div>
                <label className="block text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-1.5">
                  触发器类型
                </label>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                  <button
                    type="button"
                    onClick={() => setKind('webhook')}
                    className={`h-8 px-2.5 text-xs font-medium rounded-lg border flex items-center justify-center gap-1.5 cursor-pointer transition-colors ${
                      kind === 'webhook'
                        ? 'bg-blue-50 dark:bg-blue-950/50 border-blue-400 dark:border-blue-700 text-blue-700 dark:text-blue-300'
                        : 'bg-white dark:bg-zinc-900 border-zinc-200 dark:border-zinc-800 text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800'
                    }`}
                  >
                    <Radio className="w-3.5 h-3.5 shrink-0" />
                    <span>Webhook</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => setKind('cron')}
                    className={`h-8 px-2.5 text-xs font-medium rounded-lg border flex items-center justify-center gap-1.5 cursor-pointer transition-colors ${
                      kind === 'cron'
                        ? 'bg-purple-50 dark:bg-purple-950/50 border-purple-400 dark:border-purple-700 text-purple-700 dark:text-purple-300'
                        : 'bg-white dark:bg-zinc-900 border-zinc-200 dark:border-zinc-800 text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800'
                    }`}
                  >
                    <Clock className="w-3.5 h-3.5 shrink-0" />
                    <span>Cron 定时</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => setKind('once')}
                    className={`h-8 px-2.5 text-xs font-medium rounded-lg border flex items-center justify-center gap-1.5 cursor-pointer transition-colors ${
                      kind === 'once'
                        ? 'bg-amber-50 dark:bg-amber-950/50 border-amber-400 dark:border-amber-700 text-amber-700 dark:text-amber-300'
                        : 'bg-white dark:bg-zinc-900 border-zinc-200 dark:border-zinc-800 text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800'
                    }`}
                  >
                    <Timer className="w-3.5 h-3.5 shrink-0" />
                    <span>一次性延时 (Once)</span>
                  </button>
                </div>
              </div>

              {/* Name & Bot */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label htmlFor="trigger-name" className="block text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-1">
                    触发器名称
                  </label>
                  <input
                    id="trigger-name"
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="例如：CI 构建通知 / 晨会提醒"
                    className="w-full h-8 px-2.5 text-xs bg-white dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 rounded-lg text-zinc-800 dark:text-zinc-100 placeholder:text-zinc-400 dark:placeholder:text-zinc-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
                    required
                  />
                </div>

                <div>
                  <label htmlFor="trigger-bot" className="block text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-1">
                    响应智能体
                  </label>
                  <select
                    id="trigger-bot"
                    value={botId}
                    onChange={(e) => setBotId(e.target.value)}
                    className="w-full h-8 px-2.5 text-xs bg-white dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 rounded-lg text-zinc-800 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    {memberBots.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.name} (@{b.id})
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Kind specific config */}
              {kind === 'cron' && (
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label htmlFor="trigger-cron" className="block text-xs font-medium text-zinc-700 dark:text-zinc-300">
                      Cron 表达式
                    </label>
                    <span className="text-[11px] text-zinc-400 dark:text-zinc-500 font-mono">
                      服务端本地时间
                    </span>
                  </div>
                  <input
                    id="trigger-cron"
                    type="text"
                    value={cronExpr}
                    onChange={(e) => setCronExpr(e.target.value)}
                    placeholder="*/30 * * * *"
                    className={`w-full h-8 px-2.5 text-xs font-mono bg-white dark:bg-zinc-900 border rounded-lg text-zinc-800 dark:text-zinc-100 placeholder:text-zinc-400 dark:placeholder:text-zinc-500 focus:outline-none focus:ring-2 ${
                      trimmedCron && !isCronValid
                        ? 'border-rose-400 dark:border-rose-600 focus:ring-rose-500'
                        : 'border-zinc-300 dark:border-zinc-700 focus:ring-blue-500'
                    }`}
                  />

                  {/* Validation message or live hint */}
                  {isCronValid ? (
                    <p className="text-[11px] text-emerald-600 dark:text-emerald-400 mt-1">
                      {cronDescription || '有效表达式'}
                    </p>
                  ) : (
                    <p className="text-[11px] text-rose-500 dark:text-rose-400 mt-1">
                      无效的 Cron 表达式（标准 5 段式：分 时 日 月 周）
                    </p>
                  )}

                  {/* Quick preset chips */}
                  <div className="flex flex-wrap items-center gap-1.5 mt-2">
                    <span className="text-[11px] text-zinc-400 dark:text-zinc-500 mr-0.5">常用预设:</span>
                    {CRON_PRESETS.map((preset) => (
                      <button
                        key={preset.expr}
                        type="button"
                        onClick={() => setCronExpr(preset.expr)}
                        className={`h-7 px-2 text-[11px] rounded-lg border transition-colors cursor-pointer flex items-center gap-1 ${
                          trimmedCron === preset.expr
                            ? 'bg-purple-50 dark:bg-purple-950/50 border-purple-300 dark:border-purple-700 text-purple-700 dark:text-purple-300 font-medium'
                            : 'bg-white dark:bg-zinc-900 border-zinc-200 dark:border-zinc-800 text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800'
                        }`}
                        title={`${preset.expr}（${preset.label}）`}
                      >
                        <span className="font-mono">{preset.expr}</span>
                        <span className="text-zinc-400 dark:text-zinc-500">（{preset.label}）</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {kind === 'webhook' && (
                <div className="text-[11px] text-zinc-500 dark:text-zinc-400 bg-white/60 dark:bg-zinc-900/60 p-2 rounded-lg border border-zinc-200 dark:border-zinc-800">
                  创建后将自动生成专属 Webhook Token 与调用 URL，支持在 CI/CD、监控告警或外部系统中通过 HTTP POST 触发。
                </div>
              )}

              {kind === 'once' && (
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label htmlFor="trigger-runat" className="block text-xs font-medium text-zinc-700 dark:text-zinc-300">
                      延时 / 目标时间
                    </label>
                    <span className="text-[11px] text-zinc-400 dark:text-zinc-500 font-mono">
                      相对延时或 ISO 时间
                    </span>
                  </div>
                  <input
                    id="trigger-runat"
                    type="text"
                    value={runAtInput}
                    onChange={(e) => setRunAtInput(e.target.value)}
                    placeholder="例如：30s、15m、2h、1d 或 2025-06-01T09:00:00"
                    className={`w-full h-8 px-2.5 text-xs font-mono bg-white dark:bg-zinc-900 border rounded-lg text-zinc-800 dark:text-zinc-100 placeholder:text-zinc-400 dark:placeholder:text-zinc-500 focus:outline-none focus:ring-2 ${
                      runAtInput.trim() && !parsedRunAt
                        ? 'border-rose-400 dark:border-rose-600 focus:ring-rose-500'
                        : 'border-zinc-300 dark:border-zinc-700 focus:ring-blue-500'
                    }`}
                  />

                  {runAtInput.trim() && !parsedRunAt ? (
                    <p className="text-[11px] text-rose-500 dark:text-rose-400 mt-1">
                      无效的延时或时间（支持 30s / 15m / 2h / 1d 或 ISO 时间）
                    </p>
                  ) : parsedRunAt ? (
                    <p className="text-[11px] text-emerald-600 dark:text-emerald-400 mt-1">
                      将于 {new Date(parsedRunAt).toLocaleString()} 触发（仅一次）
                    </p>
                  ) : null}

                  {/* Quick preset chips */}
                  <div className="flex flex-wrap items-center gap-1.5 mt-2">
                    <span className="text-[11px] text-zinc-400 dark:text-zinc-500 mr-0.5">常用预设:</span>
                    {ONCE_PRESETS.map((preset) => (
                      <button
                        key={preset.value}
                        type="button"
                        onClick={() => setRunAtInput(preset.value)}
                        className={`h-7 px-2 text-[11px] rounded-lg border transition-colors cursor-pointer flex items-center gap-1 ${
                          runAtInput.trim() === preset.value
                            ? 'bg-amber-50 dark:bg-amber-950/50 border-amber-300 dark:border-amber-700 text-amber-700 dark:text-amber-300 font-medium'
                            : 'bg-white dark:bg-zinc-900 border-zinc-200 dark:border-zinc-800 text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800'
                        }`}
                      >
                        <span className="font-mono">{preset.value}</span>
                        <span className="text-zinc-400 dark:text-zinc-500">（{preset.label}）</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Prompt textarea */}
              <div>
                <label htmlFor="trigger-prompt" className="block text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-1">
                  触发指令 / 提示词
                </label>
                <textarea
                  id="trigger-prompt"
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  rows={2}
                  placeholder={
                    kind === 'webhook'
                      ? '外部 Webhook 触发时的指令，Webhook 发送的 JSON 载荷将追加在指令后'
                      : kind === 'once'
                      ? '到时自动发送给智能体的指令，仅触发一次'
                      : '定时触发时发送给智能体的指令'
                  }
                  className="w-full p-2.5 text-xs bg-white dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 rounded-lg text-zinc-800 dark:text-zinc-100 placeholder:text-zinc-400 dark:placeholder:text-zinc-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  required
                />
              </div>

              {/* Submit button */}
              <div className="flex justify-end gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => setShowAddForm(false)}
                  className="h-8 px-2.5 text-xs font-medium rounded-lg text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 cursor-pointer"
                >
                  取消
                </button>
                <button
                  type="submit"
                  disabled={submitting || (kind === 'cron' && (!trimmedCron || !isCronValid)) || (kind === 'once' && !isRunAtValid)}
                  className="h-8 px-3 text-xs font-medium rounded-lg bg-blue-600 hover:bg-blue-700 disabled:bg-blue-300 dark:disabled:bg-blue-900/50 dark:disabled:text-blue-400/50 text-white flex items-center gap-1.5 transition-colors cursor-pointer disabled:cursor-not-allowed"
                >
                  {submitting && <Loader2 className="w-3.5 h-3.5 animate-spin-fast" />}
                  <span>保存触发器</span>
                </button>
              </div>
            </form>
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
                          {trigger.kind === 'once' && !trigger.enabled && trigger.lastTriggeredAt && (
                            <span className="px-1.5 py-0.5 rounded text-[11px] font-medium bg-emerald-50 dark:bg-emerald-950/50 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-900/60 shrink-0 inline-flex items-center gap-1">
                              <CheckCircle2 className="w-3 h-3" />
                              已触发完成
                            </span>
                          )}

                          <span className="font-semibold text-xs text-zinc-900 dark:text-zinc-100 truncate">
                            {trigger.name}
                          </span>

                          <span className="text-[11px] font-mono text-zinc-400 dark:text-zinc-500 shrink-0">
                            @{trigger.botId}
                          </span>
                        </div>

                        {trigger.kind === 'cron' && cronRawExpr && (
                          <div className="text-[11px] font-mono text-zinc-400 dark:text-zinc-500 mt-0.5">
                            {cronRawExpr}
                          </div>
                        )}
                        {trigger.kind === 'once' && (
                          <div className="text-[11px] text-zinc-400 dark:text-zinc-500 mt-0.5 flex items-center gap-1">
                            <Timer className="w-3 h-3" />
                            <span>一次性延时</span>
                            {trigger.runAt && (
                              <span className="font-mono">· {new Date(trigger.runAt).toLocaleString()}</span>
                            )}
                          </div>
                        )}
                      </div>

                      {/* Switch and delete button */}
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
                          <input
                            type="text"
                            readOnly
                            value={webhookUrl}
                            className="flex-1 h-8 px-2.5 text-[11px] font-mono bg-zinc-50 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg text-zinc-600 dark:text-zinc-400 select-all"
                          />
                          <button
                            type="button"
                            onClick={() => handleCopy(webhookUrl, 'Webhook URL')}
                            className="h-8 px-2.5 text-xs font-medium rounded-lg border border-zinc-200 dark:border-zinc-800 hover:bg-zinc-100 dark:hover:bg-zinc-800 text-zinc-700 dark:text-zinc-300 flex items-center gap-1 shrink-0 cursor-pointer"
                          >
                            <Copy className="w-3 h-3" />
                            <span>复制 URL</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => handleCopy(curlCmd, 'curl 命令')}
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
        </div>

        {/* Footer */}
        <div className="px-5 py-3 sm:px-6 sm:py-3.5 border-t border-zinc-100 dark:border-zinc-800/60 flex items-center justify-end">
          <button
            type="button"
            onClick={onClose}
            className="h-8 px-3 text-xs font-medium text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded-lg cursor-pointer"
          >
            完成
          </button>
        </div>
      </div>
    </div>
  );
};
