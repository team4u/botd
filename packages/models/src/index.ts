import { PI_AI_VERSION, type Provider } from '@earendil-works/pi-ai';
import { builtinProviders } from '@earendil-works/pi-ai/providers/all';
import type { ModelCatalog, ProviderCatalogEntry } from '@botd/protocol';

/** Explicitly project public metadata; SDK providers can contain private headers and callbacks. */
export function buildModelCatalog(providers: readonly Provider[]): ModelCatalog {
  return {
    source: 'pi',
    sdkVersion: PI_AI_VERSION,
    providers: providers.map((provider): ProviderCatalogEntry => ({
      id: provider.id,
      name: provider.name,
      authMethods: [
        ...(provider.auth.apiKey ? [{
          type: 'api_key' as const,
          label: provider.auth.apiKey.name,
          interactive: Boolean(provider.auth.apiKey.login),
          subscription: false,
        }] : []),
        ...(provider.auth.oauth ? [{
          type: 'oauth' as const,
          label: provider.auth.oauth.loginLabel || provider.auth.oauth.name,
          interactive: true,
          subscription: Boolean(provider.auth.oauth.isSubscription),
        }] : []),
      ],
      models: provider.getModels().map(model => ({
        id: model.id,
        name: model.name,
        reasoning: Boolean(model.reasoning),
        input: [...model.input],
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
      })).sort((a, b) => a.id.localeCompare(b.id)),
    })).sort((a, b) => a.name.localeCompare(b.name)),
  };
}

export function getBuiltinModelCatalog(): ModelCatalog {
  return buildModelCatalog(builtinProviders());
}
