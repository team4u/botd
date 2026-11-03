# 生成式 UI

Bot 在回复中输出一份结构化 JSON Spec，Web 前端把它渲染成可交互卡片（确认按钮、下拉选择、表单、指标卡）。[文档目录](README.md)

## 这是什么

生成式 UI 有两条使用路径：

1. **聊天内展示**：Bot 在回复正文里输出 ` ```ui `（或 ` ```json-render `）代码围栏。前端把围栏内容渲染成只读卡片。输入控件不可编辑，按钮不可点击。
2. **人工交互**：脚本或 Bot 调用 `botd ask "<提示>" --ui`，把 Spec 作为确认卡发给会话。参与者在网页上填写表单、点击按钮。提交结果以单行 JSON 写入 stdout。

Spec 在三个层级被校验，非法 Spec 不会到达浏览器：

| 层级 | 位置 | 行为 |
| --- | --- | --- |
| 节点 CLI | `botd ask --ui` | 校验失败时命令非零退出，报 `Invalid UI spec: ...` |
| Node Agent 本地 IPC | daemon 的 `/ask` 接口 | 返回 HTTP 400 与错误信息 |
| Hub | `GroupRouter.requestHumanInput` | 抛出 `Invalid UI spec: ...`，合法 Spec 会归一化后存库 |

Spec 的契约定义在 `packages/protocol/src/ui-catalog.ts`。渲染实现位于 `apps/web/src/components/generative-ui/`（`BotdUiRenderer.tsx` 与 `catalog.ts`）。

## Spec 结构

顶层结构如下：

```json
{
  "root": "root-id",
  "elements": {
    "root-id": {
      "type": "Stack",
      "props": {},
      "children": ["child-id"],
      "slots": { "tab-a": ["child-id"] },
      "on": {
        "press": { "action": "submit", "params": { "decision": "approve" } }
      }
    }
  },
  "state": { "form": { "name": "初始值" } }
}
```

字段说明：

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `root` | 是 | 根元素的 ID，必须存在于 `elements` |
| `elements` | 是 | ID 到元素定义的映射，不能为空 |
| `state` | 否 | 状态初值对象，供 `{"$state": "..."}` 绑定读取 |

每个元素的字段：

| 字段 | 说明 |
| --- | --- |
| `type` | 组件类型，必须是 17 个类型之一 |
| `props` | 组件属性，见下文目录 |
| `children` | 子元素 ID 数组，按顺序渲染 |
| `slots` | 命名槽位，如 Tabs 用 `{ "tabId": ["child-id"] }` |
| `on` | 事件绑定。当前只支持 `press`，动作只允许 `submit` |

规模限制（定义于 `ui-catalog.ts`）：

| 常量 | 值 | 含义 |
| --- | --- | --- |
| `MAX_UI_SPEC_BYTES` | 65536（64KB） | Spec 序列化后的最大字节数 |
| `MAX_UI_ELEMENTS` | 64 | 元素个数上限 |
| `MAX_UI_TREE_DEPTH` | 6 | 从根算起的树深度上限 |

校验还会拦截：环引用（`Cycle detected in UI tree at element "..."`）、子元素 ID 不存在、未知动作名、各组件的非法属性值。

## 组件目录（17 个）

类型清单由 `BOTD_UI_COMPONENT_TYPES` 定义，共 17 项。渲染默认值来自 `BotdUiRenderer.tsx`。

### 布局与分组

#### Stack

纵向或横向的弹性布局容器。

| 属性 | 类型 | 必填 | 取值 | 默认 |
| --- | --- | --- | --- | --- |
| `direction` | string | 否 | `vertical` \| `horizontal` | `vertical` |
| `gap` | string | 否 | `sm` \| `md` | `md` |

子元素写在 `children`。`horizontal` 会自动换行。

```json
{ "type": "Stack", "props": { "direction": "vertical", "gap": "md" }, "children": ["card_1"] }
```

#### Card

带边框的分组卡片，含标题区。

| 属性 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `title` | string | 是 | 卡片标题 |
| `subtitle` | string | 否 | 副标题 |
| `badge` | string | 否 | 右上角等宽徽标 |
| `icon` | string | 否 | 语义图标名 |

```json
{ "type": "Card", "props": { "title": "概览", "subtitle": "系统指标", "badge": "PROD", "icon": "server" }, "children": [] }
```

