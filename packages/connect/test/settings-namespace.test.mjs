/**
 * The `dsh-connect` settings namespace.
 *
 * Two things are worth pinning here. First, `sectionOf` is the *only* thing
 * keeping secrets out of the settings document — schemastery preserves
 * undeclared keys, so anything left in the base rides out through `describe()`
 * and the settings RPC. Second, `installConnectSection` must never throw: a
 * hand-edited `settings.yaml` with a typo, or a namespace claimed by an earlier
 * fiber, has to degrade to the plugin config rather than abort the plugin's
 * `apply` (which would take the whole bridge down).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { CHANNELS } from "../lib/settings/channels.js";
import {
  CONNECT_SETTINGS_NS,
  ConnectSectionSchema,
  installConnectSection,
  sectionOf,
} from "../lib/settings/namespace.js";

/**
 * A settings service that behaves like the real one in the ways this module
 * depends on: it validates the layered value with the *actual* schema it was
 * handed, and it fires `onChange` again on later edits via the `setSource`
 * thunk it was given.
 */
function fakeSettings({ user = {}, failInstall, failReplace } = {}) {
  const calls = [];
  const fake = {
    /** Sections the fake service holds for our namespace, keyed by ns. */
    user,
    /** Set to a message to make `installSection` throw. */
    failInstall,
    /** Set to a message to make `replace` reject (a schema violation on write). */
    failReplace,
    /** Last `entry` (the base layer) passed in — asserted to hold no secrets. */
    entry: undefined,
    /** A resolved value to hand back from `get()`, mimicking an earlier fiber. */
    registered: undefined,
    /** Every section handed to `replace()`, in call order. */
    replaced: [],
    /** Simulate the provider pushing a change (the file watcher's debounce). */
    notify() {
      calls[calls.length - 1]();
    },
    installSection(owner, ns, schema, entry, hooks) {
      if (fake.failInstall !== undefined) throw new Error(fake.failInstall);
      fake.entry = entry;
      hooks.setSource(() => schema({ ...entry, ...(user[ns] ?? {}) }));
      hooks.onChange();
      calls.push(() => hooks.onChange());
    },
    get(ns) {
      return ns === CONNECT_SETTINGS_NS ? fake.registered : undefined;
    },
    /**
     * The provider's write path. The real one resolves after the document is
     * committed, so a read straight afterwards already sees the new value —
     * mirrored here by storing into `user` before the promise settles.
     */
    async replace(ns, section, expectedRevision) {
      if (fake.failReplace !== undefined) throw new Error(fake.failReplace);
      fake.replaced.push({ ns, section, expectedRevision });
      user[ns] = section;
    },
  };
  return fake;
}

/** The same service, minus the write path — an older provider. */
function readOnlySettings() {
  const fake = fakeSettings();
  delete fake.replace;
  return fake;
}

/** Owner context stub: `installConnectSection` only touches `logger.warn`. */
function owner() {
  const warnings = [];
  return { warnings, logger: { warn: (message) => warnings.push(message) } };
}

const settle = (options, settings) => {
  const changes = [];
  const result = installConnectSection({
    owner: options.owner ?? owner(),
    settings,
    entry: options.entry,
    onChange: (section) => changes.push(section),
  });
  return { result, changes };
};

// --- sectionOf: the secret projection -----------------------------------

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
  const section = sectionOf({
    channelDefaults: { language: "en", notifyLevel: "result", rogue: "x" },
  });
  assert.deepEqual(section.channelDefaults, { language: "en", notifyLevel: "result" });
  assert.equal(sectionOf({ channelDefaults: { rogue: "x" } }).channelDefaults, undefined);
});

// --- the schema itself ---------------------------------------------------

test("the schema accepts a realistic section", () => {
  const parsed = ConnectSectionSchema({
    channels: ["feishu", "web"],
    channelDefaults: { language: "en", notifyLevel: "result" },
    feishu: { transport: "websocket", requireMention: true, webhookPort: 8080, webhookPath: "/hook" },
    web: { pollIntervalMs: 1000 },
  });
  assert.deepEqual(parsed.channels, ["feishu", "web"]);
  assert.equal(parsed.feishu.webhookPort, 8080);
});

