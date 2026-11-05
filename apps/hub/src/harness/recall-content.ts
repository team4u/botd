/**
 * Chain of Recall full-content resolution.
 *
 * The recall index (`RecallIndexDoc`) is a pure index: a one-line summary, an
 * 800-char catalog preview and pointers. Full bodies live elsewhere and are
 * resolved here in pointer order:
 *
 * a. `spillPath` — the spilled full-report file (`<cwd>/.botd/recall/<workerId>.md`);
 * b. for worker nodes, the conversation's last non-empty assistant entry;
 * c. the catalog preview as the last resort.
 */
import { readFile } from "node:fs/promises";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { RecallNode } from "./docs.js";

/** Hard cap for the content one recall lookup returns to the model. */
export const RECALL_CONTENT_LIMIT = 24_000;

/** Minimal entry shape the resolution needs from a history scan. */
export interface ScannedEntry {
	readonly kind: string;
	readonly model?: readonly { role?: string; content?: unknown }[];
}

/** Scan one conversation's history newest-first (caller binds tx/session). */
export type EntryScanner = (
	query: { conversationId: ConversationId; order: "descending" },
	limit: number,
) => Promise<{ items: readonly ScannedEntry[] }>;

/** Joined text blocks of an entry's first assistant message; "" when none. */
export function assistantEntryText(entry: ScannedEntry | undefined): string {
	if (entry === undefined) return "";
	const first = entry.model?.[0];
	if (first === undefined || first.role !== "assistant") return "";
	const content = first.content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) =>
			block !== null && typeof block === "object" && "text" in block && typeof (block as { text: unknown }).text === "string"
				? (block as { text: string }).text
				: "",
		)
		.filter(Boolean)
		.join("\n");
}

export interface ResolvedRecallBody {
	content: string;
	source: "spill-file" | "conversation" | "preview";
	/** Set when the spill pointer existed but the file could not be read. */
	notice?: string;
}

/**
 * Resolve a node's full body by pointer order: spill file, then (for workers)
 * the conversation's last assistant entry, then the catalog preview.
 */
export async function resolveRecallBody(node: RecallNode, scanEntries: EntryScanner): Promise<ResolvedRecallBody> {
	if (node.spillPath !== undefined) {
		try {
			const content = await readFile(node.spillPath, "utf8");
			if (content !== "") return { content, source: "spill-file" };
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			const fallback = await conversationOrPreview(node, scanEntries);
			return { ...fallback, notice: `spill file unreadable: ${node.spillPath} (${reason})` };
		}
	}
	return conversationOrPreview(node, scanEntries);
}

async function conversationOrPreview(node: RecallNode, scanEntries: EntryScanner): Promise<ResolvedRecallBody> {
	if (node.kind === "worker" && node.conversationId !== undefined && node.conversationId !== "") {
		const id = Number(node.conversationId);
		if (Number.isInteger(id)) {
			try {
				const page = await scanEntries({ conversationId: id as ConversationId, order: "descending" }, 20);
				for (const entry of page.items) {
					const text = assistantEntryText(entry);
					if (text !== "") return { content: text, source: "conversation" };
				}
			} catch {
				// fall through to the catalog preview
			}
		}
	}
	return { content: node.contentPreview, source: "preview" };
}

/** Cap over-long content, pointing back at where the full body lives. */
export function capRecallContent(content: string, node: RecallNode): string {
	if (content.length <= RECALL_CONTENT_LIMIT) return content;
	const where = node.spillPath ?? node.conversationId ?? node.id;
	return `${content.slice(0, RECALL_CONTENT_LIMIT)}\n[truncated: full content at ${where}]`;
}
