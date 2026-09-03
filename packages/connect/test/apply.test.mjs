import { test } from "node:test";
import assert from "node:assert/strict";
import { Context } from "@deepseek-ai/cordis";

import { apply, name, inject } from "../lib/index.js";
import { SETTINGS_RPC_CHANNEL } from "../lib/settings/settings-rpc.js";

// Build a real root context with the host services ConnectService expects. We
// call `apply` directly (not through the cordis loader), so we also pin a fake
// `ctx.connection.rpc.handle` to capture the settings-channel registration.
function makeCtx({ withRpc = true } = {}) {
  const ctx = new Context();
  ctx.provide("agents", {});
  ctx.provide("sessions", {});
  ctx.provide("agentDefaultModel", { currentSelection: () => ({ provider: "p", model: "m" }) });
  const calls = [];
  if (withRpc) {
    // Provide `connection` as a real cordis service (not a bare property) so the
    // plugin's deferred `ctx.inject(["connection"], ...)` scope can resolve it and
    // register the settings RPC channel.
    ctx.provide("connection", {
      rpc: { handle: (channel, handler, opts) => { calls.push({ channel, opts }); return () => {}; } },
    });
  }
  return { ctx, calls };
}

test("plugin metadata: name and required+optional injects", () => {
  assert.equal(name, "connect");
  assert.deepEqual(inject, ["agents", "sessions", "agentDefaultModel"]);
});

test("apply with no channels activates none and does not throw", async () => {
  const { ctx, calls } = makeCtx();
  await apply(ctx, { channels: [] });
  // Let the deferred `inject(["connection"], ...)` scope settle before asserting.
  await new Promise((r) => setImmediate(r));
  // No adapters started (channels: []), but the settings RPC channel was registered.
  assert.ok(calls.some((c) => c.channel === SETTINGS_RPC_CHANNEL));
});

test("apply without a host rpc handle still succeeds (safe no-op)", async () => {
  const { ctx } = makeCtx({ withRpc: false });
  await apply(ctx, { channels: ["feishu"] });
});

test("apply with a settingsStatePath wires the settings service (no throw)", async () => {
  const { ctx } = makeCtx({ withRpc: false });
  await apply(ctx, { channels: [], settingsStatePath: "settings.json" });
});
