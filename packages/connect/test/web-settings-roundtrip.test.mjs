import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fsN from "node:fs";

import { loadSettings, saveSettings, saveCredentials } from "../lib/settings/rpc-client.js";
import { createSettingsRpcHandler } from "../lib/settings/settings-rpc.js";
import { createSettingsService } from "../lib/settings/settings-service.js";
import { createCredentialStore } from "../lib/settings/credential-store.js";
import { injectSecrets, readDotPath, writeDotPath, CHANNELS } from "../lib/settings/channels.js";
import { createFeishuOnboarding, enableFeishuConfig } from "../lib/settings/feishu-onboarding.js";
import { sectionOf, materializeConfig, installConnectSection } from "../lib/settings/namespace.js";
import {
  CHANNEL_CONFIG_FIELDS,
  CHANNEL_DEFAULT_FIELDS,
  CHANNEL_PRESERVED_KEYS,
  GENERAL_FIELDS,
  buildConfigSave,
  snapshotToForm,
} from "../lib/settings/settings-model.js";

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

// --- the general settings, over the wire -----------------------------------
//
// The general keys travel as top-level siblings of `channels`, through the same
// two endpoints as everything else. The interesting part is not the trip out —
// it is what happens to them on the way back in, which is the next test.

/** All twelve, one of every kind: two selects, four scalars, three lists, two booleans. */
const GENERAL_SAVE = {
  language: "en",
  notifyLevel: "result",
  progressTimeoutMs: 45000,
  autoCompact: true,
  autoCompactThresholdPct: 80,
  workDir: "C:/code/example",
  workspaces: ["packages", "docs"],
  allowUsers: ["ou_first", "ou_second"],
  allowChats: ["oc_first"],
  agentPreset: "dsh-connect",
  autoMirror: true,
  streamHeartbeatMs: 1200,
};

test("every general key survives save -> get, unchanged and in one piece", async () => {
  const { rpcCall } = makeHostBackend();
  await saveSettings(rpcCall, { channels: ["feishu"], ...GENERAL_SAVE });
  const snap = await loadSettings(rpcCall);
  for (const [key, value] of Object.entries(GENERAL_SAVE)) {
    assert.deepEqual(snap.config[key], value, `${key} did not survive the round trip`);
  }
  // Asserted against the field table as well as the fixture, so a key added to
  // `GENERAL_FIELDS` without being added here fails instead of going untested.
  assert.deepEqual(
    GENERAL_FIELDS.map((f) => f.key).filter((k) => !(k in GENERAL_SAVE)),
    [],
    "a general field is missing from the round-trip fixture",
  );
});

test("what the client builds is what the wire carries, emptied list and all", async () => {
  // The two halves of the save, joined: the client decides the payload's shape
  // (`buildConfigSave`, fed by controls that already coerced their own input)
  // and the host stores it as given — this plane is deliberately a loose merge
  // store rather than the declared schema, so a key the client does not send is
  // absent and nothing conjures it back.
  //
  // The emptied box is the case worth naming. `workspaces: []` and an absent
  // `workspaces` mean the same thing to the config resolver, so the pane drops
  // the key instead of writing the empty array — and it has to be the pane that
  // does it, here, because this is the last point at which the two are still
  // distinguishable.
  const { rpcCall } = makeHostBackend();
  const form = {
    channels: ["feishu"],
    channelDefaults: {},
    channelConfigs: {},
    general: { ...GENERAL_SAVE, workspaces: [] },
    secrets: {},
  };
  const payload = buildConfigSave(form);
  assert.equal("workspaces" in payload, false, "an emptied list must not reach the wire at all");

  await saveSettings(rpcCall, payload);
  const snap = await loadSettings(rpcCall);
  assert.equal("workspaces" in snap.config, false);
  for (const [key, value] of Object.entries(GENERAL_SAVE)) {
    if (key === "workspaces") continue;
    assert.deepEqual(snap.config[key], value, `${key} did not survive the round trip`);
  }
});

