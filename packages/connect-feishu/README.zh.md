# dsh-connect-feishu

[English](README.md) | 中文

面向 [dsh-connect](https://www.npmjs.com/package/dsh-connect) 的 **飞书 / Lark 渠道适配器**：通过飞书开放平台的**长连接（WebSocket）**接收消息，转发给 DSH 智能体，并将回复**流式**返回飞书，支持交互式菜单卡片。

## 安装

```sh
dsh plugin --profile web add dsh-connect dsh-connect-feishu
```

## 配置

在 DSH profile 的 `cordis.patch.yml` 中：

```yaml
- insert:
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
| `transport` | `websocket` | 长连接（无需公网）；`webhook` 需要公网 HTTPS |
| `requireMention` | `true` | 群聊中仅在 @机器人 时才会响应 |
| `dmMode` | `open` | 私聊策略：open / allowlist / pair / disabled |
| `language` | `zh` | 面向用户的消息语言：`zh` / `en` |

在飞书侧你还需要：启用机器人能力、订阅 `im.message.receive_v1` 和 `card.action.trigger` 事件、发布应用版本。参见仓库中的 `docs/feishu-setup.zh.md`。

## 文档

https://github.com/IvanWu2015/dsh-connect

## 许可

MIT
