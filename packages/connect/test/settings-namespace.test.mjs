/**
 * The `dsh-connect` settings seam onto `SettingsForms`.
 *
 * Three properties are load-bearing here, and each is a test rather than a
 * comment because each has a failure mode that is invisible in the pane:
 *
 * 1. **`sectionOf` is the only guard on the document.** Both directions go
 *    through it — the snapshot the pane reads and the payload a save writes —
 *    and schemastery preserves undeclared keys, so anything it lets past
 *    reaches `settings.yaml`, a file users are invited to paste into bug
 *    reports.
 * 2. **`materializeConfig` must read a declared-but-unset leaf as *absent*.**
 *    Every volatile leaf resolves into the parsed config whether or not the
 *    profile set it, and the adapters resolve a channel as
 *    `{...channelDefaults, ...channel}` — so an explicit `undefined` for a
 *    channel's own `language` would mask the shared default it should inherit.
 * 3. **`installConnectSection` must never throw.** A host without the service, a
 *    context with no resolvable entry id, and a refused write all degrade to a
 *    warning line; a settings integration that cannot work must never be the
 *    reason a bridge fails to start.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { CHANNELS, readDotPath, secretConfigPath, writeDotPath } from "../lib/settings/channels.js";
import { CHANNEL_CONFIG_FIELDS, CHANNEL_DEFAULT_FIELDS, GENERAL_FIELDS, channelConfigPaths } from "../lib/settings/settings-model.js";
import { CHANNEL_SECRET_KEYS } from "../lib/settings/credential-store.js";
import {
  installConnectSection,
  materializeConfig,
  mergeSections,
  sectionOf,
} from "../lib/settings/namespace.js";

// --- fixtures ------------------------------------------------------------

/** The shared volatile-write symbol, exactly as the module sniffs it. */
const VOLATILE_WRITE = Symbol.for("cosmokit.volatile.write");

/**
 * One loader-managed leaf: an object carrying the shared volatile-write symbol,
 * whose `get()` is the current snapshot.
 *
 * Hand-rolled rather than taken from cosmokit on purpose — a symbol-keyed
 * object *is* the contract `isConfigRef` sniffs, and that is the point: the host
 * may hand us references built by its own copy of the library, so the symbol is
 * the only identifier guaranteed identical across copies.
 */
function slot(initial) {
  let value = initial;
  return {
    [VOLATILE_WRITE]: () => {},
    get: () => value,
    /** What the loader does when it commits a changed path. Test-only. */
    commit: (next) => {
      value = next;
    },
  };
}

/**
 * A config shaped the way the loader hands one to `apply()`: every field the
 * pane can edit is a volatile reference, the plugin's own config keys are plain,
 * and `commit(section)` replays what the loader does on a settings write —
 * reset every declared leaf to its inherited value, then apply the section. The
 * reset is why a section that omits a field is destructive, so replaying it is
 * what makes that observable here.
 *
 * The fields are derived from the same tables the schema is, so this cannot
 * drift from the real field set without a test failing.
 */
function volatileConfig(profile = {}) {
  // Mirrors the schema's `.default([...CHANNELS])`: a profile that never set
  // `channels` resolves to every built-in channel, not to an empty list.
  const config = { channels: slot(profile.channels ?? [...CHANNELS]) };
  const defaults = {};
  for (const field of CHANNEL_DEFAULT_FIELDS) defaults[field.key] = slot(profile.channelDefaults?.[field.key]);
  config.channelDefaults = defaults;
  // Placed by *path*, not by flat key: the loader declares `stream.url` as a
  // nested leaf, so a fixture that stuffed the dotted string into a flat key
  // would be a config `sectionOf` could not read — and every assertion about
  // those fields would pass by finding nothing.
  for (const name of CHANNELS) {
    const channel = {};
    for (const path of channelConfigPaths(name)) {
      writeDotPath(channel, path, slot(readDotPath(profile[name] ?? {}, path)));
    }
    config[name] = channel;
  }
  // The general settings, top-level and volatile like the real schema. Derived
  // from `GENERAL_FIELDS` for the same reason the channel blocks are derived
  // from their table: a field the fixture does not know about is a field whose
  // reset cannot be reproduced here.
  const general = {};
  for (const field of GENERAL_FIELDS) {
    general[field.key] = slot(profile[field.key]);
    config[field.key] = general[field.key];
  }
  // Keys the pane does not own: they ride along in the config and must not
  // appear in anything the seam sends or hands out.
  config.settingsStatePath = "state.json";
  config.appSecret = "profile-secret";

  const commit = (section) => {
    config.channels.commit(section.channels);
    for (const field of CHANNEL_DEFAULT_FIELDS) defaults[field.key].commit(section.channelDefaults?.[field.key]);
    for (const name of CHANNELS) {
      for (const path of channelConfigPaths(name)) {
        readDotPath(config[name], path).commit(readDotPath(section[name] ?? {}, path));
      }
    }
    // The real loader resets a declared-but-omitted leaf to its inherited
    // value; here that is `undefined`, which is what makes a partial section
    // observably destructive in the tests below.
    for (const field of GENERAL_FIELDS) general[field.key].commit(section[field.key]);
  };
  return { config, commit, general };
}

