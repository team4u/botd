import React, { useEffect, useState } from 'react';
import {
  Plus,
  Trash2,
  Copy,
  Loader2,
  Check,
  Send,
  Clock,
  BellRing,
  BellOff,
} from 'lucide-react';
import type {
  SessionRecord,
  NotificationChannelRecord,
  NotificationTellPolicy,
} from '@botd/protocol';
import { api } from '../../api';
import { OutboxSection } from './OutboxSection';
import { ChannelForm } from './ChannelForm';
import { useUrlCopy, TELL_POLICY_LABELS, type AddToastFn } from './shared';

export interface ChannelsTabProps {
  /** 当前 Tab 是否激活（常驻挂载保留状态，非激活时不渲染） */
  visible: boolean;
  session: SessionRecord;
  onAddToast: AddToastFn;
}

export const ChannelsTab: React.FC<ChannelsTabProps> = ({ visible, session, onAddToast }) => {
  const [channels, setChannels] = useState<NotificationChannelRecord[]>([]);
  const [channelsLoading, setChannelsLoading] = useState(false);
  const [showAddChannelForm, setShowAddChannelForm] = useState(false);
  const [testingChannelId, setTestingChannelId] = useState<string | null>(null);
  const [togglingChannelId, setTogglingChannelId] = useState<string | null>(null);
  const [deletingChannelId, setDeletingChannelId] = useState<string | null>(null);

  const { copiedUrlId, copyUrl } = useUrlCopy(onAddToast);

  // 弹窗打开时随组件挂载拉取最新列表
  useEffect(() => {
    fetchChannels();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id]);

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

  const handleToggleChannel = async (channel: NotificationChannelRecord) => {
    setTogglingChannelId(channel.id);
    try {
      const updated = await api.updateChannel(channel.id, { enabled: !channel.enabled });
      setChannels((prev) => prev.map((c) => (c.id === channel.id ? updated : c)));
    } catch (err: any) {
      onAddToast('error', err?.message || '更新通道状态失败');
    } finally {
      setTogglingChannelId(null);
    }
  };

  const handleCycleTellPolicy = async (channel: NotificationChannelRecord) => {
    const order: NotificationTellPolicy[] = ['needed', 'always', 'never'];
    const current = channel.tellPolicy || 'always';
    const next = order[(order.indexOf(current) + 1) % order.length];
    setTogglingChannelId(channel.id);
    try {
      const updated = await api.updateChannel(channel.id, { tellPolicy: next });
      setChannels((prev) => prev.map((c) => (c.id === channel.id ? updated : c)));
    } catch (err: any) {
      onAddToast('error', err?.message || '更新通知策略失败');
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

  if (!visible) return null;

  return (
    <div className="space-y-4 animate-in fade-in">
      {/* Action bar: Add Channel button */}
      <div className="flex items-center justify-between">
        <span className="text-xs text-zinc-500 dark:text-zinc-400">
          共配置 {channels.length} 个外部消息通道
        </span>
        {!showAddChannelForm && (
          <button
            type="button"
            onClick={() => setShowAddChannelForm(true)}
            className="h-8 px-2.5 text-xs font-medium rounded-lg bg-zinc-900 hover:bg-zinc-800 text-white dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white flex items-center gap-1.5 transition-colors cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>新建出站通道</span>
          </button>
        )}
      </div>

      {/* Create Channel Form */}
      {showAddChannelForm && (
        <ChannelForm
          session={session}
          onAddToast={onAddToast}
          onClose={() => setShowAddChannelForm(false)}
          onCreated={(created) => {
            setChannels((prev) => [...prev, created]);
            setShowAddChannelForm(false);
          }}
        />
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
                  <div className="flex items-center gap-2 min-w-0 flex-wrap">
                    <span className={`px-1.5 py-0.5 rounded text-[11px] font-medium border shrink-0 ${kindColor}`}>
                      {kindLabel}
                    </span>
                    <button
                      type="button"
                      onClick={() => handleCycleTellPolicy(ch)}
                      disabled={isToggling}
                      className={`h-7 px-2 text-[11px] font-medium rounded-lg border transition-colors cursor-pointer inline-flex items-center gap-1 disabled:opacity-50 shrink-0 ${
                        (ch.tellPolicy || 'always') === 'needed'
                          ? 'bg-blue-50 dark:bg-blue-950/50 text-blue-700 dark:text-blue-300 border-blue-200 dark:border-blue-900/60 hover:bg-blue-100 dark:hover:bg-blue-900/50'
                          : (ch.tellPolicy || 'always') === 'always'
                          ? 'bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 border-zinc-200 dark:border-zinc-700 hover:bg-zinc-200 dark:hover:bg-zinc-700'
                          : 'bg-zinc-50 dark:bg-zinc-950/60 text-zinc-500 dark:text-zinc-400 border-zinc-200 dark:border-zinc-800 hover:bg-zinc-100 dark:hover:bg-zinc-900'
                      }`}
                      title={`当前策略：${TELL_POLICY_LABELS[ch.tellPolicy || 'always']}，点击切换（按需 → 全部 → 静默）`}
                    >
                      {isToggling ? (
                        <Loader2 className="w-3 h-3 animate-spin-fast" />
                      ) : (ch.tellPolicy || 'always') === 'needed' ? (
                        <BellRing className="w-3 h-3" />
                      ) : (ch.tellPolicy || 'always') === 'never' ? (
                        <BellOff className="w-3 h-3" />
                      ) : null}
                      {TELL_POLICY_LABELS[ch.tellPolicy || 'always']}
                    </button>
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
                    onClick={() => copyUrl(ch.id, ch.targetUrl)}
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

      {/* Outbox：最近通知投递记录 */}
      <OutboxSection sessionId={session.id} onAddToast={onAddToast} />
    </div>
  );
};
