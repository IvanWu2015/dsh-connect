# dsh-connect

[English](README.md) | 中文

将 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（**DSH**）智能体接入聊天平台——**优先飞书 / Lark**，钉钉等更多平台随后跟进。从你的聊天应用发送任务，观看智能体实时流式执行，保持多轮上下文，任务结束时自动把结果摘要推送回来。

## 功能特性

- **双向消息**：飞书消息 → DSH 智能体（`agent.followup`）；智能体的回复以打字机风格的卡片流式回传到飞书。
- **多轮上下文**：每个飞书会话（私聊或群聊）都绑定一个 DSH `Session`，进程重启后自动 `resume`。
- **工作安排**：任务结束时推送结果摘要卡片；`ctx.connect.notify()` 让 goals/jobs 钩子可以主动推送进度。
- **任务结束统计**：任务完成时，卡片报告所用模型、输入/输出/缓存 token 数、步数、耗时与上下文占用率；当上下文占用 ≥ 75% 时给出 `/compact` 建议。
- **通知级别**：`full`（全量流式）/ `important`（关键里程碑，默认）/ `result`（仅答案）——每个会话可通过设置菜单或 `/notify` 切换，重启后保持。
- **即时反馈 + 主动进度**：每条任务收到后立即确认（“✅ 已收到，开始处理”，繁忙时附带排队消息数）；关键里程碑（思考、带步数计数的工具调用、提问、权限）实时响应；可配置的看门狗在一轮对话静默过久时（默认 5 分钟，可通过 `/progress` 或 `/settings` 按会话调整）推送一张独立的状态卡片。
- **首次欢迎**：每个会话的第一条消息触发一次性欢迎卡片，介绍机器人的能力与常用命令。
- **可操作的错误提示**：失败的任务显示与错误匹配的建议——权限 / 网络 / 模型配额问题各有对应的修复提示，而不是一行裸的错误字符串。
- **安全的破坏性操作**：`/clear`、`/new` 和菜单中的“新建对话”都会先请求确认，历史记录绝不会被误清。
- **聊天中的用户选择与权限审批**：当智能体提问（`ask_user_question`）或请求权限审批（沙箱升级等）时，飞书里会直接出现带按钮的交互卡片——点按或回复文字（数字或选项标签）即可作答，无需打开 Web GUI。
- **安全**：群聊默认要求 @提及；用户/会话允许列表；飞书凭据通过环境变量或配置提供。
- **交互式菜单**：`/menu` 提供层级化点按导航（workdir / chats / settings / plugins / compact 等）——同一张卡片就地更新，支持返回/退出，连续操作中持续可用。
- **智能图片与文件处理**：发送给机器人的图片自动下载；主模型若支持视觉则直接查看，否则由视觉模型子任务生成描述并注入——纯文本主模型不会在图片上卡住。附件/音频/视频也会下载到 workdir。
- **Web 镜像**：每个会话可将其 DSH 会话镜像到 DSH Web GUI（`/mirror`，或通过 `autoMirror` 自动开启）。镜像锁只在飞书侧强制（`lockOwner`）：Web GUI 直接读写 DSH 会话、从不查询锁，因此互斥是单侧的（仓库层面无法修复，已如实记录）。`/new`、`/clear` 或切换会话会重置镜像指向；`autoMirror` 会为新会话重建镜像。
- **定时提醒**：`/remind 10分钟 喝水`（或 `2h` / `14:30`）持久化一条会话级提醒，到点自动触发——不唤醒智能体、不消耗模型 token，进程重启后依然生效。`/schedule` 会与智能体自身的会话内提醒一并列出。
- **向会话回传文件**：`/send <路径>` 把工作区文件发给会话——图片内联展示，其他文件作为附件（飞书 / Telegram）。
- **管理员广播**：`/broadcast <内容>` 向所有通道的全部已绑定会话推送消息（仅 `allowUsers` 中配置的管理员可用）。
- **线程隔离（飞书，可选）**：开启 `threadIsolation: true` 后，群里的每个话题线程各自绑定一个独立的 DSH 会话。
- **本地命令**（不消耗模型 token）：`/status` `/task` `/chat` `/dir` `/workspace` `/workspaces` `/plugins` `/compact` `/history` `/export` `/goals` `/schedule` `/remind` `/send` `/broadcast` `/model` `/notify` `/progress` `/mirror` `/unlock` `/renew` `/new` `/clear` `/stop` `/settings` `/help`。
- **可扩展、多平台**：`dsh-connect`（通道无关核心）+ 各通道适配器包——`dsh-connect-feishu`（飞书/Lark 双向）、`dsh-connect-telegram`（Telegram 双向）、`dsh-connect-dingtalk`（双向 stream 模式 + 单向 webhook 推送）。新增一个通道只需再写一个适配器包。

