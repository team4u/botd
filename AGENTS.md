# botd 开发约定

## 设计原则

符合 UNIX 设计原则。

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

## 前端设计与字号规范（apps/web）

参考 Linear / Vercel 现代管理后台设计系统，全站统一使用 Tailwind 内置规范阶梯，杜绝控件文字突兀放大：

| 用途 | 标准类 | 视觉效果 |
|---|---|---|
| 表单单行控件（input / select / SearchableSelect 触发器） | `h-8 px-2.5 text-xs rounded-lg` | 32px 高度紧凑精致，文字 12px，与周围 Label 完全同阶 |
| 表单多行文本域（textarea / prompt 编辑） | `p-2.5 text-xs rounded-lg` | 紧凑 12px，行高 1.5 |
| 字段标签（Label）、按钮、正文导航 | `text-xs font-medium` | 12px（字重 500 次级色阶，与输入框自然区分） |
| 次级小字（说明提示 Hint、时间戳、mono 标识） | `text-[11px]` 或 `text-xs` | 11px~12px 次级灰，提供清晰层次 |
| 弹窗/页面标题 | `text-sm sm:text-base font-semibold` | 14px~16px |
| 登录页大标题 | `text-xl font-bold` | 20px |
| 配对码等展示型大字符 | `text-3xl font-bold` | 30px |

约束：
- 控件高度严格收敛为 `h-8`（32px），圆角统一使用现代克制的 `rounded-lg`，禁止滥用 `rounded-xl`
- 消息正文字号只在 `index.css` 的 `.prose-botd` 定义，组件内不得叠加字号类
