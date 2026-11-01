# 部署指南

[文档目录](README.md)

长期运行时，让 Hub 提供统一入口。需要执行任务的机器各自运行 Node Agent。节点主动连接 Hub，不需要暴露本地控制端口。

可以选择 Docker Compose，或直接运行源码构建产物。

## Docker Compose

需要 Docker Engine 和 Compose 插件。以下操作面向部署服务器。

仓库模板将宿主机 `3000` 映射到容器 `3000`。本机开发请使用[入门指南](getting-started.md)中的 `3001 / 3002`。

### 准备配置

```bash
git clone https://github.com/team4u/botd.git
cd botd
cp .env.example .env
```

编辑 `.env`，将 `BOTD_ADMIN_PASSWORD` 换成自己的密码。

原始 Compose 模板固定数据库路径为 `/data/hub.sqlite`。产物目录还需要显式配置，才能保存在同一挂载卷中。

将以下内容保存为仓库根目录的 `compose.local.yml`：

```yaml
services:
  hub:
    environment:
      BOTD_HUB_DATA_DIR: /data
```

不能只把此变量写进 `.env`。Compose 不会自动把未引用的变量传入容器。

### 启动 Hub

```bash
docker compose --env-file .env \
  -f deploy/docker-compose.yml -f compose.local.yml \
  up -d --build hub
```

检查状态和日志：

```bash
docker compose --env-file .env \
  -f deploy/docker-compose.yml -f compose.local.yml ps

docker compose --env-file .env \
  -f deploy/docker-compose.yml -f compose.local.yml logs --tail 100 hub
```

使用 `http://服务器地址:3000` 完成本地连通检查。向其他设备提供服务前，配置下文的 HTTPS 代理。

使用 `admin` 和 `.env` 中的密码登录。已有账户的密码不受初始化变量影响。

### 可选：运行同机节点

先在网页生成配对码。将 `123456` 换成该码，再执行一次性配对：

```bash
docker compose --env-file .env \
  -f deploy/docker-compose.yml -f compose.local.yml \
  run --rm cloud-node join http://hub:3000 --code 123456 --name cloud-node
```

配对身份写入 `botd-node-data` 数据卷。然后启动节点：

```bash
docker compose --env-file .env \
  -f deploy/docker-compose.yml -f compose.local.yml \
  --profile cloud-node up -d
```

先配对，再启动常驻节点。未配对的节点无法正常启动。

容器内提供 `botd` 命令。模型 API Key 可通过 `.env` 中模板支持的变量传入，也可以通过网页登录供应商。

Bot 只能访问容器内的工具和文件。需要额外工具或挂载目录时，使用自己的镜像和覆盖配置。

## 源码生产部署

在部署机器上安装 Node.js ≥ 24.12.0 和 pnpm 10.34.9。

```bash
git clone https://github.com/team4u/botd.git
cd botd
pnpm install --frozen-lockfile
pnpm build
```

在独立部署服务器上运行 Hub：

```bash
export NODE_ENV=production
export BOTD_HOST=127.0.0.1
export BOTD_PORT=3000
export BOTD_HUB_DATA_DIR="$HOME/.local/share/botd-hub"
export BOTD_ADMIN_PASSWORD='replace-with-a-long-password'
pnpm start
```

先替换示例密码。将 Hub 交给系统进程管理器托管时，在服务配置中提供这些变量。

`pnpm start` 托管构建后的前端，不需要 Vite。代码修改后需要重新构建。

### 接入其他机器

在目标机器检出并构建仓库。在网页生成配对码后执行：

```bash
pnpm node join https://botd.example.com --code 123456 --name workstation
pnpm node start
```

请替换域名、配对码和节点名称。确认在线和模型可用后，再选择后台运行方式。

```bash
pnpm node service install --dry-run
pnpm node service install
pnpm node service status
```

