# 钉钉群机器人(Webhook)配置手册

[English](dingtalk-setup.md) | 中文

本文说明如何创建钉钉群自定义机器人,并用 `dsh-connect-dingtalk` 把 DeepSeek Harness 的任务进度/结果推送到钉钉群。

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

在 DSH profile 的 `cordis.patch.yml` 中:

```yaml
- insert:
    - id: connect-dingtalk
      name: dsh-connect-dingtalk
      config:
        webhookUrl: "https://oapi.dingtalk.com/robot/send?access_token=xxxxxxxx"
        secret: "SECxxxxxxxx"        # 仅当启用加签时
        language: zh
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

## 4. 验证

1. 重启 `dsh web`。
2. 在任意脚本/插件里调用一次 `sendText("DSH 测试")`,群内应出现机器人消息。
3. 检查 `dsh web` 日志无 `connect-dingtalk: 推送失败`。

## 常见问题

| 现象 | 处理 |
|---|---|
| `errcode 310000 keywords not in content` | 正文未含自定义关键词;改用「加签」安全设置即可 |
| `errcode 330000` | 机器人被限流或群异常;稍后重试 |
| HTTP 401 | webhook token 失效;重新生成机器人 |
| 推送超时 | 检查本机到 `oapi.dingtalk.com` 的网络/代理 |

## 双向对话怎么做?

群自定义机器人无法接收消息。若需要「用户在钉钉发消息 → agent 回复」的双向体验,需要在钉钉开放平台创建**企业内部应用机器人**,使用 Stream 模式长连接(类似飞书)——这将是另一个 adapter;本包的发送层可直接复用。
