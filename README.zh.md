# dsh-connect

[English](README.md) | 中文

将 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（**DSH**）智能体接入聊天平台——一个插件同时支持**飞书 / Lark**、**Telegram** 与**钉钉**。从你的聊天应用发送任务，观看智能体实时流式执行，保持多轮上下文，任务结束时自动把结果摘要推送回来。

## 功能特性

- **双向消息**：飞书消息 → DSH 智能体（`agent.followup`）；智能体的回复以打字机风格的卡片流式回传到飞书。
- **多轮上下文**：每个飞书会话（私聊或群聊）都绑定一个 DSH `Session`，进程重启后自动 `resume`。
- **工作安排**：任务结束时推送结果摘要卡片；`ctx.connect.notify()` 让 goals/jobs 钩子可以主动推送进度。
- **任务结束统计**：任务完成时，卡片报告所用模型、输入/输出/缓存 token 数、步数、耗时与上下文占用率；当上下文占用 ≥ 75% 时给出 `/compact` 建议。
- **通知级别**：`full`（全量流式）/ `important`（关键里程碑）/ `result`（仅答案，默认——卡片保持简短）——每个会话可通过设置菜单或 `/notify` 切换，重启后保持。
- **即时反馈 + 主动进度**：每条任务收到后立即确认（“✅ 已收到，开始处理”，繁忙时附带排队消息数）；关键里程碑（思考、带步数计数的工具调用、提问、权限）实时响应；可配置的看门狗在一轮对话静默过久时（默认 5 分钟，可通过 `/progress` 或 `/settings` 按会话调整）推送一张独立的状态卡片。
- **首次欢迎**：每个会话的第一条消息触发一次性欢迎卡片，介绍机器人的能力与常用命令。
- **可操作的错误提示**：失败的任务显示与错误匹配的建议——权限 / 网络 / 模型配额问题各有对应的修复提示，而不是一行裸的错误字符串。
- **安全的破坏性操作**：`/clear`、`/new` 和菜单中的“新建对话”都会先请求确认，历史记录绝不会被误清。
- **聊天中的用户选择与权限审批**：当智能体提问（`ask_user_question`）或请求权限审批（沙箱升级等）时，飞书里会直接出现带按钮的交互卡片——点按或回复文字（数字或选项标签）即可作答，无需打开 Web GUI。
- **安全**：群聊默认要求 @提及；用户/会话允许列表；各通道凭据可通过环境变量、配置文件或 DSH 凭据库提供（由设置面板写入，且回显永不返回明文）。
- **交互式菜单**：`/menu` 提供层级化点按导航（workdir / chats / settings / plugins / compact 等）——同一张卡片就地更新，支持返回/退出，连续操作中持续可用。
- **智能图片与文件处理**：发送给机器人的图片自动下载；主模型若支持视觉则直接查看，否则由视觉模型子任务生成描述并注入——纯文本主模型不会在图片上卡住。附件/音频/视频也会下载到 workdir。
- **Web 镜像**：每个会话可将其 DSH 会话镜像到 DSH Web GUI（`/mirror`，或通过 `autoMirror` 自动开启）。镜像锁只在飞书侧强制（`lockOwner`）：Web GUI 直接读写 DSH 会话、从不查询锁，因此互斥是单侧的（仓库层面无法修复，已如实记录）。`/new`、`/clear` 或切换会话会重置镜像指向；`autoMirror` 会为新会话重建镜像。
- **定时提醒**：`/remind 10分钟 喝水`（或 `2h` / `14:30`）持久化一条会话级提醒，到点自动触发——不唤醒智能体、不消耗模型 token，进程重启后依然生效。`/schedule` 会与智能体自身的会话内提醒一并列出。
- **向会话回传文件**：`/send <路径>` 把工作区文件发给会话——图片内联展示，其他文件作为附件（飞书 / Telegram）。
- **管理员广播**：`/broadcast <内容>` 向所有通道的全部已绑定会话推送消息（仅 `allowUsers` 中配置的管理员可用）。
- **线程隔离（飞书，可选）**：开启 `threadIsolation: true` 后，群里的每个话题线程各自绑定一个独立的 DSH 会话。
- **本地命令**（不消耗模型 token）：`/status` `/task` `/chat` `/dir` `/workspace` `/workspaces` `/plugins` `/compact` `/history` `/export` `/goals` `/schedule` `/remind` `/send` `/broadcast` `/model` `/notify` `/progress` `/mirror` `/unlock` `/renew` `/new` `/clear` `/stop` `/settings` `/help`。
- **多合一、多平台**：`dsh-connect` 是唯一的插件——核心 `connect` 服务 + 全部通道适配器（飞书/Lark、Telegram、钉钉）+ Web 设置栈，全部通过一个 `channels` 选择器启用。按需启用你要用的通道。

