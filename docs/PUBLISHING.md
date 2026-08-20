# Naming & Discoverability Guide

English | [中文](PUBLISHING.zh.md)

This document answers two questions: **what is it called**, and **how do DSH users find this repository**.

## 1. Naming

| Object | Name | Notes |
|---|---|---|
| GitHub repo | `dsh-connect` | The monorepo |
| Core package | `dsh-connect` | Channel-agnostic core (published **first** — every adapter depends on it) |
| Web mirror adapter | `dsh-connect-web` | Mirrors Feishu sessions into the DSH Web GUI |
| Feishu adapter | `dsh-connect-feishu` | Feishu/Lark channel |
| Telegram adapter | `dsh-connect-telegram` | Telegram channel |
| DingTalk adapter | `dsh-connect-dingtalk` | One-way DingTalk group push |
| Naming rule | `dsh-connect-<channel>` | For future channels |

**Why this naming:**

- The `dsh-` prefix aligns with the DSH ecosystem (`@deepseek-ai/dsh-*`), so users searching for `dsh` on npm/GitHub will hit it.
- `connect` says plainly what the product does: connect DSH to chat channels for bidirectional message sync and work arrangement.
- The `-feishu` suffix makes searches like "feishu + dsh" hit too.

> For publishing, avoid taking the official `@deepseek-ai` scope (that belongs to DeepSeek). Use the unscoped names `dsh-connect` / `dsh-connect-feishu` (most discoverable); if those are taken, use your own scope, e.g. `@your-org/dsh-connect`.

## 2. GitHub discoverability (so DSH users can find it)

GitHub search mainly relies on **repo name + description + About section + topics + README opening paragraph**. Do them all:

### 2.1 Create the repo

1. Create a new repository named `dsh-connect` (matching the npm package name).
2. Repo **Description** (the first sentence matters most — include keywords):
   > Bridge DeepSeek Harness (DSH) agents to Feishu/Lark & DingTalk — chat, stream replies, and arrange work from your messaging app.

### 2.2 About section

On the repo page's right-hand **About → gear icon**, fill in:
- **Website / documentation link**: the README or docs URL.
- **Topics** (the core of GitHub tag search):

```
deepseek-harness  dsh  dsh-plugin  feishu  lark  dingtalk  ai-agent  chatbot  cordis
```

### 2.3 README opening paragraph (drives search relevance)

The first paragraph must naturally include searchable terms — see the opening of this repo's `README.md`:
> Connect DeepSeek Harness (DSH) agents to chat platforms — Feishu / Lark first, with DingTalk and others to follow…

### 2.4 Add badges + screenshots

- Add build/license badges at the top (builds credibility, indirectly helps ranking).
- Add a screenshot of "chatting in Feishu with streaming replies" (demo screenshots noticeably lift click-through).

## 3. npm publishing (so `dsh plugin add` works)

DSH's plugin install command is `dsh plugin --profile web add <package>` (it forwards to pnpm underneath), so **publishing to npm is the prerequisite for DSH users to install with one command**.

Publishing is **automatic**: `.github/workflows/publish.yml` runs on every **GitHub Release** and publishes all **5 packages** (`dsh-connect`, `dsh-connect-web`, `dsh-connect-feishu`, `dsh-connect-telegram`, `dsh-connect-dingtalk`) sequentially — `dsh-connect` **first** (the other packages list it as a peer dependency), then `connect-web` → `connect-feishu` → `connect-telegram` → `connect-dingtalk`. A parallel matrix would race that peer dependency. Before testing/publishing the CI runs `pnpm build` (the `lib/` output is gitignored) and `pnpm typecheck`; `pnpm test` must also pass.

Manually, the same order applies:

```sh
# In dependency order (connect first); lib/ must exist → run pnpm build first
pnpm --filter dsh-connect publish --access public
pnpm --filter dsh-connect-web publish --access public
pnpm --filter dsh-connect-feishu publish --access public
pnpm --filter dsh-connect-telegram publish --access public
pnpm --filter dsh-connect-dingtalk publish --access public
```

Before publishing, confirm the placeholder `"name"`/`"version"` in each package.json and fill in `description`, `keywords`, `repository`, `license`. npm's **`keywords` field** also participates in npm search:

```json
"keywords": ["dsh", "deepseek-harness", "feishu", "lark", "dingtalk", "cordis", "ai-agent", "chatbot"]
```

## 4. Spread within the ecosystem (the most effective step)

Search engines aren't enough — proactively get in front of "people who use DSH":

1. **The official DSH repo**: file an Issue/Discussion on [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) introducing "dsh-connect: connect DSH to Feishu" with a link; if the project keeps a community plugin directory / awesome list, submit a PR to be listed.
2. **Awesome lists**: search for `awesome-deepseek-harness`, `awesome-feishu`, `awesome-ai-agents`, etc., and submit PRs to be listed.
3. **Communities**: in Feishu/Lark and AI-agent communities, introduce "connect DSH to Feishu" with the repo link.
4. **Keyword coverage**: include both English and Chinese terms in the README and descriptions (Feishu / Lark / DeepSeek Harness / DSH), covering both English and Chinese search.

## 5. Minimum discoverability checklist (just follow it)

- [ ] GitHub repo named `dsh-connect`, Description contains keywords
- [ ] About topics filled in (see 2.2)
- [ ] README opening paragraph contains "DeepSeek Harness / Feishu"
- [ ] All five packages published to npm with `keywords` filled in (auto via GitHub Release)
- [ ] Leave traces in the official DSH repo + at least one awesome list
