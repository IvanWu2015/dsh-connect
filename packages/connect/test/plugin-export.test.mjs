import { test } from "node:test";
import assert from "node:assert/strict";

import * as mod from "../lib/index.js";
import { CHANNELS } from "../lib/settings/channels.js";
import { GENERAL_FIELDS } from "../lib/settings/settings-model.js";

/**
 * The plugin's *loading* contract — the module's default export, as DSH reads it.
 *
 * Every other suite here imports the named exports and calls `apply` on a
 * context it built itself. That is the right way to test behaviour, and it is
 * blind to this whole class of defect: it never runs the two steps the loader
 * runs before `apply` is even reachable. A release 1.0.3 went out with the
 * plugin unable to be configured at all — the settings pane reported the Feishu
 * channel as 未设置 after a save that appeared to do nothing, and never rendered
 * the 接入状态 row — and the full suite was green, because:
 *
 * 1. cordis-plugin-loader resolves the entry to `unwrapExports(mod)` =
 *    `mod.default ?? mod`, then `ctx.registry.plugin()` builds the runtime as
 *    `{ name, callback, fibers, Config: plugin.Config }`. Our `Config` was a
 *    *named* export only; the moment a `default` exists the namespace is no
 *    longer the plugin, so `runtime.Config` was `undefined`.
 * 2. `dsh-settings` decides whether an entry is configurable from exactly that
 *    field — `schema(entry) { const schema = entry.fiber?.runtime?.Config;
 *    return schema !== void 0 && "toJSON" in schema ? schema : void 0 }` — and
 *    `write()` throws `No configurable plugin entry "<ns>"` when it is absent.
 *    The pane's first save call is `settings.save`, so it threw, the pane's
 *    `catch` set the error status, and the credential save that would have
 *    stored the appId/appSecret the user had just typed never ran.
 *
 * It is also what makes `.volatile()` mean anything: the loader hot-commits a
 * pane edit only when it can read the schema (`equalExceptVolatile(legacy,
 * next, runtime.Config)`, and `_commitVolatile` walks the references
 * `resolveConfig` produced). With no schema, `resolveConfig` returns the raw
 * config unchanged, `volatileEntries` finds no references, and every edit is a
 * full remount.
 *
 * So this suite models the loader's two steps faithfully and asserts the
 * properties DSH itself reads — not a private reimplementation of them.
 */

/** cordis-plugin-loader `unwrapExports`: what `ctx.registry.plugin()` receives. */
const plugin = mod.default ?? mod;

/** cordis `plugin()`: `runtime = { name, callback, fibers, Config: plugin.Config }`. */
const runtime = { name: plugin.name, Config: plugin.Config };

/** dsh-settings `schema(entry)`, verbatim: a schema must expose `toJSON`. */
const settingsSchemaOf = (entry) =>
  entry?.Config !== undefined && "toJSON" in entry.Config ? entry.Config : undefined;

/** A validated config field is a live reference when it carries this protocol. */
const VOLATILE_WRITE = Symbol.for("cosmokit.volatile.write");
const isReference = (value) => typeof value === "object" && value !== null && VOLATILE_WRITE in value;
const deref = (value) => (isReference(value) ? value.get() : value);

/** The host refuses a non-synchronous validator (cordis `resolveConfig`). */
function validate(config) {
  const result = runtime.Config["~standard"].validate(config);
  assert.ok(!("then" in result), "Config validates asynchronously — cordis rejects that outright");
  return result;
}

test("the default export carries the four fields the loader reads off it", () => {
  assert.equal(typeof plugin.apply, "function", "the loader cannot reach `apply` through the default export");
  assert.equal(plugin.name, "connect");
  assert.deepEqual(plugin.inject, ["agents", "sessions", "agentDefaultModel", "credentials"]);
  assert.notEqual(
    plugin.Config,
    undefined,
    "the default export has no `Config`: cordis sets `runtime.Config = plugin.Config` from *this* object, "
      + "and `dsh-settings` refuses every pane write with `No configurable plugin entry \"connect\"` without it",
  );
});

