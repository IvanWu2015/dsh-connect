# dsh-connect

[English](README.md) | 中文

**与渠道无关的核心**，用于将 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（**DSH**）智能体连接到聊天平台（飞书 / Lark、Telegram、钉钉，更多平台陆续到来）：会话绑定、智能体驱动、流式回复桥接、交互式菜单卡片与本地命令。

> 请与渠道适配器一起安装——例如 [dsh-connect-feishu](https://www.npmjs.com/package/dsh-connect-feishu)、[dsh-connect-telegram](https://www.npmjs.com/package/dsh-connect-telegram) 或仅推送的 [dsh-connect-dingtalk](https://www.npmjs.com/package/dsh-connect-dingtalk)——或可选的 [dsh-connect-web](https://www.npmjs.com/package/dsh-connect-web) 镜像监视器。

## 概述

`dsh-connect` 将聊天会话绑定到 DSH 智能体会话并端到端驱动它：

- **会话绑定与路由** —— 一个聊天 ⇄ 一个智能体会话，持久化保存在 `bindings.json` 路由存储中；会话可以创建、恢复、切换、清除，并镜像到 DSH Web GUI。
- **流式回复** —— DSH 的 `assistant/chunk` 事件被桥接到渠道的原生流式能力（飞书打字机卡片）：思考提示开启推理阶段，推理内容带可读的段落分隔实时流出，工具调用显示为 `🔧` 进度行，心跳保活机制即使在长时间静默时（首个 token 等待过长、密集工具运行）也会让卡片保持更新，绝不会一直卡在「思考中…」。
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
| DSH 版本 | `^0.1.0-rc.6`（peer `@deepseek-ai/dsh-agent`、`dsh-llm`、`dsh-session`） |
| Cordis | `^4.0.1` |
| Node.js | ≥ 20（ESM，`NodeNext`） |
| 最后验证 | **2026-08-16**，在 Windows（飞书 WebSocket 传输）上针对 DSH `0.1.0-rc.6` 验证 |

插件运行在 DSH **Host 平面**（进程级单例服务）上，而不是在智能体预设内部。

## 安装 / 卸载

插件管理是 DSH profile 中对 pnpm 的轻量封装：

```sh
# Install (core + Feishu adapter)
dsh plugin --profile web add dsh-connect dsh-connect-feishu

# Optional: Web mirror monitor
dsh plugin --profile web add dsh-connect-web
```

**升级**

```sh
dsh plugin --profile web update dsh-connect dsh-connect-feishu
```

**禁用** —— 从 profile patch 中删除相应条目，插件即停止加载（参见 `~/.dsh/profiles/<profile>/cordis.patch.yml`）：

```yaml
- insert:
    - id: connect        # delete this block (and connect-feishu) to disable
      name: dsh-connect
```

**彻底移除** —— 卸载软件包并删除它们产生的数据：

```sh
dsh plugin --profile web remove dsh-connect dsh-connect-feishu
# then remove the plugin data (see "Permissions & data" below):
rm -rf .dsh-connect            # binding route store (stateDir)
rm -f ~/.dsh/.dsh-connect/feishu-credentials.json
```

## 快速开始

1. **安装插件**（见上文）。
2. **添加最小配置**到 `~/.dsh/profiles/<profile>/cordis.patch.yml`（另见 [`examples/profile-cordis.patch.yml`](../../examples/profile-cordis.patch.yml)）：

   ```yaml
   - insert:
       - id: connect
         name: dsh-connect
         # workDir: D:\your\workdir     # agent working directory (default: process cwd)
       - id: connect-feishu
         name: dsh-connect-feishu
         config:
           appId: cli_xxxx
           appSecret: cli_secret_xxxx
           transport: websocket
           requireMention: true
           dmMode: open
   ```

3. **启动宿主** —— `dsh web`（或 `dsh run`）。未配置凭据时，`dsh-connect-feishu` 会进入**一键开通**流程：扫描日志中的二维码 / 打开链接以授权机器人。
4. **在飞书中给机器人发一条消息**。机器人以流式卡片回复；`/help` 列出所有命令；会话也会自动出现在 DSH Web GUI 中（自动镜像）。

一个完全可复现的示例是 `examples/` 文件夹加上 `docs/feishu-setup.zh.md`（飞书应用创建、事件订阅、发布）。

## 配置

配置位于 DSH profile patch（`cordis.patch.yml`）中每个插件的 `config:` 下。项目根目录（或其父目录）中的 `dsh.shared.config.json` 可以提供工作区/状态默认值，并对这些键具有更高优先级。

### `dsh-connect`（核心）

| 键 | 默认值 | 说明 |
|---|---|---|
| `agentPreset` | roster default | 组合进每个绑定会话的智能体预设 id |
| `workDir` | process cwd | 每个绑定智能体的绝对工作目录 |
| `workspaces` | `[]` | `/dir` 选择器提供的额外工作目录 |
| `visionModel` | auto-detected | 当主模型无法查看图片时，用于描述图片的 `{ provider, model }` |
| `language` | `zh` | 面向用户的消息语言：`zh` / `en` |
| `allowUsers` | `[]` | 发送者白名单（open_id）。空 = 允许所有人 |
| `allowChats` | `[]` | 聊天白名单（chat_id）。空 = 允许所有会话 |
| `stateDir` | `.dsh-connect` | 保存 `bindings.json` 路由存储的目录（环境变量 `DSH_CONNECT_STATE_DIR` 可覆盖） |
| `autoMirror` | `true` | 为每个新会话自动创建 Web GUI 镜像 |
| `streamHeartbeatMs` | `60000` | 流式卡片的心跳保活间隔（毫秒）；`0` 表示禁用 |
| `notifyLevel` | `important` | 默认通知级别：`full`（全部流式输出）/ `important`（关键节点）/ `result`（仅结果）；可通过设置菜单或 `/notify` 按聊天覆盖 |
| `progressTimeoutMs` | `300000` | 主动进度通知间隔（毫秒）：当一轮对话在此时间内没有发送独立卡片/文本时，状态卡片会报告最新节点；`0` 表示禁用；可通过设置菜单或 `/progress` 按聊天覆盖 |

### `dsh-connect-feishu`（适配器）

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

## 权限与数据

- **写入的文件**
  - `<stateDir>/bindings.json`（默认 `.dsh-connect/`）—— 聊天 ⇄ 会话路由存储（聊天键、会话 id、镜像与锁状态）。
  - `~/.dsh/.dsh-connect/feishu-credentials.json` —— 一键开通时保存的飞书凭据。
  - `<workDir>/.dsh-connect-images/` —— 为用户图片/附件暂存，供智能体工具使用。
  - DSH 自身在 `~/.dsh/` 下的会话日志与设置（sessions、settings 等）。
- **网络**
  - 飞书开放平台：WebSocket 长连接（或通过公网 HTTPS 的 webhook），以及 HTTPS API 调用（媒体下载、卡片）。
  - DSH 为智能体模型调用的 LLM 提供商 API（如 DeepSeek），以及可选的视觉模型。
- **用户数据** —— 消息文本与附件经由机器人流向智能体会话；它们与任何 DSH 会话一样保存在 DSH 会话日志中。白名单（`allowUsers` / `allowChats`）限制了可以驱动机器人的人。

## 故障排查

日志来自 DSH 宿主日志器（在终端运行 `dsh web`）；插件消息带有 `connect:` / `connect-feishu:` 前缀。

| 症状 | 可能原因 / 修复 |
|---|---|
| `connect-feishu: adapter init failed` / `start failed` | 凭据错误、应用未发布或网络被阻断。检查 `appId`/`appSecret`，重新运行开通流程，确认机器人在飞书开放平台后台处于在线状态。 |
| `connect: resume of <id> failed, creating fresh session` | 持久化会话无法恢复（工作目录缺失、持久化问题）。检查 `workDir` 和 `~/.dsh/sessions`。 |
| 会话锁定提示 | 另一个客户端（飞书或 Web）持有写锁。使用 `/unlock` 或等待锁超时。 |
| Web GUI 中的模型切换似乎被忽略 | 已在当前 main 中修复：插件不再用静态默认模型覆盖 Web GUI 的会话选择。重启 `dsh web` 以加载重建后的插件。 |
| `[用户发送了图片，但下载失败…]` | 应用缺少飞书 `im:resource` 权限；授予该权限并重新授权。 |
| 流式回复是一整块没有分段 | 已在当前 main 中修复：块边界与推理/回答分隔现在会插入空行（推理软换行已针对飞书卡片扩展）。重启 `dsh web`。 |
| 长时间任务中卡片卡在「思考中…」没有进展 | 已在当前 main 中修复：推理现在实时流出，工具调用显示为 `🔧` 进度行，静默期间心跳保活会更新卡片。重启 `dsh web`。 |
| 菜单卡片不更新 / 过期 | 设计如此：卡片空闲 60 秒后自动关闭；重新打开菜单即可。 |

**回滚** —— 重新安装之前的版本（先移除当前版本，再执行 `dsh plugin --profile web add dsh-connect@<version>`），或在源码安装中 `git checkout` 到固定的提交。

## 开发

这是一个 pnpm workspace；插件是 `packages/` 下相互独立的 npm 包：

```
packages/
  connect/          # 本包 — 与渠道无关的核心
  connect-feishu/   # 飞书 / Lark 适配器
  connect-telegram/ # Telegram 适配器（getUpdates 长轮询）
  connect-dingtalk/ # 钉钉群机器人 Webhook 推送渠道
  connect-web/      # 可选的 Web 镜像监视器
```

```sh
pnpm install

# build & typecheck one package
pnpm --filter dsh-connect build
pnpm --filter dsh-connect typecheck

# unit tests (node:test)
pnpm test
# or run one suite
node packages/connect/test/unit.test.mjs
```

**结构** —— `src/runner.ts` 负责每个聊天的智能体驱动与流式桥接（`applyStreamChunk` 是纯函数、有单元测试的块组装器）；`src/service.ts` 负责适配器注册表与路由；`src/i18n.ts` 存放 `zh`/`en` 词典（两种语言的关键字需保持同步）；`src/binding.ts` 是路由存储。

**贡献** —— 欢迎在 [github.com/IvanWu2015/dsh-connect](https://github.com/IvanWu2015/dsh-connect) 提交 PR。对于面向用户的字符串，请在 `src/i18n.ts` 中同时为 `zh` 和 `en` 添加关键字。发布说明在 `CHANGELOG.md` 中；发布流程参见 `docs/PUBLISHING.zh.md`。

## 许可与安全

- **许可：** MIT（见 `LICENSE`）。
- **安全：** 请**私下**报告漏洞 —— 使用仓库的 GitHub security advisory 流程，或通过 GitHub 主页上列出的邮箱联系维护者。请不要为凭据泄露创建公开 issue。请将 `appSecret` / `verificationToken` / `encryptKey` / `feishu-credentials.json` 视为机密：优先使用环境变量，切勿提交到版本控制。