/** A settings service that behaves like `SettingsForms` in the ways this module depends on. */
function settingsFor(store, { failReplace } = {}) {
  const replaced = [];
  return {
    /** Every section handed to `replace()`, in call order. */
    replaced,
    async replace(ns, section) {
      if (failReplace !== undefined) throw new Error(failReplace);
      replaced.push({ ns, section });
      // The real provider resolves only after the document is committed, so a
      // read straight afterwards already sees the new value.
      store.commit(section);
    },
  };
}

/** Owner context stub: the seam only ever touches `logger.warn`. */
function owner() {
  const warnings = [];
  return { warnings, logger: { warn: (message) => warnings.push(message) } };
}

/**
 * Wire the seam and collect everything it reports.
 *
 * `ns: undefined` has to reach the module as an absent entry id, so the default
 * is applied by key presence rather than by a destructuring default — which
 * would silently turn the "no id resolvable" case back into a working one and
 * make that test assert the opposite of what it says.
 */
function settle(config, options = {}) {
  const who = options.owner ?? owner();
  const changes = [];
  const result = installConnectSection({
    owner: who,
    settings: options.settings,
    config,
    ns: "ns" in options ? options.ns : "connect",
    onChange: (section) => changes.push(section),
  });
  return { result, changes, owner: who };
}

// --- sectionOf: the projection that keeps secrets out ---------------------

test("sectionOf always emits channels, defaulting to every built-in channel", () => {
  assert.deepEqual(sectionOf({}), { channels: [...CHANNELS] });
  assert.deepEqual(sectionOf(undefined), { channels: [...CHANNELS] });
  assert.deepEqual(sectionOf({ channels: ["feishu"] }), { channels: ["feishu"] });
});

test("sectionOf projects secrets out of the base", () => {
  const section = sectionOf({
    channels: ["feishu", "telegram", "dingtalk"],
    feishu: { transport: "websocket", appId: "cli_real", appSecret: "s3cret" },
    telegram: { requireMention: true, botToken: "123:abc" },
    dingtalk: { language: "zh", webhookUrl: "https://oapi/x", secret: "sign", clientId: "cid", clientSecret: "cs" },
  });

  const text = JSON.stringify(section);
  for (const secret of ["s3cret", "cli_real", "123:abc", "oapi/x", "sign", "cid", "cs"]) {
    assert.ok(!text.includes(secret), `secret ${secret} leaked into the section`);
  }
  // The non-secret neighbours survive, so this is a projection and not a wipe.
  assert.deepEqual(section.feishu, { transport: "websocket" });
  assert.deepEqual(section.telegram, { requireMention: true });
  assert.deepEqual(section.dingtalk, { language: "zh" });
});

test("sectionOf drops undeclared keys entirely", () => {
  assert.deepEqual(sectionOf({ feishu: { nonsense: 1, transport: "webhook" } }).feishu, {
    transport: "webhook",
  });
  // A channel left with nothing declared is omitted rather than emitted empty.
  assert.equal(sectionOf({ feishu: { nonsense: 1 } }).feishu, undefined);
});

test("sectionOf projects channelDefaults onto the declared keys", () => {
  const section = sectionOf({ channelDefaults: { language: "en", rogue: "x" } });
  assert.deepEqual(section.channelDefaults, { language: "en" });
  assert.equal(sectionOf({ channelDefaults: { rogue: "x" } }).channelDefaults, undefined);
});