#### Tabs

分段切换视图。子元素与页签的对应关系有两种写法：

- `children` 按索引与 `tabs` 一一对应；
- `slots` 以页签 ID 为键，如 `{ "tab_arch": ["arch_card"] }`。

| 属性 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `tabs` | array | 是 | 页签数组，每项含必填 `id`、`label`，可选 `icon` |
| `defaultTab` | string | 否 | 默认选中的页签 ID，缺省取第一个 |

```json
{
  "type": "Tabs",
  "props": {
    "tabs": [
      { "id": "tab_concept", "label": "通俗类比", "icon": "book-open" },
      { "id": "tab_arch", "label": "系统架构", "icon": "layers" }
    ],
    "defaultTab": "tab_concept"
  },
  "children": ["tab_content_1", "tab_content_2"]
}
```

#### Accordion

可折叠列表，用于常见问题与渐进披露。

| 属性 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `items` | array | 是 | 每项含必填 `title`，可选 `content`、`defaultOpen`、`icon`、`badge`、`mono` |

条目的 `mono` 为真时正文用等宽字体。除纯文本 `content` 外，条目还可通过 `slots` 嵌套任意组件：以**条目标题**为键放子元素 ID 数组（类似 Tabs 的槽位写法），展开后渲染对应组件：

```json
{
  "type": "Accordion",
  "props": { "items": [{ "title": "高级选项" }, { "title": "命令预览", "content": "rm -rf node_modules", "mono": true }] },
  "slots": { "高级选项": ["advanced_switch"] }
}
```

```json
{
  "type": "Accordion",
  "props": {
    "items": [
      { "title": "什么是零拷贝？", "content": "避免 CPU 参与的数据搬运。", "defaultOpen": true, "icon": "help-circle" },
      { "title": "适用场景", "content": "高并发静态文件服务。" }
    ]
  }
}
```

### 指标与对比

#### MetricGrid

指标卡的响应式网格容器。

| 属性 | 类型 | 必填 | 取值 | 默认 |
| --- | --- | --- | --- | --- |
| `columns` | number | 否 | `2` \| `3` \| `4` | `3` |

```json
{ "type": "MetricGrid", "props": { "columns": 3 }, "children": ["metric_cpu"] }
```

#### MetricCard

单张指标卡，支持状态点与趋势箭头。

| 属性 | 类型 | 必填 | 取值 | 说明 |
| --- | --- | --- | --- | --- |
| `label` | string | 是 | — | 指标名 |
| `value` | string | 是 | — | 指标值，等宽字体展示 |
| `hint` | string | 否 | — | 底部补充说明 |
| `status` | string | 否 | `ok` \| `warn` \| `error` | 状态点颜色：绿 / 黄 / 红 |
| `trend` | string | 否 | `up` \| `down` \| `flat` | 趋势箭头 ↑ / ↓ / → |
| `icon` | string | 否 | — | 语义图标名 |

```json
{ "type": "MetricCard", "props": { "label": "CPU", "value": "42%", "status": "ok", "trend": "up", "icon": "cpu" } }
```

#### BarList

水平对比条形图。

| 属性 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `items` | array | 是 | 每项含必填 `label`（string）、`value`（有限数字），可选 `max`（正数）、`displayValue`、`color` |
| `title` | string | 否 | 图表标题 |

`color` 取值：`blue`、`emerald`、`amber`、`rose`、`purple`，缺省为 `blue`。条宽按 `value / max` 计算。未给 `max` 时取全部条目 `value` 的最大值。

```json
{
  "type": "BarList",
  "props": {
    "title": "拷贝次数对比（越低越好）",
    "items": [
      { "label": "传统 I/O", "value": 4, "max": 4, "displayValue": "4 次", "color": "rose" },
      { "label": "sendfile", "value": 2, "max": 4, "displayValue": "2 次", "color": "emerald" }
    ]
  }
}
```

#### Table

多列数据表，适合在 `Card` / `Tabs` 内展示结构化列表。

| 属性 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `columns` | string[] | 是 | 列名数组 |
| `rows` | string[][] | 是 | 行数据，每行长度必须等于列数 |
| `monoColumns` | number[] | 否 | 以 0 起算的列索引，该列用等宽字体 |
| `title` | string | 否 | 表格标题 |

