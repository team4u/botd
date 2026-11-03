# 部署指南

[文档目录](README.md)

本文说明生产环境的两种部署方式，以及反向代理、开机自启、备份与升级操作。

系统由 Hub 和节点组成。Hub 提供统一入口，运行 Web 与 API。节点运行 Node Agent，主动连接 Hub，不需要暴露本地控制端口。浏览器、CLI 和远程节点应使用同一个公开地址访问 Hub。

端口约定：生产默认 `3000`。本机开发使用 web `3001`、hub `3002`，见[入门指南](getting-started.md)。

## Docker Compose 部署

需要 Docker Engine 和 Compose 插件。以下操作面向部署服务器。

### 准备配置

```bash
git clone https://github.com/team4u/botd.git
cd botd
cp .env.example .env
```

编辑 `.env`，将 `BOTD_ADMIN_PASSWORD` 换成自己的密码。留空时 Hub 启动会生成一次性随机密码并打印到日志。已有管理员账户的密码不受此变量影响。

`.env` 还支持五个模型供应商 Key（`BOTD_API_KEY_ANTHROPIC` 等），按需取消注释。

模板将数据库固定在 `/data/hub.sqlite`。产物目录默认写在容器内家目录，不会进入挂载卷。把以下内容保存为仓库根目录的 `compose.local.yml`，让产物进入同一卷：

```yaml
services:
  hub:
    environment:
      BOTD_HUB_DATA_DIR: /data
```

不能只把此变量写进 `.env`。`--env-file` 只提供变量替换，不会把未引用的变量传入容器。

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

访问 `http://服务器地址:3000` 确认连通。对外提供服务前，配置下文的 HTTPS 代理。使用 `admin` 和 `.env` 中的密码登录。

### 运行同机节点（可选）

先在网页生成配对码。将 `123456` 换成该码，执行一次性配对：

```bash
docker compose --env-file .env \
  -f deploy/docker-compose.yml -f compose.local.yml \
  run --rm cloud-node join http://hub:3000 --code 123456 --name cloud-node
```

配对身份写入 `botd-node-data` 卷。然后启动节点：

```bash
docker compose --env-file .env \
  -f deploy/docker-compose.yml -f compose.local.yml \
  --profile cloud-node up -d
```

先配对，再启动常驻节点。未配对的节点无法正常启动。

容器内提供 `botd` 命令。Bot 只能访问容器内的工具和文件。需要额外工具或挂载目录时，使用自己的镜像和覆盖配置。

### Compose 模板说明

`deploy/` 目录提供三个文件。

#### deploy/docker-compose.yml

`hub` 服务：

- `build` 指向仓库根目录，使用 `deploy/Dockerfile`；镜像名 `botd:latest`。
- `restart: unless-stopped`，容器异常退出时自动重启。
- 端口映射 `3000:3000`。
- 环境变量：`BOTD_HOST=0.0.0.0`、`BOTD_PORT=3000`、`BOTD_DB_PATH=/data/hub.sqlite`、`BOTD_ADMIN_PASSWORD`。
- 卷 `hub-data:/data`，持久化数据库与元数据。
- 健康检查每 10 秒执行 `curl -f http://127.0.0.1:3000/api/health`，超时 5 秒，重试 3 次，启动宽限 5 秒。
- `command: ["hub"]`，由 entrypoint 分派到 Hub 入口。

`cloud-node` 服务：

- 挂在 `cloud-node` profile 下，不加 `--profile cloud-node` 不会启动。
- `BOTD_DATA_DIR=/data/node`，数据写入独立卷。
- 可选注入五个模型供应商 Key 环境变量。
- `depends_on` 要求 Hub 健康检查通过后才启动。
- `command: ["start"]`，启动 Node Agent 守护进程。

两个命名卷：`botd-hub-data` 保存 Hub 数据库，`botd-node-data` 保存节点配置、技能、扩展和 Bot 工作区。

#### deploy/Dockerfile

多阶段构建：

- 基础镜像 `node:24-bookworm-slim`，通过 corepack 启用 pnpm `10.34.9`。
- builder 阶段复制整个仓库，执行 `pnpm install --frozen-lockfile` 和 `pnpm run build`。
- runner 阶段安装运行时依赖：`bash`（工具执行）、`curl`（健康检查）、`ca-certificates`（外连 HTTPS/WSS）、`procps`（进程管理）。
- 复制构建产物，并生成 `/usr/local/bin/botd` 包装器，指向 `node /app/apps/node/dist/cli.js`。
- 默认环境：`NODE_ENV=production`、`BOTD_HOST=0.0.0.0`、`BOTD_PORT=3000`、`BOTD_DB_PATH=/data/hub.sqlite`、`BOTD_DATA_DIR=/data/node`。
- 暴露 `3000` 端口，入口为 `entrypoint.sh`，默认命令 `hub`。

