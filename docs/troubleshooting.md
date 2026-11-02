# 故障排查

[文档目录](README.md)

按「症状 → 原因 → 解法」定位 Web、Hub 与节点的常见故障。每条给出验证命令。

## 先收集信息

排查前先收集三类信息。

**节点日志**。后台节点日志默认在 `~/.botd/daemon.log`。可用 `BOTD_DAEMON_LOG` 或启动参数 `--log-file` 覆盖。前台节点直接输出到当前终端。

```bash
pnpm node status
tail -n 100 ~/.botd/daemon.log
```

`botd status` 显示 pid、运行时长、Hub 连接状态与版本；加 `--json` 时额外返回 `hubConnected` 与日志路径。

**Hub 状态**。Hub 日志输出到启动它的终端。健康检查接口不需要登录。

```bash
curl http://localhost:3002/api/health
```

返回 `{ ok, draining, activeTurns }`。生产环境默认端口为 `3000`，本机开发为 `3002`。

**CLI 视角**。

```bash
pnpm node health
pnpm node nodes list
```

不要把包含节点令牌的 `node.json` 原文贴进 Issue。报告时只保留定位所需的字段。

## 配对与连接

### 配对码无效或过期

**症状**：`botd join` 返回 `Pairing failed (400): Invalid or expired pairing code`。

**原因**：配对码是 6 位数字，10 分钟内有效，只能消费一次。输入格式不是 6 位数字时返回 `Invalid pairing input`。

**解法**：

1. 在 Hub 侧重新生成配对码。
2. 在 10 分钟内执行 join。

```bash
pnpm node nodes pair
botd join <hubUrl> --code <新码> --name <节点名>
```

### 配对被限流

**症状**：join 返回 `Pairing failed (429): Too many failed pairing attempts; retry in Ns`。

**原因**：同一 IP 反复试错触发指数退避。退避从 1 秒起步，上限 5 分钟。单个配对码连续失败 5 次后作废。

**解法**：等待提示的秒数后再试。作废的码需要重新生成。

### 节点启动报 Node is not paired

**症状**：`Daemon start error: Node is not paired. Run "botd join <hubUrl> --code <code> --name <name>" first.`

**原因**：数据目录中没有 `node.json`。节点从未与该 Hub 配对。

**解法**：先执行 join，再启动节点。

```bash
botd join <hubUrl> --code <code> --name <name>
botd start
```

### 节点一直离线

**症状**：Web 中节点始终显示离线。发消息报 `Node is offline`（503）。

**原因**：节点进程未运行。或节点的 WebSocket 认证失败。Hub 校验 `node.json` 中的令牌，失败时直接拒绝连接且不重置节点状态。Hub 重启后所有节点置为离线，等节点重连。

**解法**：

1. 在节点机器上运行 `botd status`，确认 daemon 存活且 `hubConnected` 为真。
2. 检查 `hubUrl` 是否指向正确的 Hub。
3. 查看 Hub 终端与节点日志中的连接报错。

```bash
pnpm node status
grep -i "websocket" ~/.botd/daemon.log | tail -n 20
```

### WS 反复重连

**症状**：节点日志反复出现 `Node WebSocket error` 或重连记录。节点频繁上下线。

**原因**：网络不稳定或中间设备掐断长连接。Hub 每 30 秒 ping 一次。连续 2 轮无 pong 时 Hub 强制断开，日志出现 `missed 2 heartbeats, terminating connection`。节点侧自动无限重连。重连间隔默认不低于 200 毫秒。

**解法**：

1. 检查节点到 Hub 的网络与代理。确认代理放行 `/ws/node` 的 WebSocket 升级。
2. 观察重连是否稳定收敛为周期性心跳断开。
3. 需要时用 `BOTD_WS_MIN_RECONNECT_DELAY_MS` 调大最小重连间隔。

```bash
grep -c "Node WebSocket error" ~/.botd/daemon.log
```

### 本地报 Another botd daemon is already listening

**症状**：启动节点报 `Another botd daemon is already listening on <socket>`。

**原因**：同一数据目录已有守护进程在运行。本地控制通道是 `<dataDir>/agent.sock`（Windows 为命名管道）。

**解法**：先停止旧实例再启动。

```bash
botd stop
botd start
```

### botd reload 报 hub not connected