## 仓库结构

```
packages/
  connect/           dsh-connect 多合一插件：核心 connect 服务 + 通道适配器 + Web 设置栈
    src/             核心：agent runner、适配器注册表与路由、绑定存储、命令
    src/channels/    各通道适配器：feishu（飞书长连接、归一化、流式回复）、telegram（Bot API 长轮询、流式编辑）、dingtalk（stream 双向 + webhook 推送）、web（镜像监视器）
    src/settings/    Web 设置栈：宿主 RPC、凭据库、脱敏策略
    client/          Web 设置前端插件，及其零依赖模块（locale.mjs、panel-state.mjs）
    docs/images/     README 引用的设置面板截图
    test/            node:test 套件
docs/
  QUICKSTART.md          step-by-step run guide (DSH side + platform side)
  config-reference.md    every plugin option, annotated
  feishu-setup.md        Feishu Open Platform configuration manual
  telegram-setup.md      Telegram BotFather setup manual
  dingtalk-setup.md      DingTalk group custom-robot setup manual
  PUBLISHING.md          naming + GitHub/npm discoverability guide
  all-in-one-and-web-settings.md
                         合并与设置栈的设计说明
  archive/               已被取代的拆分包文档，保留作历史
examples/
  profile-cordis.patch.yml
```

用户需要的每一份 `docs/*.md` 都有对应的 `.zh.md`。

## 通道矩阵

| 通道 | 适配器（`dsh-connect` 内） | 方向 | 传输方式 | 说明 |
|---|---|---|---|---|
| 飞书 / Lark | `feishu` 通道 | 双向 | WebSocket 长连接 | 功能完整（流式、菜单、图片） |
| Telegram | `telegram` 通道 | 双向 | Bot API 长轮询 | 功能完整（流式编辑、内联键盘） |
| 钉钉 | `dingtalk` 通道 | 双向（stream）/ 单向推送 | stream 网关（STOMP over WebSocket）/ 群机器人 webhook | stream 模式：@提及触发智能体、回复与编号文本菜单；webhook 模式：推送服务（sendMarkdown / sendText / @提及） |
| Web 镜像 | `web` 通道 | 出站空操作 | 监视器 | 跟踪 DSH Web GUI 的镜像会话（不合成消息） |

所有通道共享同一个 `dsh-connect` 核心：命令、`/menu`、通知级别、主动进度看门狗、交互式选择与审批以及按会话设置，在每个通道上行为完全一致。通过 `channels` 选择器启用你要的通道；各通道密钥可存进 DSH 凭据库。

## 设置面板

`dsh-connect` 在 **设置 → dsh-connect** 下有自己的页面。它是一条渠道页签条 + 若干可折叠卡片：
每张卡片由一个按钮做标题行，低频字段收在第二级的**高级选项**折叠里，保存/状态固定在滚动区底部。

| 渠道与凭据 | 展开高级选项 |
|---|---|
| ![dsh-connect 设置面板：渠道页签条、展开的飞书卡片及其凭据字段，以及三张收起后仍显示凭据徽标的渠道卡片](packages/connect/docs/images/settings-overview-zh.png) | ![同一面板展开某渠道的「高级选项」折叠，露出回调端口与回调路径字段](packages/connect/docs/images/settings-advanced-zh.png) |

![面板底部的公共默认卡片与固定保存条](packages/connect/docs/images/settings-defaults-zh.png)

English screenshots: [overview](packages/connect/docs/images/settings-overview-en.png) · [advanced](packages/connect/docs/images/settings-advanced-en.png) · [shared defaults](packages/connect/docs/images/settings-defaults-en.png).

