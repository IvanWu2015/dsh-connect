import { test } from "node:test";
import assert from "node:assert/strict";

import { ADVANCED_KEYS, isAdvanced, initialOpenChannels, toggleInSet, snapshotIssues, onboardingIssues, PANE_VIEWS, DEFAULT_VIEW } from "../client/panel-state.mjs";
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

// --- the primary navigation ------------------------------------------------

test("the navigation order puts 通用设置 first, and the landing view does not follow it", () => {
  // Both halves, in one place, because they look like a contradiction and are
  // not: the *order* of the two subjects is 通用设置 → 机器人渠道, while the pane
  // opens on the channels view so the one-click creation button is zero clicks
  // away. Pinned here so that a later "cleanup" that makes `DEFAULT_VIEW` equal
  // `PANE_VIEWS[0]` — the obvious-looking tidy-up — fails a test instead of
  // silently burying the button behind a click again.
  assert.deepEqual(PANE_VIEWS, ["general", "channels"]);
  assert.equal(DEFAULT_VIEW, "channels");
  assert.notEqual(DEFAULT_VIEW, PANE_VIEWS[0], "the landing view was aligned with the navigation order");
  // Every view the pane can select is one the navigation can reach; the render
  // looks up `view.<name>` for each, so an entry with no locale label would show
  // the raw key as a button.
  assert.ok(PANE_VIEWS.includes(DEFAULT_VIEW), "the default view is not reachable from the navigation");
});

// --- onboardingIssues ------------------------------------------------------
//
// One line per true fact about the one-click run. The pane renders these as the
// save bar's problem list, so each case below is really an assertion about what
// the user is told — and, just as often, about what they are *not* told.

/** The shape a run that went cleanly end to end produces. */
const created = (extra = {}) => ({
  created: true,
  appId: "cli_created",
  credentialsStored: true,
  legacyMirrorWritten: true,
  applied: "yes",
  subscription: { attempted: true, status: "applied", needsManualAction: false },
  enableRequested: true,
  ...extra,
});

/** Just the codes, in order — the readable half of every assertion here. */
const codes = (issues) => issues.map((issue) => issue.code);

test("a pane that never ran a flow reports nothing at all", () => {
  assert.deepEqual(onboardingIssues(undefined), []);
  assert.deepEqual(onboardingIssues(null), []);
});

test("a clean run reports its facts one per line", () => {
  const issues = onboardingIssues(created());
  assert.deepEqual(issues, [
    { kind: "onboarding", code: "created", key: "onboarding:created", appId: "cli_created" },
    { kind: "onboarding", code: "credentialsStored", key: "onboarding:credentialsStored" },
    { kind: "onboarding", code: "enableRequested", key: "onboarding:enableRequested" },
    { kind: "onboarding", code: "subscription.applied", key: "onboarding:subscription.applied" },
  ]);
  // Nothing to say about `applied` on a run that applied: the absence of the
  // line is the report, and a "已生效" line here would be noise on every success.
  assert.deepEqual(codes(issues).filter((c) => c === "notApplied" || c === "applyPending"), []);
});

test("every onboarding key is stable, free of indices, and names its code", () => {
  const shapes = [
    created(),
    created({ applied: "no" }),
    created({ applied: "pending" }),
    created({ credentialsStored: false, legacyMirrorWritten: false }),
    created({ enableRequested: false }),
    created({ subscription: { attempted: true, status: "failed", reason: "x", needsManualAction: true } }),
  ];
  for (const shape of shapes) {
    for (const issue of onboardingIssues(shape)) {
      assert.equal(issue.kind, "onboarding");
      assert.equal(issue.key, `onboarding:${issue.code}`, "the key must be derivable from the code");
      assert.ok(!/\d/.test(issue.key), `unstable key ${issue.key}`);
    }
  }
});

test("a run that never created anything reports only how it ended", () => {
  // The user's cancel, the device-code expiry, and a `registerApp` that threw.
  // `created` stays false on all three and they share no other field, so the
  // reason string is the only discriminator — and each needs its own wording.
  const base = {
    created: false,
    credentialsStored: false,
    legacyMirrorWritten: false,
    applied: "pending",
    subscription: { attempted: false, status: "not-attempted", needsManualAction: true },
    enableRequested: false,
  };

  assert.deepEqual(onboardingIssues({ ...base, reason: "abort" }), [
    { kind: "onboarding", code: "cancelled", key: "onboarding:cancelled", reason: "abort" },
  ]);
  assert.deepEqual(onboardingIssues({ ...base, reason: "expired_token" }), [
    { kind: "onboarding", code: "expired", key: "onboarding:expired", reason: "expired_token" },
  ]);
  assert.deepEqual(onboardingIssues({ ...base, reason: "invalid_app_name" }), [
    { kind: "onboarding", code: "createFailed", key: "onboarding:createFailed", reason: "invalid_app_name" },
  ]);
  // Even with nothing to report beyond the fact itself.
  assert.deepEqual(onboardingIssues({ ...base }), [
    { kind: "onboarding", code: "createFailed", key: "onboarding:createFailed" },
  ]);
});

test("the credential lines report each store separately", () => {
  assert.deepEqual(codes(onboardingIssues(created())),
    ["created", "credentialsStored", "enableRequested", "subscription.applied"]);

  // Store failed, mirror written. The mirror is what carries the run — saying
  // so twice would read as two problems where there is one.
  assert.deepEqual(codes(onboardingIssues(created({ credentialsStored: false, legacyMirrorWritten: true }))),
    ["created", "credentialsNotStored", "enableRequested", "subscription.applied"]);

  // Neither landed: the credentials now live only in this process.
  assert.deepEqual(codes(onboardingIssues(created({ credentialsStored: false, legacyMirrorWritten: false }))),
    ["created", "credentialsNotStored", "legacyMirrorFailed", "enableRequested", "subscription.applied"]);
});

