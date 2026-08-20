# dsh-connect

English | [中文](README.zh.md)

The **channel-agnostic core** for connecting [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (**DSH**) agents to chat platforms (Feishu / Lark, Telegram, DingTalk; more to come): session binding, agent driving, streaming reply bridging, interactive menu cards, and local commands.

> Install together with a channel adapter — e.g. [dsh-connect-feishu](https://www.npmjs.com/package/dsh-connect-feishu), [dsh-connect-telegram](https://www.npmjs.com/package/dsh-connect-telegram) or the push-only [dsh-connect-dingtalk](https://www.npmjs.com/package/dsh-connect-dingtalk) — or the optional [dsh-connect-web](https://www.npmjs.com/package/dsh-connect-web) mirror monitor.

## Overview

`dsh-connect` binds a chat conversation to a DSH agent session and drives it end to end:

- **Session binding & routing** — one chat ⇄ one agent session, persisted in a `bindings.json` route store; sessions can be created, resumed, switched, cleared and mirrored to the DSH Web GUI.
- **Streaming replies** — DSH `assistant/chunk` events are bridged into the channel's native streaming (Feishu typewriter cards): the thinking hint opens the reasoning phase, reasoning streams live with readable paragraph breaks, tool calls appear as `🔧` progress lines, and a liveness heartbeat keeps the card moving even through long silent stretches (long first-token waits, heavy tool runs) so it never sits frozen on "Thinking…".
- **Notification levels** — per-chat control over how much of the process is streamed: `尽量输出过程` (full process) / `输出重要节点` (key milestones) / `只输出结果` (result only). Switch any time via the settings menu or `/notify`; the choice is persisted per chat and applies immediately.
- **Task-end stats** — after every task a compact card reports the model used, input/output tokens, elapsed time and context-window usage, and suggests `/compact` when the context is getting full.
- **Interactive menus** — button cards for status, tasks, history, goals, schedule, model/effort switching, workspace picking, language, and more (see the in-chat `/` commands).
- **Media handling** — downloads user images/attachments, passes them to a vision-capable model (or a configured vision model) so text-only main models never stall on images.
- **Locking & queuing** — per-chat write locks coordinate Feishu and Web writers; queued messages drain when the lock releases.
- **Web mirror (auto)** — every Feishu conversation is automatically available in the DSH Web GUI as a mirrored session (disable with `autoMirror: false`).

**Who is it for?** Anyone running DSH who wants to operate agents from a chat platform — solo operators running a bot for their own workspaces, and small teams sharing a bot in group chats with an allowlist.

## Compatibility

| Aspect | Value |
|---|---|
| DSH version | `^0.1.0-rc.6` (peer `@deepseek-ai/dsh-agent`, `dsh-llm`, `dsh-session`) |
| Cordis | `^4.0.1` |
| Node.js | ≥ 20 (ESM, `NodeNext`) |
| Last verified | **2026-08-16** against DSH `0.1.0-rc.6` on Windows (Feishu WebSocket transport) |

The plugin runs on the DSH **Host plane** (process-level singleton services), not inside an agent preset.

## Install / Uninstall

Plugin management is a thin wrapper over pnpm in the DSH profile:

```sh
# Install (core + Feishu adapter)
dsh plugin --profile web add dsh-connect dsh-connect-feishu

# Optional: Web mirror monitor
dsh plugin --profile web add dsh-connect-web
```

**Upgrade**

```sh
dsh plugin --profile web update dsh-connect dsh-connect-feishu
```

**Disable** — remove the entries from the profile patch so the plugins stop loading (see `~/.dsh/profiles/<profile>/cordis.patch.yml`):

```yaml
- insert:
    - id: connect        # delete this block (and connect-feishu) to disable
      name: dsh-connect
```

**Complete removal** — uninstall the packages and delete the data they created:

```sh
dsh plugin --profile web remove dsh-connect dsh-connect-feishu
# then remove the plugin data (see "Permissions & data" below):
rm -rf .dsh-connect            # binding route store (stateDir)
rm -f ~/.dsh/.dsh-connect/feishu-credentials.json
```

## Quick start

1. **Install the plugins** (see above).
2. **Add the minimal config** to `~/.dsh/profiles/<profile>/cordis.patch.yml` (also see [`examples/profile-cordis.patch.yml`](../../examples/profile-cordis.patch.yml)):

   ```yaml
   - insert:
       - id: connect
         name: dsh-connect
         # workDir: D:\your\workdir     # agent working directory (default: process cwd)
       - id: connect-feishu
         name: dsh-connect-feishu
         config:
           appId: cli_xxxx
           appSecret: cli_secret_xxxx
           transport: websocket
           requireMention: true
           dmMode: open
   ```

3. **Start the host** — `dsh web` (or `dsh run`). With no credentials configured, `dsh-connect-feishu` enters **one-click onboarding**: scan the QR / open the link from the log to authorize the bot.
4. **Send a message** to the bot in Feishu. The bot replies with a streaming card; `/help` lists all commands; the conversation also appears in the DSH Web GUI automatically (auto-mirror).

A fully reproducible example is the `examples/` folder plus `docs/feishu-setup.md` (Feishu app creation, event subscriptions, publishing).

## Configuration

Configuration lives in the DSH profile patch (`cordis.patch.yml`) under each plugin's `config:`. `dsh.shared.config.json` in the project root (or its parent) can supply workspace/state defaults that take precedence for those keys.

### `dsh-connect` (core)

| Key | Default | Description |
|---|---|---|
| `agentPreset` | roster default | Agent preset id composed into each bound session |
| `workDir` | process cwd | Absolute working directory for each bound agent |
| `workspaces` | `[]` | Extra workdirs offered by the `/dir` picker |
| `visionModel` | auto-detected | `{ provider, model }` used to describe images when the main model can't see them |
| `language` | `zh` | User-facing message language: `zh` / `en` |
| `allowUsers` | `[]` | Sender allowlist (open_id). Empty = allow all |
| `allowChats` | `[]` | Chat allowlist (chat_id). Empty = allow all |
| `stateDir` | `.dsh-connect` | Directory holding the `bindings.json` route store (env `DSH_CONNECT_STATE_DIR` overrides) |
| `autoMirror` | `true` | Automatically create a Web GUI mirror for every new session |
| `streamHeartbeatMs` | `60000` | Liveness heartbeat interval (ms) for the streaming card; `0` disables it |
| `notifyLevel` | `important` | Default notification level: `full` (stream everything) / `important` (key milestones) / `result` (answer only); per-chat override via settings menu or `/notify` |
| `progressTimeoutMs` | `300000` | Proactive progress-notice interval (ms): when a turn has sent no standalone card/text for this long, a status card reports the latest milestone; `0` disables; per-chat override via settings menu or `/progress` |

### `dsh-connect-feishu` (adapter)

| Key | Default | Description |
|---|---|---|
| `appId` | env `FEISHU_APP_ID` | Feishu custom app id (**secret**) |
| `appSecret` | env `FEISHU_APP_SECRET` | Feishu custom app secret (**secret**) |
| `transport` | `websocket` | `websocket` = long connection (no public network); `webhook` needs public HTTPS |
| `verificationToken` | — | Webhook verification token (**secret**) |
| `encryptKey` | — | Webhook encrypt key (**secret**) |
| `webhookPort` | `9000` | HTTP port for the built-in webhook server when `transport: "webhook"` |
| `webhookPath` | `/` | URL path the Feishu event callback posts to (webhook transport) |
| `requireMention` | `true` | Groups only respond when the bot is @mentioned |
| `dmMode` | `open` | DM policy: `open` / `allowlist` / `pair` / `disabled` |
| `language` | `zh` | User-facing message language: `zh` / `en` |

**Environment variables**

| Variable | Purpose |
|---|---|
| `FEISHU_APP_ID` / `FEISHU_APP_SECRET` | Feishu credentials — preferred over putting secrets in config files |
| `DSH_CONNECT_STATE_DIR` | Overrides `stateDir` for the binding store |
| `DSH_HOME` | Overrides the `~/.dsh` base for credential files |

**Sensitive items** — `appSecret`, `verificationToken`, `encryptKey`, and `feishu-credentials.json`. Prefer environment variables or one-click onboarding; keep them out of version control.

## Permissions & data

- **Files written**
  - `<stateDir>/bindings.json` (default `.dsh-connect/`) — the chat ⇄ session route store (chat keys, session ids, mirror and lock state).
  - `~/.dsh/.dsh-connect/feishu-credentials.json` — Feishu credentials saved by one-click onboarding.
  - `<workDir>/.dsh-connect-images/` — user images/attachments staged for the agent's tools.
  - DSH's own session logs and settings under `~/.dsh/` (sessions, settings, etc.).
- **Network**
  - Feishu Open Platform: WebSocket long connection (or webhook over public HTTPS), plus HTTPS API calls (media download, cards).
  - LLM provider APIs used by DSH for the agent's model (e.g. DeepSeek), plus the optional vision model.
- **User data** — message text and attachments flow through the bot to the agent session; they are stored in the DSH session log like any DSH conversation. The allowlists (`allowUsers` / `allowChats`) limit who can drive the bot.

## Troubleshooting

Logs come from the DSH host logger (run `dsh web` in a terminal); plugin messages are prefixed `connect:` / `connect-feishu:`.

| Symptom | Likely cause / fix |
|---|---|
| `connect-feishu: adapter init failed` / `start failed` | Bad credentials, app not published, or network blocked. Check `appId`/`appSecret`, re-run onboarding, verify the bot is online in the Feishu console. |
| `connect: resume of <id> failed, creating fresh session` | The persisted session could not be resumed (missing workdir, persistence issue). Check `workDir` and `~/.dsh/sessions`. |
| Session-locked notices | Another client (Feishu or Web) holds the write lock. Use `/unlock` or wait for the lock timeout. |
| Model switch in the Web GUI appears ignored | Fixed in the current main: the plugin no longer pins a static default model over the Web GUI's session selection. Restart `dsh web` so the rebuilt plugin is loaded. |
| `[用户发送了图片，但下载失败…]` | Feishu `im:resource` permission is missing on the app; grant it and re-approve. |
| Streaming reply is one unbroken blob | Fixed in the current main: block boundaries and the reasoning/answer split now insert blank lines (and reasoning soft breaks are expanded for Feishu cards). Restart `dsh web`. |
| Card frozen on "Thinking…" with no progress on a long task | Fixed in the current main: reasoning now streams live, tool calls show as `🔧` progress lines, and a liveness heartbeat updates the card during silent stretches. Restart `dsh web`. |
| Menu cards don't update / expire | Cards auto-close after 60 s idle by design; re-open the menu. |

**Rollback** — reinstall a previous release (`dsh plugin --profile web add dsh-connect@<version>` after removing the current one), or `git checkout` the pinned commit in a source install.

## Development

This is a pnpm workspace; the plugins are independent npm packages under `packages/`:

```
packages/
  connect/          # this package — channel-agnostic core
  connect-feishu/   # Feishu / Lark adapter
  connect-telegram/ # Telegram adapter (getUpdates long polling)
  connect-dingtalk/ # DingTalk group-webhook push channel
  connect-web/      # optional Web mirror monitor
```

```sh
pnpm install

# build & typecheck one package
pnpm --filter dsh-connect build
pnpm --filter dsh-connect typecheck

# unit tests (node:test)
pnpm test
# or run one suite
node packages/connect/test/unit.test.mjs
```

**Structure** — `src/runner.ts` owns the per-chat agent driver and the streaming bridge (`applyStreamChunk` is the pure, unit-tested chunk assembler); `src/service.ts` owns the adapter registry and routing; `src/i18n.ts` holds the `zh`/`en` dictionaries (keep keys in sync across both); `src/binding.ts` is the route store.

**Contributing** — PRs welcome at [github.com/IvanWu2015/dsh-connect](https://github.com/IvanWu2015/dsh-connect). For user-facing strings, add the key to both `zh` and `en` in `src/i18n.ts`. Release notes live in `CHANGELOG.md`; see `docs/PUBLISHING.md` for the release flow.

## License & security

- **License:** MIT (see `LICENSE`).
- **Security:** report vulnerabilities **privately** — use the GitHub security advisory flow on the repository, or contact the maintainer via the email listed on the GitHub profile. Please do not open public issues for credential exposure. Treat `appSecret` / `verificationToken` / `encryptKey` / `feishu-credentials.json` as secrets: prefer environment variables, and never commit them.
