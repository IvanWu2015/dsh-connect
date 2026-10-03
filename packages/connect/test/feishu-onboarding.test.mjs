import { test } from "node:test";
import assert from "node:assert/strict";

import { createFeishuOnboarding, enableFeishuConfig } from "../lib/settings/feishu-onboarding.js";
import { feishuMessages } from "../lib/channels/feishu/i18n.js";

/**
 * The one-click flow's host half, pinned without a network round trip and
 * without the ten-minute wait `registerApp` would otherwise impose.
 *
 * Every dependency is injected by design (`FeishuOnboardingDeps`), which is what
 * makes these tests possible at all — but the thing they are really guarding is
 * the *reporting*: this flow is the only place that knows whether a bot was
 * created, whether its secret landed anywhere durable, and whether the running
 * adapters picked it up. Each of those is a separate truth, and merging any two
 * of them into a clean 「已完成」 is the exact lie the feature exists to stop
 * telling.
 */

const CREDS = { appId: "cli_created", appSecret: "sec_created" };
const REFS = { appId: "DSH_CONNECT_FEISHU_APP_ID", appSecret: "DSH_CONNECT_FEISHU_APP_SECRET" };
const LINK = { url: "https://open.feishu.cn/page/launcher?token=abc", expireIn: 600 };

const t = feishuMessages("zh");

/** Let every already-scheduled microtask and one macrotask turn drain. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
async function settle(rounds = 8) {
  for (let i = 0; i < rounds; i += 1) await tick();
}

/** A promise a test resolves by hand, so a flow can be observed mid-flight. */
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/**
 * Build a registry with every dependency faked, plus the call log a test wants.
 *
 * `flow` is the `onboard` seam: by default it reports the device-authorization
 * link and then never resolves, which is what the real `registerApp` does until
 * a human scans — that is the state the pane lives in most of the time.
 */
function harness(overrides = {}) {
  const calls = { onboard: 0, store: [], legacy: [], subscription: [], enable: 0, reconcile: 0, logs: [], timers: [] };
  /** One deferred per `onboard` call, so a re-start is a genuinely new flow. */
  const flows = [];
  const flow = {
    resolve: (value) => flows[0].resolve(value),
    reject: (error) => flows[0].reject(error),
    get promise() { return flows[0].promise; },
  };
  const hooks = [];
  const deps = {
    onboard: async (logger, language, h) => {
      calls.onboard += 1;
      hooks.push(h);
      const pending = deferred();
      flows.push(pending);
      h.onQRCodeReady?.({ url: LINK.url, expireIn: LINK.expireIn });
      return pending.promise;
    },
    credentialStore: {
      async save(channel, values) { calls.store.push([channel, values]); },
    },
    legacySave: (credentials) => { calls.legacy.push(credentials); return true; },
    applySubscription: async (credentials) => { calls.subscription.push(credentials); return { status: "applied" }; },
    requestEnable: async () => { calls.enable += 1; },
    reconcile: async () => { calls.reconcile += 1; },
    logger: { warn: (...args) => calls.logs.push(args.join(" ")) },
    // Never the real timer. The link's lifetime is ten minutes, so the default
    // `setTimeout` would both keep the runner alive long past the assertions and
    // let a stub flow's expiry fire after the test file is done with it.
    setTimer(callback, ms) {
      const handle = { callback, ms, cancelled: false, cancel() { handle.cancelled = true; } };
      calls.timers.push(handle);
      return handle;
    },
    ...overrides,
  };
  return { registry: createFeishuOnboarding(deps), calls, flow, flows, hooks, deps };
}

// --- lifecycle -------------------------------------------------------------

test("nothing has run yet, and that is its own phase", async () => {
  const { registry } = harness();
  assert.deepEqual(await registry.status(), { phase: "idle", channel: "feishu" });
});

test("a channel with no one-click flow is refused, not silently onboarded", async () => {
  // Telegram and DingTalk have no bot-creation API; the pane renders their
  // official page instead. Answering `start("telegram")` with a Feishu link
  // would be the worst possible failure mode.
  const { registry, calls } = harness();
  await assert.rejects(registry.start("telegram"), (error) => error.code === "invalid-channel");
  assert.equal(calls.onboard, 0);
  assert.equal((await registry.status()).phase, "idle");
});

