# 命名与可发现性指南

[English](PUBLISHING.md) | 中文

本文档回答两个问题：**它叫什么**，以及**DSH 用户如何找到这个仓库**。

## 1. 命名

| 对象 | 名称 | 说明 |
|---|---|---|
| GitHub 仓库 | `dsh-connect` | monorepo |
| **唯一的 npm 包** | `dsh-connect` | 多合一插件：核心 connect 服务 + 全部通道适配器（feishu / telegram / dingtalk / web）+ Web 设置栈，全部通过一个 `channels` 选择器启用。这是唯一被安装与发布的包。 |
| 通道适配器 | 在 `dsh-connect` 内部（`src/channels/feishu`、`…/telegram`、`…/dingtalk`、`…/web`） | 不再是独立的 npm 包 |

**为什么这样命名：**

- `dsh-` 前缀与 DSH 生态（`@deepseek-ai/dsh-*`）保持一致，在 npm/GitHub 上搜索 `dsh` 的用户能命中它。
- `connect` 直白地说明产品的用途：把 DSH 接入聊天通道，实现双向消息同步与工作安排。
- 不再使用**按渠道加后缀**的包名（既没有 `dsh-connect-feishu`，也没有 `dsh-connect-all`）：一个包通过 `channels: [...]` 覆盖全部渠道。因此"feishu + dsh"这类搜索的命中要改由 `description`、`keywords` 数组、仓库 topics 与 README 正文承担——见 §2.2、§2.3 与 §3。

> 发布时不要占用官方的 `@deepseek-ai` scope（那是 DeepSeek 的）。使用无 scope 的名称 `dsh-connect`（最易被发现）；若已被占用，就使用你自己的 scope，例如 `@your-org/dsh-connect`。

## 2. GitHub 可发现性（让 DSH 用户能找到）

GitHub 搜索主要依赖**仓库名 + 描述 + About 栏 + topics + README 开头段**。全部做齐：

### 2.1 创建仓库

1. 新建一个名为 `dsh-connect` 的仓库（与 npm 包名一致）。
2. 仓库**描述**（第一句话最重要——包含关键词）：
   > Bridge DeepSeek Harness (DSH) agents to Feishu/Lark & DingTalk — chat, stream replies, and arrange work from your messaging app.
   > （中文：将 DeepSeek Harness (DSH) 智能体接入飞书/Lark 与钉钉——在聊天应用中对话、流式回复、安排工作。）

### 2.2 About 栏

在仓库页面右侧的 **About → 齿轮图标**中填写：
- **网站 / 文档链接**：README 或 docs 的 URL。
- **Topics**（GitHub 标签搜索的核心）：

```
deepseek-harness  dsh  dsh-plugin  feishu  lark  dingtalk  ai-agent  chatbot  cordis
```

### 2.3 README 开头段（驱动搜索相关性）

第一段必须自然地包含可搜索词——见本仓库 `README.md` 的开头：
> Connect DeepSeek Harness (DSH) agents to chat platforms — Feishu / Lark first, with DingTalk and others to follow…
> （中文：将 DeepSeek Harness (DSH) 智能体接入聊天平台——优先飞书 / Lark，钉钉等随后跟进……）

### 2.4 添加徽章与截图

- 顶部添加构建/许可证徽章（建立可信度，间接有助于排名）。
- 添加一张"在飞书中聊天并流式接收回复"的截图（演示截图能显著提升点击率）。

**截图路径约定。** 目前入库的截图都在 `packages/connect/docs/images/`，且一律用**相对路径**引用——不要用绝对路径或 GitHub blob URL：

| 你正在写… | 截图引用写法 |
|---|---|
| `docs/` 下的文件（含本文） | `../packages/connect/docs/images/settings-overview-zh.png` |
| `packages/connect/README.md` / `README.zh.md` | `docs/images/settings-overview-zh.png` |
| `packages/connect/README.i18n.yaml` | 与 README 相同（该 i18n 文件镜像英文 README） |

设置页这套截图共 14 张 PNG，均为 1600×1600——7 个名字，各有 `-zh` 与 `-en` 两个变体：

- `settings-overview-{zh,en}.png`——主导航 + 渠道 Tab 条 + 可折叠卡片（设置项单列）。
- `settings-general-{zh,en}.png`——通用设置视图（1.0.2）：四张卡片，装着原先只能靠聊天命令改的那十项。
- `settings-general-agent-{zh,en}.png`——同一视图里对准智能体卡片：只读的模型行，以及被 `dsh.shared.config.json` 压过的键。
- `settings-advanced-{zh,en}.png`——二级「高级」折叠。
- `settings-defaults-{zh,en}.png`——渠道未设置任何值时的默认值展示。
- `settings-feishu-{zh,en}.png`——飞书卡片的凭据字段，而「一键创建」按钮（1.0.0）在它们**上方**。这张是**滚动后**拍的，同时也正好证明两层导航条都钉在顶部。（1.0.2 之前这张拍的是按钮本身；按钮上移到卡片正文顶端后已经进了概览图，再对准它就会拍出一张与概览图逐字节相同的文件。）
- `settings-manual-{zh,en}.png`——Telegram 卡片的官方入口链接，与上一张互为对照。