test("sectionOf drops the dead channelDefaults.notifyLevel, which no adapter ever read", () => {
  // Two directions, because only one of them is obvious. Dropping it on the way
  // *out* is what makes it disappear from an old user's profile on their next
  // save — `sectionOf` is the only projection, so the write path carries the
  // same answer. It must not reappear on the way in either: a hand-edited
  // settings document that still has it would otherwise be preserved verbatim
  // by schemastery's passthrough and keep resurrecting in every later save.
  assert.equal(sectionOf({ channelDefaults: { notifyLevel: "result" } }).channelDefaults, undefined);
  assert.equal(
    Object.prototype.hasOwnProperty.call(sectionOf({ channelDefaults: { language: "en", notifyLevel: "result" } }).channelDefaults, "notifyLevel"),
    false,
  );
  // ...and the top-level `notifyLevel`, which is the one that works, is a
  // different key and is unaffected by any of this.
  assert.equal(sectionOf({ notifyLevel: "result" }).notifyLevel, "result");
});

// --- sectionOf: the general keys (the reset hazard) -----------------------

test("sectionOf projects every general key", () => {
  // The table is the source of truth: asserting against it means a field added
  // to 通用设置 without the matching arm in `sectionOf` fails here rather than
  // silently resetting on the user's next unrelated save.
  const source = {
    language: "en",
    notifyLevel: "result",
    progressTimeoutMs: 60000,
    autoCompact: true,
    autoCompactThresholdPct: 80,
    workDir: "C:/code",
    workspaces: ["packages", "docs"],
    allowUsers: ["ou_1"],
    allowChats: ["oc_1"],
    agentPreset: "fast",
    autoMirror: true,
    streamHeartbeatMs: 2000,
  };
  assert.deepEqual(sectionOf(source), {
    channels: [...CHANNELS],
    language: "en",
    notifyLevel: "result",
    progressTimeoutMs: 60000,
    autoCompact: true,
    autoCompactThresholdPct: 80,
    workDir: "C:/code",
    workspaces: ["packages", "docs"],
    allowUsers: ["ou_1"],
    allowChats: ["oc_1"],
    agentPreset: "fast",
    autoMirror: true,
    streamHeartbeatMs: 2000,
  });
});

test("sectionOf skips an unset or emptied general key instead of stamping a default", () => {
  // Absent stays absent, and a cleared list becomes absent rather than `[]`.
  // Both matter for the same reason: a volatile array resolves an unset key to
  // `[]` on the way back in, so writing `workspaces: []` would be pure noise in
  // the profile — and "cleared" is supposed to mean "back to inherited".
  const section = sectionOf({ language: undefined, workspaces: [], allowUsers: ["", null, 3], allowChats: "not-an-array" });
  assert.equal("language" in section, false);
  assert.equal("workspaces" in section, false);
  assert.equal("allowUsers" in section, false);
  assert.equal("allowChats" in section, false);
});

test("sectionOf keeps a list's real entries and drops the blank ones", () => {
  const section = sectionOf({ workspaces: ["C:/code", "", "  ", "C:/other"] });
  assert.deepEqual(section.workspaces, ["C:/code", "C:/other"]);
});

test("sectionOf's general projection is what keeps a save from resetting them", () => {
  // The failure this pins, in one line: `enableFeishuConfig` does
  // `{ ...section, channels, feishu }`. A general key that `sectionOf` forgets
  // is therefore not merely missing from the snapshot — it is *erased* the next
  // time the user saves anything at all, including a save made on the channels
  // view for an unrelated reason. Feeding a fully-populated config through the
  // same projection the write path uses is the reproducible check.
  const store = volatileConfig({
    channels: ["feishu"],
    language: "en",
    notifyLevel: "important",
    progressTimeoutMs: 30000,
    autoCompact: true,
    autoCompactThresholdPct: 75,
    workDir: "C:/code",
    workspaces: ["packages"],
    allowUsers: ["ou_1"],
    allowChats: ["oc_1"],
    agentPreset: "fast",
    autoMirror: true,
    streamHeartbeatMs: 1500,
  });
  const projected = sectionOf(materializeConfig(store.config));
  for (const field of GENERAL_FIELDS) {
    assert.notEqual(projected[field.key], undefined, `${field.key} was dropped by sectionOf — the next save resets it`);
  }
});

