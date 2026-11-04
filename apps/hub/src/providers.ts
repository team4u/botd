import { randomUUID } from 'node:crypto';
import type { Hono } from 'hono';
import { isSafeId, type ProviderAuthType, type ProviderLoginState, type UserRecord } from '@botd/protocol';
import type { HubDatabase } from './db.js';
import { resolveOwnedNode } from './http-helpers.js';
import { listEffectiveProviderCredentials, loadStoredProviders, removeLegacyProviderAuth } from './credential-store.js';

let builtinCatalogPromise: Promise<ReturnType<typeof import('@botd/models').getBuiltinModelCatalog>> | undefined;
function getCachedBuiltinCatalog() {
  return (builtinCatalogPromise ??= import('@botd/models').then(m => m.getBuiltinModelCatalog()));
}
let builderPromise: Promise<typeof import('@botd/models').buildModelCatalog> | undefined;
function getCachedBuilder() {
  return (builderPromise ??= import('@botd/models').then(m => m.buildModelCatalog));
}

/** Hub 内存中的登录会话（api_key 输入流） */
interface HubLoginSession extends ProviderLoginState {
  /** 已收到的应答值（仅 api_key 流使用；不回传给客户端） */
  submittedValue?: string;
}

/**
 * Provider 凭据登录与模型目录：全部在 Hub 完成，不经 nodeRpc。
 * - api_key：创建 pending 登录会话 → 客户端提交 key → 落库 provider_credentials
 * - oauth：Hub 暂不承载（需浏览器回调），返回 501 明确语义
 */
