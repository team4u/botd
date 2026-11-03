# 扩展开发指南

[文档目录](README.md)

扩展（Extension）是给 Bot 增加能力的可执行 TypeScript 代码：拦截工具调用、注册模型可调用的工具、添加 `/` 命令、在网页上渲染交互界面。本文讲怎么写一个扩展——从空文件到带完整 UI 的生产级扩展。

botd 的扩展基于 [Pi SDK](https://github.com/earendil-works/pi-coding-agent) 的扩展 API，并在其之上桥接了 Web 界面：**一次编写，终端与网页都能跑**；带 UI 的扩展（`ctx.ui` 弹窗、输入框挂件、工具富视图）无需任何前端构建，全部通过声明式 JSON 契约（`BotdUiSpec`）渲染。

- 想让 Bot 输出确认卡片、表单而不写代码？看[生成式 UI](generative-ui.md)。
- 想装现成的扩展？看[用户指南 · 扩展安装与使用](user-guide.md#扩展安装与使用与-web-ui-无缝融合)与 [CLI 参考 · install](cli.md#install)。

## 扩展是什么

一个扩展就是一个导出默认工厂函数的 TypeScript 模块，落在节点的 `~/.botd/extensions/<id>/index.ts`：

```ts
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

export default function (pi: ExtensionAPI) {
  // 在这里注册能力
}
```

工厂函数在 Bot 回合建立会话时被调用，拿到 `pi`（注册 API）注册钩子、工具与命令；运行期事件处理器与工具执行函数拿到 `ctx`（上下文，含 `ctx.ui`）。

扩展能做的事，按「在哪生效」分四类：

| 能力 | 注册方式 | 生效位置 |
| --- | --- | --- |
| 事件钩子（拦截 / 注入上下文） | `pi.on('tool_call', handler)` 等 | 回合生命周期各阶段 |
| 模型可调用的工具 | `pi.registerTool({...})` | Bot 的工具循环 |
| 斜杠命令 | `pi.registerCommand(name, {...})` | 输入框 `/` 命令浮层 |
| Web 交互界面 | `ctx.ui.*` + `details.ui` | 网页会话界面 |

文件布局约定：

```text
~/.botd/extensions/
└── my-ext/
    ├── index.ts          # 入口（必需）
    └── package.json      # 声明 npm 依赖时才需要
```

多文件扩展把辅助模块放在同目录再 `import` 即可。需要 npm 依赖时写一个 `package.json` 列出 `dependencies`，安装器会在安装时执行 `npm install --omit=dev`。

## 第一个扩展

最小可用的扩展——拦截高危命令并在网页弹出确认卡：

```ts
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

export default function (pi: ExtensionAPI) {
  pi.on('tool_call', async (event, ctx) => {
    if (event.toolName !== 'bash') return;
    const cmd = String((event.input as { command?: string })?.command || '');
    if (!/rm\s+-rf|git\s+push.*--force/.test(cmd)) return;

    // 网页上弹出「确认 / 取消」卡片，等待用户作答；超时或取消返回 false
    const ok = await ctx.ui.confirm('高危命令审批', cmd, { timeout: 300_000 });
    if (!ok) return { block: true, reason: '用户拒绝了该高危命令' };
    // 不返回（或返回 undefined）= 放行
  });
}
```

把它保存到节点上（三种方式任选）：

```bash
# 方式一：CLI 本地安装并立即绑定当前 Bot
botd install ./my-ext --bot "$BOTD_BOT_ID"

# 方式二：先落盘再挂载
mkdir -p ~/.botd/extensions/my-ext
# 把 index.ts 写进去，然后：
botd reload
botd bots update "$BOTD_BOT_ID" --extension my-ext

# 方式三：网页「节点与智能体」→ 新建扩展 → 在线粘贴代码，
#         底部勾选「启用到本节点智能体」一键保存挂载
```

安装后无需重启守护进程，下一回合即生效。之后 Bot 每次要跑 `rm -rf` 或 `git push --force`，网页上都会先弹出审批卡。

## 事件钩子

`pi.on(event, handler)` 订阅回合生命周期事件。常用的：

| 事件 | 时机 | 典型用途 |
| --- | --- | --- |
| `session_start` | 会话建立 | 初始化状态、挂载常驻挂件 |
| `before_agent_start` | 每次模型调用前 | 注入上下文、改写系统提示 |
| `tool_call` | 工具执行前 | 审批、拦截、改参数 |
| `tool_result` | 工具执行后 | 后处理、触发通知 |
| `session_shutdown` | 会话结束 | 清理资源 |

`tool_call` 处理器返回 `{ block: true, reason }` 可以否决本次调用；其余事件按需返回修改结果，不返回即透传。完整事件清单见 Pi 官方文档的 Events 一节。

写有状态扩展时注意：工厂函数每个会话调用一次，闭包里的变量就是该会话的私有状态，无需额外持久化机制。

## 注册工具

`pi.registerTool` 注册模型可调用的工具。参数用 JSON Schema（或 typebox）描述；执行函数的返回值里，`content` 是给模型看的文本，`details.ui` 是给人看的富视图：

```ts
pi.registerTool({
  name: 'deploy_status',
  label: '部署状态',
  description: '查询指定服务的当前部署状态',
  parameters: {
    type: 'object',
    properties: { service: { type: 'string', description: '服务名' } },
    required: ['service'],
  },
  execute: async (_toolCallId, params: { service: string }, _signal, _onUpdate, ctx) => {
    const stats = await queryStats(params.service); // 你的实现

    // 给网页：工具卡片直接渲染成指标面板（tool.view 插槽）
    return {
      content: [{ type: 'text', text: JSON.stringify(stats) }], // 给模型
      details: {
        ui: {
          root: 'grid',
          elements: {
            grid: { type: 'MetricGrid', props: { columns: 3 }, children: ['a', 'b', 'c'] },
            a: { type: 'MetricCard', props: { label: '副本数', value: String(stats.replicas), icon: 'server' } },
            b: { type: 'MetricCard', props: { label: '就绪', value: String(stats.ready), status: stats.ready < stats.replicas ? 'warn' : 'ok' } },
            c: { type: 'MetricCard', props: { label: '版本', value: stats.version, icon: 'git-branch' } },
          },
        },
      },
    };
  },
});
```

`details.ui` 在节点上经过 `validateUiSpec` 校验，非法时静默降级为普通文本预览，不会炸掉工具调用。组件目录（17 个）见[生成式 UI · 组件目录](generative-ui.md#组件目录17-个)。

## 注册命令

`pi.registerCommand` 注册 `/` 命令。命令出现在网页输入框的命令浮层（带「扩展」徽标），也会出现在输入框上方的快捷胶囊条里，点击即执行：

```ts
pi.registerCommand('deploy-ask', {
  description: '弹出部署参数表单',
  handler: async (_args, ctx) => {
    const answer = await ctx.ui.custom({
      title: '部署参数',
      prompt: '请填写部署参数',
      ui: { /* BotdUiSpec：下拉选环境 + 提交按钮 */ },
    });
    ctx.ui.notify(`已提交: ${JSON.stringify(answer)}`, 'info');
  },
});
```

带 `argumentHint` 的命令点击胶囊后预填到输入框；无参命令点击直接执行。

## Web 界面：ctx.ui 与三大插槽

`ctx.ui` 是扩展与用户交互的入口。在终端里它是 TUI 对话框；在 botd 网页会话里，它被桥接为原生 Web 组件——**扩展代码不用区分运行环境，写一份即可**。

### 方法总览

**阻塞式对话框**（`await` 等待网页上的人作答）：

| 方法 | Web 端表现 | 返回 |
| --- | --- | --- |
| `confirm(title, message, opts)` | 确认 / 取消卡片 | `boolean`，超时或中止为 `false` |
| `select(title, options, opts)` | 选项按钮卡 | 所选文本，取消为 `undefined` |
| `input(title, placeholder, opts)` | 单行输入表单卡 | 输入字符串 |
| `editor(title, prefill)` | 多行编辑表单卡 | 输入字符串 |
| `custom({ title, prompt, ui })` | 完整 `BotdUiSpec` 交互卡 | 提交的 `{ decision, state }` |

`opts` 支持 `timeout`（毫秒，带倒计时）与 `signal`（`AbortSignal`）。这类请求也会同步推送到飞书 / Slack / Telegram 等外部渠道（自动降级为摘要 + 一键确认链接或网页填写入口，见[外部渠道](channels.md)），在手机上也能完成审批。

**非阻塞实时 UI**（即时推流，不等待）：

| 方法 | Web 端表现 |
| --- | --- |
| `notify(message, type)` | 右上角 Toast |
| `setStatus(key, text)` | 输入框上方状态徽标（`text` 传 `undefined` 清除） |
| `setWorkingMessage(message)` | 会话运行中的工作消息 |
| `setEditorText(text)` / `pasteToEditor(text)` | 预填 / 追加输入框内容 |
| `setWidget(key, content, opts)` | 输入框上方 / 下方常驻挂件 |

### 三大插槽

UI 能挂到网页的三个位置（插槽思想），完整代码示例见[生成式 UI · 在 Pi 扩展中使用全栈 UI](generative-ui.md#在-pi-扩展中使用全栈-uictxui-与三大插槽)：

1. **`dialog.custom`** —— 交互表单弹在聊天流里，`await` 拿到 `{ decision, state }` 后继续执行。适合审批、参数收集。
2. **`composer.widget`** —— `ctx.ui.setWidget(key, spec, { placement })` 在输入框上下挂实时面板（构建进度、监控指标、日志尾巴）。面板里的 `Button` 可直接点击，点击后把命令与表单状态回灌发送，实现「卡片按钮 → 扩展命令 → 刷新卡片」的操控闭环。`content` 传 `string[]` 渲染为等宽文本行，传 `undefined` 清除。
3. **`tool.view`** —— 工具返回的 `details.ui` 渲染在工具卡内，随消息落库，刷新页面、节点离线、公开分享链接里都还能看。

### 终端专属能力的边界

以下方法依赖终端画布与键盘流，在 botd 网页端调用会显式报错（错误会让命令失败，不会被吞成假成功）：`ctx.ui.custom(fn)` 传组件工厂、`setWidget` 传组件工厂、`setFooter`、`setHeader`、`setEditorComponent`、`addAutocompleteProvider`、主题 API（`theme` / `setTheme` / `getTheme` / `getAllThemes`）、`onTerminalInput`。

替代方案永远是声明式的：`custom({ ui: spec })`、`setWidget(key, spec)`、`details.ui`。

扩展如需兼容纯终端（非 botd）环境，用 `ctx.mode`（botd 网页回合为 `'print'`）与 `ctx.hasUI`（botd 网页桥接下为 `true`）分支。

## 安装、更新与分发

### 安装来源

| 来源 | 示例 | 说明 |
| --- | --- | --- |
| 本地文件 / 目录 | `./my-ext.ts`、`./my-ext` | 开发期最常用 |
| Git 仓库 | `git:github.com/owner/repo@v1` | `@v1` 为分支或标签 |
| GitHub 简写 | `owner/repo` | 等价完整 URL |
| npm 包 | `npm:@scope/pkg@1.0.0` | 兼容 Pi Package 生态 |

npm 来源的包若在其 `package.json` 中声明了 `pi` 清单（`{ "pi": { "extensions": [...] } }`，即标准 Pi Package），botd 会完整装载其声明的入口，而不是只重导出默认导出——Pi 社区发布的扩展包可以直接装。

### 一键绑定

`--bot` 参数在安装后立即把资源写入指定 Bot 的启用清单，省去二次操作：

```bash
botd install ./my-ext --bot ops-bot lead-bot   # 可写多个
```

### 更新与热重载

改完代码后执行 `botd reload`（或等待守护进程自动重载），下一回合生效。从 Git / npm 来源重装同名扩展即覆盖更新。

### 分发

把扩展目录推到 Git 仓库即可分享；进阶可发布为 npm 包并打上 `pi-package` 关键字进入 Pi 生态。团队内共享走节点资源可见性（`team`），见[团队协作](team.md)。

## 调试

- **看错误**：扩展加载失败与运行期错误会出现在回合的错误消息与守护进程日志里（`botd status` 查看日志路径）。
- **网页在线编辑器**：节点与智能体 → 扩展 → 在线编码，保存即热重载，适合快速迭代。
- **`try/catch` 不会掩盖失败**：扩展命令内部吞掉 `ctx.ui` 的报错（如误用终端专属方法）不会让命令假成功——错误同样会被回合收集并上报。
- **最小化验证**：先用 `pi.registerCommand('ping', { handler: (_a, ctx) => ctx.ui.notify('pong', 'info') })` 确认扩展加载与 UI 桥接都通，再逐步加功能。

## 安全须知

扩展以节点守护进程的完整系统权限运行：能读写文件、执行命令、访问凭据。因此：

- 只安装来自可信来源的扩展，安装前审阅代码；
- 不要把高权限扩展设为团队共享资源；
- Bot 自己写扩展安装（自举）时，注意它继承的权限边界，必要时配合只读模式（`toolScope: readonly`）或命令审批类扩展做防护。

## 与 Pi 官方扩展的关系

botd 的扩展就是 Pi 扩展的超集：任何符合 Pi `ExtensionAPI` 的扩展可直接安装运行；额外获得的是 `ctx.ui` 的 Web 桥接与 `details.ui` 富视图。Pi 官方文档中的 Custom Tools、Events、State Management 等章节在 botd 中同样适用。

## 下一步

- 完整的插槽代码示例：[生成式 UI · 在 Pi 扩展中使用全栈 UI](generative-ui.md#在-pi-扩展中使用全栈-uictxui-与三大插槽)
- 让 Bot 自己写扩展（自举）：[用户指南 · 扩展安装与使用](user-guide.md#扩展安装与使用与-web-ui-无缝融合)
- 安装命令全参数：[CLI 参考 · install](cli.md#install)
