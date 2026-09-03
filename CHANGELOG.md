# Changelog

All notable changes to this project are documented following [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.8.0] - 2026-08-31

### Changed (breaking)

- **`dsh-connect` is now the single all-in-one plugin.** The former split packages — `dsh-connect-feishu`, `dsh-connect-telegram`, `dsh-connect-dingtalk`, `dsh-connect-web` and the `dsh-connect-all` bundle — were deleted. Everything (core `connect` service, all four channel adapters, and the web-settings stack) now ships in the one `dsh-connect` package. Install once:
  ```sh
  dsh plugin --profile web add dsh-connect
  ```
- **One config block**: all settings live under a single `dsh-connect` entry with a `channels` selector and `channelDefaults`, plus per-channel sub-keys:
  ```yaml
  - id: connect
    name: dsh-connect
    config:
      channels: [feishu, telegram]
      channelDefaults: { language: zh }
      feishu:   { appId: cli_xxxx, appSecret: REPLACE_ME, transport: websocket }
      telegram: { botToken: "123456:ABC" }
      dingtalk: { webhookUrl: "https://oapi.dingtalk.com/robot/send?access_token=xxx", stream: { clientId: "x", clientSecret: "y" } }
      web:      { pollIntervalMs: 1000 }
      settingsStatePath: .dsh-connect/settings.json
  ```
  The former per-plugin blocks (`connect-feishu`, `connect-telegram`, `connect-dingtalk`, `connect-web`) and the `dsh-connect-all` block must be migrated to this shape.
- **Feishu SDK is now a mandatory dependency** (`@larksuiteoapi/node-sdk`) rather than isolated in the Feishu adapter package.
- **Package export surface grows** (`dsh-connect/feishu`, `/telegram`, `/dingtalk`, `/web`, `/settings`) alongside the existing `.` and `/binding`.

### Added

- Web-settings stack absorbed into core: the `/dsh-connect` RPC channel (`settings.get`/`settings.save`/`settings.status` + `credentials.save`), the DSH credential-store adapter, JSON state persistence, and the client settings pane (`client/settings-client.mjs`). Secrets saved from the pane are injected on the next load via `injectSecrets` (dingtalk stream credentials are nested under `stream`).

### Fixed

- **Backward-compat: config-file credentials now show in the settings pane** (`dsh-connect`). On boot, `apply()` migrates channel secrets that already live in the config (e.g. a pre-consolidation `feishu.appId`/`appSecret` in `cordis.patch.yml`) into the credential store — only for refs the store doesn't already hold, so pane-saved credentials always win. The pane then reports those channels as `已配置` instead of `未配置凭据`, and prefills each channel's secret fields from the store (non-confidential ids like `appId` shown plain; real secrets masked). Secret values are never written into `dsh-connect-settings.json`. (`migrateConfigSecrets` in `src/index.ts`, `extractConfigSecrets` in `src/settings/channels.ts`, `SettingsSnapshot.secrets`, `client/settings-client.mjs`.)

## [0.7.0] - 2026-08-25

### Added

- **`/remind <time> <text>` — persistent chat-level reminders** (`dsh-connect` core). Schedules a one-shot reminder (`10分钟` / `2h` / `14:30`) stored in `stateDir/reminders.json`; a lightweight 15s loop delivers it when due **without waking the agent or spending model tokens**, and reminders survive process restarts. `/schedule` now lists both agent-level (`schedule` tool) and persistent reminders. (`src/scheduler.ts`, unit-tested.)
- **`/broadcast <text>` — admin broadcast** (`dsh-connect` core). Sends a message to every bound chat across all channels. Gated: requires a non-empty `allowUsers` and a sender listed in it; per-chat delivery failures are skipped and counted. (`service.broadcast`, unit/integration tested.)
- **`/send <path>` — send files from the workspace** (`dsh-connect` core + feishu/telegram). New optional `ChannelAdapter.sendFile` capability: feishu uploads via the SDK's `{ image: { source } }` / `{ file: { source, fileName } }` send shapes (images inline, everything else as an attachment); telegram uses `sendPhoto` / `sendDocument` multipart. `/send` resolves paths against the workdir, enforces a 20MB cap, and falls back to sending the path as text on channels without file support.
- **DingTalk stream mode — bidirectional** (`dsh-connect-dingtalk`). With `stream.clientId` / `stream.clientSecret` set, a ChannelAdapter is registered into `dsh-connect`: STOMP-over-WebSocket gateway client (`src/stomp.ts` codec, `src/stream.ts` client, zero new dependencies, lazy `globalThis.WebSocket` so the module loads on Node 20 and fails only at connect time), group @-mention gating, reply-to-origin via `msgId`, and **numbered-text menus** (answer with a number) as the honest stream-mode equivalent of button cards. Proactive pushes still go through the webhook service. Protocol details (codec, normalization, reply bodies) are unit-tested; the live boundary needs real app credentials.
- **Feishu thread isolation — optional** (`dsh-connect-feishu`). `threadIsolation: true` binds one DSH session per group thread (`chatKey = chatId:thread=<rootId>`) while outbound replies still target the base chat (in-thread via replyRef). Off by default; group behavior unchanged.

