# 排障与自愈手册

[返回文档目录](README.md)

本文介绍 botd 的运行诊断、Watchdog 自愈机制、节点重连、工作区清理与冷启动恢复流程。

## 排障诊断树

当系统出现非预期行为时，管理员按照以下诊断树定位问题：

```
                    [ 发现系统运行不正常 ]
                              |
               +--------------+--------------+
               |                             |
      [ Web 无法打开 / API 报错 ]     [ 任务卡死 / 模型无响应 ]
               |                             |
        检查 Hub 进程状态            运行 Watchdog 诊断
        curl :3000/api/health        botd watchdog health
               |                             |
       +-------+-------+             +-------+-------+
       |               |             |               |
   [端口被占]      [数据库损坏]   [瞬态模型错误]   [Node 离线]
       |               |             |               |
  修改端口配置    冷启动重置数据库  Watchdog 自动恢复 检查 WebSocket 状态
```

## Watchdog 健康诊断与自愈机制

botd 内置 Watchdog 控制循环。Watchdog 持续监控 Worker 会话与后台任务。

### 健康诊断 API 与命令

管理员或已登录用户可以通过 HTTP 接口或 CLI 查看系统健康报告（主动触发巡检 `--run-pass` / `runPass=1` 需要管理员权限）：

```bash
# 通过 CLI 查看诊断报告
botd watchdog health

# 在诊断前主动运行一轮巡检（需要 admin 管理员身份）
botd watchdog health --run-pass

# 输出 JSON 格式
botd watchdog health --json
```

通过 HTTP API 查询诊断接口（生产默认端口 `3000`，本地开发 Hub 端口 `3002`）：

```bash
# 查询当前健康状态（需携带登录 Cookie）
curl -s -b "botd_token=<TOKEN>" http://127.0.0.1:3000/api/watchdog/health

# 立即运行一轮巡检并返回诊断结果（仅限 admin 管理员）
curl -s -b "botd_token=<ADMIN_TOKEN>" "http://127.0.0.1:3000/api/watchdog/health?runPass=1"
```

响应返回系统的健康状态、干预记录与统计摘要：

```json
{
  "healthy": true,
  "summary": "System healthy: 2 live tasks, 0 unanswered submissions, no watchdog interventions yet.",
  "findings": [],
  "interventions": []
}
```

### Watchdog 自愈逻辑

Hub 默认每隔 30 秒自动运行一轮巡检：

1. **瞬态错误分页恢复**：
   - 当模型返回网络超时或中断错误时，会话记录瞬态错误标识。
   - Watchdog 使用事务分页游标扫描全库会话（不受会话数量上限约束）。
   - Watchdog 自动向空闲且带瞬态错误的会话提交继续运行指令。

2. **进展签名与卡死纠偏**：
   - Watchdog 通过 `WatchdogProgressDoc` 记录回合数、输入数、工具状态与输出长度签名。
   - 新启动的任务首次观测仅记录基线，不会误触发超时纠偏。
   - 进展签名持续 5 分钟未变或近期工具错误达 3 次时，Watchdog 自动发送纠偏指令。
   - Watchdog 自动跳过已请求中止的任务。

3. **失控任务终止**：
   - 当任务近期工具错误次数达到 6 次时，Watchdog 判定任务失控。
   - Watchdog 终止失控任务，并向父 Router 会话发送告警通知。

## Node 离线等待与恢复机制

在分布式运行模式下，Node 守护进程可能因网络抖动短暂断开。

### 工具调用离线等待机制

Worker 调度工具时，`RemoteExecutionEnv` 检查目标节点状态：

- 节点在线时，工具调用直接发送至节点运行。
- 绑定远端节点的会话在节点离线期间（含首次创建工作树）绝不回退到 Hub 宿主机目录。
- `waitForNodeOnline` 挂起当前调用并等待节点重连，中途不返回错误。
- 节点重新连接后，挂起的调用恢复运行。
- 用户取消任务时，挂起等待立即退出，若远端命令正在运行则同步发送 `envAbortExec` 终止子进程树。

### WebSocket 心跳与断线重连

- **心跳保活**：Hub 每 30 秒向 Node 发送一次 ping 心跳检测。连续 2 轮未收到 pong 响应时，Hub 关闭连接。
- **自动重连**：Node 检测到连接断开后，自动发起重连。
- **重连延迟**：系统通过 `BOTD_WS_MIN_RECONNECT_DELAY_MS` 限制最小重连间隔，默认值为 200 毫秒。

管理员查看节点连接日志：

```bash
# 查看 Node 守护进程状态
botd status

# 过滤重连日志
grep -i "websocket" ~/.botd/daemon.log | tail -n 20
```

## Worktree 归档与手动清理

Worker、子代理与工作流步骤进行代码修改时，系统在目标仓库创建独立的 Worktree 目录。

### 目录与分支规范

- **Worktree 路径**：`<repoDir>/.botd-worktrees/<id>`（标识前缀包含 `w-`、`sub-` 与 `wf-`）
- **分支命名**：`botd/<id>`

任务完成后，系统默认保留工作区目录与对应分支，确保代码改动可供审查与合并。

### 手动清理步骤

代码合并完毕或需要回收磁盘空间时，管理员按以下步骤手动清理工作区：

1. 检查现存的全部工作区：

```bash
git worktree list
```

2. 强制删除残留的工作区目录：

```bash
git worktree remove --force .botd-worktrees/<workerId>
```

3. 清理失效的元数据：

```bash
git worktree prune
```

4. 删除对应的临时分支：

```bash
git branch -D botd/<workerId>
```

## 管理员密码重置与冷启动恢复

若仅忘记管理员登录密码，无需删除数据库文件。管理员只需注入 `BOTD_ADMIN_PASSWORD=<新密码>` 环境变量并重启 Hub，系统会自动覆盖 `admin` 账户密码并使旧登录态失效。

当 SQLite 数据库文件损坏或元数据不一致时，管理员按照以下步骤进行冷启动恢复。

### 步骤一：停止服务

管理员先停止运行中的 Hub 进程：

```bash
# Docker 部署环境
docker compose stop hub

# Systemd 托管环境
sudo systemctl stop botd-hub
```

### 步骤二：备份已有数据库文件

管理员把旧数据库文件移动到安全备份目录：

```bash
# 复制 SQLite 文件与日志
mv /data/hub.sqlite /data/hub.sqlite.bak.$(date +%F)
rm -f /data/hub.sqlite-wal /data/hub.sqlite-shm
```

### 步骤三：冷启动 Hub

启动 Hub 服务：

```bash
# Docker 部署环境
docker compose up -d hub

# Systemd 托管环境
sudo systemctl start botd-hub
```

Hub 检测到数据库文件不存在时，会自动完成冷启动：

1. 创建全新的 SQLite 数据库结构。
2. 运行内置数据迁移脚本。
3. 创建默认管理员账户 `admin`。
4. 在日志中打印一次性登录密码（未配置环境变量时）。

### 步骤四：重新配对节点

数据库重置后，原有的节点令牌失效。管理员需要重新配对节点：

1. 登录 Web 控制台。
2. 在节点管理页面创建新的 6 位配对码。
3. 在 Node 宿主机运行重新配对命令：

```bash
botd join http://<hub-host>:3000 --code <配对码> --name <节点名称>
botd restart
```
