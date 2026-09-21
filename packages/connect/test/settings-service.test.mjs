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
  // Must expose `get` as well as `configured`: the snapshot builder reads both
  // inside one `try`, so a store missing `get` throws there and every channel
  // silently reports "not configured".
  const credentialStore = { configured: async (n) => n === "feishu", get: async () => ({}), save: async () => {}, clear: async () => {} };
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

// Realistic lengths, on purpose: a 5-character secret falls into the
// all-bullets branch of the mask, which would let a "the value never appears"
// assertion pass without the head/tail logic ever running.
const APP_ID = "cli_a1b2c3d4e5f6g7h8";
const APP_SECRET = "a1b2c3d4e5f6g7h8i9j0k1l2m3n4z9y8"; // 32 chars
const WEBHOOK = "https://oapi.dingtalk.com/robot/send?access_token=0123456789abcdef0123456789abcdef";

test("snapshot reports secret presence and a host-masked preview, never a usable value", async () => {
  const provider = mapProvider();
  const store = createCredentialStore(provider);
  const file = tmpFile();
  const svc = createSettingsService({ statePath: file, credentialStore: store });
  await svc.save({ channels: ["feishu"] });
  await svc.saveCredentials("feishu", { appId: APP_ID, appSecret: APP_SECRET });
  const snap = await svc.get();
  assert.equal(snap.credentials.feishu, true);
  assert.deepEqual(snap.secrets.feishu, { appId: true, appSecret: true });
  assert.deepEqual(snap.secrets.telegram, { botToken: false });

  // The user asked to be able to *confirm* what they filled in, and an appId is
  // an identifier rather than an authenticator — so it comes through whole.
  assert.equal(snap.secretPreviews.feishu.appId, APP_ID);
  // An appSecret is not: head and tail survive, the middle does not, and the
  // full value appears nowhere in the snapshot the browser receives.
  assert.equal(snap.secretPreviews.feishu.appSecret, "a1b2…z9y8");
  const wire = JSON.stringify(snap);
  assert.ok(!wire.includes(APP_SECRET));
  assert.ok(!wire.includes(APP_SECRET.slice(12, 20)));
  // An unset key is absent rather than present-but-empty, so "no entry" and
  // "not configured" are the same statement.
  assert.equal(snap.secretPreviews.feishu.appSecret.length > 0, true);
  assert.equal("botToken" in snap.secretPreviews.telegram, false);

  // the on-disk state file carries no secret values (only non-secret config)
  const raw = JSON.parse(fsN.readFileSync(file, "utf8"));
  assert.deepEqual(raw.channels, ["feishu"]);
  assert.equal(raw.feishu, undefined);
  const rawJson = JSON.stringify(raw);
  assert.ok(!rawJson.includes(APP_SECRET));
  assert.ok(!rawJson.includes(APP_SECRET.slice(0, 8)));
});

test("a preview exists exactly when the key is reported as configured", async () => {
  // The pane renders the presence flag and the preview side by side; if the two
  // could disagree, a configured secret would render as 「当前值：未配置」.
  const provider = mapProvider();
  const store = createCredentialStore(provider);
  const svc = createSettingsService({ statePath: tmpFile(), credentialStore: store });
  // appSecret deliberately left unset, so the channel has one of each.
  await svc.saveCredentials("feishu", { appId: APP_ID });
  const snap = await svc.get();
  for (const ch of ["feishu", "telegram", "dingtalk", "web"]) {
    for (const key of Object.keys(snap.secrets[ch] ?? {})) {
      assert.equal(
        (snap.secretPreviews[ch]?.[key] ?? "").length > 0,
        snap.secrets[ch][key] === true,
        `preview and presence disagree for ${ch}.${key}`,
      );
    }
  }
  assert.equal(snap.secrets.feishu.appSecret, false);
  assert.equal("appSecret" in snap.secretPreviews.feishu, false);
});

