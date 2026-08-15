# dsh-connect-feishu

[dsh-connect](https://www.npmjs.com/package/dsh-connect) 的 **飞书 / Lark 渠道适配器**：通过飞书开放平台**长连接（WebSocket）**接收消息，转发给 DSH Agent 处理，并把回复**流式**回写飞书，支持交互式菜单卡片。

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

| 键 | 默认 | 说明 |
|---|---|---|
| `appId` / `appSecret` | 环境变量 `FEISHU_APP_ID` / `FEISHU_APP_SECRET` | 飞书自建应用凭据 |
| `transport` | `websocket` | 长连接（无需公网）；`webhook` 需公网 HTTPS |
| `requireMention` | `true` | 群聊需 @机器人 才响应 |
| `dmMode` | `open` | 单聊策略：open / allowlist / pair / disabled |

飞书端还需：开通机器人能力、订阅 `im.message.receive_v1` 与 `card.action.trigger` 事件、发布应用版本。详见仓库文档 `docs/feishu-setup.md`。

## 完整文档

https://github.com/IvanWu2015/dsh-connect

## 许可

MIT
