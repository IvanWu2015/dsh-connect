# Changelog

All notable changes to this project are documented following [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.6.2] - 2026-08-19

### Added

- **Bilingual documentation (zh/en, switchable)**: every user-facing doc now ships as an English + Chinese pair following the official DSH convention — `README.md` / `README.zh.md` (and the `docs/*.md` / `docs/*.zh.md` guides), each with a language-switch link at the top (`English | [中文](…)` ⇄ `[English](…) | 中文`):
  - Root `README.md`, `docs/QUICKSTART.md`, `docs/feishu-setup.md`, `docs/telegram-setup.md`, `docs/dingtalk-setup.md`, `docs/PUBLISHING.md`, `docs/MIRROR_SESSION.md`, `docs/SHARED_WORKSPACE_SETUP.md`, `docs/ENHANCEMENTS_SUMMARY.md`, plus all five package READMEs.
  - `README.i18n.yaml` consistency records (git blob hashes of both sides) for the root and all five packages, matching the official DSH package layout.
  - npm packages now ship `README.zh.md` (and the i18n record) via the `files` field, so the Chinese docs reach npm package pages too.
- `scripts/bump-version.ps1` now updates all five workspace packages (`connect`, `connect-feishu`, `connect-dingtalk`, `connect-telegram`, `connect-web`) instead of two.

## [0.6.1] - 2026-08-18

### Fixed

- **Authorization feedback gap**: tapping an approval card's "同意"/"拒绝" button now immediately shows the result — the card is replaced with a green "✅ 已同意/已拒绝" summary when the decision is accepted, or a "⚠️ 已失效" notice when the request was already handled elsewhere or expired. Previously the card went silent (`void this.respondThen(...)` fire-and-forget), leaving the user unsure whether the tap took effect.
- **Stale-button silence**: tapping a button on an already-handled or expired card (e.g. an old approval card behind new messages) now shows a clear "⚠️ 此操作已失效" message instead of silently ignoring the tap. Applies to Feishu via `cardAction` fallback and to Telegram via `answerCallbackQuery` "expired" toast.
- **Question answer staleness**: when all questions are answered but the host rejects the response (already answered in the Web GUI), the user now sees "⚠️ 此问题已失效" instead of getting no feedback at all.

### Changed

- `presentLoop` callback signature: `onChoice` now receives the card's `messageId` as a second argument and may be **async** — enabling the approval flow to `await respond()` and update the card in place before settling.
- Removed the now-unused `respondThen` helper.

## [0.6.0] - 2026-08-18

### Added

- **`dsh-connect-telegram` — Telegram channel adapter (new package)**. Bidirectional conversation over the official Bot API `getUpdates` long polling (no webhook / public IP needed):
  - Text / markdown replies with HTML parse mode; long answers stream as in-place message edits.
  - Interactive choice prompts (`ask_user_question`, `/menu`) render as inline-keyboard buttons answered via callback queries.
  - Photo / document intake with automatic download into the workdir; group @-mention policy (`requireMention`).
  - Zero runtime HTTP dependency (built on the global `fetch`).
  - Setup guide: `docs/telegram-setup.md`.
- **`dsh-connect-dingtalk` — DingTalk group-webhook push channel (new package)**. One-way notice delivery into a DingTalk group (DingTalk custom robots cannot receive messages):
  - `ctx.dingtalk` Cordis service: `sendMarkdown` / `sendText` with @-mentions by phone / user id / @all.
  - Optional signing secret (`SEC…`); zero runtime HTTP dependency.
  - Setup guide: `docs/dingtalk-setup.md`.
- Workspace now ships 4 packages: `connect`, `connect-feishu`, `connect-telegram`, `connect-dingtalk`; root `pnpm test` covers all of them (29 + 6 + 5 unit tests).

## [0.5.3] - 2026-08-17

### Added