## 仓库结构

```
packages/
  connect/           dsh-connect core: services, bindings, runner, streaming bridge, commands
  connect-feishu/    dsh-connect-feishu Feishu adapter: createLarkChannel long connection, normalization, streaming replies
  connect-telegram/  dsh-connect-telegram Telegram adapter: Bot API long-polling, streaming edits, inline-keyboard choices
  connect-dingtalk/  dsh-connect-dingtalk 钉钉：stream 模式双向适配器（STOMP over WebSocket）+ webhook 单向推送服务
  connect-web/       dsh-connect-web Web mirror adapter: tracks mirror sessions for DSH Web GUI (no synthesized messages; outbound is a contract no-op)
docs/
  QUICKSTART.md      step-by-step run guide (DSH side + Feishu side)
  feishu-setup.md    Feishu Open Platform configuration manual
  telegram-setup.md  Telegram BotFather setup manual
  dingtalk-setup.md  DingTalk group custom-robot setup manual
  PUBLISHING.md      naming + GitHub/npm discoverability guide
examples/
  profile-cordis.patch.yml
```

## 通道矩阵

| 通道 | 包 | 方向 | 传输方式 | 说明 |
|---|---|---|---|---|
| 飞书 / Lark | `dsh-connect-feishu` | 双向 | WebSocket 长连接 | 功能完整（流式、菜单、图片） |
| Telegram | `dsh-connect-telegram` | 双向 | Bot API 长轮询 | 功能完整（流式编辑、内联键盘） |
| 钉钉 | `dsh-connect-dingtalk` | 双向（stream）/ 单向推送 | stream 网关（STOMP over WebSocket）/ 群机器人 webhook | stream 模式：@提及触发智能体、回复与编号文本菜单；webhook 模式：推送服务（sendMarkdown / sendText / @提及） |

所有双向适配器共享同一个 `dsh-connect` 核心：命令、`/menu`、通知级别、主动进度看门狗、交互式选择与审批以及按会话设置，在每个通道上行为完全一致。

## 快速开始

### 安装

5 个包在每次 GitHub Release 时自动发布到 npm——[`.github/workflows/publish.yml`](.github/workflows/publish.yml) 会先运行 `pnpm build` + typecheck，再串行发布 5 个包。直接安装到你的 DSH profile：

```sh
dsh plugin --profile web add dsh-connect dsh-connect-feishu dsh-connect-telegram dsh-connect-dingtalk
```

本地开发（包尚未发布时）请按 [快速开始](docs/QUICKSTART.zh.md) 中的绝对路径方式加载本地构建的包。

### 配置

在 profile 的 `cordis.patch.yml`（`$DSH_HOME/profiles/web/cordis.patch.yml`）末尾追加配置。这些插件会通过各自的 bundle 清单自动注册，因此这里只需要**覆盖（override）**它们的配置——**不要**再用 `insert` 重新插入它们（重复的 `id` 会让 dsh 以 `duplicate loader entry id` 拒绝启动）：

```yaml
- id: connect
  name: dsh-connect
- id: connect-feishu
  name: dsh-connect-feishu
  config:
    appId: cli_xxxx
    appSecret: cli_secret_xxxx
    transport: websocket
    requireMention: true
    dmMode: open
- id: connect-telegram
  name: dsh-connect-telegram
  config:
    botToken: "123456:ABC-YourBotToken"   # from @BotFather
    requireMention: true
- id: connect-dingtalk
  name: dsh-connect-dingtalk
  config:
    webhookUrl: "https://oapi.dingtalk.com/robot/send?access_token=xxx"
```

### 运行

