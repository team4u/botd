import type {
  ResourceLoader,
  RegisteredCommand,
  ExtensionCommandContext,
  ExtensionUIContext,
} from '@earendil-works/pi-coding-agent';
import type { BotdUiSpec, ExtensionUiStreamPayload } from '@botd/protocol';
import { validateUiSpec } from '@botd/protocol';
import type { HubStreamSink } from './runtime/hub-stream.js';

/** 测试 / 轻量环境下 hubRpc 的最小形态：仅需 onSessionStream；requestHumanInput 可选 */
export interface WebHubRpc {
  onSessionStream: { asEvent?: (event: never) => unknown } | ((event: never) => unknown);
  requestHumanInput?: (
    input: {
      sessionId: string;
      botId: string;
      prompt: string;
      options?: string[];
      timeoutSeconds?: number;
      previewType?: 'diff' | 'markdown' | 'text' | 'ui';
      previewContent?: string;
    },
  ) => Promise<{ answer: string }>;
}

export interface WebExtensionUIContextOptions {
  sessionId: string;
  botId: string;
  /** Hub RPC 通道：requestHumanInput 缺失时交互式对话（select/confirm/input/editor/custom）显式拒绝 */
  hubRpc: WebHubRpc;
  /** 会话推流 sink：非阻塞流式 UI（notify/status/widget/editor_text）经此发出 */
  sink: Pick<HubStreamSink, 'extensionUi'>;
  /** 纯 TUI 专属方法被拦截时回调（写入 extensionErrors，防止 try/catch 吞错后假成功） */
  onUnsupported: (error: Error) => void;
}

const TRUTHY_CONFIRM_ANSWERS = new Set(['确认', 'yes', 'true', 'ok', 'approve', '1']);

/** Web 端主题占位：SDK eager 展开 {...ui} 时不能抛错，返回只读空对象（类型上伪装为 Theme） */
const WEB_THEME_STUB = Object.freeze({}) as unknown as import('@earendil-works/pi-coding-agent').Theme;

/** 单行输入表单 spec：提交后 state.value 即用户输入 */
function buildInputSpec(title: string, placeholder: string | undefined): BotdUiSpec {
  return {
    root: 'root',
    elements: {
      root: { type: 'Stack', props: { direction: 'vertical' }, children: ['field', 'actions'] },
      field: {
        type: 'TextInput',
        props: { label: title, placeholder: placeholder || '请输入...', value: { $state: 'value' } },
      },
      actions: { type: 'ActionBar', props: { align: 'right' }, children: ['submit', 'cancel'] },
      submit: {
        type: 'Button',
        props: { label: '提交', variant: 'primary' },
        on: { press: { action: 'submit', params: { decision: '提交' } } },
      },
      cancel: {
        type: 'Button',
        props: { label: '取消', variant: 'secondary' },
        on: { press: { action: 'submit', params: { decision: '取消' } } },
      },
    },
    state: { value: '' },
  };
}

/** 多行编辑器表单 spec */
function buildEditorSpec(title: string, prefill?: string): BotdUiSpec {
  return {
    root: 'root',
    elements: {
      root: { type: 'Stack', props: { direction: 'vertical' }, children: ['field', 'actions'] },
      field: {
        type: 'TextInput',
        props: { label: title, multiline: true, rows: 6, value: { $state: 'value' } },
      },
      actions: { type: 'ActionBar', props: { align: 'right' }, children: ['submit', 'cancel'] },
      submit: {
        type: 'Button',
        props: { label: '提交', variant: 'primary' },
        on: { press: { action: 'submit', params: { decision: '提交' } } },
      },
      cancel: {
        type: 'Button',
        props: { label: '取消', variant: 'secondary' },
        on: { press: { action: 'submit', params: { decision: '取消' } } },
      },
    },
    state: { value: prefill ?? '' },
  };
}

/** 解析表单类 ask 的 answer：JSON 提取 state.value / decision=取消；纯文本直接返回（'取消' → undefined） */
function parseFormAnswer(answer: string): string | undefined {
  try {
    const parsed = JSON.parse(answer);
    if (parsed && typeof parsed === 'object') {
      if (parsed.decision === '取消') return undefined;
      if (typeof parsed.state?.value === 'string') return parsed.state.value;
    }
  } catch {
    // 纯文本回复（测试 / 回退输入框）：整体作为输入内容
  }
  const trimmed = answer.trim();
  if (trimmed === '取消') return undefined;
  return trimmed || undefined;
}