节点服务支持 Linux systemd 用户单元、macOS LaunchAgent 和 Windows 登录任务。服务的启动时机受系统登录会话影响。

Linux 用户服务需要退出登录后继续运行时，按系统要求配置用户驻留。服务也不会自动继承当前终端导出的模型密钥。可先通过网页登录，将凭据保存到节点。

## HTTPS 反向代理

浏览器、CLI 和远程节点应使用同一个公开 HTTPS 地址。

代理必须支持以下流量：

- 普通 HTTP 请求和附件上传。
- `/ws/node` 的 WebSocket 升级。
- `/api/events` 和会话事件接口的 SSE 长连接。

下面的 Caddy 示例适用于 Hub 在同机 `127.0.0.1:3000` 监听的情况：

```caddy
botd.example.com {
    reverse_proxy 127.0.0.1:3000 {
        flush_interval -1
    }
}
```

请替换域名并完成 DNS 配置。Caddy 自动处理 WebSocket 和证书申请。证书申请还需要满足它的网络条件。

使用其他代理时，关闭 SSE 响应缓冲。保留 WebSocket 升级头，延长长连接读取超时。上传限制应容纳单个 15 MiB 产物及请求编码开销。

Docker 模板默认向所有接口发布 `3000`。使用反向代理时，还应通过覆盖配置或防火墙限制 Hub 的直连入口。

## 数据与备份

| 数据 | 源码默认位置 | 上述 Compose 配置中的位置 |
| --- | --- | --- |
| Hub 数据库 | `~/.botd/hub.sqlite` | `botd-hub-data` 卷中的 `hub.sqlite` |
| Hub 产物 | `~/.botd/artifacts/` | 同一卷中的 `artifacts/` |
| 节点身份、模型凭据、技能、Bot 文件 | `~/.botd/` | `botd-node-data` 卷 |

源码示例显式更改了 Hub 数据目录。备份时以实际配置为准。

一次完整备份应包含数据库、产物目录和各节点数据。仅备份 SQLite 不会保留产物内容或 Bot 的私有模型会话。

### 备份步骤

1. 停止新的任务提交。
2. 等待正在执行的任务完成。
3. 停止 Hub 和各节点进程。
4. 归档 Hub 数据目录和各节点数据目录。
5. 检查归档可读，保存对应代码版本。

停机复制可以避免数据库和产物在备份期间发生变化。在线备份应使用 SQLite 备份机制，不能只复制一个正在写入的数据库文件。

Compose 数据卷包含凭据和会话内容。按 Docker 数据卷备份流程归档，保留文件权限。不要执行 `docker compose down -v`，它会删除数据卷。

### 恢复步骤

1. 停止目标环境的 Hub 和节点。
2. 恢复数据库、产物和节点数据。
3. 恢复原路径或设置对应环境变量。
4. 使用备份对应的代码版本启动 Hub。
5. 启动节点，检查模型、会话和产物。

不要让原节点和恢复副本使用同一身份同时连接。Hub 数据库也保存登录签名密钥，备份需要按敏感数据保护。

## 升级与回退

升级前先备份数据，记录当前 Git 提交或镜像标识。

源码部署应停止服务，切换到选定版本，再安装和构建：

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm test
```

检查通过后，用原有数据配置重新启动。Compose 部署在切换代码后，重新执行前文的构建启动命令。

Hub 启动时会检查数据库版本。已有数据库需要迁移时，程序会生成 `.bak-v<版本号>` 备份。该文件不能代替包含产物和节点数据的完整备份。

节点提供 `upgrade` 检查和版本接替机制。它依赖配置的 npm registry 与包。不要假设源码仓库已有可用的公开安装包。源码部署优先采用重新构建的方式。

数据库迁移不保证兼容旧代码。需要回退时，停止新版本，恢复升级前的代码、数据库和文件快照。

恢复行为与运行中任务的限制见[架构说明](architecture.md)。配置项见[配置参考](configuration.md)。
