# dsh-connect-dingtalk

[English](README.md) | 中文

面向 [dsh-connect](../connect/README.zh.md) 的钉钉群自定义机器人 Webhook 推送渠道。

钉钉**群自定义机器人**是一个*单向* webhook：它可以向群里发送文本 / markdown / @提及 消息，但**无法接收消息**（消息回调仅对内部企业应用开放）。因此，本包提供**推送服务**（`ctx.dingtalk`），供其他插件或脚本主动调用，将通知——进度、结果、告警——发送到钉钉群，与双向的飞书 / Telegram 适配器形成天然互补。没有入站通道，也没有 `/dingtalk` 命令：本包自身不会自动推送任何内容。

- **推送文本与 markdown 卡片**到任意钉钉群。
- **@提及**成员：按手机号（钉钉的要求）或用户 id，或 @all。
- **可选签名密钥**（`SEC…`），用于安全设置后的机器人。
- **零运行时 HTTP 依赖**（使用全局 `fetch`）。

## 安装

```sh
dsh plugin --profile web add dsh-connect-dingtalk
```

## 配置

1. 在钉钉群中：**设置 → 群机器人 → 添加机器人 → 自定义机器人**。
2. 复制**Webhook 地址**（`https://oapi.dingtalk.com/robot/send?access_token=…`）；可选地启用**签名**并复制 `SEC…` 密钥。
3. 追加到 profile 的 `cordis.patch.yml`。该插件会通过自身的 bundle 清单自动注册，因此这里只需要**覆盖（override）**它的配置——**不要**再用 `insert` 重新插入（重复的 `id` 会让 dsh 启动失败）：

```yaml
- id: connect-dingtalk
  name: dsh-connect-dingtalk
  config:
    webhookUrl: "https://oapi.dingtalk.com/robot/send?access_token=xxx"
    secret: "SECxxx"        # only if signing is enabled
    language: zh            # zh | en
    # defaultAt:            # optional: @-mention on every push
    #   mobiles: ["13800000000"]
```

Webhook 地址也可以来自 `DINGTALK_WEBHOOK_URL` 环境变量（密钥通过 `DINGTALK_WEBHOOK_SECRET`）。

## 用法

插件注册了一个 Cordis 服务 `ctx.dingtalk`。其他插件或脚本可以向群内推送：

```ts
const dingtalk = ctx.get("dingtalk");
await dingtalk.sendMarkdown("任务完成", "**结果**：构建成功", { mobiles: ["13800000000"] });
await dingtalk.sendText("简单的文本通知");
```

`DingtalkWebhook` 也作为独立用法直接导出：

```ts
import { DingtalkWebhook } from "dsh-connect-dingtalk";
const webhook = new DingtalkWebhook({ webhookUrl, secret });
await webhook.sendMarkdown("标题", "正文", { all: true });
```

## Stream 模式（双向，零依赖）

自 0.7.0 起，配置 `stream.clientId` / `stream.clientSecret`（需使用支持 Stream 模式的**企业内部应用**，也支持 `DINGTALK_STREAM_CLIENT_ID` / `DINGTALK_STREAM_CLIENT_SECRET` 环境变量）会向 `dsh-connect` 注册一个 **ChannelAdapter**：群内 @提及机器人和私聊消息会触发智能体，回复会回流到原消息。

- 传输：通过 STOMP over WebSocket 连接 Stream 网关（默认 `wss://api.dingtalk.com/connect`，可用 `stream.url` 覆盖），**零新增依赖**手写实现（惰性引用 `globalThis.WebSocket`；Node ≥ 22 或需 polyfill，仅在连接时失败）。
- 菜单渲染为**编号文本列表**——回复数字即可选择。本版本不包含真实的 action-card 按钮卡片。
- `streamText` 会累积完整回复后一次性发送（网关没有渐进式卡片编辑）。
- 主动推送（提醒、广播）仍走 webhook 服务——stream 适配器只回复入站消息。
- STOMP 编解码、消息归一化与回复体均已单测覆盖；真实连接需要有效的应用凭据与外网，请用真实应用验证。

```yaml
- id: connect-dingtalk
  name: dsh-connect-dingtalk
  config:
    stream:
      clientId: "dingxxxx"
      clientSecret: "xxxx"
      requireMention: true    # 群里回复需要 @提及机器人（默认 true）
    # webhookUrl / secret 仍可配置，用于主动推送
```

## 配置参考

| 键 | 默认值 | 说明 |
|---|---|---|
| `webhookUrl` | env `DINGTALK_WEBHOOK_URL` | 钉钉群机器人 Webhook 地址 |
| `secret` | env `DINGTALK_WEBHOOK_SECRET` | 启用时的签名密钥（`SEC…`） |
| `language` | `zh` | 日志/错误语言 |
| `defaultAt` | — | 每次推送都应用的 `{ mobiles, userIds, all }` @提及 |
| `stream.clientId` | env `DINGTALK_STREAM_CLIENT_ID` | 企业内部应用 Client ID（stream 模式） |
| `stream.clientSecret` | env `DINGTALK_STREAM_CLIENT_SECRET` | 企业内部应用 Client Secret（stream 模式） |
| `stream.url` | `wss://api.dingtalk.com/connect` | Stream 网关地址覆盖 |
| `stream.requireMention` | `true` | 群消息必须 @提及机器人 |