test("the schema rejects an unknown channel and a bad select value", () => {
  // These throws are what `installConnectSection` has to survive — a user
  // typing a channel name that doesn't exist must not stop the bridge.
  assert.throws(() => ConnectSectionSchema({ channels: ["feishu", "irc"] }));
  assert.throws(() => ConnectSectionSchema({ feishu: { transport: "carrier-pigeon" } }));
});

test("an absent field stays absent — no default is materialized", () => {
  // `dmMode`'s first option is the permissive one, so a schema-supplied default
  // would silently open DMs for every user who never touched the field.
  const parsed = ConnectSectionSchema({ channels: ["feishu"], feishu: { transport: "websocket" } });
  assert.equal(parsed.feishu.dmMode, undefined);
  assert.equal(parsed.feishu.requireMention, undefined);
});

test("the schema preserves undeclared keys — the hazard sectionOf exists for", () => {
  // Not a wish, a property: schemastery passes unknown keys through verbatim.
  // If a secret reached the schema it would survive into `describe()` output
  // and onto the settings RPC. `sectionOf` is the only thing that stops it.
  const parsed = ConnectSectionSchema({ feishu: { transport: "websocket", appSecret: "leaked" } });
  assert.equal(parsed.feishu.appSecret, "leaked");
});

// --- installConnectSection ----------------------------------------------

test("no settings service: the plugin config stands alone", () => {
  const { result, changes } = settle({ entry: { channels: ["feishu"], feishu: { transport: "websocket" } } }, undefined);

  assert.equal(result.live, false);
  assert.deepEqual(result.section, { channels: ["feishu"], feishu: { transport: "websocket" } });
  assert.deepEqual(changes, [result.section]);
});

test("a live registration layers the user's section over the plugin config", () => {
  const settings = fakeSettings({ user: { [CONNECT_SETTINGS_NS]: { channels: ["feishu", "web"] } } });
  const { result, changes } = settle(
    { entry: { channels: ["feishu"], feishu: { transport: "websocket", appSecret: "s3cret" } } },
    settings,
  );

  assert.equal(result.live, true);
  // The resolved section carries every declared channel as a (possibly empty)
  // object: `required(false)` omits absent *fields*, but an object schema with
  // all-optional fields still resolves to `{}`. Harmless downstream — the
  // runtime merges `{}` as a no-op — so it is pinned rather than worked around.
  assert.deepEqual(result.section, {
    channels: ["feishu", "web"],
    channelDefaults: {},
    feishu: { transport: "websocket" },
    telegram: {},
    dingtalk: {},
    web: {},
  });
  assert.deepEqual(changes, [result.section]);
  // The base layer handed to the provider must be the projected one: the
  // provider merges it into the document it hands back out.
  assert.deepEqual(settings.entry, { channels: ["feishu"], feishu: { transport: "websocket" } });
  assert.ok(!JSON.stringify(settings.entry).includes("s3cret"));
});

test("a later edit reaches onChange", () => {
  const settings = fakeSettings();
  const changes = [];
  installConnectSection({
    owner: owner(),
    settings,
    entry: { channels: ["feishu"] },
    onChange: (section) => changes.push(section),
  });

  settings.user[CONNECT_SETTINGS_NS] = { channels: ["feishu", "telegram"] };
  settings.notify();

  assert.equal(changes.length, 2);
  assert.deepEqual(changes[1].channels, ["feishu", "telegram"]);
});

test("a stored section that fails validation falls back to the plugin config", () => {
  const settings = fakeSettings({ failInstall: "ValidationError: channels[1]" });
  const plugin = owner();
  const { result, changes } = settle(
    { owner: plugin, entry: { channels: ["feishu"], feishu: { transport: "websocket" } } },
    settings,
  );

  assert.equal(result.live, false);
  assert.deepEqual(result.section, { channels: ["feishu"], feishu: { transport: "websocket" } });
  assert.deepEqual(changes, [result.section]);
  assert.match(plugin.warnings.join("\n"), /^connect: settings namespace "dsh-connect" unavailable/);
});

test("an already-registered namespace keeps the saved section, with the remedy logged", () => {
  // A live plugin reload re-runs `apply` while the previous registration is
  // still live on the settings *service* (whose effect outlives ours), so the
  // second install throws. `get()` returns what the earlier fiber resolved.
  const settings = fakeSettings({ failInstall: "settings namespace \"dsh-connect\" is already registered" });
  settings.registered = { channels: ["web"], web: { pollIntervalMs: 2000 } };
  const plugin = owner();
  const { result, changes } = settle({ owner: plugin, entry: { channels: ["feishu"] } }, settings);

  assert.equal(result.live, false);
  assert.deepEqual(result.section, { channels: ["web"], web: { pollIntervalMs: 2000 } });
  assert.deepEqual(changes, [result.section]);
  assert.match(plugin.warnings.join("\n"), /already registered .*restart dsh to re-enable live settings updates/s);
});

