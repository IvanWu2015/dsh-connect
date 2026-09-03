import { test } from "node:test";
import assert from "node:assert/strict";

import { snapshotToForm, buildConfigSave, buildCredentialSaves, CHANNEL_SECRET_FIELDS, CHANNEL_CONFIG_FIELDS, CHANNEL_DEFAULT_FIELDS, coerceConfigValue } from "../lib/settings/settings-model.js";

test("CHANNEL_SECRET_FIELDS exposes per-channel secret field names", () => {
  assert.deepEqual(CHANNEL_SECRET_FIELDS.feishu, ["appId", "appSecret"]);
  assert.deepEqual(CHANNEL_SECRET_FIELDS.telegram, ["botToken"]);
  assert.deepEqual(CHANNEL_SECRET_FIELDS.web, []);
});

test("snapshotToForm maps enabled + config into the form", () => {
  const snap = { config: { channels: ["feishu"], channelDefaults: { language: "zh" }, feishu: { appId: "cli_1" }, settingsStatePath: "s.json" }, enabled: ["feishu"], credentials: {} };
  const form = snapshotToForm(snap);
  assert.deepEqual(form.channels, ["feishu"]);
  assert.deepEqual(form.channelDefaults, { language: "zh" });
  assert.deepEqual(form.channelConfigs.feishu, { appId: "cli_1" });
  assert.equal(form.settingsStatePath, "s.json");
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
