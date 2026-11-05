/**
 * Dynamic pi-durable extension loader (Full-Stack Extensible Kernel).
 *
 * Extensions live as multi-file directory packages on the filesystem
 * (`<dataDir>/extensions/<extId>/`). `loadDynamicDurableExtensionFromDir`
 * compiles and imports the package's entry file (tsx loader) and resolves its
 * default export into a `pi-durable` `Extension`, which
 * `HubDurableRuntime.installDynamicExtension` mounts onto the Bot personas
 * that enabled it. Because the files stay in place on disk, relative imports
 * (`./helper.ts`, `./ui/card.ts`) resolve naturally across files.
 *
 * `loadDynamicDurableExtension` accepts a directory path, a `{ files }` map,
 * or a single-file TypeScript source string; strings and file maps are
 * materialized into a directory and loaded through the same code path.
 *
 * `formatUiSpecBlock` is the shared helper for emitting `botd.v1` Generative
 * UI specs as fenced ` ```ui ` blocks — the Web timeline renders those blocks
 * natively (Markdown.tsx UiSpecBlock).
 */
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import type { Extension } from "@earendil-works/pi-durable";

/** The botd UI catalog version fenced blocks must carry. */
export const BOTD_UI_FENCE = "ui";

/**
 * Format a `botd.v1` Generative UI spec as a fenced ```ui block, optionally
 * preceded by a one-line text summary. Any tool returning this string renders
 * the spec natively in the Web UI timeline and WorkersDrawer.
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
 * Directory used to make the workspace's `node_modules` resolvable: the
 * extension's bare imports (`@earendil-works/...`) must resolve against the
 * Hub's own dependency tree, which a directory under `os.tmpdir()` cannot.
 */
function workspaceNodeModules(): string {
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
 * Ensure bare imports (`@earendil-works/...`) inside `extDir` resolve to the
 * workspace's `node_modules`, and that `.ts` files load as ESM (tsx treats a
 * `.ts` file in a package without `"type": "module"` as CommonJS, whose
 * `require()` cannot resolve ESM-only dependencies). The ESM marker lives in
 * the shared bootstrap `package.json` next to `extDir`, written by the
 * caller (HubDatabase writes one at the extensions root).
 */
async function ensureNodeModules(extDir: string): Promise<void> {
	if (!existsSync(path.join(path.dirname(extDir), "package.json"))) {
		await writeFile(path.join(path.dirname(extDir), "package.json"), '{"type":"module"}\n', "utf8").catch(
			() => undefined,
		);
	}
	if (existsSync(path.join(extDir, "node_modules"))) return;
	if (existsSync(path.join(path.dirname(extDir), "node_modules"))) return;
	const linkPath = path.join(path.dirname(extDir), "node_modules");
	try {
		await symlink(workspaceNodeModules(), linkPath, process.platform === "win32" ? "junction" : "dir");
	} catch (err) {
		const code = (err as NodeJS.ErrnoException)?.code;
		if (code !== "EEXIST" && code !== "EPERM") throw err;
	}
}

/** Resolve the entry file of an extension package directory. */
function resolveEntryFile(extDir: string): string {
	const pkgPath = path.join(extDir, "package.json");
	if (existsSync(pkgPath)) {
		try {
			const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
				pi?: { extensions?: string[] };
				module?: string;
				main?: string;
			};
			const piEntry = pkg.pi?.extensions?.[0];
			const candidate = piEntry ?? pkg.module ?? pkg.main;
			if (typeof candidate === "string" && candidate !== "") {
				const resolved = path.resolve(extDir, candidate);
				if (existsSync(resolved)) return resolved;
			}
		} catch {
			// fall through to convention-based lookup
		}
	}
	for (const name of ["index.ts", "index.mts", "extension.ts", "extension.mts", "index.js", "index.mjs"]) {
		const candidate = path.join(extDir, name);
		if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
	}
	throw new Error(`no extension entry file found in ${extDir}`);
}

async function importExtensionEntry(extId: string, entryFile: string): Promise<Extension> {
	const { tsImport } = await import("tsx/esm/api");
	const url = `${pathToFileURL(entryFile).href}?t=${Date.now()}-${randomUUID()}`;
	const mod = (await tsImport(url, { parentURL: new URL(import.meta.url).href })) as {
		default?: DynamicExport;
	};
	const exported = mod.default;
	if (exported === undefined) throw new Error(`extension "${extId}" has no default export`);
	const resolved = typeof exported === "function" ? await exported({}) : exported;
	if (!looksLikeExtension(resolved)) {
		throw new Error(
			`extension "${extId}" must default-export defineExtension(...) or a factory returning an Extension`,
		);
	}
	return { ...resolved, name: resolved.name === "" ? extId : resolved.name };
}

/**
 * Load a user-authored `@earendil-works/pi-durable` extension from a
 * multi-file directory package. The module's default export may be an
 * `Extension` or a factory `(helpers) => Extension`. The resolved extension's
 * `name` defaults to `extId` when missing or blank. Each call re-imports with
 * a cache-busting URL, so reloading updated files never hits stale modules.
 */
export async function loadDynamicDurableExtensionFromDir(extId: string, extDir: string): Promise<Extension> {
	await ensureNodeModules(extDir);
	const entryFile = resolveEntryFile(extDir);
	return importExtensionEntry(extId, entryFile);
}

/**
 * Staging root for source-string / `{ files }` inputs: inside the workspace's
 * `node_modules` tree, so bare imports resolve without extra setup.
 */
function stagingRoot(): string {
	return path.join(workspaceNodeModules(), ".botd-dyn");
}

/** Input accepted by {@link loadDynamicDurableExtension}. */
export type DynamicExtensionInput = string | { dir: string } | { files: Record<string, string> };

/**
 * Load a dynamic extension from a directory path, a `{ files }` map, or a
 * single-file TypeScript source string. Strings that are existing directory
 * paths load in place; source strings and file maps are materialized into a
 * temp package directory first (removed after import).
 */
export async function loadDynamicDurableExtension(extId: string, source: DynamicExtensionInput): Promise<Extension> {
	let dir: string;
	let cleanup = false;
	if (typeof source === "string") {
		if (!source.includes("\n") && statExistsDirectory(source)) {
			return loadDynamicDurableExtensionFromDir(extId, source);
		}
		dir = path.join(stagingRoot(), randomUUID());
		await mkdir(dir, { recursive: true });
		await writeFile(path.join(dir, "index.mts"), source, "utf8");
		cleanup = true;
	} else if ("dir" in source) {
		return loadDynamicDurableExtensionFromDir(extId, source.dir);
	} else {
		dir = path.join(stagingRoot(), randomUUID());
		await mkdir(dir, { recursive: true });
		const files = source.files;
		for (const relativePath of Object.keys(files)) {
			const target = path.join(dir, relativePath);
			await mkdir(path.dirname(target), { recursive: true });
			await writeFile(target, files[relativePath], "utf8");
		}
		await writeFile(path.join(dir, "package.json"), '{"type":"module"}\n', "utf8");
		cleanup = true;
	}
	try {
		return await loadDynamicDurableExtensionFromDir(extId, dir);
	} finally {
		if (cleanup) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
	}
}

function statExistsDirectory(value: string): boolean {
	try {
		return statSync(value).isDirectory();
	} catch {
		return false;
	}
}
