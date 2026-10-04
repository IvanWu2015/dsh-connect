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
| `settingsStatePath` | Web 设置页的**回退**持久化文件路径（仅在宿主没有设置服务时使用）。正常情况下面板的权威存储是当前 profile patch 中本插件的条目 | 否 |

> **取值优先级（0.9.2 起）**：schema 默认值 → 插件被组合进来时的配置（继承条目）→ 当前 profile patch（`cordis.patch.yml`）中本插件的条目。面板保存与手改这个条目是同一件事，写入**热重载**（原子写、文件锁、保留注释），无需重启即生效。
>
> 一句例外：**渠道设置**热重载，**通用设置**（语言、工作目录、白名单、预设等）写进的是同一个条目，但那些值在插件加载时已被读走，所以要**重启 `dsh`** 才生效——见第二、四节。
>
> 面板能编辑的字段在 schema 里声明为 `volatile`，所以保存是就地 reconcile（运行中的适配器直接在下一轮采用新值），而不是重挂载。保存只会投影到已声明的字段上，因此未声明的键（凭据、`settingsStatePath`、你自己加的键）既写不进去，也不会被清掉；但**被省略的已声明字段会被重置回继承值**，所以每次写入的都是完整的已声明段。
>
> **密钥（`appSecret` / `clientSecret` / `botToken` / `secret` / `webhookUrl`）永远不写进 profile patch，也不写任何 JSON 状态文件**——它们只进 DSH 凭据库；patch 条目里只有非密钥配置。
>
> 0.2 之前面板的存储是 `$DSH_HOME/settings.yaml` 的 `dsh-connect` 段；升级到 0.9.2 时该段会被读取一次并合并进 patch 条目（见插件 README 的「从 0.9.0 升级」）。

---

## 二、核心 `dsh-connect`（`ConnectConfig`）

**「通用设置」列**标 ✅ 的键，可以直接在 Web 设置页的**通用设置**视图里读改（1.0.2 起），不必再手写配置或用聊天命令。未标 ✅ 的两个是刻意留在面板外的：`visionModel` 是对象而不是简单标量，`stateDir` 属于高级/回退路径。

| 键 | 类型 | 默认值 | 通用设置 | 说明 |
|---|---|---|---|---|
| `agentPreset` | `string` | — | ✅ | 智能体预设标识；解析失败时**尽力降级**（先试配置的 id，再试 `standard`／名单中第一个可挂载项，都不行则不带预设继续跑该轮，并记录日志） |
| `workDir` | `string` | — | ✅ | 工作目录 |
| `workspaces` | `string[]` | `[]` | ✅ | 额外工作区（面板里一行一个目录） |
| `visionModel` | `{provider, model}` | — | — | 视觉模型 |
| `language` | `string` | `"zh"` | ✅ | 回复语言 |
| `allowUsers` | `string[]` | `[]` | ✅ | 仅允许的用户（面板里一行一个，留空=全部放行） |
| `allowChats` | `string[]` | `[]` | ✅ | 仅允许的会话（面板里一行一个，留空=全部放行） |
| `stateDir` | `string` | — | — | 状态目录 |
| `autoMirror` | `boolean` | `true` | ✅ | 是否自动镜像 |
| `streamHeartbeatMs` | `number` | `60000` | ✅ | 流式心跳间隔 |
| `notifyLevel` | `"full"|"important"|"result"` | `"result"` | ✅ | 流式回复上报粒度 |
| `progressTimeoutMs` | `number` | `300000` | ✅ | 静默多久报一次进度 |

> **面板改了要重启 `dsh` 才生效。** 核心配置在插件加载时只解析一次，`AgentRunner` 构造时就把其中几项拷成了实例字段，所以通用设置里每一项的说明都写着「修改后需重启 dsh 才生效」——这是当前实现的真实行为，不是文案保守。渠道设置（凭据、`requireMention` 等）走的是同一条保存缝，但那是**热重载**的，改完即生效；两边的差别在面板上各自的说明里写明了。
>
> **被 `dsh.shared.config.json` 压过的键**（`workDir` / `language` / `autoMirror`）在面板里照常可编辑，但若共享配置确实设了它，字段上方会多出一条来源提示，说明此处修改不会生效。`workspaces` 不走这个机制：共享配置对它是**追加合并**（与 `additionalWorkspaces` 合并）而非覆盖，所以面板的修改确实有效，它带的是静态说明。

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

> **一键创建（1.0.0；1.0.2 起位于卡片正文最顶端）**：设置页的飞书卡片里有一个「一键创建并配置飞书机器人」按钮，走飞书官方的 OAuth 2.0 设备授权流（`@larksuiteoapi/node-sdk` 的 `registerApp`）：点一下 → 在浏览器里确认 → 应用建好、权限（收发/读历史消息、`im.message.receive_v1` 事件）配好、凭据存进 DSH 凭据库，并把 `feishu` 写进 `channels`、把 `transport` 定为 `websocket`（长连接，不需要公网地址）。展开飞书卡片，第一眼看到的就是它。
>
> 它**不**替你做全部事情，面板会逐条列出真实结果：应用已创建 / 凭据已入库 / 渠道已启用 / 运行中的渠道是否就地重载 / 事件订阅是 `applied`、`failed`、`skipped` 还是 `not-attempted` / 还剩什么要人工去开放平台收尾。**「凭据已写入凭据库」和「运行中的渠道没有重新加载」是两行**，后者请重启 `dsh` 后确认。事件订阅的 PATCH 可能被平台拒绝（SDK 注明「仅支持更新开发者后台创建的自建应用」，而 `registerApp` 走的渠道 SDK 未说明），也可能返回 200 却未真正生效（多数项要「提交发布」并审核），所以这一步永远是尽力而为，`dsh-connect` 不代你发布。
>
> 这条路径只对**有真人在看的 Web 设置页**开放。CLI 启动路径（`dsh` 直接跑，以及没有 TTY 的 `dsh web`）仍然记录 `onboardingSkipped` 直接返回（TTY 闸门见 `channels/feishu/index.ts:110`），这是有意的，不要「修好」它。
>
> **Telegram 和钉钉没有对应的官方「创建机器人」API**，所以它们的卡片里只放一个指向官方创建入口的链接（`https://t.me/BotFather` / `https://open-dev.dingtalk.com/`）和一句「把拿到的凭据粘到下面的字段里」——和飞书一样放在卡片正文顶端（1.0.2 起）。这两个渠道的配置方式与以前完全一样，没有自动化的部分。

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