```json
{
  "type": "Table",
  "props": {
    "title": "节点状态",
    "columns": ["节点", "状态", "CPU"],
    "rows": [["node-1", "online", "12%"], ["node-2", "offline", "—"]],
    "monoColumns": [0]
  }
}
```

#### KeyValueList

紧凑的键值对列表，行间有分隔线。

| 属性 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `items` | array | 是 | 每项含必填 `key`、`value`，可选 `mono`（boolean，值用等宽字体）、`badge` |

```json
{
  "type": "KeyValueList",
  "props": {
    "items": [
      { "key": "Host", "value": "srv-01.botd.io", "mono": true, "badge": "active" },
      { "key": "Region", "value": "us-west-2" }
    ]
  }
}
```

### 说明与流程

#### Callout

高亮提示框。四种变体有对应配色与默认图标。

| 属性 | 类型 | 必填 | 取值 | 默认 |
| --- | --- | --- | --- | --- |
| `content` | string | 是 | — | 正文 |
| `title` | string | 否 | — | 无标题 |
| `variant` | string | 否 | `info` \| `tip` \| `warn` \| `error` | `info` |
| `icon` | string | 否 | — | 按变体取 `info` / `lightbulb` / `alert-triangle` / `alert-circle` |
| `mono` | boolean | 否 | — | 为真时正文用等宽字体（命令、日志、Diff） |

```json
{ "type": "Callout", "props": { "title": "注意", "content": "该操作不可回滚。", "variant": "warn" } }
```

#### Steps

纵向时间线，展示执行流程或生命周期。

| 属性 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `items` | array | 是 | 每项含必填 `title`，可选 `description`、`status`、`icon`、`badge` |

`status` 取值 `done`、`current`、`pending`。缺省时第一项按 `current` 渲染，其余按 `pending` 渲染。

```json
{
  "type": "Steps",
  "props": {
    "items": [
      { "title": "发起调用", "description": "客户端组装参数", "status": "done" },
      { "title": "路由派发", "description": "Hub 查找在线节点", "status": "current" },
      { "title": "节点执行", "status": "pending" }
    ]
  }
}
```

### 表单与动作

#### TextInput

输入框，默认单行；`multiline` 为真时渲染为多行文本域（等宽字体）。

| 属性 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `label` | string | 是 | 字段标签 |
| `value` | string \| 绑定 | 否 | 初始值，或 `{"$state": "/key"}` |
| `placeholder` | string | 否 | 占位文本 |
| `hint` | string | 否 | 底部提示 |
| `multiline` | boolean | 否 | 为真时渲染多行文本域 |
| `rows` | number | 否 | 可见行数（2-12），仅 multiline 时生效，默认 4 |

```json
{ "type": "TextInput", "props": { "label": "集群名", "value": { "$state": "/cluster/name" }, "placeholder": "prod-main", "hint": "唯一标识" } }
```

#### Select

下拉选择框。

| 属性 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `label` | string | 是 | 字段标签 |
| `value` | string \| 绑定 | 否 | 初始值。缺省时选中第一项 |
| `options` | array | 是 | 选项数组，每项含必填 `value`、`label` |

```json
{
  "type": "Select",
  "props": {
    "label": "环境",
    "value": { "$state": "/cluster/env" },
    "options": [
      { "value": "staging", "label": "Staging" },
      { "value": "production", "label": "Production" }
    ]
  }
}
```

#### Switch

开关控件。

| 属性 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `label` | string | 是 | 字段标签 |
| `checked` | boolean \| 绑定 | 否 | 初始开关状态，或 `{"$state": "/key"}` |
| `hint` | string | 否 | 标签下提示 |

```json
{ "type": "Switch", "props": { "label": "启用告警", "checked": { "$state": "/cluster/alerts" }, "hint": "失败时通知" } }
```

#### CheckboxGroup

多选勾选组，绑定 `string[]` 状态路径。

| 属性 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `label` | string | 是 | 字段标签 |
| `options` | array | 是 | 选项数组，每项含必填 `value`、`label`，可选 `description` |
| `value` | string[] \| 绑定 | 否 | 初选中值数组，或 `{"$state": "/key"}`（绑定值为 `string[]`） |
| `hint` | string | 否 | 底部提示 |

