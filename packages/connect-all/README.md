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

A single adapter that fails to start is logged and skipped, so the others keep
working.

## Why

The split-package model means you install and configure each channel separately
and write N profile entries. This bundle keeps the same `dsh-connect` service and
channel adapters, but puts install + config behind one entry.

## Build / test

```sh
pnpm --filter dsh-connect-all build
node packages/connect-all/test/run-all.mjs
```
