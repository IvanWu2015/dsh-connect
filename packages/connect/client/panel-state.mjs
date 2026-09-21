/**
 * Which channel cards the settings pane shows open, and which fields hide behind
 * each card's "advanced" fold.
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