test("start answers with the link while the flow is still waiting", async () => {
  // The whole reason for the start/poll split: the pane must be able to render
  // the link within a second of the click, and `registerApp` resolves minutes
  // later. `onQRCodeReady` fires synchronously, before any await.
  const { registry } = harness();
  const started = await registry.start("feishu");
  assert.equal(started.phase, "waiting");
  assert.equal(started.channel, "feishu");
  assert.equal(started.link.url, LINK.url);
  assert.equal(started.link.expiresInSeconds, LINK.expireIn);
  assert.equal(started.link.expiresAt > Date.now(), true);
  assert.equal(started.outcome, undefined, "a link is not an outcome — nothing has happened yet");
});

test("a second start joins the running flow instead of opening a second link", async () => {
  // The link is single-use and single-person. A second flow would leave a
  // half-created app in the tenant that nobody can ever finish.
  const { registry, calls } = harness();
  const first = await registry.start("feishu");
  const second = await registry.start("feishu");
  await settle();
  assert.equal(calls.onboard, 1);
  assert.deepEqual(second, first);
  assert.equal((await registry.status()).phase, "waiting");
});

test("a start after a finished run clears the old link and outcome", async () => {
  // Otherwise the pane would poll a fresh run and be handed the previous run's
  // link, which is already dead — and the previous run's result, which would
  // make the new attempt look finished the instant it began.
  const { registry, calls, flow } = harness();
  await registry.start("feishu");
  flow.resolve(CREDS);
  await settle();
  assert.equal((await registry.status()).phase, "done");

  // Two runs in one process: the second start must not be blocked by the first
  // one's terminal phase.
  const again = await registry.start("feishu");
  assert.equal(calls.onboard, 2, "a terminal phase must not block a new attempt");
  assert.equal(again.phase, "waiting");
  assert.equal(again.outcome, undefined, "the previous run's result must not be inherited");
  assert.equal(again.link.url, LINK.url);
  assert.equal((await registry.status()).phase, "waiting");
});

// --- cancel ----------------------------------------------------------------

test("cancel latches the phase and aborts the flow's own signal", async () => {
  const { registry, hooks, calls } = harness();
  await registry.start("feishu");
  const status = await registry.cancel();
  assert.equal(status.phase, "cancelled");
  assert.equal(status.outcome.created, false);
  assert.equal(status.outcome.reason, "abort");
  assert.equal(hooks[0].signal.aborted, true, "cancel is real — the SDK must stop polling");
  assert.ok(calls.logs.includes(t.onboardingCancelled));
});

test("a cancelled flow can never write a credential, even if the SDK answers late", async () => {
  // The latch is what makes this safe: the flow keeps running its awaits after
  // the cancel, and the credential store is only reached if it gets past a
  // `stopped()` check. A user who cancels and then scans anyway must not end up
  // with a bot they did not ask for.
  const { registry, calls, flow } = harness();
  await registry.start("feishu");
  await registry.cancel();
  flow.resolve(CREDS);
  await settle();
  assert.deepEqual(calls.store, []);
  assert.deepEqual(calls.legacy, []);
  assert.equal(calls.enable, 0);
  assert.equal(calls.reconcile, 0);
  assert.equal((await registry.status()).phase, "cancelled");
});

test("cancel with nothing running is a no-op, not an error", async () => {
  const { registry } = harness();
  assert.deepEqual(await registry.cancel(), { phase: "idle", channel: "feishu" });
});

// --- the happy path, step by step ------------------------------------------