test("a non-object from get() is not mistaken for a saved section", () => {
  const settings = fakeSettings({ failInstall: "boom" });
  settings.registered = "nonsense";
  const plugin = owner();
  const { result } = settle({ owner: plugin, entry: { channels: ["feishu"] } }, settings);

  assert.deepEqual(result.section, { channels: ["feishu"] });
  assert.match(plugin.warnings.join("\n"), /unavailable/);
});

test("a service without installSection is not used, even if get() has a value", () => {
  const { result } = settle({ entry: { channels: ["web"] } }, { get: () => ({ channels: ["feishu"] }) });
  assert.equal(result.live, false);
  assert.deepEqual(result.section, { channels: ["web"] });
});

// --- the write handle ----------------------------------------------------

test("a live install hands back a handle that reads the registration live", () => {
  const settings = fakeSettings({ user: { [CONNECT_SETTINGS_NS]: { channels: ["feishu"] } } });
  const { result } = settle({ entry: { channels: ["web"] } }, settings);

  assert.equal(result.live, true);
  assert.ok(result.handle, "the live path must expose a write handle");
  assert.deepEqual(result.handle.read().channels, ["feishu"]);

  // The handle reads through `setSource` → `scope.get()`, so a later edit by
  // any writer (the provider's watcher, the host's own Plugins page) is visible
  // without re-installing.
  settings.user[CONNECT_SETTINGS_NS] = { channels: ["feishu", "telegram"] };
  settings.notify();
  assert.deepEqual(result.handle.read().channels, ["feishu", "telegram"]);
});

test("handle.write projects secrets and undeclared keys out of the submitted section", () => {
  // The mirror of the `sectionOf` hazard: schemastery preserves undeclared keys,
  // so a section arriving *from the pane* would persist whatever it carried —
  // including a secret. The projection sits inside `write`, not at the call site,
  // so no caller can bypass it.
  const settings = fakeSettings();
  const { result } = settle({ entry: { channels: ["feishu"] } }, settings);

  return result.handle.write({
    channels: ["feishu"],
    feishu: { transport: "websocket", appSecret: "smuggled" },
    settingsStatePath: "s.json",
    rogue: "x",
  }).then(() => {
    assert.equal(settings.replaced.length, 1);
    const sent = settings.replaced[0].section;
    assert.deepEqual(sent, { channels: ["feishu"], feishu: { transport: "websocket" } });
    // The namespace is the only store; the file-only key stays out of the document.
    assert.equal(sent.settingsStatePath, undefined);
    assert.ok(!JSON.stringify(settings.replaced).includes("smuggled"));
  });
});

test("handle.write with no channels falls back to every built-in", () => {
  const settings = fakeSettings();
  const { result } = settle({ entry: { channels: ["feishu"] } }, settings);
  return result.handle.write({}).then(() => {
    assert.deepEqual(settings.replaced[0].section, { channels: [...CHANNELS] });
  });
});

test("a provider without replace gets a read-only install: no handle", () => {
  const { result } = settle({ entry: { channels: ["feishu"] } }, readOnlySettings());
  assert.equal(result.live, true);
  assert.equal(result.handle, undefined);
});

test("a rejected write propagates instead of being swallowed", () => {
  const settings = fakeSettings({ failReplace: "ValidationError: feishu.transport" });
  const { result } = settle({ entry: { channels: ["feishu"] } }, settings);
  return result.handle.write({ feishu: { transport: "pigeon" } }).then(
    () => assert.fail("a rejected write must not resolve"),
    (error) => assert.match(error.message, /ValidationError/),
  );
});

test("a non-live install has no handle to write through", () => {
  const { result } = settle({ entry: { channels: ["feishu"] } }, undefined);
  assert.equal(result.handle, undefined);
});

test("install never throws, even with no logger on the owner", () => {
  assert.doesNotThrow(() =>
    installConnectSection({
      owner: {},
      settings: fakeSettings({ failInstall: "boom" }),
      entry: { channels: ["feishu"] },
      onChange: () => {},
    }),
  );
});
