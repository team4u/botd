import React, { useState, useEffect } from 'react';
import {
  X,
  Blocks,
  Save,
  Loader2,
  Trash2,
  CheckCircle2,
  Code2,
  Download,
  FileCode,
  Globe,
} from 'lucide-react';
import { ConfirmDialog } from './ConfirmDialog';
import { api } from '../api';

interface ExtensionEditorModalProps {
  isOpen: boolean;
  nodeId: string;
  nodeName: string;
  extId?: string | null;
  onClose: () => void;
  onSaved: () => void;
}

const STARTER_EXTENSION_TS = `import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

export default function (pi: ExtensionAPI) {
  // 1. 拦截工具调用示例 (tool_call hook)
  pi.on('tool_call', async (event) => {
    if (event.toolName === 'bash') {
      const cmd = String((event.input as { command?: string })?.command || '');
      if (cmd.includes('rm -rf /')) {
        return { block: true, reason: '已通过 bash-guard 扩展拦截高危指令' };
      }
    }
  });

  // 2. 注册自定义工具示例 (registerTool)
  // pi.registerTool({ ... });
}
`;

export const ExtensionEditorModal: React.FC<ExtensionEditorModalProps> = ({
  isOpen,
  nodeId,
  nodeName,
  extId: initialExtId,
  onClose,
  onSaved,
}) => {
  const isEditing = Boolean(initialExtId);
  const [activeTab, setActiveTab] = useState<'code' | 'install'>('code');

  // Code mode state
  const [extId, setExtId] = useState(initialExtId || '');
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);

  // Install mode state
  const [source, setSource] = useState('');
  const [kind, setKind] = useState<'auto' | 'skill' | 'extension'>('auto');
  const [customId, setCustomId] = useState('');
  const [installing, setInstalling] = useState(false);

  // Feedback state
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      setError(null);
      setSuccess(null);
      if (initialExtId) {
        setExtId(initialExtId);
        setLoading(true);
        api.getExtension(nodeId, initialExtId)
          .then((res) => {
            setContent(res.content || '');
          })
          .catch((err) => {
            setError(err?.message || '读取扩展 index.ts 失败');
          })
          .finally(() => {
            setLoading(false);
          });
      } else {
        setExtId('');
        setContent(STARTER_EXTENSION_TS);
        setSource('');
        setKind('auto');
        setCustomId('');
        setActiveTab('code');
      }
    }
  }, [isOpen, nodeId, initialExtId]);

  if (!isOpen) return null;

  const handleSaveCode = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanId = extId.trim();
    if (!cleanId) {
      setError('请输入扩展标识');
      return;
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(cleanId)) {
      setError('扩展标识仅允许包含英文字母、数字、下划线及短横线');
      return;
    }
    if (!content.trim()) {
      setError('扩展代码 index.ts 内容不能为空');
      return;
    }

    setSaving(true);
    setError(null);

    try {
      await api.saveExtension(nodeId, cleanId, content);
      setSuccess(isEditing ? '扩展已成功更新' : '扩展已成功保存');
      setTimeout(() => {
        onSaved();
        onClose();
      }, 600);
    } catch (err: any) {
      setError(err?.message || '保存扩展失败');
    } finally {
      setSaving(false);
    }
  };

  const handleInstall = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanSource = source.trim();
    if (!cleanSource) {
      setError('请输入安装来源');
      return;
    }

    const cleanCustomId = customId.trim() || undefined;
    if (cleanCustomId && !/^[a-zA-Z0-9_-]+$/.test(cleanCustomId)) {
      setError('自定义标识仅允许包含英文字母、数字、下划线及短横线');
      return;
    }

    setInstalling(true);
    setError(null);

    try {
      const result = await api.installResource(nodeId, {
        source: cleanSource,
        kind,
        customId: cleanCustomId,
      });
      setSuccess(`安装成功！类型: ${result.kind === 'extension' ? '扩展插件' : '技能文档'}，标识: ${result.id}`);
      setTimeout(() => {
        onSaved();
        onClose();
      }, 800);
    } catch (err: any) {
      setError(err?.message || '安装失败');
    } finally {
      setInstalling(false);
    }
  };

  const handleDelete = async () => {
    if (!initialExtId) return;

    setDeleting(true);
    setError(null);

    try {
      await api.deleteExtension(nodeId, initialExtId);
      onSaved();
      onClose();
    } catch (err: any) {
      setError(err?.message || '删除扩展失败');
    } finally {
      setDeleting(false);
      setConfirmDeleteOpen(false);
    }
  };

  return (
    <>
      <div
      className="fixed inset-0 z-50 bg-black/40 dark:bg-black/70 backdrop-blur-xs flex items-end sm:items-center justify-center p-0 sm:p-4 overflow-y-auto animate-in fade-in"
      role="dialog"
      aria-modal="true"
      aria-labelledby="extension-editor-title"
    >
      <div className="bg-white dark:bg-zinc-950 rounded-t-2xl sm:rounded-2xl shadow-2xl border border-zinc-200/90 dark:border-zinc-800/90 max-w-2xl w-full max-h-[92dvh] flex flex-col pb-[max(1rem,env(safe-area-inset-bottom))] sm:pb-0 overflow-hidden">
        {/* Mobile Drag Handle */}
        <div className="w-10 h-1 bg-zinc-300 dark:bg-zinc-700 rounded-full mx-auto mt-2.5 mb-1 sm:hidden shrink-0" />

        {/* Header */}
        <div className="px-5 py-4 border-b border-zinc-100 dark:border-zinc-800/60 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 flex items-center justify-center border border-zinc-200/60 dark:border-zinc-700/60">
              <Blocks className="w-4 h-4" />
            </div>
            <div>
              <h2 id="extension-editor-title" className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                {isEditing ? `编辑扩展插件: ${initialExtId}` : '安装或新建扩展'}
              </h2>
              <p className="text-xs text-zinc-500 dark:text-zinc-400">
                所属节点: <span className="font-medium text-zinc-700 dark:text-zinc-300">{nodeName}</span> ({nodeId})
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 text-zinc-400 hover:text-zinc-600 dark:text-zinc-500 dark:hover:text-zinc-300 rounded-lg hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
            aria-label="关闭"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Mode Tabs (Only shown when creating new resource) */}
        {!isEditing && (
          <div className="flex border-b border-zinc-200/80 dark:border-zinc-800/80 bg-zinc-50 dark:bg-zinc-900 shrink-0">
            <button
              type="button"
              onClick={() => {
                setActiveTab('code');
                setError(null);
              }}
              className={`flex-1 py-2.5 px-4 text-xs font-medium flex items-center justify-center gap-2 border-b-2 transition-colors ${
                activeTab === 'code'
                  ? 'border-zinc-900 text-zinc-900 bg-white font-semibold dark:border-zinc-100 dark:text-zinc-100 dark:bg-zinc-950'
                  : 'border-transparent text-zinc-500 hover:text-zinc-700 hover:bg-zinc-100/60 dark:text-zinc-400 dark:hover:text-zinc-200 dark:hover:bg-zinc-800/60'
              }`}
            >
              <Code2 className="w-3.5 h-3.5" />
              <span>编写代码新建</span>
            </button>
            <button
              type="button"
              onClick={() => {
                setActiveTab('install');
                setError(null);
              }}
              className={`flex-1 py-2.5 px-4 text-xs font-medium flex items-center justify-center gap-2 border-b-2 transition-colors ${
                activeTab === 'install'
                  ? 'border-zinc-900 text-zinc-900 bg-white font-semibold dark:border-zinc-100 dark:text-zinc-100 dark:bg-zinc-950'
                  : 'border-transparent text-zinc-500 hover:text-zinc-700 hover:bg-zinc-100/60 dark:text-zinc-400 dark:hover:text-zinc-200 dark:hover:bg-zinc-800/60'
              }`}
            >
              <Download className="w-3.5 h-3.5" />
              <span>从仓库或包安装</span>
            </button>
          </div>
        )}

        {/* Tab 1: Code Mode (or editing existing extension) */}
        {(isEditing || activeTab === 'code') && (
          <form onSubmit={handleSaveCode} className="flex-1 overflow-y-auto p-5 space-y-4 flex flex-col">
            {error && (
              <div className="p-3 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900/60 text-rose-700 dark:text-rose-300 text-xs rounded-xl">
                {error}
              </div>
            )}

            {success && (
              <div className="p-3 bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-900/60 text-emerald-800 dark:text-emerald-300 text-xs rounded-xl flex items-center gap-1.5">
                <CheckCircle2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
                <span>{success}</span>
              </div>
            )}

            {loading ? (
              <div className="py-16 flex flex-col items-center justify-center text-zinc-400 dark:text-zinc-500 gap-2">
                <Loader2 className="w-5 h-5 animate-spin-fast text-zinc-700 dark:text-zinc-300" />
                <p className="text-xs">正在读取扩展代码...</p>
              </div>
            ) : (
              <>
                <div>
                  <label className="block text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-1.5">
                    扩展标识
                  </label>
                  <input
                    type="text"
                    value={extId}
                    onChange={(e) => setExtId(e.target.value)}
                    placeholder="例如：bash-guard 或 custom-tools"
                    disabled={isEditing}
                    className="w-full h-8 px-2.5 text-xs bg-zinc-50 dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 dark:placeholder:text-zinc-500 border border-zinc-200 dark:border-zinc-800 rounded-lg focus:bg-white dark:focus:bg-zinc-950 focus:outline-none focus:ring-2 focus:ring-zinc-900 dark:focus:ring-zinc-400 font-mono disabled:opacity-60 transition-colors"
                    required
                  />
                  <p className="text-[11px] text-zinc-400 dark:text-zinc-500 mt-1">
                    对应节点路径：<code>~/.botd/extensions/{extId || '<扩展标识>'}/index.ts</code>
                  </p>
                </div>

                <div className="flex-1 flex flex-col min-h-[260px]">
                  <div className="flex items-center justify-between mb-1.5">
                    <label className="text-xs font-medium text-zinc-700 dark:text-zinc-300 flex items-center gap-1.5">
                      <FileCode className="w-3.5 h-3.5 text-zinc-500 dark:text-zinc-400" />
                      <span>TypeScript 扩展代码 (index.ts)</span>
                    </label>
                    <span className="text-[11px] text-zinc-400 dark:text-zinc-500">
                      导出 default function(pi: ExtensionAPI)
                    </span>
                  </div>
                  <textarea
                    value={content}
                    onChange={(e) => setContent(e.target.value)}
                    placeholder="在此编写 Pi 扩展 TypeScript 代码..."
                    className="flex-1 w-full p-2.5 text-xs bg-zinc-50 dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 dark:placeholder:text-zinc-500 border border-zinc-200 dark:border-zinc-800 rounded-lg focus:bg-white dark:focus:bg-zinc-950 focus:outline-none focus:ring-2 focus:ring-zinc-900 dark:focus:ring-zinc-400 font-mono leading-relaxed transition-colors"
                    rows={13}
                    required
                  />
                </div>
              </>
            )}

            <div className="pt-2 flex items-center justify-between border-t border-zinc-100 dark:border-zinc-800/60 shrink-0">
              <div>
                {isEditing && (
                  <button
                    type="button"
                    onClick={() => setConfirmDeleteOpen(true)}
                    disabled={saving || deleting || loading}
                    className="px-3 py-1.5 text-xs font-medium text-rose-600 hover:bg-rose-50 dark:text-rose-400 dark:hover:bg-rose-950/40 disabled:opacity-50 rounded-lg flex items-center gap-1.5 transition-colors"
                  >
                    {deleting ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin-fast" />
                    ) : (
                      <Trash2 className="w-3.5 h-3.5" />
                    )}
                    <span>删除扩展</span>
                  </button>
                )}
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={onClose}
                  disabled={saving || deleting}
                  className="px-3.5 py-1.5 text-xs font-medium text-zinc-600 hover:text-zinc-900 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:text-zinc-100 dark:hover:bg-zinc-800 rounded-lg transition-colors"
                >
                  取消
                </button>
                <button
                  type="submit"
                  disabled={saving || deleting || loading}
                  className="px-4 py-1.5 bg-zinc-900 hover:bg-zinc-800 text-white dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white disabled:bg-zinc-300 dark:disabled:bg-zinc-800 dark:disabled:text-zinc-500 text-xs font-medium rounded-lg shadow-xs flex items-center gap-1.5 transition-colors"
                >
                  {saving ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin-fast" />
                  ) : (
                    <Save className="w-3.5 h-3.5" />
                  )}
                  <span>保存扩展</span>
                </button>
              </div>
            </div>
          </form>
        )}

        {/* Tab 2: Install Mode */}
        {!isEditing && activeTab === 'install' && (
          <form onSubmit={handleInstall} className="flex-1 overflow-y-auto p-5 space-y-4 flex flex-col">
            {error && (
              <div className="p-3 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900/60 text-rose-700 dark:text-rose-300 text-xs rounded-xl">
                {error}
              </div>
            )}

            {success && (
              <div className="p-3 bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-900/60 text-emerald-800 dark:text-emerald-300 text-xs rounded-xl flex items-center gap-1.5">
                <CheckCircle2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
                <span>{success}</span>
              </div>
            )}

            <div>
              <label className="block text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-1.5 flex items-center gap-1.5">
                <Globe className="w-3.5 h-3.5 text-zinc-600 dark:text-zinc-400" />
                <span>安装来源</span>
              </label>
              <input
                type="text"
                value={source}
                onChange={(e) => setSource(e.target.value)}
                placeholder="例如: https://github.com/owner/repo 或 npm:@scope/pi-extension"
                className="w-full h-8 px-2.5 text-xs bg-zinc-50 dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 dark:placeholder:text-zinc-500 border border-zinc-200 dark:border-zinc-800 rounded-lg focus:bg-white dark:focus:bg-zinc-950 focus:outline-none focus:ring-2 focus:ring-zinc-900 dark:focus:ring-zinc-400 font-mono transition-colors"
                required
              />
              <p className="text-[11px] text-zinc-500 dark:text-zinc-400 mt-1 leading-relaxed">
                支持 Git 仓库根目录、GitHub 单目录 URL (如 <code>https://github.com/owner/repo/tree/main/skills/herdr</code>) 或 <code>npm:&lt;包名&gt;</code>
              </p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-1.5">
                  资源类型
                </label>
                <select
                  value={kind}
                  onChange={(e) => setKind(e.target.value as 'auto' | 'skill' | 'extension')}
                  className="w-full h-8 px-2.5 text-xs bg-zinc-50 dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 border border-zinc-200 dark:border-zinc-800 rounded-lg focus:bg-white dark:focus:bg-zinc-950 focus:outline-none focus:ring-2 focus:ring-zinc-900 dark:focus:ring-zinc-400 font-sans transition-colors"
                >
                  <option value="auto" className="bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100">自动识别</option>
                  <option value="extension" className="bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100">扩展插件</option>
                  <option value="skill" className="bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100">技能文档</option>
                </select>
                <p className="text-[11px] text-zinc-400 dark:text-zinc-500 mt-1">
                  选择「自动识别」将根据仓库内容自动检测
                </p>
              </div>

              <div>
                <label className="block text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-1.5">
                  自定义标识（可选）
                </label>
                <input
                  type="text"
                  value={customId}
                  onChange={(e) => setCustomId(e.target.value)}
                  placeholder="留空则自动从 URL 或包名提取"
                  className="w-full h-8 px-2.5 text-xs bg-zinc-50 dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 dark:placeholder:text-zinc-500 border border-zinc-200 dark:border-zinc-800 rounded-lg focus:bg-white dark:focus:bg-zinc-950 focus:outline-none focus:ring-2 focus:ring-zinc-900 dark:focus:ring-zinc-400 font-mono transition-colors"
                />
                <p className="text-[11px] text-zinc-400 dark:text-zinc-500 mt-1">
                  安装后的本地文件夹名称
                </p>
              </div>
            </div>

            <div className="p-3 bg-zinc-50 dark:bg-zinc-900 border border-zinc-200/80 dark:border-zinc-800/80 rounded-xl text-xs text-zinc-600 dark:text-zinc-400 leading-relaxed">
              <span className="font-semibold text-zinc-800 dark:text-zinc-200">安装机制说明：</span>
              <ul className="list-disc list-inside mt-1 space-y-0.5 text-[11px] text-zinc-500 dark:text-zinc-400">
                <li>由当前计算节点的 Node Agent 进程直接执行 Git 克隆或 npm 下载。</li>
                <li>扩展将保存至 <code>~/.botd/extensions/&lt;标识&gt;/</code>，技能将保存至 <code>~/.botd/skills/&lt;标识&gt;/</code>。</li>
                <li>安装完成后，智能体即可在配置中勾选启用。</li>
              </ul>
            </div>

            <div className="mt-auto pt-4 flex items-center justify-end gap-2 border-t border-zinc-100 dark:border-zinc-800/60 shrink-0">
              <button
                type="button"
                onClick={onClose}
                disabled={installing}
                className="px-3.5 py-1.5 text-xs font-medium text-zinc-600 hover:text-zinc-900 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:text-zinc-100 dark:hover:bg-zinc-800 rounded-lg transition-colors"
              >
                取消
              </button>
              <button
                type="submit"
                disabled={installing}
                className="px-4 py-1.5 bg-zinc-900 hover:bg-zinc-800 text-white dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white disabled:bg-zinc-300 dark:disabled:bg-zinc-800 dark:disabled:text-zinc-500 text-xs font-medium rounded-lg shadow-xs flex items-center gap-1.5 transition-colors"
              >
                {installing ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin-fast" />
                ) : (
                  <Download className="w-3.5 h-3.5" />
                )}
                <span>{installing ? '正在下载与安装...' : '立即安装'}</span>
              </button>
            </div>
          </form>
        )}
      </div>
    </div>

      <ConfirmDialog
        isOpen={confirmDeleteOpen}
        title="删除扩展"
        danger
        busy={deleting}
        confirmText="删除"
        onConfirm={handleDelete}
        onClose={() => {
          if (!deleting) setConfirmDeleteOpen(false);
        }}
        message={
          <>
            确定要从计算节点「{nodeName}」删除扩展「<span className="font-mono">{initialExtId}</span>」吗？
            <br />
            该操作不可逆，删除后无法恢复。
          </>
        }
      />
    </>
  );
};

