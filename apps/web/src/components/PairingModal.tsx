import React, { useState, useEffect } from 'react';
import { X, Copy, Check, Terminal, Loader2, Clock, AlertCircle } from 'lucide-react';
import { api } from '../api';
import type { PairingResult } from '@botd/protocol';

interface PairingModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const PairingModal: React.FC<PairingModalProps> = ({ isOpen, onClose }) => {
  const [pairingData, setPairingData] = useState<PairingResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nodeName, setNodeName] = useState('worker-node');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setLoading(true);
      setError(null);
      setCopied(false);
      api.createPairingCode()
        .then((res) => {
          setPairingData(res);
        })
        .catch((err) => {
          setError(err?.message || '生成配对码失败');
        })
        .finally(() => {
          setLoading(false);
        });
    } else {
      setPairingData(null);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const hubUrl = window.location.origin;
  const joinCommand = pairingData
    ? `botd join ${hubUrl} --code ${pairingData.code} --name ${nodeName.trim() || 'worker-node'}`
    : '';

  const handleCopy = () => {
    if (!joinCommand) return;
    navigator.clipboard.writeText(joinCommand);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/40 dark:bg-black/70 backdrop-blur-xs flex items-end sm:items-center justify-center p-0 sm:p-4 overflow-y-auto animate-in fade-in"
      role="dialog"
      aria-modal="true"
      aria-labelledby="pairing-modal-title"
    >
      <div className="bg-white dark:bg-zinc-950 rounded-t-2xl sm:rounded-2xl shadow-2xl border border-zinc-200/90 dark:border-zinc-800/90 max-w-lg w-full max-h-[92dvh] flex flex-col pb-[max(1rem,env(safe-area-inset-bottom))] sm:pb-0 overflow-hidden">
        {/* Mobile Drag Handle */}
        <div className="w-10 h-1 bg-zinc-300 dark:bg-zinc-700 rounded-full mx-auto mt-2.5 mb-1 sm:hidden shrink-0" />

        {/* Header */}
        <div className="px-5 py-4 border-b border-zinc-100 dark:border-zinc-800/60 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2">
            <Terminal className="w-4 h-4 text-zinc-700 dark:text-zinc-300" />
            <h2 id="pairing-modal-title" className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
              配对新节点
            </h2>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 text-zinc-400 hover:text-zinc-600 dark:text-zinc-500 dark:hover:text-zinc-300 rounded-lg hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
            aria-label="关闭"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-4 overflow-y-auto flex-1">
          {loading ? (
            <div className="py-12 flex flex-col items-center justify-center text-zinc-500 dark:text-zinc-400 gap-2">
              <Loader2 className="w-5 h-5 animate-spin-fast text-zinc-700 dark:text-zinc-300" />
              <p className="text-xs">正在申请一次性配对码...</p>
            </div>
          ) : error ? (
            <div className="p-3.5 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900/60 rounded-xl text-xs text-rose-700 dark:text-rose-300 flex items-center gap-2">
              <AlertCircle className="w-4 h-4 shrink-0 text-rose-500 dark:text-rose-400" />
              <span>{error}</span>
            </div>
          ) : pairingData ? (
            <>
              {/* One-time Code Display */}
              <div className="p-5 bg-zinc-50 dark:bg-zinc-900 border border-zinc-200/80 dark:border-zinc-800/80 rounded-xl flex flex-col items-center justify-center text-center">
                <span className="text-xs text-zinc-500 dark:text-zinc-400 mb-1">一次性配对码</span>
                <div className="text-3xl sm:text-4xl font-mono font-bold tracking-widest text-zinc-900 dark:text-zinc-100 py-1">
                  {pairingData.code}
                </div>
                <div className="flex items-center gap-1.5 text-[11px] text-zinc-600 dark:text-zinc-400 bg-white dark:bg-zinc-950 px-2.5 py-0.5 rounded-full border border-zinc-200 dark:border-zinc-800 mt-2">
                  <Clock className="w-3 h-3 text-zinc-400 dark:text-zinc-500" />
                  <span>有效期 10 分钟，使用后立即作废</span>
                </div>
              </div>

              {/* Node Name */}
              <div>
                <label className="block text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-1.5">
                  节点名称
                </label>
                <input
                  type="text"
                  value={nodeName}
                  onChange={(e) => setNodeName(e.target.value)}
                  placeholder="例如：macbook-pro 或 cloud-gpu-1"
                  className="w-full h-8 px-2.5 text-xs bg-zinc-50 dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 dark:placeholder:text-zinc-500 border border-zinc-200 dark:border-zinc-800 rounded-lg focus:bg-white dark:focus:bg-zinc-950 focus:outline-none focus:ring-2 focus:ring-zinc-900 dark:focus:ring-zinc-400 font-mono transition-colors"
                />
              </div>

              {/* Shell Command */}
              <div>
                <label className="block text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-1.5">
                  在目标计算设备终端执行以下命令：
                </label>
                <div className="relative group">
                  <pre className="p-3 bg-zinc-950 dark:bg-black text-zinc-100 rounded-xl text-xs font-mono overflow-x-auto border border-zinc-800 pr-12 leading-relaxed">
                    {joinCommand}
                  </pre>
                  <button
                    onClick={handleCopy}
                    className="absolute right-2 top-2 p-1.5 bg-zinc-800 hover:bg-zinc-700 dark:bg-zinc-900 dark:hover:bg-zinc-800 text-zinc-300 hover:text-white rounded-lg transition-colors border border-zinc-700 dark:border-zinc-800"
                    title="复制完整命令"
                    aria-label="复制完整命令"
                  >
                    {copied ? (
                      <Check className="w-3.5 h-3.5 text-emerald-400" />
                    ) : (
                      <Copy className="w-3.5 h-3.5" />
                    )}
                  </button>
                </div>
                {copied && (
                  <p className="text-xs text-emerald-600 dark:text-emerald-400 font-medium mt-1">已成功复制命令至剪贴板</p>
                )}
              </div>

              {/* Explanation */}
              <div className="p-3 bg-zinc-50 dark:bg-zinc-900 border border-zinc-200/80 dark:border-zinc-800/80 rounded-xl text-[11px] text-zinc-600 dark:text-zinc-400 leading-relaxed">
                <span className="font-semibold text-zinc-800 dark:text-zinc-200">配对流程说明：</span>
                <ol className="list-decimal ml-4 mt-1 space-y-0.5 text-zinc-500 dark:text-zinc-400">
                  <li>在目标机运行 <code>botd join</code> 自动完成凭证握手并初始化本地配置。</li>
                  <li>运行 <code>botd start</code> 启动常驻守护进程，节点即在管理页面呈现在线状态。</li>
                </ol>
              </div>
            </>
          ) : null}

          <div className="pt-2 flex justify-end border-t border-zinc-100 dark:border-zinc-800/60">
            <button
              onClick={onClose}
              className="px-4 py-2 bg-zinc-900 hover:bg-zinc-800 text-white dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white text-xs font-medium rounded-xl transition-colors shadow-xs"
            >
              完成并关闭
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

