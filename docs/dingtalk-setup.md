# DingTalk Group Robot (Webhook) Setup Manual

English | [中文](dingtalk-setup.zh.md)

This document explains how to create a DingTalk group custom robot and use `dsh-connect-dingtalk` to push DeepSeek Harness task progress/results to a DingTalk group.

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

In the `cordis.patch.yml` of your DSH profile:

```yaml
- insert:
    - id: connect-dingtalk
      name: dsh-connect-dingtalk
      config:
        webhookUrl: "https://oapi.dingtalk.com/robot/send?access_token=xxxxxxxx"
        secret: "SECxxxxxxxx"        # only needed when signing is enabled
        language: zh
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

## 4. Verification

1. Restart `dsh web`.
2. Call `sendText("DSH 测试")` once from any script/plugin — the robot message should appear in the group.
3. Check the `dsh web` logs for no `connect-dingtalk: 推送失败`.

## FAQ

| Symptom | Fix |
|---|---|
| `errcode 310000 keywords not in content` | The message body does not contain the custom keyword; switch to the **Signing** security setting instead |
| `errcode 330000` | The robot is rate-limited or the group is abnormal; retry later |
| HTTP 401 | The webhook token is invalid; regenerate the robot |
| Push timeout | Check the network/proxy between your machine and `oapi.dingtalk.com` |

## What about Two-Way Conversations?

A group custom robot cannot receive messages. If you need the two-way experience of "user sends a message in DingTalk → agent replies", you need to create an **enterprise internal app robot** on the DingTalk Open Platform, using a Stream-mode long connection (similar to Feishu) — this would be another adapter; the sending layer of this package can be reused directly.