// --- the reset risk --------------------------------------------------------
//
// The one failure this batch was most likely to ship, as a test.
//
// The pane writes a *section*, and `SettingsForms.replace()` resolves every
// field it is not handed back to its inherited value — so a key missing from
// the payload is not "unchanged", it is a reset. The one-click button happens
// to be the sharpest edge of that: it reads the live config, projects it, and
// writes the whole thing back (`enableFeishuConfig` is a whole-section spread,
// `return { ...section, channels, feishu }`). Every general key it fails to
// carry is silently wiped by pressing a button that has nothing to do with them.
//
// `sectionOf` is therefore the load-bearing projection, and this test is the
// reproducible evidence: all ten keys in, all ten keys out, through the exact
// sequence `index.ts` uses.

test("the one-click enable write carries every general key through, none reset", async () => {
  const { rpcCall } = makeHostBackend();
  // Something on both planes already: a general value and a channel config the
  // enable write must also preserve.
  await saveSettings(rpcCall, { channels: ["telegram"], telegram: { requireMention: true }, ...GENERAL_SAVE });
  const before = await loadSettings(rpcCall);

  // index.ts: `sectionOf(materializeConfig(rawConfig))` -> `enableFeishuConfig(...)`.
  const payload = enableFeishuConfig(sectionOf(materializeConfig(before.config)), CHANNELS);

  // The payload itself, first — the assertion that names the actual risk.
  for (const key of Object.keys(GENERAL_SAVE)) {
    assert.ok(key in payload, `the enable payload dropped ${key} — the next save resets it`);
  }
  assert.deepEqual(payload.workspaces, ["packages", "docs"]);

  await saveSettings(rpcCall, payload);
  const after = await loadSettings(rpcCall);
  for (const [key, value] of Object.entries(GENERAL_SAVE)) {
    assert.deepEqual(after.config[key], value, `${key} was reset by the enable write`);
  }
  // ...and it still did its own job.
  assert.deepEqual(after.enabled, ["telegram", "feishu"]);
  assert.equal(after.config.feishu.transport, "websocket");
  assert.equal(after.config.telegram.requireMention, true);
});

// --- the one-click run, over the wire --------------------------------------
//
// Everything above proves the pane can write what a user typed. This proves the
// other direction: a run the *host* performs, reported back to a pane that only
// ever sees RPC replies. The interesting assertions are all about the boundary —
// what crosses it (an app id, a masked preview) and what must never cross it
// (the secret itself).

/** A promise whose settlement this test controls — the device-authorization flow. */
function gate() {
  let open;
  const promise = new Promise((resolve) => { open = resolve; });
  return { promise, open };
}

const LINK_URL = "https://open.feishu.cn/page/launcher?user_code=WXYZ-1234&from=dsh";
const LIVE_SECRET = "live-app-secret-value-0f9a8b7c6d5e4f3a";

/**
 * A host backend with the registry wired the way `apply()` wires it: the
 * service is built first and handed a *getter*, because the registry's enable
 * step writes through that same service.
 */
