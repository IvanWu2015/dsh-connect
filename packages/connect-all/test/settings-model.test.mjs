import { test } from "node:test";
import assert from "node:assert/strict";

import { snapshotToForm, buildConfigSave, buildCredentialSaves, CHANNEL_SECRET_FIELDS } from "../lib/settings-model.js";

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
