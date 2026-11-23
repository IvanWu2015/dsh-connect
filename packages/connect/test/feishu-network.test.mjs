/**
 * The DESKTOP CRASH of 2026-11-23 (and twice before, with `getaddrinfo
 * ENOTFOUND` instead of `ECONNRESET`):
 *
 *   dsh: fatal load failure: AxiosError: read ECONNRESET
 *     url: 'https://open.feishu.cn/open-apis/cardkit/v1/cards'
 *
 * Every session in the host died with one dropped HTTP request.
 *
 * The thrower is outside this package: the official Lark SDK's streaming-card
 * controller fires `void this.doFire()` from a `setTimeout`, so a failed cardkit
 * rewrite is an UNHANDLED rejection, and Node >= 15 terminates the process on
 * those. The SDK also builds its `cardkit` client internally — an `httpInstance`
 * injected into `createLarkChannel` never sees the request (measured) — so no
 * wrapper inside this plugin can close the hole. The only lever is the process's
 * `unhandledRejection` handling, and it must stay narrow: absorb our transport
 * failures, and keep every other rejection fatal.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  FeishuAdapter,
  installProcessRejectionGuard,
  isFeishuTransportRejection,
  larkHttpInstance,
} from "../lib/channels/feishu/index.js";

const tick = (ms = 0) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** An axios-shaped transport failure, the same shape the crash log carries. */
function larkDropped() {
  const error = new Error("read ECONNRESET");
  error.code = "ECONNRESET";
  error.isAxiosError = true;
  error.config = { url: "https://open.feishu.cn/open-apis/cardkit/v1/cards", method: "post" };
  return error;
}

/**
 * Child-process modes, used by the two tests that measure the real outcome.
 *
 * Node calls every `unhandledRejection` listener, so an in-process recorder
 * cannot tell "absorbed" from "still fatal" — only the process's exit status can.
 */
