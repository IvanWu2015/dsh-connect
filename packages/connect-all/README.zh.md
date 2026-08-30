# dsh-connect-all

**dsh-connect** 的多合一单插件安装包。不再需要分别安装
`dsh-connect-feishu`、`dsh-connect-telegram`、`dsh-connect-dingtalk`、
`dsh-connect-web`，而是只装这一个插件，并按需启用你用的渠道。

## 安装

```sh
dsh plugin add dsh-connect dsh-connect-all
```

## 配置

只写一个块：`channels` 选渠道，其余用 `channelDefaults` 放公共项，渠道私有项放在各渠道名下。

```json
{
  "dsh-connect-all": {
    "channels": ["feishu", "telegram"],
    "channelDefaults": { "language": "zh" },
    "feishu":   { "appId": "cli_xxxx", "appSecret": "REPLACE_ME" },
    "telegram": { "botToken": "123456:REPLACE_ME" }
  }
}
```

- `channels` — 启用哪些渠道（`feishu`/`telegram`/`dingtalk`/`web`）；不填=全部。
- `feishu`/`telegram`/`dingtalk`/`web` — 各渠道配置，键与独立渠道插件一致。
- `channelDefaults` — 公共项，每个渠道继承，渠道自身覆盖。

某个渠道启动失败会被记录并跳过，不影响其他渠道。最小的可运行示例见
[`examples/minimal.config.json`](./examples/minimal.config.json)。

## 构建 / 测试

```sh
pnpm --filter dsh-connect-all build
pnpm --filter dsh-connect-all test   # 或 node packages/connect-all/test/run-all.mjs
```

## Web 设置

宿主侧已具备 /dsh-connect RPC 通道（settings.get/save/status）+ JSON 持久化 +
凭据库存在性；前端设置页插件见 `client/settings-client.mjs`，需在 `dsh web`
里构建/联调。详见 `docs/all-in-one-and-web-settings.md` 与 `docs/config-reference.md`。