### Changed

- DingTalk is now a **two-way channel** in the channel matrix (stream mode), alongside the existing one-way webhook push service.
## [0.6.8] - 2026-08-24

### Fixed

- **mirror-lock queue: duplicate / mis-routed replay after lock release** (`dsh-connect` core). `releaseLock` fired `processQueuedMessages` without awaiting and then wrote a *stale* binding object, resurrecting the cleared queue — the same queued messages could be processed again on the next release. The drain is now awaited and the lock is cleared from a fresh read. Replayed messages also keep their true source `channel` and are routed back through the service into the runner of their own channel (a Web-originated message lands in the web runner, never the releasing feishu runner). The lock state machine (timeout / acquire / release / canWrite) moved into a pure, unit-tested module (`src/mirror-lock.ts`) used by the runner.
- **inbound events re-delivered after a reconnect were queued twice** (feishu). The core now deduplicates inbound messages by `(channel, chatKey, messageId)` with a sliding window (`src/dedup.ts`), so SDK re-delivery of the same event is dropped instead of running the same user message twice. Messages without an id are never deduplicated.

### Changed

- **outbound delivery now retries transient channel failures** (`dsh-connect` core). Every registered adapter's `sendText` / `sendCard` / `promptChoice` / `closeMenu` is wrapped with bounded retry (3 attempts, jittered exponential backoff) so a network blip or a 429/5xx no longer silently drops a user-visible message. `streamText` is deliberately excluded — a partially-streamed reply cannot be resumed. (`src/retry.ts`; unit-tested.)
- **`/export pdf` removed from the user-facing surface**: it was advertised in the command table but unimplemented (it only replied “not supported”). `/export pdf` now falls back to the Markdown export, and the help text, README (zh/en) and `MIRROR_SESSION` docs no longer list a PDF option. A real PDF pipeline can be added later without touching the command surface.
- **new CI workflow** (`.github/workflows/ci.yml`): every push to `main` and every pull request runs build + typecheck + all six test suites on Node 20 and 22, mirroring the publish gate.
## [0.6.7] - 2026-08-24

### Added

- **`/ps <note>` — append to the running task**: while a task is executing, `/ps <note>` (alias `/append`) injects the note into the in-flight task via the agent's steering inbox — a running driver consumes it at its next step boundary, so the user can steer the current task instead of queueing a new turn behind it. When the agent is idle it starts a turn like a normal message. While a task runs, ordinary messages now reply with a hint that `/ps <note>` can append to the running task (or `/stop` to cancel) instead of silently queueing.
- **proactive context-high nudge**: while a turn runs, observed context usage vs. the model window is tracked; when it crosses 75% the user is asked (once per turn) whether to compact now. If the task is still running, compaction is deferred and runs automatically right after the turn ends.

### Fixed

- **dsh refuses to boot (`duplicate loader entry id: connect`)** when this plugin is installed on a fresh profile: since 0.6.4 each package auto-registers via its `dsh.bundle.patch` manifest, so the profile's `cordis.patch.yml` must only *override* their config — re-`insert`ing the same ids (`connect`, `connect-feishu`, …) makes the loader throw `duplicate loader entry id` and dsh aborts at startup. The docs and `examples/profile-cordis.patch.yml` now show the override form (plus `disabled: true` for disabling) instead of `insert` blocks.
- **`config: null` crash on load**: the DSH loader passes `null` (not `undefined`) as plugin config for entries without an explicit config, and does not run schema coercion on this path. `ConnectService` (constructed directly as the default export) and every adapter's `apply()` dereferenced the raw config and threw `Cannot read properties of null (reading 'workDir')`, so even a correct profile failed to boot until `connect` was given a non-null `config`. All five packages now normalize `config ?? {}` before use.