test("the secret goes into the credential store under its refs, never its config keys", async () => {
  // A config-keyed map matches no ref inside `save`, writes nothing, and still
  // reports success — the bug this assertion exists to keep dead.
  const { registry, calls, flow } = harness();
  await registry.start("feishu");
  flow.resolve(CREDS);
  await settle();
  assert.deepEqual(calls.store, [["feishu", { [REFS.appId]: CREDS.appId, [REFS.appSecret]: CREDS.appSecret }]]);
  // The legacy mirror is written too, and holds the same thing the CLI path
  // writes there.
  assert.deepEqual(calls.legacy, [CREDS]);
  assert.equal(calls.enable, 1);
  assert.equal(calls.reconcile, 1);

  const status = await registry.status();
  assert.equal(status.phase, "done");
  assert.equal(status.outcome.created, true);
  assert.equal(status.outcome.appId, CREDS.appId);
  assert.equal(status.outcome.credentialsStored, true);
  assert.equal(status.outcome.legacyMirrorWritten, true);
  assert.equal(status.outcome.enableRequested, true);
  assert.equal(status.outcome.applied, "yes");
  assert.deepEqual(status.outcome.subscription, { attempted: true, status: "applied", needsManualAction: false });
});

test("the outcome never carries the app secret", async () => {
  // The outcome is what the pane renders and what a screenshot shows.
  const { registry, flow } = harness();
  await registry.start("feishu");
  flow.resolve(CREDS);
  await settle();
  assert.ok(!JSON.stringify(await registry.status()).includes(CREDS.appSecret));
});

test("a stored credential the running channels did not pick up still reports both halves", async () => {
  // 「已落盘 ≠ 已生效」. The credential IS stored and re-sending it changes
  // nothing, so a failed save would be a lie; but the bot is still silent, so a
  // clean success would be the lie the user then acts on.
  const { registry, flow } = harness({ reconcile: async () => { throw new Error("adapter restart failed"); } });
  await registry.start("feishu");
  flow.resolve(CREDS);
  await settle();
  const { outcome } = await registry.status();
  assert.equal(outcome.credentialsStored, true);
  assert.equal(outcome.applied, "no");
  // The reason is deliberately NOT copied in: the pane polls `settings.status`
  // for the same snapshot, whose `channelErrors` already carries the adapter's
  // own words, and two copies could disagree.
  assert.equal(outcome.reason, undefined);
});

test("an enable that failed is not rescued by a clean reconcile", async () => {
  // `reconcile` resolved because there was nothing new to apply. Reporting
  // `applied: "yes"` off that is exactly the clean-success lie.
  const { registry, flow } = harness({ requestEnable: async () => { throw new Error("ValidationError"); } });
  await registry.start("feishu");
  flow.resolve(CREDS);
  await settle();
  const { outcome } = await registry.status();
  assert.equal(outcome.enableRequested, false);
  assert.equal(outcome.applied, "no");
});

// --- storage degradation ---------------------------------------------------

test("a store that refuses is reported as not stored, and the mirror's luck separately", async () => {
  const { registry, flow } = harness({
    credentialStore: { async save() { throw new Error("vault locked"); } },
    legacySave: () => true,
  });
  await registry.start("feishu");
  flow.resolve(CREDS);
  await settle();
  const { phase, outcome } = await registry.status();
  assert.equal(outcome.credentialsStored, false);
  assert.equal(outcome.legacyMirrorWritten, true);
  // The legacy mirror did land, so the app is not lost — that is a `done` run
  // with an honest caveat, not a failure.
  assert.equal(phase, "done");
});

test("neither store taking the credential is a failure, not a quiet success", async () => {
  const { registry, flow } = harness({
    credentialStore: { async save() { throw new Error("vault locked"); } },
    legacySave: () => false,
  });
  await registry.start("feishu");
  flow.resolve(CREDS);
  await settle();
  const { phase, outcome } = await registry.status();
  assert.equal(outcome.credentialsStored, false);
  assert.equal(outcome.legacyMirrorWritten, false);
  assert.equal(phase, "failed", "a bot that will be gone at the next restart is not a success");
});

test("with no credential store at all, the legacy mirror is the only copy and says so", async () => {
  const { registry, flow } = harness({ credentialStore: undefined });
  await registry.start("feishu");
  flow.resolve(CREDS);
  await settle();
  const { outcome } = await registry.status();
  assert.equal(outcome.credentialsStored, false);
  assert.equal(outcome.legacyMirrorWritten, true);
});

// --- the flow itself failing ----------------------------------------------

