/**
 * Which channel cards the settings pane shows open, which fields hide behind
 * each card's "advanced" fold, and how a snapshot's failure reports become the
 * list the pane renders.
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
