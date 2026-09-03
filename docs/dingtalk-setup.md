# DingTalk Group Robot (Webhook) Setup Manual

English | [中文](dingtalk-setup.zh.md)

This document explains how to create a DingTalk group custom robot and use the `dingtalk` channel of `dsh-connect`, which provides a **one-way push service** (`ctx.dingtalk`): other plugins or scripts can call it to push messages into a DingTalk group.

> **Installing**: install the single all-in-one plugin — `dsh plugin --profile web add dsh-connect` — and put this channel's settings under `dingtalk` in the plugin's config block (`webhookUrl`/`secret` flat, `clientId`/`clientSecret` under `stream`). Secrets may live in the DSH credential store. See [config-reference.md](config-reference.md).

> ⚠️ **What this package does NOT do**: there are **no automatic task-progress / result / alert push hooks** (nothing in the connect core pushes to DingTalk on its own), **no `/dingtalk` command**, and the channel **cannot receive messages**. Any "task progress / result / alert push" scenario means some other plugin or script calls `ctx.dingtalk` proactively.
>
> ⚠️ A group custom robot is a **one-way webhook**: it can only send messages, not receive user messages. Two-way conversations require an enterprise internal app robot (Stream mode); see the note at the end of this document.

## 1. Creating the Group Robot

1. Open the target DingTalk group → top-right **Settings** → **Robots** → **Add Robot** → choose **Custom**.
2. Enter the robot name (e.g. "DSH 助手") and choose one of the security settings:
   - **Custom keywords**: e.g. `DSH` — every message body must then contain this keyword
   - **Signing**: after enabling it, a secret starting with `SEC…` is generated (recommended; no keyword needed in the message body)
   - **IP address range**: restrict the source IPs
3. After creation, you get the **Webhook URL**, which looks like:

   ```
   https://oapi.dingtalk.com/robot/send?access_token=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
   ```

4. If signing is enabled, keep the `SEC…` secret safe.

## 2. Configuring the Plugin

In the `cordis.patch.yml` of your DSH profile. The plugin registers itself via its bundle manifest, so only override its config — do **not** `insert` it again (duplicate ids crash dsh at boot):

```yaml
- id: connect
  name: dsh-connect
  config:
    channels: [dingtalk]        # enable the DingTalk channel
    dingtalk:
      webhookUrl: "https://oapi.dingtalk.com/robot/send?access_token=xxxxxxxx"
      secret: "SECxxxxxxxx"        # only needed when signing is enabled
      language: zh
      # defaultAt: { mobiles: ["13800000000"] }   # optional default @-mentions for every push
```

Or set the environment variable `DINGTALK_WEBHOOK_URL` (use `DINGTALK_WEBHOOK_SECRET` for the signing secret).

## 3. Sending Messages

The plugin provides the Cordis service `ctx.dingtalk`, which other plugins/scripts can call directly:

```ts
const dingtalk = ctx.get("dingtalk");
// markdown card (the body must contain the custom keyword if you use the keyword security setting)
await dingtalk.sendMarkdown("任务完成", "**结果**：构建成功", { mobiles: ["13800000000"] });
// plain text
await dingtalk.sendText("DSH 任务已开始");
```

- **@ specific people**: use `{ mobiles: ["手机号"] }` (the DingTalk webhook only recognizes phone numbers) or `{ userIds: [...] }`; `{ all: true }` @mentions everyone.
- **Keyword security setting**: if you chose **Custom keywords**, the markdown **body** (the `text` field) must contain the keyword, otherwise DingTalk returns `errcode 310000`. Choosing **Signing** removes this restriction.

## 4. Behavior

- **Signing**: with a `secret` (`SEC…`) configured, every request is signed as `HMAC-SHA256(timestamp + "\n" + secret)`, base64-encoded, then **URL-encoded** and sent as the `sign` query parameter together with `timestamp`.
- **Retries**: transient **network errors** and DingTalk `errcode 130101` (the 20-messages/minute per-robot frequency limit) are retried automatically with backoff (1 s / 2 s / 4 s, and 10 s for the rate limit), up to **3 attempts** in total.
- **Markdown length**: a markdown body longer than **20000 characters** is truncated automatically (with a trailing marker) before sending.
- **Config keys**: `webhookUrl` (or `DINGTALK_WEBHOOK_URL`), `secret` (or `DINGTALK_WEBHOOK_SECRET`, optional), `language`, `defaultAt` (optional default @-mentions merged into every push).

## 5. Verification

1. Restart `dsh web`.
2. Call `sendText("DSH 测试")` once from any script/plugin — the robot message should appear in the group.
3. Check the `dsh web` logs for no `connect-dingtalk: 推送失败`.

## FAQ

| Symptom | Fix |
|---|---|
| `errcode 310000 keywords not in content` | The message body does not contain the custom keyword; switch to the **Signing** security setting instead |
| `errcode 130101` | Rate limited (20/min); retried automatically with backoff |
| `errcode 330000` | The robot is rate-limited or the group is abnormal; retry later |
| HTTP 401 | The webhook token is invalid; regenerate the robot |
| Push timeout | Check the network/proxy between your machine and `oapi.dingtalk.com` |

## Two-Way Conversations (Stream mode)

A group custom robot cannot receive messages. Since **0.7.0**, the `dingtalk` channel of `dsh-connect` ships a **Stream-mode bidirectional adapter**: create an **enterprise internal app** on the DingTalk Open Platform, enable the Stream-mode gateway, and configure the credentials:

```yaml
- id: connect
  name: dsh-connect
  config:
    channels: [dingtalk]        # enable the DingTalk channel
    dingtalk:
      stream:
        clientId: "dingxxxx"
        clientSecret: "xxxx"
        requireMention: true   # group replies need an @-mention (default true)
      # webhookUrl / secret can still be set for proactive pushes
```

`DINGTALK_STREAM_CLIENT_ID` / `DINGTALK_STREAM_CLIENT_SECRET` environment variables work too. The `dingtalk` channel registers into the `dsh-connect` core: group @-mentions and DMs trigger the agent, replies stream back to the origin message, and menus render as numbered text lists (reply with a number). The STOMP codec, message normalization and reply bodies are unit-tested; validate live connectivity on a real app (needs outbound access to `wss://api.dingtalk.com/connect`).
