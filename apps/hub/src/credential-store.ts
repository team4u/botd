import fs from 'node:fs';
import path from 'node:path';
import {
  createProvider,
  type Api,
  type AssistantMessageEventStream,
  type ApiKeyCredential,
  type AuthOperationOptions,
  type AuthResult,
  type Credential,
  type CredentialInfo,
  type CredentialStore,
  type Model,
  type MutableModels,
  type OAuthCredential,
  type Provider,
  type ProviderEnv,
  type SimpleStreamOptions,
  type TranscriptContext,
} from '@earendil-works/pi-ai';
import { stream, streamSimple } from '@earendil-works/pi-ai/compat';
import type { HubDatabase } from './db.js';

const isApiKeyCredential = (c: Credential): c is ApiKeyCredential => c.type === 'api_key';
const isOAuthCredential = (c: Credential): c is OAuthCredential => c.type === 'oauth';

/** `<dataDir>/.agent/auth.json` 中的一条凭据（node CLI 时代写入的形状）。 */
export interface LegacyAgentAuthEntry {
  type: 'api_key' | 'oauth';
  key?: string;
  env?: Record<string, string>;
  refresh?: string;
  access?: string;
  expires?: number;
}

/**
 * 读取 `<dataDir>/.agent/auth.json`（同步、尽力而为）：node CLI 时代的凭据
 * 权威文件，Hub 迁移后作为 SQLite `provider_credentials` 的种子/回退源。
 */
export function readLegacyAgentAuthFile(dataDir: string): Record<string, LegacyAgentAuthEntry> {
  try {
    const raw = fs.readFileSync(path.join(dataDir, '.agent', 'auth.json'), 'utf8').trim();
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, LegacyAgentAuthEntry> = {};
    for (const [providerId, value] of Object.entries(parsed)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const entry = value as Partial<LegacyAgentAuthEntry>;
      if (entry.type !== 'api_key' && entry.type !== 'oauth') continue;
      out[providerId] = entry as LegacyAgentAuthEntry;
    }
    return out;
  } catch {
    return {};
  }
}

/** `<dataDir>/.agent/auth.json` 中移除一个 provider 的凭据并写回（logout 同步清理）。 */
export function removeLegacyProviderAuth(dataDir: string, providerId: string): void {
  const file = path.join(dataDir, '.agent', 'auth.json');
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
  } catch {
    return;
  }
  if (!(providerId in parsed)) return;
  delete parsed[providerId];
  try {
    fs.writeFileSync(file, JSON.stringify(parsed, null, 2) + '\n');
  } catch {
    // 写回失败只影响旧文件残留，不影响 SQLite 侧删除语义
  }
}

/**
 * Hub 的有效凭据清单：SQLite `provider_credentials` 为主，`.agent/auth.json`
 * 兜底补充（冲突时 SQLite 胜出）。
 */
export function listEffectiveProviderCredentials(
  db: HubDatabase
): Array<{ providerId: string; authType: 'api_key' | 'oauth' }> {
  const merged = new Map<string, { providerId: string; authType: 'api_key' | 'oauth' }>();
  for (const [providerId, entry] of Object.entries(readLegacyAgentAuthFile(db.getDataDir()))) {
    merged.set(providerId, { providerId, authType: entry.type });
  }
  for (const row of db.listProviderCredentials()) {
    merged.set(row.providerId, row);
  }
  return [...merged.values()].sort((a, b) => a.providerId.localeCompare(b.providerId));
}

/**
 * pi-ai CredentialStore 的 Hub 实现：SQLite `provider_credentials` 表为主，
 * `<dataDir>/.agent/auth.json`（node CLI 时代写入）作为回退源，两处都查、
 * 两处都删，login 落库与 logout 清理对两个存储同时生效。
 */
export function createHubCredentialStore(db: HubDatabase): CredentialStore {
  const readCredential = (providerId: string): Credential | undefined => {
    const row = db.getProviderCredential(providerId);
    if (row) {
      if (row.authType === 'oauth') {
        return { type: 'oauth', ...(row.oauth as { refresh: string; access: string; expires: number }) };
      }
      // SQLite 未存 env（如 MAGPIE_GW_URL），旧文件里有则补上
      const legacyEnv = readLegacyAgentAuthFile(db.getDataDir())[providerId]?.env;
      return {
        type: 'api_key',
        ...(row.apiKey !== undefined ? { key: row.apiKey } : {}),
        ...(legacyEnv ? { env: legacyEnv } : {}),
      };
    }
    const legacy = readLegacyAgentAuthFile(db.getDataDir())[providerId];
    if (!legacy) return undefined;
    if (legacy.type === 'oauth') {
      return {
        type: 'oauth',
        refresh: legacy.refresh ?? '',
        access: legacy.access ?? '',
        expires: legacy.expires ?? 0,
      };
    }
    return {
      type: 'api_key',
      ...(legacy.key !== undefined ? { key: legacy.key } : {}),
      ...(legacy.env ? { env: legacy.env as ProviderEnv } : {}),
    };
  };

  return {
    async read(providerId: string, _options?: AuthOperationOptions): Promise<Credential | undefined> {
      return readCredential(providerId);
    },
    async list(_options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
      return listEffectiveProviderCredentials(db).map((c) => ({ providerId: c.providerId, type: c.authType }));
    },
    async modify(
      providerId: string,
      fn: (current: Credential | undefined) => Promise<Credential | undefined>,
      _options?: AuthOperationOptions
    ): Promise<Credential | undefined> {
      const current = readCredential(providerId);
      const next = await fn(current);
      if (next === undefined) return current;
      if (isOAuthCredential(next)) {
        db.saveProviderCredential({ providerId, authType: 'oauth', oauth: next });
      } else if (isApiKeyCredential(next)) {
        db.saveProviderCredential({ providerId, authType: 'api_key', ...(next.key !== undefined ? { apiKey: next.key } : {}) });
      }
      return next;
    },
    async delete(providerId: string, _options?: AuthOperationOptions): Promise<void> {
      db.deleteProviderCredential(providerId);
      removeLegacyProviderAuth(db.getDataDir(), providerId);
    },
  };
}