**存储模型（0.9.2 起）**：非密钥设置的权威存储是**当前 profile patch 中本插件的条目**（`profileContext.patchPath`，即 `cordis.patch.yml`）——通过 DSH 一方 `settings` 服务（`SettingsForms`）写入，热重载、原子、加文件锁、保留注释，所以在面板里保存后**重启依然生效**，手改同一条目也无需重启即生效。取值顺序为 schema 默认值 → 插件被组合进来时的配置（继承条目）→ profile patch 条目。面板能编辑的字段声明为 `volatile`，保存因此是就地 reconcile 而非重挂载；写入前会投影到已声明字段上（且因为省略的已声明字段会被重置，每次写入都是完整的已声明段）。宿主没有 settings 服务时回退到 JSON 状态文件（`settingsStatePath`）和插件自身的组合入口。

**密钥只进 DSH 凭据库**（`credentials.save`），激活时由 `injectSecrets` 注入各渠道适配器（钉钉 stream 密钥嵌套进 `stream`）；profile patch 和 JSON 状态文件都不落密钥。

> 0.9.0/0.9.1 的权威存储是 `$DSH_HOME/settings.yaml` 的 `dsh-connect` 段。DSH 0.2 不再把插件设置放在那个文档里，所以升级到 0.9.2 时该段会被读取一次、投影到已声明字段后**合并**进 patch 条目（`.dsh-connect-legacy-imported` 标记记录结果，写在 profile 条目旁），详见插件 README 的「从 0.9.0 升级」。

**面板 UI（两级）**：顶部是**主导航**——**通用设置**在前、**机器人渠道**在后，两视图互斥渲染，底部的保存/状态栏两边共用。打开时**默认停在「机器人渠道」**，这样一键创建按钮零点击可达；导航顺序与落点不一致是有意的（按钮在那里），不要「顺手调正」。

- **通用设置**：就是上表标 ✅ 的那 10 个键，分四组卡片（语言/通知与进度、工作目录/工作区、访问控制、智能体）。改完**必须重启 `dsh`** 才生效（原因见上表下方那条说明），每个字段的说明里都写着。被 `dsh.shared.config.json` 压过的键会额外显示一行来源提示。最上面还有一行**只读**的当前模型（`provider / model`），提示「此值由 DSH 管理，请在 DSH 里切换」——面板**刻意不做**模型写入口（`saveSelection()` 存在且可写，但改写会波及其他会话）；宿主读不到当前选择时整行不渲染。
- **机器人渠道**：渠道 Tab 条 + 可折叠卡片（低频字段收在二级「高级」折叠里，保存/状态固定在底部）；每个凭据字段旁边有一行只读的 `当前值：…` 掩码预览（`未配置` 表示空），掩码在宿主侧生成。钉钉的两个传输方式（webhook 推送 / stream 模式）互为互斥的凭据**组**（组内 all-of，组间 any-of）；`web` 渠道没有任何凭据，按定义即为「已配置」。

**1.0.0 起**：设置项一律**单列**（`grid-template-columns:minmax(0,1fr)`，一行一个，不再按宽度自动排 2–3 列）；页签/导航条 `position:sticky` 钉在滚动区顶部、正文从它下面滚过去（1.0.2 的导航条与渠道 Tab 条是两层粘贴，偏移量各有不同，所以滚到卡片中部时两层都还在）。**1.0.2 起**：飞书卡片正文的最顶端就是「一键创建并配置飞书机器人」按钮，App ID / App Secret 排在它**下面**——先给一键路径，再给手填路径，不让人填完才发现有自动的。

<img src="../packages/connect/docs/images/settings-overview-zh.png" alt="dsh-connect Web 设置页：顶部主导航 + 渠道 Tab 条 + 可折叠卡片，字段单列" width="760">

<img src="../packages/connect/docs/images/settings-general-zh.png" alt="dsh-connect Web 设置页：通用设置视图（四组卡片，字段单列，每项标注重启后生效）" width="760">

<img src="../packages/connect/docs/images/settings-general-agent-zh.png" alt="dsh-connect Web 设置页：通用设置里的只读模型行与智能体分组" width="760">

<img src="../packages/connect/docs/images/settings-feishu-zh.png" alt="dsh-connect Web 设置页：飞书卡片的凭据字段（一键创建按钮在它们上方，滚动后两层导航仍钉在顶部）" width="760">

<img src="../packages/connect/docs/images/settings-advanced-zh.png" alt="dsh-connect Web 设置页：二级「高级」折叠" width="760">

前端为 `packages/connect/client/`（`client.js` + `locale.mjs`，中英文都从中取词）。设计与实现过程见 `docs/all-in-one-and-web-settings.md`。
