import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fsN from "node:fs";

import { createSettingsService } from "../lib/settings/settings-service.js";
import { createCredentialStore, CHANNEL_SECRET_KEYS } from "../lib/settings/credential-store.js";
import { snapshotToForm, buildConfigSave } from "../lib/settings/settings-model.js";
import { isMaskedSecret } from "../lib/settings/secret-disclosure.js";
import { CHANNELS, readDotPath, secretConfigPath, writeDotPath } from "../lib/settings/channels.js";

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

test("a credential save re-applies the channels, after the store holds the new value", async () => {
  // An adapter keeps the secret it was started with, and the namespace's
  // `onChange` fires only for a *config* write — the pane saves credentials as a
  // separate call after that one. Without this hook a rotated appSecret stayed
  // inert until a restart while the pane said 「已保存」.
  const provider = mapProvider();
  const store = createCredentialStore(provider);
  const observed = [];
  const svc = createSettingsService({
    statePath: tmpFile(),
    credentialStore: store,
    onCredentialsSaved: () => observed.push(provider.store.get("DSH_CONNECT_FEISHU_APP_SECRET")),
  });
  await svc.saveCredentials("feishu", { appSecret: "sec_9" });
  assert.deepEqual(observed, ["sec_9"]);
});

test("a failing reconcile is not reported as a failed credential save", async () => {
  // The credential *is* stored; the phrase the pane shows has to match that.
  const provider = mapProvider();
  const store = createCredentialStore(provider);
  const logs = [];
  const svc = createSettingsService({
    statePath: tmpFile(),
    credentialStore: store,
    log: (m) => logs.push(m),
    onCredentialsSaved: () => { throw new Error("adapter restart failed"); },
  });
  // Both refs of the group, so the channel really is reported as configured.
  const snap = await svc.saveCredentials("feishu", { appId: "cli_9", appSecret: "sec_9" });
  assert.equal(snap.credentials.feishu, true);
  assert.equal(provider.store.get("DSH_CONNECT_FEISHU_APP_SECRET"), "sec_9");
  assert.equal(logs.some((m) => m.includes("adapter restart failed")), true);
});

test("an unwritable state file fails the save instead of reporting success", async () => {
  // The pane renders 「已保存」 from a resolved promise, so a swallowed write
  // error shows success for a setting that is gone at the next restart. A
  // directory in place of the file is the portable way to make the write fail
  // (EISDIR on POSIX, EISDIR/EPERM on Windows).
  const dir = fsN.mkdtempSync(path.join(os.tmpdir(), "dsh-connect-settings-"));
  const svc = createSettingsService({ statePath: dir });
  await assert.rejects(svc.save({ channels: ["feishu"] }), (e) => e.code === "save-failed");
});

test("a secret hand-edited into the fallback file never reaches the pane", async () => {
  const file = tmpFile();
  fsN.writeFileSync(file, JSON.stringify({
    channels: ["feishu"],
    language: "en",
    settingsStatePath: file,
    feishu: { transport: "websocket", appSecret: "leaked_secret_value" },
  }));
  const svc = createSettingsService({ statePath: file });
  const snap = await svc.get();
  assert.deepEqual(snap.config.feishu, { transport: "websocket" });
  assert.ok(!JSON.stringify(snap).includes("leaked_secret_value"));
  // Only the secret keys are dropped: this plane is a loose merge store rather
  // than the declared schema, so a shared-config key like `language` and the
  // path itself have to survive the read.
  assert.equal(snap.config.language, "en");
  assert.equal(snap.config.settingsStatePath, file);
  assert.deepEqual(snap.config.channels, ["feishu"]);

  // The file keeps what the user wrote: the filter is on the way out, and
  // deleting a value out of someone's document as a side effect of an unrelated
  // save would be a worse bug than the one being fixed here.
  const after = await svc.save({ channels: ["feishu", "web"] });
  assert.ok(!JSON.stringify(after).includes("leaked_secret_value"));
  const onDisk = JSON.parse(fsN.readFileSync(file, "utf8"));
  assert.equal(onDisk.feishu.appSecret, "leaked_secret_value");
  assert.deepEqual(onDisk.channels, ["feishu", "web"]);
});

