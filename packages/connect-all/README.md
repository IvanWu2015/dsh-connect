# dsh-connect-all

All-in-one single-install bundle for **dsh-connect**. Instead of installing one
plugin per IM channel (`dsh-connect-feishu`, `dsh-connect-telegram`,
`dsh-connect-dingtalk`, `dsh-connect-web`), install this one plugin and enable
exactly the channels you use.

## Install

```sh
dsh plugin add dsh-connect dsh-connect-all
```

## Configure

Pick the channels you want and pass each channel's own config under its name.

```json
// smallest working setup (see examples/minimal.config.json)
dsh-connect-all:
  channels: [feishu, telegram]
  feishu:
    appId: cli_xxxx
    appSecret: secret
  telegram:
    botToken: 123456:xxxx
```

- `channels` — which adapters to activate (default: all built-in channels).
- `feishu` / `telegram` / `dingtalk` / `web` — the per-channel config, same
  keys as the standalone channel plugin.
- `settingsStatePath` — optional path to persist Web-settings edits as JSON.

A single adapter that fails to start is logged and skipped, so the others keep
working.

> **Secrets via the DSH credential store**: instead of putting `appSecret` /
> `botToken` / `clientSecret` in the config file, save them from the Web settings
> pane — `injectSecrets` writes them into each channel config at activation,
> leaving the config file free of secrets. DingTalk's stream creds
> (`clientId`/`clientSecret`) are nested under `stream` automatically.

## Web settings

The bundle registers a `/dsh-connect` RPC channel (`settings.get` / `settings.save` /
`settings.status` + `credentials.save`) that powers a settings pane: non-secret
config is persisted to a JSON state file, secrets are written to the DSH
credential store, and `injectSecrets` feeds them back to the adapters on the next
load (round-trip tested). The client plugin (`client/settings-client.mjs`) still
needs a `dsh web` (Vite) build to render. See
[`docs/all-in-one-and-web-settings.md`](../../docs/all-in-one-and-web-settings.md)
and [`docs/config-reference.md`](../../docs/config-reference.md).

## Why

The split-package model means you install and configure each channel separately
and write N profile entries. This bundle keeps the same `dsh-connect` service and
channel adapters, but puts install + config behind one entry.

## Build / test

```sh
pnpm --filter dsh-connect-all build
node packages/connect-all/test/run-all.mjs
```
