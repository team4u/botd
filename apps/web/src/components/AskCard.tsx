import React, { useState } from 'react';
import { HelpCircle, Loader2, Send, CheckCircle2, ChevronDown } from 'lucide-react';
import type { PendingAskRecord, BotConfig } from '@botd/protocol';

export interface AskCardProps {
  ask: PendingAskRecord;
  bot?: BotConfig;
  onRespond: (askId: string, answer: string) => Promise<void>;
}

export const AskCard: React.FC<AskCardProps> = ({ ask, bot, onRespond }) => {
  const [customAnswer, setCustomAnswer] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [chosenOption, setChosenOption] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const hasPreview = Boolean(ask.previewContent && ask.previewContent.trim().length > 0);
  const [previewExpanded, setPreviewExpanded] = useState(() =>
    Boolean(ask.previewContent && ask.previewContent.length <= 4000)
  );

  const isAnswered = ask.status === 'answered' || Boolean(ask.answer);
  const botId = bot?.id || ask.botId;

  const handleRespond = async (answer: string) => {
    const trimmed = answer.trim();
    if (!trimmed || submitting) return;

    setError(null);
    setSubmitting(true);
    setChosenOption(answer);

    try {
      await onRespond(ask.id, trimmed);
    } catch (err: any) {
      setError(err?.message || '提交回复失败，请重试');
    } finally {
      setSubmitting(false);
      setChosenOption(null);
    }
  };

  const handleCustomSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    handleRespond(customAnswer);
  };

  const previewBadge = (ask.previewType || 'text').toUpperCase();

  return (
    <div className="rounded-xl border border-blue-200 dark:border-blue-900/60 bg-blue-50/60 dark:bg-blue-950/30 p-3 text-xs space-y-2.5">
      {/* Header */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 font-semibold text-blue-950 dark:text-blue-100 min-w-0">
          <HelpCircle className="w-4 h-4 text-blue-600 dark:text-blue-400 shrink-0" />
          <span className="truncate">@{botId} 请求确认 / 输入</span>
        </div>

        {isAnswered && (
          <span className="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-700 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/50 px-2 py-0.5 rounded-full border border-emerald-200 dark:border-emerald-800/60 shrink-0">
            <CheckCircle2 className="w-3 h-3" />
            <span>已答复</span>
          </span>
        )}
      </div>

      {/* Prompt content */}
      <div className="p-2.5 rounded-lg bg-white/70 dark:bg-zinc-900/50 border border-blue-100 dark:border-blue-900/40 text-xs text-zinc-800 dark:text-zinc-200 leading-relaxed font-medium">
        {ask.prompt}
      </div>

      {/* Collapsible preview section */}
      {hasPreview && (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <button
              type="button"
              onClick={() => setPreviewExpanded((v) => !v)}
              className="flex items-center gap-1 text-[11px] font-medium text-blue-700 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300 transition-colors cursor-pointer"
            >
              <ChevronDown
                className={`w-3.5 h-3.5 transition-transform duration-200 ${
                  previewExpanded ? '' : '-rotate-90'
                }`}
              />
              <span>{previewExpanded ? '收起预览' : '展开预览'}</span>
            </button>
            <span className="text-[10px] font-mono font-medium px-1.5 py-0.5 rounded bg-blue-100 dark:bg-blue-900/60 text-blue-700 dark:text-blue-300">
              {previewBadge}
            </span>
          </div>

          {previewExpanded && (
            <div className="overflow-hidden rounded-lg border border-blue-100 dark:border-blue-900/40 bg-white/90 dark:bg-zinc-950/90">
              {ask.previewType === 'diff' ? (
                <div className="font-mono text-[11px] leading-relaxed p-2 overflow-x-auto max-h-80 overflow-y-auto select-text">
                  {ask.previewContent!.split('\n').map((line, idx) => {
                    let lineClass = 'text-zinc-700 dark:text-zinc-300';
                    if (line.startsWith('+')) {
                      lineClass = 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300';
                    } else if (line.startsWith('-')) {
                      lineClass = 'bg-rose-500/10 text-rose-700 dark:text-rose-300';
                    } else if (line.startsWith('@@')) {
                      lineClass = 'text-blue-600 dark:text-blue-400 font-semibold';
                    }
                    return (
                      <div key={idx} className={`px-1.5 py-0.5 whitespace-pre-wrap break-all ${lineClass}`}>
                        {line || '\u00A0'}
                      </div>
                    );
                  })}
                </div>
              ) : (
                <pre className="font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-all overflow-x-auto max-h-80 overflow-y-auto p-2.5 text-zinc-800 dark:text-zinc-200 select-text">
                  {ask.previewContent}
                </pre>
              )}
            </div>
          )}
        </div>
      )}

      {/* Error message */}
      {error && (
        <div className="text-[11px] text-rose-600 dark:text-rose-400">
          {error}
        </div>
      )}

      {/* Interactive area */}
      {isAnswered ? (
        <div className="flex items-center gap-2 p-2 rounded-lg bg-white/80 dark:bg-zinc-900/60 border border-blue-200/60 dark:border-blue-900/40 text-xs text-zinc-700 dark:text-zinc-300">
          <span className="text-[11px] font-medium text-zinc-500 dark:text-zinc-400 shrink-0">已回复:</span>
          <span className="font-semibold text-blue-700 dark:text-blue-300 truncate">
            {ask.answer || '已提交'}
          </span>
        </div>
      ) : (
        <div className="space-y-2">
          {ask.options && ask.options.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {ask.options.map((option, idx) => (
                <button
                  key={idx}
                  type="button"
                  onClick={() => handleRespond(option)}
                  disabled={submitting}
                  className="h-8 px-3 text-xs font-medium rounded-lg bg-white hover:bg-blue-50 dark:bg-zinc-900 dark:hover:bg-blue-950/50 border border-blue-200 hover:border-blue-300 dark:border-blue-900/60 dark:hover:border-blue-800 text-blue-700 dark:text-blue-300 transition-colors shadow-2xs flex items-center gap-1.5 disabled:opacity-50 cursor-pointer"
                >
                  {submitting && chosenOption === option && (
                    <Loader2 className="w-3 h-3 animate-spin-fast text-blue-600 dark:text-blue-400" />
                  )}
                  <span>{option}</span>
                </button>
              ))}
            </div>
          )}

          <form onSubmit={handleCustomSubmit} className="flex items-center gap-1.5">
            <input
              type="text"
              value={customAnswer}
              onChange={(e) => setCustomAnswer(e.target.value)}
              disabled={submitting}
              placeholder={
                ask.options && ask.options.length > 0
                  ? '或者输入其他回复...'
                  : '请输入回复内容...'
              }
              className="flex-1 h-8 px-2.5 text-xs bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 rounded-lg text-zinc-800 dark:text-zinc-100 placeholder:text-zinc-400 dark:placeholder:text-zinc-500 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50"
            />
            <button
              type="submit"
              disabled={submitting || !customAnswer.trim()}
              className="h-8 px-3 text-xs font-medium rounded-lg bg-blue-600 hover:bg-blue-700 disabled:bg-blue-300 dark:disabled:bg-blue-900/50 dark:disabled:text-blue-400/50 text-white flex items-center gap-1 transition-colors shadow-2xs cursor-pointer shrink-0"
            >
              {submitting && chosenOption === null ? (
                <Loader2 className="w-3 h-3 animate-spin-fast" />
              ) : (
                <Send className="w-3 h-3" />
              )}
              <span>回复</span>
            </button>
          </form>
        </div>
      )}
    </div>
  );
};
