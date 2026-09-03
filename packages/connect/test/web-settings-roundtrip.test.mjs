import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fsN from "node:fs";

import { loadSettings, saveSettings, saveCredentials } from "../lib/settings/rpc-client.js";
import { createSettingsRpcHandler } from "../lib/settings/settings-rpc.js";
import { createSettingsService } from "../lib/settings/settings-service.js";
import { createCredentialStore } from "../lib/settings/credential-store.js";
import { injectSecrets, CHANNELS } from "../lib/settings/channels.js";

function tmpFile() {
  const dir = fsN.mkdtempSync(path.join(os.tmpdir(), "dsh-connect-rt-"));
  return path.join(dir, "settings.json");
}
function fakeProvider() {
  const store = new Map();
  return {
    store,
    async resolve(ref) { return store.get(ref) ?? null; },
    async describe(ref) { return { configured: store.has(ref) }; },
    async set(ref, value) { store.set(ref, value); },
    async unset(ref) { store.delete(ref); },
  };
}
// A host backend wired exactly like the dsh-connect apply(): handler -> service -> store.
function makeHostBackend() {
  const provider = fakeProvider();
  const store = createCredentialStore(provider);
  const service = createSettingsService({ statePath: tmpFile(), credentialStore: store });
  const handler = createSettingsRpcHandler(service);
  const rpcCall = (endpoint, payload, signal) => handler(endpoint, payload, signal);
  return { provider, store, rpcCall };
}

test("full Web-settings round-trip: save config + creds, read back, inject", async () => {
  const { rpcCall, provider } = makeHostBackend();
  await saveSettings(rpcCall, { channels: ["feishu"], channelDefaults: { language: "zh" } });
  await saveCredentials(rpcCall, "feishu", { appId: "cli_1", appSecret: "sec_1" });
  const snap = await loadSettings(rpcCall);
  assert.deepEqual(snap.enabled, ["feishu"]);
  assert.equal(snap.credentials.feishu, true);
  assert.equal(snap.credentials.telegram, false);
  const store = createCredentialStore(provider);
  const enriched = await injectSecrets({ channels: ["feishu"] }, CHANNELS, (n) => store.get(n));
  assert.deepEqual(enriched.feishu, { appId: "cli_1", appSecret: "sec_1" });
});

test("empty backend reports all-false credentials", async () => {
  const { rpcCall } = makeHostBackend();
  const snap = await loadSettings(rpcCall);
  assert.equal(snap.credentials.feishu, false);
  assert.equal(snap.credentials.telegram, false);
});
