# dsh-connect 配置参考

> 目标：把「要记几十个键」简化成「只设**几个必须键**，其余用默认值」。用 **`dsh-connect`** 单插件，整个配置只有一个块。

## 一、推荐：最小配置（`dsh-connect`）

只装一个插件，只写一个块。**必须设的只有渠道凭据**，其余全部有默认值。

```json
{
  "dsh-connect": {
    "channels": ["feishu", "telegram"],
    "channelDefaults": { "language": "zh" },
    "feishu":   { "appId": "cli_xxxx", "appSecret": "REPLACE_ME" },
    "telegram": { "botToken": "123456:REPLACE_ME" }
  }
}
```

| 键 | 说明 | 必填 |
|---|---|---|
| `channels` | 启用哪些渠道（`feishu`/`telegram`/`dingtalk`/`web`）；不填=全部 | 否 |
| `channelDefaults` | 公共项，每个渠道继承，渠道自身覆盖（如共享 `language`） | 否 |
| `feishu`/`telegram`/`dingtalk`/`web` | 各自渠道的配置（见下方各渠道键） | 渠道启用时其凭据必填 |
| `settingsStatePath` | Web 设置页持久化非密钥设置的文件路径 | 否 |

---

## 二、核心 `dsh-connect`（`ConnectConfig`）

| 键 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `agentPreset` | `string` | — | 智能体预设标识 |
| `workDir` | `string` | — | 工作目录 |
| `workspaces` | `string[]` | `[]` | 额外工作区 |
| `visionModel` | `{provider, model}` | — | 视觉模型 |
| `language` | `string` | `"zh"` | 回复语言 |
| `allowUsers` | `string[]` | `[]` | 仅允许的用户 |
| `allowChats` | `string[]` | `[]` | 仅允许的会话 |
| `stateDir` | `string` | — | 状态目录 |
| `autoMirror` | `boolean` | `true` | 是否自动镜像 |
| `streamHeartbeatMs` | `number` | `60000` | 流式心跳间隔 |
| `notifyLevel` | `"none"|"progress"|"result"` | `"result"` | 流式回复上报粒度 |
| `progressTimeoutMs` | `number` | `300000` | 静默多久报一次进度 |

---

## 三、各渠道（子配置）

### `feishu`
| 键 | 说明 |
|---|---|
| `appId` / `appSecret` | **必填**，飞书应用凭据 |
| `transport` | 传输方式（长连接/webhook） |
| `verificationToken` / `encryptKey` | webhook 校验/加密 |
| `webhookPort` / `webhookPath` | webhook 监听 |
| `requireMention` | 是否需 @ 才响应 |
| `dmMode` | 私聊模式 |
| `threadIsolation` | 线程隔离 |
| `language` | 渠道默认语言 |

### `telegram`
| 键 | 说明 |
|---|---|
| `botToken` | **必填** |
| `language` / `requireMention` | |
| `pollingTimeoutSeconds` / `baseUrl` | 长轮询/代理 |

### `dingtalk`
| 键 | 说明 |
|---|---|
| `webhookUrl` / `secret` | webhook 推送机器人（**平铺**在 `dingtalk` 顶层） |
| `stream.clientId` / `stream.clientSecret` | **stream 双向模式**应用凭据（**嵌套在 `stream` 下**） |
| `stream.url` / `stream.requireMention` | stream 网关地址 / 是否需 @ 才响应 |
| `defaultAt.mobiles` / `defaultAt.userIds` / `defaultAt.all` | 推送默认 @ 目标 |
| `language` | 渠道默认语言 |

> 钉钉的 stream 密钥在配置与凭据库里都是**嵌套在 `stream` 下**的（不是平铺的 `clientId`），否则 stream 适配器收不到它们——`dsh-connect` 的 `injectSecrets` 已按此结构注入。

### `web`
| 键 | 说明 |
|---|---|
| `pollIntervalMs` | 轮询间隔 |

---

## 四、Web 设置（已实现：宿主侧完整，前端待联调）
`dsh-connect` 通过宿主 RPC（通道 `/dsh-connect`，端点 `settings.get/save/status` + `credentials.save`）把上面的配置暴露给 Web 设置页：非密钥字段写 JSON 状态文件（`settingsStatePath`），密钥写 DSH 凭据库（`credentials.save`），激活时由 `injectSecrets` 注入各渠道适配器（钉钉 stream 密钥嵌套进 `stream`）。前端 `client/settings-client.mjs`（React）需在 `dsh web` 内构建联调。见 `docs/all-in-one-and-web-settings.md`。
