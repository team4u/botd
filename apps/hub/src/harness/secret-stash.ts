/**
 * In-memory zero-leakage secret stash for generative-UI asks.
 *
 * When a `botd.v1` UI form contains `TextInput` elements marked `secret: true`,
 * the raw plaintext the user submitted must never reach SQLite (AskDoc.answer),
 * SSE broadcasts, or the LLM transcript. Instead `respondToDurableAsk`:
 *
 *  1. stashes each plaintext value here under a generated env-var name
 *     (`BOTD_SECRET_<8-hex>`), with a TTL;
 *  2. replaces the value in the answer JSON with `[REDACTED:$BOTD_SECRET_...]`;
 *  3. injects the active secrets into every subsequent shell execution's env
 *     (local NodeExecutionEnv and remote RemoteExecutionEnv alike), so tools
 *     consume `process.env.BOTD_SECRET_*` cross-platform (Windows/macOS/Linux)
 *     without the value ever appearing in a command line or the LLM context.
 *
 * The stash lives only in process memory: a Hub restart clears it, and entries
 * expire on their own (default 5 minutes).
 */
import { randomBytes } from 'node:crypto';

import { extractSecretStatePaths } from '@botd/protocol';

const DEFAULT_TTL_MS = 5 * 60 * 1000;

interface StashedSecret {
	value: string;
	expiresAt: number;
	scopeId?: string;
}

/** Redaction placeholder written into persisted/broadcast answers. */
export const redactionPlaceholder = (envKey: string): string => `[REDACTED:$${envKey}]`;

export class SecretStash {
	#entries = new Map<string, StashedSecret>();

	/** Stash a plaintext value; returns the generated env var name. Optional scopeId binds the secret to one session. */
	stash(value: string, ttlMs: number = DEFAULT_TTL_MS, scopeId?: string): string {
		const envKey = `BOTD_SECRET_${randomBytes(4).toString('hex').toUpperCase()}`;
		this.#entries.set(envKey, { value, expiresAt: Date.now() + ttlMs, ...(scopeId ? { scopeId } : {}) });
		return envKey;
	}

	#prune(now: number): void {
		for (const [key, entry] of this.#entries) {
			if (entry.expiresAt <= now) this.#entries.delete(key);
		}
	}

	/**
	 * Active secrets as an env record ({ BOTD_SECRET_XXXX: plaintext }); prunes expired entries.
	 * With a scopeId, only unscoped entries and entries bound to that session are returned —
	 * a secret stashed by session A is never leaked into session B's environment.
	 */
	getEnvRecord(scopeId?: string): Record<string, string> {
		this.#prune(Date.now());
		return Object.fromEntries(
			[...this.#entries]
				.filter(([_, entry]) => scopeId === undefined || entry.scopeId === undefined || entry.scopeId === scopeId)
				.map(([key, entry]) => [key, entry.value]),
		);
	}

	/** Read (keep) a stashed value; undefined when missing, expired, or scoped to another session. */
	peek(envKey: string, scopeId?: string): string | undefined {
		const entry = this.#entries.get(envKey);
		if (entry === undefined) return undefined;
		if (entry.expiresAt <= Date.now()) {
			this.#entries.delete(envKey);
			return undefined;
		}
		if (scopeId !== undefined && entry.scopeId !== undefined && entry.scopeId !== scopeId) return undefined;
		return entry.value;
	}

	/** Read and drop a stashed value (one-shot use). */
	consume(envKey: string): string | undefined {
		const value = this.peek(envKey);
		this.#entries.delete(envKey);
		return value;
	}
}

/** Hub-wide default stash (process-local, TTL-bounded). */
export const globalSecretStash = new SecretStash();

/** Merge active secret env vars into `options.env`; explicit entries win. Scope defaults to the session id in env. */
export const withSecretEnv = (
	env: Record<string, string> | undefined,
	stash: SecretStash = globalSecretStash,
	scopeId?: string,
): Record<string, string> | undefined => {
	const effectiveScope = scopeId ?? env?.BOTD_SESSION_ID;
	const secrets = stash.getEnvRecord(effectiveScope);
	const keys = Object.keys(secrets);
	if (keys.length === 0) return env;
	return { ...secrets, ...(env ?? {}) };
};

/** Walk a JSON pointer like `/credentials/password` inside a plain object. */
function resolvePointer(root: Record<string, unknown>, pointer: string): { parent: Record<string, unknown>; key: string } | undefined {
	if (!pointer.startsWith('/') || pointer.length <= 1) return undefined;
	const segments = pointer
		.slice(1)
		.split('/')
		.map((segment) => segment.replace(/~1/g, '/').replace(/~0/g, '~'));
	const key = segments.pop()!;
	let parent: Record<string, unknown> = root;
	for (const segment of segments) {
		const next: unknown = parent[segment];
		if (next === null || typeof next !== 'object' || Array.isArray(next)) return undefined;
		parent = next as Record<string, unknown>;
	}
	return { parent, key };
}

export interface RedactedAskAnswer {
	redactedAnswer: string;
	/** state pointer path -> stashed env var name */
	stashedEnvKeys: Record<string, string>;
}

/**
 * Redact secret fields from a UI-form ask answer.
 *
 * Only `previewType === 'ui'` answers are considered. The answer is parsed as
 * JSON (`{ decision?, params?, state? }`); every secret state path found in the
 * spec (via `extractSecretStatePaths`) that holds a non-empty string in
 * `state` is stashed and replaced with `[REDACTED:$BOTD_SECRET_...]`. Anything
 * unparseable or without secret bindings passes through unchanged.
 */
export function redactSecretAskAnswer(
	answer: string,
	previewType?: string,
	previewContent?: string,
	stash: SecretStash = globalSecretStash,
	scopeId?: string,
): RedactedAskAnswer {
	const stashedEnvKeys: Record<string, string> = {};
	const secretPaths = previewType === 'ui' && previewContent ? extractSecretStatePaths(previewContent) : [];
	if (secretPaths.length === 0) return { redactedAnswer: answer, stashedEnvKeys };

	let parsed: Record<string, unknown>;
	try {
		const json: unknown = JSON.parse(answer);
		if (json === null || typeof json !== 'object' || Array.isArray(json)) {
			return { redactedAnswer: answer, stashedEnvKeys };
		}
		parsed = json as Record<string, unknown>;
	} catch {
		return { redactedAnswer: answer, stashedEnvKeys };
	}

	const state: unknown = parsed.state;
	if (state === null || typeof state !== 'object' || Array.isArray(state)) {
		return { redactedAnswer: answer, stashedEnvKeys };
	}

	for (const path of secretPaths) {
		const located = resolvePointer(state as Record<string, unknown>, path);
		if (located === undefined) continue;
		const raw = located.parent[located.key];
		if (typeof raw !== 'string' || raw.length === 0) continue;
		const envKey = stash.stash(raw, DEFAULT_TTL_MS, scopeId);
		located.parent[located.key] = redactionPlaceholder(envKey);
		stashedEnvKeys[path] = envKey;
	}

	return { redactedAnswer: JSON.stringify(parsed), stashedEnvKeys };
}
