# 模型与供应商

[文档目录](README.md)

本文说明如何为节点配置模型供应商凭据，以及如何查看和扩展模型目录。

凭据以节点为单位保存。Bot 通过 `provider/modelId` 引用模型。同一个 Hub 下的不同节点可以使用不同账户。

## 使用网页配置

1. 确认目标节点在线。
2. 打开左下角「模型与凭据设置」。
3. 在「模型与服务商设置」面板选择自己拥有的节点。
4. 搜索供应商，选择它支持的登录方式。
5. 按弹窗提示完成 API Key、OAuth 或设备码交互。
6. 编辑 Bot，选择该供应商和模型。

面板打开时自动选中第一个在线节点。节点目录获取失败时，页面回退到内置目录并给出提示。

### 登录方式

供应商只展示它声明支持的登录方式：

- `api_key`：按提示输入 Key。部分供应商还会询问账户、区域或端点。
- `oauth`：按提示打开授权链接、输入设备码，或粘贴回调结果。

只支持 OAuth 的供应商没有通用 Key 输入项。

登录成功后，凭据写入该节点的 `~/.botd/.agent/auth.json`。凭据配置成功不代表账户有权调用目录中的每个模型。实际权限、配额和费用由供应商决定。

节点的默认 Bot 使用 `anthropic/claude-sonnet-4-5`。添加其他供应商后，需要修改 Bot 的模型选择。

### OAuth 与远程回调

授权过程可能要求打开链接、输入设备码，或粘贴回调结果。

浏览器和节点在不同机器时，浏览器回调地址可能无法到达节点。若页面提供手动输入框，请粘贴地址栏中的完整回调 URL 或授权码。

不要把授权链接、验证码和回调结果发到公共会话。

### 取消与清除

取消登录会终止当前登录交互。清除凭据会调用节点上的登出逻辑，删除该供应商保存的凭据。

清除本地记录不会撤销供应商侧的账户授权，也不会移除 Node Agent 进程环境中的 Key。需要撤销时，还应到供应商侧处理。

## 使用 CLI 配置

以下命令都在仓库根目录执行，通过 Hub 转发到节点。全局选项 `--json` 输出机器可读结果。

### providers login

```bash
pnpm node providers login <nodeId> <providerId> --method <api_key|oauth> [--wait [seconds]]
```

- `--method` 必填，取值 `api_key` 或 `oauth`。
- `--wait` 缺省等待 120 秒，可指定其他秒数。省略该选项时立即返回。
- 等待期间每 2 秒轮询一次登录状态。
- 超时仍未完成时，命令以退出码 1 结束并输出警告。

命令输出登录事件：

- `info`：提示消息，可能附带链接。
- `auth_url`：需要打开的授权链接。
- `device_code`：设备码和验证网址。
- `progress`：进行中消息。

登录过程出现输入提示时，输出中会给出应答命令。

### providers respond

```bash
pnpm node providers respond <nodeId> <loginId> --prompt <promptId> [--value <value>]
```

- `--prompt` 必填，填入提示输出中的 prompt ID。
- `--value` 省略时从 stdin 读取应答值，并去掉行尾换行。

提示有四种类型：`text` 输入文本，`secret` 输入密钥，`manual_code` 粘贴回调 URL 或授权码，`select` 选择选项。单条应答不超过 65536 字符。

### providers status

```bash
pnpm node providers status <nodeId> <loginId>
```

查询一次登录的状态和事件历史。

### providers cancel

```bash
pnpm node providers cancel <nodeId> <loginId>
```

取消一个进行中的登录。

### providers logout

```bash
pnpm node providers logout <nodeId> <providerId>
```

登出节点上的一个供应商，删除该供应商保存的凭据。

### 登录的时限与并发限制

- 登录超过 10 分钟未完成时自动过期，需要重新发起。
- 同一供应商同时只允许一个进行中的登录。
- 单节点最多 64 个进行中的登录。
- 单次登录最多保留 100 条事件。
- 密钥类应答值不会回显到状态输出，错误消息中以 `[redacted]` 脱敏。

## 使用环境变量注入 Key

在启动 Node Agent 的终端配置：

```bash
export BOTD_API_KEY_ANTHROPIC='replace-with-your-api-key'
pnpm node start
```

变量名规则：供应商标识转大写，非字母数字字符替换为下划线。取值首尾空白会被去掉，空白值视为未设置。

| 供应商标识 | 环境变量 |
| --- | --- |
| `anthropic` | `BOTD_API_KEY_ANTHROPIC` |
| `openai` | `BOTD_API_KEY_OPENAI` |
| `openrouter` | `BOTD_API_KEY_OPENROUTER` |
| `zai-coding-cn` | `BOTD_API_KEY_ZAI_CODING_CN` |

`.env.example` 列出了 `BOTD_API_KEY_ANTHROPIC`、`BOTD_API_KEY_OPENAI`、`BOTD_API_KEY_DEEPSEEK`、`BOTD_API_KEY_GOOGLE`、`BOTD_API_KEY_OPENROUTER` 的示例。Compose 模板会把这些变量传给 cloud-node 容器。源码命令不自动加载 `.env` 文件，请先在进程环境中 `export`。

已经运行的 Node Agent 不会读取另一个终端新设置的变量。系统服务也不会自动继承交互终端的环境。

鉴权优先级如下：

