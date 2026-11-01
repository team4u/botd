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
  Pencil,
  Check,
  Send,
  Share2,
} from 'lucide-react';
import type {
  SessionRecord,
  BotConfig,
  TriggerRecord,
  TriggerKind,
  CreateTriggerInput,
  NotificationChannelRecord,
  NotificationChannelKind,
  NotificationEventKind,
} from '@botd/protocol';
import { isValidCronExpr, describeCronExpr } from '@botd/protocol';
import { api } from '../api';
import { copyText } from '../utils/clipboard';
import { ConfirmDialog } from './ConfirmDialog';

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

/** ISO 时间 → datetime-local 输入值（本地时区，分钟粒度） */
function isoToLocalDatetimeInput(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** datetime-local 输入值（本地时区）→ ISO 时间 */
function localDatetimeInputToIso(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const ts = new Date(trimmed).getTime();
  return Number.isFinite(ts) ? new Date(ts).toISOString() : null;
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
  const [activeTab, setActiveTab] = useState<'inbound' | 'outbound'>('inbound');

  const [triggers, setTriggers] = useState<TriggerRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Channels state
  const [channels, setChannels] = useState<NotificationChannelRecord[]>([]);
  const [channelsLoading, setChannelsLoading] = useState(false);
  const [showAddChannelForm, setShowAddChannelForm] = useState(false);
  const [channelName, setChannelName] = useState('');
  const [channelKind, setChannelKind] = useState<NotificationChannelKind>('feishu');
  const [channelTargetUrl, setChannelTargetUrl] = useState('');
  const [channelSecret, setChannelSecret] = useState('');
  const [channelEvents, setChannelEvents] = useState<NotificationEventKind[]>([
    'assistant_reply',
    'ask_request',
    'wakeup',
  ]);
  const [channelSubmitting, setChannelSubmitting] = useState(false);
  const [testingChannelId, setTestingChannelId] = useState<string | null>(null);
  const [togglingChannelId, setTogglingChannelId] = useState<string | null>(null);
  const [deletingChannelId, setDeletingChannelId] = useState<string | null>(null);

  // New trigger form state (also reused as edit form via editingTrigger)
  const [showAddForm, setShowAddForm] = useState(false);
  const [editingTrigger, setEditingTrigger] = useState<TriggerRecord | null>(null);
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

  // Run-now confirm dialog state
  const [runConfirmTrigger, setRunConfirmTrigger] = useState<TriggerRecord | null>(null);
  const [runningTrigger, setRunningTrigger] = useState(false);

  // Inline copy feedback for webhook URL (briefly swaps Copy icon for Check)
  const [copiedUrlId, setCopiedUrlId] = useState<string | null>(null);

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

  const fetchChannels = async () => {
    setChannelsLoading(true);
    try {
      const list = await api.listSessionChannels(session.id);
      setChannels(list);
    } catch (err: any) {
      onAddToast('error', err?.message || '获取出站通道失败');
    } finally {
      setChannelsLoading(false);
    }
  };

  const resetChannelForm = () => {
    setChannelName('');
    setChannelKind('feishu');
    setChannelTargetUrl('');
    setChannelSecret('');
    setChannelEvents(['assistant_reply', 'ask_request', 'wakeup']);
    setShowAddChannelForm(false);
  };

  const resetForm = () => {
    setName('');
    setPrompt('');
    setKind('webhook');
    setCronExpr('*/30 * * * *');
    setRunAtInput('15m');
    setBotId(session.leadBotId || memberBots[0]?.id || '');
  };

  useEffect(() => {
    if (isOpen) {
      fetchTriggers();
      fetchChannels();
      setShowAddForm(false);
      setShowAddChannelForm(false);
      setEditingTrigger(null);
      setRunConfirmTrigger(null);
      setCopiedUrlId(null);
      resetForm();
      resetChannelForm();
    }
  }, [isOpen, session.id]);

  if (!isOpen) return null;

  const handleCopy = async (text: string, label: string) => {
    const ok = await copyText(text);
    if (ok) {
      onAddToast('success', `已复制 ${label}`);
    } else {
      onAddToast('error', `复制 ${label} 失败，请手动复制`);
    }
  };

  const handleCopyUrl = async (triggerId: string, url: string) => {
    const ok = await copyText(url);
    if (ok) {
      setCopiedUrlId(triggerId);
      window.setTimeout(() => setCopiedUrlId((cur) => (cur === triggerId ? null : cur)), 1500);
    } else {
      onAddToast('error', '复制 Webhook URL 失败，请手动复制');
    }
  };

  const handleStartEdit = (trigger: TriggerRecord) => {
    setEditingTrigger(trigger);
    setError(null);
    setShowAddForm(true);
    setName(trigger.name);
    setBotId(trigger.botId);
    setKind(trigger.kind);
    setPrompt(trigger.prompt);
    setCronExpr(trigger.cronExpr || '*/30 * * * *');
    setRunAtInput(trigger.runAt ? isoToLocalDatetimeInput(trigger.runAt) : '');
  };

  const handleCancelEdit = () => {
    setEditingTrigger(null);
    resetForm();
    setShowAddForm(false);
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

  const isEditing = Boolean(editingTrigger);
  const parsedRunAt =
    kind === 'once' ? (isEditing ? localDatetimeInputToIso(runAtInput) : parseOnceRunAt(runAtInput)) : null;
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
      if (editingTrigger) {
        // kind/botId 不可变，仅提交可变字段
        const updated = await api.updateTrigger(editingTrigger.id, {
          name: trimmedName,
          prompt: trimmedPrompt,
          ...(kind === 'cron' ? { cronExpr: trimmedCron } : {}),
          ...(kind === 'once' && parsedRunAt ? { runAt: parsedRunAt } : {}),
        });
        setTriggers((prev) => prev.map((t) => (t.id === updated.id ? updated : t)));
        onAddToast('success', '触发器已更新');
      } else {
        const created = await api.createSessionTrigger(session.id, payload);
        setTriggers((prev) => [created, ...prev]);
        onAddToast('success', `触发器「${created.name}」已创建`);
      }
      setShowAddForm(false);
      setEditingTrigger(null);
      resetForm();
    } catch (err: any) {
      setError(err?.message || (editingTrigger ? '更新触发器失败' : '创建触发器失败'));
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
      if (editingTrigger?.id === trigger.id) handleCancelEdit();
      onAddToast('success', `已删除触发器「${trigger.name}」`);
    } catch (err: any) {
      onAddToast('error', err?.message || '删除触发器失败');
    } finally {
      setDeletingId(null);
    }
  };

  const handleCreateChannel = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedName = channelName.trim();
    const trimmedUrl = channelTargetUrl.trim();
    if (!trimmedName) {
      onAddToast('error', '请输入通道名称');
      return;
    }
    if (!trimmedUrl) {
      onAddToast('error', '请输入推送目标 URL');
      return;
    }
    if (channelEvents.length === 0) {
      onAddToast('error', '请至少勾选一个触发事件');
      return;
    }

    setChannelSubmitting(true);
    try {
      const created = await api.createSessionChannel(session.id, {
        name: trimmedName,
        kind: channelKind,
        targetUrl: trimmedUrl,
        secret: channelSecret.trim() || undefined,
        events: channelEvents,
        enabled: true,
      });
      setChannels((prev) => [...prev, created]);
      resetChannelForm();
      onAddToast('success', `出站通道「${created.name}」已创建`);
    } catch (err: any) {
      onAddToast('error', err?.message || '创建出站通道失败');
    } finally {
      setChannelSubmitting(false);
    }
  };

  const handleToggleChannel = async (channel: NotificationChannelRecord) => {
    setTogglingChannelId(channel.id);
    try {
      const updated = await api.updateChannel(channel.id, { enabled: !channel.enabled });
      setChannels((prev) => prev.map((c) => (c.id === channel.id ? updated : c)));
      onAddToast('success', `已${updated.enabled ? '启用' : '停用'}通道「${channel.name}」`);
    } catch (err: any) {
      onAddToast('error', err?.message || '更新通道状态失败');
    } finally {
      setTogglingChannelId(null);
    }
  };

  const handleTestChannel = async (channel: NotificationChannelRecord) => {
    setTestingChannelId(channel.id);
    try {
      const res = await api.testChannel(channel.id);
      if (res.ok) {
        setChannels((prev) =>
          prev.map((c) =>
            c.id === channel.id ? { ...c, lastTriggeredAt: new Date().toISOString() } : c
          )
        );
        onAddToast('success', `通道「${channel.name}」测试通知发送成功`);
      }
    } catch (err: any) {
      onAddToast('error', err?.message || '测试通知发送失败');
    } finally {
      setTestingChannelId(null);
    }
  };

  const handleDeleteChannel = async (channel: NotificationChannelRecord) => {
    if (!window.confirm(`确认删除外部通知通道「${channel.name}」吗？`)) return;
    setDeletingChannelId(channel.id);
    try {
      await api.deleteChannel(channel.id);
      setChannels((prev) => prev.filter((c) => c.id !== channel.id));
      onAddToast('success', `已删除通道「${channel.name}」`);
    } catch (err: any) {
      onAddToast('error', err?.message || '删除通道失败');
    } finally {
      setDeletingChannelId(null);
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
        <div className="px-5 py-3 sm:px-6 sm:py-3.5 border-b border-zinc-100 dark:border-zinc-800/60 flex items-center justify-between shrink-0 flex-wrap gap-2">
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2">
              <Zap className="w-4 h-4 text-amber-500 shrink-0" />
              <h2 id="triggers-modal-title" className="text-sm sm:text-base font-semibold text-zinc-900 dark:text-zinc-100">
                自动化与消息桥接
              </h2>
            </div>

            {/* Tabs */}
            <div className="flex items-center bg-zinc-100 dark:bg-zinc-800/70 p-0.5 rounded-lg text-xs font-medium">
              <button
                type="button"
                onClick={() => setActiveTab('inbound')}
                className={`h-7 px-2.5 rounded-md transition-colors cursor-pointer flex items-center gap-1.5 ${
                  activeTab === 'inbound'
                    ? 'bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 shadow-xs'
                    : 'text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200'
                }`}
              >
                <Radio className="w-3 h-3" />
                <span>入站触发器 (Webhook / 定时)</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setActiveTab('outbound');
                  fetchChannels();
                }}
                className={`h-7 px-2.5 rounded-md transition-colors cursor-pointer flex items-center gap-1.5 ${
                  activeTab === 'outbound'
                    ? 'bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 shadow-xs'
                    : 'text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200'
                }`}
              >
                <Share2 className="w-3 h-3" />
                <span>出站消息桥接 (飞书 / Slack / TG / Webhook)</span>
              </button>
            </div>
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

          {activeTab === 'inbound' ? (
            <div className="space-y-4 animate-in fade-in">
              {/* Action bar: Add Trigger button */}
              <div className="flex items-center justify-between">
                <span className="text-xs text-zinc-500 dark:text-zinc-400">
                  共配置 {triggers.length} 个自动化触发器
                </span>
                {!showAddForm && (
                  <button
                    type="button"
                    onClick={() => {
                      setEditingTrigger(null);
                      resetForm();
                      setShowAddForm(true);
                    }}
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
                  {isEditing ? '编辑触发器' : '新建触发器'}
                </span>
                <button
                  type="button"
                  onClick={handleCancelEdit}
                  className="text-xs text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200"
                >
                  {isEditing ? '取消编辑' : '取消'}
                </button>
              </div>

              {/* Kind selector (readonly badge when editing) */}
              {isEditing ? (
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium text-zinc-700 dark:text-zinc-300">类型</span>
                  <span
                    className={`px-1.5 py-0.5 rounded text-[11px] font-medium border shrink-0 ${
                      editingTrigger?.kind === 'webhook'
                        ? 'bg-blue-50 dark:bg-blue-950/50 text-blue-700 dark:text-blue-300 border-blue-200 dark:border-blue-900/60'
                        : editingTrigger?.kind === 'cron'
                        ? 'bg-purple-50 dark:bg-purple-950/50 text-purple-700 dark:text-purple-300 border-purple-200 dark:border-purple-900/60'
                        : 'bg-amber-50 dark:bg-amber-950/50 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-900/60'
                    }`}
                  >
                    {editingTrigger?.kind === 'webhook'
                      ? 'Webhook'
                      : editingTrigger?.kind === 'cron'
                      ? 'Cron 定时'
                      : '一次性延时 (Once)'}
                  </span>
                  <span className="text-[11px] text-zinc-400 dark:text-zinc-500">创建后不可修改</span>
                </div>
              ) : (
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
              )}

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
                    {isEditing && (
                      <span className="ml-1.5 text-[11px] font-normal text-zinc-400 dark:text-zinc-500">创建后不可修改</span>
                    )}
                  </label>
                  <select
                    id="trigger-bot"
                    value={botId}
                    onChange={(e) => setBotId(e.target.value)}
                    disabled={isEditing}
                    className="w-full h-8 px-2.5 text-xs bg-white dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 rounded-lg text-zinc-800 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-60 disabled:cursor-not-allowed"
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
                      {isEditing ? '本地时间' : '相对延时或 ISO 时间'}
                    </span>
                  </div>
                  <input
                    id="trigger-runat"
                    type={isEditing ? 'datetime-local' : 'text'}
                    value={runAtInput}
                    onChange={(e) => setRunAtInput(e.target.value)}
                    placeholder={
                      isEditing
                        ? undefined
                        : '例如：30s、15m、2h、1d 或 2025-06-01T09:00:00'
                    }
                    step={60}
                    className={`w-full h-8 px-2.5 text-xs font-mono bg-white dark:bg-zinc-900 border rounded-lg text-zinc-800 dark:text-zinc-100 placeholder:text-zinc-400 dark:placeholder:text-zinc-500 focus:outline-none focus:ring-2 ${
                      runAtInput.trim() && !parsedRunAt
                        ? 'border-rose-400 dark:border-rose-600 focus:ring-rose-500'
                        : 'border-zinc-300 dark:border-zinc-700 focus:ring-blue-500'
                    }`}
                  />

                  {isEditing ? (
                    parsedRunAt ? (
                      <p className="text-[11px] text-emerald-600 dark:text-emerald-400 mt-1">
                        将于 {new Date(parsedRunAt).toLocaleString()} 触发（仅一次）
                      </p>
                    ) : null
                  ) : runAtInput.trim() && !parsedRunAt ? (
                    <p className="text-[11px] text-rose-500 dark:text-rose-400 mt-1">
                      无效的延时或时间（支持 30s / 15m / 2h / 1d 或 ISO 时间）
                    </p>
                  ) : parsedRunAt ? (
                    <p className="text-[11px] text-emerald-600 dark:text-emerald-400 mt-1">
                      将于 {new Date(parsedRunAt).toLocaleString()} 触发（仅一次）
                    </p>
                  ) : null}

                  {/* Quick preset chips (new mode only) */}
                  {!isEditing && (
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
                  )}
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
                  onClick={handleCancelEdit}
                  className="h-8 px-2.5 text-xs font-medium rounded-lg text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 cursor-pointer"
                >
                  {isEditing ? '取消编辑' : '取消'}
                </button>
                <button
                  type="submit"
                  disabled={submitting || (kind === 'cron' && (!trimmedCron || !isCronValid)) || (kind === 'once' && !isRunAtValid)}
                  className="h-8 px-3 text-xs font-medium rounded-lg bg-blue-600 hover:bg-blue-700 disabled:bg-blue-300 dark:disabled:bg-blue-900/50 dark:disabled:text-blue-400/50 text-white flex items-center gap-1.5 transition-colors cursor-pointer disabled:cursor-not-allowed"
                >
                  {submitting && <Loader2 className="w-3.5 h-3.5 animate-spin-fast" />}
                  <span>{isEditing ? '保存修改' : '保存触发器'}</span>
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
                            onClick={() => handleCopyUrl(trigger.id, webhookUrl)}
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
          ) : (
            <div className="space-y-4 animate-in fade-in">
              {/* Action bar: Add Channel button */}
              <div className="flex items-center justify-between">
                <span className="text-xs text-zinc-500 dark:text-zinc-400">
                  共配置 {channels.length} 个外部消息通道
                </span>
                {!showAddChannelForm && (
                  <button
                    type="button"
                    onClick={() => {
                      resetChannelForm();
                      setShowAddChannelForm(true);
                    }}
                    className="h-8 px-2.5 text-xs font-medium rounded-lg bg-zinc-900 hover:bg-zinc-800 text-white dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white flex items-center gap-1.5 transition-colors cursor-pointer"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    <span>新建出站通道</span>
                  </button>
                )}
              </div>

              {/* Create Channel Form */}
              {showAddChannelForm && (
                <form onSubmit={handleCreateChannel} className="p-4 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-zinc-50/70 dark:bg-zinc-900/40 space-y-3.5 animate-in fade-in">
                  <div className="flex items-center justify-between border-b border-zinc-200/80 dark:border-zinc-800 pb-2.5">
                    <span className="text-xs font-semibold text-zinc-900 dark:text-zinc-100">
                      新建出站消息通道
                    </span>
                    <button
                      type="button"
                      onClick={() => setShowAddChannelForm(false)}
                      className="text-xs text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200 cursor-pointer"
                    >
                      取消
                    </button>
                  </div>

                  {/* Channel Kind selector */}
                  <div>
                    <label className="block text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-1.5">
                      通道类型
                    </label>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                      <button
                        type="button"
                        onClick={() => setChannelKind('feishu')}
                        className={`h-8 px-2.5 text-xs font-medium rounded-lg border flex items-center justify-center gap-1.5 cursor-pointer transition-colors ${
                          channelKind === 'feishu'
                            ? 'bg-blue-50 dark:bg-blue-950/50 border-blue-400 dark:border-blue-700 text-blue-700 dark:text-blue-300'
                            : 'bg-white dark:bg-zinc-900 border-zinc-200 dark:border-zinc-800 text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800'
                        }`}
                      >
                        <span>飞书机器人</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => setChannelKind('slack')}
                        className={`h-8 px-2.5 text-xs font-medium rounded-lg border flex items-center justify-center gap-1.5 cursor-pointer transition-colors ${
                          channelKind === 'slack'
                            ? 'bg-purple-50 dark:bg-purple-950/50 border-purple-400 dark:border-purple-700 text-purple-700 dark:text-purple-300'
                            : 'bg-white dark:bg-zinc-900 border-zinc-200 dark:border-zinc-800 text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800'
                        }`}
                      >
                        <span>Slack</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => setChannelKind('telegram')}
                        className={`h-8 px-2.5 text-xs font-medium rounded-lg border flex items-center justify-center gap-1.5 cursor-pointer transition-colors ${
                          channelKind === 'telegram'
                            ? 'bg-sky-50 dark:bg-sky-950/50 border-sky-400 dark:border-sky-700 text-sky-700 dark:text-sky-300'
                            : 'bg-white dark:bg-zinc-900 border-zinc-200 dark:border-zinc-800 text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800'
                        }`}
                      >
                        <span>Telegram</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => setChannelKind('webhook')}
                        className={`h-8 px-2.5 text-xs font-medium rounded-lg border flex items-center justify-center gap-1.5 cursor-pointer transition-colors ${
                          channelKind === 'webhook'
                            ? 'bg-emerald-50 dark:bg-emerald-950/50 border-emerald-400 dark:border-emerald-700 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-900/60 text-emerald-700'
                            : 'bg-white dark:bg-zinc-900 border-zinc-200 dark:border-zinc-800 text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800'
                        }`}
                      >
                        <span>通用 Webhook</span>
                      </button>
                    </div>
                  </div>

                  {/* Channel Name */}
                  <div>
                    <label htmlFor="channel-name" className="block text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-1">
                      通道名称
                    </label>
                    <input
                      id="channel-name"
                      type="text"
                      value={channelName}
                      onChange={(e) => setChannelName(e.target.value)}
                      placeholder="例如：开发团队飞书群 / 生产告警"
                      className="w-full h-8 px-2.5 text-xs bg-white dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 rounded-lg text-zinc-800 dark:text-zinc-100 placeholder:text-zinc-400 dark:placeholder:text-zinc-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
                      required
                    />
                  </div>

                  {/* Target URL */}
                  <div>
                    <label htmlFor="channel-target-url" className="block text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-1">
                      目标 Webhook URL
                    </label>
                    <input
                      id="channel-target-url"
                      type="url"
                      value={channelTargetUrl}
                      onChange={(e) => setChannelTargetUrl(e.target.value)}
                      placeholder={
                        channelKind === 'feishu'
                          ? 'https://open.feishu.cn/open-apis/bot/v2/hook/xxx'
                          : channelKind === 'slack'
                          ? 'https://hooks.slack.com/services/xxx/xxx/xxx'
                          : channelKind === 'telegram'
                          ? 'https://api.telegram.org/bot<TOKEN>/sendMessage?chat_id=<CHAT_ID>'
                          : 'https://your-domain.com/api/botd-webhook'
                      }
                      className="w-full h-8 px-2.5 text-xs bg-white dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 rounded-lg text-zinc-800 dark:text-zinc-100 placeholder:text-zinc-400 dark:placeholder:text-zinc-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
                      required
                    />
                  </div>

                  {/* Secret (Webhook only or optional) */}
                  {channelKind === 'webhook' && (
                    <div>
                      <div className="flex items-center justify-between mb-1">
                        <label htmlFor="channel-secret" className="block text-xs font-medium text-zinc-700 dark:text-zinc-300">
                          签名密钥 Secret (选填)
                        </label>
                        <span className="text-[11px] text-zinc-400 dark:text-zinc-500">
                          带 X-Botd-Signature: sha256=... 验签头
                        </span>
                      </div>
                      <input
                        id="channel-secret"
                        type="password"
                        value={channelSecret}
                        onChange={(e) => setChannelSecret(e.target.value)}
                        placeholder="选填，用于计算 HMAC-SHA256 签名"
                        className="w-full h-8 px-2.5 text-xs bg-white dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 rounded-lg text-zinc-800 dark:text-zinc-100 placeholder:text-zinc-400 dark:placeholder:text-zinc-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
                      />
                    </div>
                  )}

                  {/* Trigger Events */}
                  <div>
                    <label className="block text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-1.5">
                      触发事件（多选）
                    </label>
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                      <label className="flex items-center gap-2 text-xs text-zinc-700 dark:text-zinc-300 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg p-2 cursor-pointer hover:bg-zinc-50 dark:hover:bg-zinc-800/50">
                        <input
                          type="checkbox"
                          checked={channelEvents.includes('assistant_reply')}
                          onChange={(e) => {
                            if (e.target.checked) {
                              setChannelEvents((prev) => [...prev, 'assistant_reply']);
                            } else {
                              setChannelEvents((prev) => prev.filter((k) => k !== 'assistant_reply'));
                            }
                          }}
                          className="rounded text-blue-600 focus:ring-blue-500"
                        />
                        <div>
                          <div className="font-medium text-xs">智能体回复</div>
                          <div className="text-[11px] text-zinc-400">大模型生成回合响应</div>
                        </div>
                      </label>

                      <label className="flex items-center gap-2 text-xs text-zinc-700 dark:text-zinc-300 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg p-2 cursor-pointer hover:bg-zinc-50 dark:hover:bg-zinc-800/50">
                        <input
                          type="checkbox"
                          checked={channelEvents.includes('ask_request')}
                          onChange={(e) => {
                            if (e.target.checked) {
                              setChannelEvents((prev) => [...prev, 'ask_request']);
                            } else {
                              setChannelEvents((prev) => prev.filter((k) => k !== 'ask_request'));
                            }
                          }}
                          className="rounded text-blue-600 focus:ring-blue-500"
                        />
                        <div>
                          <div className="font-medium text-xs">botd ask 确认</div>
                          <div className="text-[11px] text-zinc-400">手机免登录一键点击回调</div>
                        </div>
                      </label>

                      <label className="flex items-center gap-2 text-xs text-zinc-700 dark:text-zinc-300 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg p-2 cursor-pointer hover:bg-zinc-50 dark:hover:bg-zinc-800/50">
                        <input
                          type="checkbox"
                          checked={channelEvents.includes('wakeup')}
                          onChange={(e) => {
                            if (e.target.checked) {
                              setChannelEvents((prev) => [...prev, 'wakeup']);
                            } else {
                              setChannelEvents((prev) => prev.filter((k) => k !== 'wakeup'));
                            }
                          }}
                          className="rounded text-blue-600 focus:ring-blue-500"
                        />
                        <div>
                          <div className="font-medium text-xs">异步唤醒</div>
                          <div className="text-[11px] text-zinc-400">外部触发或定时唤醒</div>
                        </div>
                      </label>
                    </div>
                  </div>

                  {/* Form Actions */}
                  <div className="flex items-center justify-end gap-2 pt-2 border-t border-zinc-200/80 dark:border-zinc-800">
                    <button
                      type="button"
                      onClick={() => setShowAddChannelForm(false)}
                      className="h-8 px-2.5 text-xs font-medium text-zinc-600 dark:text-zinc-400 hover:bg-zinc-200/60 dark:hover:bg-zinc-800 rounded-lg cursor-pointer"
                    >
                      取消
                    </button>
                    <button
                      type="submit"
                      disabled={channelSubmitting}
                      className="h-8 px-2.5 text-xs font-medium bg-blue-600 hover:bg-blue-700 text-white rounded-lg flex items-center gap-1.5 transition-colors cursor-pointer disabled:opacity-50"
                    >
                      {channelSubmitting ? (
                        <>
                          <Loader2 className="w-3.5 h-3.5 animate-spin-fast" />
                          <span>创建中...</span>
                        </>
                      ) : (
                        <span>创建通道</span>
                      )}
                    </button>
                  </div>
                </form>
              )}

              {/* Channels List */}
              {channelsLoading && channels.length === 0 ? (
                <div className="py-12 flex flex-col items-center justify-center text-zinc-400 gap-2">
                  <Loader2 className="w-6 h-6 animate-spin-fast text-zinc-500" />
                  <span className="text-xs">加载出站通道...</span>
                </div>
              ) : channels.length === 0 ? (
                <div className="py-12 text-center border-2 border-dashed border-zinc-200 dark:border-zinc-800 rounded-lg">
                  <Send className="w-8 h-8 text-zinc-300 dark:text-zinc-700 mx-auto mb-2" />
                  <p className="text-xs font-medium text-zinc-600 dark:text-zinc-400">暂无出站消息通道</p>
                  <p className="text-[11px] text-zinc-400 dark:text-zinc-500 mt-1 max-w-sm mx-auto">
                    支持将智能体回复、交互确认与唤醒通知推送到飞书群、Slack、Telegram 或内部系统。
                  </p>
                </div>
              ) : (
                <div className="space-y-3">
                  {channels.map((ch) => {
                    const isTesting = testingChannelId === ch.id;
                    const isToggling = togglingChannelId === ch.id;
                    const isDeleting = deletingChannelId === ch.id;

                    const kindLabel =
                      ch.kind === 'feishu'
                        ? '飞书机器人'
                        : ch.kind === 'slack'
                        ? 'Slack'
                        : ch.kind === 'telegram'
                        ? 'Telegram'
                        : 'Webhook';

                    const kindColor =
                      ch.kind === 'feishu'
                        ? 'bg-blue-50 dark:bg-blue-950/50 text-blue-700 dark:text-blue-300 border-blue-200 dark:border-blue-900/60'
                        : ch.kind === 'slack'
                        ? 'bg-purple-50 dark:bg-purple-950/50 text-purple-700 dark:text-purple-300 border-purple-200 dark:border-purple-900/60'
                        : ch.kind === 'telegram'
                        ? 'bg-sky-50 dark:bg-sky-950/50 text-sky-700 dark:text-sky-300 border-sky-200 dark:border-sky-900/60'
                        : 'bg-emerald-50 dark:bg-emerald-950/50 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-900/60';

                    return (
                      <div
                        key={ch.id}
                        className={`p-3.5 rounded-lg border transition-all ${
                          ch.enabled
                            ? 'bg-white dark:bg-zinc-900/90 border-zinc-200 dark:border-zinc-800'
                            : 'bg-zinc-50 dark:bg-zinc-900/40 border-zinc-200/60 dark:border-zinc-800/40 opacity-70'
                        }`}
                      >
                        {/* Header: Badge, Name, Controls */}
                        <div className="flex items-center justify-between gap-2 mb-2">
                          <div className="flex items-center gap-2 min-w-0">
                            <span className={`px-1.5 py-0.5 rounded text-[11px] font-medium border shrink-0 ${kindColor}`}>
                              {kindLabel}
                            </span>
                            <span className="font-semibold text-xs text-zinc-900 dark:text-zinc-100 truncate">
                              {ch.name}
                            </span>
                          </div>

                          <div className="flex items-center gap-1.5 shrink-0">
                            {/* Enable/Disable toggle */}
                            <button
                              type="button"
                              onClick={() => handleToggleChannel(ch)}
                              disabled={isToggling}
                              className={`h-7 px-2 text-[11px] font-medium rounded-lg border transition-colors cursor-pointer ${
                                ch.enabled
                                  ? 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800/60 hover:bg-emerald-100 dark:hover:bg-emerald-900/50'
                                  : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-500 dark:text-zinc-400 border-zinc-200 dark:border-zinc-700 hover:bg-zinc-200 dark:hover:bg-zinc-700'
                              }`}
                              title={ch.enabled ? '点击停用' : '点击启用'}
                            >
                              {isToggling ? (
                                <Loader2 className="w-3 h-3 animate-spin-fast" />
                              ) : ch.enabled ? (
                                '已启用'
                              ) : (
                                '已停用'
                              )}
                            </button>

                            {/* Test Push button */}
                            <button
                              type="button"
                              onClick={() => handleTestChannel(ch)}
                              disabled={isTesting}
                              className="h-7 px-2 text-[11px] font-medium rounded-lg border border-zinc-200 dark:border-zinc-800 text-zinc-600 dark:text-zinc-400 hover:text-blue-600 dark:hover:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-950/50 transition-colors cursor-pointer flex items-center gap-1"
                              title="向目标 URL 发送一条测试消息"
                            >
                              {isTesting ? (
                                <Loader2 className="w-3 h-3 animate-spin-fast text-blue-500" />
                              ) : (
                                <Send className="w-3 h-3" />
                              )}
                              <span>测试推送</span>
                            </button>

                            {/* Delete button */}
                            <button
                              type="button"
                              onClick={() => handleDeleteChannel(ch)}
                              disabled={isDeleting}
                              className="p-1.5 text-zinc-400 hover:text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/50 rounded-lg transition-colors cursor-pointer disabled:opacity-40"
                              title="删除通道"
                            >
                              {isDeleting ? (
                                <Loader2 className="w-3.5 h-3.5 animate-spin-fast text-rose-500" />
                              ) : (
                                <Trash2 className="w-3.5 h-3.5" />
                              )}
                            </button>
                          </div>
                        </div>

                        {/* URL row */}
                        <div className="flex items-center gap-1.5 mb-2">
                          <span
                            className="flex-1 min-w-0 h-7 px-2 text-[11px] font-mono bg-zinc-50 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg text-zinc-500 dark:text-zinc-400 truncate flex items-center select-all"
                            title={ch.targetUrl}
                          >
                            {ch.targetUrl}
                          </span>
                          <button
                            type="button"
                            onClick={() => handleCopyUrl(ch.id, ch.targetUrl)}
                            className="h-7 w-7 rounded-lg border border-zinc-200 dark:border-zinc-800 hover:bg-zinc-100 dark:hover:bg-zinc-800 text-zinc-500 dark:text-zinc-400 flex items-center justify-center shrink-0 cursor-pointer"
                            title={copiedUrlId === ch.id ? '已复制' : '复制目标 URL'}
                          >
                            {copiedUrlId === ch.id ? (
                              <Check className="w-3 h-3 text-emerald-500" />
                            ) : (
                              <Copy className="w-3 h-3" />
                            )}
                          </button>
                        </div>

                        {/* Events and status */}
                        <div className="flex items-center justify-between gap-2 pt-2 border-t border-zinc-100 dark:border-zinc-800/60 text-[11px] flex-wrap">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <span className="text-zinc-400">推送事件:</span>
                            {ch.events.map((ev) => (
                              <span
                                key={ev}
                                className="px-1.5 py-0.5 rounded bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 font-medium"
                              >
                                {ev === 'assistant_reply'
                                  ? '智能体回复'
                                  : ev === 'ask_request'
                                  ? 'botd ask 交互'
                                  : '异步唤醒'}
                              </span>
                            ))}
                          </div>

                          {ch.lastTriggeredAt && (
                            <div className="text-zinc-400 dark:text-zinc-500 flex items-center gap-1">
                              <Clock className="w-3 h-3" />
                              <span>上次推送: {new Date(ch.lastTriggeredAt).toLocaleString()}</span>
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
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
