import { test } from "node:test";
import assert from "node:assert/strict";

import { apply, name, inject } from "../lib/index.js";
import { SETTINGS_RPC_CHANNEL } from "../lib/settings-rpc.js";

// A fake cordis context with just enough surface for apply().
function fakeCtx({ withRpc = true } = {}) {
  const calls = [];
  const ctx = {
    logger: { warn: () => {} },
    get: () => undefined, // no "credentials" provider
  };
  if (withRpc) {
    ctx.connection = { rpc: { handle: (channel, handler, opts) => { calls.push({ channel, opts }); return () => {}; } } };
  }
  return { ctx, calls };
}

test("plugin metadata: name and required+optional injects", () => {
  assert.equal(name, "dsh-connect-all");
  assert.deepEqual(inject, ["connect", "credentials?"]);
});

test("apply with no channels activates none and does not throw", async () => {
  const { ctx, calls } = fakeCtx();
  await apply(ctx, { channels: [] });
  // No adapters started (channels: []), but the settings RPC channel was registered.
  assert.ok(calls.some((c) => c.channel === SETTINGS_RPC_CHANNEL));
});

test("apply without a host rpc handle still succeeds (safe no-op)", async () => {
  const { ctx } = fakeCtx({ withRpc: false });
  await apply(ctx, { channels: ["feishu"] });
});

test("apply with a settingsStatePath wires the settings service (no throw)", async () => {
  const { ctx } = fakeCtx({ withRpc: false });
  await apply(ctx, { channels: [], settingsStatePath: "settings.json" });
});