/** 解析 ui.custom 的返回值：JSON 对象/数组原样返回，纯文本返回原始字符串 */
function parseCustomAnswer(answer: string): unknown {
  try {
    const parsed = JSON.parse(answer);
    if (parsed && typeof parsed === 'object') return parsed;
  } catch {
    // 非 JSON
  }
  return answer;
}

/** 本地超时/abort 守卫：与 requestHumanInput 竞速，先到者胜（默认值 confirm=false，其余 undefined） */
function withDialogGuard<T>(
  opts: { signal?: AbortSignal; timeout?: number } | undefined,
  resolveDefault: T,
): { guarded: Promise<T>; settle: () => void } {
  let done = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const guarded = new Promise<T>((resolve) => {
    const finish = (value: T) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      if (onAbort && opts?.signal) opts.signal.removeEventListener('abort', onAbort);
      resolve(value);
    };
    if (opts?.signal?.aborted) {
      finish(resolveDefault);
      return;
    }
    if (opts?.signal) {
      onAbort = () => finish(resolveDefault);
      opts.signal.addEventListener('abort', onAbort, { once: true });
    }
    if (typeof opts?.timeout === 'number' && opts.timeout > 0) {
      timer = setTimeout(() => finish(resolveDefault), opts.timeout);
    }
  });
  return { guarded, settle: () => { /* finish 幂等，无需额外动作 */ } };
}

/** timeout(ms) → requestHumanInput.timeoutSeconds（秒，向上取整，最小 1） */
function toTimeoutSeconds(timeoutMs: number | undefined): number | undefined {
  if (typeof timeoutMs !== 'number' || !(timeoutMs > 0)) return undefined;
  return Math.max(1, Math.ceil(timeoutMs / 1000));
}

/** requestHumanInput 超时 reject（hub 侧 /timed? ?out/i）时回退默认值 */
function isTimeoutError(err: unknown): boolean {
  return /timed?\s*out|timeout/i.test(err instanceof Error ? err.message : String(err));
}

/**
 * Web 端扩展 UI 上下文：把 Pi SDK 的 ctx.ui 语义桥接到 botd Web 前端。
 *
 * - 非阻塞实时 UI（notify/setStatus/setWorkingMessage/setWidget/setEditorText/pasteToEditor）经 sink.extensionUi 推流；
 * - 阻塞式人机交互（select/confirm/input/editor/custom(BotdUiSpec)）经 hubRpc.requestHumanInput 闭环，
 *   支持 timeout/AbortSignal（先到者 resolve 默认值：confirm=false，select/input=undefined）；
 * - 纯 TUI 专属能力（theme/onTerminalInput/setFooter/setHeader/setEditorComponent/组件工厂）显式拒绝并上报 onUnsupported。
 */
