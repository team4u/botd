import type { SessionSseEvent } from '@botd/protocol';
import { readCliConfig, updateCliConfig } from './config.js';
import { CliError } from './errors.js';

const TOKEN_COOKIE = 'botd_token=';

export interface HubClientOptions {
  dataDir: string;
  /** Explicit --hub override. When set, a stored token for a different hub is not reused. */
  hubUrl?: string;
  /** Hub login username: --username flag, BOTD_USERNAME env, stored config, or 'admin'. */
  username?: string;
  /** Hub user password: --password flag, BOTD_ADMIN_PASSWORD env, or stored config. */
  password?: string;
  /** Only `botd login --save-credentials` sets this; controls whether the password is persisted. */
  persistPassword?: boolean;
  timeoutMs?: number;
}

const DEFAULT_USERNAME = 'admin';

const normalizeUrl = (url: string): string => url.replace(/\/+$/, '');

/**
 * The single HTTP layer for every Hub command.
 * Owns the auth lifecycle: lazy login, 401 auto-relogin (once), token persistence.
 */
export class HubClient {
  private constructor(
    private readonly baseUrl: string,
    private token: string | undefined,
    private username: string | undefined,
    private password: string | undefined,
    private readonly options: Pick<HubClientOptions, 'dataDir' | 'persistPassword' | 'timeoutMs'>
  ) {}

  get url(): string {
    return this.baseUrl;
  }

  /** Resolve hub URL + credentials from config/flags, logging in when needed. */
  static async connect(options: HubClientOptions): Promise<HubClient> {
    const config = await readCliConfig(options.dataDir);
    const hubUrl = normalizeUrl(options.hubUrl || config.hubUrl || '');
    if (!hubUrl) {
      throw new CliError('No Hub configured. Run: botd login <hubUrl> --password <password>');
    }
    const username = options.username || config.username || DEFAULT_USERNAME;
    const password = options.password || config.password;
    // Never send a token that was issued by a different hub.
    const token = config.hubUrl && normalizeUrl(config.hubUrl) === hubUrl ? config.token : undefined;

    const client = new HubClient(hubUrl, token, username, password, options);
    if (!client.token) {
      if (!client.password) {
        throw new CliError(`Not logged in to ${hubUrl}. Run: botd login <hubUrl> --password <password>`, 401);
      }
      await client.login();
    }
    return client;
  }

  /** Open a fresh session against an explicit hub URL (`botd login`). */
  static async establish(
    hubUrl: string,
    username: string,
    password: string,
    options: Omit<HubClientOptions, 'hubUrl' | 'username' | 'password'>
  ): Promise<HubClient> {
    const client = new HubClient(normalizeUrl(hubUrl), undefined, username, password, options);
    await client.login();
    return client;
  }

  /** Unauthenticated client for public endpoints (`/api/health`). */
  static anonymous(hubUrl: string, options?: Pick<HubClientOptions, 'timeoutMs'>): HubClient {
    return new HubClient(normalizeUrl(hubUrl), undefined, undefined, undefined, { dataDir: '', timeoutMs: options?.timeoutMs });
  }

