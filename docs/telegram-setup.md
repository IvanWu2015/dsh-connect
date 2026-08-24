# Telegram Bot Setup Manual

English | [中文](telegram-setup.zh.md)

This document explains how to create a Telegram bot and connect it to `dsh-connect-telegram`.

## 1. Creating a Bot (BotFather)

1. In Telegram, search for and open **[@BotFather](https://t.me/BotFather)**.
2. Send `/newbot` and follow the prompts to enter the bot's display name and username (the username must end in `bot`).
3. BotFather returns an **HTTP API Token**, which looks like:

   ```
   1234567890:AAHf7xHfZxHfxxxxxxxxxxxxxxxxxxxxxxxxxx
   ```

4. It is recommended to configure the following right away:
   - `/setcommands` — set the command list (optional; helps users discover `/menu`, `/help`, etc.)
   - `/setprivacy` — with **Enable** (the default), Telegram only delivers @-mentions / replies / commands to the bot, which is enough for the default `requireMention: true` policy. Set it to **Disable** only if you want `requireMention: false` (respond to every group message) — the plugin then applies its own mention policy on top.

## 2. Providing the Token to the Plugin

In the `cordis.patch.yml` of your DSH profile. The plugin registers itself via its bundle manifest, so only override its config — do **not** `insert` it again (duplicate ids crash dsh at boot):

```yaml
- id: connect-telegram
  name: dsh-connect-telegram
  config:
    botToken: "1234567890:AAHf7xHfZxHfxxxxxxxxxxxxxxxxxxxxxxxxxx"
    requireMention: true
    pollingTimeoutSeconds: 50   # getUpdates long-poll timeout (default 50)
    language: zh
        # baseUrl: "http://localhost:8081"   # optional: local Bot API server
```

Or set the environment variable `TELEGRAM_BOT_TOKEN` (when both are configured, the config takes precedence).

## 3. Chatting with the Bot

- **Private chat**: just send a message to the bot.
- **Group chat**: by default the bot only responds when it is @-mentioned (its username) **or when it is replying to a message the bot itself sent**; set `requireMention: false` to make it respond to every message in the group. Replying to a normal user's message does **not** trigger the bot.

## 4. Behavior

- **Long polling**: the adapter receives updates via Bot API `getUpdates` long polling (default timeout 50 s; configure with `pollingTimeoutSeconds`). The bot's **own messages are ignored** (`is_bot` filter) — otherwise every ack/reply the bot sends would loop back and trigger the agent again.
- **Streaming replies**: replies stream via `editMessageText`, which **replaces the whole message text**, so the adapter accumulates the full answer and refreshes the complete text (throttled to ~700 ms between flushes); text beyond 4096 characters is truncated with a marker. Messages are sent with **HTML parse mode**, and plain-text `&`, `<`, `>` are always escaped so nothing breaks parse mode.
- **Media**: images, files, voice, video and audio are downloaded and attached to the agent turn; `edited_message` updates are ignored (including the bot's own stream edits).
- **Config keys**: `botToken` (or `TELEGRAM_BOT_TOKEN`), `requireMention` (default `true`), `pollingTimeoutSeconds` (default `50`), `baseUrl` (optional, e.g. a local Bot API server).

## 5. Verification

1. Restart `dsh web`.
2. Send a message to the bot — you should receive an instant confirmation of 「✅ 已收到,开始处理」, followed by the streaming reply.
3. Send `/menu` and an inline button menu should pop up (button callbacks are `ask_user_question`/menu selections).
4. Send an image — the bot should download it and (if the main model supports vision) understand it directly.

## FAQ

| Symptom | Fix |
|---|---|
| The bot does not respond | Make sure the token is correct, `dsh web` has been restarted, and the plugin is inserted in the profile |
| No response in group chats | You need to @-mention the bot in the group (or reply to the bot's own message), or set `requireMention: false` |
| Long polling errors | Network issues are retried automatically; make sure no firewall on your machine blocks `api.telegram.org` |