export function createWebExtensionUIContext(options: WebExtensionUIContextOptions): ExtensionUIContext {
  const { sessionId, botId, hubRpc, sink, onUnsupported } = options;
  const requestHumanInput =
    typeof hubRpc?.requestHumanInput === 'function' ? hubRpc.requestHumanInput.bind(hubRpc) : undefined;

  let editorText = '';
  let toolsExpanded = false;

  /** 纯 TUI 专属能力 / 无交互通道时的对话：显式拒绝（onUnsupported 已记录，吞错也不会假成功） */
  const reject = (method: string): never => {
    const error = new Error(`此命令需要终端界面，当前网页不支持: ui.${method}`);
    onUnsupported(error);
    throw error;
  };

  const send = (event: ExtensionUiStreamPayload) => {
    try {
      sink.extensionUi(sessionId, botId, event);
    } catch {
      // 推流失败不影响回合本身
    }
  };

  const ask = async (input: {
    prompt: string;
    options?: string[];
    timeoutSeconds?: number;
    previewType?: 'ui';
    previewContent?: string;
  }): Promise<string> => {
    return (await requestHumanInput!({ sessionId, botId, ...input })).answer;
  };

  return {
    async select(title, options, opts) {
      if (!Array.isArray(options) || options.length === 0) return undefined;
      if (!requestHumanInput) return reject('select');
      if (opts?.signal?.aborted) return undefined;
      const guard = withDialogGuard<string | undefined>(opts, undefined);
      try {
        const answer = await Promise.race([
          ask({ prompt: title, options, timeoutSeconds: toTimeoutSeconds(opts?.timeout) }),
          guard.guarded,
        ] as [Promise<string>, Promise<string | undefined>]);
        if (answer === undefined) return undefined;
        const trimmed = answer.trim();
        if (trimmed === '取消' && !options.includes('取消')) return undefined;
        return trimmed || undefined;
      } catch (err) {
        if (isTimeoutError(err)) return undefined;
        throw err;
      }
    },

    async confirm(title, message, opts) {
      if (!requestHumanInput) return reject('confirm');
      if (opts?.signal?.aborted) return false;
      const guard = withDialogGuard<boolean>(opts, false);
      const prompt = message ? `${title}\n${message}` : title;
      try {
        const answer = await Promise.race([
          ask({ prompt, options: ['确认', '取消'], timeoutSeconds: toTimeoutSeconds(opts?.timeout) }),
          guard.guarded,
        ] as [Promise<string>, Promise<boolean>]);
        if (typeof answer !== 'string') return false;
        return TRUTHY_CONFIRM_ANSWERS.has(answer.trim().toLowerCase());
      } catch (err) {
        if (isTimeoutError(err)) return false;
        throw err;
      }
    },

    async input(title, placeholder, opts) {
      if (!requestHumanInput) return reject('input');
      if (opts?.signal?.aborted) return undefined;
      const guard = withDialogGuard<string | undefined>(opts, undefined);
      try {
        const answer = await Promise.race([
          ask({
            prompt: title,
            options: [],
            previewType: 'ui',
            previewContent: JSON.stringify(buildInputSpec(title, placeholder)),
            timeoutSeconds: toTimeoutSeconds(opts?.timeout),
          }),
          guard.guarded,
        ] as [Promise<string>, Promise<string | undefined>]);
        if (answer === undefined) return undefined;
        return parseFormAnswer(answer);
      } catch (err) {
        if (isTimeoutError(err)) return undefined;
        throw err;
      }
    },

    async editor(title, prefill) {
      if (!requestHumanInput) return reject('editor');
      const answer = await ask({
        prompt: title,
        options: [],
        previewType: 'ui',
        previewContent: JSON.stringify(buildEditorSpec(title, prefill)),
      });
      return parseFormAnswer(answer);
    },

    notify(message, type) {
      send({ kind: 'notify', message: String(message), notifyType: type ?? 'info' });
    },

    onTerminalInput() {
      // 注册型 API：Web 端无终端按键流，监听器永不触发；安全 no-op（内置 pi-subagents 扩展
      // 在 ctx.hasUI 为 true 时会注册快捷键，盲目拒绝会击穿 session_start 生命周期）
      return () => {};
    },

    setStatus(key, text) {
      send({ kind: 'status', statusKey: key, ...(text !== undefined ? { statusText: text } : {}) });
    },

    setWorkingMessage(message) {
      send({ kind: 'working_message', ...(message !== undefined ? { message } : {}) });
    },

    setWorkingVisible() {
      // Web 端无内置 loader 行，安全 no-op
    },

    setWorkingIndicator() {
      // TUI 帧动画专属，Web 端 no-op
    },

    setHiddenThinkingLabel() {
      // TUI 思考块标签专属，Web 端 no-op
    },

    setWidget(key, content, widgetOptions) {
      const placement = widgetOptions?.placement;
      if (content === undefined) {
        send({ kind: 'widget', widgetKey: key, ...(placement ? { placement } : {}) });
        return;
      }
      if (typeof content === 'function') {
        // TUI 组件工厂需要终端画布与键盘流，Web 端无法承载
        reject('setWidget');
        return;
      }
      if (Array.isArray(content)) {
        send({
          kind: 'widget',
          widgetKey: key,
          lines: content.map(String),
          ...(placement ? { placement } : {}),
        });
        return;
      }
      // 声明式 BotdUiSpec（裸 spec 或 { ui: spec } 包装）
      const raw = (content as { ui?: unknown }).ui ?? content;
      const res = validateUiSpec(raw);
      if (!res.ok) {
        throw new Error(`Invalid UI spec in ui.setWidget: ${res.errors.join('; ')}`);
      }
      send({ kind: 'widget', widgetKey: key, uiSpec: res.spec, ...(placement ? { placement } : {}) });
    },

    setFooter: () => reject('setFooter'),
    setHeader: () => reject('setHeader'),

    setTitle() {
      // 终端窗口标题专属，Web 端 no-op
    },

    async custom(factoryOrSpec) {
      if (typeof factoryOrSpec === 'function') {
        // 绝不执行 TUI 组件工厂函数体
        return reject('custom');
      }
      if (factoryOrSpec === null || typeof factoryOrSpec !== 'object') {
        throw new Error('Invalid UI spec in ui.custom: expected BotdUiSpec object');
      }
      if (!requestHumanInput) return reject('custom');
      const holder = factoryOrSpec as { ui?: unknown; prompt?: string; title?: string };
      const validation = validateUiSpec(holder.ui ?? factoryOrSpec);
      if (!validation.ok) {
        throw new Error(`Invalid UI spec in ui.custom: ${validation.errors.join('; ')}`);
      }
      const answer = await ask({
        prompt: holder.prompt || holder.title || '请完成交互操作',
        options: [],
        previewType: 'ui',
        previewContent: validation.normalizedJson,
      });
      return parseCustomAnswer(answer) as never;
    },

    pasteToEditor(text) {
      const appended = String(text ?? '');
      editorText = editorText ? editorText + appended : appended;
      send({ kind: 'editor_text', text: appended, mode: 'paste' });
    },

    setEditorText(text) {
      editorText = String(text ?? '');
      send({ kind: 'editor_text', text: editorText, mode: 'set' });
    },

    getEditorText() {
      return editorText;
    },

    addAutocompleteProvider: () => reject('addAutocompleteProvider'),

    setEditorComponent: () => reject('setEditorComponent'),
    getEditorComponent() {
      reject('getEditorComponent');
      return undefined;
    },

    get theme() {
      // SDK setUIContext 的 wrapUIPromptContext 会 eager 展开 {...ui}，getter 不能抛错；
      // Web 端返回只读空主题对象占位（方法型 API getTheme/setTheme/getAllThemes 依然显式拒绝）
      return WEB_THEME_STUB;
    },
    getAllThemes: () => reject('getAllThemes'),
    getTheme: () => {
      reject('getTheme');
      return undefined;
    },
    setTheme: () => {
      reject('setTheme');
      return { success: false, error: '此命令需要终端界面，当前网页不支持: ui.setTheme' };
    },

    getToolsExpanded() {
      return toolsExpanded;
    },
    setToolsExpanded(expanded) {
      toolsExpanded = Boolean(expanded);
    },
  };
}

