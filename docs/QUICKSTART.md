# Quickstart

English | [中文](QUICKSTART.zh.md)

Hook `dsh-connect` up to an existing DSH installation and start chatting with the agent in Feishu. It has two halves — the **DSH side** and the **Feishu side** — do them in order.

## 0. Prerequisites

- DSH installed and running (`dsh` command available, `dsh web` starts).
- A Feishu custom app created, with its **App ID** (`cli_xxx`) and **App Secret** at hand.

## 1. Build the plugin packages

```powershell
cd D:\ACOINFO\code\dsh_feishu
pnpm install
pnpm build
```

Build output goes to the package's `lib/` (`packages/connect/lib`).

## 2. Install a plugin into a DSH profile

`dsh plugin` forwards its arguments to the pnpm inside the profile directory, so **local paths must be absolute**. Install the **single all-in-one plugin** (one plugin, one config block, pulls in the core + every channel adapter + the web-settings stack):

```powershell
dsh plugin --profile web add D:\ACOINFO\code\dsh_feishu\packages\connect
```

> The npm package is published automatically by `.github/workflows/publish.yml` whenever a GitHub Release is created, so in a released setup you can install by package name instead: `dsh plugin --profile web add dsh-connect`. During local development the absolute-path install above is the way to go.

## 3. Configure the profile's cordis.patch.yml

Edit `%DSH_HOME%\profiles\web\cordis.patch.yml` (usually `C:\Users\you\.dsh\profiles\web\cordis.patch.yml`) and replace the empty array `[]` with:

> The plugin registers itself automatically via its bundle manifest, so
> this file only **overrides** its config. Do not `insert` it here again —
> a duplicate `id` makes dsh refuse to boot with `duplicate loader entry id`.

```yaml
- id: connect
  name: dsh-connect
  config:
    channels: [feishu]                       # which channels to enable (default: all built-in)
    channelDefaults:
      language: zh                           # common keys inherited by every channel
    feishu:
      appId: cli_yourAppId
      appSecret: yourAppSecret
      transport: websocket      # long connection, no public network needed
      requireMention: true      # groups need @mention
      dmMode: open              # DMs open
      # language: en            # user-facing message language: zh (default) / en
```

> Instead of putting credentials in the file you can use the environment variables `FEISHU_APP_ID` / `FEISHU_APP_SECRET` and omit `appId`/`appSecret` in the config — or save them to the DSH credential store from the Web settings pane (see [config-reference.md](config-reference.md)).

## 4. Restart dsh web

Host plugins only load after a process restart:

1. Stop the running `dsh web` (press `Ctrl+C` in its terminal).
2. Start `dsh web` again.
3. Check the startup log for `connect` output (or the absence of errors).

## 5. Feishu-side setup (if not done yet)

1. Feishu Open Platform → your app → **Add App Capabilities** → add **Bot**.
2. **Permissions** → enable: `im:message`, `im:message.p2p_msg`, `im:message.group_msg` (or `im:message.group_at_msg`), `im:message:send_as_bot`.
3. **Events & Callbacks → Subscription** → choose **"Use long connection to receive events"**, add event **`im.message.receive_v1`** (no callback URL needed in long-connection mode).
4. **Version Management & Release** → create a version (including bot + permissions + events) → submit for release.

## 6. Test

1. Add the bot to a group (or just DM it).
2. In a group, **@mention the bot** (because `requireMention: true`); in a DM, just send.
3. Send a task (e.g. "list the files in the current directory") — you should see the bot reply "Thinking…" first, then stream the result.

## 7. Troubleshooting

| Symptom | Fix |
|---|---|
| Feishu doesn't respond at all | Confirm the version is published; @mention the bot in groups; confirm `im.message.receive_v1` is subscribed |
| Startup error `connect-feishu: appId and appSecret are required` | Check the config or environment variables |
| "no adapter serves provider" | No usable model is configured in DSH — set up a DeepSeek model on the Web UI models page first |
| You want group replies without @mention | `requireMention: false` (note: the bot will then respond to every group message) |
