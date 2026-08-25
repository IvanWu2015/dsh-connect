# dsh-connect-dingtalk

English | [中文](README.zh.md)

DingTalk group-webhook push channel for [dsh-connect](../connect/README.md).

The DingTalk **group custom robot (群自定义机器人)** is a *one-way* webhook: it can send text / markdown / @-mention messages into a group, but it **cannot receive messages** (message callbacks are only available to internal-enterprise apps). This package therefore exposes a **push service** (`ctx.dingtalk`) that any other plugin or script can call to deliver notices — progress, results, alerts — into a DingTalk group, a natural companion to the bidirectional Feishu / Telegram adapters. There is no inbound path and no `/dingtalk` command: nothing is pushed automatically by this package itself.

- **Push text & markdown cards** into any DingTalk group.
- **@-mention** people by phone number (DingTalk's requirement) or user id, or @all.
- **Optional signing secret** (`SEC…`) for verified robots.
- **Zero runtime HTTP dependency** (global `fetch`).

## Install

```sh
dsh plugin --profile web add dsh-connect-dingtalk
```

## Configure

1. In a DingTalk group: **Settings → Group robot → Add robot → Custom robot**.
2. Copy the **Webhook URL** (`https://oapi.dingtalk.com/robot/send?access_token=…`); optionally enable **signing** and copy the `SEC…` secret.
3. Append to the profile's `cordis.patch.yml`. The plugin registers itself via its bundle manifest, so only override its config — do **not** `insert` it again (duplicate ids crash dsh at boot):

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

The webhook URL may also come from the `DINGTALK_WEBHOOK_URL` environment variable (secret via `DINGTALK_WEBHOOK_SECRET`).

## Usage

The plugin registers a Cordis service `ctx.dingtalk`. Other plugins or scripts can push into the group:

```ts
const dingtalk = ctx.get("dingtalk");
await dingtalk.sendMarkdown("任务完成", "**结果**：构建成功", { mobiles: ["13800000000"] });
await dingtalk.sendText("简单的文本通知");
```

`DingtalkWebhook` is also exported directly for standalone use:

```ts
import { DingtalkWebhook } from "dsh-connect-dingtalk";
const webhook = new DingtalkWebhook({ webhookUrl, secret });
await webhook.sendMarkdown("标题", "正文", { all: true });
```

## Stream mode (bidirectional, zero dependencies)

Since 0.7.0, setting `stream.clientId` / `stream.clientSecret` (an **internal-enterprise app** with the Stream-mode gateway, `DINGTALK_STREAM_CLIENT_ID` / `DINGTALK_STREAM_CLIENT_SECRET` env fallbacks) registers a **ChannelAdapter** into `dsh-connect`: group @-mentions and DMs trigger the agent, and replies stream back to the origin message.

- Transport: STOMP over WebSocket to the stream gateway (`wss://api.dingtalk.com/connect`, override via `stream.url`), hand-rolled with **zero new dependencies** (lazy `globalThis.WebSocket`; Node ≥ 22 or a polyfill at connect time).
- Menus render as **numbered text lists** — answer with a number to pick. Real action-card buttons are out of scope for this release.
- `streamText` accumulates and sends the complete reply once (no progressive card editing on the gateway).
- Proactive pushes (reminders, broadcasts) still go through the webhook service — the stream adapter replies to inbound messages only.
- The STOMP codec, message normalization and reply bodies are unit-tested; live connectivity requires real app credentials and an outbound connection, so validate on a real app.

```yaml
- id: connect-dingtalk
  name: dsh-connect-dingtalk
  config:
    stream:
      clientId: "dingxxxx"
      clientSecret: "xxxx"
      requireMention: true    # group replies need an @-mention (default true)
    # webhookUrl / secret can still be set for proactive pushes
```

## Configuration reference

| Key | Default | Description |
|---|---|---|
| `webhookUrl` | env `DINGTALK_WEBHOOK_URL` | DingTalk group robot webhook URL |
| `secret` | env `DINGTALK_WEBHOOK_SECRET` | Signing secret (`SEC…`) when enabled |
| `language` | `zh` | Log/error language |
| `defaultAt` | — | `{ mobiles, userIds, all }` @-mentions applied to every push |
| `stream.clientId` | env `DINGTALK_STREAM_CLIENT_ID` | Internal-enterprise app Client ID (stream mode) |
| `stream.clientSecret` | env `DINGTALK_STREAM_CLIENT_SECRET` | Internal-enterprise app Client Secret (stream mode) |
| `stream.url` | `wss://api.dingtalk.com/connect` | Stream gateway URL override |
| `stream.requireMention` | `true` | Group messages must @-mention the bot |
