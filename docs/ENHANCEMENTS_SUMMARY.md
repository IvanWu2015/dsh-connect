# dsh-connect 0.6.2 Round Fixes - Implementation Summary

English | [中文](ENHANCEMENTS_SUMMARY.zh.md)

## 📋 Overview

This round of fixes brings the repository in line with the code's actual behavior: crash/hang fixes in the core, correctness and streaming fixes in the Telegram adapter, real webhook support and safe downloads in the Feishu adapter, retry/truncation behavior in the DingTalk adapter, a reworked connect-web adapter, a serial 5-package publish pipeline, and dead-config cleanup. Version **0.6.2**.

---

## ✅ What Changed

### Core (`dsh-connect`)

- **Command dispatch no longer crashes**: command handlers are now invoked with a catch — a transient channel error in `/…` dispatch can no longer become an unhandled Promise rejection (Node ≥ 15 crashes the process on those by default).
- **`streamText` error path terminates the chunk stream**: if `followup` / `whenIdle` / `flush` throws, the chunk queue is ended unconditionally and the adapter's `for await` is released (its rejection swallowed) — the streaming card can no longer hang in "streaming" forever and leak the queue/adapter promise.
- **`buildUserContent` includes attachments in more cases**: non-image attachments (files / audio / video) are now staged and appended for pure-file messages and for vision-capable main models too — they were previously dropped when a message had no images.
- **Mirror reset on session changes**: `/new`, `/clear` and switching sessions (`/chat`) clear `webMirrorSessionId` / `lockOwner` so a stale mirror can never point at an abandoned session; `autoMirror` re-creates the mirror for the new session.
- **Lock scope narrowed**: the mutual-exclusion lock is only consulted for the `feishu` / `web` channels of a mirrored session; telegram / dingtalk never participate.
- **`/settings` cleaned**: the invalid "streaming" / "summary" toggles were removed from the settings menu.
- **i18n dead keys removed**; the `Config` schema now declares `autoMirror`.

### Telegram (`dsh-connect-telegram`)

- Fixed a missing brace that broke compilation.
- **Echo-loop prevention**: messages from the bot itself (`is_bot`) are ignored, so acks/replies never re-trigger the agent.
- **Streaming rewrite**: `streamText` accumulates the full text and refreshes the whole message via `editMessageText` (throttled to ~700 ms), truncating past 4096 characters with a marker — the previous delta-based approach wiped earlier content.
- **Long polling no longer throttled**: `getUpdates` gets a client-side timeout comfortably above the 50 s server-side window, so the idle poll is no longer cut at the generic 15 s HTTP timeout.
- **Offset confirmed per update**: the polling offset only advances after each update is fully handled, so a failure mid-batch never drops the remaining updates.
- **Full HTML escaping**: plain-text `& < >` are escaped everywhere (including inside converted markdown spans), so LLM output like `R&D` or `x < y` never breaks parse mode.
- **Precise @-mention detection**: the bot's id/username are cached from `getMe` and used for exact @-mention / reply-to checks.
- **Choice keys by (chat, option)**: pending inline-keyboard entries are keyed by chat + option so concurrent menus in different chats never collide; a timed-out keyboard is replaced by an expired notice.
- **More media types**: voice / video / audio downloads (on top of image / file); `edited_message` is ignored.

### Feishu (`dsh-connect-feishu`)

- **Allowlist pre-filter**: `allowUsers` / `allowChats` are checked before any message resource is downloaded — a rejected sender's images/files never touch disk.
- **Safe downloads**: per-file 20 MB cap, 60 s timeout, asynchronous writes into temp dirs (`dsh-connect-images` / `dsh-connect-files`) with automatic 24 h cleanup.
- **Webhook transport actually implemented**: the adapter hosts its own `node:http` server (`webhookPort` default 9000, `webhookPath` default "/") and answers the `url_verification` challenge via the SDK's `adaptDefault` + `autoChallenge` — no external express host needed anymore.
- **PII-free reject logs**: the inbound `reject` handler logs only a compact reason, never the full event JSON.
- **Credential file locked down**: onboarding saves `feishu-credentials.json` with mode `0600`.
- **`stop()` cleans up**: the webhook server, choice timers and stale-notice timers are all torn down.
- Pure functions (`padLabels`, `buildButtonGrid`, …) exported and covered by tests.

