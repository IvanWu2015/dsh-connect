# 快速开始

[English](QUICKSTART.md) | 中文

将 `dsh-connect` 接入现有的 DSH 安装，并开始在飞书中与智能体聊天。它分为两部分——**DSH 侧**和**飞书侧**——请按顺序完成。

## 0. 前置条件

- 已安装并运行 DSH（`dsh` 命令可用，`dsh web` 能启动）。
- 已创建飞书自建应用，手头有它的 **App ID**（`cli_xxx`）和 **App Secret**。

## 1. 构建插件包

```powershell
cd D:\ACOINFO\code\dsh_feishu
pnpm install
pnpm build
```

构建输出位于 `packages/connect/lib` 和 `packages/connect-feishu/lib`。

## 2. 将插件安装到 DSH profile

`dsh plugin` 会把参数转发给 profile 目录内的 pnpm，因此**本地路径必须是绝对路径**：

```powershell
dsh plugin --profile web add D:\ACOINFO\code\dsh_feishu\packages\connect D:\ACOINFO\code\dsh_feishu\packages\connect-feishu
```

（发布到 npm 后改用包名：`dsh plugin --profile web add dsh-connect dsh-connect-feishu`。）

## 3. 配置 profile 的 cordis.patch.yml

编辑 `%DSH_HOME%\profiles\web\cordis.patch.yml`（通常是 `C:\Users\you\.dsh\profiles\web\cordis.patch.yml`），把空数组 `[]` 替换为：

```yaml
- insert:
    - id: connect
      name: dsh-connect
    - id: connect-feishu
      name: dsh-connect-feishu
      config:
        appId: cli_yourAppId
        appSecret: yourAppSecret
        transport: websocket      # long connection, no public network needed
        requireMention: true      # groups need @mention
        dmMode: open              # DMs open
        # language: en            # user-facing message language: zh (default) / en
```

> 也可以不把凭据写进文件，改用环境变量 `FEISHU_APP_ID` / `FEISHU_APP_SECRET`，并在配置中省略 `appId`/`appSecret`。

## 4. 重启 dsh web

Host 插件只有在进程重启后才会加载：

1. 停止正在运行的 `dsh web`（在其终端按 `Ctrl+C`）。
2. 重新启动 `dsh web`。
3. 检查启动日志中是否有 `connect` / `connect-feishu` 的输出（或确认没有报错）。

## 5. 飞书侧配置（如果还没完成）

1. 飞书开放平台 → 你的应用 → **添加应用能力** → 添加**机器人**。
2. **权限管理** → 开通：`im:message`、`im:message.p2p_msg`、`im:message.group_msg`（或 `im:message.group_at_msg`）、`im:message:send_as_bot`。
3. **事件与回调 → 订阅** → 选择**"使用长连接接收事件"**，添加事件 **`im.message.receive_v1`**（长连接模式下无需回调 URL）。
4. **版本管理与发布** → 创建版本（包含机器人 + 权限 + 事件）→ 申请发布。

## 6. 测试

1. 把机器人加入群聊（或直接私聊它）。
2. 在群里**@提及机器人**（因为 `requireMention: true`）；私聊直接发送即可。
3. 发送一个任务（例如"列出当前目录下的文件"）——你应该会看到机器人先回复"Thinking…"，然后流式输出结果。

## 7. 故障排查

| 症状 | 修复方法 |
|---|---|
| 飞书完全不响应 | 确认版本已发布；群聊中 @提及机器人；确认已订阅 `im.message.receive_v1` |
| 启动报错 `connect-feishu: appId and appSecret are required` | 检查配置或环境变量 |
| "no adapter serves provider" | DSH 中未配置可用模型——先在 Web UI 的模型页面配置 DeepSeek 模型 |
| 希望群聊无需 @提及即可回复 | 设置 `requireMention: false`（注意：机器人随后会响应群里的每条消息） |
