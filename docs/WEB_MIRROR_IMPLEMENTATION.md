# Web Mirror Implementation

English | [中文](WEB_MIRROR_IMPLEMENTATION.zh.md)

## Overview

The **`web` channel** of `dsh-connect` is the Web mirror adapter: it makes Feishu's mirrored sessions visible to the DSH Web GUI. It monitors the shared `BindingStore` for chats that have a `webMirrorSessionId` set (via `/mirror`, or automatically through `autoMirror`) and records them as known mirrors.

The mirrored conversation itself needs no adapter plumbing: the DSH Web GUI reads sessions directly from DSH's session store, so a mirrored session simply appears in the GUI under the shared workspace. See [Web Mirror Session](./MIRROR_SESSION.md) for the user-facing behavior.

## What the Adapter Does

- **Tracks mirrors, nothing more.** `WebAdapter` subscribes to `BindingStore` changes (`onChange`) plus a fallback 1-second polling scan, and records each chat whose binding has `webMirrorSessionId` set:
  - `isSessionMirrored(sessionId)` — is this session known as a mirror?
  - `getMirrorSource(sessionId)` — the originating `channel:chatKey`.
- **Outbound methods are no-ops by design.** `sendText` / `sendCard` / `streamText` / `promptChoice` / `closeMenu` exist only to satisfy the `ChannelAdapter` contract: the agent writes events into the shared session store and the GUI renders them.

## No Synthetic Inbound Messages

Earlier versions of the adapter synthesized an inbound "mirror created" message and dispatched it to the connect handler. **That is gone.** Synthesizing inbound messages would:

1. create a **spurious `web` runner** for the chat, and
2. **consume a real agent (LLM) turn** on a message the user never sent.

The adapter now only records `knownMirrors`; nothing is routed through `onInbound`. This is covered by a regression test (`does NOT synthesize inbound messages for new mirrors`).

## The Lock Is One-Sided (Honest Limitation)

`lockOwner` (`"feishu" | "web"`) is enforced **only by the Feishu-side `AgentRunner`**. The DSH Web GUI never goes through this adapter and never queries the lock — it reads and writes DSH sessions directly (via DSH's own api-proxy). The Web side is therefore **always writable**, and the mutex cannot stop concurrent Web writes.

This is an architectural limitation of the DSH Web GUI and **cannot be fixed from this repository** — the docs must not claim the Web side obeys the lock.

## Getting the BindingStore

`WebAdapter` needs the `BindingStore` that owns the mirror metadata. It is obtained from the connect service's **public `bindingStore` getter** (`ctx.get("connect").bindingStore`) — not by reaching into private fields.

The core `dsh-connect` package exposes the store's types through a new **`"./binding"` export subpath** (`dsh-connect/binding`). Without it, `import type { BindingStore, ChatBinding } from "dsh-connect/binding"` failed with `TS2307` at compile time and `ERR_PACKAGE_PATH_NOT_EXPORTED` at runtime.

## Testing

The `web` channel uses **`node:test`** — the suite is `packages/connect/test/web.test.mjs`, imported by the consolidated runner `packages/connect/test/run-all.mjs` (or run alone with `node packages/connect/test/web.test.mjs`). The root `pnpm test` runs it along with the other suites. Remember to `pnpm build` first, since the tests import from `lib/` (gitignored).

Covered behaviors:
- clean `start` / `stop`
- recording newly detected mirror sessions
- `getMirrorSource` returning the source `channel:chatKey`
- **no** synthesized inbound messages for new mirrors (regression)
- outbound methods are contract-satisfying no-ops

---

## Related Documentation

- [Web Mirror Session](./MIRROR_SESSION.md) — user-facing mirror & lock behavior
- [Shared Workspace Setup](./SHARED_WORKSPACE_SETUP.md) — workspace/session visibility in the Web GUI
- [Enhancements Summary](./ENHANCEMENTS_SUMMARY.md) — round fixes for the former `dsh-connect-web` adapter (now the `web` channel)
- [Binding Store API](../packages/connect/src/binding.ts) — the store the adapter monitors

---

**Version**: v0.6.2  
**Updated**: 2026-08-20
