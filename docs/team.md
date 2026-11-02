# 团队协作

[文档目录](README.md)

本篇说明多人共用一个 Hub 的方式：管理员建账户，用户各自配对节点，按需共享 Bot 或邀请参与者进会话。

## 两种共享

| 方式 | 共享对象 | 控制者 |
| --- | --- | --- |
| Bot 共享（`visibility: 'team'`） | Bot 的使用权 | 节点所有者 |
| 会话参与者 | 会话的读写权 | 会话所有者 |

这两种共享的权限不同，不能互相替代。Bot 共享不转移节点控制权。参与者身份不等于会话所有权。

## 账户管理

### 初始账户

Hub 启动时，若数据库没有用户，用 `BOTD_ADMIN_PASSWORD` 创建 `admin` 账户（角色 `admin`）。设置方法见[配置参考](configuration.md)。

### 管理员操作

只有 `admin` 角色能管理账户。Web 端入口：

1. 用 admin 登录 Web。
2. 打开侧栏底部菜单。
3. 点击「用户管理」。

「用户管理」弹窗支持：

- 新建用户：填用户名、密码，选角色 `member` 或 `admin`。
- 重置密码：点某行的钥匙图标，输入新密码。
- 删除用户：点某行的删除图标，确认后删除。

规则（前后端一致校验）：

- 用户名 2-32 位，仅限字母、数字、`_`、`-`。
- 密码至少 4 位。
- 用户名重复返回 `409`。
- 不能删除当前登录用户（`400`）。
- 名下还有节点的用户不能删除（`409`）。先删其节点。
- 删除用户会级联删除其会话、消息与产物。

重置密码后，该用户的全部登录令牌立即失效。用户需用新密码重新登录。

### 用户管理 API

CLI 没有用户管理命令。脚本走 HTTP API：

```bash
# 登录，从响应的 Set-Cookie 取 botd_token
curl -i -X POST http://localhost:3002/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"<密码>"}'

# 创建用户
curl -X POST http://localhost:3002/api/users \
  -H 'Content-Type: application/json' \
  -b 'botd_token=<令牌>' \
  -d '{"username":"ops","password":"ops-pass","role":"member"}'

# 重置密码
curl -X PUT http://localhost:3002/api/users/<userId>/password \
  -H 'Content-Type: application/json' \
  -b 'botd_token=<令牌>' \
  -d '{"password":"new-pass"}'

# 删除用户
curl -X DELETE http://localhost:3002/api/users/<userId> \
  -b 'botd_token=<令牌>'
```

本机开发时 Hub 在 `3002` 端口（启动带 `BOTD_PORT=3002`），Web 入口在 `3001`。生产环境默认 `3000`。

普通成员调用这些接口返回 `403`。

### 令牌与身份

- 登录后浏览器持有 `botd_token` Cookie，有效期 7 天。
- 节点用配对时下发的令牌访问 Hub，身份是配对者本人。节点令牌不能调用用户管理和配对码接口（`403`）。
- CLI 用 `botd login <hubUrl> --username <用户名> --password <密码>` 登录。密码也可放在 `BOTD_ADMIN_PASSWORD`，用户名放在 `BOTD_USERNAME`。

## 节点归属

每个用户为自己配对节点：

1. 在 Web 或 CLI 执行 `botd nodes pair`，得到 6 位配对码。
2. 在目标机器运行 `botd join <hubUrl> --code <配对码> --name <节点名>`。

配对码绑定创建者，10 分钟内有效，只能使用一次。连续输错 5 次即作废。同一 IP 反复失败会触发递增退避。

节点归配对者所有。每个用户只看到自己的节点，加上团队共享的节点与 Bot。管理员看不到其他用户的节点，也不能操作它们。

## Bot 共享

### 开启共享

节点所有者在 Web 中打开 Bot 编辑器，把可见性从「仅自己可见」切到「团队共享」。

可见性字段为 `visibility`：

| 值 | 含义 |
| --- | --- |
| `private` | 默认。仅节点所有者可见可用 |
| `team` | 当前 Hub 的已登录用户可发现并使用 |

节点也有 `visibility` 字段。三种情况之一即判定可用（`canUserUseBot`）：

1. 用户是该节点的所有者。
2. 该 Bot 的 `visibility` 为 `team`。
3. 该节点的 `visibility` 为 `team`。

### 共享后其他用户获得什么

- 在侧栏 Bot 列表看到该 Bot，带 `[共享]` 标记；在节点视图看到托管它的节点。
- 用该 Bot 创建单聊会话。
- 在自己的单聊中 `@` 该 Bot 接力，或把它排进执行队列。
- 使用该 Bot 的子代理：主 Bot 可用时，其子代理一并可用。
- 在自己拥有的会话中触发该 Bot 执行回合。执行仍发生在所有者的节点上。