export function registerProviderRoutes(
  app: Hono<{ Variables: { user: UserRecord } }>,
  db: HubDatabase,
  options?: { onCredentialSaved?: () => void },
): void {
  const loginSessions = new Map<string, HubLoginSession>();

  const hubCatalog = async () => {
    const [builtin, buildModelCatalog] = await Promise.all([getCachedBuiltinCatalog(), getCachedBuilder()]);
    const storedProviders = loadStoredProviders(db.getDataDir());
    const storedCatalog = buildModelCatalog(storedProviders);
    // 凭据状态：SQLite 与 `.agent/auth.json` 合并（SQLite 胜出）
    const credentials = new Map(
      listEffectiveProviderCredentials(db).map((c) => [c.providerId, c.authType])
    );
    const usedProviders = new Set(db.getAllBots().map((bot) => bot.modelProvider));

    // 合并：内置目录为基底，存储 provider（models-store.json / models.json）
    // 已存在同名则用其模型覆盖（非空时），否则追加；最后按名称排序。
    // builtin 的 configured 仅由凭据决定（保持注销语义）；存储 provider 有
    // 模型或被任何 Bot 引用即可选（无凭据也可先选型）。
    const storedById = new Map(storedCatalog.providers.map((p) => [p.id, p]));
    const providers = builtin.providers.map((provider) => {
      const authType = credentials.get(provider.id);
      const stored = storedById.get(provider.id);
      // 同名存储 provider 只覆盖模型列表；authMethods 保持内置定义
      //（如 anthropic 的 oauth 入口不能因动态目录缓存丢失）
      const entry = stored && stored.models.length > 0
        ? { ...provider, models: stored.models }
        : { ...provider };
      return {
        ...entry,
        configured: authType !== undefined,
        ...(authType !== undefined ? { credentialType: authType } : {}),
      };
    });
    for (const stored of storedCatalog.providers) {
      // 与内置目录同名的 provider 已在上面的 map 中合并（模型覆盖），这里只追加新 provider
      if (builtin.providers.some((p) => p.id === stored.id)) continue;
      const authType = credentials.get(stored.id);
      const usable = authType !== undefined || stored.models.length > 0 || usedProviders.has(stored.id);
      providers.push({
        ...stored,
        configured: usable,
        ...(authType !== undefined ? { credentialType: authType } : usable ? { credentialType: 'api_key' as const } : {}),
      });
    }
    providers.sort((a, b) => a.name.localeCompare(b.name));
    return { ...builtin, providers };
  };

  const startLogin = async (
    providerId: string,
    method: ProviderAuthType
  ): Promise<{ ok: true; state: ProviderLoginState } | { ok: false; error: string }> => {
    if (method !== 'api_key') {
      return { ok: false, error: 'OAuth 登录暂由节点 CLI 承载，Hub 直连目前支持 api_key' };
    }
    const catalog = await getCachedBuiltinCatalog();
    const builtinProvider = catalog.providers.find((p) => p.id === providerId);
    // 存储目录（models-store.json / models.json）里的动态 provider（如 magpie）也可登录
    const storedProvider = builtinProvider
      ? undefined
      : loadStoredProviders(db.getDataDir()).find((p) => p.id === providerId);
    const providerName = builtinProvider?.name ?? storedProvider?.name;
    if (providerName === undefined) {
      return { ok: false, error: `Unknown provider: ${providerId}` };
    }
    const id = `login_${randomUUID()}`;
    const state: HubLoginSession = {
      id,
      providerId,
      method,
      status: 'pending',
      events: [{ type: 'info', message: '等待输入 API Key' }],
      prompt: { id: 'api_key', type: 'secret', message: `Enter API Key for ${providerName}` },
    };
    loginSessions.set(id, state);
    // 过期清理：30 分钟未被应答的登录会话自动作废
    setTimeout(() => {
      const session = loginSessions.get(id);
      if (session && session.status === 'pending') {
        session.status = 'cancelled';
        session.prompt = undefined;
        loginSessions.delete(id);
      }
    }, 30 * 60 * 1000).unref();
    return { ok: true, state: { ...state, prompt: state.prompt } };
  };

  const respondLogin = (loginId: string, promptId: string, value: string): ProviderLoginState | undefined => {
    const session = loginSessions.get(loginId);
    if (!session) return undefined;
    if (session.status !== 'pending' || !session.prompt) return session;
    if (promptId !== session.prompt.id) {
      return { ...session, status: 'error', error: 'Invalid prompt id', prompt: undefined };
    }
    if (!value.trim()) {
      return { ...session, status: 'error', error: 'API Key 不能为空', prompt: undefined };
    }
    db.saveProviderCredential({ providerId: session.providerId, authType: 'api_key', apiKey: value.trim() });
    session.status = 'success';
    session.prompt = undefined;
    session.events.push({ type: 'progress', message: 'API Key 已保存到 Hub' });
    options?.onCredentialSaved?.();
    // 绝不回显 key 本体
    return { ...session };
  };

  const getLogin = (loginId: string): ProviderLoginState | undefined => loginSessions.get(loginId);

  const cancelLogin = (loginId: string): boolean => {
    const session = loginSessions.get(loginId);
    if (!session) return false;
    session.status = 'cancelled';
    session.prompt = undefined;
    loginSessions.delete(loginId);
    return true;
  };

  const logout = (providerId: string): void => {
    db.deleteProviderCredential(providerId);
    // 同时清理 `.agent/auth.json` 里的旧凭据，避免注销后仍从旧文件回读
    removeLegacyProviderAuth(db.getDataDir(), providerId);
  };

  // --- 模型目录与 Provider 登录（Hub 全局路由） ---

  app.get('/api/models/catalog', async c => {
    const nodeId = c.req.query('nodeId');
    if (nodeId) {
      // 保留节点归属校验语义，但目录一律返回 Hub 侧结果（不再依赖节点在线）
      const nodeRes = resolveOwnedNode(c, db, nodeId);
      if (!nodeRes.ok) return nodeRes.response;
    }
    return c.json(await hubCatalog());
  });

  app.post('/api/providers/:providerId/login', async c => {
    const { providerId } = c.req.param();
    if (!isSafeId(providerId)) return c.json({ error: 'Invalid provider id' }, 400);
    const input = await c.req.json<{ method?: ProviderAuthType }>().catch(() => null);
    if (!input || !['api_key', 'oauth'].includes(input.method ?? '')) return c.json({ error: 'Invalid login method' }, 400);
    const result = await startLogin(providerId, input.method!);
    if (!result.ok) return c.json({ error: result.error }, 501);
    return c.json(result.state);
  });

  app.get('/api/provider-logins/:loginId', c => {
    const { loginId } = c.req.param();
    if (!isSafeId(loginId)) return c.json({ error: 'Invalid login id' }, 400);
    const state = getLogin(loginId);
    if (!state) return c.json({ error: 'Login not found' }, 404);
    return c.json(state);
  });

  app.post('/api/provider-logins/:loginId/respond', async c => {
    const { loginId } = c.req.param();
    if (!isSafeId(loginId)) return c.json({ error: 'Invalid login id' }, 400);
    const input = await c.req.json<{ promptId?: string; value?: string }>().catch(() => null);
    if (!input || typeof input.promptId !== 'string' || typeof input.value !== 'string' || input.value.length > 65_536) {
      return c.json({ error: 'Invalid login response' }, 400);
    }
    const state = respondLogin(loginId, input.promptId, input.value);
    if (!state) return c.json({ error: 'Login not found' }, 404);
    return c.json(state);
  });

  app.delete('/api/provider-logins/:loginId', c => {
    const { loginId } = c.req.param();
    if (!isSafeId(loginId)) return c.json({ error: 'Invalid login id' }, 400);
    if (!cancelLogin(loginId)) return c.json({ error: 'Login not found' }, 404);
    return c.json({ ok: true });
  });

  app.delete('/api/providers/:providerId/auth', c => {
    const { providerId } = c.req.param();
    if (!isSafeId(providerId)) return c.json({ error: 'Invalid provider id' }, 400);
    logout(providerId);
    return c.json({ ok: true });
  });

  // 凭据状态（不含密钥本体）
  app.get('/api/providers/:providerId/credentials', c => {
    const { providerId } = c.req.param();
    if (!isSafeId(providerId)) return c.json({ error: 'Invalid provider id' }, 400);
    const credential = db.getProviderCredential(providerId);
    return c.json({
      configured: credential !== undefined,
      ...(credential ? { authType: credential.authType, updatedAt: credential.updatedAt } : {}),
    });
  });

  // --- 节点维度别名：映射到同一 Hub 实现（仅保留归属校验） ---

  app.post('/api/nodes/:nodeId/providers/:providerId/login', async c => {
    const { nodeId, providerId } = c.req.param();
    const nodeRes = resolveOwnedNode(c, db, nodeId);
    if (!nodeRes.ok) return nodeRes.response;
    if (!isSafeId(providerId)) return c.json({ error: 'Invalid provider id' }, 400);
    const input = await c.req.json<{ method?: ProviderAuthType }>().catch(() => null);
    if (!input || !['api_key', 'oauth'].includes(input.method ?? '')) return c.json({ error: 'Invalid login method' }, 400);
    const result = await startLogin(providerId, input.method!);
    if (!result.ok) return c.json({ error: result.error }, 501);
    return c.json(result.state);
  });

  app.get('/api/nodes/:nodeId/provider-logins/:loginId', c => {
    const { nodeId, loginId } = c.req.param();
    const nodeRes = resolveOwnedNode(c, db, nodeId);
    if (!nodeRes.ok) return nodeRes.response;
    if (!isSafeId(loginId)) return c.json({ error: 'Invalid login id' }, 400);
    const state = getLogin(loginId);
    if (!state) return c.json({ error: 'Login not found' }, 404);
    return c.json(state);
  });

  app.post('/api/nodes/:nodeId/provider-logins/:loginId/respond', async c => {
    const { nodeId, loginId } = c.req.param();
    const nodeRes = resolveOwnedNode(c, db, nodeId);
    if (!nodeRes.ok) return nodeRes.response;
    if (!isSafeId(loginId)) return c.json({ error: 'Invalid login id' }, 400);
    const input = await c.req.json<{ promptId?: string; value?: string }>().catch(() => null);
    if (!input || typeof input.promptId !== 'string' || typeof input.value !== 'string' || input.value.length > 65_536) {
      return c.json({ error: 'Invalid login response' }, 400);
    }
    const state = respondLogin(loginId, input.promptId, input.value);
    if (!state) return c.json({ error: 'Login not found' }, 404);
    return c.json(state);
  });

  app.delete('/api/nodes/:nodeId/provider-logins/:loginId', c => {
    const { nodeId, loginId } = c.req.param();
    const nodeRes = resolveOwnedNode(c, db, nodeId);
    if (!nodeRes.ok) return nodeRes.response;
    if (!isSafeId(loginId)) return c.json({ error: 'Invalid login id' }, 400);
    if (!cancelLogin(loginId)) return c.json({ error: 'Login not found' }, 404);
    return c.json({ ok: true });
  });

  app.delete('/api/nodes/:nodeId/providers/:providerId/auth', c => {
    const { nodeId, providerId } = c.req.param();
    const nodeRes = resolveOwnedNode(c, db, nodeId);
    if (!nodeRes.ok) return nodeRes.response;
    if (!isSafeId(providerId)) return c.json({ error: 'Invalid provider id' }, 400);
    logout(providerId);
    return c.json({ ok: true });
  });
}
