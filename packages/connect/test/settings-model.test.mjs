import { test } from "node:test";
import assert from "node:assert/strict";

import { snapshotToForm, buildConfigSave, buildCredentialSaves, CHANNEL_SECRET_FIELDS, CHANNEL_CONFIG_FIELDS, CHANNEL_DEFAULT_FIELDS, coerceConfigValue } from "../lib/settings/settings-model.js";

test("CHANNEL_SECRET_FIELDS exposes per-channel secret field names", () => {
  assert.deepEqual(CHANNEL_SECRET_FIELDS.feishu, ["appId", "appSecret"]);
  assert.deepEqual(CHANNEL_SECRET_FIELDS.telegram, ["botToken"]);
  assert.deepEqual(CHANNEL_SECRET_FIELDS.web, []);
});

test("snapshotToForm maps enabled + config into the form", () => {
  const snap = { config: { channels: ["feishu"], channelDefaults: { language: "zh" }, feishu: { transport: "websocket" }, settingsStatePath: "s.json" }, enabled: ["feishu"], credentials: {}, secrets: { feishu: { appId: true } }, live: false };
  const form = snapshotToForm(snap);
  assert.deepEqual(form.channels, ["feishu"]);
  assert.deepEqual(form.channelDefaults, { language: "zh" });
  assert.deepEqual(form.channelConfigs.feishu, { transport: "websocket" });
  assert.equal(form.settingsStatePath, "s.json");
  assert.equal(form.live, false);
  assert.deepEqual(form.secretPresence, { feishu: { appId: true } });
});

test("snapshotToForm never seeds a secret value — the inputs start blank", () => {
  // The host reports presence and a masked preview, not values, so a read must
  // not be able to fill an input even if some other host did send one.
  const snap = { config: {}, enabled: [], credentials: {}, secrets: { feishu: { appSecret: "leaked" } }, live: true };
  const form = snapshotToForm(snap);
  assert.deepEqual(form.secrets, {});
  assert.deepEqual(form.secretPresence, { feishu: { appSecret: "leaked" } });
  assert.equal(form.live, true);
});

test("snapshotToForm carries the masked previews through, still without seeding the inputs", () => {
  // The two have opposite lifetimes: the preview is what the host already
  // masked for display, the input is where the user types a *new* value. Seeding
  // an input with the preview would let a stray save write the mask back as the
  // credential.
  const snap = {
    config: {}, enabled: ["feishu"], credentials: { feishu: true },
    secrets: { feishu: { appId: true, appSecret: true } },
    secretPreviews: { feishu: { appId: "cli_a1b2c3d4", appSecret: "a1b2…z9y8" } },
    live: false,
  };
  const form = snapshotToForm(snap);
  assert.deepEqual(form.secretPreviews, { feishu: { appId: "cli_a1b2c3d4", appSecret: "a1b2…z9y8" } });
  assert.deepEqual(form.secrets, {});
});

test("snapshotToForm tolerates a host that sends no previews at all", () => {
  // Older host, new client (or the reverse): an absent field must not throw.
  const form = snapshotToForm({ config: {}, enabled: ["feishu"], credentials: {} });
  assert.deepEqual(form.secretPreviews, {});
});

test("a form holding only previews emits no credential saves", () => {
  // The structural guarantee that a mask can never be written back as a secret:
  // `buildCredentialSaves` reads `form.secrets` and nothing else.
  const form = snapshotToForm({
    config: {}, enabled: ["feishu"], credentials: { feishu: true },
    secrets: { feishu: { appId: true, appSecret: true } },
    secretPreviews: { feishu: { appId: "cli_a1b2c3d4", appSecret: "a1b2…z9y8" } },
    live: true,
  });
  assert.deepEqual(buildCredentialSaves(form), []);
  // ...and saving the config in that state touches no credential path either.
  assert.deepEqual(buildConfigSave(form), { channels: ["feishu"] });
});

test("snapshotToForm defaults to the file plane when the host doesn't say", () => {
  const form = snapshotToForm({ config: {}, enabled: [], credentials: {} });
  assert.equal(form.live, false);
  assert.deepEqual(form.secrets, {});
  assert.deepEqual(form.secretPresence, {});
});

test("buildConfigSave emits channels, defaults, non-empty channel configs, path", () => {
  const form = { channels: ["feishu"], channelDefaults: { language: "zh" }, channelConfigs: { feishu: { appId: "cli_1" }, telegram: {} }, secrets: {}, settingsStatePath: "s.json" };
  const cfg = buildConfigSave(form);
  assert.deepEqual(cfg, { channels: ["feishu"], channelDefaults: { language: "zh" }, feishu: { appId: "cli_1" }, settingsStatePath: "s.json" });
});

test("buildCredentialSaves collects only channels with secret values", () => {
  const form = { channels: ["feishu", "telegram"], channelDefaults: {}, channelConfigs: {}, secrets: { feishu: { appSecret: "sec" }, telegram: {} }, settingsStatePath: undefined };
  const saves = buildCredentialSaves(form);
  assert.deepEqual(saves, [{ channel: "feishu", values: { appSecret: "sec" } }]);
});

test("CHANNEL_CONFIG_FIELDS exposes editable non-secret fields per channel", () => {
  assert.deepEqual(CHANNEL_CONFIG_FIELDS.feishu.map((f) => f.key), ["transport", "requireMention", "dmMode", "language", "webhookPort", "webhookPath"]);
  assert.equal(CHANNEL_CONFIG_FIELDS.feishu.find((f) => f.key === "transport").options.includes("websocket"), true);
  assert.deepEqual(CHANNEL_CONFIG_FIELDS.telegram.map((f) => f.key), ["requireMention", "language", "pollingTimeoutSeconds", "baseUrl"]);
  assert.deepEqual(CHANNEL_CONFIG_FIELDS.web.map((f) => f.key), ["pollIntervalMs"]);
  assert.equal(CHANNEL_CONFIG_FIELDS.feishu.find((f) => f.key === "requireMention").kind, "boolean");
  // channelDefaults describe channel-agnostic keys
  assert.deepEqual(CHANNEL_DEFAULT_FIELDS.map((f) => f.key), ["language", "notifyLevel"]);
});

test("coerceConfigValue normalizes raw inputs by kind", () => {
  assert.equal(coerceConfigValue("number", "9000"), 9000);
  assert.equal(coerceConfigValue("number", ""), undefined);
  assert.equal(coerceConfigValue("boolean", true), true);
  assert.equal(coerceConfigValue("boolean", "true"), true);
  assert.equal(coerceConfigValue("boolean", ""), undefined);
  assert.equal(coerceConfigValue("select", "websocket"), "websocket");
  assert.equal(coerceConfigValue("text", "cli_1"), "cli_1");
});

test("buildConfigSave round-trips full non-secret channel config", () => {
  const form = {
    channels: ["feishu"],
    channelDefaults: { language: "zh", notifyLevel: "important" },
    channelConfigs: { feishu: { transport: "websocket", requireMention: true, dmMode: "open", webhookPort: 9000, cleared: undefined } },
    secrets: {},
    settingsStatePath: ".dsh-connect/settings.json",
  };
  const cfg = buildConfigSave(form);
  assert.deepEqual(cfg, {
    channels: ["feishu"],
    channelDefaults: { language: "zh", notifyLevel: "important" },
    feishu: { transport: "websocket", requireMention: true, dmMode: "open", webhookPort: 9000 },
    settingsStatePath: ".dsh-connect/settings.json",
  });
});