#### deploy/entrypoint.sh

按第一个参数分派：

- `hub`：执行 `node /app/apps/hub/dist/index.js`。
- `start`、`join`、`wake`：原样转交 `botd` CLI。
- `cloud-node`：执行 `botd start`，忽略其余参数。
- `botd <args>`：去掉前缀后透传给 `botd` CLI。
- 其他：原样执行。

## 源码生产部署

在部署机器上安装 Node.js ≥ 24.12.0 和 pnpm 10.34.9。

### 构建与启动 Hub

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

先替换示例密码。交给系统进程管理器托管时，在服务配置中提供这些变量（见下文 systemd 示例）。

`pnpm start` 直接托管构建后的前端，不需要 Vite。代码修改后需要重新构建。

### 接入其他机器

在目标机器检出并构建仓库。在网页生成配对码后执行：

```bash
pnpm node join https://botd.example.com --code 123456 --name workstation
pnpm node start -d
```

请替换域名、配对码和节点名称。确认节点在线和模型可用后，再安装开机自启：

```bash
pnpm node service install --dry-run
pnpm node service install
pnpm node service status
```

节点服务支持 Linux systemd 用户单元、macOS LaunchAgent 和 Windows 登录任务。服务的启动时机受系统登录会话影响。

Linux 用户服务在退出登录后继续运行，需要按系统要求配置用户驻留。服务不继承当前终端导出的模型密钥。可先通过网页登录供应商，将凭据保存到节点。

## 反向代理

浏览器、CLI 和远程节点使用同一个公开 HTTPS 地址。代理必须放行三类流量：

- 普通 HTTP 请求和附件上传。
- `/ws/node` 的 WebSocket 升级。
- `/api/events` 和 `/api/sessions/:id/events` 的 SSE 长连接。

### nginx 完整示例

Hub 在同机 `127.0.0.1:3000` 监听时：

```nginx
# /etc/nginx/conf.d/botd.conf
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 443 ssl;
    server_name botd.example.com;

    # 替换为自己的证书路径
    ssl_certificate     /etc/letsencrypt/live/botd.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/botd.example.com/privkey.pem;

    # 产物单文件上限 15 MiB，留出请求编码开销
    client_max_body_size 25m;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # WebSocket 升级头（节点连接 /ws/node）
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;

        # SSE：关闭响应缓冲，事件及时下发
        proxy_buffering off;
        proxy_cache off;

        # 长连接读写超时
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}

server {
    listen 80;
    server_name botd.example.com;
    return 301 https://$host$request_uri;
}
```

两个注意点：

- Hub 用 `X-Forwarded-Proto` 和 `Host` 头构造配对时返回给节点的地址。这两个头传错，节点会拿到错误的 Hub 地址。
- SSE 连接每 15 秒收到一次 `ping` 保活。若中间还有其他代理，同样需要关闭缓冲。

### Caddy 示例

```caddy
botd.example.com {
    reverse_proxy 127.0.0.1:3000 {
        flush_interval -1
    }
}
```

Caddy 自动处理 WebSocket 和证书申请。`flush_interval -1` 关闭响应缓冲。

Docker 模板默认向所有接口发布 `3000`。使用反向代理时，通过覆盖配置或防火墙限制 Hub 的直连入口。

## 健康检查与开机自启

### 健康检查

Hub 暴露公开端点，无需登录：

```bash
curl http://127.0.0.1:3000/api/health
```

返回示例：

```json
{"ok":true,"draining":false,"activeTurns":0}
```

`draining` 表示 Hub 正在排空关闭。`activeTurns` 是正在执行的回合数。Compose 模板已内置此检查。

节点侧使用 CLI：

```bash
pnpm node status
```

运行中时输出 PID、运行时间、Hub 连接状态和版本。未运行时退出码为 1。远程检查 Hub 连通：

```bash
pnpm node --hub https://botd.example.com health
```

### systemd 托管 Hub

源码部署的 Hub 建议交给 systemd 系统单元。示例假设仓库在 `/opt/botd`，运行用户 `botd`：

```ini
# /etc/systemd/system/botd-hub.service
[Unit]
Description=Botd Hub
After=network.target

[Service]
Type=simple
User=botd
WorkingDirectory=/opt/botd
Environment=NODE_ENV=production
Environment=BOTD_HOST=127.0.0.1
Environment=BOTD_PORT=3000
Environment=BOTD_HUB_DATA_DIR=/var/lib/botd-hub
Environment=BOTD_ADMIN_PASSWORD=replace-with-a-long-password
ExecStart=/usr/bin/node apps/hub/dist/index.js
Restart=on-failure
RestartSec=5
# SIGTERM 后 Hub 先排空最多 25 秒再退出
TimeoutStopSec=40

[Install]
WantedBy=multi-user.target
```

