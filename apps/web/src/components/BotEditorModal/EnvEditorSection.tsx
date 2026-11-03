import React, { useState } from 'react';
import { KeyRound, Plus, Trash2, Eye, EyeOff } from 'lucide-react';
import { ConfirmDialog } from '../ConfirmDialog';
import { api } from '../../api';

export interface EnvPair {
  key: string;
  value: string;
  visible?: boolean;
}

interface EnvEditorSectionProps {
  envPairs: EnvPair[];
  setEnvPairs: React.Dispatch<React.SetStateAction<EnvPair[]>>;
  /** 已落盘的 bot（编辑在线 bot）单键删除需调 API 回写 */
  apiDelete: { botId: string } | null;
  onError: (message: string) => void;
  /** 节点离线时的提示文案开关 */
  showOfflineHint: boolean;
}

/** Sanitize env key to legal characters: uppercase letters, digits, underscore */
const sanitizeEnvKey = (raw: string) =>
  raw
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, '_')
    .replace(/^_+/, '_');

/** 环境变量 (Secrets) 编辑器：主 BOT 专属；已落盘 bot 的单键删除走 API。 */
export const EnvEditorSection: React.FC<EnvEditorSectionProps> = ({
  envPairs,
  setEnvPairs,
  apiDelete,
  onError,
  showOfflineHint,
}) => {
  // env 单键删除确认
  const [envDeleteIndex, setEnvDeleteIndex] = useState<number | null>(null);
  const [deletingEnvKey, setDeletingEnvKey] = useState(false);

  const addEnvPair = () => {
    setEnvPairs((prev) => [...prev, { key: '', value: '', visible: false }]);
  };

  const updateEnvPair = (
    index: number,
    patch: Partial<{ key: string; value: string; visible: boolean }>
  ) => {
    setEnvPairs((prev) =>
      prev.map((pair, i) => (i === index ? { ...pair, ...patch } : pair))
    );
  };

  // 单键删除：先确认；已落盘的 bot 调 API 删除并回写返回 env，否则纯本地移除
  const confirmRemoveEnvPair = async () => {
    if (envDeleteIndex === null) return;
    const pair = envPairs[envDeleteIndex];
    if (!pair) {
      setEnvDeleteIndex(null);
      return;
    }
    const cleanKey = pair.key.trim();
    const canCallApi = apiDelete !== null && cleanKey !== '';

    if (canCallApi) {
      setDeletingEnvKey(true);
      try {
        const res = await api.deleteBotEnvKey(apiDelete!.botId, cleanKey);
        setEnvPairs(
          Object.entries(res.env || {}).map(([key, value]) => ({ key, value, visible: false }))
        );
        setEnvDeleteIndex(null);
      } catch (err: any) {
        onError(err?.message || '删除环境变量失败');
      } finally {
        setDeletingEnvKey(false);
      }
    } else {
      setEnvPairs((prev) => prev.filter((_, i) => i !== envDeleteIndex));
      setEnvDeleteIndex(null);
    }
  };

  return (
    <>
      <div className="p-3.5 sm:p-4 bg-zinc-50/70 dark:bg-zinc-900/70 border border-zinc-200/90 dark:border-zinc-800/90 rounded-2xl space-y-3">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold text-zinc-900 dark:text-zinc-100 flex items-center gap-1.5">
            <KeyRound className="w-3.5 h-3.5 text-zinc-700 dark:text-zinc-300" />
            <span>环境变量 (Secrets)</span>
          </span>
          <button
            type="button"
            onClick={addEnvPair}
            className="h-7 px-2.5 text-xs font-medium rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 flex items-center gap-1 transition-colors cursor-pointer"
          >
            <Plus className="w-3 h-3" />
            <span>添加变量</span>
          </button>
        </div>
        <p className="text-[11px] text-zinc-500 dark:text-zinc-400 leading-relaxed">
          注入至 bash 子进程环境（0600 隔离存储），模型仅知晓变量名 $VAR，不会暴露明文到上下文
        </p>

        {envPairs.length === 0 ? (
          <p className="text-[11px] text-zinc-400 dark:text-zinc-500 bg-white/60 dark:bg-zinc-900/60 p-2 rounded-lg border border-dashed border-zinc-200 dark:border-zinc-800">
            {showOfflineHint
              ? '节点离线时无法读取或保存环境变量，待节点上线后重试。'
              : '尚未配置环境变量，点击右上角「添加变量」新建。'}
          </p>
        ) : (
          <div className="space-y-1.5">
            {envPairs.map((pair, index) => (
              <div key={index} className="flex items-center gap-1.5">
                <input
                  type="text"
                  value={pair.key}
                  aria-label={`环境变量名 ${index + 1}`}
                  onChange={(e) => updateEnvPair(index, { key: sanitizeEnvKey(e.target.value) })}
                  placeholder="GITHUB_TOKEN"
                  className="w-2/5 h-8 px-2.5 text-xs font-mono bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded-lg focus:outline-none focus:ring-1 focus:ring-zinc-900 dark:focus:ring-zinc-400 text-zinc-800 dark:text-zinc-200 placeholder-zinc-400 dark:placeholder-zinc-500"
                />
                <div className="relative flex-1">
                  <input
                    type={pair.visible ? 'text' : 'password'}
                    value={pair.value}
                    aria-label={`环境变量值 ${index + 1}`}
                    onChange={(e) => updateEnvPair(index, { value: e.target.value })}
                    placeholder="••••••••"
                    autoComplete="off"
                    className="w-full h-8 pl-2.5 pr-8 text-xs font-mono bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded-lg focus:outline-none focus:ring-1 focus:ring-zinc-900 dark:focus:ring-zinc-400 text-zinc-800 dark:text-zinc-200 placeholder-zinc-400 dark:placeholder-zinc-500"
                  />
                  <button
                    type="button"
                    onClick={() => updateEnvPair(index, { visible: !pair.visible })}
                    className="absolute right-1.5 top-1/2 -translate-y-1/2 p-1 text-zinc-400 hover:text-zinc-600 dark:text-zinc-500 dark:hover:text-zinc-300 rounded transition-colors cursor-pointer"
                    aria-label={pair.visible ? '隐藏明文' : '显示明文'}
                    title={pair.visible ? '隐藏明文' : '显示明文'}
                  >
                    {pair.visible ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                  </button>
                </div>
                <button
                  type="button"
                  onClick={() => setEnvDeleteIndex(index)}
                  className="p-1.5 text-zinc-400 hover:text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/50 rounded-lg transition-colors cursor-pointer shrink-0"
                  aria-label={`删除变量 ${index + 1}`}
                  title="删除变量"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 单键删除环境变量确认 */}
      <ConfirmDialog
        isOpen={envDeleteIndex !== null}
        title="删除环境变量"
        message={
          <>
            删除环境变量{' '}
            <span className="font-mono font-medium text-zinc-800 dark:text-zinc-200">
              {envDeleteIndex !== null ? (envPairs[envDeleteIndex]?.key?.trim() || '（未命名）') : ''}
            </span>
            ？该 BOT 的此配置将被移除。
          </>
        }
        confirmText="删除"
        danger
        busy={deletingEnvKey}
        onConfirm={confirmRemoveEnvPair}
        onClose={() => setEnvDeleteIndex(null)}
      />
    </>
  );
};