function makeOnboardingBackend(opts = {}) {
  const provider = fakeProvider();
  const store = createCredentialStore(provider);
  const created = { appId: "cli_live_1", appSecret: LIVE_SECRET };
  const linkGate = gate();
  const calls = { onboard: 0, legacy: [], subscription: 0, enable: 0, reconcile: 0 };

  let service;
  let registry;
  const onboard = async (_logger, _language, hooks) => {
    calls.onboard += 1;
    // What the SDK does before it starts polling: the link is available up
    // front, and the returned promise settles only once the user has scanned.
    hooks.onQRCodeReady({ url: LINK_URL, expireIn: 600 });
    return await linkGate.promise;
  };
  registry = createFeishuOnboarding({
    onboard,
    credentialStore: store,
    legacySave: (creds) => { calls.legacy.push(creds); return true; },
    applySubscription: async () => { calls.subscription += 1; return { status: "applied" }; },
    requestEnable: async () => {
      calls.enable += 1;
      // The same complete-section write a pane save performs — read what is in
      // force, add this channel, write the whole thing back.
      await service.save(enableFeishuConfig((await service.get()).config, CHANNELS));
    },
    reconcile: async () => { calls.reconcile += 1; if (opts.reconcileFails) throw new Error("the adapter refused to start"); },
    language: "zh",
  });
  service = createSettingsService({
    statePath: tmpFile(),
    credentialStore: store,
    // The runtime's failure map, read into every snapshot. It belongs to the
    // *service*, not the registry: reconcile only says the re-apply was refused,
    // and the reason a channel is down is the adapter's own words.
    ...(opts.channelFailures === undefined ? {} : { channelFailures: opts.channelFailures }),
    // A getter, not the registry — the host's ordering, and the reason
    // `requireOnboarding` reads it per call.
    onboarding: () => registry,
  });
  const handler = createSettingsRpcHandler(service);
  const rpcCall = (endpoint, payload, signal) => handler(endpoint, payload, signal);
  return { provider, store, service, registry, rpcCall, calls, created, linkGate };
}

/** Wait for the fire-and-forget flow to latch a terminal phase. */
async function settle(registry) {
  for (let i = 0; i < 200; i += 1) {
    const state = await registry.status();
    if (state.phase !== "waiting") return state;
    await new Promise((resolve) => { setTimeout(resolve, 0); });
  }
  throw new Error("the onboarding flow never reached a terminal phase");
}

test("one-click run: the link arrives before the result, and the outcome reaches the pane", async () => {
  const { rpcCall, registry, store, calls, created, linkGate } = makeOnboardingBackend();
  const replies = [];

  // Something is already in force, so "the complete declared section goes back"
  // becomes an assertion with teeth: a fragment would drop `telegram`, and the
  // hand-written transport with it, the moment the user clicks the button.
  await saveSettings(rpcCall, { channels: ["telegram"], feishu: { transport: "webhook" } });

  // `start` answers with a link, not with a result. `ok: true` here means "the
  // flow is running" — the whole reason this is two endpoints and not one.
  const started = await rpcCall("onboarding.start", { channel: "feishu" }, undefined);
  replies.push(started);
  assert.equal(started.ok, true);
  assert.equal(started.value.phase, "waiting");
  assert.equal(started.value.link.url, LINK_URL);
  assert.equal(started.value.link.expiresInSeconds, 600);
  assert.equal(started.value.outcome, undefined, "a link is not an outcome");

  // A pane that reloads mid-run polls and gets the same link back, unburnt.
  const poll = await rpcCall("onboarding.status", {}, undefined);
  replies.push(poll);
  assert.equal(poll.value.phase, "waiting");
  assert.equal(poll.value.link.url, LINK_URL);
  assert.equal(calls.onboard, 1, "a second start would have opened a second link");

  // The user scans; the SDK resolves with the app it created.
  linkGate.open(created);
  const done = await settle(registry);
  replies.push(done);
  assert.equal(done.phase, "done");
  assert.equal(done.outcome.created, true);
  assert.equal(done.outcome.appId, "cli_live_1");
  assert.equal(done.outcome.credentialsStored, true, "the secret did not reach the credential store");
  assert.equal(done.outcome.legacyMirrorWritten, true);
  assert.equal(done.outcome.subscription.status, "applied");
  assert.equal(done.outcome.enableRequested, true);
  assert.equal(done.outcome.applied, "yes");
  // A terminal phase retires the link: it is spent, and the pane renders one on
  // presence alone, so leaving it in would invite a scan of a dead URL.
  assert.equal(done.link, undefined);
  assert.deepEqual(calls.legacy, [created], "the legacy mirror was not written with what the SDK returned");

  // What the pane sees next. The enabled list is the proof the enable write was
  // a complete section that *added* this channel: a fragment there would have
  // deleted `telegram`, and a write that skipped the transport would leave the
  // webhook mode the app the flow just created cannot speak.
  const snap = await loadSettings(rpcCall);
  replies.push(snap);
  assert.deepEqual(snap.enabled, ["telegram", "feishu"]);
  assert.equal(snap.config.feishu.transport, "websocket");
  assert.equal(snap.credentials.feishu, true);
  assert.equal(snap.secrets.feishu.appId, true);
  assert.equal(snap.secrets.feishu.appSecret, true);
  assert.equal(snap.channelErrors?.feishu, undefined, "a clean run reported a channel failure");
  assert.deepEqual(calls.reconcile, 1, "the running adapter was not asked to pick the new credentials up");

  // The secret went in and did not come out. The only thing the pane can show is
  // the host's masked preview, which is derived from the stored value and must
  // not be it — nor contain it.
  const preview = snap.secretPreviews.feishu.appSecret;
  assert.equal(typeof preview, "string");
  assert.notEqual(preview, LIVE_SECRET);
  assert.equal(preview.includes(LIVE_SECRET), false, "the preview contains the secret it is supposed to mask");
  for (const reply of replies) {
    assert.equal(JSON.stringify(reply).includes(LIVE_SECRET), false, `a secret crossed the wire: ${JSON.stringify(reply)}`);
  }

  // And the last word: the credentials land where the adapter reads them, which
  // is what makes the bot answerable the moment this finishes. `injectSecrets`
  // returns the whole section — the config fields the enable write pinned with
  // the secrets the flow stored beside them.
  const enriched = await injectSecrets(snap.config, CHANNELS, (n) => store.get(n));
  assert.deepEqual({ appId: enriched.feishu.appId, appSecret: enriched.feishu.appSecret }, created);
  assert.equal(enriched.feishu.transport, "websocket");
});

