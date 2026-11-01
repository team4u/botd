import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { AuthEvent, AuthPrompt } from '@earendil-works/pi-ai';
import type { ProviderAuthType, ProviderLoginEvent, ProviderLoginPrompt, ProviderLoginState } from '@botd/protocol';
import { createRuntimeForProvider } from './models.js';
import { ensureDir } from './storage.js';

interface Waiter { id: string; resolve(value: string): void; reject(error: Error): void }
interface LoginJob {
  state: ProviderLoginState;
  controller: AbortController;
  timer: ReturnType<typeof setTimeout>;
  startedAt: number;
  finishedAt?: number;
  waiter?: Waiter;
  running?: Promise<void>;
  secrets: Set<string>;
}
export interface ProviderAuthManagerOptions {
  /** Resolves the runtime used for login/logout; defaults to one that activates
   *  extension providers (e.g. magpie) on demand for the requested provider. */
  createRuntime?: (providerId: string) => Promise<ModelRuntime>;
  ttlMs?: number;
}
const abortError = () => Object.assign(new Error('Login cancelled'), { name: 'AbortError' });

/** Delegates every provider-specific flow, token exchange and persistence to Pi SDK. */
export class ProviderAuthManager {
  private readonly createRuntime: (providerId: string) => Promise<ModelRuntime>;
  private readonly ttlMs: number;
  private readonly jobs = new Map<string, LoginJob>();
  private closed = false;
  private installationId?: Promise<string>;

  constructor(private readonly dataDir: string, options: ProviderAuthManagerOptions = {}) {
    this.createRuntime = options.createRuntime ?? ((providerId: string) => createRuntimeForProvider(dataDir, providerId));
    this.ttlMs = options.ttlMs ?? 10 * 60 * 1000;
  }

