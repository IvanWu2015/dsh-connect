# dsh-connect-dingtalk

[English](README.md) | 中文

面向 [dsh-connect](../connect/README.zh.md) 的钉钉群自定义机器人 Webhook 推送渠道。

钉钉**群自定义机器人**是一个*单向* webhook：它可以向群里发送文本 / markdown / @提及 消息，但**无法接收消息**（消息回调仅对内部企业应用开放）。因此，本包将**任务进度、结果与告警推送到钉钉群**——与双向的飞书 / Telegram 适配器形成天然互补。

- **推送文本与 markdown 卡片**到任意钉钉群。
- **@提及**成员：按手机号（钉钉的要求）或用户 id，或 @all。
- **可选签名密钥**（`SEC…`），用于安全设置后的机器人。
- **零运行时 HTTP 依赖**（使用全局 `fetch`）。

## 安装

```sh
dsh plugin --profile web add dsh-connect-dingtalk
```

## 配置

1. 在钉钉群中：**设置 → 群机器人 → 添加机器人 → 自定义机器人**。
2. 复制**Webhook 地址**（`https://oapi.dingtalk.com/robot/send?access_token=…`）；可选地启用**签名**并复制 `SEC…` 密钥。
3. 追加到 profile 的 `cordis.patch.yml`：

```yaml
- insert:
    - id: connect-dingtalk
      name: dsh-connect-dingtalk
      config:
        webhookUrl: "https://oapi.dingtalk.com/robot/send?access_token=xxx"
        secret: "SECxxx"        # only if signing is enabled
        language: zh            # zh | en
        # defaultAt:            # optional: @-mention on every push
        #   mobiles: ["13800000000"]
```

Webhook 地址也可以来自 `DINGTALK_WEBHOOK_URL` 环境变量（密钥通过 `DINGTALK_WEBHOOK_SECRET`）。

## 用法

插件注册了一个 Cordis 服务 `ctx.dingtalk`。其他插件或脚本可以向群内推送：

```ts
const dingtalk = ctx.get("dingtalk");
await dingtalk.sendMarkdown("任务完成", "**结果**：构建成功", { mobiles: ["13800000000"] });
await dingtalk.sendText("简单的文本通知");
```

`DingtalkWebhook` 也作为独立用法直接导出：

```ts
import { DingtalkWebhook } from "dsh-connect-dingtalk";
const webhook = new DingtalkWebhook({ webhookUrl, secret });
await webhook.sendMarkdown("标题", "正文", { all: true });
```

> 注意：如果你需要*双向*钉钉会话（用户发消息 → 智能体回复），那需要支持 Stream 模式的内部企业应用机器人——这里的发送层可以复用，但消息接收需要新的适配器。

## 配置参考

| 键 | 默认值 | 说明 |
|---|---|---|
| `webhookUrl` | env `DINGTALK_WEBHOOK_URL` | 钉钉群机器人 Webhook 地址 |
| `secret` | env `DINGTALK_WEBHOOK_SECRET` | 启用时的签名密钥（`SEC…`） |
| `language` | `zh` | 日志/错误语言 |
| `defaultAt` | — | 每次推送都应用的 `{ mobiles, userIds, all }` @提及 |
