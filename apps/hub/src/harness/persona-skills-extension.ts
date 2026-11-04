/**
 * Persona Skills & Memory extension (Full-Stack Extensible Kernel).
 *
 * Mounted on every Bot persona's Router and Worker conversations, it exposes
 * Hub-hosted capabilities as durable tools:
 *
 * - `load_skill`: reads a Hub skill's SKILL.md — or any file inside the
 *   skill directory via `path` — from the Hub filesystem skill store;
 * - `update_memory`: replaces or appends to the persona's MEMORY.md
 *   (`bot_files` kind `memory`) directly from tool execution;
 * - a prompt section advertising the persona's enabled skills (id + brief
 *   summary) so the model knows when to call `load_skill`.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import { defineExtension, defineTool, section, type Extension } from "@earendil-works/pi-durable";

import { TargetDoc } from "./docs.js";

/** The extension's registered name. */
export const PERSONA_SKILLS_EXTENSION = "botd-persona-skills";

export interface PersonaSkillsOptions {
	/** Skills enabled for a bot persona (id + content), resolved from the Hub filesystem store. */
	getBotEnabledSkills?: (botId: string) => Array<{ id: string; content: string }>;
	/** Content of one file inside a skill directory (default `SKILL.md`). */
	getSkillContent?: (skillId: string, relativePath?: string, botId?: string) => string | undefined;
	/** All files inside a skill directory, as relative POSIX paths. */
	listSkillFiles?: (skillId: string, botId?: string) => string[];
	/** The persona's current MEMORY.md content. */
	getBotMemory?: (botId: string) => string;
	/** Persists the persona's MEMORY.md content. */
	setBotMemory?: (botId: string, content: string) => void;
}

/** One-line summary of a SKILL.md: YAML frontmatter `description:`, else the first non-heading line. */
export function skillSummary(content: string): string {
	const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content)?.[1];
	if (frontmatter !== undefined) {
		for (const line of frontmatter.split("\n")) {
			const match = /^description:\s*(.+)$/.exec(line.trim());
			if (match !== null) return match[1].trim().replace(/^["']|["']$/g, "");
		}
	}
	for (const line of content.split("\n")) {
		const text = line.trim();
		if (text === "" || text.startsWith("#")) continue;
		return text;
	}
	return "";
}

/** The bot persona of the running conversation, from its TargetDoc (DocumentReader.snapshot). */
async function personaBotIdOf(
	api: import("@earendil-works/pi-durable").ToolExecutionApi,
): Promise<string | undefined> {
	const target = (await api.snapshot(
		TargetDoc as never,
		api.conversationId,
		BACKGROUND_CONTEXT,
	)) as { botId?: string } | undefined;
	return target?.botId || undefined;
}

export function createPersonaSkillsExtension(options: PersonaSkillsOptions = {}): Extension {
	const loadSkill = defineTool({
		name: "load_skill",
		description:
			"Load a Hub-hosted skill by id: defaults to its SKILL.md instructions, or pass " +
			"path to read another file (e.g. 'references/cli.md') from the skill directory. " +
			"Call this when a task matches one of the skills listed in the Available Skills section.",
		parameters: obj({
			skillId: str({ description: "The skill id from the Available Skills section" }),
			path: opt(str({
				description:
					"Optional relative file path inside the skill directory (e.g. 'references/cli.md'). Defaults to 'SKILL.md'.",
			})),
		}),
		async execute(input, api) {
			const botId = await personaBotIdOf(api);
			const relPath = input.path?.trim() || "SKILL.md";
			const content = options.getSkillContent?.(input.skillId, relPath, botId);
			if (content === undefined || content === "") {
				return {
					isError: true,
					output: [
						{
							type: "text",
							text:
								relPath === "SKILL.md"
									? `Skill not found: ${input.skillId}`
									: `Skill file not found: ${input.skillId}/${relPath}`,
						},
					],
				};
			}
			if (relPath !== "SKILL.md" || options.listSkillFiles === undefined) {
				return { output: [{ type: "text", text: content }] };
			}
			const files = (options.listSkillFiles(input.skillId, botId) ?? []).filter((f) => f !== "SKILL.md");
			if (files.length === 0) return { output: [{ type: "text", text: content }] };
			const footer =
				`\n\n---\nSkill directory files (use load_skill with { skillId: "${input.skillId}", path: "<file>" } to read):\n` +
				files.map((f) => `- ${f}`).join("\n");
			return { output: [{ type: "text", text: content + footer }] };
		},
	});

	const updateMemory = defineTool({
		name: "update_memory",
		description:
			"Persist a durable note into this persona's MEMORY.md (Hub-hosted). " +
			"Use mode 'replace' to rewrite it wholesale or 'append' (default) to add a dated note.",
		parameters: obj({
			content: str({ description: "The memory text to store" }),
			mode: opt(oneOf(["replace", "append"])),
		}),
		async execute(input, api) {
			const botId = await personaBotIdOf(api);
			if (botId === undefined || options.getBotMemory === undefined || options.setBotMemory === undefined) {
				return { isError: true, output: [{ type: "text", text: "Memory persistence is not available for this conversation." }] };
			}
			const current = options.getBotMemory(botId) ?? "";
			const next =
				input.mode === "replace"
					? input.content
					: current === ""
						? input.content
						: `${current.replace(/\s*$/, "")}\n\n${input.content}`;
			options.setBotMemory(botId, next);
			return {
				output: [{ type: "text", text: `Memory updated (${next.length} chars, mode: ${input.mode ?? "append"}).` }],
			};
		},
	});

	const availableSkills = section("available_skills", async (input) => {
		if (options.getBotEnabledSkills === undefined) return undefined;
		const target = await input.read.snapshot(TargetDoc, input.conversationId, BACKGROUND_CONTEXT);
		const botId = target?.botId;
		if (botId === undefined || botId === "") return undefined;
		const skills = options.getBotEnabledSkills(botId);
		if (skills === undefined || skills.length === 0) return undefined;
		const lines = skills.map((skill) => {
			const summary = skillSummary(skill.content);
			return summary === "" ? `- ${skill.id}` : `- ${skill.id}: ${summary}`;
		});
		return [
			"Skills enabled for this persona. When a task matches one, call `load_skill` with its id first:",
			...lines,
		].join("\n");
	});

	return defineExtension({
		name: PERSONA_SKILLS_EXTENSION,
		sections: [availableSkills],
		tools: [loadSkill, updateMemory],
	});
}
