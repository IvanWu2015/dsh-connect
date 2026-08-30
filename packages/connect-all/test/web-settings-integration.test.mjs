import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fsN from "node:fs";

import { createSettingsService } from "../lib/settings-service.js";
import { createCredentialStore, CREDENTIAL_REFS } from "../lib/credential-store.js";
import { createSettingsRpcHandler } from "../lib/settings-rpc.js";

function tmpFile() {
  const dir = fsN.mkdtempSync(path.join(os.tmpdir(), "dsh-connect-integ-"));
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

test("settings.get through the RPC handler reports credential presence", async () => {
  const provider = fakeProvider();
  const store = createCredentialStore(provider);
  const [idRef, secretRef] = CREDENTIAL_REFS.feishu;
  await store.save("feishu", { [idRef]: "cli_1", [secretRef]: "sec_1" });

  const service = createSettingsService({ statePath: tmpFile(), credentialStore: store });
  const handler = createSettingsRpcHandler(service);
  const res = await handler("settings.get", {}, undefined);
  assert.equal(res.ok, true);
  assert.equal(res.value.credentials.feishu, true);
  assert.equal(res.value.credentials.telegram, false);
});

test("settings.save through the RPC handler persists and returns ok", async () => {
  const file = tmpFile();
  const provider = fakeProvider();
  const store = createCredentialStore(provider);
  const service = createSettingsService({ statePath: file, credentialStore: store });
  const handler = createSettingsRpcHandler(service);
  const res = await handler("settings.save", { channels: ["telegram"], channelDefaults: { language: "zh" } }, undefined);
  assert.equal(res.ok, true);
  assert.deepEqual(res.value.config.channels, ["telegram"]);
  // A fresh service reading the same file sees the persisted config.
  const service2 = createSettingsService({ statePath: file, credentialStore: store });
  const snap = await service2.get();
  assert.deepEqual(snap.config.channels, ["telegram"]);
  assert.deepEqual(snap.config.channelDefaults, { language: "zh" });
});

test("settings.save rejects a non-empty-empty payload (bad-request)", async () => {
  const service = createSettingsService({ statePath: tmpFile() });
  const handler = createSettingsRpcHandler(service);
  const res = await handler("settings.save", {}, undefined);
  assert.equal(res.ok, false);
  assert.equal(res.error.code, "bad-request");
});
