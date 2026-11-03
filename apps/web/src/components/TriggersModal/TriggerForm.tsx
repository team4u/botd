import React, { useState } from 'react';
import { Clock, Radio, Timer, Loader2 } from 'lucide-react';
import type {
  BotConfig,
  TriggerRecord,
  TriggerKind,
  CreateTriggerInput,
  TriggerDispatchMode,
  TriggerEventFilter,
} from '@botd/protocol';
import { isValidCronExpr, describeCronExpr } from '@botd/protocol';
import { api } from '../../api';
import { parseEventTypes, parseOnceRunAt, isoToLocalDatetimeInput, localDatetimeInputToIso } from './shared';

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

export interface TriggerFormProps {
  session: SessionRecordLike;
  memberBots: BotConfig[];
  /** 编辑已有触发器；null 表示新建 */
  editingTrigger: TriggerRecord | null;
  onAddToast: (type: 'success' | 'error' | 'info', message: string) => void;
  /** 表单关闭（取消编辑/新建） */
  onClose: () => void;
}

interface SessionRecordLike {
  id: string;
  leadBotId?: string | null;
}

const defaultBotId = (session: SessionRecordLike, memberBots: BotConfig[]): string =>
  session.leadBotId || memberBots[0]?.id || '';

export const TriggerForm: React.FC<TriggerFormProps> = ({
  session,
  memberBots,
  editingTrigger,
  onAddToast,
  onClose,
}) => {
  const isEditing = Boolean(editingTrigger);

  // 父组件以 key={editingTrigger?.id ?? 'new'} 控制重挂载，这里直接取初始值即可
  const [name, setName] = useState(editingTrigger?.name ?? '');
  const [botId, setBotId] = useState(() => editingTrigger?.botId ?? defaultBotId(session, memberBots));
  const [kind, setKind] = useState<TriggerKind>(editingTrigger?.kind ?? 'webhook');
  const [cronExpr, setCronExpr] = useState(editingTrigger?.cronExpr || '*/30 * * * *');
  const [runAtInput, setRunAtInput] = useState(
    editingTrigger?.runAt ? isoToLocalDatetimeInput(editingTrigger.runAt) : '15m'
  );
  const [prompt, setPrompt] = useState(editingTrigger?.prompt ?? '');
  const [dispatchMode, setDispatchMode] = useState<TriggerDispatchMode>(
    editingTrigger?.dispatchMode || (editingTrigger ? 'append' : 'subsession')
  );
  const [skillIdInput, setSkillIdInput] = useState(editingTrigger?.skillId ?? '');
  const [eventTypesInput, setEventTypesInput] = useState(
    editingTrigger?.eventFilter?.types?.join(', ') ?? ''
  );
  const [submitting, setSubmitting] = useState(false);

  const handleCancelEdit = () => {
    onClose();
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

  const parsedRunAt =
    kind === 'once' ? (isEditing ? localDatetimeInputToIso(runAtInput) : parseOnceRunAt(runAtInput)) : null;
  const isRunAtValid = kind !== 'once' || Boolean(parsedRunAt);

  const handleCreateTrigger = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedName = name.trim();
    const trimmedPrompt = prompt.trim();

    if (!trimmedName) {
      onAddToast('error', '请输入触发器名称');
      return;
    }
    if (!trimmedPrompt) {
      onAddToast('error', '请输入触发指令或提示词');
      return;
    }
    if (!botId) {
      onAddToast('error', '请选择执行指令的智能体');
      return;
    }
    if (kind === 'cron') {
      if (!trimmedCron || !isCronValid) {
        onAddToast('error', '无效的 Cron 表达式（标准 5 段式：分 时 日 月 周）');
        return;
      }
    }
    if (kind === 'once') {
      if (!parsedRunAt) {
        onAddToast('error', '无效的延时或时间（支持 30s / 15m / 2h / 1d 或 ISO 时间）');
        return;
      }
    }

    const trimmedSkillId = skillIdInput.trim();
    const parsedTypes = parseEventTypes(eventTypesInput);
    const eventFilter: TriggerEventFilter | undefined =
      kind === 'webhook' && parsedTypes.length > 0 ? { types: parsedTypes } : undefined;

    const payload: CreateTriggerInput = {
      name: trimmedName,
      botId,
      kind,
      prompt: trimmedPrompt,
      enabled: true,
      ...(kind === 'cron' ? { cronExpr: trimmedCron } : {}),
      ...(kind === 'once' && parsedRunAt ? { runAt: parsedRunAt } : {}),
      dispatchMode,
      ...(trimmedSkillId ? { skillId: trimmedSkillId } : {}),
      ...(eventFilter ? { eventFilter } : {}),
    };

    setSubmitting(true);

    try {
      if (editingTrigger) {
        // kind/botId 不可变，仅提交可变字段（skillId 传 null 清除绑定，eventFilter 传 null 清除过滤）
        await api.updateTrigger(editingTrigger.id, {
          name: trimmedName,
          prompt: trimmedPrompt,
          ...(kind === 'cron' ? { cronExpr: trimmedCron } : {}),
          ...(kind === 'once' && parsedRunAt ? { runAt: parsedRunAt } : {}),
          dispatchMode,
          skillId: trimmedSkillId || null,
          ...(kind === 'webhook' ? { eventFilter: eventFilter ?? null } : {}),
        });
        onAddToast('success', '触发器已更新');
      } else {
        const created = await api.createSessionTrigger(session.id, payload);
        onAddToast('success', `触发器「${created.name}」已创建`);
      }
      onClose();
    } catch (err: any) {
      onAddToast('error', err?.message || (editingTrigger ? '更新触发器失败' : '创建触发器失败'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
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

      {/* Execution: dispatch mode + skill binding */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label htmlFor="trigger-dispatch-mode" className="block text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-1">
            执行方式
          </label>
          <select
            id="trigger-dispatch-mode"
            value={dispatchMode}
            onChange={(e) => setDispatchMode(e.target.value as TriggerDispatchMode)}
            className="w-full h-8 px-2.5 text-xs bg-white dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 rounded-lg text-zinc-800 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="subsession">派生独立子会话（推荐，隔离每次运行）</option>
            <option value="append">追加到当前会话</option>
          </select>
        </div>

        <div>
          <label htmlFor="trigger-skill" className="block text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-1">
            绑定技能
            <span className="ml-1.5 text-[11px] font-normal text-zinc-400 dark:text-zinc-500">可选</span>
          </label>
          <input
            id="trigger-skill"
            type="text"
            value={skillIdInput}
            onChange={(e) => setSkillIdInput(e.target.value)}
            placeholder="可选，如 github-pr-review"
            className="w-full h-8 px-2.5 text-xs bg-white dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 rounded-lg text-zinc-800 dark:text-zinc-100 placeholder:text-zinc-400 dark:placeholder:text-zinc-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <p className="text-[11px] text-zinc-400 dark:text-zinc-500 mt-1">
            触发时自动以 <span className="font-mono">/skill:&lt;id&gt;</span> 启动
          </p>
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
        <div>
          <label htmlFor="trigger-event-types" className="block text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-1">
            事件类型过滤
            <span className="ml-1.5 text-[11px] font-normal text-zinc-400 dark:text-zinc-500">可选</span>
          </label>
          <input
            id="trigger-event-types"
            type="text"
            value={eventTypesInput}
            onChange={(e) => setEventTypesInput(e.target.value)}
            placeholder="可选，如 pull_request.opened, pull_request.synchronize"
            className="w-full h-8 px-2.5 text-xs font-mono bg-white dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 rounded-lg text-zinc-800 dark:text-zinc-100 placeholder:text-zinc-400 dark:placeholder:text-zinc-500 placeholder:font-sans focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <p className="text-[11px] text-zinc-400 dark:text-zinc-500 mt-1">
            逗号分隔；留空接收全部事件，填写后仅匹配类型才触发
          </p>
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
  );
};
