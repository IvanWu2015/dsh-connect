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
- `settingsStatePath` —（可选）Web 设置页持久化非密钥设置的文件路径。

某个渠道启动失败会被记录并跳过，不影响其他渠道。最小的可运行示例见
[`examples/minimal.config.json`](./examples/minimal.config.json)。

> **密钥走 DSH 凭据库**：不必把 `appSecret`/`botToken`/`clientSecret` 写进配置文件——从 Web 设置面板保存即可；`injectSecrets` 会在激活时把它们注入各渠道配置，让配置文件免于出现密钥。钉钉的 stream 凭据（`clientId`/`clientSecret`）会自动嵌套进 `stream`。

## Web 设置

本包注册了 `/dsh-connect` RPC 通道（`settings.get`/`settings.save`/`settings.status` + `credentials.save`）支撑设置面板：非密钥配置持久化到 JSON 状态文件，密钥写入 DSH 凭据库，下次加载由 `injectSecrets` 回填给各适配器（round-trip 已测）。前端插件 `client/settings-client.mjs` 仍需在 `dsh web`（Vite）里构建/渲染。详见
[`docs/all-in-one-and-web-settings.md`](../../docs/all-in-one-and-web-settings.md) 与 [`docs/config-reference.md`](../../docs/config-reference.md)。

## 构建 / 测试

```sh
pnpm --filter dsh-connect-all build
pnpm --filter dsh-connect-all test   # 或 node packages/connect-all/test/run-all.mjs
```

## Web 设置

宿主侧已具备 /dsh-connect RPC 通道（settings.get/save/status）+ JSON 持久化 +
凭据库存在性；前端设置页插件见 `client/settings-client.mjs`，需在 `dsh web`
里构建/联调。详见 `docs/all-in-one-and-web-settings.md` 与 `docs/config-reference.md`。