- **First-time welcome card**: the first message in every chat now also sends a one-time welcome card (ability intro + common commands), marked in `bindings.json` so it never repeats.
- **Error classification & actionable advice**: a failed task now shows a suggestion matched to the error — permission problems (Feishu app permissions / DSH sandbox & workdir access), network problems (connection / proxy), model or quota problems (config / `/model` switch), or a generic hint (`/status`, `/stop`).
- **Destructive-action confirmation**: `/clear`, `/new` and the menu's "新建对话" now ask for confirmation first (✅ 确认 / ↩️ 取消), preventing accidental history loss.
- **Progress step counter**: tool-call status lines now include the call number (`🔧 第 2 次工具调用 \`pwsh\``), and the processing acknowledgment reports how many messages are still queued.
- **Group completion @-mention**: in groups, the task-end stats/summary cards now @-mention the requester so the result is noticed.
- New `OutboundTarget.atUsers` (channel adapters may @-mention users on delivery; the Feishu adapter renders it through the SDK's native mentions).

### Changed

- `recordSession` now spreads the existing binding, so per-chat settings (language / notify level / progress interval / welcome marker) survive the first session record.

## [0.5.2] - 2026-08-17

### Added

- **User choices in Feishu**: when the agent calls `ask_user_question` (confirmations, plan reviews, option pickers), an interactive card with buttons now appears right in the chat — no need to open the Web GUI. Answer by tapping a button or by replying with plain text (option number or label; multi-select questions accept `1,3` style lists). The plugin answers through the host api-proxy's own respond path, so the Web GUI stays fully functional and whoever answers first wins.
- **Permission approvals in Feishu**: sandbox/permission requests (`approval/requested`, e.g. tool escalation) render as an allow-once / deny card in the chat, and the user's decision is routed back to the approval service.
- **Processing acknowledgment**: every received message is acknowledged immediately (“✅ 已收到，开始处理” with a preview) before the agent spins up, so the user always knows processing started.
- **Proactive progress watchdog**: if a turn has sent no standalone status for `progressTimeoutMs` (default 5 minutes), a status card reports the latest milestone (thinking / last tool call) instead of leaving the user in silence. New `progressTimeoutMs` config (0 disables) plus a per-chat setting via `/progress` or the settings menu (off / 2 / 5 / 10 / 15 / 30 minutes), persisted in `bindings.json`.
- **Compact feedback**: `/compact` (and the menu action) now announces “🔄 正在压缩上下文…” immediately and reports “✅ 上下文压缩完成” (or the failure) when done.
- **`ask_user_question` visibility**: the tool-call status line now shows the actual question text at every notification level, so a pending choice is never invisible.

### Changed

- `ask_user_question` / approval questions time out per-card but are re-presented in place, so a choice stays answerable for as long as the agent waits.
- Settings overview (`/settings` → 配置总览) now shows the current progress-reminder interval.

## [0.5.1] - 2026-08-16

### Added

- **Notification levels** (`notifyLevel`): streaming replies now follow one of three levels — `full` (stream everything), `important` (key milestones; thinking hint + tool-call status + heartbeat + final answer, no reasoning text), `result` (answer only). Per-chat override via the settings menu or `/notify`; the choice is persisted in `bindings.json` and survives restarts. New `notifyLevel` config key (default `important`).
- **Task-end stats card**: when a task finishes, a card reports the model used, input/output/cached tokens, step count, duration and context usage, and suggests `/compact` when the context is ≥ 75% of the model's window.
- **Web mirror sessions**: `/mirror [--timeout N]` creates (or shows) a mirror of the chat's DSH session in the DSH Web GUI; the mirror shares the same session with mutual-exclusion locking and an optional lock timeout. New `autoMirror` config (default `true`) auto-creates the mirror for every new chat.
- **`streamHeartbeatMs` config**: liveness heartbeat for the streaming card during long silent phases (default 60000 ms; `0` disables it).
- **Feishu file downloads**: the Feishu adapter now downloads attached files/audio/video in addition to images, all via `im.v1.messageResource.get`, with sanitized file names; only stickers remain unsupported.
- **Configurable button grid**: Feishu choice menus now render 2 columns per row by default (was 3), and each menu section can override the column count.
- **Shared config file**: `dsh.shared.config.json` at the project root can supply workspace/state/mirror defaults shared between DSH Web and the connect plugins.
- **`dsh-connect-web` package** (work-in-progress): Web channel adapter that mirrors Feishu conversations to the DSH Web GUI; source committed, not yet published.
- Version bump helper `scripts/bump-version.ps1` and repository rules (`.cursorrules`).

### Changed

- **Default notification level is now `important`** (key milestones) instead of `full`.
- Streaming card layout: blocks, the reasoning phase and the final answer are separated by blank lines, and reasoning text streams live instead of a single static hint; tool calls render as status lines.
- The core README was rewritten to the 9-section spec (Overview / Compatibility / Install & uninstall / Quick start / Configuration / Permissions & data / Troubleshooting / Development / License & security).

### Fixed

- **Model switching from the Web GUI now applies**: the connect runner no longer installs a static model selection that shadowed the api-proxy's per-agent selection, so switching the model in the GUI is actually used by bound sessions instead of silently falling back to the default.
- **Streaming replies no longer concatenate into one unbroken wall of text** (blank-line separation between chunks).
- **Long tasks no longer stall on "Thinking..." for many minutes**: reasoning is streamed live, tool calls emit a status line, a heartbeat keeps the card alive during silent phases, and agent listeners are deduplicated with a `WeakSet` so an externally rebuilt agent can't silently stop streaming.
- Feishu `messageResource.get`-based downloads apply to files/audio/video too (images were already fixed in 0.5.0).

## [0.5.0] - 2026-08-16

> This is the first release since 0.2.0 on npm. The 0.3.0 and 0.4.0 development milestones were never published; their changes are folded into this release.

### Added

- **Configurable message language**: a `language` config (`zh` / `en`, default `zh`) on both `dsh-connect` and `dsh-connect-feishu` switches all user-facing messages (menus, command replies, status lines, image-download errors, help text) between Chinese and English.
- **Menu card polish**: the main menu is now grouped into sections ("Workspace / Session / Task / System") with titles and separators; the "❌ Exit" button uses a red danger style; an operation hint is shown at the card footer; the menu header theme color switched to a more prominent indigo. Choice menus now support optional `sections` (grouping) and `footer` (footer hint) rendering.
- **Smart image handling**: images sent via Feishu are downloaded automatically; if the main model supports vision (`inputModalities` includes image) it sees them directly, otherwise a "vision model" sub-task is invoked to describe the image content, and the description is injected into the main model — so a main model without image support no longer stalls the whole task.
- **Images staged into the workdir**: received images are copied to `<workdir>/.dsh-connect-images/` and the full paths are given to the agent, so even without a vision model the agent can locate the images with its tools.
- **Model capability detection**: automatically probes whether each model supports images; `/settings` model switching shows vision-capable models.
- **`visionModel` config**: `dsh-connect` gains `visionModel: { provider, model }` to pin the vision model for the image sub-task; when unset, the first image-capable model is auto-detected.
- **Adding new models**: models added via the DSH Web model settings are picked up automatically with their capabilities (including vision).
- **Token stats**: `/status` shows the current session's context tokens and session tokens (based on DSH `tokenMeter`).
- **Scheduled reminders**: `/schedule` (`/reminders`) lists scheduled reminders for this session; telling the agent "remind me in 5 minutes…" creates one (requires mounting `@deepseek-ai/dsh-schedule` in the profile).
- **Feishu one-click onboarding**: without `appId`/`appSecret`, the plugin enters onboarding mode and prints an onboarding link (valid ~10 minutes); scan it with Feishu or click and confirm, and the bot app is created automatically with permissions and event subscriptions preset. Credentials are saved for reuse (`$DSH_HOME/.dsh-connect/feishu-credentials.json`).
- READMEs added for both packages (npm package pages no longer show "no README").

### Fixed

- **Fixed Feishu image download failure (HTTP 400)**: images in user messages are now downloaded via the "get resource file from message" endpoint (`im.v1.messageResource.get`, with message_id + type=image). The old code used `im.v1.image.get` (download image), which per the Feishu docs can only download images uploaded by the bot itself, so user-sent images always failed with HTTP 400. The real Feishu error code/detail is also attached to the chat notice to help diagnose permission (`99991672`) and other issues.
- Fixed the missing README on npm package pages.
- Fixed pnpm hardlink EPERM on Windows during dependency reinstall (build environment switched to copy import; runtime unaffected).

## [0.2.0] - 2026-08-15

### Added

- **Interactive menu system** (`/menu`): hierarchical point-and-click (workdir / chats / settings / plugins / compact, …); the same card **updates in place**, supports "🔙 Back" / "❌ Exit", returns to the main menu automatically after an action — continuous operation with no more new cards every time.
- **Settings menu** (`/settings`):
  - Switch model: lists all models registered in DSH, tap to switch (writes to `agentDefaultModel`).
  - Reasoning effort: default / low / medium / high.
  - Notification settings: streaming output, end-of-turn summary toggles.
  - Config overview: model, reasoning effort, preset, workdir, workspaces, allowlists, etc.
- **New commands**: `/plugins` (list plugins), `/workspace <path>` (create a workspace), `/workspaces` (list all workspaces), `/compact` (compact context), `/history [count]` (recent messages), `/goals` (view goals), `/model` (view / switch model).
- Workdir default changed to "the first DSH workspace" (previously the process start directory, which could wrongly point at locations like `C:\Users\...`).
- The model's thinking phase now shows a "🤔 Deep thinking…" hint instead of sitting on the Thinking placeholder for a long time.
- Menu timeout (60 s) now updates the card to "menu expired" instead of silently hanging.
- Feishu buttons unified into a **3-column equal-width grid** (`column_set`), with empty columns auto-padded when there are fewer than 3; button labels are padded with full-width spaces to align by display width (CJK = 2 cells / ASCII = 1, excluding emoji zero-width chars).

### Changed

- All `/` commands are executed locally by the plugin and consume no model tokens.
- Session management upgraded: one chat can hold **multiple conversations** (switch / create / clear), recorded in `bindings.json`, still listable and resumable after restart.

### Fixed

- Fixed menu cards being "usable only once": tapping now updates the same card in place for continuous operation.
- Fixed `cannot get property "agents" without inject` when accessing `ctx.agents` / `ctx.sessions` in Feishu long-connection callbacks (switched to `ctx.get()`).
- Fixed `/dir` not listing DSH's existing workspaces (now wired to `workspaceRegistry`).
- Fixed new session routing not being recorded when agent resume fails.

## [0.1.0] - 2026-08-15

### Added

- First release: connects DeepSeek Harness (DSH) agents to Feishu / Lark.
- Bidirectional message sync: Feishu messages → DSH agent (`agent.followup`), replies stream back to Feishu (typewriter cards).
- Multi-turn context: each Feishu chat is bound to a DSH `Session`, automatically resumed after a process restart.
- Work arrangement: a result-summary card is pushed when a task ends; `ctx.connect.notify()` lets goals/jobs hooks push proactively.
- Basic local commands: `/new` `/clear` `/stop` `/status` `/help`.
- Security: groups require @mention by default, user/chat allowlists, credentials via environment variables or config.
- Layered architecture: `dsh-connect` (channel-agnostic core) + `dsh-connect-feishu` (Feishu adapter), with extension points reserved for DingTalk / WeCom and other channels.
