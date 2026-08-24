# dsh-connect-web

English | [中文](README.zh.md)

Web channel adapter for [dsh-connect](https://www.npmjs.com/package/dsh-connect): tracks which conversations are **mirrored** into the DSH Web GUI. It monitors the binding route store for chats whose session has been mirrored (`webMirrorSessionId` set — auto-created by `dsh-connect` for every new chat) so the GUI can open the shared session.

## What it does

- **Mirror tracking** — watches the `BindingStore` (via `onChange` events plus a fallback poll) and records each mirrored session: `isSessionMirrored(sessionId)` and `getMirrorSource(sessionId)` (`"channel:chatKey"`).
- **No synthetic inbound messages** — mirror detection is pure bookkeeping. The adapter deliberately does **not** emit an inbound "mirror created" message, because that would spin up a spurious `web` runner and burn a real agent turn for nothing.
- **Outbound methods are contract no-ops** — `sendText` / `sendCard` / `streamText` / `promptChoice` / `closeMenu` exist only to satisfy the `ChannelAdapter` interface. The Web GUI renders the agent's session events directly from DSH's shared session store, not from adapter calls.
- **One-sided locking** — the mirror "lock" (`lockOwner` in the binding) is enforced **only on the Feishu side** by `dsh-connect`. The Web GUI reads mirrored sessions directly and is write-always from this repository's perspective; that asymmetry cannot be fixed from this package.

## Install

```sh
dsh plugin --profile web add dsh-connect dsh-connect-web
```

Requires the `dsh-connect` service to be loaded first (it is declared via `inject: ["connect"]`), and reads the binding store through `dsh-connect`'s public `bindingStore` getter (typed via the `dsh-connect/binding` export subpath).

## Configure

The plugins register themselves via their bundle manifests, so only override their config — do **not** `insert` them again (duplicate ids crash dsh at boot):

```yaml
- id: connect
  name: dsh-connect
- id: connect-web
  name: dsh-connect-web
  config:
    # pollIntervalMs: 1000   # fallback mirror scan interval (default 1000)
```

| Key | Default | Description |
|---|---|---|
| `pollIntervalMs` | `1000` | Fallback polling interval (ms) for detecting new mirror sessions when change events are missed |

## API

```ts
class WebAdapter implements ChannelAdapter {
  readonly id = "web";
  isSessionMirrored(sessionId: string): boolean;                    // is this DSH session mirrored from a chat?
  getMirrorSource(sessionId: string): string | undefined;           // "channel:chatKey" of the source chat
  // sendText / sendCard / streamText / promptChoice / closeMenu — contract no-ops
}
```

## Limitations

- **No inbound path**: messages typed in the Web GUI are not routed through this adapter; the GUI talks to the shared DSH session directly.
- **No locking guarantee for Web writers**: the mutual-exclusion lock is one-sided (enforced by the Feishu adapter's runner only).
- **Mirror visibility depends on `dsh-connect`**: if the `connect` service or its `bindingStore` is unavailable, mirror detection is disabled (a warning is logged).

## License

MIT
