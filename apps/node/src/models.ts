import path from 'node:path';
import fs from 'node:fs/promises';
import type {
  Api,
  AuthOperationOptions,
  Credential,
  CredentialInfo,
  CredentialStore,
  ModelsStore,
  ModelsStoreEntry,
  Model,
  MutableModels,
  Provider,
} from '@earendil-works/pi-ai';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import type { ModelCatalog } from '@botd/protocol';
import { ensureDir } from './storage.js';

/**
 * Node 侧模型目录与 Provider 登录运行时。
 *
 * Phase 3A 起不再依赖 Pi SDK 的 ModelRuntime，改用 pi-ai 的
 * `builtinModels()` + 文件型 CredentialStore / ModelsStore：
 * - 凭据沿用 <dataDir>/.agent/auth.json（同一 JSON 结构，登录态无缝保留）；
 * - 动态目录缓存沿用 <dataDir>/.agent/models-store.json；
 * - <dataDir>/.agent/models.json 的自定义 provider（baseUrl/api/models）继续生效；
 * - BOTD_API_KEY_<PROVIDER> 运行时覆盖经包装的 CredentialStore 生效。
 */

// ---------------------------------------------------------------------------
// 文件型凭据存储（auth.json 的 JSON 结构与 Pi SDK AuthStorage 完全一致）
// ---------------------------------------------------------------------------

class FileCredentialStore implements CredentialStore {
  private readonly authPath: string;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(authPath: string) {
    this.authPath = authPath;
  }

  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const next = this.chain.then(task, task);
    this.chain = next.catch(() => undefined);
    return next;
  }

  private async readData(): Promise<Record<string, Credential>> {
    try {
      const raw = await fs.readFile(this.authPath, 'utf8');
      return raw ? (JSON.parse(raw) as Record<string, Credential>) : {};
    } catch {
      return {};
    }
  }

  private async writeData(data: Record<string, Credential>): Promise<void> {
    await fs.mkdir(path.dirname(this.authPath), { recursive: true });
    await fs.writeFile(this.authPath, JSON.stringify(data, null, 2), { mode: 0o600 });
  }

  read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
    options?.signal?.throwIfAborted();
    return this.serialize(async () => (await this.readData())[providerId]);
  }

  list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
    options?.signal?.throwIfAborted();
    return this.serialize(async () =>
      Object.entries(await this.readData()).map(([providerId, credential]) => ({
        providerId,
        type: credential.type,
      })),
    );
  }

  modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
    options?: AuthOperationOptions,
  ): Promise<Credential | undefined> {
    options?.signal?.throwIfAborted();
    return this.serialize(async () => {
      const data = await this.readData();
      const next = await fn(data[providerId]);
      if (next !== undefined) {
        data[providerId] = next;
        await this.writeData(data);
      }
      return next;
    });
  }

  delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
    options?.signal?.throwIfAborted();
    return this.serialize(async () => {
      const data = await this.readData();
      if (providerId in data) {
        delete data[providerId];
        await this.writeData(data);
      }
    });
  }
}

// ---------------------------------------------------------------------------
// 文件型动态目录缓存（models-store.json：providerId -> ModelsStoreEntry）
// ---------------------------------------------------------------------------

class FileModelsStore implements ModelsStore {
  private readonly storePath: string;

  constructor(storePath: string) {
    this.storePath = storePath;
  }

  private async readAll(): Promise<Record<string, ModelsStoreEntry>> {
    try {
      const raw = await fs.readFile(this.storePath, 'utf8');
      return raw ? (JSON.parse(raw) as Record<string, ModelsStoreEntry>) : {};
    } catch {
      return {};
    }
  }

  private async writeAll(data: Record<string, ModelsStoreEntry>): Promise<void> {
    await fs.mkdir(path.dirname(this.storePath), { recursive: true });
    await fs.writeFile(this.storePath, JSON.stringify(data, null, 2), { mode: 0o600 });
  }

  async read(providerId: string): Promise<ModelsStoreEntry | undefined> {
    const entry = (await this.readAll())[providerId];
    return entry ? structuredClone(entry) : undefined;
  }

  async write(providerId: string, entry: ModelsStoreEntry): Promise<void> {
    const data = await this.readAll();
    data[providerId] = structuredClone(entry);
    await this.writeAll(data);
  }

