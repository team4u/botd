# botd 开发约定

## 设计原则

- **简洁优雅**：用最少的代码解决问题，拒绝不必要的抽象和配置。优雅的方案通常也是正确的方案——如果实现感觉笨重，先怀疑设计而非动手修补。
- **第一性原理**：从问题本质出发推理方案，而非类比现有实现或照搬惯例。写代码前先问：这个问题到底是什么？最直接的解法是什么？
- **遵循好的设计原则**：遵循 UNIX 设计原则（Do One Thing Well、组合优于聚合、机制与策略分离）、KISS、YAGNI、最小惊讶原则。高内聚低耦合，让边界清晰、让修改安全。
- **可读性优先**：代码是写给人看的。命名表达意图，结构自解释，必要时才写注释（解释 Why，而非 What）。
- **最优方案优先（允许破坏性重构）**：项目处于快速演进期，任何功能与架构改动一律以**最优设计方案**为唯一标准，无需保留向后兼容包袱（可完全重写、直接物理删除旧实现与旧接口）。涉及重大架构或破坏性方案调整时，先向用户对齐确认方案再落地执行。
- **子代理开发默认 worktree 后台模式**：委派子代理做开发（写代码、改文件）时，默认使用 `worktree` 隔离 + 后台运行，避免与主工作区互相污染；纯研究、只读调查类任务不需要 worktree。

## 端口约定（重要，3000 被外部占用）

本机 3000 端口留给宿主机其他用途，**botd 开发一律不得占用 3000**。

- 前端 dev（Vite）：`3001`，浏览器唯一入口，API/WS 代理到 3002
- dev hub（后端）：`3002`，通过 `BOTD_PORT=3002` 指定，仅作 Vite 内部上游
- 生产配置（`deploy/docker-compose.yml`、`apps/hub/src/index.ts` 默认值）仍为 3000，不改；只影响本机开发

## 启动命令

```bash
# 日常开发（前后端一起）
BOTD_PORT=3002 pnpm dev

# 只起后端
BOTD_PORT=3002 pnpm dev:hub

# 只起前端（需 hub 已在 3002）
pnpm dev:web
```

`BOTD_PORT=3002` 必须带上；Vite 端口（3001）与代理目标（3002）已固化在 `apps/web/vite.config.ts`（`strictPort: true`，被占直接报错不漂移）。

## 版本发布与分发规范

- **触发事实源**：以 GitHub Release 作为唯一触发源，由 `scripts/release.ts` 驱动全流程（版本同步 → 质量检验 → 规范提交 → 创建 Release）。本地不手工打 Git 标签，禁止脱离发行流程直接 `npm publish`。
- **发布清单与拓扑**：仅发布 `@botd/protocol` → `@botd/models` → `@botd/node`（按依赖拓扑序）。hub 与 web 保持 private，绝不在发布清单。
- **全仓版本强一致**：发版时根目录与全部 workspace 包版本号统一同步（`scripts/bump-version.ts`），发布前做强一致性断言，避免 npm 回退加载旧版本。
- **分发标签隔离**：正式版本使用 `latest`；预发布版本（如 `0.2.0-beta.1`）自动使用 `beta`/`alpha` 独立标签，严禁覆盖 `latest` 指针。注意：节点升级检查默认查 `@botd/node` 的 `latest` 标签，未发布的预发布版本不会触发升级。
- **不可变发布**：CI 发布前逐包 shasum 幂等校验，同版本号摘要不一致直接终止；摘要一致则跳过，重跑安全。
- **产物分发**：GitHub Release 触发 `publish.yml`，同步发布 npm 包（provenance）与 Docker 镜像到 `ghcr.io/team4u/botd`（稳定 semver 自动打 `latest`）。
- **常用命令**：

```bash
node scripts/release.ts --patch --dry-run   # 模拟发版，查看计划
node scripts/release.ts --patch             # 补丁版本发版
node scripts/release.ts --prerelease beta   # 预发布版本（beta 标签）
```

- **发版提交格式**：统一为 `chore(release): release <version>`，正文附变更日志；提交信息遵循 `git-commit` 技能的中文规范。
- **变更提炼**：发版脚本自动装配上一版本以来的提交明细；重大版本需在 `--notes` 补充包含背景、核心能力与迁移说明的解读。
