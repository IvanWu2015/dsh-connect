# dsh-connect

[English](#) · 中文

把 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（**DSH**）的 Agent 接入聊天软件（**飞书/Lark 先行**，后续钉钉、企业微信等），实现**信息同步 + 工作安排**：在飞书里给 DSH 派任务、看它流式执行、多轮带上下文，任务结束主动推送结果卡片。

## 特性

- **双向信息同步**：飞书消息 → DSH Agent（`agent.followup`），Agent 回复流式回写飞书（打字机卡片）。
- **多轮上下文**：每个飞书会话（单聊/群）绑定一个 DSH `Session`，进程重启后自动 `resume`。
- **工作安排**：任务跑完主动推送「结果摘要」卡片；`ctx.connect.notify()` 供 goals/jobs 钩子主动推送进度。
- **安全**：群聊默认需 @机器人；用户/群白名单；飞书凭据走环境变量或加密配置。
- **命令**：本地指令（不消耗模型）：`/status` `/task` `/chat` `/dir` `/new` `/clear` `/stop` `/help`。
- **可扩展**：`dsh-connect`（核心，渠道无关）+ `dsh-connect-feishu`（飞书适配器）分层，新增钉钉只需再加一个适配器包。

## 仓库结构

```
packages/
  connect/         dsh-connect 核心层：服务、绑定、驱动、流式桥、命令
  connect-feishu/  dsh-connect-feishu 飞书适配器：createLarkChannel 长连接、归一化、流式回写
docs/
  QUICKSTART.md    分步运行指南（DSH 端 + 飞书端）
  feishu-setup.md  飞书开放平台配置手册
  PUBLISHING.md    命名 + GitHub/npm 可发现性指南
examples/
  profile-cordis.patch.yml
```

## 快速开始

### 安装

已发布到 npm，直接装进你的 DSH profile：

```sh
dsh plugin --profile web add dsh-connect dsh-connect-feishu
```

### 配置

在 profile 的 `cordis.patch.yml`（`$DSH_HOME/profiles/web/cordis.patch.yml`）里用 `insert` 追加（Host 平面）：

```yaml
- insert:
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
```

### 启动

重启 `dsh web`（Host 插件需重启进程才生效），按 [docs/feishu-setup.md](docs/feishu-setup.md) 完成飞书侧订阅后，即可在飞书里对话。

> 详细的分步操作（含飞书端设置与验证）见 [docs/QUICKSTART.md](docs/QUICKSTART.md)。

## 配置

### dsh-connect（核心）

| 键 | 默认 | 说明 |
|---|---|---|
| `agentPreset` | 未设置=roster 默认 | 每个绑定会话采用的 Agent 预设（如 `standard`） |
| `workDir` | DSH 第一个工作区 | Agent 工作目录（绝对路径，可显式指定） |
| `workspaces` | `[]` | `/dir` 交互式选择里列出的工作目录列表 |
| `allowUsers` | `[]` | 发送者白名单（空=全部放行） |
| `allowChats` | `[]` | 会话白名单（空=全部放行） |
| `stateDir` | `./.dsh-connect` | 绑定路由 `bindings.json` 存放目录 |

### dsh-connect-feishu（飞书）

| 键 | 默认 | 说明 |
|---|---|---|
| `appId` / `appSecret` | 环境变量 `FEISHU_APP_ID` / `FEISHU_APP_SECRET` | 应用凭据 |
| `transport` | `websocket` | 长连接（推荐）；`webhook` 需公网 HTTPS |
| `verificationToken` / `encryptKey` | 空 | 仅 webhook 模式需要 |
| `requireMention` | `true` | 群聊需 @机器人 才响应 |
| `dmMode` | `open` | 单聊策略：`open` 接收 / `closed` 忽略 |

## 原理

- **Agent 创建/恢复**：复用 DSH 官方驱动范式（见 `dsh-headless`）——`ctx.agents.create({ meta:{cwd, agentPreset}, agentOptions:{provider,model}, setup })`；恢复走 `ctx.agents.resume`。
- **预设挂载**：`setup` 里 `installModelSelection` + `ctx.agentPresets.mount(agentCtx, presetId)`，让绑定会话获得标准工具集（bash/fs/…）。
- **流式**：监听 `session/event` 的 `assistant/chunk`（text-delta），经 `createAsyncQueue` 桥接进飞书 `channel.stream()` 的打字机卡片；`turn/end` 判定回合结果。
- **串行**：每个 chatKey 一个 `AgentRunner`，消息入队串行执行，`agent.followup` 天然排队。

## 测试

```sh
pnpm build        # 先构建（生成 lib/）
pnpm test         # 单元测试（纯逻辑）+ 冒烟测试（Cordis 运行时加载契约）
```

- `packages/connect/test/unit.test.mjs`：命令解析、绑定持久化、异步队列、回合结果推导。
- `packages/connect/test/smoke.mjs`：把两个插件加载进真实 Cordis 上下文，验证 `ctx.connect` 服务注册、适配器注册、白名单授权、`notify` 主动推送与飞书适配器构造。

## 文档

- [飞书开放平台配置](docs/feishu-setup.md)
- [命名与 GitHub/npm 可发现性](docs/PUBLISHING.md)
- [示例配置](examples/profile-cordis.patch.yml)

## 许可

MIT
