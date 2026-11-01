# 模型与供应商

[文档目录](README.md)

先把已有模型账号配置到一个节点，再为 Bot 选择模型。同一个 Hub 中的不同节点可以使用不同账户。

模型目录来自锁定版本的 Pi SDK，以及节点注册的自定义供应商。目录会随依赖和节点配置变化。

## 使用网页配置

1. 确认目标节点在线。
2. 打开左下角「模型与凭据设置」。
3. 选择自己拥有的节点。
4. 搜索供应商，选择它支持的登录方式。
5. 按页面提示完成 API Key、OAuth 或设备码交互。
6. 编辑 Bot，选择该供应商和模型。

凭据配置成功不代表账户有权调用目录中的每个模型。实际权限、配额和费用由供应商决定。

默认助手使用 `anthropic/claude-sonnet-4-5`。添加其他供应商的凭据后，需要修改 Bot 的模型选择。

### API Key

按当前供应商的提示输入 Key。部分供应商还需要账户、区域或端点等信息。

系统只显示供应商声明支持的方式。只支持 OAuth 的供应商不能通过通用 Key 输入替代登录。

### OAuth 与远程回调

授权过程可能要求打开链接、输入设备码，或粘贴回调结果。

浏览器和节点在不同机器上时，浏览器回调地址可能无法到达节点。若页面提供手动输入，请按提示粘贴完整回调 URL 或授权码。

不要将授权链接、验证码和回调结果发到公共会话。

### 取消与清除

取消登录会终止当前登录交互。清除凭据会删除节点保存的该供应商记录。

清除本地记录不会撤销供应商侧的账户授权，也不会移除 Node Agent 环境中的 Key。需要撤销时，还应在供应商侧处理。

## 使用节点环境变量

在启动 Node Agent 的终端配置：

```bash
export BOTD_API_KEY_ANTHROPIC='replace-with-your-api-key'
pnpm node start
```

已经运行的 Node Agent 不会读取另一个终端新设置的变量。系统服务也不自动继承交互终端环境。

供应商标识转成大写，非字母数字字符替换为下划线。例如：

| 供应商标识 | 环境变量 |
| --- | --- |
| `anthropic` | `BOTD_API_KEY_ANTHROPIC` |
| `openai` | `BOTD_API_KEY_OPENAI` |
| `openrouter` | `BOTD_API_KEY_OPENROUTER` |
| `zai-coding-cn` | `BOTD_API_KEY_ZAI_CODING_CN` |

鉴权优先级如下：

1. Node Agent 进程中的 `BOTD_API_KEY_<PROVIDER>`。
2. 节点 `.agent/auth.json` 中保存的凭据。
3. 缺少上述凭据时，报配置错误。

模型鉴权不隐式回退到普通的 `OPENAI_API_KEY` 等宿主变量，也不读取宿主机 Pi 登录状态。

OAuth 专用供应商会拒绝 Key 覆盖。网页目录中的“已配置”状态主要反映保存的凭据，不是环境变量是否生效的完整检测。

## 凭据存在哪里

默认位置为 `~/.botd/.agent/auth.json`。自定义节点数据目录时，位置跟随 `BOTD_DATA_DIR` 或 `--data-dir`。

文件内容不加密。请保护节点账户、文件权限和备份。

Web 登录输入先经过 Hub，再转发到节点。Hub 不将其保存为模型凭据库，但它是登录链路中的受信任组件。

Bot 的 `env.json` 用于工具环境，不是模型凭据库。详细边界见[安全说明](security.md)。

## 查看模型目录

```bash
pnpm node models catalog
```

上述命令通过 Hub 查看内置目录。指定实际节点时，可以查看该节点的目录：

```text
pnpm node models catalog --node <nodeId>
```

查询节点要求拥有它，且它在线。节点目录还可以包含自定义模型和扩展注册的供应商。

节点读取扩展供应商目录时，可能刷新对应模型，并写入 `.agent/models-store.json`。刷新失败时会回退到已有目录。模型调用仍需要可用的推理端点。

## 配置兼容模型端点

自定义目录位于节点 `.agent/models.json`。以下结构对应仓库测试使用的兼容端点配置：

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

替换端点、模型 ID 和能力参数。这里的窗口大小只是结构示例，必须按实际模型填写。

`apiKey` 是模型目录字段。botd 仍要求节点环境变量或保存的 SDK 凭据，不能仅靠该字段绕过鉴权配置。

例如，在启动节点前设置：

```bash
export BOTD_API_KEY_LOCAL_GATEWAY='replace-with-your-gateway-key'
pnpm node start
```

随后刷新节点模型目录，为 Bot 选择 `local-gateway` 和对应模型。未知模型会报错，运行时不会猜测接口。

此示例使用的协议标识为 `openai-completions`。其他端点需要按所用 SDK 支持的协议配置。

## 常见问题

| 现象 | 检查方法 |
| --- | --- |
| 不能选择节点登录 | 确认节点在线，并且属于当前用户 |
| Key 已配置但仍提示缺少凭据 | 检查 Bot 的供应商、节点数据目录和进程环境 |
| 清除后仍能调用 | 检查 `BOTD_API_KEY_*` 是否仍存在 |
| 模型不在下拉列表 | 检查节点目录、自定义配置和扩展加载结果 |
| 模型目录有条目，但调用被拒绝 | 检查供应商权限、配额和端点网络 |
| 远程 OAuth 卡在回调 | 按页面提示使用手动回调或设备码流程 |

模型加载与凭据解析代码见 [models.ts](../apps/node/src/models.ts)，登录交互见 [provider-auth.ts](../apps/node/src/provider-auth.ts)。
