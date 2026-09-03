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
- `-feishu` 后缀让"feishu + dsh"这类搜索也能命中。

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

## 3. npm 发布（让 `dsh plugin add` 可用）

DSH 的插件安装命令是 `dsh plugin --profile web add <package>`（底层转发给 pnpm），所以**发布到 npm 是 DSH 用户一条命令安装的前提**。

发布是**自动的**：`.github/workflows/publish.yml` 在每次 **GitHub Release** 时运行，发布**唯一的 `dsh-connect` 包**（working-directory `packages/connect`），走 npm trusted publishing（OIDC）。测试/发布前 CI 会先执行 `pnpm build`（`lib/` 被 gitignore）与 `pnpm typecheck`；`pnpm test` 也必须通过。

手动发布这一个包：

```sh
# lib/ 必须先构建 → 先运行 pnpm build
pnpm --filter dsh-connect publish --access public
```

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