启用并检查：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now botd-hub.service
sudo systemctl status botd-hub.service
```

### Node Agent 开机自启

节点使用内置的服务安装命令，不需要手写单元：

```bash
botd service install --dry-run   # 预览生成的配置
botd service install             # 安装并启动
botd service status
botd service uninstall
```

Linux 上生成的用户单元位于 `~/.config/systemd/user/botd.service`，内容形如：

```ini
[Unit]
Description=Botd Node Agent
After=network.target

[Service]
Type=simple
ExecStart=<node> <CLI 入口> start --data-dir <数据目录>
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=default.target
```

安装命令等价于 `systemctl --user enable --now botd.service`。macOS 生成 LaunchAgent（`dev.botd.agent.plist`）。Windows 生成登录计划任务（`BotdNodeAgent`）。

退出登录后仍需运行时，为该用户启用驻留：

```bash
sudo loginctl enable-linger <用户名>
```

## 数据与备份

### 数据位置

| 数据 | 源码默认位置 | 上述 Compose 配置中的位置 |
| --- | --- | --- |
| Hub 数据库 | `~/.botd/hub.sqlite`（`BOTD_DB_PATH` 优先） | `botd-hub-data` 卷中的 `hub.sqlite` |
| Hub 产物 | `<BOTD_HUB_DATA_DIR>/artifacts/`，默认 `~/.botd/artifacts/` | 同一卷中的 `artifacts/` |
| 节点数据 | `~/.botd`（`BOTD_DATA_DIR`） | `botd-node-data` 卷 |

节点数据目录包含：`node.json`（身份与令牌）、`bots/<botId>/`（配置与工作区）、`skills/`、`extensions/`、`daemon.log`，以及升级记录（`current.json`、`previous.json`、`update-blocked.json`、`releases/`）。

一次完整备份包含数据库、产物目录和各节点数据。只备份数据库不会保留产物和 Bot 工作区。

### 备份

数据库支持在线备份，不需要停止 Hub。运行中的 SQLite 直接复制文件可能得到损坏副本，必须用备份命令：

```bash
sqlite3 "$HOME/.local/share/botd-hub/hub.sqlite" \
  ".backup '/backup/hub-$(date +%F).sqlite'"
```

需要安装 sqlite3 CLI。Hub 内部的迁移备份同样基于 `VACUUM INTO`，是同一类在线安全操作。

产物目录直接归档：

```bash
tar czf "/backup/artifacts-$(date +%F).tar.gz" \
  -C "$HOME/.local/share/botd-hub" artifacts
```

节点数据建议先停守护进程再归档，避免套接字和升级目录变动：

```bash
botd stop
tar czf "/backup/node-$(date +%F).tar.gz" -C "$HOME" .botd
botd start -d
```

Compose 卷用一次性容器归档：

```bash
docker run --rm -v botd-hub-data:/data -v "$PWD:/backup" alpine \
  tar czf "/backup/hub-data-$(date +%F).tar.gz" -C /data .

docker run --rm -v botd-node-data:/data -v "$PWD:/backup" alpine \
  tar czf "/backup/node-data-$(date +%F).tar.gz" -C /data .
```

不要执行 `docker compose down -v`，它会删除数据卷。备份包含凭据、令牌哈希和会话内容，按敏感数据保管。

### 恢复

1. 停止目标环境的 Hub 和节点。
2. 恢复数据库、产物目录和节点数据目录。
3. 保持原路径，或设置对应环境变量。
4. 使用备份对应的代码版本启动 Hub。
5. 启动节点，检查模型、会话和产物。

Compose 环境把归档解回卷内：

```bash
docker run --rm -i -v botd-hub-data:/data -v "$PWD:/backup" alpine \
  tar xzf /backup/hub-data-2025-01-01.tar.gz -C /data