**故意没有「一键创建之后」的结果截图**：要拍出它就得在真实租户里建一个真实应用，所以文档改用一张表描述结果行。不要用效果图去补这个空缺。

**怎么拍出来的。** 用一个**不是开发者本人**的一次性 `dsh` profile：一个临时 `DSH_HOME`，其 profile 的插件 `link:` 到本工作树，凭据全是假占位符。画面里没有真实密钥，任何一次截图都不会真的启动流程（一键按钮只拍不按）。用空闲端口启动——`--port 0` 让 OS 挑一个，这很重要，因为开发机上 3080 很可能已经跑着真实的 DSH Web UI：

```sh
DSH_HOME=<scratch-home> dsh --profile <scratch-profile> --no-open --port 0
```

然后用 Playwright 驱动，对**面板元素本身**截图（一个固定的 800×800 CSS px 画框，所以 `deviceScaleFactor: 2` 下每张恰好是 1600×1600）。正因为画框固定，**一张图拍到什么完全由滚动位置决定**——那几张滚动中的图是把某个选择器滚到画面中部，不是裁剪。宿主 UI 语言跟随宿主自己的语言设置且是黏性的，所以拍 `-en` 时要先切宿主语言那一行。

**变体要与文档语言一致**：中文文档与 `README.zh.md` 用 `-zh`，英文文档与 `README.md` 用 `-en`，同一文件内不要混用。由于原图宽 1600px，请用带显式宽度的原始 HTML 嵌入，避免撑破页面：

```html
<img src="../packages/connect/docs/images/settings-overview-zh.png" alt="dsh-connect Web 设置页：渠道 Tab 条 + 可折叠卡片" width="760">
```

## 3. npm 发布（让 `dsh plugin add` 可用）

DSH 的插件安装命令是 `dsh plugin --profile web add <package>`（底层转发给 pnpm），所以**发布到 npm 是 DSH 用户一条命令安装的前提**。

发布是**自动的**：`.github/workflows/publish.yml` 在每次 **GitHub Release** 时运行，发布**唯一的 `dsh-connect` 包**（working-directory `packages/connect`），走 npm trusted publishing（OIDC）。测试/发布前 CI 会先执行 `pnpm build`（`lib/` 被 gitignore）与 `pnpm typecheck`；`pnpm test` 也必须通过。

手动发布这一个包：

```sh
# lib/ 必须先构建 → 先运行 pnpm build
pnpm --filter dsh-connect publish --access public
```

### 3.1 每次发布之后的 24 小时冷静期

pnpm 12 内置 **1440 分钟的 `minimumReleaseAge`**，且是非严格生效的：每次发布后的整整一天里，裸写 `dsh plugin --profile web add dsh-connect` 都会解析到**上一版**。tarball 没有任何问题，重新发布也救不了——对策在消费方，README 的[「安装落到旧版本怎么办」](../README.zh.md#安装落到旧版本怎么办)记录了具体做法。

对一次发布来说，这意味着：

- 发布后 24 小时内，请预期收到「插件列表给的是新版本，装上的却是旧版本」这类反馈。这是冷静期的典型签名，不是打包问题——先去比对 registry，再排查别的地方。
- 对于**首次**安装、且该包不存在任何满 24 小时的发布的情况，没有可回退的版本，安装会直接失败。此时 profile 豁免或显式写 `dsh-connect@<版本>` 是必需项，而不是「更好」。

与冷静期无关的另一个问题：每次 `add` 这个包，都需要消费方 profile 里有 `allowBuilds: {protobufjs: false}`，否则会在写入依赖之后以 `ERR_PNPM_IGNORED_BUILDS` 退出。这两个问题都无法从已发布的包内部修掉。

发布前，确认每个 package.json 中的占位 `"name"`/`"version"`，并填写 `description`、`keywords`、`repository`、`license`。npm 的 **`keywords` 字段**也参与 npm 搜索：

```json
"keywords": ["dsh", "deepseek-harness", "feishu", "lark", "dingtalk", "cordis", "ai-agent", "chatbot"]
```

## 4. 在生态内传播（最有效的一步）

搜索引擎不够——主动出现在"使用 DSH 的人"面前：

1. **官方 DSH 仓库**：在 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 上提交 Issue/Discussion，介绍"dsh-connect：把 DSH 接入飞书"并附上链接；若项目维护社区插件目录 / awesome list，提交 PR 让自己上榜。
2. **Awesome 列表**：搜索 `awesome-deepseek-harness`、`awesome-feishu`、`awesome-ai-agents` 等，提交 PR 上榜。
3. **社区**：在飞书/Lark 和 AI 智能体社区中，带上仓库链接介绍"把 DSH 接入飞书"。
4. **关键词覆盖**：在 README 与描述中同时包含中英文词（Feishu / Lark / DeepSeek Harness / DSH），同时覆盖中英文搜索。

## 5. 最低可发现性清单（照着做就行）

- [ ] GitHub 仓库命名为 `dsh-connect`，描述中包含关键词
- [ ] 已填写 About topics（见 2.2）
- [ ] README 开头段包含 "DeepSeek Harness / Feishu"
- [ ] `dsh-connect` 包已发布到 npm 且填写了 `keywords`（随 GitHub Release 自动发布）
- [ ] 在官方 DSH 仓库 + 至少一个 awesome list 中留下踪迹
