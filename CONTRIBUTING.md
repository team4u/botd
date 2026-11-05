# 贡献指南

欢迎帮助 botd 改进使用体验、修复问题或补全文档。

第一次运行项目，请先完成[入门指南](docs/getting-started.md)。需要理解代码时，查看[开发指南](docs/development.md)和[架构说明](docs/architecture.md)。

## 找到一个具体问题

可以从这些工作开始：

- 报告一个能重复出现的问题。
- 改正无法按步骤运行的文档。
- 改善一个常用界面的交互。
- 为已知缺陷补充回归测试。

提交 Issue 时，写明运行系统、Node.js 版本、操作步骤、预期结果和实际结果。附上必要日志，先移除密钥和会话隐私内容。

## 准备开发环境

需要 Node.js ≥ 24.12.0 和 pnpm 10.34.9。

```bash
git clone https://github.com/team4u/botd.git
cd botd
corepack enable
corepack prepare pnpm@10.34.9 --activate
pnpm install
pnpm build
BOTD_PORT=3002 pnpm dev
```

浏览器访问 `http://localhost:3001`。Vite 将 API 和 WebSocket 代理到 `3002`。

本机开发不要占用 `3000`。生产 Hub 和 Compose 仍保留该默认端口。

需要验证真实模型或工具时，另开终端配对并启动节点。`pnpm dev` 不启动 Node Agent。

## 按改动选择入口

| 想改进的部分 | 入口 |
| --- | --- |
| 网页交互和消息展示 | `apps/web/src/` |
| HTTP 接口和资源权限 | `apps/hub/src/routes.ts`、`http-helpers.ts` |
| 会话调度与多角色协同 | `apps/hub/src/harness/`（`runtime.ts`、`router-extension.ts`） |
| 节点守护进程与远程环境 | `apps/node/src/daemon.ts`、`env-rpc-server.ts` |
| CLI 命令 | `apps/node/src/cli/` |
| 跨端类型和事件 | `packages/protocol/src/` |
| 模型元数据 | `packages/models/src/` |

## 修改与验证

保持改动聚焦。协议、权限、调度或持久化行为变化时，检查其他端的调用方式。

遵循 [AGENTS.md](AGENTS.md) 的设计原则与端口规范。

修复行为缺陷时，优先增加能复现问题的测试。文档或低风险样式修改不需要为实现细节补测试。

代码修改完成后，在根目录运行：

```bash
pnpm typecheck
pnpm build
pnpm test
```

[GitHub Actions](.github/workflows/ci.yml) 在 push 和 Pull Request 时运行这些检查。测试范围与人工验收方法见[测试指南](docs/testing.md)。

## 提交 Pull Request

PR 描述应回答以下问题：

1. 哪个具体场景存在问题？
2. 修改后，用户会看到什么行为？
3. 运行过哪些检查？还有哪些限制？

界面改动可附截图。改变命令、配置或用户操作时，请同步更新文档。

不要提交模型凭据、节点令牌、本地数据库或工作区数据。无法提交公开复现材料时，先删去其中的敏感内容。

[返回文档目录](docs/README.md) · [MIT 许可证](LICENSE)