```json
{
  "type": "CheckboxGroup",
  "props": {
    "label": "选择要清理的分支",
    "value": { "$state": "/cleanup/branches" },
    "options": [
      { "value": "feat/a", "label": "feat/a", "description": "已合并，30 天未动" },
      { "value": "feat/b", "label": "feat/b" }
    ]
  }
}
```

#### ActionBar

按钮条容器，按 `children` 顺序排列按钮。

| 属性 | 类型 | 必填 | 取值 | 默认 |
| --- | --- | --- | --- | --- |
| `align` | string | 否 | `left` \| `right` \| `between` | `right` |

```json
{ "type": "ActionBar", "props": { "align": "right" }, "children": ["btn_cancel", "btn_submit"] }
```

#### Button

动作按钮，是唯一绑定事件的组件。

| 属性 | 类型 | 必填 | 取值 | 默认 |
| --- | --- | --- | --- | --- |
| `label` | string | 是 | — | 按钮文字 |
| `variant` | string | 否 | `primary` \| `secondary` \| `danger` | `primary` |

事件写在 `on.press`，动作只允许 `submit`：

```json
{
  "type": "Button",
  "props": { "label": "应用变更", "variant": "primary" },
  "on": { "press": { "action": "submit", "params": { "decision": "apply" } } }
}
```

`params.decision` 是决策标识，脚本用它判断参与者选了哪个按钮。其他 `params` 字段原样返回。

## 状态绑定与提交

Spec 里的 `state` 是状态初值。表单控件用 `{"$state": "/key"}` 绑定状态路径（`$bindState` 等价，渲染器内部会补齐）：

- `TextInput.value`、`Select.value` 绑定字符串；
- `Switch.checked` 绑定布尔值；
- `CheckboxGroup.value` 绑定字符串数组。

交互模式下的提交行为：

1. 参与者修改控件，值实时写入状态存储。
2. 点击 `Button` 时，渲染器组装单行 JSON：`{ "decision": ..., "params": ..., "state": { ... } }`。
3. `Button` 未写 `on.press` 时，`decision` 取按钮文字，`params` 为 `{"decision": "<按钮文字>"}`。
4. Spec 里没有任何 `Button` 时，卡片底部自动出现「提交表单」按钮。点击提交 `{"decision":"submit","state":{...}}`。

提交后卡片变为已答复状态，答案写回 `botd ask` 的 stdout。展示模式（` ```ui ` 围栏）不接收提交，全部输入禁用。

## 在聊天内输出展示卡片

Bot 在回复中直接输出围栏即可，无需调用命令：

````markdown
```ui
{
  "root": "card",
  "elements": {
    "card": {
      "type": "Card",
      "props": { "title": "构建结果", "icon": "check-circle" },
      "children": ["metric_ok"]
    },
    "metric_ok": {
      "type": "MetricCard",
      "props": { "label": "通过用例", "value": "42/42", "status": "ok" }
    }
  }
}
```
````

围栏语言标记用 `ui` 或 `json-render` 均可。渲染前先跑一遍 `validateUiSpec`：

- 校验通过：渲染为只读卡片。
- 校验失败：显示红色错误卡片，逐条列出错误，可展开「查看原始 Spec」。
- JSON 尚不完整（流式输出中）：显示「正在渲染动态界面...」占位。

## 与 ask 的关系：可交互确认、选择与表单

`ask` 是人工确认的显式入口，详细参数见 [CLI 参考](cli.md) 与 [自动化指南](automation.md)。生成式 UI 是它的一种预览类型：`previewType: 'ui'`（其余取值为 `diff`、`markdown`、`text`）。

### 基本用法

1. 把 Spec 存成文件（建议后缀 `.ui.json`，命令会自动识别类型）。
2. 调用 `botd ask "<提示>" --ui --file ./spec.ui.json`，或用 `--stdin` 管道输入。
3. 参与者在网页卡片上交互并提交。
4. 从 stdout 读取单行 JSON：`{"decision":"apply","params":{...},"state":{...}}`。

会话与 Bot 的定位参数：

| 参数 | 环境变量回退 |
| --- | --- |
| `--session <id>` | `BOTD_SESSION_ID` |
| `--bot <id>` | `BOTD_BOT_ID` |

其他要点（均为源码事实）：

- `--ui` 必须提供内容，否则报错 `UI spec content is required when --ui is specified (provide via --file <path> or --stdin)`。
- 预览内容读取上限为 256KB，超出部分截断。
- `--timeout` 默认 300 秒，`0` 表示无限等待。
- 校验通过后发送的是归一化 JSON（`validateUiSpec` 返回的 `normalizedJson`）。
- 默认输出原始答案 JSON；加 `--json` 时输出 `{"ok":true,"answer":"..."}` 包装。

### 风险审批卡（一行语法糖）

`--risk`、`--reason`、`--resource` 任一出现时，命令自动生成审批卡，不需要手写 Spec：

```bash
choice=$(botd ask '是否将本次变更发布到生产环境？' \
  --risk high \
  --reason '生产数据库 schema 迁移，失败需回滚' \
  --resource 'prod-db/orders' \
  --file ./change.patch --diff)
