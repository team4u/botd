/**
 * workflow-script.ts — workflow 脚本解析与结构化 JSON 提取（纯函数，无副作用）。
 */
import vm from 'node:vm';

/** 脚本 `export const meta` 元信息。 */
export interface WorkflowScriptMeta {
	name: string;
	description?: string;
	phases?: string[];
}

/** 编译后的脚本模块：meta + 以 hooks 为参执行脚本体的 run()。 */
export interface WorkflowScriptModule {
	meta: WorkflowScriptMeta;
	run: (hooks: unknown) => Promise<unknown>;
}

const DEFAULT_META: WorkflowScriptMeta = { name: 'workflow' };

/** 提取 `export const meta = {...}`（支持单双引号与对象字面量）。 */
export function extractMeta(source: string): WorkflowScriptMeta {
	const match = source.match(/export\s+const\s+meta\s*=\s*(\{[\s\S]*?\})\s*(?:;|\n|$)/);
	if (!match) return { ...DEFAULT_META };
	try {
		const evaluated = vm.runInNewContext(`(${match[1]})`) as Partial<WorkflowScriptMeta>;
		return {
			name: typeof evaluated.name === 'string' ? evaluated.name : 'workflow',
			description: typeof evaluated.description === 'string' ? evaluated.description : undefined,
			phases: Array.isArray(evaluated.phases) ? evaluated.phases.map(String) : undefined,
		};
	} catch {
		return { ...DEFAULT_META };
	}
}

/** 把脚本体改写为在隔离上下文中执行的异步工厂函数。 */
export function parseWorkflowScript(source: string): { module: WorkflowScriptModule; meta: WorkflowScriptMeta } | { error: string } {
	let meta: WorkflowScriptMeta;
	try {
		meta = extractMeta(source);
	} catch {
		meta = { ...DEFAULT_META };
	}

	// 去掉 meta 导出语句（跨行贪婪到闭合大括号 + 分号），其余顶层代码包进异步工厂；
	// 工厂参数直接解构出 agent/phase/log/pipeline/parallel/args，脚本体可立即使用
	const body = source.replace(/export\s+const\s+meta\s*=\s*\{[\s\S]*?\}\s*;?[\t ]*\r?\n?/, '');
	const wrapped = `(async ({ agent, phase, log, pipeline, parallel, args }) => {\n${body}\n})`;
	try {
		const script = new vm.Script(wrapped, { filename: 'workflow-script.mjs' });
		const context = vm.createContext({ Promise, JSON, Math, Array, Object, String, Number, Boolean, Error, console: { log: () => {} } });
		const factory = script.runInContext(context) as (hooks: unknown) => Promise<unknown>;
		if (typeof factory !== 'function') return { error: 'workflow script did not compile to an async function' };
		return {
			meta,
			module: {
				meta,
				// vm 沙箱内构造的对象携带 vm 全局的原型，宿主侧 copyJson 会拒绝；
				// JSON 往返把返回值归一成宿主 Object.prototype
				run: async (hooks: unknown) => JSON.parse(JSON.stringify(await factory(hooks))),
			},
		};
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}

/** 从文本回复提取结构化 JSON：整体 → ```json 围栏 → 首尾大括号截取。 */
export function extractWorkflowJson(text: string): unknown | undefined {
	const trimmed = text.trim();
	try {
		return JSON.parse(trimmed);
	} catch {
		// fall through
	}
	const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
	if (fence) {
		try {
			return JSON.parse(fence[1]);
		} catch {
			// fall through
		}
	}
	const first = trimmed.indexOf('{');
	const last = trimmed.lastIndexOf('}');
	if (first >= 0 && last > first) {
		try {
			return JSON.parse(trimmed.slice(first, last + 1));
		} catch {
			return undefined;
		}
	}
	return undefined;
}
