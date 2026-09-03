# 配置简化 + Web 设置 + 多合一重构（对齐 dsh-im）

> **当前状态更新（2026-08-31）**：本仓库已按**方案 B（吸收进核心）**完成最终实现——`dsh-connect` 现在是**唯一的包**：核心 connect 服务、全部通道适配器（feishu / telegram / dingtalk / web）与 Web 设置栈全部内置，通过 `channels` 选择器启用。此前的拆分包（`dsh-connect-feishu` / `dsh-connect-telegram` / `dsh-connect-dingtalk` / `dsh-connect-web`）与聚合包（`dsh-connect-all`，即方案 A）均已被删除。下文是设计决策与实施过程的**历史记录**，不代表当前架构；安装与配置请以根 `README.md` / `docs/config-reference.md` 为准。

> 结论先行：**参考 xmanrui/dsh-im 的「单插件、单一设置入口、Web 可视化配置、凭据入库、多渠道多机器人」模型**是正确方向。dsh-connect 目前的「每渠道一个包、逐包安装、YAML 配置一把梭」确实复杂。但 dsh-im 是 v4 成熟版、自带完整的 client/server 双端 Web 插件，全部复刻是一次不小的工程。下面给出诊断、目标形态、落地路径与取舍。


## 零、TL;DR（给决策者的结论）

**最终采用 方案 B（吸收进核心，已完整实现并验证）**：把 feishu / telegram / dingtalk / web 的通道适配器收进 `dsh-connect` 包内，按 `channels` 选择器按需激活；`dsh-connect` 现在是**唯一的包**，核心 connect 服务、全部通道适配器与 Web 设置栈全部内置。

为何选 B：一个插件、一份配置（`channels` + `channelDefaults` + 各通道子键），按 `channels` 显式激活启用的通道（`channels: ["feishu","dingtalk"]`），未启用的通道不启动；它还提供**单一 `/dsh-connect` 设置入口**，镜像 dsh-im 的单入口模型，Web 端只出现一次「连接设置」。代价是核心包包含全部渠道 SDK（见下文「方案 B」依赖膨胀风险），且拆分包与聚合包（方案 A）均已删除。

**现在能拿到什么（全部通过 `node scripts/verify.mjs`，全绿）：**
- 一份配置（`channels` + `channelDefaults` + N 个渠道块）启用任意渠道组合；渠道失败隔离、渠道级配置透传。
- Web 可视化设置：`/dsh-connect` RPC（`settings.get/save/status` + `credentials.save`）+ JSON 持久化 + DSH 凭据库读写，配置与凭据**读写闭环**（round-trip 已验证）。
- 凭据从配置挪到凭据库：面板写密钥 → 激活时 `injectSecrets` 注入各渠道适配器（非侵入，渠道适配器零改动）。
- 一键发布：`files` 含 client/examples、`prepack` 自动重建、入口解析 OK；57 项测试 + core 57 + feishu 16 + smoke 全绿。

**还差什么（需要你/本机，沙箱内无法验证）：**
1. `dsh web` 内构建并渲染前端 `settings-client` 组件（沙箱禁 Vite/子进程、无真实 `dsh web`）。
2. 推送 v0.7.2：需有效 GitHub 凭据（当前 git-credential-manager 在沙箱崩溃、推送被拒）。

## 1. 现状：配置与安装复杂度

当前模型是「核心 + 每渠道一个插件」：

| 包 | 职责 | 配置字段数 | 备注 |
| --- | --- | --- | --- |
| `dsh-connect` | 核心 `connect` 服务 | 12 | agentPreset / workDir / workspaces / visionModel / language / allowUsers / allowChats / stateDir / autoMirror / streamHeartbeatMs / notifyLevel / progressTimeoutMs |
| `dsh-connect-feishu` | 飞书适配器 | ~11 | appId / appSecret / transport / verificationToken / encryptKey / webhookPort / webhookPath / requireMention / dmMode / threadIsolation / language |
| `dsh-connect-telegram` | Telegram 适配器 | 5 | botToken / language / requireMention / pollingTimeoutSeconds / baseUrl |
| `dsh-connect-dingtalk` | 钉钉适配器 | 12 | webhookUrl / secret / language / defaultAt / mobiles / userIds / all / stream / clientId / clientSecret / url / requireMention |
| `dsh-connect-web` | Web mirror | — | 复用 Web GUI |

