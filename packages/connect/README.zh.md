# dsh-connect

[English](README.md) | 中文

**多合一插件**，将 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（**DSH**）智能体连接到聊天平台（飞书 / Lark、Telegram、钉钉，以及 Web 镜像，更多平台陆续到来）：会话绑定、智能体驱动、流式回复桥接、交互式菜单卡片、本地命令，以及 Web 设置栈。

> 一次安装、一份配置：核心 `connect` 服务、全部通道适配器（feishu / telegram / dingtalk / web）以及 Web 设置栈都内置在这个包里。通过 `channels` 选择器启用你要用的通道。此前的拆分包（`dsh-connect-feishu`、`dsh-connect-telegram`、`dsh-connect-dingtalk`、`dsh-connect-web`）与 `dsh-connect-all` 合集已不存在。

## 概述

`dsh-connect` 将聊天会话绑定到 DSH 智能体会话并端到端驱动它：

- **会话绑定与路由** —— 一个聊天 ⇄ 一个智能体会话，持久化保存在 `bindings.json` 路由存储中；会话可以创建、恢复、切换、清除，并镜像到 DSH Web GUI。
- **流式回复** —— 模型的实时增量被桥接到渠道的原生流式能力（飞书打字机卡片）：思考提示开启推理阶段，推理内容带可读的段落分隔实时流出，工具调用显示为 `🔧` 进度行，心跳保活机制即使在长时间静默时（首个 token 等待过长、密集工具运行）也会让卡片保持更新，绝不会一直卡在「思考中…」。runner 保持两路订阅，因为 `0.1.5-rc.2` 把原本合二为一的东西拆开了：持久的 `session/event` 流承载回合、工具与结算，瞬时的 `agent/assistant-stream` 帧承载模型增量 —— 过去同时承载两者的 `assistant/chunk` 会话事件已被删除。
- **通知级别** —— 按聊天控制过程流式的详细程度：`尽量输出过程`（完整过程）/ `输出重要节点`（关键节点）/ `只输出结果`（仅结果）。可随时通过设置菜单或 `/notify` 切换；选择按聊天持久化并立即生效。
- **任务结束统计** —— 每个任务结束后，一张紧凑卡片报告所用模型、输入/输出 token、耗时与上下文窗口占用，并在上下文接近占满时建议 `/compact`。
- **交互式菜单** —— 状态、任务、历史、目标、日程、模型/努力度切换、工作区选择、语言等按钮卡片（参见聊天内的 `/` 命令）。
- **媒体处理** —— 下载用户图片/附件，并将其交给支持视觉的模型（或已配置的视觉模型），使纯文本主模型不会因图片而卡住。
- **锁与队列** —— 按聊天的写锁协调飞书与 Web 的写入方；锁释放后排队消息自动处理。
- **Web 镜像（自动）** —— 每个飞书会话都会自动作为镜像会话出现在 DSH Web GUI 中（可通过 `autoMirror: false` 关闭）。

**适用人群** —— 任何运行 DSH 并希望从聊天平台操作智能体的人：为自己工作区运行机器人的个人用户，以及通过白名单在群聊中共享机器人的小团队。

## 兼容性

| 方面 | 值 |
|---|---|
| DSH 版本 | `^0.1.5-rc.2`（peer `@deepseek-ai/dsh-agent`、`dsh-llm`、`dsh-session`） |
| Cordis | `^4.0.1` |
| Node.js | ≥ 20（ESM，`NodeNext`） |
| 最后验证 | **2026-09-21**，在 Windows 上针对 DSH `0.1.5-rc.2` 验证（宿主加载、飞书 WebSocket 传输、Web 设置面板） |

