import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fsN from "node:fs";

import { createSettingsService } from "../lib/settings/settings-service.js";
import { createCredentialStore } from "../lib/settings/credential-store.js";

function tmpFile() {
  const dir = fsN.mkdtempSync(path.join(os.tmpdir(), "dsh-connect-settings-"));
  return path.join(dir, "settings.json");
}

test("missing state file -> empty config, credentials all false", async () => {
  const svc = createSettingsService({ statePath: tmpFile() });
  const snap = await svc.get();
  assert.deepEqual(snap.config, {});
  // with no channels configured, the plugin defaults to activating all built-ins
  assert.deepEqual(snap.enabled, ["feishu", "telegram", "dingtalk", "web"]);
  assert.equal(Object.keys(snap.credentials).length, 4);
  assert.ok(Object.values(snap.credentials).every((v) => v === false));
});

test("save merges and persists; get reads it back", async () => {
  const file = tmpFile();
  const svc = createSettingsService({ statePath: file });
  await svc.save({ channels: ["feishu"], channelDefaults: { language: "zh" } });
  const snap = await svc.get();
  assert.deepEqual(snap.enabled, ["feishu"]);
  assert.deepEqual(snap.config.channelDefaults, { language: "zh" });
  // persisted on disk as JSON
  const raw = JSON.parse(fsN.readFileSync(file, "utf8"));
  assert.deepEqual(raw.channels, ["feishu"]);
});

test("save preserves previously-set keys (merge, not replace)", async () => {
  const svc = createSettingsService({ statePath: tmpFile() });
  await svc.save({ language: "en" });
  const snap = await svc.save({ channels: ["telegram"] });
  assert.deepEqual(snap.config.language, "en");
  assert.deepEqual(snap.config.channels, ["telegram"]);
});

test("corrupt state file -> empty config, no throw", async () => {
  const file = tmpFile();
  fsN.writeFileSync(file, "{ this is not json }");
  const svc = createSettingsService({ statePath: file });
  const snap = await svc.get();
  assert.deepEqual(snap.config, {});
});

test("save creates the parent directory", async () => {
  const dir = fsN.mkdtempSync(path.join(os.tmpdir(), "dsh-connect-settings-"));
  const file = path.join(dir, "nested", "deep", "settings.json");
  const svc = createSettingsService({ statePath: file });
  await svc.save({ channels: ["web"] });
  assert.ok(fsN.existsSync(file));
  assert.deepEqual(JSON.parse(fsN.readFileSync(file, "utf8")).channels, ["web"]);
});

test("credentialStore presence is surfaced in the snapshot", async () => {
  const credentialStore = { configured: async (n) => n === "feishu", save: async () => {}, clear: async () => {} };
  const svc = createSettingsService({ statePath: tmpFile(), credentialStore });
  const snap = await svc.get();
  assert.equal(snap.credentials.feishu, true);
  assert.equal(snap.credentials.telegram, false);
  assert.equal(snap.credentials.web, false);
});

test("without a credentialStore every channel reports false", async () => {
  const svc = createSettingsService({ statePath: tmpFile() });
  const snap = await svc.get();
  assert.ok(Object.values(snap.credentials).every((v) => v === false));
});
function mapProvider() {
  const store = new Map();
  return {
    store,
    async resolve(ref) { return store.get(ref) ?? null; },
    async describe(ref) { return { configured: store.has(ref) }; },
    async set(ref, value) { store.set(ref, value); },
    async unset(ref) { store.delete(ref); },
  };
}

test("saveCredentials maps config keys to refs and writes the store", async () => {
  const provider = mapProvider();
  const store = createCredentialStore(provider);
  const svc = createSettingsService({ statePath: tmpFile(), credentialStore: store });
  const snap = await svc.saveCredentials("feishu", { appId: "cli_9", appSecret: "sec_9" });
  assert.equal(snap.credentials.feishu, true);
  assert.equal(provider.store.get("DSH_CONNECT_FEISHU_APP_ID"), "cli_9");
  assert.equal(provider.store.get("DSH_CONNECT_FEISHU_APP_SECRET"), "sec_9");
});

test("saveCredentials without a store throws not-configured", async () => {
  const svc = createSettingsService({ statePath: tmpFile() });
  await assert.rejects(svc.saveCredentials("feishu", { appId: "x" }), (e) => e.code === "not-configured");
});