**问题：**
1. **安装多**：要用飞书+钉钉，得 `dsh plugin add dsh-connect dsh-connect-feishu dsh-connect-dingtalk`；换渠道要再装一个包。
2. **配置散**：每个渠道各自的 YAML 键位不同（`appId/appSecret` vs `botToken` vs `clientId/clientSecret`），核心加渠道加起来 20~30 个键。
3. **Secret 平铺在配置**：secret 类字段直接写在配置文件里（虽标了 `role("secret")`），没有走真正的凭据库。
4. **无 Web 设置入口**：只能手写 `dsh.shared.config.json` / cli，用户要在文档/示例里猜。

## 2. 目标形态（对齐 dsh-im）

**一个插件、一个设置入口，多渠道统一管理，Web 可视化配置，凭据入库。**

- 单插件（就是把渠道吸收进 `dsh-connect`，做成一个多合一包），一个 `dsh plugin add dsh-connect` 装完。
- Web 设置页「设置 → 通道」：按渠道分 Tab，每个通道可加**多个机器人**；每个机器人卡片配工作区、Agent Preset、通知/进度、访问模式（白名单）等。
- 连接方式走 QR 扫码 / App Manifest / 手工凭据（复用现有 `onboard.ts` 的扫码流并扩展到各渠道）。
- Secret 只写本地 Harness 凭据存储，不写进普通配置；状态接口只回传脱敏信息。
- 每个机器人独立工作区、会话、绑定；会话绑定按 channel+chatKey，多机器人互不干扰。

## 3. 关键：DSH 宿主的 Web 设置插件机制（已在本机确认存在）

参考仓库 `plugin-src/client/index.js` 已经给出标准做法，我在 DSH 宿主里也确认了这些 API 真实存在：

1. **设置页入口**：客户端插件用 `ctx.slots.inject('settings.section', () => ctx.slots.register({
     name:'settings.section', id:'dsh-connect', order:21, label, locale, inject: () => ({...rpcCalls})
   }))` 注册「设置 → 通道」。
2. **前后端通信**：前端 `ctx.connection.rpc.call('<通道>', endpoint, payload, signal)`；宿主插件注册 RPC 通道，处理读写配置/凭据/重启等。
3. **凭据库**：secret 走宿主凭据存储（dsh-im 写明「Device Token 只写入 Harness 凭据存储」），普通配置只保留非敏感 id。
4. **Web 镜像**：`web` 通道已存在复用关系。

## 4. 三种「多合一」打包方案对比

| 方案 | 做法 | 优点 | 缺点 | 工作量 |
| --- | --- | --- | --- | --- |
| **A. 聚合包** `dsh-connect-all` | 新包只依赖并加载 4 个渠道 + 核心，`inject` 全部注册 | 改动最小、可回退、兼容现有包；一个命令装完 | 仍是 4 个包的依赖树，安装体积偏大；渠道代码不合并 | 小 |
| **B. 吸收进核心**（推荐） | 把 feishu/telegram/dingtalk/web 的 adapter 收进 `dsh-connect` 包内，按配置/凭据按需激活 channel | 真正单插件、单依赖；无用渠道不启动 | 核心包变大；需处理可选依赖与按需加载；破坏现有拆分包 | **大** |
| **C. 双轨** | 保留拆分包，另发布聚合包（A），Web 设置覆盖聚合包 | 平衡；老用户无破坏 | 两套安装路径并存，维护成本高 | 中 |

**取舍分析：**
- dsh-im 走的是 B（一个插件内置 9 渠道，依赖项里直接带 qqbot/wecom/dingtalk 等 SDK）。它接受「装一个包、全渠道依赖都进来」的体积。
- 对 dsh-connect 而言，**渠道 SDK 各不相同且较重**（飞书 SDK、telegram bot api、钉钉 stream）。用户**只用钉钉**就不该背飞书+telegram 的依赖。所以**纯 B 有依赖膨胀风险**。
- → 更优做法：**A + 按需加载**。`dsh-connect-all` 把各渠道作为**可选依赖/peer 依赖**，通过 config 显式声明启用哪些 channel（`channels: ["feishu","dingtalk"]`），只 activate 启用的；未启用的 SDK 不 require。可选依赖装不完时，仅对应渠道不可用并给出明确提示，不影响其他渠道。

## 5. 落地路径（建议顺序）