**peer 版本线必须与宿主保持同步。** 上游不提供 changelog 或迁移说明，因此过期的版本范围是插件与静默损坏之间唯一的屏障：DSH `0.1.5-rc.2` 直接删除了 `Session.events` 访问器和 `assistant/chunk` 事件类型，而所有 `dsh-*` 包共用同一条版本线。升级 DSH 时，请把 `dsh-agent`、`dsh-llm`、`dsh-session` 的 `peerDependencies`（以及 `devDependencies`）**一起**上调，重新运行 `tsc`，并重跑测试套件 —— 当版本范围与宿主版本不再有交集时，就是桥接需要再次迁移的信号。

插件运行在 DSH **Host 平面**（进程级单例服务）上，而不是在智能体预设内部。

## 安装 / 卸载

插件管理是 DSH profile 中对 pnpm 的轻量封装：

```sh
# 安装唯一的多合一插件（核心 + 全部通道适配器 + Web 设置）
dsh plugin --profile web add dsh-connect
```

**升级**

```sh
dsh plugin --profile web update dsh-connect
```

**禁用** —— 在 profile patch 中将 bundle 注册的条目覆盖为 `disabled: true`（参见 `~/.dsh/profiles/<profile>/cordis.patch.yml`）：

```yaml
- id: connect
  name: dsh-connect
  disabled: true
```

**彻底移除** —— 卸载软件包并删除它产生的数据：

```sh
dsh plugin --profile web remove dsh-connect
# then remove the plugin data (see "Permissions & data" below):
rm -rf .dsh-connect            # binding route store (stateDir)
rm -f ~/.dsh/.dsh-connect/feishu-credentials.json
```

## 快速开始