### Changed

- **inbound errors are never silent**: the core no longer fire-and-forgets `handleInbound` — failures are caught and logged as `connect: inbound handling failed` instead of vanishing as unhandled rejections, so adapter-side crashes surface in the `dsh web` log.
- **feishu inbound visibility**: the adapter logs each received message at `info` level (`connect-feishu: received message chat=… sender=… type=… len=…`) before the allowlist gate, so "sent but bot silent" is instantly diagnosable as events-not-arriving vs. events-rejected.

## [0.6.6] - 2026-08-21

### Added

- **feishu history after `/dir`**: the "switch conversation" menu and `/history` now list every session the DSH workspace registry attaches to the current work directory (binding records plus Web-created / older-chat sessions, titles via `sessionQuery.readTitle`, sorted by recency) instead of a bare new-chat entry or a "no active session" error. After switching work directories the historical conversations of that directory are visible and switchable, matching the Web GUI.
- **feishu menu feedback**: every menu button press now answers visibly — switching sessions/work directories, new chat, model and reasoning-effort changes, and placeholder buttons (no history / no models) send a result message (success or why nothing changed) before the menu returns, so users never have to guess whether a press worked. The new-chat confirm prompt reuses the menu card instead of leaving a stale card behind.

### Fixed

- **feishu session titles**: session lists rendered `[object Object]` for Web-created / older-chat sessions because `sessionQuery.readTitle` returns a `SessionTitleSnapshot` object, not the bare title string. The title is now unwrapped (and a plain string still accepted), so work-directory session lists show real titles.
- **feishu menu under rapid taps**: rapid menu navigation (switching workspace, switching conversation, going back…) no longer lands in the wrong menu or freezes. The pending tap listener is registered before the card redraw, so taps arriving mid-redraw are handled instead of dropped as "stale", and a leftover tap from a previous card generation redraws the current menu instead of silently ending the chain.

### Changed

- **terminology**: user-facing copy now consistently says "workspace" (工作区) instead of mixing "work directory" (工作目录) and "workspace" for the same concept — menu labels, `/dir` help, welcome text, status/settings fields and empty-history messages, matching the Web GUI and the `/workspace` `/workspaces` commands. The `/dir` command name and `workDir` config key are unchanged.

## [0.6.5] - 2026-08-20

### Fixed

- **feishu (`dsh-connect-feishu`) hotfix for 0.6.4**: the pre-download allowlist gate crashed on every inbound message — `connect.isChatAllowed` was passed to the adapter as a bare method reference, so invoking it as `this.isChatAllowed(...)` lost the `ConnectService` `this` and threw `Cannot read properties of undefined (reading 'allowUsers')` on every Feishu message (the bot appeared unresponsive). The method is now bound at construction (`connect.isChatAllowed?.bind(connect)`); messages route normally again. **Anyone who installed 0.6.4 must upgrade to 0.6.5.**

## [0.6.4] - 2026-08-20

### Added

- **`dsh.bundle` manifest for `dsh plugin add`** — every package now declares `dsh.bundle.patch` (`./cordis.patch.yml`) in its `package.json` and ships a per-package `cordis.patch.yml` (listed in `files`), so `dsh plugin --profile <name> add dsh-connect dsh-connect-feishu …` installs the packages as proper profile bundle layers (auto-applied, no manual `cordis.patch.yml` editing) instead of plain dependencies.

## [0.6.3] - 2026-08-20

### Fixed

- **core (`dsh-connect`)**:
  - Command dispatch errors no longer crash the host: a failed command's promise rejection is now handled, so an unhandled rejection can't take the process down.
  - `driveAgent`'s streaming error path now guarantees the chunk stream terminates — the streaming card no longer hangs forever, and queues / iterators no longer leak.
  - `buildUserContent` now includes attachments for pure-file messages and vision-capable main models too (previously files were silently dropped).
  - `/new` `/clear` `/switchTo` now reset `webMirrorSessionId` / `lockOwner` and queued messages, so a stale mirror can no longer point at an old session.
  - The mirror mutual-exclusion lock now applies only to the feishu/web channels (telegram/dingtalk are no longer misjudged as web).
  - `getLastTurnInfo` and reminder times use the session language instead of hardcoded `zh-CN`.
  - `/settings` no longer shows the invalid "streaming output / end-of-turn summary" toggles; 10 unused i18n keys removed.
  - The Config schema now explicitly declares `autoMirror`.
