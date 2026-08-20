# Web 镜像实现

[English](WEB_MIRROR_IMPLEMENTATION.md) | 中文

## 概述

`dsh-connect-web` 是 `dsh-connect` 的 **Web 通道适配器**：它让飞书的镜像会话在 DSH Web GUI 中可见。它监听共享的 `BindingStore`，找出设置了 `webMirrorSessionId` 的聊天（通过 `/mirror`，或 `autoMirror` 自动创建），并记录为已知镜像。

镜像会话本身不需要适配器转发：DSH Web GUI 直接从 DSH 的会话存储读取会话，因此镜像会话会直接出现在 GUI 的共享工作区下。用户侧行为见 [Web Mirror Session](./MIRROR_SESSION.zh.md)。

## 适配器做什么

- **只记录镜像，不做别的。** `WebAdapter` 订阅 `BindingStore` 变更（`onChange`）并带 1 秒轮询兜底扫描，记录每个 binding 中设置了 `webMirrorSessionId` 的聊天：
  - `isSessionMirrored(sessionId)` — 该会话是否为已知镜像？
  - `getMirrorSource(sessionId)` — 来源 `channel:chatKey`。
- **出站方法按设计为空操作。** `sendText` / `sendCard` / `streamText` / `promptChoice` / `closeMenu` 只是为了满足 `ChannelAdapter` 契约：agent 把事件写入共享会话存储，GUI 负责渲染。

## 不再合成入站消息

旧版适配器会合成一条"镜像已创建"的入站消息并派发给 connect handler。**该行为已删除。** 合成入站消息会：

1. 为该聊天创建一个**多余的 `web` runner**，并且
2. 在用户从未发送任何消息的情况下**白烧一次真实的 agent（LLM）turn**。

适配器现在只记录 `knownMirrors`；任何内容都不会经过 `onInbound` 派发。这有一条回归测试覆盖（`does NOT synthesize inbound messages for new mirrors`）。

## 锁是单侧的（如实说明）

`lockOwner`（`"feishu" | "web"`）**只由飞书侧的 `AgentRunner` 强制**。DSH Web GUI 从不经过本适配器、从不查询锁——它直接读写 DSH 会话（经由 DSH 自己的 api-proxy）。因此 Web 侧**实际上永远可写**，互斥锁无法阻止 Web 并发写入。

这是 DSH Web GUI 的架构限制，**无法在本仓库修复**——文档不得声称 Web 侧会遵守互斥锁。

## 获取 BindingStore

`WebAdapter` 需要持有镜像元数据的 `BindingStore`。它通过 connect 服务的**公开 `bindingStore` getter** 获取（`ctx.get("connect").bindingStore`），而不是伸手进私有字段。

核心包 `dsh-connect` 通过新的 **`"./binding"` 导出子路径**（`dsh-connect/binding`）暴露该存储的类型。没有它，`import type { BindingStore, ChatBinding } from "dsh-connect/binding"` 会在编译时报 `TS2307`、运行时报 `ERR_PACKAGE_PATH_NOT_EXPORTED`。

## 测试

`dsh-connect-web` 使用 **`node:test`**——测试套件为 `packages/connect-web/test/unit.test.mjs`（运行方式：`node packages/connect-web/test/unit.test.mjs`）。已接入**根目录 `pnpm test`**（共 6 个套件：connect unit + smoke、dingtalk、telegram、feishu、connect-web）。记得先 `pnpm build`——测试从 `lib/`（被 gitignore）导入。

覆盖的行为：
- 干净的 `start` / `stop`
- 记录新检测到的镜像会话
- `getMirrorSource` 返回来源 `channel:chatKey`
- 新镜像**不**合成入站消息（回归测试）
- 出站方法为满足契约的空操作

---

## 相关文档

- [Web Mirror Session](./MIRROR_SESSION.zh.md) — 面向用户的镜像与锁行为
- [Shared Workspace Setup](./SHARED_WORKSPACE_SETUP.zh.md) — Web GUI 中的工作区/会话可见性
- [Enhancements Summary](./ENHANCEMENTS_SUMMARY.zh.md) — 本轮修复（含 connect-web）
- [Binding Store API](../packages/connect/src/binding.ts) — 适配器监听的存储

---

**版本**：v0.6.2  
**更新日期**：2026-08-20
