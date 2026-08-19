# dsh-connect-telegram

[English](README.md) | 中文

面向 [dsh-connect](../connect/README.zh.md) 的 Telegram 渠道适配器：将 DeepSeek Harness 智能体带入 Telegram，能力与飞书适配器相同——双向对话、流式打字机风格回复、交互式选择提示、图片/文件接收与完成卡片。

- **传输**：通过 `getUpdates` 长轮询使用官方 [Telegram Bot API](https://core.telegram.org/bots/api)（无需 webhook / 无需公网 IP）。
- **双向**：支持私聊与群聊；群聊回复需要 @提及（可配置）。
- **流式回复**：长回答在同一消息上原地编辑（打字机效果）。
- **交互式选择**：`ask_user_question` / 菜单提示渲染为内联键盘按钮；点击即可回答问题。
- **媒体**：照片和文档自动下载到工作目录。
- **零运行时 HTTP 依赖**：基于全局 `fetch` 构建（Node ≥ 18 / ≥ 20）。

## 安装

```sh
dsh plugin --profile web add dsh-connect dsh-connect-telegram
```

## 配置

通过 [@BotFather](https://t.me/BotFather) 创建一个机器人并复制 token。追加到 profile 的 `cordis.patch.yml`：

```yaml
- insert:
    - id: connect-telegram
      name: dsh-connect-telegram
      config:
        botToken: "123456:ABC-YourBotToken"
        requireMention: true   # groups must @-mention the bot (default true)
        language: zh           # zh | en
```

token 也可以来自 `TELEGRAM_BOT_TOKEN` 环境变量。

## 工作原理

```
Telegram user ──getUpdates(long poll)──► dsh-connect-telegram ──InboundMessage──► dsh-connect (agent)
Telegram user ◄──sendMessage / editMessageText ◄────── dsh-connect (replies)
```

所有面向用户的字符串都通过核心的 i18n 层本地化（zh/en）；按聊天语言、通知级别、`/menu`、`/progress` 看门狗以及所有其他核心功能都与飞书一致。

## 配置参考

| 键 | 默认值 | 说明 |
|---|---|---|
| `botToken` | env `TELEGRAM_BOT_TOKEN` | BotFather 生成的 token |
| `requireMention` | `true` | 群聊：要求 @提及或回复机器人 |
| `language` | `zh` | 面向用户的消息语言 |
| `pollingTimeoutSeconds` | `50` | getUpdates 长轮询超时 |
| `baseUrl` | — | Bot API 基础地址覆盖（本地 Bot API 服务器） |