test("sectionOf keeps an empty channel list — 'none' is a choice, not an omission", () => {
  assert.deepEqual(sectionOf({ channels: [] }).channels, []);
});

// --- the loss probe: a declared key must survive a save -------------------

/**
 * A profile with a value at *every* path each channel declares — the editable
 * fields and the preserved keys — so that 「改了却没存住」 has one reproducible
 * shape instead of being re-argued per field.
 */
function populatedProfile() {
  const profile = { channels: [...CHANNELS] };
  for (const name of CHANNELS) {
    const channel = {};
    for (const path of channelConfigPaths(name)) {
      // `defaultAt` is genuinely an object of arrays; a string would round-trip
      // just as well and prove considerably less.
      writeDotPath(
        channel,
        path,
        path === "defaultAt"
          ? { mobiles: ["13800000000"], userIds: ["manager1"], all: false }
          : `value:${name}.${path}`,
      );
    }
    profile[name] = channel;
  }
  return profile;
}

/** The given config with a credential planted at every declared secret path. */
function withCredentials(config) {
  for (const name of CHANNELS) {
    for (const key of Object.keys(CHANNEL_SECRET_KEYS[name])) {
      writeDotPath(config[name], secretConfigPath(name, key), `secret:${name}.${key}`);
    }
  }
  return config;
}

test("no declared channel key is lost on the write path — except the credentials", () => {
  // The failure this reproduces: `sectionOf` projects path by path and a save
  // replaces the whole declared section, so a `Config` key in no pane table is
  // silently deleted the next time the user saves *anything*. Derived from the
  // same tables the projection reads, so a field added to one side and not the
  // other fails here rather than in someone's profile.
  const store = volatileConfig(populatedProfile());
  const section = sectionOf(withCredentials(materializeConfig(store.config)));

  const missing = [];
  for (const name of CHANNELS) {
    for (const path of channelConfigPaths(name)) {
      if (readDotPath(section[name] ?? {}, path) === undefined) missing.push(`${name}.${path}`);
    }
  }
  assert.deepEqual(missing, [], "a save would delete these declared keys from the profile");

  // The credentials travel the other way — out of the section, never in — and
  // it is the same projection doing both, so the two checks belong together.
  const text = JSON.stringify(section);
  for (const name of CHANNELS) {
    for (const key of Object.keys(CHANNEL_SECRET_KEYS[name])) {
      assert.ok(!text.includes(`secret:${name}.${key}`), `${name}.${key} leaked into the section`);
    }
  }
});

test("a preserved key the pane never shows survives a save made for another reason", () => {
  // `defaultAt` used to be a `kind: 'text'` field, which rendered it as
  // `[object Object]` and wrote that string back over the object. It has no
  // control at all now, so this is the moment it is most at risk: the pane is
  // not even looking at it when it saves. Asserted on the *stored* value after
  // the write replays the loader's reset, not on the payload alone — the payload
  // is only half the path.
  const store = volatileConfig(populatedProfile());
  store.commit(sectionOf(materializeConfig(store.config)));

  const after = materializeConfig(store.config);
  assert.deepEqual(readDotPath(after.dingtalk, "defaultAt"), {
    mobiles: ["13800000000"],
    userIds: ["manager1"],
    all: false,
  });
  // ...and its neighbour on the same nested branch, which reaches the adapter
  // through a dotted path rather than a flat key.
  assert.equal(readDotPath(after.dingtalk, "stream.url"), "value:dingtalk.stream.url");
});

// --- materializeConfig: refs in, plain data out ---------------------------

