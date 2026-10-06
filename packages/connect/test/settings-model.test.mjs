import { test } from "node:test";
import assert from "node:assert/strict";

import { snapshotToForm, buildConfigSave, buildCredentialSaves, CHANNEL_SECRET_FIELDS, CHANNEL_CONFIG_FIELDS, CHANNEL_DEFAULT_FIELDS, GENERAL_FIELD_GROUPS, GENERAL_FIELDS, coerceConfigValue } from "../lib/settings/settings-model.js";

test("CHANNEL_SECRET_FIELDS exposes per-channel secret field names", () => {
  // The verification token and encrypt key are the *webhook* transport's
  // secrets. They belong here like appId/appSecret do — the pane has to be able
  // to render and save them — even though they are deliberately absent from
  // CREDENTIAL_GROUPS.feishu, which answers the narrower 「has what it needs to
  // be reached」 question. See the note on that table.
  assert.deepEqual(CHANNEL_SECRET_FIELDS.feishu, ["appId", "appSecret", "verificationToken", "encryptKey"]);
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
  // The value used to be `appId`, which is a *credential* — it belongs to the
  // credential store, not to the config section, so writing it here was always
  // the wrong example. The payload builder now only emits keys on the channel's
  // own field/preserved table, and that is the behaviour under test.
  const form = { channels: ["feishu"], channelDefaults: { language: "zh" }, channelConfigs: { feishu: { transport: "websocket" }, telegram: {} }, secrets: {}, settingsStatePath: "s.json" };
  const cfg = buildConfigSave(form);
  assert.deepEqual(cfg, { channels: ["feishu"], channelDefaults: { language: "zh" }, feishu: { transport: "websocket" }, settingsStatePath: "s.json" });
});

test("buildCredentialSaves collects only channels with secret values", () => {
  const form = { channels: ["feishu", "telegram"], channelDefaults: {}, channelConfigs: {}, secrets: { feishu: { appSecret: "sec" }, telegram: {} }, settingsStatePath: undefined };
  const saves = buildCredentialSaves(form);
  assert.deepEqual(saves, [{ channel: "feishu", values: { appSecret: "sec" } }]);
});