test("a flow that returns null fails without touching any store", async () => {
  const { registry, calls, flow } = harness();
  await registry.start("feishu");
  flow.resolve(null);
  await settle();
  const { phase, outcome } = await registry.status();
  assert.equal(phase, "failed");
  assert.equal(outcome.created, false);
  assert.deepEqual(outcome.subscription, { attempted: false, status: "skipped", needsManualAction: true });
  assert.deepEqual(calls.store, []);
  assert.deepEqual(calls.legacy, []);
  assert.equal(calls.enable, 0);
});

test("the SDK's error code survives into the outcome as the reason", async () => {
  // The hook exists because the code is only otherwise logged, and the pane
  // cannot read the host log — without it the pane could only say "创建失败".
  const { registry } = harness({
    onboard: async (logger, language, h) => {
      h.onQRCodeReady?.({ url: LINK.url, expireIn: LINK.expireIn });
      h.onError?.("230025");
      return null;
    },
  });
  await registry.start("feishu");
  await settle();
  const { outcome } = await registry.status();
  assert.equal(outcome.reason, "230025");
  assert.equal(outcome.created, false);
});

test("a flow that throws is a failure with the thrown message, not an unhandled rejection", async () => {
  // This one runs inside a fire-and-forget promise; on Node ≥ 15 an unhandled
  // rejection takes the host process down.
  const { registry } = harness({
    onboard: async () => { throw new Error("network unreachable"); },
  });
  await registry.start("feishu");
  await settle();
  const { phase, outcome } = await registry.status();
  assert.equal(phase, "failed");
  assert.equal(outcome.reason, "network unreachable");
  assert.equal(outcome.created, false);
});

// --- the event-subscription step -------------------------------------------

test("no subscription dependency is reported as not attempted, with the manual step flagged", async () => {
  const { registry, flow } = harness({ applySubscription: undefined });
  await registry.start("feishu");
  flow.resolve(CREDS);
  await settle();
  const { outcome } = await registry.status();
  assert.deepEqual(outcome.subscription, { attempted: false, status: "not-attempted", needsManualAction: true });
});

test("a refused subscription PATCH is passed through in the API's own words", async () => {
  // The API's message is the only part that says *why*; mapping it to a code
  // here would throw away the answer.
  const { registry, calls, flow } = harness({
    applySubscription: async () => ({ status: "failed", reason: "99991672 permission denied" }),
  });
  await registry.start("feishu");
  flow.resolve(CREDS);
  await settle();
  const { outcome } = await registry.status();
  assert.deepEqual(outcome.subscription, {
    attempted: true, status: "failed", reason: "99991672 permission denied", needsManualAction: true,
  });
  assert.ok(calls.logs.includes(t.onboardingSubscriptionFailed(CREDS.appId, "99991672 permission denied")));
});

test("a subscription PATCH that throws is a failed step, and the run still finishes", async () => {
  // Best effort by design: a bot that exists and is enabled but whose
  // subscription the console must confirm is still a usable bot.
  const { registry, calls, flow } = harness({
    applySubscription: async () => { throw new Error("403 Forbidden"); },
  });
  await registry.start("feishu");
  flow.resolve(CREDS);
  await settle();
  const { phase, outcome } = await registry.status();
  assert.equal(outcome.subscription.status, "failed");
  assert.equal(outcome.subscription.reason, "403 Forbidden");
  assert.equal(outcome.subscription.needsManualAction, true);
  assert.equal(outcome.credentialsStored, true);
  assert.equal(phase, "done");
  assert.equal(calls.enable, 1, "a failed subscription must not skip the enable the user asked for");
});

test("an applied subscription is the only state that clears the manual flag", async () => {
  const { registry, calls, flow } = harness();
  await registry.start("feishu");
  flow.resolve(CREDS);
  await settle();
  const { outcome } = await registry.status();
  assert.equal(outcome.subscription.status, "applied");
  assert.equal(outcome.subscription.needsManualAction, false);
  assert.ok(calls.logs.includes(t.onboardingSubscriptionApplied(CREDS.appId)));
});

// --- the link's own lifetime ------------------------------------------------