test("a secret hand-written into the plugin entry never reaches the pane", async () => {
  // The realistic case for this one: the plugin entry is *allowed* to carry a
  // secret the user wrote by hand, and the deployed profile does. The read is
  // the resolved section, so without the same filter the value would ride out
  // in the snapshot the browser receives — while the whole point of the masked
  // preview is that a secret never does.
  const section = {
    channels: ["feishu"],
    feishu: { transport: "websocket", appId: "cli_a1b2c3d4", appSecret: "hand_written_secret" },
  };
  const svc = createSettingsService({
    statePath: tmpFile(),
    live: () => ({ read: () => section, write: async () => {} }),
  });
  const snap = await svc.get();
  // appId goes with it, and that is the honest answer rather than an
  // over-reach: it is a credential-store ref exactly like appSecret, so the
  // pane shows it on the credential plane (as a preview the user can read in
  // full) and not as a config field. Exempting it here would take a guess about
  // which keys are authenticators, and that guess is the kind that rots.
  assert.deepEqual(snap.config.feishu, { transport: "websocket" });
  const wire = JSON.stringify(snap);
  assert.ok(!wire.includes("hand_written_secret"));
  assert.ok(!wire.includes("cli_a1b2c3d4"));

  // ...and the filter is load-bearing for *writes*, not just for display: the
  // form is built from `snap.config` and the payload builder re-emits whatever
  // keys it finds there, so an unfiltered read would hand the secret back to
  // the server inside the next save.
  const payload = buildConfigSave(snapshotToForm(snap));
  assert.deepEqual(payload.feishu, { transport: "websocket" });
  assert.ok(!JSON.stringify(payload).includes("hand_written_secret"));

  // Nothing was removed from the document: the filter is on the way out, and
  // the service never writes a read back.
  assert.equal(section.feishu.appSecret, "hand_written_secret");
  assert.equal(section.feishu.appId, "cli_a1b2c3d4");
});

