# Telegram Bot 配置手册

[English](telegram-setup.md) | 中文

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
   - `/setprivacy` — 保持 **Enable**(默认)即可:此时 Telegram 只把 @提及 / 回复 / 命令投递给机器人,足够支撑默认的 `requireMention: true` 策略。仅当你希望 `requireMention: false`(响应群内所有消息)时才设为 **Disable**,插件会在此基础上再应用自己的提及策略。

## 2. 把 Token 配置给插件

在 DSH profile 的 `cordis.patch.yml` 中。该插件会通过自身的 bundle 清单自动注册，因此这里只需要**覆盖（override）**它的配置——**不要**再用 `insert` 重新插入（重复的 `id` 会让 dsh 启动失败）:

```yaml
- id: connect-telegram
  name: dsh-connect-telegram
  config:
    botToken: "1234567890:AAHf7xHfZxHfxxxxxxxxxxxxxxxxxxxxxxxxxx"
    requireMention: true
    pollingTimeoutSeconds: 50   # getUpdates 长轮询超时(默认 50)
        language: zh
        # baseUrl: "http://localhost:8081"   # 可选:本地 Bot API 服务器
```

或设置环境变量 `TELEGRAM_BOT_TOKEN`(两者都配置时,优先用 config)。

## 3. 与机器人对话

- **私聊**:直接给机器人发消息即可。
- **群聊**:默认需要 @ 机器人用户名,或**回复机器人自己发的消息**才会响应;可通过 `requireMention: false` 改为群内所有消息都响应。回复普通用户的消息**不会**触发机器人。

## 4. 行为说明

- **长轮询**:适配器通过 Bot API `getUpdates` 长轮询接收更新(默认超时 50 秒,可用 `pollingTimeoutSeconds` 调整)。**机器人自己的消息会被忽略**(`is_bot` 过滤)——否则机器人每发一条确认/回复都会回环触发一次 agent。
- **流式回复**:通过 `editMessageText` 流式输出,该接口会**整体替换消息文本**,因此适配器累积全文并在每次刷新时发送完整内容(两次刷新间隔约节流到 700ms);文本超过 4096 字符时截断并带省略标记。消息使用 **HTML 解析模式**发送,普通文本中的 `&` `<` `>` 会被全部转义,不会破坏解析。
- **媒体**:支持下载图片、文件、语音、视频、音频并附加到 agent 任务;`edited_message` 更新被忽略(包括机器人自己的流式编辑)。
- **配置键**:`botToken`(或 `TELEGRAM_BOT_TOKEN`)、`requireMention`(默认 `true`)、`pollingTimeoutSeconds`(默认 `50`)、`baseUrl`(可选,如本地 Bot API 服务器)。

## 5. 验证

1. 重启 `dsh web`。
2. 给机器人发一条消息,应收到「✅ 已收到,开始处理」的即时确认,随后是流式回复。
3. 发 `/menu` 应弹出内联按钮菜单(按钮回调即 `ask_user_question`/菜单选择)。
4. 发一张图片,机器人应下载并(若主模型支持视觉)直接理解。

## 常见问题

| 现象 | 处理 |
|---|---|
| 机器人没反应 | 确认 token 正确、`dsh web` 已重启、profile 里插件已 insert |
| 群聊不响应 | 需要在群里 @ 机器人(或回复机器人自己的消息),或设 `requireMention: false` |
| 长轮询报错 | 网络问题会自动重试;确认机器没有防火墙拦截 `api.telegram.org` |