/**
 * 包装扩展命令 handler：把 ctx.ui 替换为 Web 桥接上下文（与 bindExtensions 同一实例），
 * 使命令 handler 内的 ctx.ui.* 拥有与生命周期钩子/工具一致的 Web 语义；
 * 纯 TUI 方法在上下文内部已显式拒绝并触发 onUnsupported。
 * 未提供 webUiContext 时保持旧的全量拒绝行为（防御性兜底）。
 */
export function guardExtensionCommands(
  loader: ResourceLoader,
  onUnsupported: (error: Error) => void,
  webUiContext?: ExtensionUIContext,
): void {
  const wrappedCommands = new WeakSet<RegisteredCommand>();
  const { extensions } = loader.getExtensions();
  for (const ext of extensions) {
    for (const command of ext.commands.values()) {
      if (wrappedCommands.has(command)) continue;
      wrappedCommands.add(command);

      const originalHandler = command.handler;
      command.handler = async (args: string, ctx: ExtensionCommandContext) => {
        if (!webUiContext) {
          const reject = (method: PropertyKey): never => {
            const error = new Error(`此命令需要终端界面，当前网页不支持: ui.${String(method)}`);
            onUnsupported(error);
            throw error;
          };
          const ui = new Proxy(ctx.ui as ExtensionUIContext, {
            get(target, key, receiver) {
              if (typeof key === 'symbol') return Reflect.get(target, key, receiver);
              if (key === 'theme') return reject(key);
              const value = Reflect.get(target, key, receiver);
              return typeof value === 'function' ? () => reject(key) : reject(key);
            },
          });
          const context = new Proxy(ctx, {
            get(target, key, receiver) {
              return key === 'ui' ? ui : Reflect.get(target, key, receiver);
            },
          });
          await originalHandler(args, context);
          return;
        }

        const context = new Proxy(ctx, {
          get(target, key, receiver) {
            return key === 'ui' ? webUiContext : Reflect.get(target, key, receiver);
          },
        });
        await originalHandler(args, context);
      };
    }
  }
}
