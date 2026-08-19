# Telegram Bot 配置手册

本文说明如何创建 Telegram 机器人并与 `dsh-connect-telegram` 对接。

## 1. 创建机器人(BotFather)

1. 在 Telegram 里搜索并打开 **[@BotFather](https://t.me/BotFather)**。
2. 发送 `/newbot`,按提示输入机器人显示名称和用户名(必须以 `bot` 结尾)。
3. BotFather 返回一个 **HTTP API Token**,形如:

   ```
   1234567890:AAHf7xHfZxHfxxxxxxxxxxxxxxxxxxxxxxxxxx
   ```

4. 建议立即配置:
   - `/setcommands` — 设置命令列表(可选,便于用户发现 `/menu`、`/help` 等)
   - `/setprivacy` — 选择 **Disable**,否则群聊里机器人收不到非 @ 消息(我们的 `requireMention` 策略自己处理,建议保持 Enable 并用插件配置控制)

## 2. 把 Token 配置给插件

在 DSH profile 的 `cordis.patch.yml` 中:

```yaml
- insert:
    - id: connect-telegram
      name: dsh-connect-telegram
      config:
        botToken: "1234567890:AAHf7xHfZxHfxxxxxxxxxxxxxxxxxxxxxxxxxx"
        requireMention: true
        language: zh
```

或设置环境变量 `TELEGRAM_BOT_TOKEN`(两者都配置时,优先用 config)。

## 3. 与机器人对话

- **私聊**:直接给机器人发消息即可。
- **群聊**:默认需要 @ 机器人(或回复机器人的消息)才会响应;可通过 `requireMention: false` 改为群内所有消息都响应。

## 4. 验证

1. 重启 `dsh web`。
2. 给机器人发一条消息,应收到「✅ 已收到,开始处理」的即时确认,随后是流式回复。
3. 发 `/menu` 应弹出内联按钮菜单(按钮回调即 `ask_user_question`/菜单选择)。
4. 发一张图片,机器人应下载并(若主模型支持视觉)直接理解。

## 常见问题

| 现象 | 处理 |
|---|---|
| 机器人没反应 | 确认 token 正确、`dsh web` 已重启、profile 里插件已 insert |
| 群聊不响应 | 需要在群里 @ 机器人,或设 `requireMention: false` |
| 长轮询报错 | 网络问题会自动重试;确认机器没有防火墙拦截 `api.telegram.org` |