### 阶段一：配置简化 + 统一命名空间（低风险，先做）
- 核心与渠道统一一个 `channels` 命名空间：`dsh-connect` 配置里支持 `channels: { feishu: {...}, dingtalk: {...} }`，把渠道的 appId/token 等收进来。
- 收敛重复项：`language`、`requireMention`、`dmMode` 等以「核心默认 + 渠道覆盖」合并。
- 默认值文档化，去掉「两个字段语义重复」（`notifyLevel` 注释里出现两行重复说明）。
- 提供一份**最小可用示例**（`examples/`）代替现在的多键样板。

### 阶段二：聚合包 `dsh-connect-all`（中风险）
- 新建聚合插件，`inject` 全部渠道；config 用 `channels` 数组控制启用。
- 保留拆分包；聚合包只是省安装。验证：构建 + 单测 + smoke。

### 阶段三：Web 设置页（大，需 DSH host + 前端）
- 客户端插件注册 `settings.section`（对标 dsh-im），宿主插件注册 RPC（读写配置/凭据）。
- 前端渠道 Tab + 机器人卡片（工作区/Agent Preset/通知进度/访问白名单）。
- 凭据走宿主凭据存储；复用现有 `onboard.ts` 扫码流。
- 该阶段依赖能跑起来 `dsh web` 前端构建验证（本环境未起 HMR dev，需在能连宿主的环境联调）。

### 阶段四：多机器人 + 每机器人独立绑定
- 把「每渠道单机器人」升级为「每渠道多机器人」，绑定、工作区、会话按 botId 隔离。

## 6. 风险 / 需你拍板的点

1. **「多合一」选 A / B / C？** 我倾向 **A + 按需加载（channels 数组）**：单命令安装、不背无用依赖、老包兼容。
2. **Web 设置页面到什么程度？** 先做「配凭据 + 每机器人基础项（工作区/预设/通知/进度/白名单）」；高级项（上下文增强、访问模式等）后续补。
3. **是否保留现有拆分包？** 保留（双轨）以照顾已有用户；若你只想要单包，可以逐步废弃拆分包。
4. **前端联调环境**：Web 设置页需要能起 `dsh web` 验证；当前环境无法访问 github.com 且未起 HMR，阶段三的 UI 交互需你在本机跑起来后反馈，或我按 dsh-im 代码对齐实现再由你验证。

## 7. 我会怎么建议先动

先做**阶段一（配置简化）+ 阶段二（聚合包）**——这两步在本环境可完整 build/test/smoke，直接解决「配置复杂 + 要分别安装」两个痛点。**阶段三（Web 设置）**工程量大且需要宿主联调，建议单独排期，先出设计+骨架，再由你在能跑 `dsh web` 的环境联调。

下一步等你确认：**多合一选 A/B/C？先启动阶段一+二，还是先做阶段三的 Web 设置骨架？**


---

## 进展（实现中）

### 已完成：`dsh-connect-all` 聚合包（方案 A 骨架，已 build + 单测通过）
- 新增 `packages/connect-all/` 单插件：一个 `dsh plugin add dsh-connect dsh-connect-all` 装齐核心 + 4 渠道。
- `src/channels.ts` 是**不依赖任何渠道 SDK** 的纯编排核心 `activateChannels(ctx, config, channels)`：按 `channels` 数组只激活指定 adapter；未知渠道跳过并告警；单个渠道抛错被捕获，不影响其他渠道；每渠道配置切片透传给对应 `apply`。
- `src/index.ts` cordis 入口：`name`/`inject=["connect"]`/`Config`（`channels` 枚举 + 各渠道配置），接线 4 个渠道的 `apply`。
- 验证：`npx tsc -p packages/connect-all/tsconfig.json` 通过；`node packages/connect-all/test/unit.test.mjs` 5 项全过（默认全量/子集/未知渠道/失败隔离/配置透传）；`import lib/index.js` 冒烟确认 `name/inject/apply/Config/CHANNELS/activateChannels` 正确输出；原有 connect(57)+feishu(16)+smoke 均通过（pnpm 重装无回归）。
- `pnpm-lock.yaml` 已纳入 connect-all；`allowBuilds.protobufjs=false`（pnpm 11 自动插入的占位已修正）。

### 待办（需用户确认方向后继续）
- **阶段一 配置简化**：统一 `channels` 命名空间、收敛重复键、最小示例。
- **阶段三 Web 设置页**：客户端 `settings.section` + 宿主 RPC + 凭据库 + 渠道 Tab/机器人卡片；需 `dsh web` 联调。
- **阶段四 多机器人 + 独立绑定**。
- **单插件按需加载**：目前 `connect-all` 静态引入 4 个渠道，SDK 会随包存在；若只启用部分渠道的「不下载无用 SDK」，需把渠道改为可选依赖 + 动态 `import()`（引发布局/构建调整，单独排期）。