test("no declared secret survives a read or a save, on either plane", async () => {
  // Derived from the credential table rather than hand-listed, because the two
  // tests above each name one key and the table has since grown twice: feishu
  // gained the webhook transport's `verificationToken` and `encryptKey`, and a
  // hand-written list would have gone on certifying a filter that no longer
  // covers the keys the adapter actually reads. Every channel, every declared
  // key, planted at the key's *config path* — which is where the adapter looks
  // for it, and therefore where a leak would surface.
  const planted = [];
  const section = { channels: [...CHANNELS] };
  for (const channel of CHANNELS) {
    for (const key of Object.keys(CHANNEL_SECRET_KEYS[channel] ?? {})) {
      // Long enough that the mask has a middle to hide — a short value falls into
      // the all-bullets branch and would let "the value never appears" pass
      // without the head/tail logic ever running.
      const value = `leak_${channel}_${key}_0123456789abcdef`;
      writeDotPath(section, `${channel}.${secretConfigPath(channel, key)}`, value);
      planted.push({ channel, key, value });
    }
  }
  assert.ok(planted.length >= 9, `the sweep planted only ${planted.length} values — CHANNEL_SECRET_KEYS shrank`);

  // The same values in the credential store, where a secret is *supposed* to
  // live. Both places at once is the realistic worst case: the startup migration
  // copies config secrets into the store and the profile may still carry them.
  const provider = mapProvider();
  const credentialStore = createCredentialStore(provider);
  // `save` is keyed by the store *ref*, not by the config key, even though `get`
  // answers in config keys — mapping one to the other is the ref table's whole
  // job. Passing the config key here would silently store nothing.
  for (const { channel, key, value } of planted) {
    await credentialStore.save(channel, { [CHANNEL_SECRET_KEYS[channel][key]]: value });
  }
  assert.equal(provider.store.size, planted.length, "the credential store did not take every planted secret");

  const liveSection = { ...section };
  const file = tmpFile();
  fsN.writeFileSync(file, JSON.stringify({ ...section, settingsStatePath: file }));
  const PLANES = [
    { name: "settings namespace", svc: createSettingsService({ statePath: tmpFile(), credentialStore, live: () => ({ read: () => liveSection, write: async () => {} }) }) },
    { name: "json fallback", svc: createSettingsService({ statePath: file, credentialStore }) },
  ];

  /**
   * Every claim this sweep makes about one snapshot, in one place so the *read*
   * and the save's *answer* are held to the same standard — they are the same
   * object type from the same builder, and a leak that only ever shows up on the
   * save path is the one a read-only check would miss.
   */
  function assertSnapshotCarriesNoSecret(snap, where) {
    for (const { channel, key, value } of planted) {
      // `snap.config` is the part the pane builds a save payload from, so a secret
      // sitting here is not a display wart — it is a credential that gets written
      // back into the profile on the next click. Asserted per *path* rather than
      // by substring so a failure names the offending key instead of dumping a
      // whole snapshot into the diff.
      assert.equal(
        readDotPath(snap.config[channel] ?? {}, secretConfigPath(channel, key)),
        undefined,
        `${where}: ${channel}.${key} is in the config the pane re-emits on save`,
      );

      // The other half of the report: the pane must still be able to say the key
      // *is* stored. A filter that stripped the value and the flag together
      // would look identical on the wire and would send the user to re-enter a
      // secret that is already there.
      assert.equal(snap.secrets[channel]?.[key], true, `${where}: ${channel}.${key} is stored but reported as unset`);

      // The masked preview is the one place a stored secret is allowed to appear.
      // Identifiers are exempt *by design* — `disclosureOf` calls `appId`/`clientId`
      // `full` because they appear in the URL of every outbound call and grant
      // nothing alone, and showing them verbatim is the only way the user can tell
      // a correct id from a typo. `isMaskedSecret` is the same predicate the host
      // masks with, so this cannot drift from what the host actually did. It is
      // also why the confidential branch checks the whole wire and the identifier
      // branch does not: a blanket substring check would fail on a preview that is
      // *supposed* to be verbatim, and a check loosened to accommodate that would
      // stop catching the leaks it exists for.
      const preview = snap.secretPreviews[channel]?.[key];
      assert.ok(preview, `${where}: ${channel}.${key} has no preview`);
      if (isMaskedSecret(key)) {
        assert.ok(preview !== value && !preview.includes(value), `${where}: ${channel}.${key} preview is not masked`);
        assert.ok(!JSON.stringify(snap).includes(value), `${where}: ${channel}.${key} reached the pane snapshot in clear text`);
      } else {
        assert.equal(preview, value, `${where}: ${channel}.${key} is an identifier and should be shown in full`);
      }
    }
  }

  for (const plane of PLANES) {
    const snap = await plane.svc.get();
    assertSnapshotCarriesNoSecret(snap, plane.name);

    // And the filter is load-bearing for writes, not only for display: the pane
    // builds its form from `snap.config` and re-emits whatever it finds there.
    // The payload carries no previews, so a plain substring check is exact here
    // and catches a secret at a path this test never thought to name.
    const payload = buildConfigSave(snapshotToForm(snap));
    assert.ok(!JSON.stringify(payload).includes("leak_"), `${plane.name}: a save payload carries a secret back`);
    assertSnapshotCarriesNoSecret(await plane.svc.save({ channels: [...CHANNELS] }), `${plane.name} (save answer)`);
  }

  // Nothing was deleted out of either document: the filter is on the way out,
  // and a read that rewrote the profile would be a worse bug than the leak.
  for (const { channel, key, value } of planted) {
    assert.equal(readDotPath(section[channel], secretConfigPath(channel, key)), value, `${channel}.${key} was removed from the document`);
  }
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
  // Keyed by *every* secret the channel declares, so derived rather than
  // hand-listed: feishu now declares the webhook transport's verificationToken
  // and encryptKey beside the app credentials, and this save stored neither —
  // `false` for those is the correct report, not a regression.
  const stored = new Set(["appId", "appSecret"]);
  assert.deepEqual(
    snap.secrets.feishu,
    Object.fromEntries(Object.keys(CHANNEL_SECRET_KEYS.feishu).map((k) => [k, stored.has(k)])),
  );
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

// --- the two general-view extras on the snapshot ---------------------------
//
// Both are display-only and both are attached **only when they have something
// to say**. The pane's own tests deep-equal whole snapshots, so an
// always-present `agentModel: undefined` / `sharedOverrideKeys: []` would be
// noise on the happy path — which is the common case for both (no DSH model
// resolved, no shared config on the machine).

test("a snapshot with nothing extra carries neither general-view field", async () => {
  const svc = createSettingsService({ statePath: tmpFile() });
  const snap = await svc.get();
  assert.equal("agentModel" in snap, false);
  assert.equal("sharedOverrideKeys" in snap, false);
});

test("a resolved default model rides along, read-only and never writeable", async () => {
  const file = tmpFile();
  const svc = createSettingsService({
    statePath: file,
    agentModel: () => ({ provider: "deepseek", model: "v4" }),
  });
  const snap = await svc.get();
  assert.deepEqual(snap.agentModel, { provider: "deepseek", model: "v4" });

  // The whole point of the read-only row: seeing the value must not create a
  // way to change it. `saveSelection()` exists and is what `/model` uses — this
  // snapshot must stay out of that path, so a save built from it carries no
  // trace of the value and the state file never learns it.
  const payload = buildConfigSave(snapshotToForm(snap));
  assert.equal("agentModel" in payload, false);
  assert.equal(JSON.stringify(payload).includes("deepseek"), false);
  assert.equal(JSON.stringify(snap.config).includes("deepseek"), false);
  await svc.save(payload);
  assert.equal(JSON.stringify(JSON.parse(fsN.readFileSync(file, "utf8"))).includes("deepseek"), false);
});

test("a half-answered default model is dropped rather than shown empty", async () => {
  // "Cannot say" is not "nothing selected". Every shape that leaves the row
  // without a provider *and* a model is the same statement, and a row reading
  // 「deepseek / 」 would be a claim about DSH that DSH did not make.
  for (const selection of [
    undefined,
    {},
    { provider: "deepseek" },
    { model: "v4" },
    { provider: "", model: "v4" },
    { provider: "deepseek", model: "" },
  ]) {
    const svc = createSettingsService({ statePath: tmpFile(), agentModel: () => selection });
    assert.equal("agentModel" in (await svc.get()), false, `kept a partial selection: ${JSON.stringify(selection)}`);
  }
});

test("a default-model getter that throws degrades to no row, and says so", async () => {
  const logs = [];
  const svc = createSettingsService({
    statePath: tmpFile(),
    log: (m) => logs.push(m),
    agentModel: () => { throw new Error("agentDefaultModel is still injecting"); },
  });
  const snap = await svc.get();
  assert.equal("agentModel" in snap, false);
  assert.equal(logs.some((m) => m.includes("agentDefaultModel is still injecting")), true);
});

test("shared-config overrides ride along only when a shared config really shadows a key", async () => {
  const clean = createSettingsService({ statePath: tmpFile(), sharedOverrideKeys: () => [] });
  assert.equal("sharedOverrideKeys" in (await clean.get()), false);

  const shadowed = createSettingsService({
    statePath: tmpFile(),
    sharedOverrideKeys: () => ["workDir", "language", "autoMirror"],
  });
  assert.deepEqual((await shadowed.get()).sharedOverrideKeys, ["workDir", "language", "autoMirror"]);

  // A copy, so the pane's list and the service's own cannot be the same array:
  // the host hands out the live one, and a client-side edit reaching back into
  // it would change what the *next* read reports.
  const source = ["workDir"];
  const copying = createSettingsService({ statePath: tmpFile(), sharedOverrideKeys: () => source });
  const snap = await copying.get();
  source.push("language");
  assert.deepEqual(snap.sharedOverrideKeys, ["workDir"]);
});

// --- the access-state probe ------------------------------------------------
//
// 「接入状态」 is attached on an *opposite* rule to every other optional key in
// this snapshot. `channelErrors`, `warnings` and `sharedOverrideKeys` appear
// only when they have something to say, so an empty result is indistinguishable
// from "the host cannot tell you". For access state that distinction is the
// whole point: 「未启用」 and 「未运行」 are answers, and a channel missing from
// the map would be a channel the pane has nothing to render — so the key is
// present whenever the probe is wired, empty or not, and absent when it is not.

test("the access-state probe is asked with the enabled list the snapshot reports", async () => {
  // The same array object, not a copy of it: the badge's idea of "which
  // channels are on" and the snapshot's `enabled` cannot drift if they are the
  // same value, which is also why the probe takes `enabled` as an argument
  // rather than reading the config again.
  const asked = [];
  const svc = createSettingsService({
    statePath: tmpFile(),
    channelStatus: (enabled) => {
      asked.push(enabled);
      return { feishu: { state: "connected" } };
    },
  });
  await svc.save({ channels: ["feishu"], telegram: { requireMention: true } });
  const snap = await svc.get();

  assert.deepEqual(asked.at(-1), ["feishu"]);
  assert.deepEqual(snap.enabled, ["feishu"]);
  assert.deepEqual(snap.channelStatus, { feishu: { state: "connected" } });
});

test("a probe that reports only disabled channels still produces the key", async () => {
  // The distinction the option's comment exists for. An empty map here means
  // "every channel is off", which the pane renders as 「未启用」 — dropping the
  // key instead would make the badge vanish and read as "no information".
  const svc = createSettingsService({ statePath: tmpFile(), channelStatus: () => ({}) });
  const snap = await svc.get();
  assert.equal("channelStatus" in snap, true);
  assert.deepEqual(snap.channelStatus, {});
});

test("without a probe the snapshot carries no access state at all", async () => {
  const svc = createSettingsService({ statePath: tmpFile() });
  assert.equal("channelStatus" in (await svc.get()), false);
});

test("a probe that throws degrades to no key, and the read still succeeds", async () => {
  // Failing to *describe* a state is not the same claim as the state being
  // empty, so it must not be reported as `{}` — and it must never turn a read,
  // or a save that ends in one, into a failure.
  const logs = [];
  const svc = createSettingsService({
    statePath: tmpFile(),
    log: (m) => logs.push(m),
    channelStatus: () => { throw new Error("the runtime never started"); },
  });
  const snap = await svc.get();
  assert.equal("channelStatus" in snap, false);
  assert.equal(logs.some((m) => m.includes("the runtime never started")), true);
});

test("a probe returning undefined is read as 'cannot say', not as an empty map", async () => {
  // The other way a probe can decline. `{}` and `undefined` mean different
  // things and only the probe knows which one it means.
  const svc = createSettingsService({ statePath: tmpFile(), channelStatus: () => undefined });
  assert.equal("channelStatus" in (await svc.get()), false);
});

test("the access state rides on a save's answer too, so the badge refreshes with it", async () => {
  let state = "connecting";
  const svc = createSettingsService({
    statePath: tmpFile(),
    channelStatus: () => ({ feishu: { state } }),
  });
  const first = await svc.save({ channels: ["feishu"] });
  // `connecting` → `connected`, the transition the user actually watches for.
  state = "connected";
  const second = await svc.save({ channels: ["feishu"] });
  assert.deepEqual(first.channelStatus, { feishu: { state: "connecting" } });
  assert.deepEqual(second.channelStatus, { feishu: { state: "connected" } });
});

test("a shared-override getter that throws reads as 'nothing is overridden', and says so", async () => {
  const logs = [];
  const svc = createSettingsService({
    statePath: tmpFile(),
    log: (m) => logs.push(m),
    sharedOverrideKeys: () => { throw new Error("shared config unreadable"); },
  });
  const snap = await svc.get();
  assert.equal("sharedOverrideKeys" in snap, false);
  assert.equal(logs.some((m) => m.includes("shared config unreadable")), true);
});