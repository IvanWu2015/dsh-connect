# 竞品分析与后续迭代方向

> 撰写于 2026-10-10，对应 `dsh-connect` 1.0.14（仓库状态 `148ec10`）。
> **方法与局限。** `web_search` 不可用（搜索端点返回 HTTP 401），因此下文的每条外部结论
> 都来自用 `web_fetch` 抓取的项目文档与 README。GitHub 的 HTML 页面大多是模板内容，因此
> 尽可能改用原始 README 与厂商的 `.md` 文档。**抓取失败的结论一律标注 UNVERIFIED，且不作为
> 判断依据。** 关于 `dsh-connect` 自身的每一条陈述都**核对了本仓库代码，而非凭印象**。

## 一、格局

相关的是两类完全不同的项目：厂商提供**自家**智能体的聊天入口；开源项目提供智能体但
**没有**聊天入口（或只有编程接口）。`dsh-connect` 两边都不属于——它是**给"你自己运行的
运行时"做聊天桥接**。

| 项目 | 聊天控制面 | 运行时归属 | 开源 | 差异点 |
|---|---|---|---|---|
| [OpenHands / Agent Canvas](https://raw.githubusercontent.com/OpenHands/OpenHands/main/README.md) | Slack / GitHub / Linear，作为**自动化触发器** | 任意 **ACP** 智能体（Claude Code、Codex、Gemini、OpenCode…） | 是 | 一个前端驱动多种运行时 |
| [Claude Code](https://code.claude.com/docs/en/slack.md) | **Slack** `@Claude`、Web、手机端 Code 标签页、[Remote Control](https://code.claude.com/docs/en/remote-control.md) | Anthropic 自有 | **否** | 入口最多；Remote Control 可驱动**本地**会话 |
| [OpenAI Codex](https://raw.githubusercontent.com/openai/codex/main/README.md) | Codex Web / 云端智能体；**Slack 集成 UNVERIFIED**（文档返回 403） | OpenAI 自有 | CLI 为 Apache-2.0 | 按套餐登录 |
| [Aider](https://raw.githubusercontent.com/Aider-AI/aider/main/README.md) | **无** | 任意 LLM | 是 | 仓库地图、自动提交、语音 |
| [Cline](https://raw.githubusercontent.com/cline/cline/main/README.md) | **无** | 任意模型 | 是（JetBrains 插件闭源） | Plan/Act、检查点、MCP |
| [OpenCode](https://opencode.ai/docs/server/) | **无**——但 HTTP API 提供 `POST /session/:id/permissions/:permissionID` | 自有 | 是 | 第三方桥接最清晰的现成底座 |
| [Devin](https://docs.devin.ai/integrations/slack.md) | **Slack** | Cognition 自有 | **否** | 聊天体验最深：`!ask`/`mute`/`sleep`/`EXIT`、"code channel" |
| [Factory](https://docs.factory.com/delegations/slack.md) | **Slack** | Factory 自有 | **否** | **身份**模型（个人 vs 服务账号）；回传文件与视频 |
| [Cursor Cloud Agents](https://cursor.com/docs/integrations/slack.md) | **Slack** | Cursor 自有 | **否** | 团队级 + 每渠道默认 **pool** |
| Jules（Google） | **UNVERIFIED**（两次抓取均失败） | Google 自有 | 否 | — |

**上表最重要的一条事实：** 所有已核实的厂商集成竞品**只支持 Slack**。本次核实范围内
**没有任何项目**记录了对飞书/Lark、钉钉或企业微信的支持。

## 二、`dsh-connect` 的位置

### 确实领先的地方

1. **非西方聊天平台。** 一个插件内提供飞书/Lark（WebSocket 长连接）、Telegram（长轮询）
   与钉钉（基于 WebSocket 的 STREAM + 群机器人 webhook）。已核实的竞品**无一覆盖**飞书/Lark
   或钉钉。
2. **提问与授权以聊天按钮完成往返。** `ask_user_question` 与权限申请会渲染成卡片，可**点击
   或回复编号**作答。在厂商阵营中这一点似乎缺失——Devin 最接近的只是环境配置 diff 上的
   "Apply" 按钮；OpenCode 仅在 HTTP API 层暴露。**正是这个功能让桥接成为"控制台"而不是
   "通知流"。**
3. **同时做到自托管且以聊天为主入口。** 闭源 SaaS 对手是聊天驱动但不可自托管；OpenHands
   可自托管但其聊天面偏向自动化触发，而非对话式控制台。
4. **聊天会话镜像到 DSH Web GUI**（`/mirror`、`autoMirror`）——是**同一个会话对象**出现在
   两处，不是副本。
5. **不消耗 token 的提醒。** `/remind`、`/schedule` 到点投递时**不唤醒智能体**，因此定时提醒
   不花模型 token。
6. **上下文遥测与主动提示。** 任务结束卡片报告上下文占用，并在每轮任务中于
   `COMPACT_THRESHOLD_PCT = 75`（`runner.ts:1468`）触发一次提示，在窗口填满前给出压缩选项。

### 落后或缺失

以下按"在对比中会失分多少"排序：

| # | 缺口 | 谁有 | 为何在这里重要 |
|---|---|---|---|
| G1 | **任务结束不自动回传产物**，`/send <path>` 是手动的 | Factory 会在完成时回传文件/产物/视频 | 一个写报告或画图的长任务，本应无需开口就把结果递到你手上 |
| G2 | **没有"长会话专属频道"** | Devin 的 code channel；Factory 为 PR 工作开频道 | 一个无限增长的卡片，不是长任务的好归宿 |
| G3 | **没有按聊天的"以谁的身份运行"** | Factory：私聊用你的身份，共享频道用服务账号 | 团队群的审计追溯需要它 |
| G4 | **没有入站 webhook 触发器** | 第三方桥接中较常见 | 应当能让 CI/PR 事件发起会话，而不只是人发消息 |
| G5 | **只支持单一运行时（DSH）** | OpenHands 可驱动任意 ACP 智能体 | 加一层运行时接缝可扩大受众 |
| G6 | **没有 pool / 调度目标抽象** | Cursor 的团队级 + 每渠道 pool | 目前一个聊天绑定一个工作目录 |
| G7 | **没有"快速问答"模式** | Devin 的 `!ask` | 不是每个问题都值得开一整轮智能体 |
| G8 | **没有应用市场上架** | Claude Code 在 Slack 应用市场 | 飞书应用目录上架有助于被发现 |

**关于 G6 的一处纠正：** `/workspaces` 已经能列出多个工作目录，`/dir` 也能在它们之间切换，
所以**面向用户的需求已部分满足**。缺的是**管理员视角的 pool 概念**，而不是"切换目录的能力"。

## 三、建议的推进顺序

1. **G1 —— 自动回传产物。** 可见价值与工作量之比最高：传输层（`sendFile`）已存在，飞书与
   Telegram（`/send`）都已实现。缺的是**判断这一轮产出了哪些文件**。稳妥的做法是
   **列出本轮在 workdir 下新写入的文件**供用户点选，而不是猜测意图。
2. **G4 —— 入站 webhook 触发器。** 可复用现有 webhook 服务端路径，让机器人从"聊天玩具"
   变成 CI 能驱动的东西。
3. **G2 —— 长会话专属频道。** 体量更大，且与绑定、加锁相互影响。建议在前两项之后再动。
4. **G3 与 G6** 属于组织级功能，面向团队而非个人，应等真实需求出现再做。

G5（多运行时）是**战略选择而非待办项**：它改变的是这个项目**是什么**。

## 四、不该去争的地方

- **不该追 Slack 系厂商的精致度。** Devin、Factory 有很深的命令词汇（`!ask`、`mute`、
  `sleep`、`aside`）和更丰富的产物体验。为对齐这些而放弃真正无人竞争的平台，得不偿失。
- **不该做成聊天客户端。** 它的价值恰恰在于**你的团队已经在用聊天工具了**。

## 五、需要如实说明的前提

- **因 UNVERIFIED 而不作为依据的：** Codex 的 Slack 集成（403）、Jules 的聊天控制（抓取失败），
  以及一个第三方 `claude-code-telegram` 桥接——它的功能清单来自唯一一次成功抓取，无法复现。
- **这份对比在构造上是不对称的。** 厂商侧依据的是其营销文档，`dsh-connect` 侧依据的是源码。
  **写在厂商文档里的功能，未必比这里由测试保证的功能更可靠；而厂商文档没写的功能，也可能确实存在。**
- **锁是单向的**（`channels/web/adapter.ts:25`）：Web GUI 从不经由本插件发送入站消息，因此
  无法遵守聊天侧的锁。README 现在已在描述加锁功能处**明确写出这一点**。
