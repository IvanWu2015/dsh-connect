# 飞书开放平台配置手册

本插件默认使用飞书「**长连接（WebSocket）事件订阅**」模式 —— 无需公网 IP / 域名 / 内网穿透，本地即可接收事件回调。

## 1. 创建自建应用

1. 打开 [飞书开放平台](https://open.feishu.cn/) → 「开发者后台」→「创建企业自建应用」。
2. 填应用名称、图标（如 `DSH 助手`）。
3. 进入应用 → 「凭证与基础信息」：
   - 记下 **App ID**（`cli_xxx`）与 **App Secret**。
   - 这两个值填入插件配置的 `appId` / `appSecret`（或环境变量 `FEISHU_APP_ID` / `FEISHU_APP_SECRET`）。

## 2. 开通机器人能力

- 「添加应用能力」→ 添加「**机器人**」。

## 3. 配置权限

在「权限管理」里开通并发布以下权限（至少前三条）：

| 权限 | 用途 |
|---|---|
| `im:message` | 获取消息内容（单聊+群聊） |
| `im:message.p2p_msg:readonly` 或 `im:message.p2p_msg` | 读取单聊消息 |
| `im:message.group_msg` | 读取群消息（若需「群聊全响应」需管理员审批；仅 @bot 响应也建议开通 group_at） |
| `im:message:send_as_bot` | 以机器人身份发消息 |
| **`im:resource`** | **下载用户发送的图片 / 文件 / 音视频（接收图片必需，不开则图片下载失败）** |

> 提示：`im:message.group_msg` 的「读取群聊全部消息」需要管理员审批；只做「@机器人触发」用 `im:message.group_at_msg` 即可。

## 4. 事件订阅（长连接模式）

1. 「事件与回调」→「事件配置」→「订阅方式」选择「**使用长连接接收事件**」。
2. 添加事件：**`im.message.receive_v1`**（接收消息）。
3. **添加事件：`card.action.trigger`（卡片按钮回调）** —— 交互式菜单（`/menu`、`/dir`、`/chat`、`/settings` 的按钮点选）靠它回传，**不订阅则按钮点了没反应**。
4. 无需填写「请求地址」——长连接模式由 SDK 主动建连，不需要公网 URL，也不需要 verification token / encrypt key（这两个仅 webhook 模式使用）。
5. 保存。

## 5. 创建版本并发布

1. 「版本管理与发布」→「创建版本」，把上面的权限、机器人、事件订阅一起打包。
2. 提交 → 由企业管理员审核发布。
3. 发布后，把 bot 添加到目标群 / 与 bot 单聊即可。

## 6. 运行

```yaml
# profile 的 cordis.patch.yml
- id: connect
  name: dsh-connect
- id: connect-feishu
  name: dsh-connect-feishu
  config:
    appId: cli_xxxx
    appSecret: cli_secret_xxxx
    transport: websocket          # 长连接
    requireMention: true          # 群聊需 @机器人
    dmMode: open                  # 单聊开放
```

启动 `dsh web` 后，日志出现连接成功即可在飞书对话。

## 7. 常见问题

- **收不到消息**：确认版本已发布；群聊需 @机器人（或关闭 `requireMention`）；确认订阅了 `im.message.receive_v1`。
- **点卡片按钮没反应**：确认订阅了 `card.action.trigger` 事件并重新发版。
- **3 秒超时重推**：长连接模式下事件需在 3 秒内 ACK；SDK 内部已处理，业务侧保持 `handleInbound` 快速返回（本插件把消息入队即返回，Agent 处理在队列里异步进行，不受此限制）。
- **多实例**：长连接为集群模式，同一应用多客户端只有随机一个收到消息（本插件按单进程设计）。
- **webhook 模式**：如需公网回调，把 `transport: webhook` 并配 `verificationToken` / `encryptKey`，同时需要一个本地 HTTP 服务承接 SDK 的 express 适配器（本阶段未内置 HTTP 服务，优先用长连接）。
