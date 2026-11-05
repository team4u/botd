/**
 * Worker layer of the Multi-Persona Super-agent (DeepSeek §2.2).
 *
 * A Worker is a background conversation spawned by a Router (see
 * router-extension.ts). This extension gives it:
 *
 * - a task-owned `subagent` tool, so a Worker can split sub-tasks into child
 *   conversations owned by the running tool task (crash-safe replay);
 * - an `afterRun` hook on `GenerationTask` that, when a Worker conversation
 *   finishes its run with an answer, writes the result into the session-wide
 *   Chain of Recall, marks the worker completed in the parent Router's
 *   `WorkerRegistryDoc`, and posts a compact notification back to the Router
 *   conversation. The report-back task uses a deterministic
 *   `requestId: "worker-report:<taskId>"` so restarts never double-report.
 */
import { bool, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import {
	AssistantEntry,
	defineExtension,
	defineTask,
	defineTool,
	GenerationTask,
	hook,
	runEndTask,
	type ConversationId,
	type Extension,
} from "@earendil-works/pi-durable";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { RecallIndexDoc, TargetDoc, WorkerRegistryDoc } from "./docs.js";
import { askHumanTool } from "./router-extension.js";
import { assistantEntryText } from "./recall-content.js";
import { configure, type AgentChange } from "@earendil-works/pi-durable";

export const WORKER_EXTENSION_NAME = "botd-worker";

/** Resolves a registered subagent/bot persona into its real agent change (model, instructions, extensions, toolScope). */
export type SubagentChangeResolver = (agentType: string, cwd?: string) => AgentChange | undefined;

// Branded ConversationId <-> string: documents store plain strings.
const toId = (value: string): ConversationId => {
	const numeric = Number(value);
	if (!Number.isInteger(numeric)) throw new Error(`invalid conversation id: ${value}`);
	return numeric as ConversationId;
};
const idToString = (id: ConversationId): string => String(id);
const conversationIdToString = idToString;
const stringToConversationId = toId;

const SUMMARY_LIMIT = 200;
/** Answers up to this length ride inline in the completion notification; longer ones spill to a local file. */
const INLINE_LIMIT = 4000;
/** Preview carried by the recall index node: the index is a catalog card, never a full body. */
const PREVIEW_LIMIT = 800;
/** One-line summary cap for the recall index node. */
const SUMMARY_LINE_LIMIT = 160;

/** Write the full report to `<cwd>/.botd/recall/<workerId>.md`; returns the absolute path and byte size. */
async function spillReportToDisk(cwd: string, workerId: string, answer: string): Promise<{ spillPath: string; spillBytes: number }> {
	const spillPath = path.resolve(cwd, ".botd", "recall", `${workerId}.md`);
	await mkdir(path.dirname(spillPath), { recursive: true });
	await writeFile(spillPath, answer, "utf8");
	return { spillPath, spillBytes: Buffer.byteLength(answer, "utf8") };
}

/**
 * The durable report-back task. Created by the `afterRun` hook as a child of
 * the worker's generation; commits its writes in one commit and posts the
 * notification to the parent Router conversation as a follow-up input with a
 * deterministic requestId (exactly-once across restarts).
 */
interface WorkerReportInput {
	workerId: string;
	parentConversationId: string;
	title: string;
	answer: string;
	/** Worker cwd (from TargetDoc): where a long report spills to `.botd/recall/<workerId>.md`. */
	cwd?: string;
	worktreePath?: string;
	branchName?: string;
}

const WorkerReportTask = defineTask<WorkerReportInput, { phase: "report" }, { reported: boolean }>({
	name: "botd.worker-report",
	version: 1,
	initial: () => ({ phase: "report" }),
	phases: {
		report: async (task, runtime, context) => {
			const input = task.input;
			const summary =
				input.answer.length > SUMMARY_LIMIT
					? `${input.answer.slice(0, SUMMARY_LIMIT)}…`
					: input.answer;

			// Length-based routing (Chain of Recall Inline & Spill): short answers ride
			// inline in full so the Router reads them with zero extra tool calls; long
			// ones spill to `<cwd>/.botd/recall/<workerId>.md` and the notification
			// carries a preview plus a pointer. A spill failure degrades to inline —
			// never drop a report because the disk refused it.
			let body = "";
			let spillPath: string | undefined;
			let spillBytes: number | undefined;
			if (input.answer.length <= INLINE_LIMIT) {
				body = input.answer;
			} else {
				const cwd = input.cwd ?? process.cwd();
				try {
					({ spillPath, spillBytes } = await spillReportToDisk(cwd, input.workerId, input.answer));
				} catch (error) {
					const reason = error instanceof Error ? error.message : String(error);
					body = `${input.answer.slice(0, INLINE_LIMIT)}\n[Spill failed: ${reason}]`;
				}
				if (spillPath !== undefined) {
					body =
						`${input.answer.slice(0, 1500)}\n` +
						`[Spilled ${input.answer.length} chars -> full report: ${spillPath} | recall({ id: "${input.workerId}" }) or read the file]`;
				}
			}

			const notification =
				`[Worker Completed: ${input.workerId} | ${input.title}]\n` +
				`Summary: ${summary}\n` +
				(input.worktreePath === undefined ? "" : `Worktree: ${input.branchName ?? "worktree"} (${input.worktreePath})\n`) +
				`${body}\n` +
				`(Use recall({ id: "${input.workerId}" }) for full transcript & details)`;

			// Acquire the parent handle BEFORE the commit: `runtime.conversation()` is a
			// line job of its own, and calling it inside this commit's callback would
			// wait for the commit that awaits it (a deadlock).
			const parentId = stringToConversationId(input.parentConversationId);
			const router = await runtime.conversation(parentId, context);

			await runtime.commit(async (tx) => {
				// 1. Index into the session-wide Chain of Recall. The doc stays a pure
				//    index: one-line summary + 800-char catalog preview (+ spill pointer
				//    when the body went to disk) — never a full-body copy.
				const recall = await tx.doc(RecallIndexDoc);
				const summaryLine = `Completed: ${input.title}`.slice(0, SUMMARY_LINE_LIMIT);
				const node = recall.nodes[input.workerId];
				if (node !== undefined) {
					node.summary = summaryLine;
					node.contentPreview = input.answer.slice(0, PREVIEW_LIMIT);
					if (spillPath !== undefined) {
						node.spillPath = spillPath;
						node.spillBytes = spillBytes;
					}
				} else {
					recall.nodes[input.workerId] = {
						id: input.workerId,
						kind: "worker",
						title: input.title,
						summary: summaryLine,
						contentPreview: input.answer.slice(0, PREVIEW_LIMIT),
						...(spillPath === undefined ? {} : { spillPath, ...(spillBytes === undefined ? {} : { spillBytes }) }),
						conversationId: conversationIdToString(runtime.conversationId),
						relatedIds: [],
						createdAt: runtime.now(),
					};
				}

				// 2. Mark the worker completed in the parent Router's registry. A worker
				// woken by a follow-up/steer runs a second round after "completed"; keep
				// the fresh summary instead of discarding it (an explicit abort still wins).
				const registry = await tx.doc(WorkerRegistryDoc, parentId);
				const entry = registry.workers[input.workerId];
				if (entry !== undefined && entry.status !== "aborted") {
					entry.status = "completed";
					entry.finishedAt = runtime.now();
					entry.summary = summary;
				}

				// 3. Post the compact notification back to the Router (follow-up input;
				//    deterministic requestId keeps a restart from double-reporting).
				if (router !== undefined) {
					await router.submit(tx, {
						type: "input",
						content: notification,
						requestId: `worker-report:${task.id}`,
						entry: { kind: "botd.worker-report", data: { workerId: input.workerId } },
					});
				}

				return {
					status: "terminal",
					outcome: { status: "completed", result: { reported: true } },
				};
			}, context);
		},
	},
	abort: (_task, runtime, context) =>
		runtime.commit(
			() => ({
				status: "terminal",
				outcome: { status: "aborted" },
			}),
			context,
		),
});

/** Task-owned foreground subagent: the Worker's child conversations. */
const subagentToolFor = (resolveSubagentChange: SubagentChangeResolver | undefined) =>
	defineTool({
		name: "subagent",
		description:
			"Delegate a self-contained sub-task to an isolated child agent conversation and get its answer back. " +
			"The child is owned by this tool call (aborted with it) and is replay-safe across crashes. " +
			"Pass agentType to run as a registered subagent persona (its model, instructions and toolScope); " +
			"pass worktree: true (or isolation: 'worktree') to run it in an isolated git worktree; " +
			"by default a child inherits the parent's worktree when the parent runs in one.",
		parameters: obj({
			task: str({ description: "Complete instructions for the sub-agent" }),
			agentType: opt(str({ description: "Optional subagent persona id to run as" })),
			worktree: opt(bool({ description: "Give the subagent an isolated git worktree" })),
			isolation: opt(oneOf(["off", "worktree"])),
			forkContext: opt(bool({ description: "Fork this conversation's context into the subagent (default false)" })),
		}),
		replay: "safe",
		async execute(args, api, context) {
			const useWorktree = args.worktree === true || args.isolation === "worktree";
			let branchName = "";
			let worktreePath = "";
			// A registered subagent persona runs with its real identity (model,
			// SYSTEM.md, toolScope) instead of a blank generic child.
			const resolvedChange =
				args.agentType !== undefined ? resolveSubagentChange?.(args.agentType) : undefined;
			const child = await api.commit(async (tx) => {
				// The ownership index remembers the child, so a rerun reuses it.
				const existing = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0];
				if (existing !== undefined) {
					const existingTarget = await tx.doc(TargetDoc, existing.id);
					branchName = existingTarget.branchName ?? "";
					worktreePath = existingTarget.worktreePath ?? "";
					return existing.id;
				}
				let record;
				if (args.forkContext === true) {
					const latest = await tx.latestEntryId(api.conversationId);
					record =
						latest === undefined
						? await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } })
						: await tx.forkConversation(api.conversationId, latest, {
								ownership: { kind: "task", taskId: api.taskId },
							});
				} else {
					record = await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
				}
				// Apply the resolved subagent persona (model / instructions / extensions /
				// toolScope) when one matched; otherwise the child keeps the host default.
				if (resolvedChange !== undefined) {
					await configure(tx, record.id, resolvedChange);
				}
				// Mark it as a subagent in its target doc.
				const workerTarget = await tx.doc(TargetDoc, record.id);
				const self = await tx.doc(TargetDoc, api.conversationId);
				if (useWorktree) {
					const baseCwd = self.cwd || process.cwd();
					const subId = `sub-${record.id}`;
					branchName = `botd/${subId}`;
					worktreePath = `${baseCwd}/.botd-worktrees/${subId}`;
				} else if (args.isolation !== "off" && self.worktreePath) {
					// Inherit the parent's worktree: a Worker already isolated in one must
					// not have its children bounce back to the main checkout.
					branchName = self.branchName ?? "";
					worktreePath = self.worktreePath;
				}
				Object.assign(workerTarget, {
					// Running as a registered subagent persona re-targets the child onto it.
					botId: args.agentType !== undefined && resolvedChange !== undefined ? args.agentType.replace(/^@/, "") : self.botId,
					role: "subagent" as const,
					parentConversationId: conversationIdToString(api.conversationId),
					nodeId: self.nodeId,
					cwd: self.cwd,
					...(self.sessionId ? { sessionId: self.sessionId } : {}),
					...(worktreePath ? { worktreePath, branchName } : {}),
					threadKeys: [],
					title: args.task.slice(0, 80),
				});
				return record.id;
			}, context);

			await api.details({ conversationId: child }, context);
			const request = {
				type: "input" as const,
				content: args.task,
				requestId: `subagent:${api.taskId}` as const,
			};
			const conversation = await api.conversation(child, context);
			if (conversation === undefined) throw new Error("subagent conversation is gone");
			const settled = await (await conversation.submit(request, context)).wait(context);
			let text: string = settled.status;
			if (settled.status === "done" && settled.type === "input") {
				// ToolExecutionApi has no entry(); read the answer entry inside a commit.
				const answerEntry = await api.commit(
					(tx) => tx.entry(AssistantEntry, settled.answer),
					context,
				);
				text = assistantEntryText(answerEntry) || settled.status;
			}
			if (useWorktree) text += `\n[worktree: ${branchName} at ${worktreePath}]`;
			return { output: [{ type: "text", text }] };
		},
	});

