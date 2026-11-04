# 模型供应商与代码执行沙箱

[文档目录](README.md)

本文档说明模型供应商支持、BYOM 机制、集中式凭据管理与 QuickJS 沙箱执行原理。

## 概述

系统依托 `@earendil-works/pi-ai` 统一抽象层对接模型供应商。

Hub 集中托管模型目录与调用凭据。

每个角色分身可独立绑定适合的模型。

后台 Worker 默认挂载 QuickJS 沙箱，安全执行复杂数据变换。

## 模型供应商支持

系统内置支持主流商业模型与开源生态模型。

模型目录由 `packages/models/src/index.ts` 的 `buildModelCatalog` 统一构建。

系统支持的供应商列表如下：

| 供应商 ID | 名称 | 认证方式 | 典型模型 |
| :--- | :--- | :--- | :--- |
| `anthropic` | Anthropic | `api_key` | `claude-3-7-sonnet`, `claude-3-5-haiku` |
| `openai` | OpenAI | `api_key` | `gpt-4o`, `gpt-4o-mini`, `o1`, `o3-mini` |
| `google` | Google Gemini | `api_key` | `gemini-2.5-pro`, `gemini-2.5-flash` |
| `deepseek` | DeepSeek | `api_key` | `deepseek-chat`, `deepseek-reasoner` |
| `mistral` | Mistral AI | `api_key` | `mistral-large`, `codestral` |
| `groq` | Groq | `api_key` | `llama-3.3-70b-versatile` |
| `moonshotai` | Moonshot Kimi | `api_key` | `moonshot-v1-auto` |
| `minimax` | MiniMax | `api_key` | `MiniMax-Text-01` |
| `openrouter` | OpenRouter | `api_key` | 聚合各大开源与商业模型 |

### 模型元数据与能力

模型目录向前端投递标准化元数据：

- `id` 与 `name`：模型标识与名称。
- `reasoning`：是否具备显式推理能力。
- `thinkingLevels`：支持的思考深度等级列表。
- `input`：输入模态支持范围（包含 `text` 或 `image`）。
- `contextWindow` 与 `maxTokens`：上下文窗口大小与最大输出长度。

### 细粒度思考档位（Thinking Levels）

系统支持为每个角色分身独立配置思考预算。档位逐级递增：

- `off`：关闭显式推理。
- `minimal`、`low`、`medium`：适合低延迟与中等复杂度任务。
- `high`、`xhigh`、`max`：适合复杂架构设计与深度代码重构（`max` 自动钳制为底层的 `xhigh`）。

Router 前台调度与 Worker 后台执行均按角色独立下发思考档位。

### 多模态输入支持（Multimodal）

系统统一支持文本与图片混合输入：

- 前端在消息输入框中粘贴或上传图片。
- 载荷携带 `images` 数组（包含 `mimeType` 与 Base64 编码数据）。
- 系统将文本与图片组织为标准消息块，投递给支持视觉的大语言模型。

## BYOM 机制

BYOM 即 Bring Your Own Model。

系统支持用户输入自有 API Key。

用户接入自建兼接口或第三方网关。

### 角色分身独立模型配置

每个 Bot Persona 拥有独立的配置：

```json
{
  "botId": "architect",
  "name": "架构师",
  "model": {
    "provider": "anthropic",
    "modelId": "claude-3-7-sonnet"
  },
  "thinkingLevel": "high",
  "env": {
    "NODE_ENV": "development"
  }
}
```

### 双层会话差异化模型策略

系统采用分层调度策略：

- 前台 Router：配置低延迟模型（例如 `gemini-2.5-flash` 或 `gpt-4o-mini`），毫秒级响应用户。
- 后台 Worker：配置高逻辑模型（例如 `claude-3-7-sonnet` 或 `deepseek-reasoner`），处理代码开发。

跨角色委派时，任务自动切换至目标角色指定的模型。

## 集中式凭据管理

旧版本将凭据分散存储在各个 Node 节点。

新架构采用集中式凭据管理。

所有凭据统一存储在 Hub SQLite 的 `provider_credentials` 表中。

```sql
CREATE TABLE IF NOT EXISTS provider_credentials (
  provider_id TEXT PRIMARY KEY,
  auth_type TEXT NOT NULL,
  api_key TEXT,
  oauth_json TEXT,
  updated_at TEXT NOT NULL
);
```

### 集中凭据的安全机制

- 凭据仅由 Hub 统一持久化。Node 端不持有密钥明文。
- API 接口向前端返回目录时，只指示 `configured: true`。
- Hub 绝不向前端回显 API Key 原始内容。

## 凭据配置流程

用户可通过 Web 管理面板或 HTTP API 配置模型凭据。

### Web 界面配置

1. 打开 Web 管理界面左下角「模型与服务商配置」。
2. 浏览支持的供应商列表。
3. 选择目标供应商并点击「配置凭据」。
4. 输入该供应商的有效 API Key。
5. 点击提交完成配置。

### HTTP API 交互协议

凭据配置通过 `apps/hub/src/providers.ts` 路由处理：

1. 客户端发起登录请求：
   ```bash
   POST /api/providers/deepseek/login
   {"method": "api_key"}
   ```
2. Hub 创建待处理会话并返回交互提示：
   ```json
   {
     "id": "login_uuid",
     "providerId": "deepseek",
     "method": "api_key",
     "status": "pending",
     "prompt": { "id": "api_key", "type": "secret" }
   }
   ```
3. 客户端应答凭据：
   ```bash
   POST /api/provider-logins/login_uuid/respond
   {"promptId": "api_key", "value": "sk-xxxxxx"}
   ```
4. Hub 校验输入非空后写入 SQLite，立即标记配置成功。

## Worker QuickJS codemode 沙箱

后台 Worker 处理多步骤任务时，经常面临数据筛选与逻辑组合需求。

若直接在 Shell 中执行 Node.js，存在启动开销与权限逃逸风险。

系统引入 QuickJS 沙箱提供代码执行模式。

### 沙箱架构设计

Hub 依赖 `@earendil-works/pi-codemode` 与 `@earendil-works/pi-durable/codemode`。

```mermaid
flowchart TD
    subgraph Hub["Hub 运行时"]
        Worker["后台 Worker 会话"]
        Tool["codemode 工具"]
        Sandbox["CodemodeSandbox (QuickJS 引擎)"]
        Memory[("独立隔离内存堆")]
    end

    Worker -->|"调用工具"| Tool
    Tool -->|"提交代码片段"| Sandbox
    Sandbox --> Memory
    Sandbox -->>|"返回安全 JSON 结果"| Tool
    Tool -->>|"投递工具执行产物"| Worker
```

### Codemode 机制与优势

- 轻量启动：QuickJS 内存开销极低，微秒级创建执行上下文。
- 内存安全：代码在独立的 JavaScript 虚拟机内执行，禁止直接访问宿主操作系统的底层资源。
- 自动化集成：`HubDurableRuntime` 初始化时创建共享 `CodemodeSandbox`。
- 自动挂载扩展：Worker 启动时，系统自动挂载 `codemodeExtension`。
- 生命周期同存：Hub 进程关闭时，自动执行 `codemodeSandbox.close()` 释放内存。
