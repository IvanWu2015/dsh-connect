import { test } from "node:test";
import assert from "node:assert/strict";

import { ADVANCED_KEYS, isAdvanced, initialOpenChannels, toggleInSet } from "../client/panel-state.mjs";
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