export function createWorkerExtension(
	options: { resolveSubagentChange?: SubagentChangeResolver } = {},
): Extension {
	return defineExtension({
		name: WORKER_EXTENSION_NAME,
		tasks: [WorkerReportTask],
		tools: [subagentToolFor(options.resolveSubagentChange), askHumanTool],
		sections: [],
		hooks: [
			hook(GenerationTask, {
				afterRun: async (run, api, context) => {
					// Only Worker conversations report back; routers and plain chats do not.
					const target = await api.snapshot(TargetDoc, api.conversationId, context);
					if (target === undefined || target.role !== "worker") return undefined;
					if (target.parentConversationId === undefined) return undefined;

					// Extract the final assistant answer text.
					const answerEntry = await api.entry(AssistantEntry, run.answer, context);
					const answer = assistantEntryText(answerEntry);
					if (answer === "") return undefined;

					// Which workerId? The newest `botd.worker-task` input in this run names it.
					const page = await api.entries(
						{ minEntryId: run.first, maxEntryId: run.last, order: "ascending" },
						200,
						undefined,
						context,
					);
					let workerId = "";
					let title = target.title ?? "worker";
					for (const entry of page.items) {
						if (entry.kind !== "botd.worker-task") continue;
						const data = entry.data as { workerId?: string; title?: string } | undefined;
						if (data?.workerId !== undefined) workerId = data.workerId;
						if (data?.title !== undefined) title = data.title;
					}
					if (workerId === "") return undefined;

					return {
						tasks: [
							runEndTask(WorkerReportTask, {
								workerId,
								parentConversationId: target.parentConversationId,
								title,
								answer,
								...(target.cwd === "" ? {} : { cwd: target.cwd }),
								...(target.worktreePath === undefined ? {} : { worktreePath: target.worktreePath }),
								...(target.branchName === undefined ? {} : { branchName: target.branchName }),
							}),
						],
					};
				},
			}),
		],
	});
}
