/**
 * The per-channel access state the settings pane reports.
 *
 * Two different facts live here and are deliberately kept apart:
 *
 * - **What the runtime knows** — is the channel enabled at all, did its `start`
 *   throw, is it currently up. This is evidence the runtime owns, and it covers
 *   every channel equally.
 * - **What the transport knows** — for a channel whose long-connection library
 *   can report a live socket state (Feishu's `LarkChannel.getConnectionStatus`),
 *   the real `connecting`/`connected`/`reconnecting` progression, including how
 *   many reconnect attempts are in flight.
 *
 * A channel with no transport probe is reported as `running`, which is exactly
 * what is known about it — never as `connected`, which would be an invention.
 *
 * @module dsh-connect/settings/channel-status
 */

/**
 * Every state the pane can show. Exported as a real array (rather than a bare
 * type) so the locale test can derive the `cs.<state>` key list from it and
 * fail when a translation is missing, instead of keeping a hand-copied list that
 * goes stale the first time a state is added.
 */
export const CHANNEL_CONNECTION_STATES = [
  /** Not in `channels` — switched off, so nothing was ever started. */
  'disabled',
  /** Enabled, but nothing is running and `start` did not throw (yet). */
  'stopped',
  /** Enabled and `start` (or its reconcile) threw; the reason is in `channelErrors`. */
  'failed',
  /** Up, and the channel has no finer probe to offer. */
  'running',
  /** Transport states, verbatim from a channel that can report them. */
  'idle',
  'connecting',
  'connected',
  'reconnecting',
] as const;

export type ChannelConnectionState = (typeof CHANNEL_CONNECTION_STATES)[number];

export interface ChannelConnectionStatus {
  state: ChannelConnectionState;
  /**
   * Reconnect attempts in flight, when the transport reports them. Omitted
   * rather than zeroed when not applicable, so "no attempts to mention" and
   * "one attempt so far" can't be confused at the render site.
   */
  attempts?: number;
}

const STATE_SET: ReadonlySet<string> = new Set(CHANNEL_CONNECTION_STATES);

/** Narrow an untrusted string (e.g. a foreign SDK state) to a known state. */
export function isChannelConnectionState(value: unknown): value is ChannelConnectionState {
  return typeof value === 'string' && STATE_SET.has(value);
}

/** The transport-facing half of a status, as an adapter reports it. */
export type ChannelStatusProbe = (id: string) => ChannelConnectionStatus | undefined;

/**
 * Compose one status per channel from the runtime's evidence plus, where
 * available, the channel's own transport probe.
 *
 * `channels` is the pane's full channel list, so every card gets a row — a
 * switched-off channel answering 「未启用」 is information, while a missing row
 * would be indistinguishable from "the host cannot tell".
 *
 * `enabled` is passed *in* rather than re-derived on purpose: the caller has
 * already computed the enabled set for the same snapshot, so taking it here is
 * what makes the badge and the snapshot's `enabled` field unable to disagree
 * about which channels are switched on.
 *
 * Pure by construction (no I/O, no clock, no logging) so every branch is
 * unit-testable; the caller owns the try/catch around the probe.
 */
export function composeChannelStatus(input: {
  channels: readonly string[];
  enabled: readonly string[];
  active: readonly string[];
  failures: Record<string, string>;
  probe: ChannelStatusProbe;
}): Record<string, ChannelConnectionStatus> {
  const enabled = new Set(input.enabled);
  const active = new Set(input.active);
  const out: Record<string, ChannelConnectionStatus> = {};
  // The union keeps an unknown-but-running or unknown-but-failed id from being
  // dropped silently: config is the source of truth for "enabled", but a
  // channel the runtime is holding is still a fact worth reporting.
  const ids = new Set<string>([...input.channels, ...input.active, ...Object.keys(input.failures)]);
  for (const id of ids) {
    if (!enabled.has(id)) {
      out[id] = { state: 'disabled' };
      continue;
    }
    if (input.failures[id] !== undefined) {
      out[id] = { state: 'failed' };
      continue;
    }
    if (!active.has(id)) {
      out[id] = { state: 'stopped' };
      continue;
    }
    const probed = input.probe(id);
    if (probed === undefined) {
      out[id] = { state: 'running' };
      continue;
    }
    const attempts = probed.attempts;
    out[id] =
      attempts !== undefined && attempts > 0 ? { state: probed.state, attempts } : { state: probed.state };
  }
  return out;
}