重启 `dsh web`（Host 插件需要进程重启才能加载），按 [飞书配置](docs/feishu-setup.zh.md)、[Telegram 配置](docs/telegram-setup.zh.md) 或 [钉钉配置](docs/dingtalk-setup.zh.md) 完成平台侧的订阅，然后与机器人聊天。

> 详细的分步指南（包括飞书侧配置与验证）见 [快速开始](docs/QUICKSTART.zh.md)。

## 命令列表

| 命令 | 说明 |
|---|---|
| `/menu` | 打开主菜单（层级化点按；同一张卡片就地更新；支持返回/退出） |
| `/settings`（`/set`） | 设置：切换模型 / 推理力度 / 通知级别 / 配置概览 |
| `/model` | 显示当前模型，点按切换 |
| `/notify`（`/notice`） | 选择通知级别：`full` / `important` / `result`（立即生效） |
| `/progress` | 选择静默任务在收到主动进度卡片前可运行多久（默认 5 分钟；`关闭` 可禁用） |
| `/mirror [--timeout N]` | 为本会话创建（或显示）Web 镜像会话；可选锁超时分钟数 |
| `/unlock` | 手动释放会话锁（仅飞书/Web 镜像场景） |
| `/renew`（`/renew-lock`） | 续期当前会话锁超时 |
| `/status` | 会话状态、模型、workdir、队列长度、**上下文 token**、会话 ID |
| `/task`（`/tasks` `/todo`） | 显示当前任务列表 |
| `/schedule`（`/reminders`） | 显示本会话的定时提醒 |
| `/chat`（`/session` `/sessions`） | 列出会话；点按切换或新建 |
| `/dir`（`/cd` `/pwd`） | 切换 workdir（点按选择，或 `/dir <绝对路径>`） |
| `/workspace <绝对路径>` | 创建新的工作区 |
| `/workspaces` | 列出所有工作区 |
| `/plugins` | 列出已安装插件 |
| `/compact` | 压缩当前会话上下文 |
| `/history [count]` | 显示最近的会话消息 |
| `/export [markdown]` | 导出对话历史为 Markdown |
| `/goals` | 显示当前目标 |
| `/new`（`/reset`） | 开始新对话（请求确认） |
| `/clear` | 清空当前对话（请求确认） |
| `/stop`（`/cancel`） | 停止当前任务 |
| `/help` | 列出所有命令 |

> 所有 `/` 命令都由插件在本地执行，不消耗模型 token；其他任何文本都会作为任务发送给 DSH 智能体。

## 配置

### dsh-connect（核心）

| 键 | 默认值 | 说明 |
|---|---|---|
| `agentPreset` | 未设置 = roster 默认 | 每个绑定会话使用的智能体预设（如 `standard`） |
| `workDir` | 第一个 DSH 工作区 | 智能体工作目录（绝对路径，可显式设置） |
| `workspaces` | `[]` | `/dir` 交互选择器中列出的工作目录 |
| `visionModel` | 自动检测 | 图片子任务的视觉模型 `{provider, model}`；未设置时自动检测第一个支持图片的模型 |
| `language` | `zh` | 面向用户的消息语言：`zh`（默认）或 `en` |
| `allowUsers` | `[]` | 发送者允许列表（空 = 允许所有人） |
| `allowChats` | `[]` | 会话允许列表（空 = 允许所有人） |
| `stateDir` | `./.dsh-connect` | 绑定路由 `bindings.json` 的存放目录 |
| `autoMirror` | `true` | 为每个新会话自动创建 Web 镜像会话 |
| `streamHeartbeatMs` | `60000` | 流式卡片存活心跳间隔（毫秒）；`0` 禁用 |
| `notifyLevel` | `important` | 默认通知级别：`full`（全量流式）/ `important`（关键里程碑）/ `result`（仅答案）；可通过 `/settings` 或 `/notify` 按会话覆盖 |
| `progressTimeoutMs` | `300000` | 主动进度通知间隔（毫秒）：一轮对话在此时间内未发送任何内容时，推送一张独立状态卡片；`0` 禁用；可通过 `/settings` 或 `/progress` 按会话覆盖 |

### dsh-connect-feishu（飞书）

