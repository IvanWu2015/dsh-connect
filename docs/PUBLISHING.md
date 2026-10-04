# Naming & Discoverability Guide

English | [中文](PUBLISHING.zh.md)

This document answers two questions: **what is it called**, and **how do DSH users find this repository**.

## 1. Naming

| Object | Name | Notes |
|---|---|---|
| GitHub repo | `dsh-connect` | The monorepo |
| **The only npm package** | `dsh-connect` | All-in-one plugin: core `connect` service + every channel adapter (feishu / telegram / dingtalk / web) + the web-settings stack, all behind a `channels` selector. This is the single package that is installed and published. |
| Channel adapters | inside `dsh-connect` (`src/channels/feishu`, `…/telegram`, `…/dingtalk`, `…/web`) | No longer separate npm packages |

**Why this naming:**

- The `dsh-` prefix aligns with the DSH ecosystem (`@deepseek-ai/dsh-*`), so users searching for `dsh` on npm/GitHub will hit it.
- `connect` says plainly what the product does: connect DSH to chat channels for bidirectional message sync and work arrangement.
- There is deliberately **no per-channel suffix** any more (no `dsh-connect-feishu`, no `dsh-connect-all`): one package carries every channel behind `channels: [...]`. Channel-level discoverability for searches like "feishu + dsh" now has to come from the `description`, the `keywords` array, the repo topics and the README text — see §2.2, §2.3 and §3.

> For publishing, avoid taking the official `@deepseek-ai` scope (that belongs to DeepSeek). Use the unscoped name `dsh-connect` (most discoverable); if it is taken, use your own scope, e.g. `@your-org/dsh-connect`.

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

**Screenshot path convention.** All screenshots committed today live in `packages/connect/docs/images/` and are referenced by *relative* path — never an absolute path or a GitHub blob URL:

| Writing in… | Reference screenshots as… |
|---|---|
| a file under `docs/` (this file included) | `../packages/connect/docs/images/settings-overview-zh.png` |
| `packages/connect/README.md` / `README.zh.md` | `docs/images/settings-overview-zh.png` |
| `packages/connect/README.i18n.yaml` | same as the READMEs (the i18n file mirrors the English README) |

The settings-pane set is fourteen PNGs, all 1600×1600 — seven names, each in a `-zh` and an `-en` variant:

- `settings-overview-{zh,en}.png` — the primary navigation above the channel tab strip, over collapsible cards (one setting per row).
- `settings-general-{zh,en}.png` — the General view (1.0.2): four cards of the ten formerly chat-command-only values.
- `settings-general-agent-{zh,en}.png` — the same view, framed on the agent card: the read-only model row, plus the keys `dsh.shared.config.json` overrides.
- `settings-advanced-{zh,en}.png` — the second-level 高级 / Advanced fold.
- `settings-defaults-{zh,en}.png` — how defaults are shown for a channel that has none set.
- `settings-feishu-{zh,en}.png` — the Feishu card's credential fields, with the one-click create button (1.0.0) sitting *above* them. Shot mid-scroll, which is also what shows both navigation strips staying pinned at the top. (Until 1.0.2 this framed the button itself; that moved to the top of the card body, so it is already in the overview shot and centring on it again produced a file byte-identical to it.)
- `settings-manual-{zh,en}.png` — the Telegram card's official-entry link, the manual counterpart to the above.

There is deliberately **no screenshot of the result of a one-click run**: producing one means creating a real app in a real tenant, so the docs describe the result lines in a table instead. Do not fill the gap with a mock-up.

**How the shots are taken.** From a throwaway `dsh` profile that is *not* the developer's own: a scratch `DSH_HOME` with a profile whose plugin is linked to this working tree, and whose credentials are all fake placeholders. Nothing in frame is a real secret, and no capture ever starts a flow (the one-click button is photographed, never pressed). Boot it on a free port — `--port 0` lets the OS pick one, which matters because a developer machine is likely already serving the real DSH web UI on 3080:

```sh
DSH_HOME=<scratch-home> dsh --profile <scratch-profile> --no-open --port 0
```

Then drive it with Playwright, screenshotting the pane element itself (a fixed 800×800 CSS-px frame, so every shot is exactly 1600×1600 at `deviceScaleFactor: 2`). Because the frame is fixed, **scroll position alone decides what a shot shows** — the mid-scroll shots are centred on a selector, not cropped. The host UI locale follows the host's own language setting, which is sticky, so a capture for `-en` has to switch the shell's locale row first.

**Pick the variant that matches the document's language**: Chinese docs and `README.zh.md` use `-zh`, English docs and `README.md` use `-en`. Do not mix them within one file. Because the images are 1600px wide, embed them as raw HTML with an explicit width so they don't blow up the page — e.g.

```html
<img src="../packages/connect/docs/images/settings-overview-en.png" alt="dsh-connect web settings: primary nav + channel tabs + collapsible cards" width="760">
```

## 3. npm publishing (so `dsh plugin add` works)

DSH's plugin install command is `dsh plugin --profile web add <package>` (it forwards to pnpm underneath), so **publishing to npm is the prerequisite for DSH users to install with one command**.

Publishing is **automatic**: `.github/workflows/publish.yml` runs on every **GitHub Release** and publishes the **single `dsh-connect` package** (working-directory `packages/connect`) via npm trusted publishing (OIDC). Before testing/publishing the CI runs `pnpm build` (the `lib/` output is gitignored) and `pnpm typecheck`; `pnpm test` must also pass.

Manually, publish the one package:

```sh
# lib/ must exist → run pnpm build first
pnpm --filter dsh-connect publish --access public
```

### 3.1 The 24-hour cooldown that follows every publish

pnpm 12 ships a **1440-minute `minimumReleaseAge`** and applies it non-strictly, so for a full day after each release a bare `dsh plugin --profile web add dsh-connect` resolves to the **previous** version. Nothing is wrong with the tarball and republishing does not help — the remedy is on the consumer side and is documented in the README's ["When the install resolves to an older version"](../README.md#when-the-install-resolves-to-an-older-version).

What this means for a release:

- Expect "the plugin list offers the new version but the install takes the old one" within 24 hours of shipping. That is the expected signature of the cooldown, not a packaging bug — verify against the registry before debugging anything else.
- A **first-time** install of a package with no release older than 24 hours has nothing to fall back to and fails outright, so the profile exemption or an explicit `dsh-connect@<version>` is mandatory there rather than merely preferable.

Independently of the cooldown, every `add` of this package needs `allowBuilds: {protobufjs: false}` in the consumer's profile, or it exits with `ERR_PNPM_IGNORED_BUILDS` after writing the dependency. Neither problem can be fixed from inside the published package.

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
- [ ] The `dsh-connect` package published to npm with `keywords` filled in (auto via GitHub Release)
- [ ] Leave traces in the official DSH repo + at least one awesome list