test("materializeConfig resolves every reference to its current snapshot", () => {
  const { config } = volatileConfig({
    channels: ["feishu"],
    channelDefaults: { language: "en" },
    feishu: { transport: "websocket" },
  });
  assert.deepEqual(materializeConfig(config), {
    channels: ["feishu"],
    channelDefaults: { language: "en" },
    feishu: { transport: "websocket" },
    // A declared-but-unset *channel* materializes as an empty object rather
    // than as `undefined`: schemastery resolves an object schema's keys into
    // the result whether or not the data carried them, and the leaves inside
    // are then dropped as unset. Harmless everywhere it lands — the adapters
    // resolve a channel as `{...channelDefaults, ...overrides}`, where `{}` is
    // a no-op — so it is pinned rather than worked around.
    telegram: {},
    // The same rule one level down: `stream.url` and `stream.requireMention` are
    // both unset, so the branch they live in survives empty while its leaves go.
    // Also harmless — `readDotPath({stream:{}}, "stream.url")` is undefined, and
    // so is what the adapter reads — but it is the shape the loader really
    // produces, so it is pinned rather than papered over in the fixture.
    dingtalk: { stream: {} },
    web: {},
    settingsStatePath: "state.json",
    appSecret: "profile-secret",
  });
});

test("materializeConfig does not let an unset field mask the shared default", () => {
  // `language` is a key of the shared defaults *and* of every channel's own
  // fields, so this is the exact collision the adapters merge over:
  // `{...channelDefaults, ...channel}`. A declared-but-unset leaf that
  // materialized as `undefined` would take the shared value away from feishu
  // alone — a bug that shows up as "my language setting works everywhere except
  // one channel".
  const { config } = volatileConfig({ channels: ["feishu"], channelDefaults: { language: "en" } });
  const plain = materializeConfig(config);

  assert.equal("language" in plain.feishu, false, "an unset leaf must read as absent, not as undefined");
  assert.equal("requireMention" in plain.feishu, false);
  assert.equal("language" in plain.channelDefaults, true);
  assert.equal({ ...plain.channelDefaults, ...plain.feishu }.language, "en");
});

test("materializeConfig returns a fresh, mutable copy", () => {
  // Snapshots are deeply frozen (the loader commits them read-only), while
  // `ChannelRuntime` spreads a channel's config into a new object and the pane
  // holds one to edit — so handing out the snapshot itself would throw in
  // strict mode at the first write.
  const frozenArray = Object.freeze(["feishu"]);
  const frozenChannel = Object.freeze({ transport: "websocket" });
  const copy = materializeConfig({ channels: slot(frozenArray), feishu: slot(frozenChannel) });

  assert.doesNotThrow(() => copy.channels.push("web"));
  assert.doesNotThrow(() => {
    copy.feishu.transport = "webhook";
  });
  assert.deepEqual(copy.channels, ["feishu", "web"]);
  assert.equal(copy.feishu.transport, "webhook");
  assert.deepEqual([...frozenArray], ["feishu"]);
  assert.equal(frozenChannel.transport, "websocket");
});

test("materializeConfig tolerates a cycle", () => {
  // Ordinary config cannot contain a reference, but a hand-built one (or a test
  // double) can, and a walk that recursed forever would take the plugin load
  // down with a stack overflow.
  const cyclic = { channels: slot(["feishu"]) };
  cyclic.self = cyclic;
  const copy = materializeConfig(cyclic);
  assert.equal(copy.self, copy);
  assert.deepEqual(copy.channels, ["feishu"]);
});

test("materializeConfig leaves undeclared keys to sectionOf", () => {
  // Not a wish, a property: everything in the parsed config survives
  // materialization verbatim, secrets included. `sectionOf` is the only thing
  // standing between a profile's `appSecret` and the settings document.
  const { config } = volatileConfig({ channels: ["feishu"] });
  assert.equal(materializeConfig(config).appSecret, "profile-secret");
});

// --- mergeSections: the reset-safe write ---------------------------------

test("mergeSections keeps the base's channel list when the override omits it", () => {
  // The migration's whole safety argument: `replace()` resets what a section
  // omits, so a legacy import carrying only per-channel keys must not drop
  // `channels` — that is how a migration switches every adapter off.
  assert.deepEqual(mergeSections({ channels: ["feishu"] }, { feishu: { transport: "webhook" } }), {
    channels: ["feishu"],
    feishu: { transport: "webhook" },
  });
});

test("mergeSections layers per-channel keys with the override winning", () => {
  const merged = mergeSections(
    { channels: ["feishu"], feishu: { transport: "websocket", webhookPort: 8080 }, web: { pollIntervalMs: 1000 } },
    { channels: ["web"], feishu: { transport: "webhook" } },
  );
  assert.deepEqual(merged, {
    channels: ["web"],
    feishu: { transport: "webhook", webhookPort: 8080 },
    web: { pollIntervalMs: 1000 },
  });
});