test("the enable line reports the write, not a guess about the outcome", () => {
  assert.ok(codes(onboardingIssues(created())).includes("enableRequested"));
  const refused = codes(onboardingIssues(created({ enableRequested: false })));
  assert.ok(refused.includes("enableFailed"));
  assert.ok(!refused.includes("enableRequested"), "one line, not both halves of a dichotomy");
});

test("both halves of 已落盘 ≠ 已生效 are reported, as two lines", () => {
  // The case this whole outcome type exists for: the secret is on disk and the
  // running adapter never picked it up. Collapsing these into one line is the
  // clean-success lie.
  const issues = onboardingIssues(created({ applied: "no" }));
  const seen = codes(issues);
  assert.ok(seen.includes("credentialsStored"), "half one");
  assert.ok(seen.includes("notApplied"), "half two");
  assert.ok(!seen.includes("applyPending"), "not applied is not the same as pending");
});

test("`pending` and `yes` are distinct from `no`", () => {
  const applied = (value) => codes(onboardingIssues(created({ applied: value })))
    .filter((c) => c === "notApplied" || c === "applyPending");
  // What a run that was cancelled or died after creating the app leaves behind.
  assert.deepEqual(applied("pending"), ["applyPending"]);
  // Only an explicit `no` claims the re-apply was asked for and failed.
  assert.deepEqual(applied("no"), ["notApplied"]);
  assert.deepEqual(applied("yes"), []);
});

test("the subscription reports four states, not two", () => {
  const sub = (subscription) => onboardingIssues(created({ subscription }))
    .filter((issue) => issue.code.startsWith("subscription."));

  assert.deepEqual(sub({ attempted: false, status: "not-attempted", needsManualAction: true }), [
    { kind: "onboarding", code: "subscription.notAttempted", key: "onboarding:subscription.notAttempted" },
  ]);
  assert.deepEqual(sub({ attempted: false, status: "skipped", needsManualAction: true }), [
    { kind: "onboarding", code: "subscription.skipped", key: "onboarding:subscription.skipped" },
  ]);
  assert.deepEqual(sub({ attempted: true, status: "applied", needsManualAction: false }), [
    { kind: "onboarding", code: "subscription.applied", key: "onboarding:subscription.applied" },
  ]);
  // The API's own code/msg, verbatim — rendered in a `<code>` beside the line.
  assert.deepEqual(sub({ attempted: true, status: "failed", reason: "99991672 access denied", needsManualAction: true }), [
    { kind: "onboarding", code: "subscription.failed", key: "onboarding:subscription.failed", reason: "99991672 access denied" },
  ]);
  assert.deepEqual(sub({ attempted: true, status: "failed", needsManualAction: true }), [
    { kind: "onboarding", code: "subscription.failed", key: "onboarding:subscription.failed" },
  ]);

  // `not-attempted` ("the flow never got that far") must not borrow `skipped`'s
  // key ("there was nothing to subscribe with") — different statements, and the
  // pane keys its rows on this.
  assert.notDeepEqual(sub({ status: "not-attempted" }), sub({ status: "skipped" }));
});

test("an unknown subscription status falls back to the one that claims least", () => {
  for (const subscription of [undefined, {}, { attempted: false }]) {
    const issues = onboardingIssues(created({ subscription }));
    assert.deepEqual(codes(issues).filter((c) => c.startsWith("subscription.")), ["subscription.skipped"]);
  }
});

test("needsManual is its own line, and only when work really is left over", () => {
  assert.ok(codes(onboardingIssues(created({ subscription: { status: "skipped", needsManualAction: true } }))).includes("needsManual"));
  assert.ok(codes(onboardingIssues(created({ subscription: { status: "failed", needsManualAction: true } }))).includes("needsManual"));
  assert.ok(!codes(onboardingIssues(created())).includes("needsManual"));
  // Strictly `true`: an absent flag is not a claim that the user has work to do.
  assert.ok(!codes(onboardingIssues(created({ subscription: { status: "applied" } }))).includes("needsManual"));
});

test("a run that created an app and then went wrong reports every half", () => {
  const issues = onboardingIssues({
    created: true,
    appId: "cli_created",
    credentialsStored: false,
    legacyMirrorWritten: false,
    applied: "no",
    enableRequested: false,
    subscription: { attempted: true, status: "failed", reason: "99991672 access denied", needsManualAction: true },
    reason: "boom",
  });
  assert.deepEqual(codes(issues), [
    "created",
    "credentialsNotStored",
    "legacyMirrorFailed",
    "enableFailed",
    "subscription.failed",
    "needsManual",
    "notApplied",
  ]);
  // The app id is carried on its own line, and never the secret — the outcome
  // has no field for one.
  assert.equal(issues[0].appId, "cli_created");
  assert.equal(JSON.stringify(issues).includes("appSecret"), false);
  // `reason` is a *pre-creation* field: it is set by the flow error callback and
  // by a throw, both of which leave `created` false and are reported by the
  // three codes above. Once an app exists, each step reports its own result and
  // the flow-level reason says nothing the lines do not. (With the real
  // `saveCredentials` it cannot even be set: that function returns `false`
  // rather than throwing, so no guarded step can reject the flow.)
  assert.equal(JSON.stringify(issues).includes("boom"), false);
});
