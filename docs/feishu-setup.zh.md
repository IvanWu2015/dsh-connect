# 飞书开放平台配置手册

[English](feishu-setup.md) | 中文

本插件默认使用飞书**长连接（WebSocket）事件订阅**模式——无需公网 IP / 域名 / 隧道，事件在本地接收。**Webhook 模式也已实现**（见 [Webhook 传输](#webhook-传输)），供必须使用公网 HTTPS 回调地址的场景使用。

> **安装**：安装唯一的多合一插件——`dsh plugin --profile web add dsh-connect`——把该渠道的设置放在插件配置块的 `feishu` 名下（密钥可存 DSH 凭据库）。详见 [config-reference.md](config-reference.md)。

## 1. 创建自建应用

1. 打开[飞书开放平台](https://open.feishu.cn/) → 开发者后台 → **创建企业自建应用**。
2. 填写应用名称和图标（如 `DSH Assistant`）。
3. 进入应用 → **凭证与基础信息**：
   - 记下 **App ID**（`cli_xxx`）和 **App Secret**。
   - 将它们填入插件配置的 `appId` / `appSecret`（或使用环境变量 `FEISHU_APP_ID` / `FEISHU_APP_SECRET`）。

> **一键开通**：当配置和环境变量都没有提供凭据时，插件不会报错退出，而是进入扫码注册流程：在 `dsh web` 日志中打印一个二维码/链接（约 10 分钟有效）。用飞书扫码后，机器人应用会自动创建并预置好权限与事件订阅；返回的凭据保存到 `$DSH_HOME/.dsh-connect/feishu-credentials.json`（权限 `0600`），后续启动自动复用。

## 2. 开通机器人能力

- **添加应用能力** → 添加**机器人**。

## 3. 配置权限

在**权限管理**中开通并发布以下权限（至少前三个）：

| 权限 | 用途 |
|---|---|
| `im:message` | 读取消息内容（私聊 + 群聊） |
| `im:message.p2p_msg:readonly` 或 `im:message.p2p_msg` | 读取私聊消息 |
| `im:message.group_msg` | 读取群消息（读取全部群消息需要管理员审批；仅 @提及响应时 `im:message.group_at_msg` 即可） |
| `im:message:send_as_bot` | 以机器人身份发送消息 |
| `im:message`（上文已覆盖） | 同时支持下载用户发送的图片/文件/音频/视频——缺少它时图片接收会失败 |

> 注意：`im:message.group_msg`（读取全部群消息）需要管理员审批。对于"@提及触发响应"的机器人，`im:message.group_at_msg` 即可。

## 4. 事件订阅（长连接模式）

1. **事件与回调** → **事件配置** → 订阅方式 → 选择**"使用长连接接收事件"**。
2. 添加事件：**`im.message.receive_v1`**（接收消息）。
3. **添加事件：`card.action.trigger`（卡片按钮回调）**——交互式菜单（`/menu`、`/dir`、`/chat`、`/settings` 的按钮选择）依赖它；**没有它，点按钮毫无反应**。
4. 无需填写**请求网址**——长连接模式下 SDK 主动外连，不需要公网 URL、验证令牌或加密密钥（那些只用于 webhook 模式）。
5. 保存。

## 5. 创建版本并发布

1. **版本管理与发布** → **创建版本**，打包上面的权限、机器人能力与事件订阅。
2. 提交 → 由企业管理员审核并发布。
3. 发布后，把机器人加入目标群 / 私聊它。

## 6. 运行

```yaml
# the profile's cordis.patch.yml
- id: connect
  name: dsh-connect
  config:
    channels: [feishu]            # 启用飞书通道
    feishu:
      appId: cli_xxxx
      appSecret: cli_secret_xxxx
      transport: websocket          # long connection
      requireMention: true          # groups need @mention
      dmMode: open                  # DMs open
```

启动 `dsh web`；当日志显示连接成功后，就可以在飞书中聊天了。

## 7. 行为说明

- **群消息 @提及策略**：群消息只有 @提及机器人时才会回复（`requireMention` 默认 `true`）；设为 `requireMention: false` 则响应群里每条消息。
- **允许列表预过滤**：适配器在**下载任何消息资源之前**就执行 `allowUsers` / `allowChats` 检查——被拒绝的发送者的图片/文件不会落盘（核心服务之后会按完整策略再检查一遍）。
- **附件下载**：用户发送的图片/文件/音频/视频下载到系统临时目录（图片在 `dsh-connect-images`，其余在 `dsh-connect-files`）。单文件上限 20 MB、下载超时 60 秒；超过 24 小时的文件会自动清理。
- <a id="webhook-传输"></a>**Webhook 传输**：设置 `transport: webhook` 后，适配器自带 `node:http` 服务，监听 `webhookPort`（默认 `9000`）+ `webhookPath`（默认 `/`），经 SDK 的 `adaptDefault` + `autoChallenge` 自动应答 `url_verification` 挑战。把飞书回调地址指向能到达该端口的**公网 HTTPS** 地址即可。`verificationToken` / `encryptKey` 仅在 webhook 模式需要；长连接模式下忽略它们。

## 8. 常见问题

- **收不到消息**：确认版本已发布；群聊需要 @提及（或关闭 `requireMention`）；确认已订阅 `im.message.receive_v1`。
- **卡片按钮无响应**：确认已订阅 `card.action.trigger` 并发布新版本。
- **收不到图片（提示"图片下载失败"）**：
  - **旧版本 bug**：旧代码使用 `im.v1.image.get`（下载图片）获取用户消息中的图片，但飞书文档说明该接口**只能下载机器人自己上传的图片**。用户消息中的图片必须用"获取消息中的资源文件"——`im.v1.messageResource.get`（带 message_id + type=image）——否则返回 **HTTP 400**。请升级到修复后的版本。
  - **权限**：`messageResource.get` 需要 `im:message`（或 `im:message:readonly` / `im:message.history:readonly`）中的任意一个——见官方 API 文档的"权限要求"一节；**不存在 `im:resource` 权限**。缺少权限时，飞书返回业务错误 `99991672`，响应体中的 `error.permission_violations[]` 数组会精确列出缺少的权限——以它为准。在**权限管理**中开通所列权限，然后在**版本管理与发布**中**创建版本并发布**（企业自建应用需要管理员审批）。你也可以直接在 [API 调试台](https://open.feishu.cn/api-explorer) 用"获取消息中的资源文件"接口复现验证。
  - **在哪里看真实错误码**：在 `dsh web` 进程控制台日志中找 `connect-feishu: 图片下载失败 (...)` 一行（目前为本地化文案，意为"图片下载失败"）——聊天消息里也包含详情（修复版）。其他错误码（资源过期、file_key 无效等）参见 [飞书错误码 FAQ](https://open.feishu.cn/document/faq/trouble-shooting/how-to-fix-the-99991672-error) 和 API 文档。
- **3 秒超时重投**：长连接模式下事件必须在 3 秒内 ACK；SDK 内部处理。业务侧保持 `handleInbound` 快速返回（本插件将消息入队后立即返回；智能体处理在队列中异步进行，不受影响）。
- **多实例**：长连接是集群模式——同一应用有多个客户端时，每条消息只会随机被其中一个收到（本插件按单进程设计）。
