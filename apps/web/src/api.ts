import type {
  NodeWithBots,
  SaveBotInput,
  BotConfig,
  SessionRecord,
  CreateSessionInput,
  MessageRecord,
  SessionSseEvent,
  GlobalSseEvent,
  BgJobRecord,
  PairingResult,
  ModelCatalog,
  ProviderAuthType,
  ProviderLoginState,
  ChatCommand,
  ArtifactRecord,
  MessageAttachment,
  PendingAskRecord,
  TriggerRecord,
  CreateTriggerInput,
  MessageSearchHit,
  NodeUpgradeCheckResult,
  NodeUpgradeResult,
  SessionShareRecord,
  SharedSessionSnapshot,
  DelegateSessionInput,
  DelegateSessionResult,
} from '@botd/protocol';
import type { UserInfo } from './types.js';

export type { MessageSearchHit };

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

export class AuthRequiredError extends ApiError {
  constructor(message = '需要登录认证') {
    super(message, 401);
    this.name = 'AuthRequiredError';
  }
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers || {});
  if (!headers.has('Content-Type') && options.body && typeof options.body === 'string') {
    headers.set('Content-Type', 'application/json');
  }

  const response = await fetch(path, {
    ...options,
    headers,
    credentials: 'include',
  });

  if (response.status === 401) {
    throw new AuthRequiredError();
  }

  if (!response.ok) {
    let errorMsg = `请求失败: HTTP ${response.status}`;
    try {
      const errorJson = await response.json();
      if (errorJson && typeof errorJson.error === 'string') {
        errorMsg = errorJson.error;
      }
    } catch {
      // response is not JSON
    }
    throw new ApiError(errorMsg, response.status);
  }

  // Handle 204 or empty response
  if (response.status === 204) {
    return {} as T;
  }

  return response.json();
}

