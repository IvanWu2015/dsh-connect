# 钉钉群机器人(Webhook)配置手册

[English](dingtalk-setup.md) | 中文

本文说明如何创建钉钉群自定义机器人,并用 `dsh-connect-dingtalk`——它提供**单向推送服务**(`ctx.dingtalk`):其他插件或脚本可调用它把消息推送到钉钉群。

> **安装**:使用单插件合集——`dsh plugin add dsh-connect dsh-connect-all`——把该渠道的设置放在合集配置块的 `dingtalk` 名下(`webhookUrl`/`secret` 平铺,`clientId`/`clientSecret` 放在 `stream` 下)。密钥可存 DSH 凭据库。详见 [config-reference.md](config-reference.md)。单独的 `dsh-connect-dingtalk` 包也仍可独立使用。

> ⚠️ **本包不做什么**:没有**自动的任务进度/结果/告警推送钩子**(connect 核心不会自己向钉钉推送),没有 **`/dingtalk` 命令**,通道**不能接收消息**。任何"任务进度/结果/告警推送"场景都意味着其他插件或脚本主动调用 `ctx.dingtalk`。
>
> ⚠️ 群自定义机器人是**单向 Webhook**:只能发消息,不能接收用户消息。双向对话需要企业内部应用机器人(Stream 模式),见文末说明。

## 1. 创建群机器人

1. 打开目标钉钉群 → 右上角 **设置** → **机器人** → **添加机器人** → 选择「**自定义**」。
2. 填写机器人名称(如 "DSH 助手"),安全设置任选其一:
   - **自定义关键词**:如 `DSH` —— 之后每条消息正文必须包含该关键词
   - **加签**:勾选后生成 `SEC…` 开头的密钥(推荐,正文无需关键词)
   - **IP 地址段**:限制来源 IP
3. 创建完成后,得到 **Webhook 地址**,形如:

   ```
   https://oapi.dingtalk.com/robot/send?access_token=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
   ```

4. 若启用了加签,把 `SEC…` 密钥保存好。

## 2. 配置给插件

在 DSH profile 的 `cordis.patch.yml` 中。该插件会通过自身的 bundle 清单自动注册，因此这里只需要**覆盖（override）**它的配置——**不要**再用 `insert` 重新插入（重复的 `id` 会让 dsh 启动失败）:

```yaml
- id: connect-dingtalk
  name: dsh-connect-dingtalk
  config:
    webhookUrl: "https://oapi.dingtalk.com/robot/send?access_token=xxxxxxxx"
    secret: "SECxxxxxxxx"        # 仅当启用加签时
    language: zh
    # defaultAt: { mobiles: ["13800000000"] }   # 可选:每次推送默认 @ 的人
```

或设置环境变量 `DINGTALK_WEBHOOK_URL`(加签密钥用 `DINGTALK_WEBHOOK_SECRET`)。

## 3. 推送消息

插件提供 Cordis 服务 `ctx.dingtalk`,其他插件/脚本可直接调用:

```ts
const dingtalk = ctx.get("dingtalk");
// markdown 卡片(正文需含自定义关键词,若使用关键词安全设置)
await dingtalk.sendMarkdown("任务完成", "**结果**：构建成功", { mobiles: ["13800000000"] });
// 纯文本
await dingtalk.sendText("DSH 任务已开始");
```

- **@ 指定人**:用 `{ mobiles: ["手机号"] }`(钉钉 Webhook 只认手机号)或 `{ userIds: [...] }`;`{ all: true }` 表示 @所有人。
- **关键词安全设置**:若选择了「自定义关键词」,markdown 的**正文**(`text` 字段)必须包含该关键词,否则钉钉返回 `errcode 310000`。选择「加签」则无此限制。

## 4. 行为说明

- **加签**:配置 `secret`(`SEC…`)后,每次请求按 `HMAC-SHA256(timestamp + "\n" + secret)` 签名,base64 编码后**再做 URL 编码**,连同 `timestamp` 作为 `sign` 查询参数发送。
- **重试**:瞬时**网络错误**与钉钉 `errcode 130101`(每个机器人 20 次/分钟的频控)会自动退避重试(1s / 2s / 4s,频控额外等 10s),最多共 **3 次**。
- **正文长度**:markdown 正文超过 **20000 字符**会在发送前自动截断(带省略标记)。
- **配置键**:`webhookUrl`(或 `DINGTALK_WEBHOOK_URL`)、`secret`(或 `DINGTALK_WEBHOOK_SECRET`,可选)、`language`、`defaultAt`(可选,每次推送默认合并的 @ 列表)。

## 5. 验证

1. 重启 `dsh web`。
2. 在任意脚本/插件里调用一次 `sendText("DSH 测试")`,群内应出现机器人消息。
3. 检查 `dsh web` 日志无 `connect-dingtalk: 推送失败`。

## 常见问题

| 现象 | 处理 |
|---|---|
| `errcode 310000 keywords not in content` | 正文未含自定义关键词;改用「加签」安全设置即可 |
| `errcode 130101` | 被频控(20 次/分钟);会自动退避重试 |
| `errcode 330000` | 机器人被限流或群异常;稍后重试 |
| HTTP 401 | webhook token 失效;重新生成机器人 |
| 推送超时 | 检查本机到 `oapi.dingtalk.com` 的网络/代理 |

## 双向对话怎么做?

群自定义机器人无法接收消息。若需要「用户在钉钉发消息 → agent 回复」的双向体验,需要在钉钉开放平台创建**企业内部应用机器人**,使用 Stream 模式长连接(类似飞书)——这将是另一个 adapter;本包的发送层可直接复用。