> 截图取自一个凭据全是占位符的一次性 profile。上面没有任何真实密钥——也不可能有：宿主会在
> 值到达浏览器之前完成打码（见下文[面板回显与脱敏](#面板回显与脱敏)）。

卡片默认展开你已启用的渠道（一个都没启用时展开第一个）。点击页签会展开对应卡片并滚进视野，
**不会**收起其他卡片——多张同时展开是合法状态。收起是**卸载**卡片主体而不是隐藏它，这之所
以安全，是因为你刚输入但尚未保存的密钥存在面板自身的 state 里，而不在卡片里。勾选某渠道的
启用框同样会展开它。

### 设置存放位置

面板编辑的是 `$DSH_HOME/settings.yaml` 里的 `dsh-connect` 段，走 DSH 自带的（第一方）设置机制
——支持热重载、在文件锁下原子写入、并保留你的注释，所以手工编辑它同样有效。取值分三层解析，
越靠后越具体：

1. 插件内置的 schema 默认值；
2. 插件自己的 `cordis.patch.yml` 条目（你现有的配置**不会**被丢弃，它注册为基础层）；
3. `settings.yaml` 中的 `dsh-connect` 段。

**密钥永远不会写入 `settings.yaml`。** 那是一份普通的、鼓励用户贴进 issue 的文档；凭据
一律保存在 DSH 凭据库（`ctx.credentials`）——一键开通流程与 `FEISHU_*` 这类环境变量也
正是写在那里。

旧版 `/dsh-connect` HTTP RPC 为面板兼容而保留；它现在读写同一个 namespace，并把非密钥配置
镜像到 `settingsStatePath`，以兼容旧面板。

### 面板回显与脱敏

每个已保存的密钥字段下方都有一行**只读**的「当前值：…」（没有值时显示「未配置」），这样你
不用重新输入就能确认自己填了什么。**打码在宿主侧完成**，只有一张共用的策略表
（`src/settings/secret-disclosure.ts`）——宿主按它打码，面板按它决定输入框渲染成
`password` 还是 `text`，两边因此不可能各说各话。

| 字段 | 显示方式 |
|---|---|
| `appId`、`clientId` | **完整显示**。它们是标识符而不是口令：每次出站 API 调用都会带上，厂家控制台也明文可见，遮住并不能保护什么。 |
| `appSecret`、`clientSecret`、`botToken`、`secret` | 只留头尾，例如 `a1b2…z9y8`。太短、露头露尾就等于全露的值，改为固定长度的 `••••••`。 |
| `webhookUrl`（钉钉） | **URL 感知**。保留协议、域名、路径与参数名，只对令牌的中段打码——钉钉把令牌放在查询串里，整串打码（`https…bcde`）等于什么也确认不了。 |
| 其他 / 未列出的键 | 一律按最保守的方式打码。 |

有两条性质无论如何都成立：

- **可用密钥不会跨线。** 值在离开宿主前就已打码，所以浏览器标签页（以及它的截图）永远拿不到
  一个可用的密钥。
- **掩码不可能被写回。** 预览是输入框**旁边**的文本，不是输入框的 `value`。输入框始终为空，
  而「空」的含义是「不动已保存的值」——因此只保存配置时，一个凭据都不会被写入。

面板自身的全部文案都来自 `client/locale.mjs`，其中同时提供 `zh` 与 `en`；有测试断言两种语言的
键集合完全一致——宿主在缺键时会静默回退到另一种语言。

### 凭据分组

当某通道的**任意一组**凭据被完整满足时，该通道即视为「已配置」；而单组内必须**全部**满足
——组内是 all-of，组间是 any-of。没有任何分组的通道（`web`）按定义就是已配置，永远不显示
告警徽标。

之所以要分组，是因为一个通道可能有不止一种互斥的认证方式；若要求全部满足，就会把明明能用的
机器人误报成未配置：

| 通道 | 分组 |
|---|---|
| `feishu` | app id + app secret |
| `telegram` | bot token |
| `dingtalk` | webhook URL + 签名密钥 —— *或* —— Stream 模式的 client id + client secret |
| `web` | 无 |

因此，只用 webhook 推送（没有 Stream 凭据）的钉钉机器人会被正确判定为已配置，只用 Stream
模式的同样如此。

## 快速开始

### 安装

该包会在每次 GitHub Release 时自动发布到 npm——[`.github/workflows/publish.yml`](.github/workflows/publish.yml) 会先运行 `pnpm build` + typecheck，再发布 `dsh-connect`。**安装一次即可**——一个插件、一份配置，按需启用你用的渠道：

```sh
dsh plugin --profile web add dsh-connect
```

（安装这一个包会拉进核心 `connect` 服务、所有通道适配器以及 Web 设置栈。通过 `channels` 选择器启用你要的通道。）

本地开发（包尚未发布时）请按 [快速开始](docs/QUICKSTART.zh.md) 中的绝对路径方式加载本地构建的包。

### 配置

在 profile 的 `cordis.patch.yml`（`$DSH_HOME/profiles/web/cordis.patch.yml`）末尾追加配置。该插件会通过其 bundle 清单自动注册，因此这里只需要**覆盖（override）**它的配置——**不要**再用 `insert` 重新插入它（重复的 `id` 会让 dsh 以 `duplicate loader entry id` 拒绝启动）：

```yaml
- id: connect
  name: dsh-connect
  config:
    channels: [feishu, telegram, dingtalk]   # 启用哪些通道（默认：全部内置）
    channelDefaults:
      language: zh                           # 所有渠道继承的公共键
    feishu:
      appId: cli_xxxx
      appSecret: cli_secret_xxxx
      transport: websocket
      requireMention: true
      dmMode: open
    telegram:
      botToken: "123456:ABC-YourBotToken"    # 来自 @BotFather
      requireMention: true
    dingtalk:
      webhookUrl: "https://oapi.dingtalk.com/robot/send?access_token=xxx"
      # stream: { clientId: xxx, clientSecret: xxx }   # 启用双向 stream 模式
```

> 密钥类字段（`appSecret`/`botToken`/`clientSecret`）也可以只存进 DSH 凭据库，由 Web 设置面板写入——见 [配置参考](docs/config-reference.md)。

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
| `agentPreset` | 未设置 = roster 默认 | 每个绑定会话使用的智能体预设（如 `standard`）。解析是尽力而为的：先试配置的 id，再试 `standard`（或 roster 中第一个可挂载项），两者都组合不出来时，智能体不带预设构建、回合照常运行。因此一个过期的 id 只会留下日志，不会让每条消息都失败。 |
| `workDir` | 第一个 DSH 工作区 | 智能体工作目录（绝对路径，可显式设置） |
| `workspaces` | `[]` | `/dir` 交互选择器中列出的工作目录 |
| `visionModel` | 自动检测 | 图片子任务的视觉模型 `{provider, model}`；未设置时自动检测第一个支持图片的模型 |
| `language` | `zh` | 面向用户的消息语言：`zh`（默认）或 `en` |
| `allowUsers` | `[]` | 发送者允许列表（空 = 允许所有人） |
| `allowChats` | `[]` | 会话允许列表（空 = 允许所有人） |
| `stateDir` | `./.dsh-connect` | 绑定路由 `bindings.json` 的存放目录 |
| `autoMirror` | `true` | 为每个新会话自动创建 Web 镜像会话 |
| `streamHeartbeatMs` | `60000` | 流式卡片存活心跳间隔（毫秒）；`0` 禁用 |
| `notifyLevel` | `result` | 默认通知级别：`full`（全量流式）/ `important`（关键里程碑）/ `result`（仅答案，默认）；可通过 `/settings` 或 `/notify` 按会话覆盖 |
| `progressTimeoutMs` | `300000` | 主动进度通知间隔（毫秒）：一轮对话在此时间内未发送任何内容时，推送一张独立状态卡片；`0` 禁用；可通过 `/settings` 或 `/progress` 按会话覆盖 |

### 飞书通道（`feishu`）

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

> **一键开通**：不带 `appId`/`appSecret` 启动插件，它会打印一个开通链接（约 10 分钟有效）。用飞书扫码（或点击并确认），机器人应用即自动创建，权限与事件订阅均已预设；**凭据保存到 DSH 凭据库**。（0.9.0 之前它们写进 `$DSH_HOME/.dsh-connect/feishu-credentials.json`，而没有任何代码读回该文件——已有安装会在启动时从这个文件回填一次，此后它不再被使用。）该流程只在确实能完成时才启动：`onboarding: false` 或 stdout 不是终端时会被跳过，因此一个无人应答的服务进程不会开始扫码。

## 工作原理

- **智能体创建/恢复**：复用标准 DSH 驱动模式（见 `dsh-headless`）——`ctx.agents.create({ meta:{cwd, agentPreset}, agentOptions:{provider,model}, setup })`；恢复走 `ctx.agents.resume`。每个会话的模型选择由 DSH api-proxy 负责（`selectionFor`），因此在 Web GUI 中切换模型会应用到绑定会话。
- **预设挂载**：`setup` 挂载配置的智能体预设（`ctx.agentPresets.mount`），为绑定会话提供标准工具集（bash/fs/…）。挂载是尽力而为的——先试配置的 id，再试 `standard`（或 roster 中第一个可挂载项），最后是不带预设——因为预设解析发生在智能体存在**之前**，在那里抛错会让每个绑定会话的每一轮都以一条宿主原始错误告终，而不是一条回复。
- **流式**：两路数据通过 `createAsyncQueue` 桥接到渠道的流式卡片。持久的 `session/event` 流承载回合、工具调用与结算；瞬时的 `agent/assistant-stream` 帧承载推理/文本增量。它们是两路独立订阅，因为 DSH `0.1.5-rc.2` 删除了过去同时承载两者的 `assistant/chunk` 会话事件。块之间以空行分隔，推理实时流式输出，工具调用显示状态行，可配置的心跳在长静默阶段保持卡片存活。`turn/end` 决定回合结果并发布任务统计卡片。
- **主动进度**：每条消息立即确认；若在 `progressTimeoutMs` 内未发送任何独立卡片/文本，则推送状态卡片报告最新里程碑（思考 / 最近一次工具调用），长回合看起来不会卡死。
- **交互式选择与审批**：插件作为宿主 api-proxy（`ctx.apiProxy`）的进程内客户端：订阅与 Web GUI 相同的 mux 流，将 connect 绑定会话的 `question/requested` / `approval/requested` 帧渲染为带按钮的飞书卡片，并通过 `apiProxy.respond` 回传用户的答案——Web GUI 保持完全可用，先到者先答。
- **串行化**：每个 chatKey 对应一个 `AgentRunner`——消息排队串行执行；`agent.followup` 天然排队。

## 测试

所有套件均使用 `node:test`，经统一 runner 运行（需先构建 `lib/`）：

```sh
pnpm build        # build first (generates lib/)
pnpm test         # 经 packages/connect/test/run-all.mjs 运行全部套件
```

- `packages/connect/test/run-all.mjs`：进程内导入每个套件（见下方各套件）。
- `packages/connect/test/unit.test.mjs` + `packages/connect/test/smoke.mjs`（connect 核心套件）：命令解析、绑定持久化、异步队列、回合结果推导；以及把插件加载进真实 Cordis 上下文验证插件契约，含 `isChatAllowed` 允许列表预过滤断言。
- `packages/connect/test/feishu.test.mjs`：按钮网格、标签对齐、文件名清洗、错误提取。
- `packages/connect/test/telegram.test.mjs`：HTML 转义、@提及判断、offset 确认语义。
- `packages/connect/test/dingtalk.test.mjs`：签名校验、重试/限流、20000 字符截断。
- `packages/connect/test/web.test.mjs`：镜像记录、无合成消息回归测试。
- `packages/connect/test/settings-*.test.mjs`、`rpc-client.test.mjs`、`credential-store.test.mjs`、`apply.test.mjs`、`web-settings-*.test.mjs`、`channels.test.mjs`、`channel-runtime.test.mjs`、`settings-namespace.test.mjs`：多合一配置 + Web 设置栈（通道激活、宿主 RPC、设置持久化、凭据库、namespace 注册、round-trip）。
- `packages/connect/test/runner.test.mjs` + `agent-scope.test.mjs`：桥接的核心回合路径——会话日志与流式事件处理，以及智能体预设解析（含降级路径：过期 id 会恢复；健康解析仍然只挂载配置的那个预设且不产生日志）。
- 0.9.0 新增的三道设置面板防线：
  - `secret-disclosure.test.mjs` 钉住脱敏策略（完整显示 / 头尾 / URL 感知、超短值、未列出的键）。
  - `locale.test.mjs` 断言 `zh` 与 `en` 覆盖**完全一致**的键集合——宿主在缺键时会静默回退到 `en`，这正是中文页面一半变英文却不报任何错的原因。
  - `client-bundle.test.mjs` 通过 stub 的 `window.__ModuleLoader__` 加载**构建产物** `client/client.js`，在 Node 里真实渲染面板，并断言输入框的 `type` 与共享的脱敏表一致、每个字段的标签与说明都进了 DOM、且掩码（以及已保存密钥）永远不会被放进输入框。源码改动后不重建产物同样会失败。卡片的折叠规则另由纯模块 `panel-state.test.mjs` 单独钉住。
- `packages/connect/test/e2e-bridge.mjs`：入站消息 → 智能体回合 → 出站回复，既对脚本化的智能体离线断言，也对活跃的 `dsh` 宿主断言。真机那一部分会自我闸门，没有启动器时打印 `E2E SKIP`，因此它不可能靠「什么都没做」通过。

## 文档

- [飞书开放平台配置](docs/feishu-setup.zh.md)
- [Telegram 配置](docs/telegram-setup.zh.md) · [钉钉配置](docs/dingtalk-setup.zh.md)
- [分步运行指南](docs/QUICKSTART.zh.md)
- [完整选项参考](docs/config-reference.md)
- [命名与 GitHub/npm 可发现性](docs/PUBLISHING.zh.md)
- [配置示例](examples/profile-cordis.patch.yml)

## 许可证

MIT
