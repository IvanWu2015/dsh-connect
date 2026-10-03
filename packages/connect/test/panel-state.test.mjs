import { test } from "node:test";
import assert from "node:assert/strict";

import { ADVANCED_KEYS, isAdvanced, initialOpenChannels, toggleInSet, snapshotIssues } from "../client/panel-state.mjs";
import { CHANNEL_SECRET_FIELDS, CHANNEL_CONFIG_FIELDS } from "../lib/settings/settings-model.js";

/**
 * The accordion's rules, pinned outside React.
 *
 * `client-bundle.test.mjs` renders the real component, but it can only hand the
 * component its hook *values* — it can never observe what the component
 * initializes them to, because the stub has no working `useEffect` and no second
 * render. So "which cards start open" and "which fields count as advanced" would
 * otherwise be untested in exactly the place a mistake is easiest to make.
 */

const CHANNELS = Object.keys(CHANNEL_SECRET_FIELDS);

test("the channels that start open are the enabled ones", () => {
  const open = initialOpenChannels(["feishu", "dingtalk"], CHANNELS);
  assert.ok(open instanceof Set);
  assert.deepEqual([...open].sort(), ["dingtalk", "feishu"]);
});

test("with nothing enabled the first channel opens, so the pane is never a wall of headers", () => {
  assert.deepEqual([...initialOpenChannels([], CHANNELS)], [CHANNELS[0]]);
  assert.deepEqual([...initialOpenChannels(undefined, CHANNELS)], [CHANNELS[0]]);
  assert.deepEqual([...initialOpenChannels(null, CHANNELS)], [CHANNELS[0]]);
});

test("a name the pane does not know never opens a card", () => {
  // `enabled` comes from the host's config file, which a user can edit by hand.
  // A stale channel name must not silently pre-open nothing, nor crash.
  assert.deepEqual([...initialOpenChannels(["mattermost"], CHANNELS)], [CHANNELS[0]]);
  assert.deepEqual([...initialOpenChannels(["feishu", "mattermost"], CHANNELS)], ["feishu"]);
  assert.deepEqual([...initialOpenChannels([], [])], []);
});

test("toggleInSet returns a new set and leaves the original alone", () => {
  const before = new Set(["feishu"]);
  const added = toggleInSet(before, "telegram");
  assert.deepEqual([...before], ["feishu"], "toggleInSet mutated the set it was given");
  assert.deepEqual([...added].sort(), ["feishu", "telegram"]);

  const removed = toggleInSet(before, "feishu");
  assert.deepEqual([...before], ["feishu"]);
  assert.deepEqual([...removed], []);
});

test("every advanced key is a real config field of its own channel", () => {
  // A typo here does not fail anything at runtime — it just makes a field
  // disappear from the pane, so this is the only place it can be caught.
  for (const [ch, keys] of Object.entries(ADVANCED_KEYS)) {
    assert.ok(CHANNELS.includes(ch), `ADVANCED_KEYS names a channel that does not exist: ${ch}`);
    const fieldKeys = (CHANNEL_CONFIG_FIELDS[ch] ?? []).map((f) => f.key);
    for (const key of keys) {
      assert.ok(fieldKeys.includes(key), `ADVANCED_KEYS.${ch} names ${key}, which is not a config field of ${ch}`);
    }
  }
});

test("no credential is ever behind the advanced fold", () => {
  // Folding a field the user cannot otherwise reach is bad; folding a *secret*
  // is worse, because the pane's whole job is to confirm what is configured.
  for (const [ch, fields] of Object.entries(CHANNEL_SECRET_FIELDS)) {
    for (const field of fields) {
      assert.ok(!isAdvanced(ch, field), `${ch}.${field} is a credential and must never be folded away`);
    }
  }
});

test("isAdvanced is per-channel, so a shared key folds differently per channel", () => {
  assert.equal(isAdvanced("telegram", "pollingTimeoutSeconds"), true);
  assert.equal(isAdvanced("feishu", "pollingTimeoutSeconds"), false);
  assert.equal(isAdvanced("feishu", "webhookPort"), true);
  assert.equal(isAdvanced("web", "pollIntervalMs"), true);
  assert.equal(isAdvanced("telegram", "language"), false);
  // An unknown channel has no advanced fields rather than a crash.
  assert.equal(isAdvanced("mattermost", "language"), false);
});

test("a clean snapshot produces no issues at all", () => {
  // The happy path is the one that has to stay quiet: an empty list is what the
  // pane reads to decide whether to render the save bar's problem block.
  assert.deepEqual(snapshotIssues({ config: {}, credentials: { feishu: true } }), []);
  // Explicit empty lists mean "nothing to report", not "unknown".
  assert.deepEqual(snapshotIssues({ credentialErrors: [], warnings: [], channelErrors: {} }), []);
  assert.deepEqual(snapshotIssues(undefined), []);
});

test("each report becomes its own kind of issue, with a stable key", () => {
  const issues = snapshotIssues({
    credentialErrors: ["dingtalk"],
    warnings: ["credentialsStoredNotApplied"],
    channelErrors: { feishu: "Error: app id is empty" },
  });
  assert.deepEqual(issues, [
    { kind: "credentialUnknown", channel: "dingtalk", key: "credentialUnknown:dingtalk" },
    { kind: "warning", code: "credentialsStoredNotApplied", key: "warning:credentialsStoredNotApplied" },
    { kind: "channelFailed", channel: "feishu", reason: "Error: app id is empty", key: "channelFailed:feishu" },
  ]);
  // Keys carry no index, so a list that reorders reconciles in place rather than
  // remounting every row.
  for (const issue of issues) assert.ok(!/\d/.test(issue.key), `unstable key ${issue.key}`);
});

test("the host's own warnings are used when the caller has none of its own", () => {
  // The single-snapshot read path (`get` on load) has no chain to accumulate.
  assert.deepEqual(snapshotIssues({ warnings: ["credentialsStoredNotApplied"] }), [
    { kind: "warning", code: "credentialsStoredNotApplied", key: "warning:credentialsStoredNotApplied" },
  ]);
});

test("accumulated warnings add to the snapshot's, rather than replacing them", () => {
  // The credential save chain: an earlier channel's warning must survive a later
  // channel's save, because it is a statement about the call that raised it and
  // the host does not repeat it.
  const issues = snapshotIssues({ channelErrors: { feishu: "boom" } }, ["credentialsStoredNotApplied"]);
  assert.deepEqual(issues.map((i) => i.kind), ["warning", "channelFailed"]);
});

test("an explicit empty warning list is respected, not treated as absent", () => {
  // `??` and not `||`: a caller that clears its warnings means it, and falling
  // back to `snap.warnings` would resurrect exactly the entry it just dropped.
  assert.deepEqual(snapshotIssues({ warnings: ["credentialsStoredNotApplied"] }, []), []);
});
