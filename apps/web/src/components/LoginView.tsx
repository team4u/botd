import React, { useState } from 'react';
import { User, Lock, Eye, EyeOff, Loader2, Bot, ShieldCheck } from 'lucide-react';
import { api } from '../api';

interface LoginViewProps {
  onLoginSuccess: () => void;
}

export const LoginView: React.FC<LoginViewProps> = ({ onLoginSuccess }) => {
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim()) {
      setError('请输入用户名');
      return;
    }
    if (!password.trim()) {
      setError('请输入密码');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      await api.login(username.trim(), password);
      onLoginSuccess();
    } catch (err: any) {
      setError(err?.message || '登录失败，请检查用户名和密码后重试');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950 flex flex-col justify-center items-center px-4 py-12">
      <div className="w-full max-w-sm bg-white dark:bg-zinc-900 rounded-2xl shadow-sm border border-zinc-200/80 dark:border-zinc-800 p-8">
        <div className="flex flex-col items-center text-center mb-8">
          <div className="w-12 h-12 rounded-2xl bg-zinc-900 dark:bg-zinc-100 flex items-center justify-center text-white dark:text-zinc-900 mb-4 shadow-sm">
            <Bot className="w-6 h-6" />
          </div>
          <h1 className="text-xl font-bold tracking-tight text-zinc-900 dark:text-zinc-100">
            botd 控制台登录
          </h1>
          <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">
            多节点个人智能体平台
          </p>
        </div>

        {error && (
          <div
            className="mb-5 p-3 bg-rose-50 dark:bg-rose-950/40 border border-rose-200/80 dark:border-rose-900/60 rounded-xl text-xs text-rose-700 dark:text-rose-300 flex items-start gap-2"
            role="alert"
          >
            <span className="font-semibold shrink-0">错误:</span>
            <span>{error}</span>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label
              htmlFor="login-username"
              className="block text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-1.5"
            >
              用户名
            </label>
            <div className="relative">
              <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-zinc-400 dark:text-zinc-500">
                <User className="w-4 h-4" />
              </div>
              <input
                id="login-username"
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="请输入用户名（默认 admin）"
                className="w-full h-8 pl-9 pr-3 px-2.5 text-xs bg-zinc-50/60 dark:bg-zinc-950/60 border border-zinc-200/90 dark:border-zinc-800 rounded-lg text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 dark:placeholder:text-zinc-500 focus:bg-white dark:focus:bg-zinc-950 focus:outline-none focus:ring-2 focus:ring-zinc-900/10 dark:focus:ring-zinc-400/20 focus:border-zinc-900 dark:focus:border-zinc-100 transition-colors"
                autoComplete="username"
                autoFocus
                required
                disabled={loading}
              />
            </div>
          </div>

          <div>
            <label
              htmlFor="login-password"
              className="block text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-1.5"
            >
              密码
            </label>
            <div className="relative">
              <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-zinc-400 dark:text-zinc-500">
                <Lock className="w-4 h-4" />
              </div>
              <input
                id="login-password"
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="请输入密码"
                className="w-full h-8 pl-9 pr-10 px-2.5 text-xs bg-zinc-50/60 dark:bg-zinc-950/60 border border-zinc-200/90 dark:border-zinc-800 rounded-lg text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 dark:placeholder:text-zinc-500 focus:bg-white dark:focus:bg-zinc-950 focus:outline-none focus:ring-2 focus:ring-zinc-900/10 dark:focus:ring-zinc-400/20 focus:border-zinc-900 dark:focus:border-zinc-100 transition-colors"
                autoComplete="current-password"
                required
                disabled={loading}
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute inset-y-0 right-0 pr-3 flex items-center text-zinc-400 dark:text-zinc-500 hover:text-zinc-600 dark:hover:text-zinc-300 focus:outline-none"
                aria-label={showPassword ? '隐藏密码' : '显示密码'}
              >
                {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
            <p className="text-[11px] text-zinc-400 dark:text-zinc-500 mt-1.5">
              默认账号 admin，密码由 BOTD_ADMIN_PASSWORD 初始化；成员账号由管理员分配
            </p>
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full py-2.5 px-4 bg-zinc-900 hover:bg-zinc-800 disabled:bg-zinc-300 dark:bg-zinc-100 dark:hover:bg-white dark:disabled:bg-zinc-800 text-white dark:text-zinc-900 dark:disabled:text-zinc-500 text-sm font-medium rounded-xl shadow-xs transition-colors flex items-center justify-center gap-2 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-zinc-900 dark:focus:ring-zinc-400 dark:focus:ring-offset-zinc-900 cursor-pointer disabled:cursor-not-allowed"
          >
            {loading ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin-fast" />
                <span>正在验证登录...</span>
              </>
            ) : (
              <>
                <ShieldCheck className="w-4 h-4" />
                <span>进入控制台</span>
              </>
            )}
          </button>
        </form>
      </div>

      <div className="mt-8 text-center text-xs text-zinc-400 dark:text-zinc-500">
        botd · 多节点个人智能体平台
      </div>
    </div>
  );
};