**症状**：`botd reload` 返回 503 `hub not connected`。

**原因**：守护进程活着，但与 Hub 的 WebSocket 未连接。资源清单只在连接建立时上报。

**解法**：先按「节点一直离线」恢复连接，再重试 reload。

```bash
pnpm node status
pnpm node reload
```

## 认证与模型

### Web 或 CLI 登录失败

**症状**：Web 登录提示 `Invalid username or password`。CLI 报 `Login failed (401): invalid credentials`。

**原因**：密码错误，或用户名不存在。管理员密码在首次初始化时写入数据库。之后再改 `BOTD_ADMIN_PASSWORD` 环境变量不会修改已有密码。

**解法**：

1. 确认使用已初始化的密码。
2. 首次启动且未设置 `BOTD_ADMIN_PASSWORD` 时，Hub 终端会打印一次性随机密码。到 Hub 终端查找该输出。

```bash
grep -A2 "Bootstrap admin password" <hub 终端输出>
```

### CLI 报 Login expired 或 Not logged in

**症状**：CLI 报 `Login expired for <hubUrl>. Run: botd login --password <password>` 或 `Not logged in to <hubUrl>`。

**原因**：会话令牌过期（有效期 7 天）。或管理员修改了密码，旧令牌立即失效。CLI 配置在 `<数据目录>/cli.json`。

**解法**：重新登录。密码可用 `--password` 传入或设置 `BOTD_ADMIN_PASSWORD`。

```bash
botd login <hubUrl> --password <password>
```

### CLI 报 Cannot reach Hub

**症状**：CLI 报 `Cannot reach Hub at <url>: ...`。

**原因**：Hub 未启动，或 URL 与端口错误。本机开发 Hub 在 `3002`，生产默认 `3000`。

**解法**：先用 health 命令确认 Hub 可达。

```bash
curl http://localhost:3002/api/health
pnpm node health
```

### provider 登录无响应

**症状**：在 Web 模型设置里发起供应商登录，页面一直没有出现登录指引。

**原因**：登录流程由节点执行。节点离线时接口直接返回 503 `Node is offline`。登录会话在节点内存中保存 10 分钟，超时报 `Login expired; please start again`。同一供应商已有待完成登录时报 `A login is already pending for this provider`。

**解法**：

1. 确认节点在线。
2. 刷新页面重新发起登录。
3. 提示已有时先取消旧登录再重试。

```bash
pnpm node status
```

### 模型 401 或额度不足

**症状**：Bot 回合失败，报供应商鉴权或额度错误。

**原因**：节点上该供应商的凭据失效或额度耗尽。凭据保存在节点的 `.agent/auth.json`。若设置了 `BOTD_API_KEY_<PROVIDER>` 环境变量，它会覆盖节点保存的凭据。OAuth 型供应商不支持 API Key，报 `Provider "..." requires OAuth login rather than an API key`。

**解法**：

1. 到 Web 模型设置重新登录该供应商，或更新 API Key。
2. 检查供应商控制台的额度。
3. 确认环境变量设置在 Node Agent 进程中，而非 Hub。

```bash
grep -i "provider" ~/.botd/daemon.log | tail -n 20
```

回合未配置任何凭据时报：`API key or SDK login for provider "<id>" is not configured. Configure this provider in the model settings.`。按提示在模型设置中补齐。

### 模型目录为空

**症状**：Web 模型选择器为空，或 Bot 配置保存后回合报 `Model not found in catalog: <provider>/<modelId>`。

**原因**：不带 `nodeId` 查询时，目录接口返回内置目录，所有供应商均显示未配置。带 `nodeId` 查询需要节点在线。扩展注册的供应商目录依赖节点联网拉取，拉取失败时回退为空列表。

**解法**：

1. 确认节点在线并已登录供应商。
2. 在 Web 中选中该节点后再查看目录。
3. 重启节点触发目录重新拉取。

```bash
curl -H "Cookie: botd_token=<token>" "http://localhost:3002/api/models/catalog?nodeId=<nodeId>"
```

## 执行

### Bot 的 Bash 里找不到 botd 命令

**症状**：Bot 在 Bash 工具中执行 `botd wake` 等命令报 command not found。