test("a run whose credentials landed but whose adapter did not reports both halves", async () => {
  // 已落盘 ≠ 已生效, over the wire. The secret is in the store — a restart would
  // pick it up — and the channel that was supposed to adopt it right now failed.
  // One 「已保存」 here is the clean-success lie the outcome type exists to stop.
  const { rpcCall, registry, linkGate, created } = makeOnboardingBackend({
    reconcileFails: true,
    channelFailures: () => ({ feishu: "Error: app id is empty" }),
  });

  await rpcCall("onboarding.start", { channel: "feishu" }, undefined);
  linkGate.open(created);
  const done = await settle(registry);

  assert.equal(done.outcome.credentialsStored, true, "half one: the secret is on disk");
  assert.equal(done.outcome.enableRequested, true);
  assert.equal(done.outcome.applied, "no", "half two: the running channel never picked it up");
  // The reason lives in the snapshot, not in the outcome — the host keeps it out
  // of the outcome on purpose, so this read is the only place it can be found.
  const snap = await loadSettings(rpcCall);
  assert.equal(snap.credentials.feishu, true);
  assert.equal(snap.channelErrors.feishu, "Error: app id is empty");
});

// --- every declared field, round-tripped on both planes --------------------
//
// 「配置的值也需要能正确保存，显示」 as a mechanical claim rather than a spot
// check. One row per declared field, driven from the field tables themselves, so
// a key added to `GENERAL_FIELDS` / `CHANNEL_CONFIG_FIELDS` is covered the
// moment it is declared — and a key the pane can render but not store fails
// here instead of in someone's profile.
//
// Run on both planes on purpose. They do not have the same write semantics: the
// JSON fallback *merges* (`{ ...readConfig(), ...config }`, so an omitted key
// survives by accident), while the namespace plane *replaces* (so an omitted
// declared key is reset to its inherited value). A round trip that passes on
// the loose plane can still fail on the live one, which is the plane every
// real install uses.

