# 生产部署指南

[返回文档目录](README.md)

本文介绍 botd 的生产部署方案。内容包含容器编排、反向代理、系统服务托管与数据备份。

## 部署目录

| 部署板块 | 核心方式 | 说明 |
| :--- | :--- | :--- |
| [架构拓扑与端口](#架构拓扑与端口约定) | 拓扑设计 | 单端口 3000、出站连接与网络策略。 |
| [Docker Compose 部署](#docker-compose-部署) | 容器编排 | 一键启动 Hub 与云端 Node。 |
| [数据持久化与备份](#数据持久化与备份) | 数据安全 | SQLite 数据库备份与文件目录持久化。 |
| [反向代理配置](#反向代理配置) | Nginx / Caddy | HTTPS 证书与 WebSocket 代理规则。 |
| [Systemd 服务托管](#systemd-服务托管) | 原生守护 | Linux 宿主机服务配置与开机自启。 |
| [服务健康检查](#服务健康检查) | 监控巡检 | HTTP 健康探针与节点在线监测。 |

## 架构拓扑与端口约定

botd 生产环境包含两个核心组件：

- **Hub**：中央服务进程。Hub 运行 Web 界面、HTTP API、WebSocket 通道与 SQLite 数据库。
- **Node**：工作节点守护进程。Node 主动向 Hub 发起出站连接。Node 运行工具与任务。

生产环境统一使用端口 `3000`。浏览器与外部 Node 访问同一个公开端口。

```
[ 浏览器 / Web UI ] -------> [ 反向代理 :443 ]
                                    | (反向代理至 :3000)
                                    v
                             [ botd Hub :3000 ]
                                    ^
                                    | (出站 WebSocket /ws/node)
                             [ botd Node 守护进程 ]
```

## Docker Compose 部署

官方提供预构建容器镜像与源码构建两种 Compose 模式。

### 方式一：GHCR 镜像部署（推荐）

用户无需克隆代码仓库。用户直接拉取 GitHub Packages 镜像：

```bash
mkdir -p botd && cd botd
curl -fLO https://raw.githubusercontent.com/team4u/botd/main/deploy/docker-compose.ghcr.yml
echo 'BOTD_ADMIN_PASSWORD=your-secure-password' > .env
```

指定 `BOTD_ADMIN_PASSWORD` 会初始化或覆盖 `admin` 密码。留空时仅空库首次启动创建随机密码并打印到日志，后续重启保持原密码。

使用稳定版本标签启动 Hub：

```bash
BOTD_VERSION=0.2.0 docker compose -f docker-compose.ghcr.yml up -d hub
```

省略 `BOTD_VERSION` 时，Docker 默认拉取 `latest` 标签。生产环境建议固定版本号。

启动同机运行的 Node 守护进程（可选）：

```bash
BOTD_VERSION=0.2.0 docker compose -f docker-compose.ghcr.yml --profile cloud-node up -d
```

### 方式二：本地源码构建部署

管理员克隆代码仓库并使用本地配置：

```bash
git clone https://github.com/team4u/botd.git
cd botd
cp .env.example .env
```

管理员在 `.env` 中修改管理员密码：

```bash
BOTD_ADMIN_PASSWORD=your-secure-password
```

启动本地构建服务：

```bash
docker compose -f deploy/docker-compose.yml up -d --build hub
```

### Compose 配置说明

`deploy/docker-compose.ghcr.yml` 包含两个服务：

```yaml
services:
  hub:
    image: ghcr.io/team4u/botd:${BOTD_VERSION:-latest}
    container_name: botd-hub
    restart: unless-stopped
    ports:
      - "3000:3000"
    environment:
      - BOTD_HOST=0.0.0.0
      - BOTD_PORT=3000
      - BOTD_DB_PATH=/data/hub.sqlite
      - BOTD_ADMIN_PASSWORD=${BOTD_ADMIN_PASSWORD:-}
    volumes:
      - hub-data:/data
    healthcheck:
      test: ["CMD-SHELL", "curl -f http://127.0.0.1:3000/api/health || exit 1"]
      interval: 10s
      timeout: 5s
      retries: 3
      start_period: 5s
    command: ["hub"]

  cloud-node:
    image: ghcr.io/team4u/botd:${BOTD_VERSION:-latest}
    container_name: botd-cloud-node
    restart: unless-stopped
    profiles:
      - cloud-node
    environment:
      - BOTD_DATA_DIR=/data/node
    volumes:
      - node-data:/data/node
    depends_on:
      hub:
        condition: service_healthy
    command: ["start"]

volumes:
  hub-data:
    name: botd-hub-data
  node-data:
    name: botd-node-data
```

## 数据持久化与备份

容器使用两个独立数据卷保存数据：

| 数据卷 | 挂载路径 | 保存内容 |
| --- | --- | --- |
| `botd-hub-data` | `/data` | `hub.sqlite`、`hub.sqlite.durable.sqlite`、`artifacts/`、全局 `skills/` 与 `extensions/` 包及 `.agent/` 配置（`0600`） |
| `botd-node-data` | `/data/node` | Node 节点身份配置、工作区与日志 |

### 在线备份 SQLite 数据库

Hub 运行期间，管理员可以使用 SQLite 备份命令：

```bash
docker exec botd-hub sqlite3 /data/hub.sqlite ".backup '/data/hub-backup.sqlite'"
```

命令完成数据库在线快照。管理员把备份文件复制到备份目录：

```bash
docker cp botd-hub:/data/hub-backup.sqlite ./hub-$(date +%F).sqlite
```

### 备份数据卷

管理员可以使用临时容器归档数据卷：

```bash
docker run --rm -v botd-hub-data:/data -v "$PWD:/backup" alpine \
  tar czf "/backup/hub-data-$(date +%F).tar.gz" -C /data .

docker run --rm -v botd-node-data:/data -v "$PWD:/backup" alpine \
  tar czf "/backup/node-data-$(date +%F).tar.gz" -C /data .
```

严禁在生产环境运行 `docker compose down -v`。该操作会销毁数据卷。

## 反向代理配置

生产环境必须在 Hub 前部署 HTTPS 反向代理。反向代理必须满足三项要求：

1. 转发普通 HTTP 请求，请求体上限建议 `25m`。
2. 允许 `/ws/node` 路径的 WebSocket 连接升级。
3. 关闭 `/api/events` 与 `/api/sessions/:id/events` 的响应缓冲。

### Nginx 配置示例

把以下内容写入 `/etc/nginx/conf.d/botd.conf`：

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 443 ssl http2;
    server_name botd.example.com;

    ssl_certificate     /etc/letsencrypt/live/botd.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/botd.example.com/privkey.pem;

    client_max_body_size 25m;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # WebSocket 协议升级
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;

        # SSE 事件流：关闭缓冲
        proxy_buffering off;
        proxy_cache off;

        # 长连接超时配置
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

### Caddy 配置示例

使用 Caddy 自动管理 TLS 证书：

```caddy
botd.example.com {
    reverse_proxy 127.0.0.1:3000 {
        flush_interval -1
    }
}
```

`flush_interval -1` 指示 Caddy 实时推送 SSE 事件流。

## Systemd 服务托管

源码部署模式下，管理员使用 systemd 托管服务。Hub 原生运行要求宿主机安装 Node.js ≥ 24.12.0。独立分发的 `@botd/node` 守护进程支持 Node.js ≥ 20.0.0。

### 托管 Hub 服务

创建单元文件 `/etc/systemd/system/botd-hub.service`：

```ini
[Unit]
Description=Botd Hub Service
After=network.target

[Service]
Type=simple
User=botd
Group=botd
WorkingDirectory=/opt/botd
Environment=NODE_ENV=production
Environment=BOTD_HOST=127.0.0.1
Environment=BOTD_PORT=3000
Environment=BOTD_DB_PATH=/var/lib/botd/hub.sqlite
Environment=BOTD_HUB_DATA_DIR=/var/lib/botd
Environment=BOTD_ADMIN_PASSWORD=your-secure-password
ExecStart=/usr/bin/node apps/hub/dist/index.js
Restart=always
RestartSec=5
TimeoutStopSec=40

[Install]
WantedBy=multi-user.target
```

启动并启用服务：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now botd-hub.service
sudo systemctl status botd-hub.service
```

### 托管 Node 守护进程

Node 提供内置服务管理命令。管理员无需手动编写配置：

```bash
# 预览将要创建的服务配置
botd service install --dry-run

# 安装并启动用户级服务
botd service install

# 查看服务状态
botd service status
```

Linux 环境下，命令自动创建 `~/.config/systemd/user/botd.service`。

允许服务在用户登出后持续运行：

```bash
sudo loginctl enable-linger botd
```

## 服务健康检查

Hub 提供无需认证的健康检查接口：

```bash
curl -f http://127.0.0.1:3000/api/health
```

正常返回示例：

```json
{"ok":true,"draining":false,"activeTurns":0}
```

管理员查看 Node 运行状态：

```bash
botd status
```
