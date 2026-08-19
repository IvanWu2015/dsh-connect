# dsh-connect-dingtalk

English | [中文](README.zh.md)

DingTalk group-webhook push channel for [dsh-connect](../connect/README.md).

The DingTalk **group custom robot (群自定义机器人)** is a *one-way* webhook: it can send text / markdown / @-mention messages into a group, but it **cannot receive messages** (message callbacks are only available to internal-enterprise apps). This package therefore delivers **task progress, results, and alerts into a DingTalk group** — a natural companion to the bidirectional Feishu / Telegram adapters.

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
3. Append to the profile's `cordis.patch.yml`:

```yaml
- insert:
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

> Note: if you need *bidirectional* DingTalk conversation (user sends a message → agent replies), that requires an internal-enterprise app robot with Stream mode — the sending layer here is reusable, but intake would be a new adapter.

## Configuration reference

| Key | Default | Description |
|---|---|---|
| `webhookUrl` | env `DINGTALK_WEBHOOK_URL` | DingTalk group robot webhook URL |
| `secret` | env `DINGTALK_WEBHOOK_SECRET` | Signing secret (`SEC…`) when enabled |
| `language` | `zh` | Log/error language |
| `defaultAt` | — | `{ mobiles, userIds, all }` @-mentions applied to every push |