/** A value of the right shape for a field, distinct per key where the type allows. */
function sampleFor(field) {
  if (field.kind === "select") return field.options?.[0] ?? "sample";
  if (field.kind === "number") return 4321;
  if (field.kind === "boolean") return true;
  if (field.kind === "list") return ["alpha", "beta"];
  return `sample-value:${field.key}`;
}

/** The namespace plane: a `replace()` that commits a section, and a service over it. */
function makeLiveBackend() {
  const provider = fakeProvider();
  const store = createCredentialStore(provider);
  // The section store the host owns. `replace()` resets and reapplies, which is
  // the semantics that made the dropped-key bug destructive — a fake that only
  // merged would not be able to reproduce it.
  const doc = { channels: [...CHANNELS] };
  const settings = {
    async replace(_ns, section) {
      for (const key of Object.keys(doc)) delete doc[key];
      Object.assign(doc, section);
    },
  };
  const installed = installConnectSection({
    owner: { logger: { warn() {} } },
    settings,
    config: doc,
    ns: "connect",
    onChange: () => {},
  });
  assert.equal(installed.live, true, "the live plane did not wire up");
  const service = createSettingsService({
    statePath: tmpFile(),
    credentialStore: store,
    live: () => installed.handle,
  });
  const handler = createSettingsRpcHandler(service);
  return { provider, store, rpcCall: (endpoint, payload, signal) => handler(endpoint, payload, signal) };
}

const PLANES = [
  { name: "json fallback", make: makeHostBackend },
  { name: "settings namespace", make: makeLiveBackend },
];

