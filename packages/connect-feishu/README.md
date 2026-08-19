# dsh-connect-feishu

English | [中文](README.zh.md)

The **Feishu / Lark channel adapter** for [dsh-connect](https://www.npmjs.com/package/dsh-connect): receives messages over the Feishu Open Platform **long connection (WebSocket)**, forwards them to the DSH agent, and **streams** replies back to Feishu, with interactive menu cards.

## Install

```sh
dsh plugin --profile web add dsh-connect dsh-connect-feishu
```

## Configuration

In the DSH profile's `cordis.patch.yml`:

```yaml
- insert:
    - id: connect
      name: dsh-connect
    - id: connect-feishu
      name: dsh-connect-feishu
      config:
        appId: cli_xxx
        appSecret: cli_secret_xxx
        transport: websocket
        requireMention: true
        dmMode: open
```

| Key | Default | Description |
|---|---|---|
| `appId` / `appSecret` | env `FEISHU_APP_ID` / `FEISHU_APP_SECRET` | Feishu custom app credentials |
| `transport` | `websocket` | Long connection (no public network needed); `webhook` needs public HTTPS |
| `requireMention` | `true` | Groups only respond when the bot is @mentioned |
| `dmMode` | `open` | DM policy: open / allowlist / pair / disabled |
| `language` | `zh` | User-facing message language: `zh` / `en` |

On the Feishu side you also need: bot capability enabled, `im.message.receive_v1` and `card.action.trigger` events subscribed, and an app version published. See `docs/feishu-setup.md` in the repository.

## Documentation

https://github.com/IvanWu2015/dsh-connect

## License

MIT