### DingTalk (`dsh-connect-dingtalk`)

- **Automatic retry with backoff** for transient network errors and `errcode 130101` (the 20/min frequency limit), up to 3 attempts.
- **Markdown truncated at 20000 characters** (the API limit) before sending.
- **Signature verification fixed**: URL-decodes both sides before comparing and enforces a timestamp freshness window.
- Removed dead exports and dead i18n keys.

### Web mirror (`dsh-connect-web`)

- **New `dsh-connect/binding` export subpath** in the core package — fixes `TS2307` (missing type) and the runtime `ERR_PACKAGE_PATH_NOT_EXPORTED` when importing `BindingStore` / `ChatBinding`.
- **BindingStore via the public getter**: the adapter obtains the store from the connect service's public `bindingStore` getter instead of reaching into internals.
- **No more synthetic `[Mirror]` inbound messages**: the adapter no longer dispatches a fake "mirror created" message to the handler — that used to spin up a spurious web runner and burn a real agent turn. It only records known mirrors (`isSessionMirrored` / `getMirrorSource`).
- **Tests moved to `node:test`** and wired into the root `pnpm test` (see below).

### CI / config

- **`publish.yml`**: `pnpm build` now runs before test and publish (lib/ is gitignored), `pnpm typecheck` added, and publishing is a **serial 5-package** flow (`dsh-connect` first, then connect-web → feishu → telegram → dingtalk) instead of a parallel matrix.
- **`dsh.shared.config.json`**: dead keys removed (`state.bindingsFile`, `state.sessionStorePath`, `mirror.defaultTimeoutMinutes`, `mirror.enableLocking`); only `workspace.defaultWorkDir`, `workspace.additionalWorkspaces`, `state.stateDir`, `mirror.autoCreate`, `language` are read.

---

## 🧪 Testing

Tests require a build first (`pnpm build` — `lib/` is gitignored). The root `pnpm test` now runs **6 suites**, all `node:test`:

1. `packages/connect/test/unit.test.mjs` — core unit tests (command parsing, binding persistence, async queue, turn outcomes, …)
2. `packages/connect/test/smoke.mjs` — Cordis runtime load contract (service registration, adapters, allowlist, notify)
3. `packages/connect-dingtalk/test/unit.test.mjs`
4. `packages/connect-telegram/test/unit.test.mjs`
5. `packages/connect-feishu/test/unit.test.mjs`
6. `packages/connect-web/test/unit.test.mjs`

---

## 📝 Notes

### Honest limitation: the mirror lock is one-sided

`lockOwner` is enforced only by the Feishu-side runner; the DSH Web GUI reads/writes DSH sessions directly and never consults the lock, so the Web side is effectively always writable. This is an architectural limitation of DSH Web and cannot be fixed from this repository. See [Web Mirror Session](./MIRROR_SESSION.md) for details.

### Mirror commands

`/mirror [--timeout N]`, `/unlock` (manual lock release), `/renew` (renew the lock timeout), `/export [markdown|pdf]`; `autoMirror` config (default `true`).

---

## 📚 Related Documentation

- [Web Mirror Session](./MIRROR_SESSION.md)
- [Shared Workspace Setup](./SHARED_WORKSPACE_SETUP.md)
- [Web Mirror Implementation](./WEB_MIRROR_IMPLEMENTATION.md)
- [Binding Store API](../packages/connect/src/binding.ts)
- [Runner Implementation](../packages/connect/src/runner.ts)

---

**Version**: v0.6.2  
**Updated**: 2026-08-20  
**Author**: DSH Connect Team
