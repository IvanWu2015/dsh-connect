# dsh-connect

Connect [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (**DSH**) agents to chat platforms — **Feishu / Lark first**, with DingTalk and others to follow. Send tasks from your messaging app, watch the agent execute with live streaming output, keep multi-turn context, and get result summaries pushed back when a task finishes.

## Features

- **Bidirectional messaging**: Feishu messages → DSH agent (`agent.followup`); agent replies stream back to Feishu as typewriter-style cards.
- **Multi-turn context**: each Feishu chat (DM or group) is bound to a DSH `Session`, automatically `resume`d after a process restart.
- **Work arrangement**: pushes a result-summary card when a task ends; `ctx.connect.notify()` lets goals/jobs hooks push progress proactively.
- **Security**: groups require @mention by default; user/chat allowlists; Feishu credentials via environment variables or config.
- **Interactive menus**: `/menu` offers hierarchical point-and-click navigation (workdir / chats / settings / plugins / compact, …) — the same card updates in place, supports back/exit, and stays usable across consecutive actions.
- **Smart image handling**: images sent to the bot are downloaded automatically; if the main model supports vision it sees them directly, otherwise a vision-model sub-task describes them and the description is injected — so a text-only main model never stalls on images.
- **Local commands** (no model tokens): `/status` `/task` `/chat` `/dir` `/workspace` `/workspaces` `/plugins` `/compact` `/history` `/goals` `/schedule` `/model` `/new` `/clear` `/stop` `/settings` `/help`.
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
| `/settings` (`/set`) | Settings: switch model / reasoning effort / notification toggles / config overview |
| `/model` | Show the current model, tap to switch |
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
| `/new` (`/reset`) | Start a new conversation |
| `/clear` | Clear the current conversation |
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
| `allowUsers` | `[]` | Sender allowlist (empty = allow all) |
| `allowChats` | `[]` | Chat allowlist (empty = allow all) |
| `stateDir` | `./.dsh-connect` | Directory for the binding route `bindings.json` |
| `notifyStream` / `notifySummary` | runtime-adjustable | Streaming / summary notification toggles switchable from `/settings` |

### dsh-connect-feishu (Feishu)

| Key | Default | Description |
|---|---|---|
| `appId` / `appSecret` | env `FEISHU_APP_ID` / `FEISHU_APP_SECRET`, or **one-click onboarding** | App credentials (when unset, onboarding mode starts and creates the app via QR scan) |
| `transport` | `websocket` | Long connection (recommended); `webhook` needs a public HTTPS URL |
| `verificationToken` / `encryptKey` | empty | Only needed for webhook mode |
| `requireMention` | `true` | Groups only respond when the bot is @mentioned |
| `dmMode` | `open` | DM policy: `open` receive / `closed` ignore |

> **One-click onboarding**: start the plugin without `appId`/`appSecret` and it prints an onboarding link (valid ~10 minutes). Scan it with Feishu (or click and confirm) and the bot app is created automatically with permissions and event subscriptions preset; credentials are saved to `$DSH_HOME/.dsh-connect/feishu-credentials.json`.

## How it works

- **Agent create/resume**: reuses the standard DSH driving pattern (see `dsh-headless`) — `ctx.agents.create({ meta:{cwd, agentPreset}, agentOptions:{provider,model}, setup })`; resume goes through `ctx.agents.resume`.
- **Preset mounting**: `setup` runs `installModelSelection` + `ctx.agentPresets.mount(agentCtx, presetId)`, giving bound sessions the standard toolset (bash/fs/…).
- **Streaming**: `assistant/chunk` (text-delta) events on `session/event` are bridged via `createAsyncQueue` into the Feishu `channel.stream()` typewriter card; `turn/end` decides the turn outcome.
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