### 共享的边界

其他用户不能：

- 编辑或删除该 Bot。
- 读写该 Bot 的 `SYSTEM.md`、`MEMORY.md` 和环境变量。
- 把该 Bot 用作子会话委派目标。委派要求委派者拥有该 Bot 的节点。
- 查看该节点的后台任务和模型登录状态，读写该节点的技能与扩展文件。
- 对该节点执行重启、删除、安装技能或扩展。

共享 Bot 等于允许其他用户请求它调用节点上的模型和工具。它不是只读资源。开启前先确认节点系统账户可访问的文件与服务，参见[安全边界](security.md)。

## 会话参与者

会话所有者可把其他用户加为参与者。当前 Web 界面没有参与者管理入口，使用 HTTP API：

```http
GET /api/sessions/<sessionId>/participants
```

列出参与者。

```http
POST /api/sessions/<sessionId>/participants
Content-Type: application/json

{"username":"ops","role":"member"}
```

`username` 与 `userId` 二选一。`role` 可省略，默认 `member`。重复添加为更新角色。

```http
DELETE /api/sessions/<sessionId>/participants/<userId>
```

会话所有者可移除任何参与者。参与者只能移除自己。

### 参与者能做什么

参与者拥有会话的完整读写权：

- 读消息、订阅 SSE 事件、发消息。
- 编辑消息、分叉会话、清空历史、取消执行。
- 调整执行队列（跳过阶段、追加阶段）。
- 停止单个子代理、向子代理插话或追问。
- 查看待确认请求并回答。待办列表同样包含参与会话的请求。

参与者不是只读角色。多人协作前先约定编辑与清空历史的方式。

### 参与者不能做什么

- 邀请或移除其他参与者（仅会话所有者）。
- 删除会话（仅会话所有者）。
- 创建、撤销公开分享链接（仅会话所有者）。
- 上传或下载会话产物（仅会话所有者）。
- 在会话内搜索消息。搜索只覆盖自己拥有的会话。
- 委派子会话到不属于自己的 Bot。

参与者分叉会话时，新会话仍归源会话所有者。

### 多人发言的署名

会话里有参与者时，发送者身份随消息落库（字段 `senderUserId`、`senderUsername`）。路由给 Bot 的内容会加前缀 `[User: <用户名>]:`，模型可以区分发言人。

## 权限边界表

下表逐条对应 Hub 的实际校验逻辑。

| 操作 | 管理员 | 节点所有者 | 共享 Bot 使用者 | 会话所有者 | 会话参与者 | 分享链接访问者 |
| --- | --- |---|---|---|---|---|
| 创建用户、重置密码、删除用户 | 仅此角色 | - | - | - | - | - |
| 配对码创建 | 可 | 可 | 可 | 可 | 可 | - |
| 节点删除、重启、安装、升级 | - | 仅自己的节点 | - | - | - | - |
| 模型登录、模型目录（指定节点） | - | 仅自己的节点 | - | - | - | - |
| 后台任务查看与终止 | - | 仅自己的节点 | - | - | - | - |
| 技能同步 | - | 源与目标节点均归自己 | - | - | - | - |
| Bot 增删改、提示词、记忆、环境变量 | - | 仅自己的节点 | - | - | - | - |
| 查看 Bot 列表 | 自有与共享 | 自有与共享 | 可见共享项 | 自有与共享 | 自有与共享 | - |
| 用 Bot 建会话、`@` 接力、排队 | - | 自有 Bot | 共享 Bot | 自有与共享 Bot | 按会话所有者口径 | - |
| 委派子会话 | - | 自有 Bot 可 | 不可 | 自有 Bot 可 | 不可 | - |
| 查看会话列表 | 自有与参与 | 自有与参与 | 自有与参与 | 自有与参与 | 自有与参与 | - |
| 读消息、发消息、订阅事件 | - | - | - | 自己的会话 | 参与的会话 | 只读消息 |
| 编辑消息、取消执行、清空历史 | - | - | - | 自己的会话 | 参与的会话 | - |
| 分叉会话 | - | - | - | 自己的会话 | 参与的会话（新会话归原所有者） | - |
| 回答确认请求 | - | - | - | 自己的会话 | 参与的会话 | - |
| 邀请、移除参与者 | - | - | - | 仅此角色 | 移除自己 | - |
| 删除会话 | - | - | - | 仅此角色 | - | - |
| 管理公开分享链接 | - | - | - | 仅此角色 | - | - |
| 上传、下载产物 | - | - | - | 仅此角色 | - | 经链接读 |
| 会话内搜索消息 | - | - | - | 仅自己的会话 | - | - |
| 触发器创建 | - | - | - | 有会话访问权即可 | 同左 | - |
| 触发器修改、删除、手动运行 | - | - | - | 仅创建者 | 仅创建者 | - |