test("a webhook preview keeps the robot's URL and masks only its token", async () => {
  const provider = mapProvider();
  const store = createCredentialStore(provider);
  const svc = createSettingsService({ statePath: tmpFile(), credentialStore: store });
  await svc.saveCredentials("dingtalk", { webhookUrl: WEBHOOK });
  const snap = await svc.get();
  assert.ok(snap.secretPreviews.dingtalk.webhookUrl.includes("oapi.dingtalk.com/robot/send"));
  assert.ok(!JSON.stringify(snap).includes("0123456789abcdef0123456789abcdef"));
});

test("a credential store that throws leaves no preview behind", async () => {
  // A broken store must degrade to "not configured", not to a half-filled
  // snapshot that contradicts itself.
  const credentialStore = {
    configured: async () => true,
    get: async () => { throw new Error("vault locked"); },
    save: async () => {},
    clear: async () => {},
  };
  const svc = createSettingsService({ statePath: tmpFile(), credentialStore });
  const snap = await svc.get();
  assert.equal(snap.credentials.feishu, false);
  assert.deepEqual(snap.secretPreviews.feishu, {});
});

test("without a credential store the snapshot carries empty previews, not a missing key", async () => {
  const svc = createSettingsService({ statePath: tmpFile() });
  const snap = await svc.get();
  assert.deepEqual(snap.secretPreviews.feishu, {});
  assert.deepEqual(snap.secretPreviews.web, {});
});

test("a live section is the store: reads come from it and writes go back through it", async () => {
  const file = tmpFile();
  let section = { channels: ["feishu"], feishu: { transport: "websocket" } };
  const written = [];
  const live = {
    read: () => section,
    write: async (config) => {
      written.push(config);
      section = { channels: config.channels, ...(config.feishu ? { feishu: config.feishu } : {}) };
    },
  };
  const svc = createSettingsService({ statePath: file, initialConfig: { channels: ["web"] }, live: () => live });

  const before = await svc.get();
  assert.equal(before.live, true);
  assert.deepEqual(before.enabled, ["feishu"]);
  assert.deepEqual(before.config.feishu, { transport: "websocket" });

  const after = await svc.save({ channels: ["feishu", "telegram"], channelDefaults: { language: "en" } });
  assert.deepEqual(written, [{ channels: ["feishu", "telegram"], channelDefaults: { language: "en" } }]);
  // The snapshot re-reads the section, so what the pane shows is what is stored.
  assert.deepEqual(after.enabled, ["feishu", "telegram"]);
  assert.equal(after.live, true);
  // Nothing was written to the fallback file.
  assert.equal(fsN.existsSync(file), false);
});

test("without a live section the state file is the store, and live is false", async () => {
  const file = tmpFile();
  const svc = createSettingsService({ statePath: file, live: () => undefined });
  const snap = await svc.save({ channels: ["web"] });
  assert.equal(snap.live, false);
  assert.deepEqual(JSON.parse(fsN.readFileSync(file, "utf8")).channels, ["web"]);
});

test("a live section that appears after construction is picked up (deferred install)", async () => {
  // The service is built during the plugin's `apply`; the namespace is
  // registered later by an injected scope, so the handle has to be read lazily.
  let handle;
  const file = tmpFile();
  const svc = createSettingsService({ statePath: file, live: () => handle });
  assert.equal((await svc.get()).live, false);
  handle = { read: () => ({ channels: ["dingtalk"] }), write: async () => {} };
  const snap = await svc.get();
  assert.equal(snap.live, true);
  assert.deepEqual(snap.enabled, ["dingtalk"]);
});

test("a failing live write rejects instead of silently falling back to the file", async () => {
  const file = tmpFile();
  const svc = createSettingsService({
    statePath: file,
    live: () => ({
      read: () => ({ channels: ["feishu"] }),
      write: async () => { throw new Error("ValidationError: feishu.transport"); },
    }),
  });
  await assert.rejects(svc.save({ channels: ["feishu"], feishu: { transport: "pigeon" } }), /ValidationError/);
  // No fallback write: a rejection means the saved value is unknown, not stale.
  assert.equal(fsN.existsSync(file), false);
});