test("the named `Config` export and the one on the plugin object are the same schema", () => {
  // Two copies of a schema drift. The named export is what the codebase imports
  // (and what `paneConfigFields` feeds); the plugin property is what the host
  // reads. They must be one object, not two equal ones.
  assert.equal(plugin.Config, mod.Config);
});

test("`Config` passes both probes the host makes before it will accept a write", () => {
  const schema = settingsSchemaOf(runtime);
  assert.notEqual(schema, undefined, "dsh-settings resolves this entry to no schema — the pane's save is refused");
  assert.equal(typeof schema.toJSON, "function", "the host serializes the schema through `toJSON` to build the form");

  const result = validate({});
  assert.equal(result.issues, undefined, `an empty config must validate, got ${JSON.stringify(result.issues)}`);
});

test("a config that sets nothing still loads, and still activates every channel", () => {
  // `channels` is `.default([...CHANNELS])` on purpose: a volatile *array*
  // resolves an absent key to `[]`, so without the default a profile that never
  // named a channel would start no adapter at all instead of the documented all.
  const result = validate({});
  assert.equal(result.issues, undefined);
  assert.deepEqual(deref(result.value.channels), [...CHANNELS]);
  assert.deepEqual(Object.keys(result.value.feishu).length > 0, true);
});

test("every field the pane edits comes back as a live reference", () => {
  // This is the half of the contract a working write path depends on: the loader
  // commits a pane save into the references `resolveConfig` produced, and it only
  // takes the volatile path for paths the schema marks. A field the pane edits
  // but the schema does not mark is a save that silently remounts instead.
  const samples = {
    language: "zh",
    notifyLevel: "result",
    progressTimeoutMs: 60000,
    workDir: "C:/tmp",
    workspaces: ["C:/tmp"],
    allowUsers: ["ou_probe"],
    allowChats: ["oc_probe"],
    agentPreset: "default",
    autoMirror: true,
    streamHeartbeatMs: 60000,
  };
  const config = { channels: ["feishu"], channelDefaults: { language: "zh" }, feishu: { transport: "websocket" } };
  for (const field of GENERAL_FIELDS) config[field.key] = samples[field.key];

  const result = validate(config);
  assert.equal(result.issues, undefined, JSON.stringify(result.issues));
  const value = result.value;

  for (const field of GENERAL_FIELDS) {
    assert.ok(isReference(value[field.key]), `${field.key} is a pane field but not a live reference`);
    assert.deepEqual(deref(value[field.key]), samples[field.key], `${field.key} did not survive validation`);
  }
  assert.ok(isReference(value.channels), "channels is not hot-committable");
  assert.ok(isReference(value.channelDefaults?.language), "channelDefaults.language is not hot-committable");
  assert.ok(isReference(value.feishu?.transport), "feishu.transport is not hot-committable");
  assert.deepEqual(deref(value.channels), ["feishu"]);
});

test("declaring `Config` must not stop a stale profile from loading", () => {
  // The cost of the fix: the profile config is validated now, and a
  // `ValidationError` at load time costs the user the whole plugin. Anything we
  // do not recognise has to pass through untouched — a key from an older
  // version, a channel option this release dropped, a secret we deliberately
  // keep out of the pane's field set.
  const result = validate({
    channels: ["feishu"],
    legacyThing: { a: 1 },
    feishu: { transport: "websocket", dmMode: "open", appId: "cli_probe", appSecret: "probe_secret", wormholePort: 1234 },
  });
  assert.equal(result.issues, undefined, `a stale profile is rejected: ${JSON.stringify(result.issues)}`);

  const value = result.value;
  assert.deepEqual(value.legacyThing, { a: 1 }, "an unknown top-level key was dropped");
  const feishu = deref(value.feishu);
  assert.equal(feishu.appId, "cli_probe", "the channel's appId was dropped");
  assert.equal(feishu.appSecret, "probe_secret", "the channel's appSecret was dropped");
  assert.equal(feishu.wormholePort, 1234, "an unknown channel option was dropped");
  // `dmMode` is a declared pane field, so it comes back as a reference while its
  // undeclared neighbours above stay plain — both shapes have to survive.
  assert.equal(deref(feishu.dmMode), "open");
});