### 已完成：宿主 RPC 基座（Web 设置页的通信层，单测通过）
参照 dsh-im 的 `update-rpc.mjs`，在 `packages/connect-all/src/settings-rpc.ts` 落地：
- `SETTINGS_RPC_CHANNEL = "/dsh-connect"`；端点 `settings.get` / `settings.save` / `settings.status`。
- `createSettingsRpcHandler(service)`：返回 `{ ok:true, value }` 或 `{ ok:false, error:{code,message} }`；校验端点/载荷（`settings.save` 需非空对象，读端点需空载荷）；aborted 返回 `cancelled`；service 抛错归并为 `settings-failed`。
- `installSettingsRpc(ctx,{service})`：经 `ctx.connection.rpc.handle(...)` 注册，宿主连接不可用则安全空转。
- `SettingsService`：`get/save/status` `SettingsSnapshot{config,enabled,credentials}`（真实实现由 Web 设置页整合提供：非密钥写配置、密钥写凭据库）。
- 验证：`settings-rpc.test.mjs` 9 项全过（envelope/校验/分发/隔离/空转/注册）。


### 已完成：设置持久化服务 + 接线 + 最小示例（单测通过）
- `packages/connect-all/src/settings-service.ts`：`createSettingsService` 用 JSON 状态文件持久化非密钥设置（`get/save/status` 返回 `SettingsSnapshot{config,enabled,credentials}`）；缺文件/损坏→空配置不抛错；`save` 合并而非替换；自动建父目录。`settings-service.test.mjs` 5 项全过。
- `connect-all` 的 `apply` 已接线：`installSettingsRpc(ctx,{service:createSettingsService({statePath: config.settingsStatePath})})`，宿主连接不可用则安全空转（`settings-rpc` 与 `index` 的类型已验证）。
- `Config` 增加 `settingsStatePath`（可选，持久化 Web 编辑）。
- `packages/connect-all/examples/minimal.config.json`：最小可用示例（channels + channelDefaults + 每渠道密钥），已并入 README。

### 状态：Web 设置已具备完整可测的宿主侧
- RPC 基座（通道/端点/信封/校验）、设置持久化、配置化简都已落地并单测通过。
- 剩余为 **客户端 UI**（前端 `settings.section` 表单 + `ctx.connection.rpc.call` 调用宿主 + 凭据库回写），需 `dsh web` 联调；凭据库注入（DSH `credentials`）为下一步整合。


