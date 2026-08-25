/**
 * Bounded outbound retry for channel deliveries.
 *
 * The core wraps every registered adapter's delivery methods (sendText /
 * sendCard / promptChoice / closeMenu) so a transient channel failure —
 * network blip, 429, 5xx — retries a few times with jittered exponential
 * backoff instead of silently dropping a user-visible message. streamText is
 * deliberately NOT retried: a partially-streamed reply cannot be resumed, and
 * restarting it would duplicate the streaming card.
 * @module dsh-connect/retry
 */
import type { ChannelAdapter } from "./types.js";

export interface RetryOptions {
  /** Total attempts including the first call (default 3). */
  attempts?: number;
  /** Base delay between attempts in ms (default 250). */
  baseDelayMs?: number;
  /** Cap for a single delay in ms (default 2000). */
  maxDelayMs?: number;
  /**
   * Decide whether an error is worth retrying. Defaults to retrying every
   * error — bounded attempts keep permanent failures cheap (a few extra
   * channel calls), while transient ones actually recover.
   */
  isTransient?: (error: unknown) => boolean;
}

/** Run `fn` with bounded, jittered exponential backoff on failure. */
export async function retry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? 3);
  const baseDelayMs = Math.max(0, options.baseDelayMs ?? 250);
  const maxDelayMs = Math.max(1, options.maxDelayMs ?? 2000);
  const isTransient = options.isTransient ?? (() => true);
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || !isTransient(error)) throw error;
      const backoff = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      const jitter = backoff * 0.25 * Math.random();
      await new Promise((resolve) => setTimeout(resolve, Math.round(backoff + jitter)));
    }
  }
  throw lastError;
}

/**
 * Wrap an adapter so its delivery methods retry transient failures.
 * Non-delivery faces (start/stop/onInbound) and streamText pass through
 * untouched.
 */
export function withOutboundRetry(adapter: ChannelAdapter, options: RetryOptions = {}): ChannelAdapter {
  return {
    id: adapter.id,
    start: () => adapter.start(),
    stop: () => adapter.stop(),
    onInbound: (handler) => adapter.onInbound(handler),
    sendText: (target, text) => retry(() => adapter.sendText(target, text), options),
    sendCard: (target, card) => retry(() => adapter.sendCard(target, card), options),
    promptChoice: (target, prompt, updateMessageId) => retry(() => adapter.promptChoice(target, prompt, updateMessageId), options),
    closeMenu: (messageId, summary) => retry(() => adapter.closeMenu(messageId, summary), options),
    streamText: (target, chunks) => adapter.streamText(target, chunks),
  };
}
