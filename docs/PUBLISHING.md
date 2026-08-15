# 命名与可发现性指南

本文回答两个问题：**叫什么名字**，以及**怎么让 DSH 用户找到这个仓库**。

## 1. 命名

| 对象 | 名称 | 说明 |
|---|---|---|
| GitHub 仓库 | `dsh-connect` | 总仓库（monorepo） |
| 核心包 | `dsh-connect` | 渠道无关核心层 |
| 飞书适配器 | `dsh-connect-feishu` | 飞书/Lark 渠道 |
| 后续钉钉 | `dsh-connect-dingtalk` | 命名规则：`dsh-connect-<channel>` |

**为什么这样命名：**

- `dsh-` 前缀对齐 DSH 官方生态（`@deepseek-ai/dsh-*`），用户在 npm/GitHub 搜 `dsh` 时能命中。
- `connect` 直白地描述了这个产品做的事：把 DSH 与聊天渠道连接起来，实现双向消息同步与工作安排。
- `-feishu` 后缀让「飞书 + dsh」这类搜索词也能命中。

> 发布时建议**不占用 `@deepseek-ai` 官方 scope**（那是 DeepSeek 官方的）。用无 scope 名 `dsh-connect` / `dsh-connect-feishu`（最易发现）；若被占用，改用你自己的 scope，如 `@你的组织/dsh-connect`。

## 2. GitHub 可发现性（让 DSH 用户能找到）

GitHub 搜索主要靠 **仓库名 + 描述 + About 区 + Topics + README 首段**。逐项做齐：

### 2.1 创建仓库

1. 新建仓库，名字 `dsh-connect`（与 npm 包名一致）。
2. 仓库 **Description**（第一句最关键，含关键词）：
   > Bridge DeepSeek Harness (DSH) agents to Feishu/Lark & DingTalk — chat, stream replies, and arrange work from your messaging app.

### 2.2 About 区

在仓库页右侧 **About → 齿轮图标** 里填：
- **Website / 文档链接**：README 或 docs 的 URL。
- **Topics**（GitHub 搜 tag 的核心）：

```
deepseek-harness  dsh  dsh-plugin  feishu  lark  dingtalk  ai-agent  chatbot  cordis
```

### 2.3 README 首段（决定搜索相关性）

首段必须自然包含可检索词，参考本仓库 `README.md` 已写好的开头：
> 把 DeepSeek Harness（DSH）的 Agent 接入聊天软件（飞书/Lark 先行…），实现信息同步 + 工作安排…

### 2.4 加徽章 + 截图

- 顶部加 build/license 徽章（提高可信度，间接利于排序）。
- 放一张「飞书里对话 + 流式回复」的截图（demo 截图能显著提升点击率）。

## 3. npm 发布（让 `dsh plugin add` 可用）

DSH 的插件安装命令是 `dsh plugin --profile web add <包名>`（底层转发 pnpm），所以**发布到 npm 是被 DSH 用户「一键安装」的前提**。

```sh
# 在 packages/connect 与 packages/connect-feishu 分别：
pnpm --filter dsh-connect publish --access public
pnpm --filter dsh-connect-feishu publish --access public
```

发布前把 package.json 里占位的 `"name"`/`"version"` 确认好，`description`、`keywords`、`repository`、`license` 补全。**npm 的 `keywords` 字段**同样参与 npm 搜索：

```json
"keywords": ["dsh", "deepseek-harness", "feishu", "lark", "dingtalk", "cordis", "ai-agent", "chatbot"]
```

## 4. 生态内扩散（最有效的一步）

仅靠搜索引擎不够，主动让「用 DSH 的人」看到：

1. **DSH 官方仓库**：在 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 提 Issue / Discussion，说明「dsh-connect：把 DSH 接入飞书」，附链接；若官方有社区插件目录/awesome 列表，提交 PR 收录。
2. **awesome 列表**：搜 `awesome-deepseek-harness`、`awesome-feishu`、`awesome-ai-agents` 等，提交 PR 收录。
3. **中文社区**：在飞书/Lark、AI Agent 相关讨论（掘金、知乎、V2EX 等）介绍「把 DSH 接入飞书」并附仓库链接。
4. **关键搜索词占位**：README 和描述里同时出现中英文词（`飞书` `钉钉` `Feishu` `Lark` `DeepSeek Harness` `DSH`），覆盖中文与英文检索。

## 5. 最小可发现性清单（照着做即可）

- [ ] GitHub 仓库名 `dsh-connect`，Description 含关键词
- [ ] About Topics 填齐（见 2.2）
- [ ] README 首段含「DeepSeek Harness / 飞书」
- [ ] npm 发布两个包，`keywords` 补全
- [ ] 在 DSH 官方仓库 + 至少一个 awesome 列表留痕
