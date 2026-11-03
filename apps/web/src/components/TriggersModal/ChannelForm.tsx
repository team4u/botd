import React, { useState } from 'react';
import { Loader2, Send, BellRing, BellOff } from 'lucide-react';
import type {
  NotificationChannelKind,
  NotificationEventKind,
  NotificationTellPolicy,
  SessionRecord,
  NotificationChannelRecord,
} from '@botd/protocol';
import { api } from '../../api';
import type { AddToastFn } from './shared';

export interface ChannelFormProps {
  session: SessionRecord;
  onAddToast: AddToastFn;
  onClose: () => void;
  onCreated: (channel: NotificationChannelRecord) => void;
}

const DEFAULT_EVENTS: NotificationEventKind[] = ['assistant_reply', 'ask_request', 'wakeup'];

/** 新建出站消息通道表单（挂载即全新状态，关闭即卸载重置） */
export const ChannelForm: React.FC<ChannelFormProps> = ({ session, onAddToast, onClose, onCreated }) => {
  const [channelName, setChannelName] = useState('');
  const [channelKind, setChannelKind] = useState<NotificationChannelKind>('feishu');
  const [channelTargetUrl, setChannelTargetUrl] = useState('');
  const [channelSecret, setChannelSecret] = useState('');
  const [channelEvents, setChannelEvents] = useState<NotificationEventKind[]>([...DEFAULT_EVENTS]);
  const [channelTellPolicy, setChannelTellPolicy] = useState<NotificationTellPolicy>('needed');
  const [channelSubmitting, setChannelSubmitting] = useState(false);

  const toggleChannelEvent = (eventKind: NotificationEventKind, checked: boolean) => {
    setChannelEvents((prev) =>
      checked ? [...prev, eventKind] : prev.filter((k) => k !== eventKind)
    );
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
        tellPolicy: channelTellPolicy,
        enabled: true,
      });
      onAddToast('success', `出站通道「${created.name}」已创建`);
      onCreated(created);
    } catch (err: any) {
      onAddToast('error', err?.message || '创建出站通道失败');
    } finally {
      setChannelSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleCreateChannel} className="p-4 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-zinc-50/70 dark:bg-zinc-900/40 space-y-3.5 animate-in fade-in">
      <div className="flex items-center justify-between border-b border-zinc-200/80 dark:border-zinc-800 pb-2.5">
        <span className="text-xs font-semibold text-zinc-900 dark:text-zinc-100">
          新建出站消息通道
        </span>
        <button
          type="button"
          onClick={onClose}
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
              onChange={(e) => toggleChannelEvent('assistant_reply', e.target.checked)}
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
              onChange={(e) => toggleChannelEvent('ask_request', e.target.checked)}
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
              onChange={(e) => toggleChannelEvent('wakeup', e.target.checked)}
              className="rounded text-blue-600 focus:ring-blue-500"
            />
            <div>
              <div className="font-medium text-xs">异步唤醒</div>
              <div className="text-[11px] text-zinc-400">外部触发或定时唤醒</div>
            </div>
          </label>
        </div>
      </div>

      {/* Notification Tell Policy */}
      <div>
        <label className="block text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-1">
          通知打扰策略
        </label>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          <button
            type="button"
            onClick={() => setChannelTellPolicy('needed')}
            className={`h-8 px-2.5 text-xs font-medium rounded-lg border flex items-center justify-center gap-1.5 cursor-pointer transition-colors text-center ${
              channelTellPolicy === 'needed'
                ? 'bg-blue-50 dark:bg-blue-950/50 border-blue-400 dark:border-blue-700 text-blue-700 dark:text-blue-300'
                : 'bg-white dark:bg-zinc-900 border-zinc-200 dark:border-zinc-800 text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800'
            }`}
            title="仅人工审批与异常失败时推送"
          >
            <BellRing className="w-3.5 h-3.5 shrink-0" />
            <span>按需打扰（推荐）</span>
          </button>
          <button
            type="button"
            onClick={() => setChannelTellPolicy('always')}
            className={`h-8 px-2.5 text-xs font-medium rounded-lg border flex items-center justify-center gap-1.5 cursor-pointer transition-colors text-center ${
              channelTellPolicy === 'always'
                ? 'bg-blue-50 dark:bg-blue-950/50 border-blue-400 dark:border-blue-700 text-blue-700 dark:text-blue-300'
                : 'bg-white dark:bg-zinc-900 border-zinc-200 dark:border-zinc-800 text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800'
            }`}
            title="全部勾选事件均推送"
          >
            <Send className="w-3.5 h-3.5 shrink-0" />
            <span>全部推送</span>
          </button>
          <button
            type="button"
            onClick={() => setChannelTellPolicy('never')}
            className={`h-8 px-2.5 text-xs font-medium rounded-lg border flex items-center justify-center gap-1.5 cursor-pointer transition-colors text-center ${
              channelTellPolicy === 'never'
                ? 'bg-blue-50 dark:bg-blue-950/50 border-blue-400 dark:border-blue-700 text-blue-700 dark:text-blue-300'
                : 'bg-white dark:bg-zinc-900 border-zinc-200 dark:border-zinc-800 text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800'
            }`}
            title="静默，暂停推送"
          >
            <BellOff className="w-3.5 h-3.5 shrink-0" />
            <span>静默</span>
          </button>
        </div>
        <p className="text-[11px] text-zinc-400 dark:text-zinc-500 mt-1">
          {channelTellPolicy === 'needed'
            ? '仅人工审批与异常失败时推送，推荐'
            : channelTellPolicy === 'always'
            ? '全部勾选事件均推送'
            : '静默，暂停推送'}
        </p>
      </div>

      {/* Form Actions */}
      <div className="flex items-center justify-end gap-2 pt-2 border-t border-zinc-200/80 dark:border-zinc-800">
        <button
          type="button"
          onClick={onClose}
          className="h-8 px-2.5 text-xs font-medium rounded-lg text-zinc-600 dark:text-zinc-400 hover:bg-zinc-200/60 dark:hover:bg-zinc-800 cursor-pointer"
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
  );
};