```

自动生成的卡片结构（`buildApprovalCardSpec`）：

- `Card`：图标 `shield`，徽标为风险等级大写（无风险参数时为 `APPROVAL`）。
- `Callout`：风险提示。`high` 映射 `error` 变体「高风险操作确认」，`medium` 映射 `warn`「中风险操作确认」，`low` 映射 `info`「低风险操作确认」。
- `KeyValueList`：`--resource` 显示为「目标资源」，`--file` 显示为「关联文件」，均用等宽字体。
- `Accordion`：`--file` / `--stdin` 提供的预览折叠展示，默认展开，超过 20000 字符截断。
- `ActionBar` + `Button`：默认选项「批准 / 拒绝」，可用 `--options` 覆盖。按钮文案命中 `拒绝|取消|中止|reject|cancel|deny` 时渲染为 `danger`；第一个非否定选项为 `primary`；其余为 `secondary`。

按钮变体规则示例：`--options '批准,跳过,取消'` 生成 `primary`、`secondary`、`danger` 三枚按钮。

审批卡模式下不加 `--json` 时，stdout 只输出纯文本决策（如 `批准`），方便 `case` 语句判断。手写 `--ui` Spec 优先于自动卡片。

## 版本协商

`BOTD_UI_CATALOG_VERSION`（当前值 `botd.v1`）与 `BOTD_UI_COMPONENT_TYPES` 是 `packages/protocol/src/ui-catalog.ts` 导出的 TypeScript 常量，不是环境变量。

它们的作用：

1. `validateUiSpec` 用 `BOTD_UI_COMPONENT_TYPES` 判断组件类型是否合法。报错信息会列出全部允许类型。
2. `botd ask --ui-schema` 输出完整契约文档 `BOTD_UI_SCHEMA_DOC`，内容含版本号、规模限制、全部组件与图标清单。
3. 加 `--json` 时输出结构化结果，便于脚本比对版本：

```bash
botd ask --ui-schema --json
```

```json
{
  "ok": true,
  "version": "botd.v1",
  "componentTypes": ["Stack", "Card", "..."],
  "schemaDoc": "# botd.v1 Generative UI Spec Schema & Component Catalog ..."
}
```

脚本或技能的稳妥做法：先读 `version` 字段。等于 `botd.v1` 才生成对应 Spec。版本不一致时改用纯文本 `--options` 提问。

每个 Bot 都内置 `botd-cli` 技能（`apps/node/src/builtin-skill.ts`），其中已包含这份组件目录与 `--ui` 用法，主控 Bot 无需额外安装即可使用。

## 网页端扩展命令的终端 UI 限制

`apps/node/src/web-command-ui.ts` 给网页触发的扩展命令加了一层守卫。网页会话中执行扩展命令时：

- 访问 `ctx.ui` 的任何属性或方法都会抛出错误，错误文案为 `此命令需要终端界面，当前网页不支持: ui.<方法名>`。
- 该错误使命令执行失败，不会被吞掉成假成功。

网页触发的命令回合里 `ctx.hasUI` 为假值、`ctx.mode` 为 `print`。扩展命令应先判断这两个字段，再决定走终端 UI 还是无界面回退。生成式 UI 卡片是网页端的交互替代方案。

## 语义图标

`icon` 字段传语义名，渲染器查 `ICON_MAP` 匹配。名称转小写，下划线转连字符。未匹配的名称回退为 `layers` 图标。

主名称与别名：

| 主名称 | 别名 |
| --- | --- |
| `lightbulb` | `idea`、`tip` |
| `info` | — |
| `alert-triangle` | `warning`、`warn` |
| `alert-circle` | `error`、`danger` |
| `check-circle` | `check`、`success`、`ok` |
| `cpu` | `processor` |
| `database` | `db` |
| `server` | — |
| `hard-drive` | `disk`、`storage` |
| `activity` | `pulse` |
| `layers` | `stack` |
| `terminal` | `console`、`cli` |
| `code` | — |
| `git-branch` | `branch`、`fork` |
| `workflow` | `process` |
| `shield` | `security`、`protect` |
| `lock` | — |
| `key` | — |
| `globe` | `network`、`web` |
| `zap` | `flash`、`speed`、`fast` |
| `clock` | `time`、`history` |
| `sparkles` | `magic`、`ai` |
| `book-open` | `book`、`docs` |
| `file-text` | `file`、`doc` |
| `box` | `package` |
| `help-circle` | `help` |
| `trending-up` | `up` |
| `trending-down` | `down` |
| `bar-chart` | `chart` |
| `refresh` | `sync` |

## 技能片段示例

以下是一个完整可复制的技能文件。它教 Bot 在发布前用表单卡收集环境与选项，并按决策分支执行。保存到 `~/.botd/skills/release-gate/SKILL.md` 后执行 `botd reload`：

````markdown
---
name: release-gate
description: 发布前用生成式 UI 表单卡向参与者收集环境与确认，再执行发布。
---

# 发布门禁

## When to use

用户要求发布、上线或应用变更，且需要人工确认环境与范围时使用。

## Steps

1. 用表单卡收集参数：

   ```bash
   answer=$(botd ask '请确认发布参数' --ui --stdin --timeout 600 <<'EOF'
   {
     "root": "form_card",
     "elements": {
       "form_card": {
         "type": "Card",
         "props": { "title": "发布确认", "badge": "RELEASE", "icon": "shield" },
         "children": ["env_select", "dryrun_switch", "callout_hint", "action_bar"]
       },
       "env_select": {
         "type": "Select",
         "props": {
           "label": "目标环境",
           "value": { "$state": "/release/env" },
           "options": [
             { "value": "staging", "label": "Staging" },
             { "value": "production", "label": "Production" }
           ]
         }
       },
       "dryrun_switch": {
         "type": "Switch",
         "props": { "label": "先执行演练", "checked": { "$state": "/release/dryRun" }, "hint": "只打印计划，不改文件" }
       },
       "callout_hint": {
         "type": "Callout",
         "props": { "title": "影响面", "content": "Production 发布影响线上用户。", "variant": "warn" }
       },
       "action_bar": {
         "type": "ActionBar",
         "props": { "align": "right" },
         "children": ["btn_cancel", "btn_apply"]
       },
       "btn_cancel": {
         "type": "Button",
         "props": { "label": "取消", "variant": "secondary" },
         "on": { "press": { "action": "submit", "params": { "decision": "cancel" } } }
       },
       "btn_apply": {
         "type": "Button",
         "props": { "label": "开始发布", "variant": "primary" },
         "on": { "press": { "action": "submit", "params": { "decision": "apply" } } }
       }
     },
     "state": { "release": { "env": "staging", "dryRun": true } }
   }
   EOF
   ) || exit 1
   ```

2. 提取决策与环境：

   ```bash
   decision=$(printf '%s' "$answer" | sed -n 's/.*"decision":"\([^"]*\)".*/\1/p')
   env=$(printf '%s' "$answer" | sed -n 's/.*"env":"\([^"]*\)".*/\1/p')
   ```

3. 按分支执行：

   ```bash
   case "$decision" in
     apply) echo "开始发布到 $env" ;;
     *)     echo "已取消"; exit 0 ;;
   esac
   ```

## Gotchas

- `botd ask` 未加 `--json` 时 stdout 就是提交的原始 JSON，不要重复解析。
- 参与者超时未作答会让命令非零退出；会话被取消时待答请求立即失败。脚本必须处理失败分支。
- 高风险变更优先用 `--risk high --reason --resource` 自动审批卡，少手写 Spec。
````

## 相关文档

- [CLI 参考](cli.md)：`botd ask` 全部参数。
- [自动化指南](automation.md)：人工确认、后台任务与产物。
- [配置参考](configuration.md)：`BOTD_SESSION_ID` 等环境变量。
