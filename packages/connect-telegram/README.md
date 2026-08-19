# dsh-connect-telegram

Telegram channel adapter for [dsh-connect](../connect/README.md): brings DeepSeek Harness agents into Telegram with the same capabilities as the Feishu adapter — bidirectional conversation, streaming typewriter-style replies, interactive choice prompts, image/file intake, and completion cards.

- **Transport**: official [Telegram Bot API](https://core.telegram.org/bots/api) via `getUpdates` long polling (no webhook / no public IP needed).
- **Bidirectional**: private chats and groups; group replies require @-mention (configurable).
- **Streaming replies**: long answers are edited in place on one message (typewriter feel).
- **Interactive choices**: `ask_user_question` / menu prompts render as inline-keyboard buttons; tapping answers the question.
- **Media**: photos and documents are downloaded into the workdir automatically.
- **Zero runtime HTTP dependency**: built on the global `fetch` (Node ≥ 18 / ≥ 20).

## Install

```sh
dsh plugin --profile web add dsh-connect dsh-connect-telegram
```

## Configure

Create a bot with [@BotFather](https://t.me/BotFather) and copy the token. Append to the profile's `cordis.patch.yml`:

```yaml
- insert:
    - id: connect-telegram
      name: dsh-connect-telegram
      config:
        botToken: "123456:ABC-YourBotToken"
        requireMention: true   # groups must @-mention the bot (default true)
        language: zh           # zh | en
```

The token may also come from the `TELEGRAM_BOT_TOKEN` environment variable.

## How it works

```
Telegram user ──getUpdates(long poll)──► dsh-connect-telegram ──InboundMessage──► dsh-connect (agent)
Telegram user ◄──sendMessage / editMessageText ◄────── dsh-connect (replies)
```

All user-facing strings are localized (zh/en) through the core's i18n layer; per-chat language, notification levels, `/menu`, `/progress` watchdog and every other core feature work the same as Feishu.

## Configuration reference

| Key | Default | Description |
|---|---|---|
| `botToken` | env `TELEGRAM_BOT_TOKEN` | BotFather token |
| `requireMention` | `true` | Groups: require @-mention or a reply to the bot |
| `language` | `zh` | User-facing message language |
| `pollingTimeoutSeconds` | `50` | getUpdates long-poll timeout |
| `baseUrl` | — | Bot API base URL override (local Bot API server) |
