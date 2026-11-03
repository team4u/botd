import { useCallback, useEffect, useState } from 'react';
import type { MainViewTab } from '../types';

// 全局 hash 路由：视图/当前会话/弹窗统一编码进 URL hash（如 #?v=nodes&s=xxx&m=settings），
// 页面重载/手机后台回收后原样恢复。不引路由库，hash 即状态单一来源。
export type ModalName = 'create' | 'settings' | 'users';

/** 会话内消息高亮定位：搜索跳转等场景通过 msg 参数携带目标消息 ID */
export interface HashRoute {
  view: MainViewTab;
  sessionId: string | null;
  modal: ModalName | null;
  messageId: string | null;
}

export type HashRoutePatch = Partial<HashRoute> | ((prev: HashRoute) => Partial<HashRoute>);
export type NavigateFn = (patch: HashRoutePatch) => void;

const parseHash = (): HashRoute => {
  const raw = window.location.hash.replace(/^#[?]?/, '');
  const params = new URLSearchParams(raw);
  const m = params.get('m');
  return {
    view: params.get('v') === 'nodes' ? 'nodes' : 'chat',
    sessionId: params.get('s'),
    modal: m === 'create' || m === 'settings' || m === 'users' ? m : null,
    messageId: params.get('msg'),
  };
};

const buildHash = (route: HashRoute): string => {
  const params = new URLSearchParams();
  if (route.view !== 'chat') params.set('v', route.view);
  if (route.sessionId) params.set('s', route.sessionId);
  if (route.modal) params.set('m', route.modal);
  if (route.messageId) params.set('msg', route.messageId);
  const qs = params.toString();
  return qs ? `#?${qs}` : '';
};

/**
 * hash 路由 hook：navigate 更新 route state，副作用同步到 URL（replaceState 不污染历史栈）；
 * 同时监听 hashchange（手动改 URL / 分享链接），从 hash 反向解析。
 */
export const useHashRoute = (): { route: HashRoute; navigate: NavigateFn } => {
  const [route, setRoute] = useState<HashRoute>(parseHash);

  const navigate = useCallback<NavigateFn>((patch) => {
    setRoute((prev) => ({ ...prev, ...(typeof patch === 'function' ? patch(prev) : patch) }));
  }, []);

  useEffect(() => {
    const hash = buildHash(route);
    window.history.replaceState(null, '', hash || window.location.pathname + window.location.search);
  }, [route]);

  useEffect(() => {
    const onHashChange = () => setRoute(parseHash());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  return { route, navigate };
};