// ---------------------------------------------------------------------------
// 动态/自定义 Provider 目录：`.agent/models-store.json` 与 `.agent/models.json`
// ---------------------------------------------------------------------------

/** `<dataDir>/.agent/models-store.json` 的形状（pi 动态目录缓存）。 */
interface LegacyModelsStore {
  [providerId: string]: { models?: unknown[]; checkedAt?: number } | undefined;
}

/** `<dataDir>/.agent/models.json`（及 `<dataDir>/models.json`）中一个 provider 块的形状。 */
interface LegacyModelsJsonProvider {
  name?: string;
  baseUrl?: string;
  api?: string;
  apiKey?: string;
  models?: unknown[];
}

interface LegacyModelsJson {
  providers?: Record<string, LegacyModelsJsonProvider | undefined>;
}

const readJsonFile = <T>(file: string): T | undefined => {
  try {
    const raw = fs.readFileSync(file, 'utf8').trim();
    if (!raw) return undefined;
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
};

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

/** 存储模型 → pi chat Model：保留 thinkingLevelMap/compat/cost 等全部字段。 */
function toStoredModel(providerId: string, baseUrl: string | undefined, raw: unknown): Model<Api> | undefined {
  const entry = asRecord(raw);
  if (!entry || typeof entry.id !== 'string' || entry.id.length === 0) return undefined;
  const model: Record<string, unknown> = { ...entry, provider: providerId };
  // 存储模型的 baseUrl 缺失时落到 provider baseUrl，保证 Model.baseUrl 必填
  if (typeof model.baseUrl !== 'string' || model.baseUrl.length === 0) {
    model.baseUrl = baseUrl ?? '';
  }
  return model as unknown as Model<Api>;
}

const delegateStream = stream as unknown as (
  model: Model<Api>,
  context: TranscriptContext,
  options?: unknown
) => AssistantMessageEventStream;

/**
 * 把一组已存储的模型包装成 pi Provider：`getModels()` 原样返回存储模型
 * （thinkingLevelMap/reasoning/contextWindow/maxTokens/input/compat 全保留），
 * 认证按存储凭据解析（缺 key 时回退 'magpie'，与 magpie 网关的 loopback
 * 默认 token 约定一致），请求交给 pi-ai compat 按 `model.api` 派发。
 */
function buildStoredProvider(
  providerId: string,
  name: string | undefined,
  baseUrl: string | undefined,
  models: readonly Model<Api>[]
): Provider {
  return createProvider({
    id: providerId,
    name: name ?? providerId,
    baseUrl,
    auth: {
      apiKey: {
        name: `${name ?? providerId} API key`,
        async resolve({ credential }): Promise<AuthResult | undefined> {
          return {
            auth: { apiKey: credential?.key || 'magpie' },
            ...(credential?.env ? { env: credential.env } : {}),
            source: 'stored credential',
          };
        },
      },
    },
    models,
    api: {
      stream: (model, context, options) => delegateStream(model, context, options),
      streamSimple: (model, context: TranscriptContext, options?: SimpleStreamOptions) =>
        streamSimple(model, context, options),
    },
  });
}

/**
 * 读取 `<dataDir>/.agent/models-store.json`、`<dataDir>/.agent/models.json` 与
 * `<dataDir>/models.json`，把其中的动态/自定义 provider（如 magpie）构建为
 * Provider 列表：`getModels()` 返回缓存的 Model 对象（字段原样保留）。
 */
export function loadStoredProviders(dataDir: string): Provider[] {
  const providers: Provider[] = [];

  // 1. models-store.json：动态目录缓存（magpie 等扩展写入）
  const store = readJsonFile<LegacyModelsStore>(path.join(dataDir, '.agent', 'models-store.json'));
  for (const [providerId, entry] of Object.entries(store ?? {})) {
    const models = (entry?.models ?? [])
      .map((raw) => toStoredModel(providerId, undefined, raw))
      .filter((m): m is Model<Api> => m !== undefined);
    if (models.length === 0) continue;
    providers.push(buildStoredProvider(providerId, undefined, undefined, models));
  }

  // 2. models.json（.agent/ 下优先，dataDir 根次之）：自定义 provider 配置；
  //    与 models-store.json 同名的 provider 以缓存目录为准，避免重复注册
  const seen = new Set(providers.map((p) => p.id));
  const config =
    readJsonFile<LegacyModelsJson>(path.join(dataDir, '.agent', 'models.json')) ??
    readJsonFile<LegacyModelsJson>(path.join(dataDir, 'models.json'));
  for (const [providerId, block] of Object.entries(config?.providers ?? {})) {
    if (!block || seen.has(providerId)) continue;
    const models = (block.models ?? [])
      .map((raw) => toStoredModel(providerId, block.baseUrl, raw))
      .filter((m): m is Model<Api> => m !== undefined);
    if (models.length === 0) continue;
    providers.push(buildStoredProvider(providerId, block.name, block.baseUrl, models));
  }

  return providers;
}

/** 把存储 provider 注册进 Models 集合（upsert by provider.id），新建/刷新均可调用。 */
export function registerStoredProviders(models: MutableModels, dataDir: string): void {
  for (const provider of loadStoredProviders(dataDir)) {
    models.setProvider(provider);
  }
}
