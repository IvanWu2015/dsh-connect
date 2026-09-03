# Feishu Open Platform Configuration Manual

English | [中文](feishu-setup.zh.md)

This plugin uses Feishu's **long-connection (WebSocket) event subscription** mode by default — no public IP / domain / tunnel is required, and events are received locally. A **webhook mode is also implemented** (see [Webhook transport](#webhook-transport)) for setups that must use a public HTTPS callback URL.

> **Installing**: install the single all-in-one plugin — `dsh plugin --profile web add dsh-connect` — and put this channel's settings under `feishu` in the plugin's config block (secrets may live in the DSH credential store). See [config-reference.md](config-reference.md).

## 1. Create a custom app

1. Open the [Feishu Open Platform](https://open.feishu.cn/) → Developer Console → **Create enterprise self-built app**.
2. Fill in the app name and icon (e.g. `DSH Assistant`).
3. Inside the app → **Credentials & Basic Info**:
   - Note the **App ID** (`cli_xxx`) and **App Secret**.
   - Put these into the plugin config as `appId` / `appSecret` (or the environment variables `FEISHU_APP_ID` / `FEISHU_APP_SECRET`).

> **One-click onboarding**: when neither the config nor the environment variables provide credentials, the plugin enters an onboarding flow instead of failing: it prints a QR-code / link (valid ~10 minutes) in the `dsh web` log. Scan it with Feishu and the bot app is created automatically with the permissions and event subscriptions pre-set; the returned credentials are saved to `$DSH_HOME/.dsh-connect/feishu-credentials.json` (permissions `0600`) and reused on later startups.

## 2. Enable the bot capability

- **Add App Capabilities** → add **Bot**.

## 3. Configure permissions

Enable and release the following permissions in **Permission Management** (at least the first three):

| Permission | Purpose |
|---|---|
| `im:message` | Read message content (DMs + groups) |
| `im:message.p2p_msg:readonly` or `im:message.p2p_msg` | Read DM messages |
| `im:message.group_msg` | Read group messages (requires admin approval for full group reads; for @mention-only responses `im:message.group_at_msg` is enough) |
| `im:message:send_as_bot` | Send messages as the bot |
| `im:message` (already covered above) | Also enables downloading images/files/audio/video that users send — image reception fails without it |

> Note: `im:message.group_msg` (reading all group messages) requires admin approval. For an "@mention triggers response" bot, `im:message.group_at_msg` is sufficient.

## 4. Event subscription (long-connection mode)

1. **Events & Callbacks** → **Event Configuration** → Subscription Method → choose **"Use long connection to receive events"**.
2. Add event: **`im.message.receive_v1`** (receive messages).
3. **Add event: `card.action.trigger` (card button callback)** — the interactive menus (`/menu`, `/dir`, `/chat`, `/settings` button picks) rely on it; **without it, tapping buttons does nothing**.
4. No need to fill in a **Request URL** — in long-connection mode the SDK connects outbound, so no public URL, verification token, or encrypt key is needed (those are only for webhook mode).
5. Save.

## 5. Create a version and release

1. **Version Management & Release** → **Create Version**, packaging the permissions, bot capability, and event subscriptions above.
2. Submit → reviewed and released by the enterprise admin.
3. After release, add the bot to the target group / DM it.

## 6. Run

```yaml
# the profile's cordis.patch.yml
- id: connect
  name: dsh-connect
  config:
    channels: [feishu]            # enable the Feishu channel
    feishu:
      appId: cli_xxxx
      appSecret: cli_secret_xxxx
      transport: websocket          # long connection
      requireMention: true          # groups need @mention
      dmMode: open                  # DMs open
```

Start `dsh web`; once the log shows a successful connection you can chat in Feishu.

## 7. Behavior

- **Group @mention policy**: group messages are only answered when the bot is @-mentioned (`requireMention: true` by default); set `requireMention: false` to respond to every group message.
- **Allowlist pre-filter**: `allowUsers` / `allowChats` are enforced by the adapter **before** any message resource is downloaded — a rejected sender's images/files are never written to disk (the core re-checks the same lists later for the full policy).
- **Attachment downloads**: images / files / audio / video sent by users are downloaded into the system temp directory (`dsh-connect-images` for images, `dsh-connect-files` for the rest). A single file is capped at 20 MB with a 60-second download timeout, and files older than 24 hours are cleaned up automatically.
- <a id="webhook-transport"></a>**Webhook transport**: set `transport: webhook` and the adapter starts its own `node:http` server listening on `webhookPort` (default `9000`) at `webhookPath` (default `/`), wired through the SDK's `adaptDefault` with `autoChallenge`, so the `url_verification` challenge is answered automatically. Point the Feishu callback URL at a **public HTTPS** address that reaches this port. `verificationToken` / `encryptKey` are only needed in webhook mode; in long-connection mode they are ignored.

## 8. FAQ

- **Messages not received**: confirm the version is released; groups need @mention (or disable `requireMention`); confirm `im.message.receive_v1` is subscribed.
- **Card buttons don't respond**: confirm `card.action.trigger` is subscribed and release a new version.
- **Images not received (shows "image download failed")**:
  - **Old-version bug**: the old code used `im.v1.image.get` (download image) to fetch images from user messages, but the Feishu docs state that endpoint **can only download images uploaded by the bot itself**. Images in user messages must be fetched with "get resource file from message" — `im.v1.messageResource.get` (with message_id + type=image) — otherwise it returns **HTTP 400**. Upgrade to the fixed version.
  - **Permissions**: `messageResource.get` requires any one of `im:message` (or `im:message:readonly` / `im:message.history:readonly`) — see the "Permission Requirements" section of the official API docs; there is **no `im:resource` permission**. When a permission is missing, Feishu returns business error `99991672`, and the `error.permission_violations[]` array in the response body lists exactly which permission is missing — trust that. Enable the listed permission in **Permission Management**, then **Create Version and Release** in **Version Management & Release** (enterprise self-built apps need admin approval). You can reproduce and verify directly in the [API Debug Console](https://open.feishu.cn/api-explorer) with the "get resource file from message" endpoint.
  - **Where to see the real error code**: look for the `connect-feishu: 图片下载失败 (...)` line (currently localized; means "image download failed") in the `dsh web` process console log — the chat message also includes the detail (in the fixed version). For other error codes (resource expired, invalid file_key, etc.) see the [Feishu error-code FAQ](https://open.feishu.cn/document/faq/trouble-shooting/how-to-fix-the-99991672-error) and the API docs.
- **3-second timeout redelivery**: in long-connection mode events must be ACKed within 3 seconds; the SDK handles this internally. Keep `handleInbound` fast on the business side (this plugin enqueues the message and returns immediately; agent processing happens asynchronously in the queue, unaffected).
- **Multiple instances**: the long connection is cluster-mode — with multiple clients on the same app only one randomly receives each message (this plugin is designed single-process).
