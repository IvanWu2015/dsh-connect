# dsh-connect

Connect [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (**DSH**) agents to chat platforms — **Feishu / Lark first**, with DingTalk and others to follow. Send tasks from your messaging app, watch the agent execute with live streaming output, keep multi-turn context, and get result summaries pushed back when a task finishes.

## Features

- **Bidirectional messaging**: Feishu messages → DSH agent (`agent.followup`); agent replies stream back to Feishu as typewriter-style cards.
- **Multi-turn context**: each Feishu chat (DM or group) is bound to a DSH `Session`, automatically `resume`d after a process restart.
- **Work arrangement**: pushes a result-summary card when a task ends; `ctx.connect.notify()` lets goals/jobs hooks push progress proactively.
- **Task-end stats**: when a task finishes, a card reports the model used, input/output/cached tokens, step count, duration and context usage, with a `/compact` suggestion when the context is ≥ 75% full.
- **Notification levels**: `full` (stream everything) / `important` (key milestones, default) / `result` (answer only) — switchable per chat via the settings menu or `/notify`, persisted across restarts.
- **Instant feedback + proactive progress**: every task is acknowledged the moment it is received (“✅ 已收到，开始处理”, with the queued-message count when busy), key milestones (thinking, tool calls with step counters, questions, permissions) react live, and a configurable watchdog sends a standalone status card when a turn has been silent for too long (default 5 min, per-chat adjustable via `/progress` or `/settings`).
- **First-time welcome**: the first message in each chat triggers a one-time welcome card introducing the bot's capabilities and common commands.
- **Actionable errors**: failed tasks show a suggestion matched to the error — permission / network / model-quota problems each get their own fix hint instead of a bare error string.
- **Safe destructive actions**: `/clear`, `/new` and the menu's “新建对话” ask for confirmation first, so history is never wiped by accident.
- **User choices & permission approvals in chat**: when the agent asks a question (`ask_user_question`) or requests a permission approval (sandbox escalation etc.), an interactive card with buttons appears right in Feishu — answer by tapping or by replying with text (number or option label); no need to open the Web GUI.
- **Security**: groups require @mention by default; user/chat allowlists; Feishu credentials via environment variables or config.
- **Interactive menus**: `/menu` offers hierarchical point-and-click navigation (workdir / chats / settings / plugins / compact, …) — the same card updates in place, supports back/exit, and stays usable across consecutive actions.
- **Smart image & file handling**: images sent to the bot are downloaded automatically; if the main model supports vision it sees them directly, otherwise a vision-model sub-task describes them and the description is injected — so a text-only main model never stalls on images. Attached files/audio/video are also downloaded into the workdir.
- **Web mirror**: each chat can mirror its DSH session into the DSH Web GUI (`/mirror`, or automatic via `autoMirror`), sharing the same conversation with mutual-exclusion locking.
- **Local commands** (no model tokens): `/status` `/task` `/chat` `/dir` `/workspace` `/workspaces` `/plugins` `/compact` `/history` `/goals` `/schedule` `/model` `/notify` `/progress` `/mirror` `/new` `/clear` `/stop` `/settings` `/help`.
- **Extensible**: `dsh-connect` (channel-agnostic core) + `dsh-connect-feishu` (Feishu adapter) are layered; adding DingTalk only requires one more adapter package.

## Repository layout

```
packages/
  connect/         dsh-connect core: services, bindings, runner, streaming bridge, commands
  connect-feishu/  dsh-connect-feishu Feishu adapter: createLarkChannel long connection, normalization, streaming replies
docs/
  QUICKSTART.md    step-by-step run guide (DSH side + Feishu side)
  feishu-setup.md  Feishu Open Platform configuration manual
  PUBLISHING.md    naming + GitHub/npm discoverability guide
examples/
  profile-cordis.patch.yml
```

## Quick start

### Install

Published to npm — install straight into your DSH profile:

```sh
dsh plugin --profile web add dsh-connect dsh-connect-feishu
```

### Configure

Append to the profile's `cordis.patch.yml` (`$DSH_HOME/profiles/web/cordis.patch.yml`) with an `insert` block (Host plane):

```yaml
- insert:
    - id: connect
      name: dsh-connect
    - id: connect-feishu
      name: dsh-connect-feishu
      config:
        appId: cli_xxxx
        appSecret: cli_secret_xxxx
        transport: websocket
        requireMention: true
        dmMode: open
```

### Run

Restart `dsh web` (Host plugins require a process restart to load), complete the Feishu-side subscription per [docs/feishu-setup.md](docs/feishu-setup.md), then chat with the bot in Feishu.

> Detailed step-by-step instructions (including Feishu-side setup and verification) are in [docs/QUICKSTART.md](docs/QUICKSTART.md).

## Command list

| Command | Description |
|---|---|
| `/menu` | Open the main menu (hierarchical point-and-click; the same card updates in place; back / exit supported) |
| `/settings` (`/set`) | Settings: switch model / reasoning effort / notification level / config overview |
| `/model` | Show the current model, tap to switch |
| `/notify` (`/notice`) | Choose the notification level: `full` / `important` / `result` (takes effect immediately) |
| `/progress` | Choose how long a silent task may run before a proactive progress card is sent (default 5 min; `关闭` disables) |
| `/mirror [--timeout N]` | Create (or show) the Web mirror session for this chat; optional lock timeout in minutes |
| `/status` | Session status, model, workdir, queue length, **context tokens**, session ID |
| `/task` (`/tasks` `/todo`) | Show the current task list |
| `/schedule` (`/reminders`) | Show scheduled reminders for this session |
| `/chat` (`/session` `/sessions`) | List chats; tap to switch or create a new one |
| `/dir` (`/cd` `/pwd`) | Switch workdir (tap to pick, or `/dir <absolute path>`) |
| `/workspace <absolute path>` | Create a new workspace |
| `/workspaces` | List all workspaces |
| `/plugins` | List installed plugins |
| `/compact` | Compact the current session context |
| `/history [count]` | Show recent session messages |
| `/goals` | Show current goals |
| `/new` (`/reset`) | Start a new conversation (asks for confirmation) |
| `/clear` | Clear the current conversation (asks for confirmation) |
| `/stop` (`/cancel`) | Stop the current task |
| `/help` | List all commands |

> All `/` commands are executed locally by the plugin and consume no model tokens; any other text is sent to the DSH agent as a task.

## Configuration

### dsh-connect (core)

| Key | Default | Description |
|---|---|---|
| `agentPreset` | unset = roster default | Agent preset used for each bound session (e.g. `standard`) |
| `workDir` | first DSH workspace | Agent working directory (absolute path, can be set explicitly) |
| `workspaces` | `[]` | Workdirs listed in the `/dir` interactive picker |
| `visionModel` | auto-detected | Vision model `{provider, model}` for the image sub-task; when unset, the first image-capable model is auto-detected |
| `language` | `zh` | User-facing message language: `zh` (default) or `en` |
| `allowUsers` | `[]` | Sender allowlist (empty = allow all) |
| `allowChats` | `[]` | Chat allowlist (empty = allow all) |
| `stateDir` | `./.dsh-connect` | Directory for the binding route `bindings.json` |
| `autoMirror` | `true` | Automatically create a Web mirror session for every new chat |
| `streamHeartbeatMs` | `60000` | Streaming-card liveness heartbeat (ms); `0` disables it |
| `notifyLevel` | `important` | Default notification level: `full` (stream everything) / `important` (key milestones) / `result` (answer only); per-chat override via `/settings` or `/notify` |
| `progressTimeoutMs` | `300000` | Proactive progress-notice interval (ms): when a turn has sent nothing for this long, a standalone status card is pushed; `0` disables; per-chat override via `/settings` or `/progress` |

### dsh-connect-feishu (Feishu)

| Key | Default | Description |
|---|---|---|
| `appId` / `appSecret` | env `FEISHU_APP_ID` / `FEISHU_APP_SECRET`, or **one-click onboarding** | App credentials (when unset, onboarding mode starts and creates the app via QR scan) |
| `transport` | `websocket` | Long connection (recommended); `webhook` needs a public HTTPS URL |
| `verificationToken` / `encryptKey` | empty | Only needed for webhook mode |
| `requireMention` | `true` | Groups only respond when the bot is @mentioned |
| `dmMode` | `open` | DM policy: `open` receive / `closed` ignore |
| `language` | `zh` | User-facing message language: `zh` (default) or `en` |

> **One-click onboarding**: start the plugin without `appId`/`appSecret` and it prints an onboarding link (valid ~10 minutes). Scan it with Feishu (or click and confirm) and the bot app is created automatically with permissions and event subscriptions preset; credentials are saved to `$DSH_HOME/.dsh-connect/feishu-credentials.json`.

## How it works

- **Agent create/resume**: reuses the standard DSH driving pattern (see `dsh-headless`) — `ctx.agents.create({ meta:{cwd, agentPreset}, agentOptions:{provider,model}, setup })`; resume goes through `ctx.agents.resume`. Model selection per session is owned by the DSH api-proxy (`selectionFor`), so switching models in the Web GUI applies to the bound sessions.
- **Preset mounting**: `setup` mounts the configured agent preset (`ctx.agentPresets.mount`), giving bound sessions the standard toolset (bash/fs/…).
- **Streaming**: `assistant/chunk` events (reasoning/text deltas, block starts/ends) on `session/event` are bridged via `createAsyncQueue` into the Feishu streaming card; blocks are separated by blank lines, reasoning is streamed live, tool calls show a status line, and a configurable heartbeat keeps the card alive during long silent phases. `turn/end` decides the turn outcome and posts the task-stats card.
- **Proactive progress**: each message is acknowledged immediately; if no standalone card/text has been sent for `progressTimeoutMs`, a status card reports the latest milestone (thinking / last tool call) so a long turn never looks frozen.
- **Interactive choices & approvals**: the plugin acts as an in-process client of the host api-proxy (`ctx.apiProxy`): it subscribes to the same mux stream the Web GUI uses, renders `question/requested` / `approval/requested` frames for connect-bound sessions as Feishu cards with buttons, and feeds the user's answer back through `apiProxy.respond` — the Web GUI stays fully functional, first answer wins.
- **Serialization**: one `AgentRunner` per chatKey — messages are queued and executed serially; `agent.followup` naturally queues.

## Testing

```sh
pnpm build        # build first (generates lib/)
pnpm test         # unit tests (pure logic) + smoke test (Cordis runtime load contract)
```

- `packages/connect/test/unit.test.mjs`: command parsing, binding persistence, async queue, turn outcome derivation.
- `packages/connect/test/smoke.mjs`: loads both plugins into a real Cordis context, verifying `ctx.connect` service registration, adapter registration, allowlist authorization, proactive `notify` push, and Feishu adapter construction.

## Documentation

- [Feishu Open Platform configuration](docs/feishu-setup.md)
- [Naming and GitHub/npm discoverability](docs/PUBLISHING.md)
- [Example configuration](examples/profile-cordis.patch.yml)

## License

MIT
