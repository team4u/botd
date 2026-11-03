import React, { useState, useEffect, useCallback } from 'react';
import {
  X,
  Users,
  Loader2,
  Plus,
  Trash2,
  KeyRound,
  ShieldCheck,
  AlertCircle,
  RefreshCw,
} from 'lucide-react';
import { api } from '../api';
import { ConfirmDialog } from './ConfirmDialog';
import type { UserRecord } from '@botd/protocol';

interface UsersModalProps {
  isOpen: boolean;
  currentUser: UserRecord;
  onClose: () => void;
}

const USERNAME_PATTERN = /^[a-zA-Z0-9_-]{2,32}$/;

function formatCreatedAt(iso?: string): string {
  if (!iso) return '-';
  const time = new Date(iso).getTime();
  if (!Number.isFinite(time)) return '-';
  const d = new Date(time);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

export const UsersModal: React.FC<UsersModalProps> = ({ isOpen, currentUser, onClose }) => {
  const [users, setUsers] = useState<UserRecord[]>([]);
  const [loading, setLoading] = useState(false);

  // 新建用户表单
  const [newUsername, setNewUsername] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newRole, setNewRole] = useState<'admin' | 'member'>('member');
  const [creating, setCreating] = useState(false);

  const [error, setError] = useState<string | null>(null);

  // ConfirmDialog state
  const [deleteTarget, setDeleteTarget] = useState<UserRecord | null>(null);
  const [deletingUser, setDeletingUser] = useState(false);
  const [resetTarget, setResetTarget] = useState<UserRecord | null>(null);
  const [resettingPassword, setResettingPassword] = useState(false);

  const fetchUsers = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await api.listUsers();
      setUsers(list || []);
    } catch (err: any) {
      setError(err?.message || '读取用户列表失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isOpen) {
      setNewUsername('');
      setNewPassword('');
      setNewRole('member');
      setError(null);
      return;
    }
    fetchUsers();
  }, [isOpen, fetchUsers]);

  if (!isOpen) return null;

  const handleCreateUser = async (e: React.FormEvent) => {
    e.preventDefault();
    const username = newUsername.trim();
    if (!USERNAME_PATTERN.test(username)) {
      setError('用户名仅支持字母、数字、下划线与短横线，长度 2-32 位');
      return;
    }
    if (users.some((u) => u.username === username)) {
      setError(`用户名 "${username}" 已存在`);
      return;
    }
    if (newPassword.length < 4) {
      setError('密码至少需要 4 位');
      return;
    }

    setCreating(true);
    setError(null);
    try {
      await api.createUser({ username, password: newPassword, role: newRole });
      setNewUsername('');
      setNewPassword('');
      setNewRole('member');
      await fetchUsers();
    } catch (err: any) {
      setError(err?.message || '创建用户失败');
    } finally {
      setCreating(false);
    }
  };

  const handleDeleteUser = async (user: UserRecord) => {
    if (user.id === currentUser.id) return; // 当前登录用户禁删，后端亦会拦截
    setDeleteTarget(user);
  };

  const confirmDeleteUser = async () => {
    if (!deleteTarget) return;
    setDeletingUser(true);
    setError(null);
    try {
      await api.deleteUser(deleteTarget.id);
      setDeleteTarget(null);
      await fetchUsers();
    } catch (err: any) {
      if (err?.status === 409) {
        setError(`用户 "${deleteTarget.username}" 名下还有节点，无法删除`);
      } else {
        setError(err?.message || '删除用户失败');
      }
      setDeleteTarget(null);
    } finally {
      setDeletingUser(false);
    }
  };

  const handleResetPassword = (user: UserRecord) => {
    setResetTarget(user);
  };

  const confirmResetPassword = async (password?: string) => {
    if (!resetTarget || password === undefined) return;
    setResettingPassword(true);
    setError(null);
    try {
      await api.resetUserPassword(resetTarget.id, password);
      setResetTarget(null);
      setError(null);
      await fetchUsers();
    } catch (err: any) {
      setError(err?.message || '重置密码失败');
      setResetTarget(null);
    } finally {
      setResettingPassword(false);
    }
  };

  return (
    <>
    <div
      className="fixed inset-0 z-50 bg-black/40 dark:bg-black/70 backdrop-blur-xs flex items-end sm:items-center justify-center p-0 sm:p-4 overflow-y-auto animate-in fade-in"
      role="dialog"
      aria-modal="true"
      aria-labelledby="users-modal-title"
    >
      <div className="bg-white dark:bg-zinc-950 rounded-t-2xl sm:rounded-2xl shadow-2xl border border-zinc-200/80 dark:border-zinc-800/80 w-full sm:max-w-lg overflow-hidden flex flex-col max-h-[90dvh]">
        {/* 移动端手柄条 */}
        <div className="w-10 h-1 bg-zinc-300 dark:bg-zinc-700 rounded-full mx-auto my-2 sm:hidden shrink-0" />

        {/* 弹窗头部 */}
        <div className="px-5 py-3.5 sm:px-6 sm:py-4 border-b border-zinc-100 dark:border-zinc-800/60 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-xl bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900 flex items-center justify-center shadow-xs">
              <Users className="w-4 h-4" />
            </div>
            <div>
              <h2 id="users-modal-title" className="text-sm sm:text-base font-semibold text-zinc-900 dark:text-zinc-100">
                用户管理
              </h2>
              <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
                管理团队成员账号及其角色权限
              </p>
            </div>
          </div>

          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => fetchUsers()}
              disabled={loading}
              className="p-1.5 text-zinc-400 hover:text-zinc-700 dark:text-zinc-500 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded-lg transition-colors"
              title="刷新用户列表"
            >
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            </button>
            <button
              onClick={onClose}
              className="p-1.5 text-zinc-400 hover:text-zinc-700 dark:text-zinc-500 dark:hover:text-zinc-200 rounded-lg hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
              aria-label="关闭对话框"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* 错误提示 */}
        {error && (
          <div className="mx-4 sm:mx-6 mt-3 p-3 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900/60 text-rose-700 dark:text-rose-300 text-xs rounded-xl flex items-start gap-2 shrink-0">
            <AlertCircle className="w-4 h-4 text-rose-500 dark:text-rose-400 shrink-0 mt-0.5" />
            <div className="flex-1">{error}</div>
          </div>
        )}

        {/* 内容区 */}
        <div className="flex-1 overflow-y-auto px-4 sm:px-6 py-4 space-y-5">
          {/* 用户列表 */}
          <div className="space-y-2">
            <span className="text-xs font-semibold text-zinc-900 dark:text-zinc-100">
              团队成员 ({users.length})
            </span>

            {loading && users.length === 0 ? (
              <div className="py-8 flex flex-col items-center justify-center text-zinc-400 dark:text-zinc-500 gap-2">
                <Loader2 className="w-4 h-4 animate-spin" />
                <span className="text-xs">加载用户列表...</span>
              </div>
            ) : (
              <div className="border border-zinc-200 dark:border-zinc-800 rounded-xl overflow-hidden bg-white dark:bg-zinc-950 shadow-2xs divide-y divide-zinc-100 dark:divide-zinc-800">
                {users.map((user) => {
                  const isSelf = user.id === currentUser.id;
                  return (
                    <div
                      key={user.id}
                      className="px-3 py-2.5 flex items-center justify-between gap-2 hover:bg-zinc-50/70 dark:hover:bg-zinc-900/70 transition-colors"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className="text-xs font-semibold text-zinc-900 dark:text-zinc-100 truncate">
                            {user.username}
                          </span>
                          {isSelf && (
                            <span className="text-[11px] px-1.5 py-0.5 bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 rounded font-medium">
                              当前用户
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-2 mt-0.5 text-[11px]">
                          {user.role === 'admin' ? (
                            <span className="inline-flex items-center gap-0.5 text-zinc-800 dark:text-zinc-200 bg-zinc-200/80 dark:bg-zinc-800/80 px-1.5 py-0.5 rounded-full font-medium">
                              <ShieldCheck className="w-2.5 h-2.5" />
                              <span>admin</span>
                            </span>
                          ) : (
                            <span className="text-zinc-500 dark:text-zinc-400 bg-zinc-100 dark:bg-zinc-800/80 px-1.5 py-0.5 rounded-full font-medium">
                              member
                            </span>
                          )}
                          <span className="text-zinc-400 dark:text-zinc-500 font-mono">
                            {formatCreatedAt(user.createdAt)}
                          </span>
                        </div>
                      </div>

                      <div className="flex items-center gap-1 shrink-0">
                        <button
                          type="button"
                          onClick={() => handleResetPassword(user)}
                          className="p-1.5 text-zinc-400 hover:text-zinc-700 dark:text-zinc-500 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded-lg transition-colors"
                          title="重置密码"
                        >
                          <KeyRound className="w-3.5 h-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDeleteUser(user)}
                          disabled={isSelf}
                          className="p-1.5 text-zinc-400 hover:text-rose-600 dark:hover:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/40 rounded-lg transition-colors disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-zinc-400"
                          title={isSelf ? '不能删除当前登录用户' : '删除用户'}
                          aria-label={`删除用户 ${user.username}`}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* 新建用户 */}
          <form
            onSubmit={handleCreateUser}
            className="p-4 bg-zinc-50/70 dark:bg-zinc-900/70 border border-zinc-200/90 dark:border-zinc-800/90 rounded-2xl space-y-3"
          >
            <span className="text-xs font-semibold text-zinc-900 dark:text-zinc-100 flex items-center gap-1.5">
              <Plus className="w-3.5 h-3.5" />
              <span>新建用户</span>
            </span>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
              <input
                type="text"
                value={newUsername}
                onChange={(e) => setNewUsername(e.target.value)}
                placeholder="用户名（2-32 位字母/数字/_/-）"
                className="w-full h-8 px-2.5 text-xs bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded-lg focus:outline-none focus:ring-1 focus:ring-zinc-900 dark:focus:ring-zinc-400 text-zinc-800 dark:text-zinc-200 placeholder:text-zinc-400 dark:placeholder:text-zinc-500"
                autoComplete="off"
                disabled={creating}
                required
              />
              <input
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="密码（至少 4 位）"
                className="w-full h-8 px-2.5 text-xs bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded-lg focus:outline-none focus:ring-1 focus:ring-zinc-900 dark:focus:ring-zinc-400 text-zinc-800 dark:text-zinc-200 placeholder:text-zinc-400 dark:placeholder:text-zinc-500"
                autoComplete="new-password"
                disabled={creating}
                required
              />
            </div>

            <div className="flex items-center gap-2">
              <label className="text-xs font-medium text-zinc-700 dark:text-zinc-300 shrink-0">角色:</label>
              <select
                value={newRole}
                onChange={(e) => setNewRole(e.target.value as 'admin' | 'member')}
                className="h-8 px-2.5 text-xs bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded-lg focus:outline-none focus:ring-1 focus:ring-zinc-900 dark:focus:ring-zinc-400 font-medium text-zinc-800 dark:text-zinc-200"
                aria-label="新用户角色"
                disabled={creating}
              >
                <option value="member" className="dark:bg-zinc-900 dark:text-zinc-100">member · 成员</option>
                <option value="admin" className="dark:bg-zinc-900 dark:text-zinc-100">admin · 管理员</option>
              </select>
            </div>

            <button
              type="submit"
              disabled={creating || !newUsername.trim() || !newPassword}
              className="w-full py-2 bg-zinc-900 hover:bg-zinc-800 disabled:bg-zinc-300 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white dark:disabled:bg-zinc-800 dark:disabled:text-zinc-600 text-white text-xs font-semibold rounded-xl shadow-xs flex items-center justify-center gap-1.5 transition-colors cursor-pointer disabled:cursor-not-allowed"
            >
              {creating ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  <span>正在创建...</span>
                </>
              ) : (
                <>
                  <Plus className="w-3.5 h-3.5" />
                  <span>创建用户</span>
                </>
              )}
            </button>
          </form>
        </div>
      </div>
    </div>

    {/* 删除用户确认 */}
    <ConfirmDialog
      isOpen={Boolean(deleteTarget)}
      title="删除用户"
      message={
        <>
          确定要删除用户「{deleteTarget?.username}」吗？
          <br />
          删除后不可恢复。
        </>
      }
      confirmText="删除"
      danger
      busy={deletingUser}
      onConfirm={confirmDeleteUser}
      onClose={() => setDeleteTarget(null)}
    />

    {/* 重置密码：弹窗内置密码输入 */}
    <ConfirmDialog
      isOpen={Boolean(resetTarget)}
      title="重置密码"
      message={
        <>
          为用户「{resetTarget?.username}」设置新密码。
        </>
      }
      confirmText="重置"
      busy={resettingPassword}
      prompt={{
        type: 'password',
        label: '新密码（至少 4 位）',
        placeholder: '输入新密码（至少 4 位）',
      }}
      validatePrompt={(v) => v.length >= 4}
      onConfirm={confirmResetPassword}
      onClose={() => setResetTarget(null)}
    />
    </>
  );
};