  async delete(providerId: string): Promise<void> {
    const data = await this.readAll();
    if (providerId in data) {
      delete data[providerId];
      await this.writeAll(data);
    }
  }
}

// ---------------------------------------------------------------------------
// models.json 自定义 provider（Node 端最小子集：baseUrl / api / models）
// ---------------------------------------------------------------------------

interface ModelsJsonModelDefinition {
  id: string;
  name?: string;
  api?: Api;
  baseUrl?: string;
  reasoning?: boolean;
  input?: Model<Api>['input'];
  contextWindow?: number;
  maxTokens?: number;
}

interface ModelsJsonProviderConfig {
  baseUrl?: string;
  api?: Api;
  apiKey?: string;
  models?: ModelsJsonModelDefinition[];
}

type ModelsJson = { providers?: Record<string, ModelsJsonProviderConfig> };

async function readModelsJson(agentDir: string): Promise<ModelsJson> {
  try {
    const raw = await fs.readFile(path.join(agentDir, 'models.json'), 'utf8');
    return JSON.parse(raw) as ModelsJson;
  } catch {
    return {};
  }
}

/** 依据 models.json 定义派生自定义 provider（api-key 认证 + 静态模型清单）。 */
function customProviderFromConfig(providerId: string, config: ModelsJsonProviderConfig): Provider {
  const streamViaCompatApi = (
    _model: Model<Api>,
    _context: unknown,
    _options: unknown,
    _simple: boolean,
  ): never => {
    throw new Error(
      `Provider ${providerId}: direct streaming requires the Hub durable runtime (model catalog is read-only on node)`,
    );
  };
  const models: Model<Api>[] = (config.models ?? []).map((definition) => {
    const api = definition.api ?? config.api;
    if (!api) {
      throw new Error(`Provider ${providerId}, model ${definition.id}: no "api" specified. Set it at provider or model level.`);
    }
    const baseUrl = definition.baseUrl ?? config.baseUrl;
    if (!baseUrl) {
      throw new Error(`Provider ${providerId}: "baseUrl" is required when defining custom models.`);
    }
    return {
      id: definition.id,
      name: definition.name ?? definition.id,
      api,
      provider: providerId,
      baseUrl,
      reasoning: definition.reasoning ?? false,
      input: definition.input ?? ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: definition.contextWindow ?? 128000,
      maxTokens: definition.maxTokens ?? 16384,
    } as Model<Api>;
  });
  return {
    id: providerId,
    name: providerId,
    baseUrl: config.baseUrl,
    auth: {
      apiKey: {
        name: 'API key',
        login: async (interaction) => ({
          type: 'api_key',
          key: await interaction.prompt({ type: 'secret', message: 'Enter API key' }),
        }),
        resolve: async ({ credential }) =>
          credential?.key ? { auth: { apiKey: credential.key }, source: 'stored credential' } : undefined,
      },
    },
    getModels: () => models,
    stream: (model, context, options) => streamViaCompatApi(model, context, options, false),
    streamSimple: (model, context, options) => streamViaCompatApi(model, context, options, true),
  } as Provider;
}

// ---------------------------------------------------------------------------
// Node 模型运行时
// ---------------------------------------------------------------------------

export interface NodeModelRuntime extends MutableModels {
  /** 注册扩展声明的原生 provider（provider-auth 测试经此注入桩 provider）。 */
  registerNativeProvider(provider: Provider): void;
  /** 运行时 API key 覆盖（BOTD_API_KEY_<PROVIDER>，凭据存储之上的一层）。 */
  setRuntimeApiKey(providerId: string, apiKey: string): Promise<void>;
  listCredentials(): Promise<readonly CredentialInfo[]>;
}

/**
 * 创建 Node 端隔离模型运行时：内置 provider + models.json 自定义 provider，
 * 凭据与动态目录落盘在 <dataDir>/.agent 下，创建时不做网络刷新。
 */
