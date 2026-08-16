# Feishu Open Platform Configuration Manual

This plugin uses Feishu's **long-connection (WebSocket) event subscription** mode by default — no public IP / domain / tunnel is required, and events are received locally.

## 1. Create a custom app

1. Open the [Feishu Open Platform](https://open.feishu.cn/) → Developer Console → **Create enterprise self-built app**.
2. Fill in the app name and icon (e.g. `DSH Assistant`).
3. Inside the app → **Credentials & Basic Info**:
   - Note the **App ID** (`cli_xxx`) and **App Secret**.
   - Put these into the plugin config as `appId` / `appSecret` (or the environment variables `FEISHU_APP_ID` / `FEISHU_APP_SECRET`).

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
- id: connect-feishu
  name: dsh-connect-feishu
  config:
    appId: cli_xxxx
    appSecret: cli_secret_xxxx
    transport: websocket          # long connection
    requireMention: true          # groups need @mention
    dmMode: open                  # DMs open
```

Start `dsh web`; once the log shows a successful connection you can chat in Feishu.

## 7. FAQ

- **Messages not received**: confirm the version is released; groups need @mention (or disable `requireMention`); confirm `im.message.receive_v1` is subscribed.
- **Card buttons don't respond**: confirm `card.action.trigger` is subscribed and release a new version.
- **Images not received (shows "image download failed")**:
  - **Old-version bug**: the old code used `im.v1.image.get` (download image) to fetch images from user messages, but the Feishu docs state that endpoint **can only download images uploaded by the bot itself**. Images in user messages must be fetched with "get resource file from message" — `im.v1.messageResource.get` (with message_id + type=image) — otherwise it returns **HTTP 400**. Upgrade to the fixed version.
  - **Permissions**: `messageResource.get` requires any one of `im:message` (or `im:message:readonly` / `im:message.history:readonly`) — see the "Permission Requirements" section of the official API docs; there is **no `im:resource` permission**. When a permission is missing, Feishu returns business error `99991672`, and the `error.permission_violations[]` array in the response body lists exactly which permission is missing — trust that. Enable the listed permission in **Permission Management**, then **Create Version and Release** in **Version Management & Release** (enterprise self-built apps need admin approval). You can reproduce and verify directly in the [API Debug Console](https://open.feishu.cn/api-explorer) with the "get resource file from message" endpoint.
  - **Where to see the real error code**: look for the `connect-feishu: 图片下载失败 (...)` line (currently localized; means "image download failed") in the `dsh web` process console log — the chat message also includes the detail (in the fixed version). For other error codes (resource expired, invalid file_key, etc.) see the [Feishu error-code FAQ](https://open.feishu.cn/document/faq/trouble-shooting/how-to-fix-the-99991672-error) and the API docs.
- **3-second timeout redelivery**: in long-connection mode events must be ACKed within 3 seconds; the SDK handles this internally. Keep `handleInbound` fast on the business side (this plugin enqueues the message and returns immediately; agent processing happens asynchronously in the queue, unaffected).
- **Multiple instances**: the long connection is cluster-mode — with multiple clients on the same app only one randomly receives each message (this plugin is designed single-process).
- **Webhook mode**: for public callbacks, set `transport: webhook` with `verificationToken` / `encryptKey`, and you also need a local HTTP service to host the SDK's express adapter (an HTTP service is not built in at this stage — prefer long connection).
