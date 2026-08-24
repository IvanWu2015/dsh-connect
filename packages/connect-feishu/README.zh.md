# dsh-connect-feishu

[English](README.md) | 中文

面向 [dsh-connect](https://www.npmjs.com/package/dsh-connect) 的 **飞书 / Lark 渠道适配器**：通过飞书开放平台的**长连接（WebSocket）**或自建 **webhook** 端点接收消息，转发给 DSH 智能体，并将回复**流式**返回飞书，支持交互式菜单卡片。

## 安装

```sh
dsh plugin --profile web add dsh-connect dsh-connect-feishu
```

## 配置

在 DSH profile 的 `cordis.patch.yml` 中。这些插件会通过各自的 bundle 清单自动注册，因此这里只需要**覆盖（override）**它们的配置——**不要**再用 `insert` 重新插入（重复的 `id` 会让 dsh 启动失败）：

```yaml
- id: connect
  name: dsh-connect
- id: connect-feishu
  name: dsh-connect-feishu
  config:
    appId: cli_xxx
    appSecret: cli_secret_xxx
    transport: websocket
    requireMention: true
    dmMode: open
```

| 键 | 默认值 | 说明 |
|---|---|---|
| `appId` / `appSecret` | env `FEISHU_APP_ID` / `FEISHU_APP_SECRET` | 飞书自建应用凭据 |
| `transport` | `websocket` | 长连接（无需公网）；`webhook` 运行内置 HTTP 服务，需要公网 HTTPS |
| `verificationToken` | — | Webhook 验证令牌（仅 webhook 传输） |
| `encryptKey` | — | Webhook 加密密钥（仅 webhook 传输） |
| `webhookPort` | `9000` | `transport: "webhook"` 时内置 webhook 服务的 HTTP 端口 |
| `webhookPath` | `/` | 飞书事件回调所 POST 的 URL 路径（webhook 传输） |
| `requireMention` | `true` | 群聊中仅在 @机器人 时才会响应 |
| `dmMode` | `open` | 私聊策略：open / allowlist / pair / disabled |
| `language` | `zh` | 面向用户的消息语言：`zh` / `en` |

在飞书侧你还需要：启用机器人能力、订阅 `im.message.receive_v1` 和 `card.action.trigger` 事件、发布应用版本。参见仓库中的 `docs/feishu-setup.zh.md`。

## 文档

https://github.com/IvanWu2015/dsh-connect

## 许可

MIT