export async function createIsolatedModelRuntime(dataDir: string): Promise<NodeModelRuntime> {
  const agentDir = path.join(dataDir, '.agent');
  await ensureDir(agentDir, 0o700);

  const fileCredentials = new FileCredentialStore(path.join(agentDir, 'auth.json'));
  const modelsStore = new FileModelsStore(path.join(agentDir, 'models-store.json'));

  // 运行时 API key 覆盖：包在文件存储外层，Models 的登录/刷新/请求全路径感知
  const runtimeApiKeyOverrides = new Map<string, string>();
  const credentials: CredentialStore = {
    read: (providerId, options) => {
      const override = runtimeApiKeyOverrides.get(providerId);
      return override
        ? Promise.resolve({ type: 'api_key', key: override } as Credential)
        : fileCredentials.read(providerId, options);
    },
    list: (options) => fileCredentials.list(options),
    modify: (providerId, fn, options) => fileCredentials.modify(providerId, fn, options),
    delete: (providerId, options) => fileCredentials.delete(providerId, options),
  };

  const models = builtinModels({ credentials, modelsStore });

  const { providers: customConfigs = {} } = await readModelsJson(agentDir);
  for (const [providerId, config] of Object.entries(customConfigs)) {
    if (!config?.baseUrl && !(config?.models && config.models.length > 0)) continue;
    try {
      models.setProvider(customProviderFromConfig(providerId, config));
    } catch {
      // 单个损坏的自定义 provider 不得拖垮内置目录
    }
  }

  // 代理委托：Models 接口全部转发给底层集合，仅追加 Node 特有方法
  const runtime: NodeModelRuntime = new Proxy({} as NodeModelRuntime, {
    get(_target, prop: string) {
      if (prop === 'registerNativeProvider') {
        return (provider: Provider) => models.setProvider(provider);
      }
      if (prop === 'setRuntimeApiKey') {
        return async (providerId: string, apiKey: string) => {
          runtimeApiKeyOverrides.set(providerId, apiKey);
        };
      }
      if (prop === 'listCredentials') {
        return async () => {
          const stored = await fileCredentials.list();
          const overrides = [...runtimeApiKeyOverrides.keys()].map((providerId) => ({
            providerId,
            type: 'api_key' as const,
          }));
          return [...new Map([...stored, ...overrides].map((entry) => [entry.providerId, entry])).values()];
        };
      }
      const value = Reflect.get(models as unknown as Record<string, unknown>, prop);
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(models) : value;
    },
  });
  return runtime;
}

/**
 * Create a runtime that can serve `providerId`. Builtin providers load with zero
 * extra cost; unknown providers currently fall back to the isolated runtime
 * (extension-provider activation left the builtin catalog intact). Used by
 * provider login/logout.
 */
export async function createRuntimeForProvider(_dataDir: string, _providerId: string): Promise<NodeModelRuntime> {
  return await createIsolatedModelRuntime(_dataDir);
}

export function resolveProviderApiKey(providerId: string): string | undefined {
  const variable = `BOTD_API_KEY_${providerId.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
  const override = process.env[variable];
  return override?.trim() ? override.trim() : undefined;
}

export async function configureProviderAuth(runtime: NodeModelRuntime, providerId: string): Promise<void> {
  const key = resolveProviderApiKey(providerId);
  if (key) {
    const provider = runtime.getProvider(providerId);
    if (provider && !provider.auth.apiKey) throw new Error(`Provider "${providerId}" requires OAuth login rather than an API key`);
    await runtime.setRuntimeApiKey(providerId, key);
    return;
  }
  // Require credentials explicitly owned by botd; do not silently borrow host provider keys.
  const credentials = await runtime.listCredentials();
  if (!credentials.some((credential) => credential.providerId === providerId)) {
    throw new Error(`API key or SDK login for provider "${providerId}" is not configured. Configure this provider in the model settings.`);
  }
}

export async function getNodeModelCatalog(dataDir: string): Promise<ModelCatalog> {
  const runtime = await createIsolatedModelRuntime(dataDir);

  const credentials = new Map((await runtime.listCredentials()).map((credential) => [credential.providerId, credential.type]));
  const { buildModelCatalog } = await import('@botd/models');
  const catalog = buildModelCatalog(runtime.getProviders());
  return {
    ...catalog,
    providers: catalog.providers.map((provider) => {
      const storedType = credentials.get(provider.id);
      return { ...provider, configured: Boolean(storedType), ...(storedType ? { credentialType: storedType } : {}) };
    }),
  };
}
