# dsh-connect 0.6.2 本轮修复 - 实现总结

English | [中文](ENHANCEMENTS_SUMMARY.zh.md)

> **历史说明**：本文档记录 **v0.6.2** 这一轮的修复。此后本仓库已合并为**唯一的 `dsh-connect` 包**——下文提到的各分包（`dsh-connect-feishu`、`dsh-connect-telegram`、`dsh-connect-dingtalk`、`dsh-connect-web`）与 `packages/connect-*/test/` 拆分目录已不存在；这些通道现在是 `dsh-connect` 单个插件的子键（`feishu:` / `telegram:` / `dingtalk:` / `web:`）。

## 📋 概述

本轮修复让仓库行为与代码事实保持一致：核心的崩溃/挂死修复、Telegram 适配器的正确性与流式修复、飞书适配器的真实 webhook 支持与安全下载、钉钉适配器的重试/截断行为、重构后的 connect-web 适配器、串行 5 包发布流水线，以及死配置清理。版本 **0.6.2**。

---

## ✅ 改动内容

### 核心（`dsh-connect`）

- **命令分发不再崩溃**：命令处理器现在带 catch 调用——`/…` 分发过程中的瞬时通道错误不再变成未处理的 Promise rejection（Node ≥ 15 默认会因此崩溃进程）。
- **`streamText` 错误路径保证 chunk 流终结**：`followup` / `whenIdle` / `flush` 抛错时无条件 `end()` chunk 队列并释放适配器的 `for await`（其 rejection 被吞掉）——流式卡片不再永久卡在 "streaming" 状态、不再泄漏队列/适配器 promise。
- **`buildUserContent` 更多场景包含附件**：非图片附件（文件/音频/视频）现在对纯文件消息和视觉主模型场景也会暂存并附加——之前无图片的消息会静默丢弃它们。
- **会话变更重置镜像**：`/new`、`/clear` 和切换会话（`/chat`）清除 `webMirrorSessionId` / `lockOwner`，陈旧镜像不会指向已废弃会话；`autoMirror` 为新会话重建镜像。
- **锁的作用范围收窄**：互斥锁只对镜像会话的 `feishu` / `web` 通道生效；telegram / dingtalk 不参与。
- **`/settings` 清理**：移除了设置菜单中无效的"流式/摘要"开关。
- **i18n 死键清理**；`Config` schema 现在声明了 `autoMirror`。

### Telegram（`dsh-connect-telegram`）

- 修复导致编译失败的缺失大括号。
- **回声循环防护**：忽略机器人自己的消息（`is_bot`），确认/回复不再回环触发 agent。
- **流式重写**：`streamText` 累积全文，通过 `editMessageText` 每次刷新整个消息（约 700ms 节流），超过 4096 字符截断并带省略标记——旧的增量式做法会抹掉前面的内容。
- **长轮询不再被掐断**：`getUpdates` 使用高于 50 秒服务端窗口的客户端超时，空闲轮询不再被通用 15 秒 HTTP 超时切断。
- **按 update 确认 offset**：每个 update 完整处理后才推进轮询 offset——批次中途失败不会丢批。
- **HTML 全量转义**：普通文本的 `& < >` 在所有位置（含转换后的 markdown 片段内部）都被转义，LLM 输出的 `R&D`、`x < y` 等不会破坏解析模式。
- **精确 @提及检测**：从 `getMe` 缓存机器人 id/用户名，用于精确的 @提及 / 回复目标判断。
- **选项按键按 (chat, option) 复合键存储**：不同聊天中的并发菜单互不覆盖；超时后按键键盘替换为过期提示。
- **更多媒体类型**：支持语音/视频/音频下载（在图片/文件之上）；忽略 `edited_message`。

### 飞书（`dsh-connect-feishu`）

