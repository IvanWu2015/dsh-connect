# Changelog

All notable changes to this project are documented following [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- **Configurable message language**: a `language` config (`zh` / `en`, default `zh`) on both `dsh-connect` and `dsh-connect-feishu` switches all user-facing messages (menus, command replies, status lines, image-download errors, help text) between Chinese and English.
- **Menu card polish**: the main menu is now grouped into sections ("Workspace / Session / Task / System") with titles and separators; the "❌ Exit" button uses a red danger style; an operation hint is shown at the card footer; the menu header theme color switched to a more prominent indigo. Choice menus now support optional `sections` (grouping) and `footer` (footer hint) rendering.

### Fixed

- **Fixed Feishu image download failure (HTTP 400)**: images in user messages are now downloaded via the "get resource file from message" endpoint (`im.v1.messageResource.get`, with message_id + type=image). The old code used `im.v1.image.get` (download image), which per the Feishu docs can only download images uploaded by the bot itself, so user-sent images always failed with HTTP 400. The real Feishu error code/detail is also attached to the chat notice to help diagnose permission (`99991672`) and other issues.

## [0.4.0] - 2026-08-15

### Added

- **Smart image handling**: images sent via Feishu are downloaded automatically; if the main model supports vision (`inputModalities` includes image) it sees them directly, otherwise a "vision model" sub-task is invoked to describe the image content, and the description is injected into the main model — so a main model without image support no longer stalls the whole task.
- **Images staged into the workdir**: received images are copied to `<workdir>/.dsh-connect-images/` and the full paths are given to the agent, so even without a vision model the agent can locate the images with its tools.
- **Model capability detection**: automatically probes whether each model supports images; `/settings` model switching shows vision-capable models.
- **`visionModel` config**: `dsh-connect` gains `visionModel: { provider, model }` to pin the vision model for the image sub-task; when unset, the first image-capable model is auto-detected.
- **Adding new models**: models added via the DSH Web model settings are picked up automatically with their capabilities (including vision).

## [0.3.0] - 2026-08-15

### Added

- **Token stats**: `/status` shows the current session's context tokens and session tokens (based on DSH `tokenMeter`).
- **Scheduled reminders**: `/schedule` (`/reminders`) lists scheduled reminders for this session; telling the agent "remind me in 5 minutes…" creates one (requires mounting `@deepseek-ai/dsh-schedule` in the profile).
- **Feishu one-click onboarding**: without `appId`/`appSecret`, the plugin enters onboarding mode and prints an onboarding link (valid ~10 minutes); scan it with Feishu or click and confirm, and the bot app is created automatically with permissions and event subscriptions preset. Credentials are saved for reuse (`$DSH_HOME/.dsh-connect/feishu-credentials.json`).
- READMEs added for both packages (npm package pages no longer show "no README").

### Fixed

- Fixed the missing README on npm package pages (0.2.1 content merged into this release).
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