**原因**：Node Agent 把 `<dataDir>/bin` 注入回合子进程的 `PATH` 头部，并在其中维护 `botd` 包装脚本。守护进程未正常生成包装脚本时命令不可见。开发模式下要求能解析 tsx loader，否则报 `Cannot resolve the tsx loader for the development CLI`。

**解法**：

1. 重启节点，让它重新生成包装脚本。
2. 在 Bot 会话中验证 `which botd`。
3. 开发模式报 tsx 错误时，在仓库根目录执行 `pnpm install`。

```bash
botd restart
ls ~/.botd/bin/
```

### 后台任务无回调

**症状**：`botd bg run` 启动的任务结束后，会话没有收到完成通知。

**原因**：任务结束时节点调用 Hub 的 `requestWakeupTurn` 回调会话。回调只在 WebSocket 连接建立时发送。任务运行期间断连则丢单次回调。任务记录保存在节点内存中，节点重启后任务列表清空，报 `Background job "<id>" not found`。

**解法**：

1. 查看任务日志，日志文件持久保存在 `<workspace>/.bg/<jobId>.log`。
2. 确认节点与 Hub 的连接正常。
3. 需要补发通知时手动 wake 对应会话。

```bash
pnpm node bg list --session <sessionId>
pnpm node bg logs <jobId> --lines 50
```

### wake 无效

**症状**：执行 `botd wake` 后会话没有反应。

**原因**：常见原因有四种。本地守护进程未运行。Hub 连接未建立，报 `Hub connection not established`（503）。参数缺失，报 `Missing --session, --bot or --message`。Bot 不是该会话成员，Hub 报 `Forbidden: bot @<botId> cannot run in session <sessionId>`。带 `--delay` 时唤醒转为定时触发器，到点前不产生回合。

**解法**：

1. 运行 `botd status` 确认守护进程与 Hub 连接。
2. 核对 `--session` 与 `--bot`。
3. 带 `--delay` 时用返回的 `scheduledTriggerId` 查触发器。

```bash
pnpm node wake --session <id> --bot <id> --message "测试"
```

### Windows 节点找不到 Bash

**症状**：Windows 节点日志出现 `Automatic MinGit download failed`。或警告 `Bash tool unavailable. Install Git for Windows or set BOTD_BASH_PATH.`

**原因**：Windows 上 Pi 的 Bash 工具需要一个可用的 `bash.exe`。节点按顺序查找：`BOTD_BASH_PATH`、托管 MinGit、Git for Windows、`PATH`。`PATH` 中 System32 下的 WSL 空壳 `bash.exe` 会被跳过。全部找不到时节点联网下载便携版 MinGit（约 30MB）到 `<dataDir>/runtime/mingit`。离线或下载失败时 Bash 工具不可用。

**解法**：

1. 安装 Git for Windows。
2. 或手动指定路径：设置 `BOTD_BASH_PATH` 指向一个真实可用的 `bash.exe`。
3. 下载地址被墙时用 `BOTD_MINGIT_URL` 指定镜像。

```powershell
$env:BOTD_BASH_PATH = "C:\Program Files\Git\bin\bash.exe"
botd restart
```

### 非 Windows 后台任务的 shell 不对

**症状**：`botd bg run` 的任务用了错误的 shell 语法执行失败。

**原因**：非 Windows 后台任务默认用系统 shell 执行。可用 `BOTD_SHELL_PATH` 指定解释器。

**解法**：在 Node Agent 进程环境中设置 `BOTD_SHELL_PATH`，再重启节点。

```bash
export BOTD_SHELL_PATH=/bin/bash
botd restart
```

## Web

### 3001 打不开

**症状**：浏览器访问 `http://localhost:3001` 失败。或 Vite 启动即报端口被占用退出。

**原因**：Vite 固定监听 `3001` 且开启 `strictPort`。端口被占用时 Vite 直接报错退出，不换端口。Vite 未启动时页面自然无法访问。

**解法**：

1. 查看 Vite 终端是否有 `Port 3001 is already in use` 类报错。
2. 找到并停止占用 3001 的进程。
3. 重新运行 `pnpm dev:web`。

```bash
lsof -i :3001
pnpm dev:web
```

### 页面能打开但请求全部失败

**症状**：页面加载出来，接口请求全部报错或挂起。Vite 终端出现 proxy error 与 `ECONNREFUSED`。