export const api = {
  // Auth
  async checkAuth(): Promise<boolean> {
    try {
      const res = await fetch('/api/auth/me', { credentials: 'include' });
      if (res.ok) {
        return true;
      }
      if (res.status === 401) {
        return false;
      }
      // If /api/auth/me not implemented, test with /api/nodes
      const testRes = await fetch('/api/nodes', { credentials: 'include' });
      return testRes.status !== 401;
    } catch {
      return false;
    }
  },

  async login(username: string, password: string): Promise<{ ok: boolean; user: UserInfo }> {
    return request<{ ok: boolean; user: UserInfo }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    });
  },

  async me(): Promise<{ authenticated: boolean; user: UserInfo }> {
    return request<{ authenticated: boolean; user: UserInfo }>('/api/auth/me');
  },

  async logout(): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>('/api/auth/logout', {
      method: 'POST',
    });
  },

  // Users（仅 admin，后端对非 admin 返回 403）
  async listUsers(): Promise<UserInfo[]> {
    return request<UserInfo[]>('/api/users');
  },

  async createUser(input: {
    username: string;
    password: string;
    role?: 'admin' | 'member';
  }): Promise<UserInfo> {
    return request<UserInfo>('/api/users', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  async deleteUser(userId: string): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>(`/api/users/${encodeURIComponent(userId)}`, {
      method: 'DELETE',
    });
  },

  async resetUserPassword(userId: string, password: string): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>(`/api/users/${encodeURIComponent(userId)}/password`, {
      method: 'PUT',
      body: JSON.stringify({ password }),
    });
  },

  async getModelCatalog(nodeId?: string): Promise<ModelCatalog> {
    const query = nodeId ? `?nodeId=${encodeURIComponent(nodeId)}` : '';
    return request<ModelCatalog>(`/api/models/catalog${query}`);
  },

  async startProviderLogin(
    nodeId: string,
    providerId: string,
    method: ProviderAuthType
  ): Promise<ProviderLoginState> {
    return request<ProviderLoginState>(
      `/api/nodes/${encodeURIComponent(nodeId)}/providers/${encodeURIComponent(providerId)}/login`,
      {
        method: 'POST',
        body: JSON.stringify({ method }),
      }
    );
  },

  async getProviderLogin(nodeId: string, loginId: string): Promise<ProviderLoginState> {
    return request<ProviderLoginState>(
      `/api/nodes/${encodeURIComponent(nodeId)}/provider-logins/${encodeURIComponent(loginId)}`
    );
  },

  async respondProviderLogin(
    nodeId: string,
    loginId: string,
    promptId: string,
    value: string
  ): Promise<ProviderLoginState> {
    return request<ProviderLoginState>(
      `/api/nodes/${encodeURIComponent(nodeId)}/provider-logins/${encodeURIComponent(loginId)}/respond`,
      {
        method: 'POST',
        body: JSON.stringify({ promptId, value }),
      }
    );
  },

  async cancelProviderLogin(nodeId: string, loginId: string): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>(
      `/api/nodes/${encodeURIComponent(nodeId)}/provider-logins/${encodeURIComponent(loginId)}`,
      {
        method: 'DELETE',
      }
    );
  },

  async logoutProviderAuth(nodeId: string, providerId: string): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>(
      `/api/nodes/${encodeURIComponent(nodeId)}/providers/${encodeURIComponent(providerId)}/auth`,
      {
        method: 'DELETE',
      }
    );
  },

  // Nodes & Pairing
  async getNodes(): Promise<NodeWithBots[]> {
    return request<NodeWithBots[]>('/api/nodes');
  },

  async createPairingCode(): Promise<PairingResult> {
    return request<PairingResult>('/api/nodes/pairing', {
      method: 'POST',
      body: JSON.stringify({}),
    });
  },

  async deleteNode(nodeId: string, force = false): Promise<{ ok: boolean }> {
    const query = force ? '?force=1' : '';
    return request<{ ok: boolean }>(`/api/nodes/${encodeURIComponent(nodeId)}${query}`, {
      method: 'DELETE',
    });
  },

  async restartNode(nodeId: string): Promise<{ ok: true; pid: number }> {
    return request(`/api/nodes/${encodeURIComponent(nodeId)}/restart`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
  },

  async checkNodeUpgrade(nodeId: string): Promise<NodeUpgradeCheckResult> {
    return request<NodeUpgradeCheckResult>(`/api/nodes/${encodeURIComponent(nodeId)}/upgrade/check`);
  },

  async upgradeNode(nodeId: string, targetVersion?: string): Promise<NodeUpgradeResult> {
    return request<NodeUpgradeResult>(`/api/nodes/${encodeURIComponent(nodeId)}/upgrade`, {
      method: 'POST',
      body: JSON.stringify(targetVersion ? { targetVersion } : {}),
    });
  },

  // Skills
  async getSkill(nodeId: string, skillId: string): Promise<{ content: string }> {
    return request<{ content: string }>(
      `/api/nodes/${encodeURIComponent(nodeId)}/skills/${encodeURIComponent(skillId)}`
    );
  },

  async saveSkill(nodeId: string, skillId: string, content: string): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>(
      `/api/nodes/${encodeURIComponent(nodeId)}/skills/${encodeURIComponent(skillId)}`,
      {
        method: 'PUT',
        body: JSON.stringify({ content }),
      }
    );
  },

  async deleteSkill(nodeId: string, skillId: string): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>(
      `/api/nodes/${encodeURIComponent(nodeId)}/skills/${encodeURIComponent(skillId)}`,
      { method: 'DELETE' }
    );
  },

  async syncSkillAcrossNodes(
    sourceNodeId: string,
    skillId: string,
    targetNodeIds: string[]
  ): Promise<{ ok: boolean; syncedNodeIds: string[]; failedNodeIds: string[] }> {
    return request<{ ok: boolean; syncedNodeIds: string[]; failedNodeIds: string[] }>(
      `/api/nodes/${encodeURIComponent(sourceNodeId)}/skills/${encodeURIComponent(skillId)}/sync`,
      {
        method: 'POST',
        body: JSON.stringify({ targetNodeIds }),
      }
    );
  },

  // Extensions & Resource Installer
  async getExtension(nodeId: string, extId: string): Promise<{ content: string }> {
    return request<{ content: string }>(
      `/api/nodes/${encodeURIComponent(nodeId)}/extensions/${encodeURIComponent(extId)}`
    );
  },

  async saveExtension(nodeId: string, extId: string, content: string): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>(
      `/api/nodes/${encodeURIComponent(nodeId)}/extensions/${encodeURIComponent(extId)}`,
      {
        method: 'PUT',
        body: JSON.stringify({ content }),
      }
    );
  },

  async deleteExtension(nodeId: string, extId: string): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>(
      `/api/nodes/${encodeURIComponent(nodeId)}/extensions/${encodeURIComponent(extId)}`,
      { method: 'DELETE' }
    );
  },

  async installResource(
    nodeId: string,
    input: { source: string; kind?: 'auto' | 'skill' | 'extension'; customId?: string }
  ): Promise<{ kind: 'skill' | 'extension'; id: string }> {
    return request<{ kind: 'skill' | 'extension'; id: string }>(
      `/api/nodes/${encodeURIComponent(nodeId)}/install`,
      {
        method: 'POST',
        body: JSON.stringify(input),
      }
    );
  },

  // BOTs
  async createBot(input: SaveBotInput): Promise<BotConfig> {
    return request<BotConfig>('/api/bots', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  async updateBot(botId: string, input: SaveBotInput): Promise<BotConfig> {
    return request<BotConfig>(`/api/bots/${encodeURIComponent(botId)}`, {
      method: 'PUT',
      body: JSON.stringify(input),
    });
  },

  async deleteBot(botId: string): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>(`/api/bots/${encodeURIComponent(botId)}`, {
      method: 'DELETE',
    });
  },

  async getBotSystem(botId: string): Promise<{ content: string }> {
    return request<{ content: string }>(`/api/bots/${encodeURIComponent(botId)}/system`);
  },

  async saveBotSystem(botId: string, content: string): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>(`/api/bots/${encodeURIComponent(botId)}/system`, {
      method: 'PUT',
      body: JSON.stringify({ content }),
    });
  },

  async getBotMemory(botId: string): Promise<{ content: string }> {
    return request<{ content: string }>(`/api/bots/${encodeURIComponent(botId)}/memory`);
  },

  async saveBotMemory(botId: string, content: string): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>(`/api/bots/${encodeURIComponent(botId)}/memory`, {
      method: 'PUT',
      body: JSON.stringify({ content }),
    });
  },

  async getBotCommands(botId: string): Promise<ChatCommand[]> {
    return request<ChatCommand[]>(`/api/bots/${encodeURIComponent(botId)}/commands`);
  },

  // Bot environment variables (secrets)
  async getBotEnv(
    botId: string
  ): Promise<{ keys: string[]; env: Record<string, string> }> {
    return request<{ keys: string[]; env: Record<string, string> }>(
      `/api/bots/${encodeURIComponent(botId)}/env`
    );
  },

  async putBotEnv(
    botId: string,
    env: Record<string, string>,
    merge = false
  ): Promise<{ ok: true; keys: string[]; env: Record<string, string> }> {
    return request<{ ok: true; keys: string[]; env: Record<string, string> }>(
      `/api/bots/${encodeURIComponent(botId)}/env`,
      {
        method: 'PUT',
        body: JSON.stringify({ env, merge }),
      }
    );
  },

  async deleteBotEnvKey(
    botId: string,
    key: string
  ): Promise<{ ok: boolean; keys: string[]; env: Record<string, string> }> {
    return request<{ ok: boolean; keys: string[]; env: Record<string, string> }>(
      `/api/bots/${encodeURIComponent(botId)}/env/${encodeURIComponent(key)}`,
      { method: 'DELETE' }
    );
  },

  // Sessions
  async getSessions(): Promise<SessionRecord[]> {
    return request<SessionRecord[]>('/api/sessions');
  },

  async createSession(input: CreateSessionInput): Promise<SessionRecord> {
    return request<SessionRecord>('/api/sessions', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  async delegateSession(sessionId: string, input: DelegateSessionInput): Promise<DelegateSessionResult> {
    return request<DelegateSessionResult>(`/api/sessions/${encodeURIComponent(sessionId)}/delegate`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  async listSubSessions(sessionId: string): Promise<SessionRecord[]> {
    return request<SessionRecord[]>(`/api/sessions/${encodeURIComponent(sessionId)}/subsessions`);
  },

  async updateSession(sessionId: string, input: Partial<CreateSessionInput>): Promise<SessionRecord> {
    return request<SessionRecord>(`/api/sessions/${encodeURIComponent(sessionId)}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    });
  },

  async setSessionArchived(sessionId: string, archived: boolean): Promise<SessionRecord> {
    return request<SessionRecord>(`/api/sessions/${encodeURIComponent(sessionId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ archived }),
    });
  },

  async updateSessionPinned(sessionId: string, pinned: boolean): Promise<SessionRecord> {
    return request<SessionRecord>(`/api/sessions/${encodeURIComponent(sessionId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ pinned }),
    });
  },

  async getSessionMessages(sessionId: string, signal?: AbortSignal): Promise<MessageRecord[]> {
    return request<MessageRecord[]>(`/api/sessions/${encodeURIComponent(sessionId)}/messages`, {
      signal,
    });
  },

  async getSessionMessagesPage(
    sessionId: string,
    opts: { before?: string; around?: string; limit?: number }
  ): Promise<{ messages: MessageRecord[]; hasMore: boolean }> {
    const params = new URLSearchParams();
    if (opts.before) params.set('before', opts.before);
    if (opts.around) params.set('around', opts.around);
    if (opts.limit !== undefined) params.set('limit', String(opts.limit));
    const query = params.toString();
    return request<{ messages: MessageRecord[]; hasMore: boolean }>(
      `/api/sessions/${encodeURIComponent(sessionId)}/messages${query ? `?${query}` : ''}`
    );
  },

  async sendMessage(
    sessionId: string,
    content: string,
    attachments?: MessageAttachment[]
  ): Promise<MessageRecord> {
    return request<MessageRecord>(`/api/sessions/${encodeURIComponent(sessionId)}/messages`, {
      method: 'POST',
      body: JSON.stringify({
        content,
        ...(attachments && attachments.length > 0 ? { attachments } : {}),
      }),
    });
  },

  async editUserMessage(sessionId: string, messageId: string, content: string): Promise<MessageRecord> {
    return request<MessageRecord>(
      `/api/sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(messageId)}`,
      {
        method: 'PUT',
        body: JSON.stringify({ content }),
      }
    );
  },

  async cancelSession(sessionId: string): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>(`/api/sessions/${encodeURIComponent(sessionId)}/cancel`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
  },

  // 从指定消息（含）分叉出新会话：只读源会话并复制出新会话，原会话不受影响
  async forkSession(sessionId: string, anchorMessageId: string): Promise<SessionRecord> {
    return request<SessionRecord>(`/api/sessions/${encodeURIComponent(sessionId)}/fork`, {
      method: 'POST',
      body: JSON.stringify({ anchorMessageId }),
    });
  },

  async deleteSession(sessionId: string): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>(`/api/sessions/${encodeURIComponent(sessionId)}`, {
      method: 'DELETE',
    });
  },

  async clearSessionMessages(sessionId: string): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>(`/api/sessions/${encodeURIComponent(sessionId)}/messages`, {
      method: 'DELETE',
    });
  },

  // Share links
  async getSessionShare(sessionId: string): Promise<{ share: SessionShareRecord | null }> {
    return getSessionShare(sessionId);
  },

  async createSessionShare(sessionId: string, regenerate?: boolean): Promise<SessionShareRecord> {
    return createSessionShare(sessionId, regenerate);
  },

  async revokeSessionShare(sessionId: string): Promise<{ ok: boolean }> {
    return revokeSessionShare(sessionId);
  },

  async getPublicShare(token: string): Promise<SharedSessionSnapshot> {
    return getPublicShare(token);
  },

  // Artifacts
  async uploadArtifact(
    sessionId: string,
    input: { filename: string; mimeType?: string; contentBase64: string }
  ): Promise<ArtifactRecord & { url: string }> {
    return request<ArtifactRecord & { url: string }>(
      `/api/sessions/${encodeURIComponent(sessionId)}/artifacts`,
      {
        method: 'POST',
        body: JSON.stringify(input),
      }
    );
  },

  async listSessionArtifacts(sessionId: string): Promise<ArtifactRecord[]> {
    return request<ArtifactRecord[]>(
      `/api/sessions/${encodeURIComponent(sessionId)}/artifacts`
    );
  },

  // Asks (Human-in-the-Loop)
  async getPendingAsks(sessionId: string): Promise<PendingAskRecord[]> {
    return request<PendingAskRecord[]>(
      `/api/sessions/${encodeURIComponent(sessionId)}/asks`
    );
  },

  async respondToAsk(
    sessionId: string,
    askId: string,
    answer: string
  ): Promise<{ ok: boolean; ask: PendingAskRecord }> {
    return request<{ ok: boolean; ask: PendingAskRecord }>(
      `/api/sessions/${encodeURIComponent(sessionId)}/asks/${encodeURIComponent(askId)}/respond`,
      {
        method: 'POST',
        body: JSON.stringify({ answer }),
      }
    );
  },

  // Triggers
  async listSessionTriggers(sessionId: string): Promise<TriggerRecord[]> {
    return request<TriggerRecord[]>(
      `/api/sessions/${encodeURIComponent(sessionId)}/triggers`
    );
  },

  async createSessionTrigger(
    sessionId: string,
    input: CreateTriggerInput
  ): Promise<TriggerRecord> {
    return request<TriggerRecord>(
      `/api/sessions/${encodeURIComponent(sessionId)}/triggers`,
      {
        method: 'POST',
        body: JSON.stringify(input),
      }
    );
  },

  async updateTrigger(
    triggerId: string,
    patch: {
      enabled?: boolean;
      name?: string;
      prompt?: string;
      cronExpr?: string;
      runAt?: string;
    }
  ): Promise<TriggerRecord> {
    return request<TriggerRecord>(
      `/api/triggers/${encodeURIComponent(triggerId)}`,
      {
        method: 'PATCH',
        body: JSON.stringify(patch),
      }
    );
  },

  async runTrigger(triggerId: string): Promise<{ ok: true }> {
    return request<{ ok: true }>(`/api/triggers/${encodeURIComponent(triggerId)}/run`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
  },

  async deleteTrigger(triggerId: string): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>(
      `/api/triggers/${encodeURIComponent(triggerId)}`,
      {
        method: 'DELETE',
      }
    );
  },

  // Global message search
  async searchMessages(
    query: string,
    options?: { sessionId?: string; limit?: number }
  ): Promise<MessageSearchHit[]> {
    const params = new URLSearchParams({ q: query });
    if (options?.sessionId) params.set('sessionId', options.sessionId);
    if (options?.limit !== undefined) params.set('limit', String(options.limit));
    return request<MessageSearchHit[]>(`/api/messages/search?${params.toString()}`);
  },

  // Background jobs (Node bg-jobs 面板)
  async listBgJobs(
    nodeId: string,
    filter?: { sessionId?: string }
  ): Promise<BgJobRecord[]> {
    const query = filter?.sessionId
      ? `?sessionId=${encodeURIComponent(filter.sessionId)}`
      : '';
    return request<BgJobRecord[]>(`/api/nodes/${encodeURIComponent(nodeId)}/bg-jobs${query}`);
  },

  async getBgJobLogs(
    nodeId: string,
    jobId: string,
    lines?: number
  ): Promise<{ job: BgJobRecord; logs: string }> {
    const query = lines !== undefined ? `?lines=${encodeURIComponent(String(lines))}` : '';
    return request<{ job: BgJobRecord; logs: string }>(
      `/api/nodes/${encodeURIComponent(nodeId)}/bg-jobs/${encodeURIComponent(jobId)}/logs${query}`
    );
  },

  async killBgJob(nodeId: string, jobId: string): Promise<{ job: BgJobRecord }> {
    return request<{ job: BgJobRecord }>(
      `/api/nodes/${encodeURIComponent(nodeId)}/bg-jobs/${encodeURIComponent(jobId)}/kill`,
      { method: 'POST', body: JSON.stringify({}) }
    );
  },
};

/**
 * Connect to SSE stream for a specific session.
 * Returns an unsubscribe callback to cleanly close the connection.
 */
export function subscribeSessionEvents(
  sessionId: string,
  callbacks: {
    onEvent: (event: SessionSseEvent) => void;
    onError?: (error: Event) => void;
    onOpen?: () => void;
  }
): () => void {
  const url = `/api/sessions/${encodeURIComponent(sessionId)}/events`;
  const eventSource = new EventSource(url, { withCredentials: true });

  eventSource.onopen = () => {
    callbacks.onOpen?.();
  };

  eventSource.onmessage = (event) => {
    try {
      if (!event.data) return;
      const parsed = JSON.parse(event.data) as SessionSseEvent;
      callbacks.onEvent(parsed);
    } catch (err) {
      console.warn('[SSE] Failed to parse message data:', err, event.data);
    }
  };

  eventSource.onerror = (err) => {
    callbacks.onError?.(err);
  };

  return () => {
    eventSource.close();
  };
}

export async function getSessionShare(sessionId: string): Promise<{ share: SessionShareRecord | null }> {
  return request<{ share: SessionShareRecord | null }>(`/api/sessions/${encodeURIComponent(sessionId)}/share`);
}

export async function createSessionShare(sessionId: string, regenerate?: boolean): Promise<SessionShareRecord> {
  return request<SessionShareRecord>(`/api/sessions/${encodeURIComponent(sessionId)}/share`, {
    method: 'POST',
    body: JSON.stringify({ regenerate: Boolean(regenerate) }),
  });
}

export async function revokeSessionShare(sessionId: string): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(`/api/sessions/${encodeURIComponent(sessionId)}/share`, {
    method: 'DELETE',
  });
}

export async function getPublicShare(token: string): Promise<SharedSessionSnapshot> {
  return request<SharedSessionSnapshot>(`/api/public/shares/${encodeURIComponent(token)}`);
}

/**
 * Subscribe to the per-user global SSE stream (/api/events):
 * session events for all of the user's sessions plus node online/offline notifications.
 * Returns an unsubscribe callback to cleanly close the connection.
 */
export function subscribeGlobalEvents(
  callbacks: {
    onEvent: (event: GlobalSseEvent) => void;
    onError?: (error: Event) => void;
    onOpen?: () => void;
  }
): () => void {
  const eventSource = new EventSource('/api/events', { withCredentials: true });

  eventSource.onopen = () => {
    callbacks.onOpen?.();
  };

  eventSource.onmessage = (event) => {
    try {
      if (!event.data) return;
      const parsed = JSON.parse(event.data) as GlobalSseEvent;
      callbacks.onEvent(parsed);
    } catch (err) {
      console.warn('[SSE] Failed to parse global event data:', err, event.data);
    }
  };

  eventSource.onerror = (err) => {
    callbacks.onError?.(err);
  };

  return () => {
    eventSource.close();
  };
}
