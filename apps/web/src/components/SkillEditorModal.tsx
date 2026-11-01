import React, { useState, useEffect } from 'react';
import { X, Wrench, Save, Loader2, FileCode, CheckCircle2, Trash2 } from 'lucide-react';
import { ConfirmDialog } from './ConfirmDialog';
import { api } from '../api';

interface SkillEditorModalProps {
  isOpen: boolean;
  nodeId: string;
  nodeName: string;
  skillId?: string | null;
  onClose: () => void;
  onSaved: () => void;
}

const STARTER_SKILL_MD = `# 技能说明文档

## 概述
简要描述此技能的应用场景，以及智能体应当在何时调用该技能。

## 命令与使用方法
智能体可通过内置终端工具在所属计算节点直接执行以下命令：
\`\`\`bash
# 示例命令
echo "Hello from Skill"
\`\`\`

## 关键参数与返回值规范
- 参数 1: 说明
- 输出: 预期标准输出格式
`;

export const SkillEditorModal: React.FC<SkillEditorModalProps> = ({
  isOpen,
  nodeId,
  nodeName,
  skillId: initialSkillId,
  onClose,
  onSaved,
}) => {
  const isEditing = Boolean(initialSkillId);
  const [skillId, setSkillId] = useState(initialSkillId || '');
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setError(null);
      setSuccess(false);
      if (initialSkillId) {
        setSkillId(initialSkillId);
        setLoading(true);
        api.getSkill(nodeId, initialSkillId)
          .then((res) => {
            setContent(res.content || '');
          })
          .catch((err) => {
            setError(err?.message || '读取技能说明文档失败');
          })
          .finally(() => {
            setLoading(false);
          });
      } else {
        setSkillId('');
        setContent(STARTER_SKILL_MD);
      }
    }
  }, [isOpen, nodeId, initialSkillId]);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanId = skillId.trim();
    if (!cleanId) {
      setError('请输入技能标识');
      return;
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(cleanId)) {
      setError('技能标识仅允许包含英文字母、数字、下划线及短横线');
      return;
    }
    if (!content.trim()) {
      setError('技能说明文档内容不能为空');
      return;
    }

    setSaving(true);
    setError(null);

    try {
      await api.saveSkill(nodeId, cleanId, content);
      setSuccess(true);
      setTimeout(() => {
        onSaved();
        onClose();
      }, 600);
    } catch (err: any) {
      setError(err?.message || '保存技能失败');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!initialSkillId) return;

    setDeleting(true);
    setError(null);

    try {
      await api.deleteSkill(nodeId, initialSkillId);
      onSaved();
      onClose();
    } catch (err: any) {
      setError(err?.message || '删除技能失败');
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
      aria-labelledby="skill-editor-title"
    >
      <div className="bg-white dark:bg-zinc-950 rounded-t-2xl sm:rounded-2xl shadow-2xl border border-zinc-200/90 dark:border-zinc-800/90 max-w-2xl w-full max-h-[92dvh] flex flex-col pb-[max(1rem,env(safe-area-inset-bottom))] sm:pb-0 overflow-hidden">
        {/* Mobile Drag Handle */}
        <div className="w-10 h-1 bg-zinc-300 dark:bg-zinc-700 rounded-full mx-auto mt-2.5 mb-1 sm:hidden shrink-0" />

        {/* Header */}
        <div className="px-5 py-4 border-b border-zinc-100 dark:border-zinc-800/60 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 flex items-center justify-center border border-zinc-200/60 dark:border-zinc-700/60">
              <Wrench className="w-4 h-4" />
            </div>
            <div>
              <h2 id="skill-editor-title" className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                {isEditing ? `编辑技能: ${initialSkillId}` : '新建技能'}
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

        <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto p-5 space-y-4 flex flex-col">
          {error && (
            <div className="p-3 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900/60 text-rose-700 dark:text-rose-300 text-xs rounded-xl">
              {error}
            </div>
          )}

          {success && (
            <div className="p-3 bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-900/60 text-emerald-800 dark:text-emerald-300 text-xs rounded-xl flex items-center gap-1.5">
              <CheckCircle2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
              <span>技能说明文档已成功同步至该节点</span>
            </div>
          )}

          {loading ? (
            <div className="py-16 flex flex-col items-center justify-center text-zinc-400 dark:text-zinc-500 gap-2">
              <Loader2 className="w-5 h-5 animate-spin-fast text-zinc-700 dark:text-zinc-300" />
              <p className="text-xs">正在读取本地技能文档...</p>
            </div>
          ) : (
            <>
              <div>
                <label className="block text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-1.5">
                  技能标识
                </label>
                <input
                  type="text"
                  value={skillId}
                  onChange={(e) => setSkillId(e.target.value)}
                  placeholder="例如：custom-cli 或 git-flow"
                  disabled={isEditing}
                  className="w-full h-8 px-2.5 text-xs bg-zinc-50 dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 dark:placeholder:text-zinc-500 border border-zinc-200 dark:border-zinc-800 rounded-lg focus:bg-white dark:focus:bg-zinc-950 focus:outline-none focus:ring-2 focus:ring-zinc-900 dark:focus:ring-zinc-400 font-mono disabled:opacity-60 transition-colors"
                  required
                />
                <p className="text-[11px] text-zinc-400 dark:text-zinc-500 mt-1">
                  对应节点路径：<code>~/.botd/skills/{skillId || '<技能标识>'}/SKILL.md</code>
                </p>
              </div>

              <div className="flex-1 flex flex-col min-h-[260px]">
                <div className="flex items-center justify-between mb-1.5">
                  <label className="text-xs font-medium text-zinc-700 dark:text-zinc-300 flex items-center gap-1.5">
                    <FileCode className="w-3.5 h-3.5 text-zinc-500 dark:text-zinc-400" />
                    <span>技能说明文档 (SKILL.md)</span>
                  </label>
                  <span className="text-[11px] text-zinc-400 dark:text-zinc-500">
                    智能体将阅读此文档执行相关任务
                  </span>
                </div>
                <textarea
                  value={content}
                  onChange={(e) => setContent(e.target.value)}
                  placeholder="在此编写技能的 Markdown 说明文档..."
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
                  <span>删除技能</span>
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
                <span>保存技能</span>
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>

      <ConfirmDialog
        isOpen={confirmDeleteOpen}
        title="删除技能"
        danger
        busy={deleting}
        confirmText="删除"
        onConfirm={handleDelete}
        onClose={() => {
          if (!deleting) setConfirmDeleteOpen(false);
        }}
        message={
          <>
            确定要从计算节点「{nodeName}」删除技能「<span className="font-mono">{initialSkillId}</span>」吗？
            <br />
            该操作不可逆，删除后无法恢复。
          </>
        }
      />
    </>
  );
};