- **允许列表预过滤**：在下载任何消息资源之前检查 `allowUsers` / `allowChats`——被拒绝发送者的图片/文件不会落盘。
- **安全下载**：单文件 20 MB 上限、60 秒超时、异步写入临时目录（`dsh-connect-images` / `dsh-connect-files`），超过 24 小时自动清理。
- **Webhook 传输真正实现**：适配器自带 `node:http` 服务（`webhookPort` 默认 9000、`webhookPath` 默认 "/"），经 SDK 的 `adaptDefault` + `autoChallenge` 自动应答 `url_verification` 挑战——不再需要外部 express 宿主。
- **reject 日志去 PII**：入站 `reject` 处理器只记录精简原因，不打印完整事件 JSON。
- **凭据文件权限收紧**：onboarding 保存的 `feishu-credentials.json` 权限为 `0600`。
- **`stop()` 清理资源**：webhook 服务器、选项定时器、过期提示定时器全部拆除。
- 纯函数（`padLabels`、`buildButtonGrid` 等）导出并有测试覆盖。

### 钉钉（`dsh-connect-dingtalk`）

- **自动退避重试**：瞬时网络错误与 `errcode 130101`（20 次/分钟频控）自动重试，最多 3 次。
- **markdown 20000 字符截断**：超过 API 上限时发送前自动截断。
- **签名校验修复**：比较前对两侧做 URL 解码，并强制时间戳新鲜度窗口。
- 删除死导出与死 i18n 键。

### Web 镜像（`dsh-connect-web`）

- **核心包新增 `dsh-connect/binding` 导出子路径**——修复导入 `BindingStore` / `ChatBinding` 时的 `TS2307`（缺类型）与运行时 `ERR_PACKAGE_PATH_NOT_EXPORTED`。
- **改用公开 bindingStore getter**：适配器通过 connect 服务的公开 `bindingStore` getter 获取存储，不再触碰内部字段。
- **删除合成的 `[Mirror]` 入站消息**：适配器不再向 handler 派发假的"镜像已创建"消息——此前会创建多余的 web runner 并白烧一次真实 LLM turn。现在只记录已知镜像（`isSessionMirrored` / `getMirrorSource`）。
- **测试改为 `node:test`** 并接入根 `pnpm test`（见下）。

### CI / 配置

- **`publish.yml`**：测试/发布前先 `pnpm build`（`lib/` 被 gitignore），新增 `pnpm typecheck`，发布改为**串行 5 包**（`dsh-connect` 最先，然后 connect-web → feishu → telegram → dingtalk），不再用并行矩阵。
- **`dsh.shared.config.json`**：删除死键（`state.bindingsFile`、`state.sessionStorePath`、`mirror.defaultTimeoutMinutes`、`mirror.enableLocking`）；只读取 `workspace.defaultWorkDir`、`workspace.additionalWorkspaces`、`state.stateDir`、`mirror.autoCreate`、`language`。

---

## 🧪 测试

测试需先构建（`pnpm build`——`lib/` 被 gitignore）。根 `pnpm test` 现在跑 **6 个套件**，全部 `node:test`：

1. `packages/connect/test/unit.test.mjs` — 核心单元测试（命令解析、绑定持久化、异步队列、回合结果等）
2. `packages/connect/test/smoke.mjs` — Cordis 运行时加载契约（服务注册、适配器、允许列表、notify）
3. `packages/connect-dingtalk/test/unit.test.mjs`
4. `packages/connect-telegram/test/unit.test.mjs`
5. `packages/connect-feishu/test/unit.test.mjs`
6. `packages/connect-web/test/unit.test.mjs`

---

## 📝 注意事项

### 诚实的限制：镜像锁是单侧的

`lockOwner` 只由飞书侧 runner 强制；DSH Web GUI 直接读写 DSH 会话、从不查询锁，因此 Web 侧实际上永远可写。这是 DSH Web 的架构限制，无法在本仓库修复。详见 [Web Mirror Session](./MIRROR_SESSION.zh.md)。

### 镜像命令

`/mirror [--timeout N]`、`/unlock`（手动释放锁）、`/renew`（续期锁超时）、`/export [markdown|pdf]`；`autoMirror` 配置（默认 `true`）。

---

## 📚 相关文档

- [Web Mirror Session](./MIRROR_SESSION.zh.md)
- [共享工作区配置](./SHARED_WORKSPACE_SETUP.zh.md)
- [Web 镜像实现](./WEB_MIRROR_IMPLEMENTATION.zh.md)
- [Binding Store API](../packages/connect/src/binding.ts)
- [Runner 实现](../packages/connect/src/runner.ts)

---

**版本**：v0.6.2  
**更新日期**：2026-08-20  
**作者**：DSH Connect Team