说明两点：

- 管理员只多出账户管理权。管理员看不到也操作不了其他用户的节点与会话。
- 共享 Bot 使用者的会话执行权按会话所有者判定。所有者能用该 Bot，回合就能在该会话运行。

## 协作场景：两人在同一会话排障

场景：运维同事 ops 管理测试机，开发同事 dev 需要它上面的日志 Bot 一起排障。Hub 已在本机 `3002` 运行。

### 第 1 步：管理员创建两个账户

Web 路径：

1. admin 登录 `http://localhost:3001`。
2. 打开侧栏底部菜单，点击「用户管理」。
3. 新建用户 `ops`，角色 `member`。
4. 新建用户 `dev`，角色 `member`。

API 等价：

```bash
curl -X POST http://localhost:3002/api/users \
  -H 'Content-Type: application/json' -b 'botd_token=<admin令牌>' \
  -d '{"username":"ops","password":"ops-pass","role":"member"}'
curl -X POST http://localhost:3002/api/users \
  -H 'Content-Type: application/json' -b 'botd_token=<admin令牌>' \
  -d '{"username":"dev","password":"dev-pass","role":"member"}'
```

### 第 2 步：ops 配对测试机

```bash
# ops 本机登录 CLI
pnpm node login http://localhost:3002 --username ops --password ops-pass

# 生成配对码
pnpm node nodes pair

# 在测试机上执行输出的 join 命令
botd join http://localhost:3002 --code <配对码> --name test-node
```

节点归 ops 所有。dev 和 admin 看不到这个节点。

### 第 3 步：ops 创建诊断 Bot 并共享

1. ops 登录 Web。
2. 进入节点视图，新建 Bot，例如 `log-doctor`。
3. 在 Bot 编辑器中把可见性切到「团队共享」。
4. 保存。

### 第 4 步：dev 用共享 Bot 开会话

1. dev 登录 Web。
2. 新建会话，选择 `log-doctor`。它在侧栏 Bot 列表中带 `[共享]` 标记。
3. 发送排障问题。

Bot 在 ops 的测试机上执行。会话归 dev 所有。

### 第 5 步：dev 邀请 ops 进会话

从地址栏或会话列表取会话 ID，然后：

```bash
curl -X POST http://localhost:3002/api/sessions/<会话ID>/participants \
  -H 'Content-Type: application/json' -b 'botd_token=<dev令牌>' \
  -d '{"username":"ops"}'
```

只有会话所有者 dev 能执行这一步。ops 用自己的账户登录 Web 后，会话列表里会出现这个会话。

### 第 6 步：两人在同一会话排障

Web 或 CLI 均可发言：

```bash
# ops 侧
pnpm node login http://localhost:3002 --username ops --password ops-pass
pnpm node chat send <会话ID> 补充：报错出现在 auth 模块，帮忙看下日志 --wait 120
```

两人的消息都带用户名署名，模型能区分发言人。Bot 发起确认请求时，两人都能在待办中看到并回答，任一人回答即生效。

### 第 7 步：收尾

- ops 自行退出：`DELETE /api/sessions/<会话ID>/participants/<ops的userId>`。
- dev 需要给会话外同事看结论时，创建公开只读分享链接。链接访问者只能读消息和产物，见[安全边界](security.md)。
- dev 删除会话前先停止执行中的回合。

### 这个场景里的边界

- ops 是参与者：能读能写，不能删会话、不能管理分享链接、不能上传下载产物。
- dev 想把任务委派成子会话时，目标 Bot 必须归自己所有。`log-doctor` 归 ops，不可委派。
- 会话产物只有 dev 能通过 API 上传下载。

## 其他跨用户限制

- 向离线节点派发的任务暂存在 Hub，默认 72 小时有效。节点重连后恢复。边界细节见[架构说明](architecture.md)。
- 子会话完成后自动向父会话回报摘要。流程见[自动化指南](automation.md)。
- 通知通道的修改按创建者校验。

组合不同所有者的资源前，先用测试会话验证要用的接口。

## 相关文档

- [用户指南](user-guide.md)：Bot、子代理与消息操作
- [自动化指南](automation.md)：子会话委派、人工确认、产物、触发器
- [安全边界](security.md)：共享访问与凭据要求
- [HTTP API](api.md)：接口清单与 SSE 事件
- [CLI 参考](cli.md)：会话与消息命令