for (const plane of PLANES) {
  test(`${plane.name}: every general key survives display -> edit -> save -> reload, twice`, async () => {
    const { rpcCall } = plane.make();
    for (const pass of [1, 2]) {
      // Built from the snapshot each time, so the second pass also proves the
      // value comes back *into the control* — a save that stores a field the
      // pane cannot then display is only half the round trip.
      const form = snapshotToForm(await loadSettings(rpcCall));
      for (const field of GENERAL_FIELDS) form.general[field.key] = sampleFor(field);

      await saveSettings(rpcCall, buildConfigSave(form));
      const after = await loadSettings(rpcCall);

      for (const field of GENERAL_FIELDS) {
        assert.deepEqual(
          after.config[field.key],
          sampleFor(field),
          `${field.key} did not survive round trip ${pass} on the ${plane.name} plane`,
        );
      }
    }
  });

  test(`${plane.name}: every channel config field survives display -> edit -> save -> reload, twice`, async () => {
    const { rpcCall } = plane.make();
    for (const pass of [1, 2]) {
      const form = snapshotToForm(await loadSettings(rpcCall));
      for (const [channel, fields] of Object.entries(CHANNEL_CONFIG_FIELDS)) {
        for (const field of fields) form.channelConfigs[channel][field.key] = sampleFor(field);
      }

      await saveSettings(rpcCall, buildConfigSave(form));
      const after = await loadSettings(rpcCall);

      for (const [channel, fields] of Object.entries(CHANNEL_CONFIG_FIELDS)) {
        for (const field of fields) {
          // Read by *path*: `stream.url` has to come back out of `{ stream: {
          // url } }`, and a flat read of the snapshot would find nothing and
          // call the field absent instead of misplaced.
          assert.deepEqual(
            readDotPath(after.config[channel] ?? {}, field.key),
            sampleFor(field),
            `${channel}.${field.key} did not survive round trip ${pass} on the ${plane.name} plane`,
          );
        }
      }
    }
  });

  test(`${plane.name}: the channel defaults survive the same trip`, async () => {
    // The defaults tab is a third editable surface with its own projection
    // (`sectionOf` writes it through `CHANNEL_DEFAULT_FIELDS`), and it is the one
    // a user reaches for first — 「回复的简略程度」 lives here.
    const { rpcCall } = plane.make();
    const form = snapshotToForm(await loadSettings(rpcCall));
    for (const field of CHANNEL_DEFAULT_FIELDS) form.channelDefaults[field.key] = sampleFor(field);

    await saveSettings(rpcCall, buildConfigSave(form));
    const after = await loadSettings(rpcCall);

    for (const field of CHANNEL_DEFAULT_FIELDS) {
      assert.deepEqual(
        (after.config.channelDefaults ?? {})[field.key],
        sampleFor(field),
        `channelDefaults.${field.key} did not survive the round trip on the ${plane.name} plane`,
      );
    }
  });

  test(`${plane.name}: a key the pane has no control for is carried through, not rewritten`, async () => {
    // `defaultAt` is an object of arrays with no control in the pane, and it used
    // to be declared `kind: 'text'` — which rendered `[object Object]` and wrote
    // that string back over the object on the next save. It is now a *preserved*
    // path: invisible in the UI, copied verbatim on the way through.
    const DEFAULT_AT = { mobiles: ["13800000000"], userIds: ["manager1"], all: false };
    const { rpcCall } = plane.make();
    await saveSettings(rpcCall, {
      channels: ["dingtalk"],
      dingtalk: { stream: { url: "https://oapi.dingtalk.com/robot/send" }, defaultAt: DEFAULT_AT },
    });

    const form = snapshotToForm(await loadSettings(rpcCall));
    // The display half: what the pane holds is the object, not its `String()`.
    assert.deepEqual(form.channelConfigs.dingtalk.defaultAt, DEFAULT_AT);
    assert.deepEqual(form.channelConfigs.dingtalk["stream.url"], "https://oapi.dingtalk.com/robot/send");

    // An edit that has nothing to do with dingtalk — the save that used to lose
    // these keys by not mentioning them.
    form.general.language = "en";
    await saveSettings(rpcCall, buildConfigSave(form));

    const after = await loadSettings(rpcCall);
    const stored = after.config.dingtalk ?? {};
    assert.deepEqual(readDotPath(stored, "defaultAt"), DEFAULT_AT, "the preserved object was not carried through");
    assert.equal(typeof readDotPath(stored, "defaultAt"), "object");
    assert.equal(readDotPath(stored, "stream.url"), "https://oapi.dingtalk.com/robot/send");
  });

  test(`${plane.name}: every preserved path is carried through generically`, async () => {
    // Derived from `CHANNEL_PRESERVED_KEYS` rather than from the one entry that
    // exists today, so a second preserved key is covered as soon as it is
    // declared — including the `null`/`undefined` rule, which is what keeps a
    // preserved-but-unset path from being stamped into the profile.
    const { rpcCall } = plane.make();
    const seedConfig = {};
    const seeded = [];
    for (const [channel, paths] of Object.entries(CHANNEL_PRESERVED_KEYS)) {
      for (const path of paths) {
        // An object either way, because the only shapes a preserved path can
        // have are ones the pane has no control for.
        const value = path === "defaultAt" ? { all: true } : { kept: path };
        seedConfig[channel] ??= {};
        writeDotPath(seedConfig[channel], path, value);
        seeded.push({ channel, path, value });
      }
    }
    assert.ok(seeded.length > 0, "CHANNEL_PRESERVED_KEYS is empty — this test would prove nothing");

    await saveSettings(rpcCall, { ...seedConfig, channels: [...CHANNELS] });
    const form = snapshotToForm(await loadSettings(rpcCall));
    form.general.language = "en";
    await saveSettings(rpcCall, buildConfigSave(form));

    const after = await loadSettings(rpcCall);
    for (const { channel, path, value } of seeded) {
      assert.deepEqual(
        readDotPath(after.config[channel] ?? {}, path),
        value,
        `${channel}.${path} is declared preserved but did not survive a save`,
      );
    }
  });
}