test("CHANNEL_CONFIG_FIELDS exposes editable non-secret fields per channel", () => {
  assert.deepEqual(CHANNEL_CONFIG_FIELDS.feishu.map((f) => f.key), ["transport", "requireMention", "dmMode", "language", "threadIsolation", "onboarding", "webhookPort", "webhookPath"]);
  assert.equal(CHANNEL_CONFIG_FIELDS.feishu.find((f) => f.key === "transport").options.includes("websocket"), true);
  assert.deepEqual(CHANNEL_CONFIG_FIELDS.telegram.map((f) => f.key), ["requireMention", "language", "pollingTimeoutSeconds", "baseUrl"]);
  assert.deepEqual(CHANNEL_CONFIG_FIELDS.web.map((f) => f.key), ["pollIntervalMs"]);
  assert.equal(CHANNEL_CONFIG_FIELDS.feishu.find((f) => f.key === "requireMention").kind, "boolean");
  // channelDefaults describe channel-agnostic keys. `notifyLevel` used to be
  // here and was dead: no channel adapter ever read it, and the real
  // plugin-wide value is the top-level `notifyLevel` the runner resolves (now
  // edited in 通用设置). Dropped rather than left in place, because a field the
  // pane renders and nothing consumes is a control that appears to do nothing.
  assert.deepEqual(CHANNEL_DEFAULT_FIELDS.map((f) => f.key), ["language"]);
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

test("coerceConfigValue turns a list's raw text into non-empty entries", () => {
  // The control is a textarea, so the separator the user reaches for is a
  // newline; commas are accepted too because a pasted `C:/a, C:/b` should do
  // what it looks like rather than become one absurd path.
  assert.deepEqual(coerceConfigValue("list", "a\nb, c ,"), ["a", "b", "c"]);
  assert.deepEqual(coerceConfigValue("list", ["a", " b ", ""]), ["a", "b"]);
});

test("an emptied list coerces to undefined, not to []", () => {
  // Deliberate, and the difference is visible in the user's settings file.
  // These keys are `z.array`, and a volatile array resolves an *absent* key to
  // `[]` on the way back in — so projecting one back out as `workspaces: []`
  // would stamp noise into every profile that ever saved while leaving the box
  // blank. Emptying the box means "back to inherited", which is what absent is.
  assert.equal(coerceConfigValue("list", ""), undefined);
  assert.equal(coerceConfigValue("list", "  \n , "), undefined);
  assert.equal(coerceConfigValue("list", []), undefined);
});

test("GENERAL_FIELDS is the four groups, flattened, in render order", () => {
  // Order is the pane's render order and is asserted rather than assumed: the
  // groups are what the user actually sees, and a reordering here silently
  // reorders 通用设置.
  assert.deepEqual(GENERAL_FIELD_GROUPS.map((g) => g.title), [
    "g.group.locale", "g.group.workspace", "g.group.access", "g.group.agent",
  ]);
  assert.deepEqual(GENERAL_FIELDS.map((f) => f.key), [
    "language", "notifyLevel", "progressTimeoutMs",
    "workDir", "workspaces",
    "allowUsers", "allowChats",
    "agentPreset", "autoMirror", "streamHeartbeatMs",
  ]);
  assert.deepEqual(GENERAL_FIELDS, GENERAL_FIELD_GROUPS.flatMap((g) => g.fields));
  // Every list-kind field must go through the `'list'` coercion above — a
  // `text` kind on `workspaces` would save the whole textarea as one string.
  for (const key of ["workspaces", "allowUsers", "allowChats"]) {
    assert.equal(GENERAL_FIELDS.find((f) => f.key === key).kind, "list", `${key} must be a list`);
  }
});

test("snapshotToForm seeds every known channel, so a save cannot wipe a disabled one", () => {
  // A save replaces the whole declared section: a channel block the payload
  // omits is reset to its inherited value (see namespace.ts). Seeding only the
  // *enabled* channels meant that a channel the user had configured and then
  // switched off lost every declared field on the next save — including a save
  // made for an entirely unrelated reason. The card for a switched-off channel
  // also renders whatever is still stored, rather than a blank form.
  const snap = {
    config: { channels: ["web"], feishu: { transport: "websocket", dmMode: "pair" } },
    enabled: ["web"],
    credentials: {},
    live: true,
  };
  const form = snapshotToForm(snap);
  assert.deepEqual(form.channelConfigs.feishu, { transport: "websocket", dmMode: "pair" });
  // Channels with nothing stored are seeded empty and then dropped by the
  // payload builder, so seeding them all costs nothing in the document.
  assert.deepEqual(form.channelConfigs.telegram, {});

  const cfg = buildConfigSave(form);
  assert.deepEqual(cfg.channels, ["web"]);
  assert.deepEqual(cfg.feishu, { transport: "websocket", dmMode: "pair" });
  assert.equal("telegram" in cfg, false);
});

test("buildConfigSave round-trips full non-secret channel config", () => {
  const form = {
    channels: ["feishu"],
    channelDefaults: { language: "zh" },
    channelConfigs: { feishu: { transport: "websocket", requireMention: true, dmMode: "open", webhookPort: 9000, cleared: undefined } },
    secrets: {},
    settingsStatePath: ".dsh-connect/settings.json",
  };
  const cfg = buildConfigSave(form);
  assert.deepEqual(cfg, {
    channels: ["feishu"],
    channelDefaults: { language: "zh" },
    feishu: { transport: "websocket", requireMention: true, dmMode: "open", webhookPort: 9000 },
    settingsStatePath: ".dsh-connect/settings.json",
  });
});

// --- the general keys on the form -----------------------------------------

test("snapshotToForm seeds the general keys from the top level of the config", () => {
  const snap = {
    config: { channels: ["feishu"], language: "en", notifyLevel: "result", workspaces: ["packages"], autoMirror: false, stateDir: ".dsh-connect" },
    enabled: ["feishu"], credentials: {}, live: true,
  };
  const form = snapshotToForm(snap);
  assert.deepEqual(form.general, { language: "en", notifyLevel: "result", workspaces: ["packages"], autoMirror: false });
  // Not a copy of the whole top level: `stateDir` is not a general field, so
  // the form — which is what a save sends back — must not claim to own it.
  assert.equal("stateDir" in form.general, false);
});

test("a seeded list is copied, so the form never aliases the snapshot it came from", () => {
  // `setGeneral` replaces the whole `general` object rather than mutating it,
  // but a list *inside* it is edited through the same path; aliasing the host's
  // own array would let a pane edit reach back into the snapshot.
  const workspaces = ["packages"];
  const form = snapshotToForm({ config: { workspaces }, enabled: [], credentials: {} });
  form.general.workspaces.push("docs");
  assert.deepEqual(workspaces, ["packages"]);
});

test("snapshotToForm carries the shared-config provenance list, defaulting to empty", () => {
  // The pane prints a 「current value comes from the shared config」 note on
  // these rows. Absent on a clean install — which is why the host only sends it
  // when non-empty, and why this must still produce a usable array.
  const withKeys = snapshotToForm({ config: {}, enabled: [], credentials: {}, sharedOverrideKeys: ["workDir", "language"] });
  assert.deepEqual(withKeys.sharedOverrideKeys, ["workDir", "language"]);
  const clean = snapshotToForm({ config: {}, enabled: [], credentials: {} });
  assert.deepEqual(clean.sharedOverrideKeys, []);
});

test("snapshotToForm carries the DSH-owned model only when the host resolved one", () => {
  const form = snapshotToForm({ config: {}, enabled: [], credentials: {}, agentModel: { provider: "deepseek", model: "v4" } });
  assert.deepEqual(form.agentModel, { provider: "deepseek", model: "v4" });
  // Absent, not empty: the pane omits the row entirely rather than rendering an
  // empty control, so a blank string would be a lie about what DSH reports.
  assert.equal(snapshotToForm({ config: {}, enabled: [], credentials: {} }).agentModel, undefined);
});

test("buildConfigSave flattens the general keys beside channels", () => {
  const form = {
    channels: ["feishu"],
    channelDefaults: {},
    channelConfigs: {},
    general: { language: "en", notifyLevel: "result", workDir: "C:/code", workspaces: ["packages", "docs"], autoMirror: true },
    secrets: {},
  };
  assert.deepEqual(buildConfigSave(form), {
    channels: ["feishu"],
    language: "en",
    notifyLevel: "result",
    workDir: "C:/code",
    workspaces: ["packages", "docs"],
    autoMirror: true,
  });
});

test("buildConfigSave drops a cleared list rather than writing []", () => {
  // The other half of the empty-list rule: `coerceConfigValue` deletes the key
  // when the box is emptied, and this is what makes that deletion survive all
  // the way to the payload. Writing `workspaces: []` instead would be an
  // endless source of noise, since absent and `[]` mean the same thing here.
  const form = { channels: [], channelDefaults: {}, channelConfigs: {}, general: { workspaces: [], allowUsers: ["ou_1"] }, secrets: {} };
  const cfg = buildConfigSave(form);
  assert.equal("workspaces" in cfg, false);
  assert.deepEqual(cfg.allowUsers, ["ou_1"]);
});

test("buildConfigSave never emits agentModel", () => {
  // It belongs to DSH. This pane reads it for a display row and has no write
  // path for it, deliberately — see the note on `renderModelRow` in the client.
  // If it ever appears in a payload, that decision has been undone by accident.
  const form = {
    channels: ["feishu"], channelDefaults: {}, channelConfigs: {},
    general: { language: "en" }, secrets: {},
    agentModel: { provider: "deepseek", model: "v4" },
    sharedOverrideKeys: ["language"],
  };
  const cfg = buildConfigSave(form);
  assert.equal("agentModel" in cfg, false);
  assert.equal("sharedOverrideKeys" in cfg, false);
  assert.equal(JSON.stringify(cfg).includes("deepseek"), false);
});