### 已完成：客户端 RPC 帮手 + 设置页插件骨架 + 配置参考（客户端逻辑已测）
- `packages/connect-all/src/rpc-client.ts`：客户端调用宿主的 envelope 解包帮手（`callRpc`/\`loadSettings\`/\`saveSettings\`/\`loadStatus\`；失败抛 `RpcError`）。`rpc-client.test.mjs` 6 项全过。
- `packages/connect-all/client/settings-client.mjs`：前端设置插件（`settings.section` 注册，镜像 dsh-im `plugin-src/client/index.js`），含 `ConnectSettingsTab` 瘦组件与 `rpcCall = ctx.connection.rpc.call('/dsh-connect', ...)`。**需 `dsh web`（Vite）构建/联调**，`node --check` 已验证语法。
- `docs/config-reference.md`：完整配置参考（推荐最小配置 + 各包键表 + 核心默认值），直接回应「配置过于复杂」。

### Web 设置全链路（宿主侧已完整可测，前端逻辑已测）
宿主：`/dsh-connect` 通道 + `settings.get/save/status` + 持久化（`settings-rpc`+\`settings-service\`）；客户端：`settings.section` + `rpcCall`（`rpc-client` 逻辑已测）。剩余为 **`dsh web` 内构建并跑通前端组件**、**DSH 凭据库整合**（`credentials` 注入，把 `appSecret/botToken` 从配置挪到凭据库）。

### 已完成：凭据库抽象 + 注入 + 面板状态（单测通过）
- packages/connect-all/src/credential-store.ts：createCredentialStore(provider) 适配 DSH credentials（resolve/describe/set/unset）为逐渠道接口；每渠道凭据引用（DSH_CONNECT_<CHANNEL>_*）；configured(channel) 只在全部引用就绪时返回 true；save/clear 幂等。credential-store.test.mjs 5 项全过（含 provider 校验）。
- settings-service 增加 credentialStore 选项，credentials 字段改为真实存在性（无 store 时回退 false）；新增 2 项集成测试（7 项全过）。
- connect-all 的 inject 改为 ["connect","credentials?"]（可选项），apply 在有 credentials 时构造 store 注入设置服务（try/catch 兜底）。构建通过。

### Web 设置：宿主侧 + 客户端逻辑已完整可测
宿主：通道 + 端点 + 信封 + 持久化 + 凭据存在性；客户端：settings.section + rpcCall + 卡片。剩余为 dsh web 内构建/跑通前端组件，以及把渠道 adapter 的 appSecret/botToken 读取改为走凭据库（非配置）。
### 已补齐：apply 接线集成测试（4 项，run-all 共 37 项全过）
- test/apply.test.mjs：验证 index.ts 的 apply 真实接线（非仅核心函数）——插件元数据（name/inject=["connect","credentials?"]）、channels:[] 时不启用任何 adapter 且不抛错、会把 /dsh-connect 设置 RPC 注册到 host、无 host rpc 时安全空转、带 settingsStatePath 时正常接线设置服务。
- 统一 test/run-all.mjs 现跑 6 套件共 **37 项全过、0 失败、exit 0**。
### 已补齐：Web 设置全链路集成测试（3 项，run-all 共 40 项全过）
- test/web-settings-integration.test.mjs：把「RPC handler → settings service → credential store → snapshot」装配起来验证——settings.get 经 RPC 信封返回真实凭据存在性；settings.save 经 RPC 持久化并可被新 service 读出；settings.save 空载荷拒为 bad-request。
- 至此代码侧（多合一 + Web 设置宿主/客户端逻辑 + 配置化简）**全部可测且 40/40 通过**。
### 已补齐：渠道配置从凭据库注密（injectSecrets，run-all 共 44 项全过）
- channels.ts 新增 injectSecrets(config, enabled, getSecrets)：把 store 里存的密钥注入各启用渠道配置（store 覆盖 config；不改动调用方对象；单渠道解析失败不阻塞）。
- index.ts 的 apply 改为 async，先用 injectSecrets 富化配置再 activateChannels；store 密钥在下次插件加载时真正进入 adapter，凭据库不再是死胡同。
- 测试：injectSecrets 2 项（store 覆盖 + 不改原对象）；credential-store 新增 get 读取 2 项。run-all 现 44 项全过、exit 0。
### 已补齐：凭据写路径（credentials.save RPC，run-all 共 50 项全过）
- settings-rpc 新增 credentials.save 端点（payload {channel, values:{configKey:secret}}；校验；service 无该能力返回 unsupported）。
- settings-service.saveCredentials：经 CHANNEL_SECRET_KEYS 把 configKey 映射到凭据引用后写入 store；无 store 抛 not-configured，空值抛 invalid-credentials。
- rpc-client 增加 saveCredentials 客户端帮手。
- 与上轮 injectSecrets 形成「写（面板存密钥）→ 读（激活注入 adapter）」的完整闭环。run-all 现 50 项全过、exit 0；core 57 / feishu 16 / smoke 均通过。
### 已补齐：Web 设置全流程 round-trip 测试（2 项，run-all 共 52 项全过）
- test/web-settings-roundtrip.test.mjs：用真实宿主后端（handler→service→store）模拟 Web 面板的完整操作——saveSettings（写非密钥配置）→ saveCredentials（写密钥到凭据库）→ loadSettings（读到启用渠道 + 真实凭据存在性）→ injectSecrets（下次激活把密钥注入 adapter）。证明整个「写→读→注入」闭环在 unit 级可用，前端仅剩 React 渲染待 dsh web 联调。

### 代码侧状态：完整 + 52/52 可测
多合一 + Web 设置（配置读写 + 凭据读写闭环）+ 配置化简全部落地并有测试；core 57 / feishu 16 无回归。
### 已补齐：客户端数据模型 settings-model（4 测，run-all 共 56 项全过）
- src/settings-model.ts：纯函数映射 snapshot<->form、构建保存载荷（buildConfigSave / buildCredentialSaves / snapshotToForm / CHANNEL_SECRET_FIELDS）。
- client/settings-client.mjs 改为**基于已测 helper 的薄渲染器**：loadSettings→snapshotToForm→渲染(渠道开关+密钥输入+credentials 状态)→saveSettings(配置)+saveCredentials(密钥)。
- 客户端逻辑现已完整并全部可测；仅剩 React 渲染需 dsh web 联调。run-all 现 56 项全过、exit 0；core 57 / feishu 16 无回归。
### 已补齐：包可发布性（npm files 修正 + prepack + 内容/入口校验）
- package.json files 增加 client 与 examples（此前缺，前端插件与示例不会随包发布）。
- 新增 prepack 脚本（tsc -p tsconfig.json，发布前自动重建 lib）。
- 校验（npm pack 被沙箱禁止写 npm 缓存日志，故用 node 直接校验）：files 全部存在、exports 根入口的 types/default 均解析到 lib/index、main=lib/index.js 存在。可发布。
- run-all 56 项仍全过、exit 0。
### 已补齐：一键发布门禁 scripts/verify.mjs（构建 + 全部测试一键跑）
- 唯一入口：node scripts/verify.mjs。依次跑 connect-all 构建、run-all(57)、connect 单元(57)、smoke、connect-feishu(16)、客户端语法检查；全绿输出 VERIFY OK、C=0。
- 注：本沙箱把输出经管道传给上层时会误报 exit 1（Windows 管道 EPERM 产物），重定向到文件后 C=0、FAILED=false、VERIFY OK；在你本机直接运行即可。

### 已修复：钉钉 stream 密钥的嵌套注入缺陷（F1）+ 注释纠正（F2）
- 缺陷：`injectSecrets` 此前把 `clientId`/`clientSecret` **平铺**进 `dingtalk`，而钉钉 adapter 读取 `config.stream.clientId` → 仅凭凭据库配置时 stream 适配器从未注册（Case A=3 适配器、缺 DingtalkStream；Case B 嵌套配置则注册）。
- 修复：`channels.ts` 新增 `NESTED_SECRET_KEYS`（`dingtalk: { clientId:"stream.clientId", clientSecret:"stream.clientSecret" }`）与 `mergeSecrets(target, secrets, nested)`——按点分路径把密钥放回 `stream` 下的嵌套节点；复用 `structuredClone`，不改动调用方对象。
- 新增单测：`injectSecrets nests dingtalk stream secrets under stream without mutating caller`，断言 `out.dingtalk.stream = {url?, clientId, clientSecret}` 且原配置未被改写。run-all 现 **57 项全过、exit 0**。
- F2：`injectSecrets` 的 docstring 原先声称「渠道配置优先于凭据库」，与实现（store 覆盖 config）相反，已纠正为「store 密钥注入并覆盖渠道配置」。

### 已完成：全部文档按「多合一 / 单配置块 + 凭据库注密」模式改写
- 根 README.md / README.zh.md：仓库结构加 `connect-all` 行；渠道矩阵加「任意子集 / dsh-connect-all」并标为**推荐**；安装→`dsh plugin add dsh-connect dsh-connect-all`；配置→单 `connect-all` 块（channels + channelDefaults + 每渠道）+ 凭据库说明。
- docs/QUICKSTART.md/.zh：构建产物、安装、配置、启动日志均改为 connect-all 单插件路径。
- docs/feishu-setup.md / telegram-setup.md / dingtalk-setup.md（+ .zh）：加「安装」推荐块，指向 config-reference.md。
- docs/config-reference.md：钉钉表澄清 `stream.clientId`/`clientSecret` **嵌套在 stream 下**；第四节「Web 设置」改为已实现的宿主侧状态。
- packages/connect-all/README.md/.zh：配置要点 + `settingsStatePath` + 凭据库注密说明（含钉钉 stream 嵌套）+ Web 设置节。
- docs/PUBLISHING.md/.zh：全部 6 包（connect-all 最后发布）、手动发布顺序加入 connect-all、命名表加「多合一合集」行。

### 已完成：升级/发布脚本改为单组件路径（不再分别维护多包）
- scripts/bump-version.ps1：`$PackageFiles` 加入 `packages\connect-all\package.json`；「Next steps」改 6 包、connect-all 最后；手动发布清单加 connect-all。
- scripts/reload.ps1：`$ws = Split-Path -Parent $PSScriptRoot`（不再硬编码路径）；connect-all 的 tsc 构建；头部 `[1/3] 按依赖顺序重建 6 个插件（含 connect-all）`。
- .github/workflows/publish.yml：加「Publish dsh-connect-all」步骤（顺序最后，依赖各渠道包；其渠道依赖为字面 `^0.7.2`，无需 workspace 协议改写）。

### 代码侧状态：完整 + 57/57 可测
- 多合一 + Web 设置（配置读写 + 凭据读写闭环 + 钉钉 stream 嵌套注入）+ 配置化简全部落地并有测试；core 57 / feishu 16 无回归。