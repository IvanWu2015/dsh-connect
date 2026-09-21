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
| `settingsStatePath` | Web 设置页的**回退**持久化文件路径（仅在宿主没有设置服务时使用）。正常情况下面板的权威存储是 `$DSH_HOME/settings.yaml` 的 `dsh-connect` 段 | 否 |

> **取值优先级（0.9.0 起）**：schema 默认值 → 插件配置（`cordis.patch.yml` 的 `dsh-connect` 块）→ `$DSH_HOME/settings.yaml` 的 `dsh-connect` 段。在 Web 设置面板或 `settings.yaml` 里改的值会**热重载**（原子写、文件锁、保留注释），手改 `settings.yaml` 无需重启即生效；插件配置不会被丢弃，它作为基础层参与合并。
>
> **密钥（`appSecret` / `clientSecret` / `botToken` / `secret` / `webhookUrl`）永远不写 `settings.yaml`，也不写任何 JSON 状态文件**——它们只进 DSH 凭据库；`settings.yaml` 里只有非密钥配置。

---

## 二、核心 `dsh-connect`（`ConnectConfig`）

| 键 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `agentPreset` | `string` | — | 智能体预设标识；解析失败时**尽力降级**（先试配置的 id，再试 `standard`／名单中第一个可挂载项，都不行则不带预设继续跑该轮，并记录日志） |
| `workDir` | `string` | — | 工作目录 |
| `workspaces` | `string[]` | `[]` | 额外工作区 |
| `visionModel` | `{provider, model}` | — | 视觉模型 |
| `language` | `string` | `"zh"` | 回复语言 |
| `allowUsers` | `string[]` | `[]` | 仅允许的用户 |
| `allowChats` | `string[]` | `[]` | 仅允许的会话 |
| `stateDir` | `string` | — | 状态目录 |
| `autoMirror` | `boolean` | `true` | 是否自动镜像 |
| `streamHeartbeatMs` | `number` | `60000` | 流式心跳间隔 |
| `notifyLevel` | `"full"|"important"|"result"` | `"result"` | 流式回复上报粒度 |
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

## 四、Web 设置（已完整实现：宿主 + 前端）

`dsh-connect` 通过宿主 RPC（通道 `/dsh-connect`，端点 `settings.get/save/status` + `credentials.save`）把上面的配置暴露给 Web 设置页。

**存储模型（0.9.0 起）**：非密钥设置的权威存储是 **`$DSH_HOME/settings.yaml` 的 `dsh-connect` 段**——通过 DSH 一方设置接缝注册（`installSection`，见 `src/settings/namespace.ts`），写入是热重载、原子、加文件锁、保留注释的，所以在面板里保存后**重启依然生效**，手改 `settings.yaml` 也无需重启即生效。插件自己的 `cordis.patch.yml` 配置不会作废，它作为基础层参与合并（schema 默认值 → 插件配置 → `settings.yaml`）。宿主没有设置服务时回退到 JSON 状态文件（`settingsStatePath`）和插件自身的组合入口。

**密钥只进 DSH 凭据库**（`credentials.save`），激活时由 `injectSecrets` 注入各渠道适配器（钉钉 stream 密钥嵌套进 `stream`）；`settings.yaml` 和 JSON 状态文件都不落密钥。

**面板 UI**：渠道 Tab 条 + 可折叠卡片（低频字段收在二级「高级」折叠里，保存/状态固定在底部）；每个凭据字段旁边有一行只读的 `当前值：…` 掩码预览（`未配置` 表示空），掩码在宿主侧生成。钉钉的两个传输方式（webhook 推送 / stream 模式）互为互斥的凭据**组**（组内 all-of，组间 any-of）；`web` 渠道没有任何凭据，按定义即为「已配置」。

<img src="../packages/connect/docs/images/settings-overview-zh.png" alt="dsh-connect Web 设置页：渠道 Tab 条 + 可折叠卡片" width="760">

<img src="../packages/connect/docs/images/settings-advanced-zh.png" alt="dsh-connect Web 设置页：二级「高级」折叠" width="760">

前端为 `packages/connect/client/`（`client.js` + `locale.mjs`，中英文都从中取词）。设计与实现过程见 `docs/all-in-one-and-web-settings.md`。