  private async getInstallationId(): Promise<string> {
    const file = path.join(this.dataDir, '.agent', 'device-id');
    await ensureDir(path.dirname(file), 0o700);
    try {
      return (await fs.readFile(file, 'utf8')).trim();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    try {
      await fs.writeFile(file, randomUUID(), { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    return (await fs.readFile(file, 'utf8')).trim();
  }

  private snapshot(job: LoginJob): ProviderLoginState { return structuredClone(job.state); }
  private find(id: string): LoginJob {
    const job = this.jobs.get(id);
    if (!job) throw new Error('Login not found or expired');
    return job;
  }
  private cleanMessage(job: LoginJob, message: string): string {
    let result = message;
    for (const secret of job.secrets) result = result.replaceAll(secret, '[redacted]');
    return result.slice(0, 2000);
  }
  private stop(job: LoginJob, status: 'cancelled' | 'error', error?: string): void {
    if (job.state.status !== 'pending') return;
    job.state.status = status;
    job.state.error = error;
    job.finishedAt = Date.now();
    clearTimeout(job.timer);
    job.controller.abort();
    job.waiter?.reject(abortError());
    delete job.state.prompt;
    delete job.waiter;
  }
  private prune(): void {
    const cutoff = Date.now() - this.ttlMs;
    for (const [id, job] of this.jobs) {
      if (job.finishedAt !== undefined && job.finishedAt < cutoff) this.jobs.delete(id);
    }
    // Keep a bounded history even when a user starts many short login flows.
    if (this.jobs.size >= 100) {
      for (const [id, job] of this.jobs) {
        if (job.finishedAt !== undefined) this.jobs.delete(id);
        if (this.jobs.size < 100) break;
      }
    }
  }

  async start(input: { providerId: string; method: ProviderAuthType }): Promise<ProviderLoginState> {
    if (this.closed) throw new Error('Node is shutting down');
    if (!/^[a-zA-Z0-9_-]+$/.test(input.providerId) || !['api_key', 'oauth'].includes(input.method)) throw new Error('Invalid provider login');
    const runtime = await this.createRuntime(input.providerId);
    this.installationId ??= this.getInstallationId();
    const installationId = await this.installationId;
    if (this.closed) throw new Error('Node is shutting down');
    const provider = runtime.getProvider(input.providerId);
    if (!provider) throw new Error(`Unknown provider: ${input.providerId}`);
    if (input.method === 'oauth' ? !provider.auth.oauth : !provider.auth.apiKey?.login) {
      throw new Error(`Provider ${input.providerId} does not support this login method`);
    }
    this.prune();
    if ([...this.jobs.values()].some(job => job.state.providerId === input.providerId && job.state.status === 'pending')) throw new Error('A login is already pending for this provider');
    if ([...this.jobs.values()].filter(job => job.state.status === 'pending').length >= 64) throw new Error('Too many pending logins');
    const id = `login_${randomUUID()}`;
    const job: LoginJob = {
      state: { id, ...input, status: 'pending', events: [] },
      controller: new AbortController(),
      startedAt: Date.now(),
      secrets: new Set(),
      timer: setTimeout(() => this.stop(job, 'error', 'Login expired; please start again'), this.ttlMs),
    };
    job.timer.unref();
    this.jobs.set(id, job);
    // Start independently of this RPC response: browsers poll and answer SDK prompts.
    job.running = Promise.resolve().then(async () => {
      await runtime.login(input.providerId, input.method, {
        signal: job.controller.signal,
        prompt: prompt => this.prompt(job, prompt),
        notify: event => this.notify(job, event),
      }, {
        agentName: 'botd',
        getDeviceId: () => installationId,
      });
      if (job.state.status === 'pending') {
        job.state.status = 'success';
        delete job.state.prompt;
        job.waiter?.reject(abortError());
        delete job.waiter;
      }
    }).catch((error: unknown) => {
      if (job.state.status === 'pending') {
        job.state.status = 'error';
        job.state.error = this.cleanMessage(job, error instanceof Error ? error.message : 'Provider login failed');
        job.waiter?.reject(abortError());
        delete job.waiter;
        delete job.state.prompt;
      }
    }).finally(() => {
      clearTimeout(job.timer);
      job.finishedAt = Date.now();
      job.secrets.clear();
    });
    return this.snapshot(job);
  }

  private prompt(job: LoginJob, input: AuthPrompt): Promise<string> {
    if (job.state.status !== 'pending' || job.controller.signal.aborted || input.signal?.aborted) return Promise.reject(abortError());
    if (job.waiter) return Promise.reject(new Error('Provider requested overlapping login prompts'));
    const prompt: ProviderLoginPrompt = {
      id: `prompt_${randomUUID()}`,
      type: input.type,
      message: input.message,
      ...('placeholder' in input && input.placeholder ? { placeholder: input.placeholder } : {}),
      ...(input.type === 'select' ? { options: input.options.map(option => ({ ...option })) } : {}),
    };
    job.state.prompt = prompt;
    return new Promise<string>((resolve, reject) => {
      let settled = false;
      const finish = (value?: string, error?: Error) => {
        if (settled) return;
        settled = true;
        input.signal?.removeEventListener('abort', onAbort);
        job.controller.signal.removeEventListener('abort', onAbort);
        if (job.waiter?.id === prompt.id) {
          delete job.waiter;
          delete job.state.prompt;
        }
        if (error) reject(error);
        else resolve(value!);
      };
      const onAbort = () => finish(undefined, abortError());
      job.waiter = {
        id: prompt.id,
        resolve: value => {
          if (value && (input.type === 'secret' || input.type === 'manual_code')) job.secrets.add(value);
          finish(value);
        },
        reject: error => finish(undefined, error),
      };
      input.signal?.addEventListener('abort', onAbort, { once: true });
      job.controller.signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  private notify(job: LoginJob, event: AuthEvent): void {
    if (job.state.status !== 'pending') return;
    let value: ProviderLoginEvent;
    switch (event.type) {
      case 'auth_url': value = { type: event.type, url: event.url, instructions: event.instructions }; break;
      case 'device_code': value = { type: event.type, userCode: event.userCode, verificationUri: event.verificationUri, intervalSeconds: event.intervalSeconds, expiresInSeconds: event.expiresInSeconds }; break;
      case 'info': value = { type: event.type, message: this.cleanMessage(job, event.message), links: event.links?.map(link => ({ url: link.url, label: link.label })) }; break;
      case 'progress': value = { type: event.type, message: this.cleanMessage(job, event.message) }; break;
    }
    job.state.events.push(value);
    if (job.state.events.length > 100) job.state.events.shift();
  }

  async get(loginId: string): Promise<ProviderLoginState> { return this.snapshot(this.find(loginId)); }
  async respond(input: { loginId: string; promptId: string; value: string }): Promise<ProviderLoginState> {
    const job = this.find(input.loginId);
    if (job.state.status !== 'pending' || job.waiter?.id !== input.promptId) throw new Error('Login prompt is no longer active');
    if (typeof input.value !== 'string' || input.value.length > 65536) throw new Error('Invalid login response');
    const options = job.state.prompt?.options;
    if (job.state.prompt?.type === 'select' && !options?.some(option => option.id === input.value)) throw new Error('Invalid login selection');
    job.waiter.resolve(input.value);
    return this.snapshot(job);
  }
  async cancel(loginId: string): Promise<void> { this.stop(this.find(loginId), 'cancelled'); }
  async logout(providerId: string): Promise<void> {
    if (!/^[a-zA-Z0-9_-]+$/.test(providerId)) throw new Error('Invalid provider id');
    for (const job of this.jobs.values()) if (job.state.providerId === providerId) this.stop(job, 'cancelled');
    const runtime = await this.createRuntime(providerId);
    await runtime.logout(providerId);
  }
  async close(): Promise<void> {
    this.closed = true;
    for (const job of this.jobs.values()) this.stop(job, 'cancelled');
    let timeout: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.allSettled([...this.jobs.values()].map(job => job.running)),
      new Promise<void>(resolve => { timeout = setTimeout(resolve, 1000); timeout.unref(); }),
    ]);
    if (timeout) clearTimeout(timeout);
    this.jobs.clear();
  }
}
