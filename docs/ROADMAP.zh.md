# dsh-connect 下个版本迭代计划（Roadmap）

> 状态：基于 2026-08-24 的 v0.6.7 代码基线分析后制定；已按计划推进。
> 进度：
> - **阶段 A（0.6.8 可靠性批次）已完成**——A1 锁队列修复、A2 出站重试、A3 入站去重、A4 单测、A5 CI、A6 `/export pdf` 面移除均已落地并全测试通过（2026-08-24）。
> - **阶段 B（0.7.0 功能批次）已完成**——B1 钉钉双向 stream 模式、B2 定时提醒、B3 文件回传、B4 群聊线程隔离、B5 管理员广播全部落地；5 包构建/typecheck 通过，95 个单测 + smoke 全绿（2026-08-25）。
> 版本纪律：按 `.cursorrules`，patch（0.6.x）可自动递增；minor（0.7.x）/major（0.8.x）需显式用户批准。
> 每条目的"依据"均来自当前代码事实（文件行号 / 测试结果），非猜测。

---

## 阶段 A（0.6.8）——可靠性批次 ✅ 已完成

| # | 内容 | 状态 |
|---|---|---|
| A1 | 镜像锁队列：`releaseLock` 竞态（队列复活重复处理）修复，锁状态机抽为纯模块 `src/mirror-lock.ts` 并单测 | ✅ |
| A2 | 出站消息带重试（`src/retry.ts`：sendText/sendCard/promptChoice/closeMenu 重试，streamText 不重试） | ✅ |
| A3 | 入站去重（`src/dedup.ts`：按 channel+chatKey+messageId 滑窗去重，防 SDK 重投） | ✅ |
| A4 | 单测扩充（锁/去重/重试/export 解析/helpText），smoke 同步更新 | ✅ |
| A5 | CI（`.github/workflows/ci.yml`：Node 20/22 矩阵，build+typecheck+test） | ✅ |
| A6 | 移除 `/export pdf` 用户面（无实现仅报错），统一为 Markdown 导出 | ✅ |

## 阶段 B（0.7.0）——功能批次 ✅ 已完成

| # | 内容 | 状态 |
|---|---|---|
| B1 | **钉钉双向**：`stream` 模式（`dsh-connect` 的 `dingtalk` 通道），零新增依赖——STOMP 编解码（`src/stomp.ts`）+ 消息归一化/回复体（`src/message.ts`）+ 网关客户端（`src/stream.ts`，惰性 `globalThis.WebSocket`）+ ChannelAdapter（`src/adapter.ts`）；群 @提及触发任务、结果回推原消息；菜单为编号文本列表（回复数字作答）；主动推送仍走 webhook | ✅ |
| B2 | **定时提醒**：`/remind <时间> <内容>`（`10分钟`/`2h`/`14:30`），持久化到 `stateDir/reminders.json`，15s 循环到点投递（不唤醒智能体、不耗 token、重启生效）；`/schedule` 合并展示智能体级与会话级提醒 | ✅ |
| B3 | **图片/文件回传**：`ChannelAdapter.sendFile`（可选）契约；飞书用 SDK `{ image:{source} }`/`{ file:{source,fileName} }`（图片内联/其余附件）、Telegram 用 `sendPhoto`/`sendDocument`；`/send <路径>` 命令（相对 workdir、20MB 上限、无能力通道回退为发路径文本） | ✅ |
| B4 | **群聊线程隔离**（飞书，可选）：`threadIsolation: true` 时按线程绑定独立会话（`chatKey=chatId:thread=<rootId>`），出站仍发基础 chatId（经 replyRef 回线程）；纯编解码函数单测 | ✅ |
| B5 | **管理员广播**：`/broadcast <内容>`（别名 `/announce`）向所有已绑定会话推送；仅 `allowUsers` 非空且发送者在列表中才可用，逐会话容错计数 | ✅ |

### 阶段 B 已知边界（如实记录）

- **B1 钉钉 stream**：协议细节（STOMP 帧、CONNECT 体、回复体、@提及判定）全部单测；但真实网关连通性无法在本仓库环境验证（需真实企业内部应用凭据 + 外网），`stream.ts` 是刻意保持薄的网络边界，建议用真实应用做一次端到端冒烟。
- **B3 文件回传**：本版本提供传输能力（`sendFile` 契约 + 飞书/Telegram 实现 + `/send` 命令）；"智能体生成图片后自动推送" 的自动探测留待后续。
- **B4 线程隔离**：依赖 SDK 事件里携带 `root_id`；若 SDK 未透传则该配置静默退化为现状（防御式读取）。

## 阶段 C（0.8.0）——架构批次（候选，未启动）

| # | 内容 | 说明 |
|---|---|---|
| C1 | 出站统一排队/限流层 | 现为每适配器重试包装；可抽为统一 outbound pipeline（优先级、重试、退避、节流、统计） |
| C2 | 会话与绑定状态迁移到 DSH 工作区 Registry | 当前 BindingStore 独立于 workspaceRegistry；统一后可跨进程/多实例一致 |
| C3 | 通道能力自描述 | 把 sendFile/stream/menu/button 等能力做成适配器自描述的能力位图，核心据此裁剪 UI 与回退 |
| C4 | 图片/文件入站统一附件管线 | 飞书/Telegram/钉钉各自下载；可抽统一附件下载 + 类型探测 + 注入 |
| C5 | 钉钉按钮卡片菜单 | 用真实 action-card 替换编号文本菜单（依赖 B1 稳定后再做） |
| C6 | 可观测性 | 出站/入站指标、每个通道的运行状态端点、`/status` 汇总 |