1. **安装插件**（见上文）。
2. **添加最小配置**到 `~/.dsh/profiles/<profile>/cordis.patch.yml` —— 配置形状见 [`examples/minimal.config.json`](examples/minimal.config.json)，带完整注释的版本是仓库里的 [`examples/profile-cordis.patch.yml`](https://github.com/IvanWu2015/dsh-connect/blob/main/examples/profile-cordis.patch.yml)（该路径不在发布产物内，故用绝对链接）。该插件会通过其 bundle 清单自动注册，因此这里只需要**覆盖（override）**它的配置——**不要**再用 `insert` 重新插入（重复的 `id` 会让 dsh 启动失败）：

   ```yaml
   - id: connect
     name: dsh-connect
     # workDir: D:\your\workdir     # agent working directory (default: process cwd)
     config:
       channels: [feishu]             # 启用哪些通道；省略 = 全部内置
       # channelDefaults: { language: zh }   # 应用到未单独设置该键的每个通道
       feishu:
         appId: cli_xxxx
         appSecret: cli_secret_xxxx
         transport: websocket
         requireMention: true
         dmMode: open
   ```

3. **启动宿主** —— `dsh web`（或 `dsh run`）。未配置凭据时，`feishu` 通道会进入**一键开通**流程：扫描日志中的二维码 / 打开链接以授权机器人。
4. **在飞书中给机器人发一条消息**。机器人以流式卡片回复；`/help` 列出所有命令；会话也会自动出现在 DSH Web GUI 中（自动镜像）。

一个完全可复现的示例是 [`examples/`](examples/) 文件夹加上仓库里的[飞书配置手册](https://github.com/IvanWu2015/dsh-connect/blob/main/docs/feishu-setup.zh.md)（飞书应用创建、事件订阅、发布）。

## 对话中的提问与授权

智能体需要你拍板时会停下来问你，这些问答直接出现在飞书里，不用切到 Web GUI：

- **带选项的问题** —— 渲染成一张卡片，一个选项一个按钮，点一下即作答，卡片随即切到下一问。
- **不带选项的问题** —— 没有按钮可用，机器人把问题当提示发出来，你**直接在聊天里回一条消息**即可，这条消息就是答案。
- **工具授权**（需要你点头才能执行的操作）—— 同样是一张卡片，按钮是**允许一次** / **拒绝**。这类请求**只认按钮**：等待授权时发来的普通聊天消息不会被当成授权结果。

同一时刻一个聊天只有一张待答卡片。第二个请求会交还给宿主自己的处理路径（即 Web GUI），既不跟第一张抢同一条消息，也不会被丢掉；卡片投递失败、或请求在你作答前被取消，同样如此，并且会**释放该聊天**——否则你接下来那条消息会被静默吞掉。

看到「此操作已失效」说明这张卡片已经过期（空闲 60 秒后自动关闭），重新发起一次即可。连点两下、或上一问刚答完时紧接着落下的那一下，属于卡片重绘的窗口，会被静默忽略，**不会**误报失效。

## 配置

配置位于 DSH profile patch（`cordis.patch.yml`）中该插件的 `config:` 下。项目根目录（或其父目录）中的 `dsh.shared.config.json` 可以提供工作区/状态默认值，并对这些键具有更高优先级。

### `dsh-connect`（核心）

| 键 | 默认值 | 说明 |
|---|---|---|
| `agentPreset` | roster default | 组合进每个绑定会话的智能体预设 id。解析是尽力而为的：先试配置的 id，再试 `standard`（或 roster 中第一个可挂载项）；两者都组合不出来时，智能体不带预设构建，回合照常运行。因此一个过期的 id 只会降级并留下日志，而不会让每条消息都失败。 |
| `workDir` | process cwd | 每个绑定智能体的绝对工作目录 |
| `workspaces` | `[]` | `/dir` 选择器提供的额外工作区 |
| `visionModel` | auto-detected | 当主模型无法查看图片时，用于描述图片的 `{ provider, model }` |
| `language` | `zh` | 面向用户的消息语言：`zh` / `en` |
| `allowUsers` | `[]` | 发送者白名单（open_id）。空 = 允许所有人 |
| `allowChats` | `[]` | 聊天白名单（chat_id）。空 = 允许所有会话 |
| `stateDir` | `.dsh-connect` | 保存 `bindings.json` 路由存储的目录（环境变量 `DSH_CONNECT_STATE_DIR` 可覆盖） |
| `autoMirror` | `true` | 为每个新会话自动创建 Web GUI 镜像 |
| `streamHeartbeatMs` | `60000` | 流式卡片的心跳保活间隔（毫秒）；`0` 表示禁用 |
| `notifyLevel` | `result` | 默认通知级别：`full`（全部流式输出）/ `important`（关键节点）/ `result`（仅结果，默认）；可通过设置菜单或 `/notify` 按聊天覆盖 |
| `progressTimeoutMs` | `300000` | 主动进度通知间隔（毫秒）：当一轮对话在此时间内没有发送独立卡片/文本时，状态卡片会报告最新节点；`0` 表示禁用；可通过设置菜单或 `/progress` 按聊天覆盖 |

### 公共（所有通道）

| 键 | 默认值 | 说明 |
|---|---|---|
| `channels` | 全部内置 | 启用哪些通道：`feishu` / `telegram` / `dingtalk` / `web`。省略则启用全部内置通道。 |
| `channelDefaults` | `{}` | 应用到未单独设置该键的每个通道（如 `{ language: "zh" }`）。 |
| `settingsStatePath` | `<stateDir>/dsh-connect-settings.json` | Web 设置面板镜像非密钥配置的路径。默认落在 `stateDir` **之内**的 `dsh-connect-settings.json`，与 `bindings.json` 同目录，二者不会各说各话；设置该键可覆盖。自 0.9.0 起，面板的权威数据源是 `$DSH_HOME/settings.yaml` 里的 `dsh-connect` 段（见[用户设置](#用户设置)），本文件只是旧版 `/dsh-connect` RPC 读写的兼容镜像。 |

### `feishu`（飞书 / Lark 通道）

| 键 | 默认值 | 说明 |
|---|---|---|
| `appId` | env `FEISHU_APP_ID` | 飞书自建应用 id（**机密**） |
| `appSecret` | env `FEISHU_APP_SECRET` | 飞书自建应用密钥（**机密**） |
| `transport` | `websocket` | `websocket` = 长连接（无需公网）；`webhook` 需要公网 HTTPS |
| `verificationToken` | — | Webhook 验证令牌（**机密**） |
| `encryptKey` | — | Webhook 加密密钥（**机密**） |
| `webhookPort` | `9000` | `transport: "webhook"` 时内置 webhook 服务的 HTTP 端口 |
| `webhookPath` | `/` | 飞书事件回调所 POST 的 URL 路径（webhook 传输） |
| `requireMention` | `true` | 群聊中仅在 @机器人 时才会响应 |
| `dmMode` | `open` | 私聊策略：`open` / `allowlist` / `pair` / `disabled` |
| `language` | `zh` | 面向用户的消息语言：`zh` / `en` |

**环境变量**

| 变量 | 用途 |
|---|---|
| `FEISHU_APP_ID` / `FEISHU_APP_SECRET` | 飞书凭据 —— 优于把机密写进配置文件 |
| `DSH_CONNECT_STATE_DIR` | 覆盖绑定存储的 `stateDir` |
| `DSH_HOME` | 覆盖凭据文件所在的 `~/.dsh` 基目录 |

**敏感项** —— `appSecret`、`verificationToken`、`encryptKey` 和 `feishu-credentials.json`。优先使用环境变量或一键开通；切勿将它们提交到版本控制。

### `telegram`（Telegram 通道）

| 键 | 默认值 | 说明 |
|---|---|---|
| `botToken` | 环境变量 `TELEGRAM_BOT_TOKEN` | 来自 @BotFather 的机器人 token（**机密**） |
| `requireMention` | `true` | 群聊仅在 @提及机器人（或回复机器人自己发的消息）时响应 |
| `pollingTimeoutSeconds` | `50` | `getUpdates` 长轮询超时（秒） |
| `baseUrl` | — | 可选：Bot API 基地址覆盖（如本地 Bot API 服务器） |
| `language` | `zh` | 面向用户的消息语言：`zh` / `en` |

### `dingtalk`（钉钉通道）

| 键 | 默认值 | 说明 |
|---|---|---|
| `webhookUrl` | 环境变量 `DINGTALK_WEBHOOK_URL` | 群自定义机器人 webhook（主动推送） |
| `secret` | 环境变量 `DINGTALK_WEBHOOK_SECRET` | 仅启用加签时的 `SEC…` 密钥 |
| `stream.clientId` / `stream.clientSecret` | 环境变量 `DINGTALK_STREAM_CLIENT_ID` / `DINGTALK_STREAM_CLIENT_SECRET` | 双向 stream 模式应用凭据（**机密**，嵌套在 `stream` 下） |
| `stream.requireMention` | `true` | 群回复需要 @提及（stream 模式） |
| `defaultAt` | — | 每次推送默认合并的 @列表（`{ mobiles, userIds, all }`） |
| `language` | `zh` | 面向用户的消息语言：`zh` / `en` |

### `web`（Web 镜像通道）

| 键 | 默认值 | 说明 |
|---|---|---|
| `pollIntervalMs` | `1000` | 镜像会话轮询间隔（毫秒） |

环境变量（`FEISHU_*`、`TELEGRAM_*`、`DINGTALK_*`、`DSH_CONNECT_STATE_DIR`、`DSH_HOME`）与 DSH 凭据库是提供各通道密钥的推荐方式——Web 设置面板把密钥写入凭据库，加载时由 `injectSecrets` 注入。

## 权限与数据

- **写入的文件**
  - `<stateDir>/bindings.json`（默认 `.dsh-connect/`）—— 聊天 ⇄ 会话路由存储（聊天键、会话 id、镜像与锁状态）。
  - `<stateDir>/dsh-connect-settings.json`（默认 `.dsh-connect/`）—— 非密钥配置的兼容镜像，见 `settingsStatePath`。
  - `$DSH_HOME/settings.yaml` 的 `dsh-connect` 段 —— 经由 DSH 第一方设置机制写入，原子、加锁、保留注释。
  - `~/.dsh/.dsh-connect/feishu-credentials.json` —— **旧版、只读**。一键开通过去把飞书凭据存在这里而不是凭据库，导致刚扫码授权完的用户永远看到「未配置凭据」。现在开通流程写入凭据库，已有安装会在启动时从这个文件回填一次；此后不再读写它。
  - `<workDir>/.dsh-connect-images/` —— 为用户图片/附件暂存，供智能体工具使用。
  - DSH 自身在 `~/.dsh/` 下的会话日志与设置（sessions、settings 等）。
- **网络**
  - 飞书开放平台：WebSocket 长连接（或通过公网 HTTPS 的 webhook），以及 HTTPS API 调用（媒体下载、卡片）。
  - DSH 为智能体模型调用的 LLM 提供商 API（如 DeepSeek），以及可选的视觉模型。
- **用户数据** —— 消息文本与附件经由机器人流向智能体会话；它们与任何 DSH 会话一样保存在 DSH 会话日志中。白名单（`allowUsers` / `allowChats`）限制了可以驱动机器人的人。

## 设置面板

`dsh-connect` 在 **设置 → dsh-connect** 下有自己的页面。它是一条渠道页签条 + 若干可折叠卡片：
每张卡片由一个按钮做标题行，低频字段收在第二级的**高级选项**折叠里，保存/状态固定在滚动区底部。

| 渠道与凭据 | 展开高级选项 |
|---|---|
| ![dsh-connect 设置面板：渠道页签条、展开的飞书卡片及其凭据字段，以及三张收起后仍显示凭据徽标的渠道卡片](docs/images/settings-overview-zh.png) | ![同一面板展开某渠道的「高级选项」折叠，露出回调端口与回调路径字段](docs/images/settings-advanced-zh.png) |

![面板底部的公共默认卡片与固定保存条](docs/images/settings-defaults-zh.png)

英文截图：[概览](docs/images/settings-overview-en.png) · [高级](docs/images/settings-advanced-en.png) · [公共默认](docs/images/settings-defaults-en.png)。

> 截图取自一个凭据全是占位符的一次性 profile。上面没有任何真实密钥 —— 也不可能有：宿主会在
> 值到达浏览器之前完成打码（见下文[面板回显与脱敏](#面板回显与脱敏)）。

卡片默认展开你已启用的渠道（一个都没启用时展开第一个）。点击页签会展开对应卡片并滚进视野，
**不会**收起其他卡片 —— 多张同时展开是合法状态。收起是**卸载**卡片主体而不是隐藏它，这之所
以安全，是因为你刚输入但尚未保存的密钥存在面板自身的 state 里，而不在卡片里。勾选某渠道的
启用框同样会展开它。

## 用户设置

Web 设置面板（**设置** 下的 `dsh-connect`）编辑的是 `$DSH_HOME/settings.yaml` 里的
`dsh-connect` 段，走 DSH 自带的（第一方）设置机制。该文档支持热重载、在文件锁下原子写入、
并保留你的注释——所以手工编辑它同样有效，改动无需重启即可生效。

取值分三层解析，越靠后越具体：

1. 插件内置的 schema 默认值；
2. 插件自己的 `cordis.patch.yml` 条目（你现有的配置**不会**被丢弃，它注册为基础层）；
3. `settings.yaml` 中的 `dsh-connect` 段。

**密钥永远不会写入 `settings.yaml`。** 那是一份普通的、鼓励用户贴进 issue 的文档；凭据
一律保存在 DSH 凭据库（`ctx.credentials`）——一键开通流程与 `FEISHU_*` 这类环境变量也
正是写在那里。

旧版 `/dsh-connect` HTTP RPC 为面板兼容而保留；它现在读写同一个 namespace，并把非密钥配置
镜像到 `settingsStatePath`（见[公共（所有通道）](#公共所有通道)），以兼容旧面板。

### 面板回显与脱敏

每个已保存的密钥字段下方都有一行**只读**的「当前值：…」（没有值时显示「未配置」），这样你
不用重新输入就能确认自己填了什么。**打码在宿主侧完成**，只有一张共用的策略表
（`src/settings/secret-disclosure.ts`）——宿主按它打码，面板按它决定输入框渲染成
`password` 还是 `text`，两边因此不可能各说各话。

| 字段 | 显示方式 |
|---|---|
| `appId`、`clientId` | **完整显示**。它们是标识符而不是口令：每次出站 API 调用都会带上，厂家控制台也明文可见，遮住并不能保护什么。 |
| `appSecret`、`clientSecret`、`botToken`、`secret` | 只留头尾，例如 `a1b2…z9y8`。太短、露头露尾就等于全露的值，改为固定长度的 `••••••`。 |
| `webhookUrl`（钉钉） | **URL 感知**。保留域名、路径与参数名，只对令牌的中段打码——钉钉把令牌放在查询串里，整串打码（`https…bcde`）等于什么也确认不了。 |
| 其他 / 未列出的键 | 一律按最保守的方式打码。 |

有两条性质无论如何都成立：

- **可用密钥不会跨线。** 值在离开宿主前就已打码，所以浏览器标签页（以及它的截图）永远拿不到
  一个可用的密钥。
- **掩码不可能被写回。** 预览是输入框**旁边**的文本，不是输入框的 `value`。输入框始终为空，
  而「空」的含义是「不动已保存的值」——因此只保存配置时，一个凭据都不会被写入。

面板自身的全部文案（通道名、字段标签、选项文字、状态）都来自 `client/locale.mjs`，其中同时
提供 `zh` 与 `en`。有测试断言两种语言的键集合完全一致——宿主在缺键时会静默回退到另一种语言，
所以漏译不会报错，只会让页面变成中英混杂。

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

## 故障排查

日志来自 DSH 宿主日志器（在终端运行 `dsh web`）；插件消息带有 `connect:` / `connect-feishu:` 前缀。

| 症状 | 可能原因 / 修复 |
|---|---|
| `connect-feishu: adapter init failed` / `start failed` | 凭据错误、应用未发布或网络被阻断。检查 `appId`/`appSecret`，重新运行开通流程，确认机器人在飞书开放平台后台处于在线状态。 |
| `connect: resume of <id> failed, creating fresh session` | 持久化会话无法恢复（工作目录缺失、持久化问题）。检查 `workDir` 和 `~/.dsh/sessions`。 |
| 机器人对每条消息都回一行原始的 `agent-presets: preset "…" not found`，内容到不了智能体 | `$DSH_HOME/settings.yaml` 里的 `agent-presets.default` 指向了任何已安装版本都不提供的 id。**0.9.0** 已修复：改为重试 `standard` 并记录决策，而不是让这一轮失败；在更旧的版本上，请把该键改成一个确实存在的 id（`standard`）。 |
| 会话锁定提示 | 另一个客户端（飞书或 Web）持有写锁。使用 `/unlock` 或等待锁超时。 |
| Web GUI 中的模型切换似乎被忽略 | 已在 **0.9.0** 修复：插件不再用静态默认模型覆盖 Web GUI 的会话选择。升级后重启 `dsh web`。 |
| `[用户发送了图片，但下载失败…]` | 应用缺少飞书 `im:resource` 权限；授予该权限并重新授权。 |
| 流式回复是一整块没有分段 | 已在 **0.9.0** 修复：块边界与推理/回答分隔现在会插入空行（推理软换行已针对飞书卡片扩展）。升级后重启 `dsh web`。 |
| 长时间任务中卡片卡在「思考中…」没有进展 | 已在 **0.9.0** 修复：推理现在实时流出，工具调用显示为 `🔧` 进度行，静默期间心跳保活会更新卡片。升级后重启 `dsh web`。 |
| 智能体给出选项 / 请求工具授权，飞书里却什么都没有 | 已在 **0.9.0** 修复：桥接此前订阅了一个宿主上并不存在的服务，问题只会静默落回宿主。升级后重启 `dsh web`。 |
| 点击卡片按钮提示「此操作已失效」，但卡片明明是刚发出来的 | 已在 **0.9.0** 修复：卡片重绘期间（连点两下、上一问刚答完）落下的点击被误判为过期操作。升级后重启 `dsh web`。 |
| 菜单卡片不更新 / 过期 | 设计如此：卡片空闲 60 秒后自动关闭；重新打开菜单即可。提问与授权卡片同理——详见[对话中的提问与授权](#对话中的提问与授权)。 |

**回滚** —— 重新安装之前的版本（先移除当前版本，再执行 `dsh plugin --profile web add dsh-connect@<version>`），或在源码安装中 `git checkout` 到固定的提交。

## 开发

这是一个 pnpm workspace；`dsh-connect` 是 `packages/` 下的**唯一**包：

```
packages/
  connect/          # 本包 — 多合一插件
    src/            # 核心：runner、service、binding、commands、menus、chat key …
    src/channels/   # 通道适配器：feishu / telegram / dingtalk / web
    src/settings/   # Web 设置栈：宿主 RPC、凭据库、脱敏策略
    client/         # Web 设置前端插件 + 其纯函数模块（locale、panel-state）
    test/           # node:test 套件（run-all.mjs 导入每个套件）
    docs/images/    # 本 README 引用的截图
    examples/       # minimal.config.json
```

```sh
pnpm install

# build & typecheck the package
pnpm --filter dsh-connect build
pnpm --filter dsh-connect typecheck

# unit tests (node:test) — run-all.mjs 进程内导入每个套件
pnpm test
# or run one suite
node packages/connect/test/unit.test.mjs
```

**结构** —— `src/runner.ts` 负责每个聊天的智能体驱动与流式桥接（`applyStreamChunk` 是纯函数、有单元测试的块组装器）；`src/service.ts` 负责适配器注册表与路由；`src/channels/` 存放 feishu / telegram / dingtalk / web 通道适配器；`src/settings/` 存放 Web 设置栈（宿主 RPC、凭据库、脱敏策略）；`src/binding.ts` 是路由存储。

有两样东西原来是放在 `src/` 的，现在移到了 `client/`，为的是能在不引入 React 的情况下单测：**`client/locale.mjs`** 存放设置面板的全部用户可见文案（`zh` 与 `en`，两边键集合必须一致 —— 宿主在缺键时会静默渲染**另一种**语言，所以漏译表现为中英混杂，而不是报错），**`client/panel-state.mjs`** 存放卡片的展开/高级折叠规则。两者都是零依赖的纯 ESM，分别由 `test/locale.test.mjs` 与 `test/panel-state.test.mjs` 直接断言。

**贡献** —— 欢迎在 [github.com/IvanWu2015/dsh-connect](https://github.com/IvanWu2015/dsh-connect) 提交 PR。对于面向用户的面板文案，请在 `client/locale.mjs` 中同时为 `zh` 和 `en` 添加键，然后重建产物（`node scripts/build-client.mjs`）—— `test/client-bundle.test.mjs` 跑的是**构建产物**，产物过期会直接失败。发布说明在 `CHANGELOG.md` 中；发布流程参见 [`docs/PUBLISHING.zh.md`](https://github.com/IvanWu2015/dsh-connect/blob/main/docs/PUBLISHING.zh.md)。

## 许可与安全

- **许可：** MIT（见 `LICENSE`）。
- **安全：** 请**私下**报告漏洞 —— 使用仓库的 GitHub security advisory 流程，或通过 GitHub 主页上列出的邮箱联系维护者。请不要为凭据泄露创建公开 issue。请将 `appSecret` / `verificationToken` / `encryptKey` / `feishu-credentials.json` 视为机密：优先使用环境变量，切勿提交到版本控制。