  /** POST /api/auth/login, capture the token cookie and persist the session. */
  private async login(): Promise<void> {
    if (!this.password) {
      throw new CliError(`Login required for ${this.baseUrl}. Run: botd login <hubUrl> --password <password>`, 401);
    }
    const response = await fetch(`${this.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: this.username || DEFAULT_USERNAME, password: this.password }),
      signal: AbortSignal.timeout(this.timeout),
    }).catch((err: Error) => {
      throw new CliError(`Cannot reach Hub at ${this.baseUrl}: ${err.message}`);
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new CliError(`Login failed (${response.status}): ${detail || 'invalid credentials'}`.trim(), 401);
    }

    const cookie = response.headers
      .getSetCookie()
      .flatMap(value => value.split(';')[0]!)
      .find(part => part.startsWith(TOKEN_COOKIE));
    if (!cookie) {
      throw new CliError('Login succeeded but the Hub did not return a session token', 500);
    }

    this.token = cookie.slice(TOKEN_COOKIE.length);
    await updateCliConfig(this.options.dataDir, {
      hubUrl: this.baseUrl,
      token: this.token,
      username: this.username,
      password: this.options.persistPassword ? this.password : undefined,
    });
  }

  private get timeout(): number {
    return this.options.timeoutMs && this.options.timeoutMs > 0 ? this.options.timeoutMs : 30_000;
  }

  private headers(body?: unknown): Record<string, string> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (this.token) headers.cookie = `${TOKEN_COOKIE}${this.token}`;
    return headers;
  }

  /** JSON request with one automatic relogin+retry on 401. */
  async request<T>(method: string, apiPath: string, body?: unknown): Promise<T> {
    const send = (): Promise<Response> =>
      fetch(`${this.baseUrl}${apiPath}`, {
        method,
        headers: this.headers(body),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeout),
      }).catch((err: Error) => {
        throw new CliError(`Cannot reach Hub at ${this.baseUrl}: ${err.message}`);
      });

    let response = await send();
    if (response.status === 401 && this.password) {
      await this.login();
      response = await send();
    }
    if (response.status === 401) {
      throw new CliError(
        `Login expired for ${this.baseUrl}. Run: botd login --password <password> (or pass --password / set BOTD_ADMIN_PASSWORD)`,
        401,
      );
    }

    const text = await response.text();
    if (!response.ok) {
      let detail = text;
      try {
        const parsed = JSON.parse(text) as { error?: string };
        if (parsed && typeof parsed.error === 'string') detail = parsed.error;
      } catch {
        // keep raw text
      }
      throw new CliError(detail || `HTTP ${response.status} on ${method} ${apiPath}`, response.status);
    }
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new CliError(`Hub returned invalid JSON on ${method} ${apiPath}`, 500);
    }
  }

  get<T>(apiPath: string): Promise<T> { return this.request<T>('GET', apiPath); }
  post<T>(apiPath: string, body?: unknown): Promise<T> { return this.request<T>('POST', apiPath, body); }
  put<T>(apiPath: string, body?: unknown): Promise<T> { return this.request<T>('PUT', apiPath, body); }
  patch<T>(apiPath: string, body?: unknown): Promise<T> { return this.request<T>('PATCH', apiPath, body); }
  delete<T>(apiPath: string): Promise<T> { return this.request<T>('DELETE', apiPath); }

  /**
   * Subscribe to a session's SSE event stream. Resolves when the server closes the stream.
   * Keepalive `ping` events (empty data) are filtered out.
   */
  async events(
    sessionId: string,
    listeners: { onEvent: (event: SessionSseEvent) => void; signal?: AbortSignal },
  ): Promise<void> {
    const response = await fetch(`${this.baseUrl}/api/sessions/${encodeURIComponent(sessionId)}/events`, {
      headers: {
        accept: 'text/event-stream',
        ...(this.token ? { cookie: `${TOKEN_COOKIE}${this.token}` } : {}),
      },
      signal: listeners.signal,
    }).catch((err: Error) => {
      throw new CliError(`Cannot reach Hub at ${this.baseUrl}: ${err.message}`);
    });

    if (!response.ok || !response.body) {
      throw new CliError(`Failed to open event stream (HTTP ${response.status})`, response.status);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let boundary = buffer.indexOf('\n\n');
        while (boundary !== -1) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          boundary = buffer.indexOf('\n\n');
          const data = block
            .split('\n')
            .filter(line => line.startsWith('data:'))
            .map(line => line.slice('data:'.length).trimStart())
            .join('\n');
          if (!data) continue; // keepalive ping
          try {
            listeners.onEvent(JSON.parse(data) as SessionSseEvent);
          } catch {
            // ignore malformed frame
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}