- **telegram (`dsh-connect-telegram`)**:
  - Fixed a missing-brace compile error (TS1128).
  - The bot's own messages are now ignored (`is_bot` filter), eliminating the echo loop.
  - `streamText` now accumulates the full text, truncates at 4096 chars and throttles to ~700 ms (previously only deltas were sent, losing content).
  - `getUpdates` long polling is no longer cut short by the 15 s client timeout — the 50 s polling window now actually applies.
  - The offset is confirmed per single update (a failed update no longer loses the whole batch).
  - HTML conversion now fully escapes `& < >` in plain text (previously it could break parse mode).
  - @-mentions now match exactly against the cached `getMe` identity (replying to a normal user no longer misfires).
  - Choice buttons are keyed by the composite `(chatId, optionId)` (concurrent menus no longer overwrite each other).
  - After the timeout, the keyboard is replaced with a "menu expired" notice.
  - Voice / video / audio downloads are now supported.
  - `edited_message` is ignored (streaming edits no longer re-trigger the agent).
  - Unit tests added (escaping / mentions / offset semantics, mocked fetch).
- **feishu (`dsh-connect-feishu`)**:
  - Allowlists can pre-filter before the adapter downloads resources (new public `isChatAllowed` on the connect service).
  - Downloads now have a 20 MB cap and 60 s timeout, async writes, and a 24 h automatic cleanup of the temp dirs.
  - `transport: "webhook"` is truly implemented (bundled `node:http` server + automatic `url_verification` response; `webhookPort` / `webhookPath` configurable).
  - `reject` event logs no longer include PII.
  - Credential files are saved with `chmod 0600`.
  - `stop()` clears choice / stale-reminder timers.
  - Pure functions exported and 8 new unit tests added.
- **dingtalk (`dsh-connect-dingtalk`)**:
  - Network errors and the `errcode 130101` frequency limit now retry with automatic backoff (up to 3 attempts, configurable delay).
  - Markdown bodies are truncated at 20000 chars.
  - `verifyDingtalkSignature` now compares after URL-decoding and enforces a ±5-minute timestamp freshness window (previously encoding mismatches made the signature always fail).
  - Removed the unused `md5Hex` export and 4 dead i18n keys.
  - Tests expanded to 11 (retry / rate-limit / truncation).
- **connect-web / packaging**:
  - `dsh-connect` gained a `"./binding"` export subpath (fixes TS2307 and the runtime `ERR_PACKAGE_PATH_NOT_EXPORTED`).
  - `getBindingStore` now uses the public `bindingStore` getter.
  - Removed the synthetic `[Mirror]` inbound message (it used to create a spurious web runner and burn a real agent turn).
  - `connect-web` tests migrated from vitest to `node:test` and wired into the root `pnpm test`.
  - `dsh-connect-web` `package.json` now ships `README.zh.md` / `README.i18n.yaml` via a `files` field and declares `repository` / `homepage` / `bugs` like the other packages.

### Changed

- **CI / configuration**: `publish.yml` now runs `pnpm build` before test and publish, adds a typecheck step, and publishes the 5 packages serially (connect first). `dsh.shared.config.json` dropped dead keys nobody reads (`bindingsFile` / `sessionStorePath` / `defaultTimeoutMinutes` / `enableLocking`).
- **Documentation sync**: all docs updated to match the code (root README + package READMEs, QUICKSTART, feishu/telegram/dingtalk setup guides, PUBLISHING, MIRROR_SESSION, SHARED_WORKSPACE_SETUP, ENHANCEMENTS_SUMMARY, and a new bilingual `docs/WEB_MIRROR_IMPLEMENTATION.md` + `docs/WEB_MIRROR_IMPLEMENTATION.zh.md`); DingTalk is now honestly described as a one-way push service (no inbound, no automatic lifecycle hooks), the mirror lock is documented as one-sided (Feishu-side only), dead config keys and the broken `$schema` reference were removed, and the publish claims were unified across README and QUICKSTART.

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