const childMode = process.argv[2];
if (childMode === "--crash-child" || childMode === "--guarded-child" || childMode === "--bug-child") {
  const install = childMode === "--guarded-child"
    ? installProcessRejectionGuard({ owner: "child", logger: { warn: () => undefined } })
    : undefined;
  // The same rejection the desktop host died on, plus a control that is NOT ours.
  void Promise.reject(childMode === "--bug-child"
    ? new TypeError("undefined is not a function")
    : larkDropped());
  // Long enough for Node to report the rejection (or for the guard to absorb it).
  setTimeout(() => {
    install?.();
    process.stdout.write("SURVIVED\n");
    // This is a child, not a test runner: end here instead of importing the
    // declarations below as tests.
    process.exit(0);
  }, 150);
} else {

test("a Feishu transport rejection is recognised, and nothing else is", () => {
  assert.equal(isFeishuTransportRejection(larkDropped()), true);

  // The two shapes the earlier crashes carried.
  const dns = new Error("getaddrinfo ENOTFOUND open.feishu.cn");
  dns.code = "ENOTFOUND";
  assert.equal(isFeishuTransportRejection(dns), true);

  // A dropped connection to ANOTHER host is not ours to absorb.
  const elsewhere = new Error("read ECONNRESET");
  elsewhere.code = "ECONNRESET";
  elsewhere.config = { url: "https://api.deepseek.com/models" };
  assert.equal(isFeishuTransportRejection(elsewhere), false);

  // A bug in Feishu's response handling is not a transport failure: it must stay fatal.
  const schema = new Error("Cannot read properties of undefined (reading 'card_id')");
  schema.stack = "Error: Cannot read properties of undefined\n    at updateCard (https://open.feishu.cn/x)";
  assert.equal(isFeishuTransportRejection(schema), false);

  // Non-objects and bare strings
  assert.equal(isFeishuTransportRejection(undefined), false);
  assert.equal(isFeishuTransportRejection("open.feishu.cn ECONNRESET"), false);
});

test("the guard absorbs a genuine SDK-style unhandled rejection and keeps running", () => {
  // This is the crash: a rejection nobody awaits. Measured where it can be
  // measured — in a child process, because `node:test` attributes a rejection
  // raised inside a test body to that test and fails it before any listener
  // runs. The child exits 1 without the guard (previous test) and survives with
  // it, which is the whole claim.
  const modulePath = fileURLToPath(import.meta.url);
  const guarded = spawnSync(process.execPath, [modulePath, "--guarded-child"], { encoding: "utf8" });
  const unguarded = spawnSync(process.execPath, [modulePath, "--crash-child"], { encoding: "utf8" });
  assert.equal(guarded.status, 0, `guarded child must survive; stderr=${String(guarded.stderr).slice(0, 300)}`);
  assert.equal(String(guarded.stdout).includes("SURVIVED"), true);
  assert.equal(unguarded.status, 1, "the control child must die, or this test proves nothing");
});

test("an unhandled rejection terminates the process without the guard", () => {
  // The claim the whole module rests on, measured rather than assumed: a child
  // process that rejects exactly like the SDK does exits non-zero.
  const modulePath = fileURLToPath(import.meta.url);
  const result = spawnSync(process.execPath, [modulePath, "--crash-child"], { encoding: "utf8" });
  assert.equal(result.status, 1, "an unhandled rejection must exit with status 1");
  assert.equal(String(result.stdout).includes("SURVIVED"), false);
});

test("with the guard installed, the same child survives", () => {
  const modulePath = fileURLToPath(import.meta.url);
  const result = spawnSync(process.execPath, [modulePath, "--guarded-child"], { encoding: "utf8" });
  assert.equal(result.status, 0, `guarded child must exit cleanly; stderr=${String(result.stderr).slice(0, 300)}`);
  assert.equal(String(result.stdout).includes("SURVIVED"), true);
});

test("a rejection that is NOT ours is not absorbed", () => {
  // A guard that swallowed everything would hide real defects and change the
  // host's crash behaviour — the opposite of a fix. The control child rejects a
  // plain TypeError and must still die, with no guard involved.
  const modulePath = fileURLToPath(import.meta.url);
  const result = spawnSync(process.execPath, [modulePath, "--bug-child"], { encoding: "utf8" });
  assert.equal(result.status, 1, "an unrelated unhandled rejection must still terminate the process");
});

test("installing and removing is symmetric, even when installed twice", async () => {
  const before = process.listenerCount("unhandledRejection");
  const a = installProcessRejectionGuard({ owner: "a" });
  const b = installProcessRejectionGuard({ owner: "b" });
  assert.equal(process.listenerCount("unhandledRejection"), before + 2);
  a();
  b();
  assert.equal(process.listenerCount("unhandledRejection"), before);
});

test("the guard is a no-op with no logger", () => {
  // The logger is optional on a bare host; losing it must not turn the guard
  // into a thrower inside the process's rejection handler.
  const install = installProcessRejectionGuard({ owner: "silent" });
  install();
  assert.equal(process.listenerCount("unhandledRejection") >= 0, true);
});

test("a request that never answers is cut off at the configured timeout", async () => {
  // Same defect class as the desktop host hitting `api.deepseek.com` requests
  // that never answered: a hung socket must not pin a card rewrite forever.
  const calls = [];
  const hanging = {
    request: () => { calls.push("request"); return new Promise(() => undefined); },
    post: () => { calls.push("post"); return new Promise(() => undefined); },
    get: () => new Promise(() => undefined),
    put: () => new Promise(() => undefined),
    patch: () => new Promise(() => undefined),
    delete: () => new Promise(() => undefined),
    head: () => new Promise(() => undefined),
    options: () => new Promise(() => undefined),
  };
  const http = larkHttpInstance(hanging, { timeoutMs: 20 });
  await assert.rejects(
    () => http.post("https://open.feishu.cn/open-apis/cardkit/v1/cards", {}),
    (error) => {
      assert.equal(error.code, "ETIMEDOUT");
      assert.match(String(error.message), /timed out/i);
      return true;
    },
  );
  assert.deepEqual(calls, ["post"]);
});

test("a wrapped request passes the result through, and a failure through unchanged", async () => {
  const ok = larkHttpInstance({ request: async () => ({ code: 0 }) }, { timeoutMs: 1000 });
  assert.deepEqual(await ok.request({ url: "x" }), { code: 0 });

  const dropping = larkHttpInstance({
    request: async () => { throw larkDropped(); },
  }, { timeoutMs: 1000 });
  await assert.rejects(() => dropping.request({ url: "x" }), (error) => {
    assert.equal(error.code, "ECONNRESET");
    return true;
  });
});

test("starting the Feishu channel installs the net, and stopping it removes the net", async () => {
  // The guard is only worth anything if the CHANNEL ENTRY installs it — that is
  // the code path that runs on real load. A regression here is invisible: the
  // plugin looks fine and only the host dies, which is the failure reported
  // three times. The first version of this test only checked that the adapter
  // runs a disposer it was handed, and passed with the wiring removed.
  const before = process.listenerCount("unhandledRejection");
  const registered = [];
  const warnings = [];
  const connect = {
    registerAdapter(adapter) { registered.push(adapter); },
  };
  // `register` starts the real adapter against a stubbed SDK channel so no
  // network is touched; credentials are supplied so onboarding is skipped.
  const { register } = await import("../lib/channels/feishu/index.js");
  const ctx = { logger: { info: () => undefined, warn: (m) => warnings.push(String(m)), error: () => undefined }, get: () => undefined };
  register(connect, { appId: "cli_x", appSecret: "sec_x", transport: "websocket" }, ctx);

  assert.equal(registered.length, 1, "the channel must register one adapter");
  assert.equal(
    process.listenerCount("unhandledRejection"),
    before + 1,
    "starting the channel must install exactly one process-level net",
  );

  // Stop the adapter: the net must come off with it.
  const adapter = registered[0];
  adapter["channel"] = {
    on() {},
    async connect() {},
    async disconnect() {},
    async send() { return { messageId: "m" }; },
  };
  await adapter.stop();
  assert.equal(
    process.listenerCount("unhandledRejection"),
    before,
    "stopping the channel must remove the net it installed",
  );
});

}
