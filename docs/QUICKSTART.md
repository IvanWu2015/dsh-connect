# 运行指南（QUICKSTART）

把 `dsh-connect` 接入你已经装好的 DSH，并在飞书里和 Agent 对话。分「DSH 端」和「飞书端」两半，按顺序做。

## 0. 前置条件

- 已安装并能运行 DSH（`dsh` 命令可用，`dsh web` 能启动）。
- 已创建飞书自建应用，拿到 **App ID**（`cli_xxx`）与 **App Secret**。

## 1. 构建插件包

```powershell
cd D:\ACOINFO\code\dsh_feishu
pnpm install
pnpm build
```

构建产物在 `packages/connect/lib` 与 `packages/connect-feishu/lib`。

## 2. 把插件装进 DSH profile

`dsh plugin` 是把参数转发给 profile 目录里的 pnpm，所以**本地路径必须用绝对路径**：

```powershell
dsh plugin --profile web add D:\ACOINFO\code\dsh_feishu\packages\connect D:\ACOINFO\code\dsh_feishu\packages\connect-feishu
```

（发布到 npm 后可用包名代替路径：`dsh plugin --profile web add dsh-connect dsh-connect-feishu`）

## 3. 配置 profile 的 cordis.patch.yml

编辑 `%DSH_HOME%\profiles\web\cordis.patch.yml`（通常就是 `C:\Users\你\.dsh\profiles\web\cordis.patch.yml`），把空数组 `[]` 替换为：

```yaml
- insert:
    - id: connect
      name: dsh-connect
    - id: connect-feishu
      name: dsh-connect-feishu
      config:
        appId: cli_你的AppId
        appSecret: 你的AppSecret
        transport: websocket      # 长连接，无需公网
        requireMention: true      # 群聊需 @机器人
        dmMode: open              # 单聊开放
```

> 凭据也可以不写进文件，改用环境变量 `FEISHU_APP_ID` / `FEISHU_APP_SECRET`，然后在 config 里省略 `appId`/`appSecret`。

## 4. 重启 dsh web

Host 插件必须重启进程才被加载：

1. 关掉正在跑的 `dsh web`（在其终端按 `Ctrl+C`）。
2. 重新启动 `dsh web`。
3. 观察启动日志里出现 `connect` / `connect-feishu` 相关输出（或没有报错）。

## 5. 飞书端设置（若还没做）

1. 飞书开放平台 → 你的应用 → **添加应用能力** → 添加「**机器人**」。
2. **权限管理** → 开通：`im:message`、`im:message.p2p_msg`、`im:message.group_msg`（或 `im:message.group_at_msg`）、`im:message:send_as_bot`。
3. **事件与回调 → 订阅方式** → 选「**使用长连接接收事件**」，添加事件 **`im.message.receive_v1`**（长连接模式无需填回调 URL）。
4. **版本管理与发布** → 创建版本（带上机器人 + 权限 + 事件）→ 提交发布。

## 6. 测试

1. 把机器人拉进一个群（或直接和它单聊）。
2. 群里发消息时 **@机器人**（因为 `requireMention: true`）；单聊直接发。
3. 发一句任务（如「帮我看看当前目录有哪些文件」），应看到机器人先回「Thinking…」，随后流式输出结果。

## 7. 排查

| 现象 | 处理 |
|---|---|
| 飞书完全没反应 | 确认版本已发布；群里要 @机器人；确认订阅了 `im.message.receive_v1` |
| 启动报 `connect-feishu: appId and appSecret are required` | 检查 config 或环境变量是否填对 |
| 报「no adapter serves provider」 | DSH 里没配可用模型，先在 Web 界面的模型页配好 DeepSeek 模型 |
| 群里不 @ 也想要响应 | `requireMention: false`（注意这会让 bot 响应群里所有消息） |
