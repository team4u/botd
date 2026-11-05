# 本地开发指南

[返回文档目录](README.md)

本文介绍 botd 的本地开发流程、仓库拓扑结构、端口约定与发布规范。

## 环境要求

- Monorepo 开发与 `@botd/hub`：Node.js `>=24.12.0`、pnpm `10.34.9` 与 Git。
- 独立分发的 `@botd/node` 与 `@botd/protocol`：声明 `"engines": { "node": ">=20.0.0" }`。
- 分发包兼容性约束：禁止引入高于 Node 20 的运行时依赖，也禁止使用 `import ... with { type: 'json' }` 语法。

开发者在仓库根目录运行全部命令。

## Monorepo 工作区拓扑

botd 采用 pnpm workspaces 单体仓库架构。

```
botd/
├── packages/
│   ├── protocol/    # 跨端数据协议、RPC 接口与 SSE 事件定义
│   └── models/      # 模型提供商元数据定义
├── apps/
│   ├── hub/         # Hono 后端服务、SQLite 数据库与调度内核
│   ├── node/        # 工作节点守护进程、运行时与 CLI
│   └── web/         # React 前端界面（Vite 驱动）
├── tests/           # 自动化测试套件
└── scripts/         # 版本发布与构建脚本
```

### 依赖拓扑与构建顺序

子包依赖顺序如下：

1. `@botd/protocol`
2. `@botd/models`
3. `@botd/hub`、`@botd/node`、`@botd/web`

修改 `packages/protocol` 或 `packages/models` 后，开发者必须运行构建：

```bash
pnpm build
```

`pnpm build` 命令按拓扑顺序完成全仓构建。

## 端口约定（开发环境严禁占用 3000）

宿主机 3000 端口预留给外部系统。**本地开发严禁占用 3000 端口**。

- **前端 Vite 服务**：端口 `3001`。浏览器统一访问 `http://localhost:3001`。
- **后端 Hub 服务**：端口 `3002`。开发者通过 `BOTD_PORT=3002` 指定端口。
- **生产环境默认端口**：生产环境仍保持 `3000` 端口。

Vite 配置包含严格端口检查与内部反向代理：

```ts
// apps/web/vite.config.ts
export default defineConfig({
  server: {
    port: 3001,
    strictPort: true, // 端口被占用直接报错退出
    proxy: {
      '/api': 'http://localhost:3002',
      '/ws': {
        target: 'ws://localhost:3002',
        ws: true,
      },
    },
  },
});
```

## 本地启动命令

### 启动日常联调

开发者在一个终端同时启动前端与后端：

```bash
BOTD_PORT=3002 pnpm dev
```

该命令同时启动 Hub（3002）与 Vite（3001）。

### 分别启动前后端

开发者需要单独调试某一端时，使用两个终端分别启动：

```bash
# 终端 1：启动 Hub 后端服务
BOTD_PORT=3002 pnpm dev:hub

# 终端 2：启动 Web 前端服务
pnpm dev:web
```

`dev:web` 要求 Hub 已经在 3002 端口运行。

### 启动工作节点

开发者调试真实任务时，在独立终端启动 Node 守护进程：

```bash
botd start
```

### 代码热更新机制

- **Hub 服务**：使用 `tsx watch` 模式。文件保存后服务自动重启。
- **Web 服务**：使用 Vite 实时热模块替换。
- **Node 守护进程**：无热重载。开发者修改代码后必须重启守护进程。

## 代码质量检查

提交代码前，开发者必须运行类型检查与自动化测试：

```bash
# 全仓类型检查
pnpm typecheck

# 运行测试套件
pnpm test

# 运行 Node 20 分发兼容冒烟检查
bash scripts/node20-smoke.sh
```

## 版本发布与不可变 CI 分发规范

botd 采用规范化的发版工作流。

### 核心设计原则

- **GitHub Release 为唯一触发源**：本地不手动打 Git 标签。开发者禁止直接调用 `npm publish`。
- **发布清单隔离**：仅按依赖拓扑顺序发布 `@botd/protocol` 与 `@botd/node`。`hub`、`web` 与 `models` 保持私有，绝不发布到 npm。
- **全仓版本强一致**：发版脚本自动同步根目录与全部子包的版本号。
- **分发标签隔离**：正式版本使用 `latest` 标签。预发布版本自动使用 `beta` 或 `alpha` 独立标签。
- **不可变发布检查**：CI 逐包对比 npm 远端文件的 shasum 哈希值。哈希一致则跳过发布，哈希不一致则终止发布。

### 发版命令操作

开发者使用发布脚本发起发版流程：

```bash
# 模拟补丁发版，预览发布计划
node scripts/release.ts --patch --dry-run

# 发起补丁版本发版（x.y.Z）
node scripts/release.ts --patch

# 发起次版本号发版（x.Y.0）
node scripts/release.ts --minor

# 发起预发布版本发版（带有 beta 标签）
node scripts/release.ts --prerelease beta
```

### 发版流程各阶段

1. **工作区状态检查**：检查工作区无未提交修改。
2. **质量检查**：脚本运行 `pnpm typecheck`、`pnpm build` 与 `pnpm test`。
3. **版本同步**：`scripts/bump-version.ts` 同步更新所有 package.json 文件。
4. **规范提交**：创建 `chore(release): release <version>` 格式的 Git 提交。
5. **创建 GitHub Release**：调用 GitHub CLI 创建带有版本标签的 Release。
6. **CI 流水线分发**：GitHub Actions 监听 Release 事件。流水线发布 npm 包，并推送 Docker 镜像至 `ghcr.io/team4u/botd`。