test("mergeSections omits a channel neither side mentions", () => {
  assert.deepEqual(mergeSections({ channels: ["feishu"] }, {}), { channels: ["feishu"] });
});

test("mergeSections keeps the base's general keys when the override omits them", () => {
  // The most important new assertion of this batch. `mergeSections` rebuilds
  // the section key by key, and the only caller (`legacy-import.ts`) writes
  // `mergeSections(current, legacy)` — so a general key the merge does not
  // explicitly mention is silently *erased* by an import that was supposed to
  // preserve it. A rebuild-from-nothing implementation passes every other test
  // in this file and fails this one.
  const base = {
    channels: ["feishu"],
    language: "en",
    notifyLevel: "important",
    progressTimeoutMs: 30000,
    workDir: "C:/code",
    workspaces: ["packages"],
    allowUsers: ["ou_1"],
    allowChats: ["oc_1"],
    agentPreset: "fast",
    autoMirror: true,
    streamHeartbeatMs: 1500,
  };
  const merged = mergeSections(base, { feishu: { transport: "webhook" } });

  for (const field of GENERAL_FIELDS) {
    assert.deepEqual(merged[field.key], base[field.key], `${field.key} was dropped by mergeSections`);
  }
  assert.deepEqual(merged.feishu, { transport: "webhook" });
  assert.deepEqual(merged.channels, ["feishu"]);
});

test("mergeSections lets the override's general keys win", () => {
  const merged = mergeSections(
    { channels: ["feishu"], language: "en", allowUsers: ["ou_1"] },
    { language: "zh", notifyLevel: "result" },
  );
  assert.equal(merged.language, "zh");
  assert.deepEqual(merged.allowUsers, ["ou_1"]);
  assert.equal(merged.notifyLevel, "result");
});

// --- installConnectSection ------------------------------------------------

test("no settings service: the plugin config stands alone", () => {
  const store = volatileConfig({ channels: ["feishu"], feishu: { transport: "websocket" } });
  const { result, changes, owner: who } = settle(store.config);

  assert.equal(result.live, false);
  assert.equal(result.handle, undefined);
  assert.deepEqual(result.section, { channels: ["feishu"], feishu: { transport: "websocket" } });
  assert.deepEqual(changes, [result.section]);
  // A bare host is the normal case, not a misconfiguration: no line.
  assert.deepEqual(who.warnings, []);
});

test("a profile that never set channels resolves to every built-in channel", () => {
  // The regression this pins: declared as a volatile array *without* a default,
  // an absent `channels` resolves to `[]` rather than to nothing at all, which
  // reads as "activate no adapter" — where the documented default, and the
  // behaviour before the fields became volatile, is every channel.
  const store = volatileConfig({ feishu: { transport: "websocket" } });
  const { result } = settle(store.config, { settings: settingsFor(store) });
  assert.deepEqual(result.section.channels, [...CHANNELS]);

  const { config, commit } = volatileConfig({ feishu: { transport: "websocket" } });
  assert.equal(config.channels.get().length, CHANNELS.length);
  // And it stays a real choice once the loader commits one.
  commit({ channels: ["web"] });
  assert.deepEqual(config.channels.get(), ["web"]);
});

test("settings present but no resolvable entry id: read-only, with the remedy logged", () => {
  const store = volatileConfig({ channels: ["feishu"] });
  const { result, changes, owner: who } = settle(store.config, { settings: settingsFor(store), ns: undefined });

  assert.equal(result.live, false);
  assert.equal(result.handle, undefined);
  assert.deepEqual(changes, [result.section]);
  assert.equal(who.warnings.length, 1);
  assert.match(who.warnings[0], /^connect: .*profile entry id could not be resolved/);
  assert.match(who.warnings[0], /state file/);
});

test("a settings service that cannot write is read-only, silently", () => {
  const store = volatileConfig({ channels: ["feishu"] });
  const { result, owner: who } = settle(store.config, { settings: {} });

  // `live` means "a save can land", so a provider with no write path is false —
  // and the pane's own wording falls back to the state file, which is where the
  // settings service sends the save.
  assert.equal(result.live, false);
  assert.equal(result.handle, undefined);
  assert.deepEqual(who.warnings, []);
});

