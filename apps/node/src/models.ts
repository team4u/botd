import path from 'node:path';
import { ModelRuntime, DefaultResourceLoader, SettingsManager } from '@earendil-works/pi-coding-agent';
import { buildModelCatalog } from '@botd/models';
import type { ModelCatalog } from '@botd/protocol';
import { ensureDir, listExtensions } from './storage.js';

export async function createIsolatedModelRuntime(dataDir: string): Promise<ModelRuntime> {
  const agentDir = path.join(dataDir, '.agent');
  await ensureDir(agentDir, 0o700);
  return ModelRuntime.create({
    authPath: path.join(agentDir, 'auth.json'),
    modelsPath: path.join(agentDir, 'models.json'),
    modelsStorePath: path.join(agentDir, 'models-store.json'),
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
}

/**
 * Activate the node's extension pool on an isolated runtime so extension-registered
 * providers (e.g. pi-magpie's gateway provider) become usable. The resource loader
 * runs each extension factory immediately; provider registrations are queued on the
 * extension runtime and flushed into the isolated ModelRuntime. A broken extension
 * must never take down the builtin catalog. Returns the registered provider ids.
 */
async function activateExtensionProviders(runtime: ModelRuntime, dataDir: string): Promise<string[]> {
  const registeredProviderIds: string[] = [];
  try {
    const extensionIds = await listExtensions(dataDir);
    if (extensionIds.length === 0) return registeredProviderIds;
    const extensionPaths = extensionIds.map((id) => path.join(dataDir, 'extensions', id));
    const settingsManager = SettingsManager.inMemory({});
    const resourceLoader = new DefaultResourceLoader({
      cwd: dataDir,
      agentDir: path.join(dataDir, '.agent'),
      settingsManager,
      noSkills: true,
      noExtensions: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      additionalExtensionPaths: extensionPaths,
    });
    // Mark loaded = true before reload() so DefaultResourceLoader clears jiti's
    // module cache, picking up extension files changed since the last catalog read.
    (resourceLoader as any).loaded = true;
    await resourceLoader.reload();
    const extensionRuntime = resourceLoader.getExtensions().runtime;
    for (const { provider } of extensionRuntime.pendingNativeProviderRegistrations) {
      try {
        runtime.registerNativeProvider(provider);
        registeredProviderIds.push(provider.id);
      } catch {
        // Skip invalid provider registrations from extensions
      }
    }
    for (const { name, config } of extensionRuntime.pendingProviderRegistrations) {
      try {
        runtime.registerProvider(name, config);
        registeredProviderIds.push(name);
      } catch {
        // Skip invalid provider registrations from extensions
      }
    }
  } catch {
    // Extension loading failures fall back to the builtin catalog
  }
  return registeredProviderIds;
}

/**
 * Create a runtime that can serve `providerId`. Builtin providers load with zero
 * extra cost; extension-registered providers (custom gateways like magpie) activate
 * the node's extension pool on demand. Used by provider login/logout and bot turns,
 * so an extension provider is as operable as a builtin one.
 */
export async function createRuntimeForProvider(dataDir: string, providerId: string): Promise<ModelRuntime> {
  const runtime = await createIsolatedModelRuntime(dataDir);
  if (runtime.getProvider(providerId)) return runtime;
  await activateExtensionProviders(runtime, dataDir);
  return runtime;
}

export function resolveProviderApiKey(providerId: string): string | undefined {
  const variable = `BOTD_API_KEY_${providerId.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
  const override = process.env[variable];
  return override?.trim() ? override.trim() : undefined;
}

export async function configureProviderAuth(runtime: ModelRuntime, providerId: string): Promise<void> {
  const key = resolveProviderApiKey(providerId);
  if (key) {
    const provider = runtime.getProvider(providerId);
    if (provider && !provider.auth.apiKey) throw new Error(`Provider "${providerId}" requires OAuth login rather than an API key`);
    await runtime.setRuntimeApiKey(providerId, key);
    return;
  }
  // Require credentials explicitly owned by botd; do not silently borrow host provider keys.
  const credentials = await runtime.listCredentials();
  if (!credentials.some(credential => credential.providerId === providerId)) {
    throw new Error(`API key or SDK login for provider "${providerId}" is not configured. Configure this provider in the model settings.`);
  }
}

export async function getNodeModelCatalog(dataDir: string): Promise<ModelCatalog> {
  const runtime = await createIsolatedModelRuntime(dataDir);
  const registeredProviderIds = await activateExtensionProviders(runtime, dataDir);

  // Pull live model catalogs for extension providers (scoped to them only, so
  // builtin providers stay untouched). Successful pulls persist into the shared
  // models store, so later catalog reads (and bot turns, whose runtimes are
  // network-restricted) restore the models without fetching again.
  if (registeredProviderIds.length > 0) {
    try {
      const timeout = AbortSignal.timeout(8_000);
      await runtime.refresh({ allowNetwork: true, providers: registeredProviderIds, force: true, signal: timeout });
    } catch {
      // Network failures fall back to stored / empty model lists
    }
  }

  const credentials = new Map((await runtime.listCredentials()).map(credential => [credential.providerId, credential.type]));
  const catalog = buildModelCatalog(runtime.getProviders());
  return {
    ...catalog,
    providers: catalog.providers.map(provider => {
      const storedType = credentials.get(provider.id);
      return { ...provider, configured: Boolean(storedType), ...(storedType ? { credentialType: storedType } : {}) };
    }),
  };
}