```

不要让原节点和恢复副本使用同一身份同时连接 Hub。

## 升级与回退

升级前先完成一次完整备份，并记录当前 Git 提交或镜像标识。

### 节点升级：网页触发

网页升级走 Hub 转发，要求节点在线且当前用户拥有该节点。步骤：

1. 打开网页的节点列表，在节点卡片上选择升级。
2. 弹窗自动调用 `GET /api/nodes/:nodeId/upgrade/check`，显示当前版本与最新版本。存在失败封禁记录时一并显示原因。
3. 确认升级。前端调用 `POST /api/nodes/:nodeId/upgrade`，请求体携带 `targetVersion`（默认取检查结果的 `latestVersion`）。
4. 节点下载新版本、排空任务、启动替代进程，旧进程随后退出。
5. 网页轮询节点 PID 变化，确认节点完成重启。

接口行为：

- 检查结果包含 `currentVersion`、`latestVersion`、`updateAvailable`，可选 `blocked`。
- 节点离线返回 503。
- 非节点所有者返回 403。
- 节点版本过旧、不支持升级 RPC 时返回 501。

### 节点升级：CLI

在节点本机执行：

```bash
botd upgrade --check            # 只检查
botd upgrade                    # 升级到 registry 最新版
botd upgrade --version 0.3.0    # 指定版本
```

守护进程运行时，命令通过本地套接字提交给守护进程执行，超时 600 秒。守护进程未运行时，CLI 直接执行升级逻辑。

也可以从任意已登录机器远程触发：

```bash
botd login https://botd.example.com --username admin --password <管理员密码>
botd nodes upgrade node_xxx --check
botd nodes upgrade node_xxx --version 0.3.0
```

`nodes upgrade` 复用与网页相同的 Hub 接口，同样要求节点在线。

升级依赖 npm registry 中的包。包名由 `BOTD_NPM_PACKAGE` 指定，默认 `@botd/node`。registry 由 `BOTD_NPM_REGISTRY` 指定，默认 `https://registry.npmjs.org`。包尚未发布时检查返回 404，升级功能不可用；源码部署的节点优先采用重新构建的方式。

安全约束：

- 检查地址为 `${registry}/${package}/latest`。
- 下载后校验 tarball 的 sha512 与 registry 发布的 `dist.integrity` 一致，不一致即中止。
- Hub 下发的 `registryUrl` 受节点允许清单约束：只接受官方默认 registry 或节点自身 `BOTD_NPM_REGISTRY` 的值，其余一律忽略。

### 升级期间任务排空

Hub 和节点在升级关闭前都会排空任务。

Hub 收到 `SIGTERM` 或 `SIGINT` 后：

1. 进入排空状态，清空所有会话队列。
2. 把 queued 会话重置为 idle 并广播事件。
3. 等待运行中的回合完成，上限 25 秒。
4. 关闭连接和数据库后退出。

排空期间的可见行为：

- `GET /api/health` 返回 `draining: true` 和剩余回合数。
- `POST /api/sessions/:id/messages` 返回 503。
- 运行中的回合正常完成，回复照常写回。

节点升级前同样排空：等待活动回合数归零，默认上限 30 秒。超时则放弃本次升级，节点继续运行旧版本。Hub 重启后会自动把节点标记为 offline、把残留的 running 会话标记为 idle。

### 升级失败回退

节点升级采用先启动、后接替的方式：

1. 新版本下载到数据目录的 `releases/<版本>/`，校验完整性。
2. 旧版本记录写入 `previous.json`，新版本写入 `current.json`。
3. 以 detached 方式启动新版本守护进程，等待其就绪信号，上限 15 秒。
4. 就绪后旧进程退出，升级完成。

新版本未在时限内就绪时自动回退：

- `current.json` 恢复为旧版本记录。
- 旧守护进程继续运行，服务不中断。
- 失败版本写入 `update-blocked.json`，30 分钟内禁止重试。冷却时长可用 `BOTD_UPGRADE_BLOCK_COOLDOWN_MS` 调整。
- 封禁记录在此后的检查结果中持续可见。
- `--force` 可跳过封禁重试。

另有两类拒绝：

- 目标版本低于当前版本时默认拒绝，`--force` 可覆盖。
- 目标与当前版本相同时直接返回 `upgraded: false`，不做变更。

### Hub 升级（源码）

1. 完成备份。
2. 停止 Hub。`SIGTERM` 会先排空最多 25 秒。
3. 切换到目标版本：

```bash
git fetch --tags
git checkout v0.3.0
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm test
```

4. 用原有数据配置重新启动。

### Hub 升级（Compose）

```bash
git pull
docker compose --env-file .env \
  -f deploy/docker-compose.yml -f compose.local.yml \
  up -d --build
```

同机节点使用同一镜像重建。配对身份保存在数据卷中，重建后自动重连。需要升级节点内的 `botd` CLI 时，优先重建镜像，不依赖 npm 包。

### 数据库迁移与版本回退

Hub 启动时检查数据库 `user_version`。低于当前 schema 版本时：

1. 先用 `VACUUM INTO` 生成 `<dbPath>.bak-v<旧版本>` 备份。
2. 再执行迁移并更新版本号。

重复打开已迁移的数据库不会生成新备份。该备份只覆盖数据库，不能代替包含产物和节点数据的完整备份。

数据库迁移不保证兼容旧代码。回退版本时：

1. 停止新版本 Hub。
2. 恢复升级前的代码。
3. 用 `.bak-v<版本>` 备份替换当前数据库。
4. 启动并检查 `/api/health`。

恢复行为与运行中任务的限制见[架构说明](architecture.md)。全部环境变量见[配置参考](configuration.md)。升级相关命令见[CLI 参考](cli.md)。