test("the expiry timer is armed for the link's lifetime and fires expired_token", async () => {
  const { registry, calls } = harness({ now: () => 1_000_000 });
  await registry.start("feishu");
  assert.equal(calls.timers.length, 1);
  assert.equal(calls.timers[0].ms, LINK.expireIn * 1000, "the timer must cover the link's own lifetime, no more");

  calls.timers[0].callback();
  const { phase, outcome } = await registry.status();
  assert.equal(phase, "failed");
  assert.equal(outcome.reason, "expired_token");
  assert.equal(outcome.created, false);
  assert.equal(calls.timers[0].cancelled, true, "the timer must not outlive the run it belongs to");
  assert.equal(calls.enable, 0);
  assert.equal(calls.store.length, 0, "an expired link must not leave a bot behind");
});

test("a terminal phase retires the link, on every kind of ending", async () => {
  // The pane renders the link on presence alone, not on the phase, so a spent
  // link left in the snapshot is a dead link offered for scanning right next to
  // the line saying the run is over. `link` present must mean one thing only:
  // still waiting.
  const expired = harness();
  await expired.registry.start("feishu");
  expired.calls.timers[0].callback();
  assert.equal((await expired.registry.status()).phase, "failed");
  assert.equal((await expired.registry.status()).link, undefined);

  const cancelled = harness();
  await cancelled.registry.start("feishu");
  await cancelled.registry.cancel();
  assert.equal((await cancelled.registry.status()).link, undefined);

  const done = harness();
  await done.registry.start("feishu");
  done.flow.resolve(CREDS);
  await settle();
  assert.equal((await done.registry.status()).phase, "done");
  assert.equal((await done.registry.status()).link, undefined, "the user already scanned it");
});

test("a run that finishes first cancels the timer, so nothing fires later", async () => {
  const { registry, calls, flow } = harness();
  await registry.start("feishu");
  flow.resolve(CREDS);
  await settle();
  assert.equal((await registry.status()).phase, "done");
  assert.equal(calls.timers[0].cancelled, true);
  // And firing it now is inert — the latch is what makes a late expiry harmless.
  calls.timers[0].callback();
  assert.equal((await registry.status()).phase, "done", "a timer that lost the race must not overwrite the result");
});

// --- enableFeishuConfig -----------------------------------------------------

test("enabling Feishu writes the whole section, not a fragment", async () => {
  // A fragment save is a deletion (0.9.2): the settings plane merges nothing.
  const before = {
    channels: ["web", "telegram"],
    channelDefaults: { language: "en" },
    telegram: { pollIntervalMs: 2000 },
    feishu: { requireMention: true },
  };
  const after = enableFeishuConfig(before, ["feishu", "telegram", "dingtalk", "web"]);
  assert.deepEqual(after.channels, ["web", "telegram", "feishu"]);
  assert.deepEqual(after.channelDefaults, { language: "en" });
  assert.deepEqual(after.telegram, { pollIntervalMs: 2000 });
  assert.deepEqual(after.feishu, { requireMention: true, transport: "websocket" });
  // It composes; it does not mutate the caller's section.
  assert.deepEqual(before.channels, ["web", "telegram"]);
  assert.deepEqual(before.feishu, { requireMention: true });
});

test("the enable write is idempotent and never duplicates feishu", () => {
  const once = enableFeishuConfig({ channels: ["feishu"], feishu: { transport: "websocket" } }, ["feishu", "web"]);
  const twice = enableFeishuConfig(once, ["feishu", "web"]);
  assert.deepEqual(twice.channels, ["feishu"]);
  assert.deepEqual(twice.feishu, { transport: "websocket" });
});

test("a section with no channels key falls back to every known channel", () => {
  // Same posture as the plugin's activation default: no `channels` means "all
  // built-ins", and narrowing that here would silently disable channels.
  const after = enableFeishuConfig({ feishu: null }, ["feishu", "telegram", "dingtalk", "web"]);
  assert.deepEqual(after.channels, ["feishu", "telegram", "dingtalk", "web"]);
  assert.deepEqual(after.feishu, { transport: "websocket" });
});