| 键 | 默认值 | 说明 |
|---|---|---|
| `appId` / `appSecret` | 环境变量 `FEISHU_APP_ID` / `FEISHU_APP_SECRET`，或**一键开通** | 应用凭据（未设置时进入开通模式，通过扫码创建应用） |
| `transport` | `websocket` | `websocket`（默认，长连接）；`webhook` 需要公网 HTTPS 回调地址，适配器自带 HTTP 服务并自动应答 `url_verification` 挑战 |
| `webhookPort` | `9000` | webhook 传输模式的 HTTP 监听端口 |
| `webhookPath` | `/` | 飞书事件回调路径 |
| `verificationToken` / `encryptKey` | 空 | 仅 webhook 模式需要 |
| `requireMention` | `true` | 群聊仅在 @提及机器人时响应 |
| `dmMode` | `open` | 私聊策略：`open` / `allowlist` / `pair` / `disabled`（`disabled` = 忽略私聊） |
| `language` | `zh` | 面向用户的消息语言：`zh`（默认）或 `en` |

> **一键开通**：不带 `appId`/`appSecret` 启动插件，它会打印一个开通链接（约 10 分钟有效）。用飞书扫码（或点击并确认），机器人应用即自动创建，权限与事件订阅均已预设；凭据保存到 `$DSH_HOME/.dsh-connect/feishu-credentials.json`。

## 工作原理

- **智能体创建/恢复**：复用标准 DSH 驱动模式（见 `dsh-headless`）——`ctx.agents.create({ meta:{cwd, agentPreset}, agentOptions:{provider,model}, setup })`；恢复走 `ctx.agents.resume`。每个会话的模型选择由 DSH api-proxy 负责（`selectionFor`），因此在 Web GUI 中切换模型会应用到绑定会话。
- **预设挂载**：`setup` 挂载配置的智能体预设（`ctx.agentPresets.mount`），为绑定会话提供标准工具集（bash/fs/…）。
- **流式**：`session/event` 上的 `assistant/chunk` 事件（推理/文本增量、块开始/结束）通过 `createAsyncQueue` 桥接到飞书流式卡片；块之间以空行分隔，推理实时流式输出，工具调用显示状态行，可配置的心跳在长静默阶段保持卡片存活。`turn/end` 决定回合结果并发布任务统计卡片。
- **主动进度**：每条消息立即确认；若在 `progressTimeoutMs` 内未发送任何独立卡片/文本，则推送状态卡片报告最新里程碑（思考 / 最近一次工具调用），长回合看起来不会卡死。
- **交互式选择与审批**：插件作为宿主 api-proxy（`ctx.apiProxy`）的进程内客户端：订阅与 Web GUI 相同的 mux 流，将 connect 绑定会话的 `question/requested` / `approval/requested` 帧渲染为带按钮的飞书卡片，并通过 `apiProxy.respond` 回传用户的答案——Web GUI 保持完全可用，先到者先答。
- **串行化**：每个 chatKey 对应一个 `AgentRunner`——消息排队串行执行；`agent.followup` 天然排队。

## 测试

5 个测试套件，全部使用 `node:test`（需先构建 `lib/`）：

```sh
pnpm build        # build first (generates lib/)
pnpm test         # 5 个测试套件，全部 node:test
```

- `packages/connect/test/unit.test.mjs` + `packages/connect/test/smoke.mjs`（connect 核心套件）：命令解析、绑定持久化、异步队列、回合结果推导；以及把插件加载进真实 Cordis 上下文验证插件契约，含 `isChatAllowed` 允许列表预过滤断言。
- `packages/connect-dingtalk/test/unit.test.mjs`：签名校验、重试/限流、20000 字符截断。
- `packages/connect-telegram/test/unit.test.mjs`：HTML 转义、@提及判断、offset 确认语义。
- `packages/connect-feishu/test/unit.test.mjs`：按钮网格、标签对齐、文件名清洗、错误提取。
- `packages/connect-web/test/unit.test.mjs`：镜像记录、无合成消息回归测试。

## 文档

- [飞书开放平台配置](docs/feishu-setup.zh.md)
- [命名与 GitHub/npm 可发现性](docs/PUBLISHING.zh.md)
- [配置示例](examples/profile-cordis.patch.yml)

## 许可证

MIT
