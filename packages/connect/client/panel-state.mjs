/**
 * Which channel cards the settings pane shows open, which fields hide behind
 * each card's "advanced" fold, and how a snapshot's failure reports — and a
 * one-click onboarding run's outcome — become the list the pane renders.
 *
 * Dependency-free and separate from the React component for the same reason
 * `locale.mjs` is: these rules are the interesting part, they are pure, and a
 * test can pin them without a DOM. The bundle test in particular cannot — it
 * renders the component with pre-supplied hook values, so it can never observe
 * what the component *initializes* to. Only this module can answer that.
 */

/**
 * Fields that are set once and then left alone, grouped by channel.
 *
 * These are what makes the pane tall: with every channel expanded the pane
 * renders 20 field blocks, each a label + input + preview + hint. Folding the
 * rarely-touched ones behind a second-level disclosure keeps the common case —
 * credentials plus the handful of behavioural switches — on one screen.
 * `test/panel-state.test.mjs` asserts every key here really exists in
 * `CHANNEL_CONFIG_FIELDS`, because a typo would silently drop a field from the
 * UI rather than fail anything.
 */
export const ADVANCED_KEYS = {
  feishu: ['webhookPort', 'webhookPath'],
  telegram: ['pollingTimeoutSeconds', 'baseUrl'],
  dingtalk: ['defaultAt'],
  web: ['pollIntervalMs'],
};

/** True when `key` is one of `channel`'s low-frequency fields. */
export function isAdvanced(channel, key) {
  return (ADVANCED_KEYS[channel] ?? []).includes(key);
}

/**
 * The channels whose card starts open: the enabled ones, or — when nothing is
 * enabled at all — the first channel, so the pane never opens as a wall of
 * collapsed headers with no contents in sight.
 *
 * Unknown names are filtered out rather than trusted: `enabled` comes from the
 * host and would otherwise open a card that does not exist.
 */
export function initialOpenChannels(enabled, all) {
  const open = (enabled ?? []).filter((ch) => all.includes(ch));
  return new Set(open.length > 0 ? open : all.slice(0, 1));
}

/** Toggle one key in a Set, returning a new Set (never mutating the argument). */
export function toggleInSet(set, key) {
  const next = new Set(set);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

/**
 * Turn a snapshot's failure reports into the pane's render-ready issue list:
 * `{kind, key}` plus the fields that kind needs. Three kinds —
 *
 * - `credentialUnknown` — the stored credentials could not be *read*, so
 *   presence is unknown and the channel must not be labelled 「未配置凭据」
 *   (that sends the user to re-enter a secret that was never the problem).
 * - `warning` — a code from the host (`w.<code>` in the locale), e.g. a secret
 *   that is stored but that the running adapters did not pick up.
 * - `channelFailed` — a channel whose adapter threw on start, with the adapter's
 *   own reason. The reason is passed through verbatim rather than mapped to a
 *   code: it is the only part that says *which* credential or option is wrong.
 *
 * `warnings` is the union the caller has collected across a whole save chain and
 * defaults to this snapshot's own. The split is deliberate: the two error lists
 * are *state of the world* — the host re-derives them on every call — so the
 * last snapshot is the truth, and merging in earlier ones would strand an entry
 * for a channel that has since recovered. A warning is about a single call, so
 * it has to survive the call that raised it.
 *
 * `key` is stable per issue and carries no index, so React reconciles a list
 * that reorders instead of remounting every row.
 */
export function snapshotIssues(snap, warnings) {
  const issues = [];
  for (const channel of snap?.credentialErrors ?? []) {
    issues.push({ kind: 'credentialUnknown', channel, key: `credentialUnknown:${channel}` });
  }
  for (const code of warnings ?? snap?.warnings ?? []) {
    issues.push({ kind: 'warning', code, key: `warning:${code}` });
  }
  for (const [channel, reason] of Object.entries(snap?.channelErrors ?? {})) {
    issues.push({ kind: 'channelFailed', channel, reason, key: `channelFailed:${channel}` });
  }
  return issues;
}

/**
 * Turn an onboarding outcome — what the one-click flow actually did — into the
 * same render-ready list `snapshotIssues` builds for a snapshot.
 *
 * Kept separate from `snapshotIssues` because the two have different lifetimes.
 * A snapshot describes the state of the world and the host re-derives it on every
 * call, so the pane may replace its list wholesale; the outcome is a *report on
 * one run* and has to survive the saves that follow it, which is why the pane
 * derives these lines at render time instead of appending them to `notices`.
 *
 * Every fact that is true gets its own line and none of them are merged into a
 * single 「已创建并配置完成」. The split that matters most is
 * `credentialsStored` + `applied`: the secret is in the store, *and* the running
 * adapters may yet have failed to pick it up. Reporting only the first is the lie
 * this whole feature exists to stop telling — the user is on this page because
 * their bot went silent, so 「已保存」 over a bot that is still silent is the one
 * answer worse than an error.
 *
 * `key` carries no index, like `snapshotIssues`.
 */
export function onboardingIssues(outcome) {
  // No flow has run — the ordinary case, and it must render nothing at all.
  if (!outcome) return [];
  const issues = [];
  const push = (code, extra) => issues.push({
    kind: 'onboarding',
    code,
    key: `onboarding:${code}`,
    ...(extra?.reason === undefined ? {} : { reason: extra.reason }),
    ...(extra?.appId === undefined ? {} : { appId: extra.appId }),
  });

  // Nothing was created, so the reason *is* the whole report. `created` stays
  // false on every pre-creation exit — the user's cancel, the device-code
  // expiry, and a `registerApp` that threw — and those three share no other
  // field, so the reason string is the only discriminator available.
  if (!outcome.created) {
    const code = outcome.reason === "abort" ? "cancelled"
      : outcome.reason === "expired_token" ? "expired"
        : "createFailed";
    push(code, { reason: outcome.reason });
    return issues;
  }

  push("created", { appId: outcome.appId });
  push(outcome.credentialsStored ? "credentialsStored" : "credentialsNotStored");
  // The legacy mirror is the file the pre-credential-store versions read. Worth
  // a line only when it is the *only* copy that failed to land: with the
  // credential store written, a dead mirror changes nothing for this host.
  if (!outcome.credentialsStored && !outcome.legacyMirrorWritten) push("legacyMirrorFailed");
  push(outcome.enableRequested ? "enableRequested" : "enableFailed");

  // Four states, not three: `not-attempted` means the flow never got this far,
  // which is not the same statement as `skipped` ("there were no credentials to
  // subscribe with") and must not borrow its wording.
  const subscription = outcome.subscription ?? {};
  const subscriptionCode = subscription.status === "applied" ? "applied"
    : subscription.status === "failed" ? "failed"
      : subscription.status === "not-attempted" ? "notAttempted"
        : "skipped";
  push(`subscription.${subscriptionCode}`, { reason: subscription.reason });
  if (subscription.needsManualAction === true) push("needsManual");

  // The second half of 「已落盘 ≠ 已生效」, on its own line. `pending` is its own
  // case and not a shade of `yes`: it is what a flow that was cancelled or that
  // died after creating the app leaves behind.
  if (outcome.applied === "no") push("notApplied");
  else if (outcome.applied !== "yes") push("applyPending");

  return issues;
}
