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
   - `/setprivacy` — choose **Disable**, otherwise the bot will not receive non-@ messages in group chats (our `requireMention` policy handles this itself; we recommend keeping it at Enable and controlling it through the plugin config)

## 2. Providing the Token to the Plugin

In the `cordis.patch.yml` of your DSH profile:

```yaml
- insert:
    - id: connect-telegram
      name: dsh-connect-telegram
      config:
        botToken: "1234567890:AAHf7xHfZxHfxxxxxxxxxxxxxxxxxxxxxxxxxx"
        requireMention: true
        language: zh
```

Or set the environment variable `TELEGRAM_BOT_TOKEN` (when both are configured, the config takes precedence).

## 3. Chatting with the Bot

- **Private chat**: just send a message to the bot.
- **Group chat**: by default the bot only responds when it is @-mentioned (or when replying to the bot's message); set `requireMention: false` to make it respond to every message in the group.

## 4. Verification

1. Restart `dsh web`.
2. Send a message to the bot — you should receive an instant confirmation of 「✅ 已收到,开始处理」, followed by the streaming reply.
3. Send `/menu` and an inline button menu should pop up (button callbacks are `ask_user_question`/menu selections).
4. Send an image — the bot should download it and (if the main model supports vision) understand it directly.

## FAQ

| Symptom | Fix |
|---|---|
| The bot does not respond | Make sure the token is correct, `dsh web` has been restarted, and the plugin is inserted in the profile |
| No response in group chats | You need to @-mention the bot in the group, or set `requireMention: false` |
| Long polling errors | Network issues are retried automatically; make sure no firewall on your machine blocks `api.telegram.org` |