**原因**：Vite 把 `/api` 代理到 `http://localhost:3002`，把 `/ws` 代理到 `ws://localhost:3002`。Hub 没在 3002 运行时代理失败。

**解法**：先启动 Hub 再访问页面。日常开发直接用联合命令。

```bash
BOTD_PORT=3002 pnpm dev
curl http://localhost:3002/api/health
```

本机开发 Hub 必须带 `BOTD_PORT=3002`。3000 端口留给宿主机其他用途。

### SSE 断开重连

**症状**：浏览器控制台出现 `[SSE] Global EventSource connection error`。消息短暂停更后恢复。

**原因**：Hub 每 15 秒发送一次 `ping` 保活。连接断开后浏览器 EventSource 自动重连。重连成功后页面清空半截的流式气泡，并重新拉取当前会话快照，补齐断线期间的事件。短暂断线属于自愈行为。

**解法**：

1. 控制台错误偶发且页面自动恢复时无需处理。
2. 持续断开时检查 Hub 是否存活与代理超时配置。

```bash
curl http://localhost:3002/api/health
```

## 数据与升级

### 数据库锁

**症状**：Hub 写入报 SQLite 忙锁类错误。或行为异常后退出。

**原因**：两个 Hub 进程打开了同一个 `hub.sqlite`。数据库路径由 `BOTD_HUB_DATA_DIR`（默认 `~/.botd`）或 `BOTD_DB_PATH`（默认 `<目录>/hub.sqlite`）决定。

**解法**：

1. 确认同一数据库文件只有一个 Hub 进程在用。
2. 停掉多余实例后重启 Hub。

```bash
lsof ~/.botd/hub.sqlite
ps aux | grep -i botd
```

### 升级后版本不匹配

**症状**：CLI 本地命令（如 `botd status`、`botd wake`）报 401：`daemon and CLI versions do not match. Restart the daemon (botd restart) or upgrade botd to a matching version.`

**原因**：升级后 CLI 与守护进程的本地 IPC 令牌或协议不一致。旧守护进程仍在运行。

**解法**：重启守护进程，让新版本接管。

```bash
botd restart
botd status
```

### 节点升级失败或被阻止

**症状**：`botd upgrade` 报以下任一错误。

- `Refusing to upgrade from X to older version Y (downgrade rejected; use force to override)`
- `Upgrade to X is blocked: <reason> (at <time>)`
- `Upgrade to X failed canary check and was rolled back to Y: <reason>`
- `Timed out waiting for active turns to drain before upgrade`

**原因**：升级默认拒绝降级。金丝雀启动失败过的版本写入 `update-blocked.json`，冷却期内默认 30 分钟。升级前会等待运行中的回合结束，超时则放弃。金丝雀失败时自动回滚到旧版本。

**解法**：

1. 查看升级检查结果中的 blocked 记录。
2. 等待冷却期结束后重试。
3. 确认要覆盖保护时加 `--force`。
4. 先让会话回合结束或停止 Bot，再做升级。

```bash
botd upgrade --check
```

### 产物丢失

**症状**：下载产物报 `Artifact not found`（404）或 `Artifact content is missing on disk`（410）。上传报 `Artifact too large (max 15MB)`（413）。

**原因**：产物的数据库记录在 `hub.sqlite`，文件在 `<Hub 数据目录>/artifacts/`。备份只还原了数据库而没还原产物目录时，记录存在但文件缺失。超出 15MB 的文件被拒绝。

**解法**：

1. 备份时同时保留数据库与 `artifacts` 目录。
2. 大文件先压缩或分卷。
3. 检查 Hub 数据目录配置是否变更过。

```bash
ls ~/.botd/artifacts/ | head
```

### Hub 升级后 schema 变更

**症状**：升级 Hub 后数据目录多出 `hub.sqlite.bak-v<n>` 文件。

**原因**：Hub 检测到 schema 版本低于当前版本时，自动用 `VACUUM INTO` 做升级前备份。这是正常行为。

**解法**：无需处理。确认新版本运行正常后可归档备份文件。

```bash
ls ~/.botd/hub.sqlite*
```

## 相关文档

- [配置参考](configuration.md)：环境变量与数据目录
- [开发指南](development.md)：按问题定位代码入口
- [部署指南](deployment.md)：生产升级与备份恢复
- [架构说明](architecture.md)：组件职责与任务恢复