test("a live install hands back a handle over the same references", () => {
  const store = volatileConfig({ channels: ["feishu"], feishu: { transport: "websocket" } });
  const { result } = settle(store.config, { settings: settingsFor(store) });

  assert.equal(result.live, true);
  assert.ok(result.handle, "the live path must expose a write handle");
  assert.deepEqual(result.handle.read(), result.section);

  // A handle reads the references, not a copy of the install-time value, so an
  // edit by any writer is visible without re-running `apply` — that is the whole
  // reason the seam is built on volatile refs.
  store.commit({ channels: ["feishu", "web"] });
  assert.deepEqual(result.handle.read(), { channels: ["feishu", "web"] });
});

test("handle.write sends the projected payload and reconciles the running config", async () => {
  const store = volatileConfig({ channels: ["feishu"], feishu: { transport: "websocket" } });
  const settings = settingsFor(store);
  const { result, changes } = settle(store.config, { settings });

  await result.handle.write({
    channels: ["feishu"],
    feishu: { transport: "webhook", appSecret: "smuggled", nonsense: 1 },
    settingsStatePath: "elsewhere.json",
    rogue: "x",
  });

  assert.equal(settings.replaced.length, 1);
  assert.equal(settings.replaced[0].ns, "connect", "the namespace is the profile entry id, not the package name");
  assert.deepEqual(settings.replaced[0].section, { channels: ["feishu"], feishu: { transport: "webhook" } });
  assert.ok(!JSON.stringify(settings.replaced).includes("smuggled"));
  // The file-only key belongs to the fallback store; it must not be persisted
  // into the profile entry alongside the pane's fields.
  assert.equal(settings.replaced[0].section.settingsStatePath, undefined);

  // The loader committed the values into the references, so the reconcile that
  // follows a write sees the new section — this is what makes a save take effect
  // without a remount.
  assert.equal(changes.length, 2);
  assert.deepEqual(changes[1], { channels: ["feishu"], feishu: { transport: "webhook" } });
  assert.deepEqual(result.handle.read(), changes[1]);
});

test("handle.write accepts a ref-carrying config instead of reading it as 'no channels'", async () => {
  // A caller that passes this plugin's own config (refs and all) must not be
  // silently reinterpreted: `sectionOf` would see `channels` as a reference
  // rather than an array, read it as absent, and project *every* channel —
  // turning an unrelated save into "enable all adapters".
  const store = volatileConfig({ channels: ["feishu"] });
  const settings = settingsFor(store);
  const { result } = settle(store.config, { settings });

  const fresh = volatileConfig({ channels: ["web"], web: { pollIntervalMs: 1000 } });
  await result.handle.write(fresh.config);

  assert.deepEqual(settings.replaced[0].section, { channels: ["web"], web: { pollIntervalMs: 1000 } });
});

test("handle.write with nothing to say falls back to every built-in channel", async () => {
  const store = volatileConfig({ channels: ["feishu"] });
  const settings = settingsFor(store);
  const { result } = settle(store.config, { settings });

  await result.handle.write({});
  assert.deepEqual(settings.replaced[0].section, { channels: [...CHANNELS] });
});

test("a refused write propagates and changes nothing", async () => {
  const store = volatileConfig({ channels: ["feishu"] });
  const settings = settingsFor(store, { failReplace: "ValidationError: feishu.transport" });
  const { result, changes } = settle(store.config, { settings });

  await assert.rejects(() => result.handle.write({ feishu: { transport: "pigeon" } }), /ValidationError/);
  assert.deepEqual(settings.replaced, []);
  // No reconcile either: the running adapters must keep the config that is
  // actually in force.
  assert.equal(changes.length, 1);
});

test("the handle reads the section in force even before any write", () => {
  const store = volatileConfig({ channels: ["telegram"] });
  const { result } = settle(store.config, { settings: settingsFor(store) });
  assert.deepEqual(result.section, { channels: ["telegram"] });
});

test("install never throws, even with a bare owner and a hostile service", () => {
  assert.doesNotThrow(() =>
    installConnectSection({
      owner: {},
      settings: { replace: () => Promise.reject(new Error("boom")) },
      config: undefined,
      ns: undefined,
      onChange: () => {},
    }),
  );
});
