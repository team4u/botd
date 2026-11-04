/**
 * Dynamic pi-durable extension loader (Full-Stack Extensible Kernel).
 *
 * User-authored extensions live as TypeScript source in Hub SQLite
 * (`hub_extensions`). `loadDynamicDurableExtension` compiles and imports such
 * a module (tsx loader) and resolves its default export into a `pi-durable`
 * `Extension`, which `HubDurableRuntime.installDynamicExtension` mounts onto
 * the Bot personas that enabled it.
 *
 * `formatUiSpecBlock` is the shared helper for emitting `botd.v1` Generative
 * UI specs as fenced ` ```ui ` blocks — the Web timeline renders those blocks
 * natively (Markdown.tsx UiSpecBlock).
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import type { Extension } from "@earendil-works/pi-durable";

/** The botd UI catalog version fenced blocks must carry. */
export const BOTD_UI_FENCE = "ui";

/**
 * Format a `botd.v1` Generative UI spec as a fenced ```ui block, optionally
 * preceded by a one-line text summary. Any tool returning this string renders
 * the spec natively in the Web UI timeline and WorkerInspectDrawer.
 */
export function formatUiSpecBlock(spec: Record<string, unknown>, summary?: string): string {
	const json = JSON.stringify(spec, null, 2);
	const block = `\`\`\`${BOTD_UI_FENCE}\n${json}\n\`\`\``;
	return summary === undefined || summary === "" ? block : `${summary}\n\n${block}`;
}

/** Anything extension-shaped a dynamic module may export as default. */
type DynamicExport = Extension | ((helpers: unknown) => Extension | Promise<Extension>) | undefined;

function looksLikeExtension(value: unknown): value is Extension {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as { name?: unknown }).name === "string" &&
		(value as { name: string }).name !== ""
	);
}

/**
 * Directory the temp module is written into: inside the workspace's
 * `node_modules` tree, so the extension's bare imports (`@earendil-works/...`)
 * resolve against the Hub's own dependency tree. A file under `os.tmpdir()`
 * has no `node_modules` ancestor and would fail to resolve them.
 */
function dynamicImportDir(): string {
	const resolved = import.meta.resolve("@earendil-works/pi-durable");
	let dir = path.dirname(fileURLToPath(resolved));
	for (;;) {
		const base = path.basename(dir);
		if (base === "node_modules") return dir;
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return path.dirname(fileURLToPath(import.meta.url));
}

/**
 * Load a user-authored `@earendil-works/pi-durable` extension from source.
 *
 * The source is written to a temp `.mts` file (inside the workspace's
 * `node_modules` tree, so bare imports resolve) and imported with the tsx
 * loader. The module's default export may be:
 *
 * - an `Extension` (from `defineExtension({ name, ... })`), or
 * - a factory `(helpers) => Extension`.
 *
 * The resolved extension's `name` defaults to `extId` when missing or blank.
 * Each call uses a unique file path, so reloading an updated source never hits
 * the module cache of an earlier version.
 */
export async function loadDynamicDurableExtension(extId: string, sourceCode: string): Promise<Extension> {
	const dir = path.join(dynamicImportDir(), ".botd-dyn", randomUUID());
	await mkdir(dir, { recursive: true });
	const file = path.join(dir, "extension.mts");
	await writeFile(file, sourceCode, "utf8");
	try {
		const { tsImport } = await import("tsx/esm/api");
		const parentURL = new URL(import.meta.url).href;
		const mod = (await tsImport(`file://${file}`, { parentURL })) as {
			default?: DynamicExport;
		};
		const exported = mod.default;
		if (exported === undefined) throw new Error(`extension "${extId}" has no default export`);
		const resolved =
			typeof exported === "function" ? await exported({}) : exported;
		if (!looksLikeExtension(resolved)) {
			throw new Error(
				`extension "${extId}" must default-export defineExtension(...) or a factory returning an Extension`,
			);
		}
		return { ...resolved, name: resolved.name === "" ? extId : resolved.name };
	} finally {
		await rm(dir, { recursive: true, force: true }).catch(() => undefined);
	}
}