1. Node Agent 进程中的 `BOTD_API_KEY_<PROVIDER>`。
2. 节点 `.agent/auth.json` 中保存的 SDK 凭据。
3. 两者都缺少时，调用报配置错误。

模型鉴权不回退到 `OPENAI_API_KEY` 等宿主变量，也不读取宿主机的 Pi 登录状态。

只支持 OAuth 的供应商会拒绝 Key 覆盖，调用报错 `Provider "<id>" requires OAuth login rather than an API key`。

网页目录中的「已配置」状态来自节点保存的 SDK 凭据，不检测环境变量是否生效。

## 凭据存在哪里

默认位置为 `~/.botd/.agent/auth.json`。自定义节点数据目录时，位置跟随 `BOTD_DATA_DIR` 或 `--data-dir`。

文件权限为 `0600`。文件内容不加密，请保护节点账户、文件权限和备份。

网页和 CLI 的登录输入先经过 Hub，再转发到节点。Hub 只转发登录状态，不保存模型凭据。

Bot 的 `env.json` 用于工具环境，不是模型凭据库。详细边界见[安全说明](security.md)。

## 模型目录的来源与更新

模型目录有三层来源：

1. **内置目录**：来自 `@botd/models` 包，底层是锁定版本（1.4.0）的 pi-ai 内置供应商。目录元数据带 `source: 'pi'` 和 `sdkVersion`。升级依赖才会更新内置目录。
2. **节点自定义模型**：节点数据目录下 `.agent/models.json` 中声明的兼容端点模型。
3. **扩展注册的供应商**：节点安装的扩展可以注册自定义供应商。读取节点目录时，Node Agent 按需激活扩展池，把注册项合入目录。

节点读取目录时，只对扩展注册的供应商发起在线刷新。刷新带 8 秒超时。刷新成功的结果写入 `.agent/models-store.json`，之后的目录读取和 Bot 调用直接复用，不再联网。刷新失败时回退到已保存的目录。

Bot 会话使用的运行时禁止模型网络访问，启动时不刷新目录。仅当所选模型不在目录中且供应商存在时，运行时对该供应商做一次 8 秒在线刷新，仍找不到才报错。

目录只输出公开元数据：供应商 `id`、`name`、`authMethods`，模型的 `id`、`name`、`reasoning`、`thinkingLevels`、`input`、`contextWindow`、`maxTokens`。自定义端点的 `baseUrl`、`apiKey` 和私有 headers 不会出现在目录中。

## 查看模型目录

不带参数时查看 Hub 缓存的内置目录：

```bash
pnpm node models catalog
```

指定节点时查看该节点的实际目录：

```bash
pnpm node models catalog --node <nodeId>
```

查询节点要求拥有它，且它在线。离线时 Hub 返回 `Node is offline`。

命令输出示例：

```text
source: pi  sdk: 1.4.0
anthropic               Anthropic  auth=[api_key,oauth]  configured=false  models=17
  claude-sonnet-4-5  (Claude Sonnet 4.5 (latest), reasoning)
```

内置目录中所有供应商显示 `configured=false`。节点目录中，保存了凭据的供应商显示 `configured=true` 和凭据类型。

## 配置兼容模型端点

自定义目录位于节点 `.agent/models.json`。以下结构与仓库测试使用的兼容端点配置一致：

```json
{
  "providers": {
    "local-gateway": {
      "baseUrl": "http://127.0.0.1:8000/v1",
      "api": "openai-completions",
      "apiKey": "configured-through-botd",
      "models": [
        {
          "id": "your-model-id",
          "reasoning": false,
          "contextWindow": 8192,
          "maxTokens": 1024
        }
      ]
    }
  }
}
```

替换端点、模型 ID 和能力参数。窗口大小只是结构示例，必须按实际模型填写。

`apiKey` 是模型目录字段。botd 的鉴权检查不读取它，仍要求环境变量或保存的 SDK 凭据。

例如，在启动节点前设置：

```bash
export BOTD_API_KEY_LOCAL_GATEWAY='replace-with-your-gateway-key'
pnpm node start
```

随后刷新节点模型目录，为 Bot 选择 `local-gateway` 和对应模型。模型不存在于目录时，运行时会报错，不会猜测接口。

示例使用的协议标识为 `openai-completions`。其他端点按所用 pi-ai 支持的协议配置。

## 常见问题

| 现象 | 检查方法 |
| --- | --- |
| 不能选择节点登录 | 确认节点在线，并且属于当前用户 |
| Key 已配置但仍提示缺少凭据 | 检查 Bot 的供应商、节点数据目录和进程环境 |
| 清除凭据后仍能调用 | 检查 `BOTD_API_KEY_*` 是否仍存在 |
| 环境变量 Key 被拒绝 | 该供应商只支持 OAuth，改用网页或 CLI 登录 |
| 登录超时失败 | 登录超过 10 分钟自动过期，重新发起 |
| 同一供应商无法再次登录 | 该供应商已有进行中的登录，先取消或等待完成 |
| 模型不在下拉列表 | 检查节点目录、自定义配置和扩展加载结果 |
| 目录有条目，但调用被拒绝 | 检查供应商权限、配额和端点网络 |
| 远程 OAuth 卡在回调 | 按页面提示使用手动回调或设备码流程 |

模型加载与凭据解析代码见 [models.ts](../apps/node/src/models.ts)，登录交互见 [provider-auth.ts](../apps/node/src/provider-auth.ts)，目录构建见 [packages/models](../packages/models/src/index.ts)。
