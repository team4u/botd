import type {
  ApiKeyCredential,
  AuthOperationOptions,
  Credential,
  CredentialInfo,
  CredentialStore,
  OAuthCredential,
} from '@earendil-works/pi-ai';
import type { HubDatabase } from './db.js';

const isApiKeyCredential = (c: Credential): c is ApiKeyCredential => c.type === 'api_key';
const isOAuthCredential = (c: Credential): c is OAuthCredential => c.type === 'oauth';

/**
 * pi-ai CredentialStore 的 Hub SQLite 实现：provider_credentials 表是唯一凭据源，
 * Hub 侧 LLM 请求（Brain in Hub）直接用库内 API Key 解析认证，无需节点参与。
 */
export function createHubCredentialStore(db: HubDatabase): CredentialStore {
  const readCredential = (providerId: string): Credential | undefined => {
    const row = db.getProviderCredential(providerId);
    if (!row) return undefined;
    if (row.authType === 'oauth') {
      return { type: 'oauth', ...(row.oauth as { refresh: string; access: string; expires: number }) };
    }
    return { type: 'api_key', ...(row.apiKey !== undefined ? { key: row.apiKey } : {}) };
  };

  return {
    async read(providerId: string, _options?: AuthOperationOptions): Promise<Credential | undefined> {
      return readCredential(providerId);
    },
    async list(_options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
      return db.listProviderCredentials().map((c) => ({ providerId: c.providerId, type: c.authType }));
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
    },
  };
}
