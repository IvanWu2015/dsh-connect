/**
 * Sliding-window duplicate guard for inbound messages.
 *
 * Channel SDKs can re-deliver the same event after a reconnect (the Feishu
 * WebSocket dispatcher does this), which would otherwise queue the same user
 * message twice. Each inbound message carries a stable per-message id in
 * `replyRef`; keys are (channel, chatKey, messageId) within a recency window.
 * Messages without an id (not all channels set one) are never deduplicated.
 * @module dsh-connect/dedup
 */
export class InboundDedup {
  /** key → last-seen timestamp */
  private readonly seen = new Map<string, number>();

  constructor(
    /** Re-delivery of the same id inside this window is a duplicate (default 5 min). */
    private readonly windowMs = 5 * 60_000,
    /** Hard cap on remembered ids; oldest entries are dropped beyond it. */
    private readonly maxEntries = 1024,
  ) {}

  /**
   * Record the message and report whether an identical id was already seen
   * within the window. Side-effect free for messages without an id.
   */
  isDuplicate(channel: string, chatKey: string, messageId: string | undefined, now = Date.now()): boolean {
    if (messageId === undefined || messageId === "") return false;
    const key = `${channel}\u0000${chatKey}\u0000${messageId}`;
    const previous = this.seen.get(key);
    this.seen.set(key, now);
    if (this.seen.size > this.maxEntries) this.prune(now);
    return previous !== undefined && now - previous < this.windowMs;
  }

  /** Forget ids older than the window, then the oldest beyond the cap. */
  private prune(now: number): void {
    for (const [key, timestamp] of this.seen) {
      if (now - timestamp >= this.windowMs) this.seen.delete(key);
    }
    if (this.seen.size > this.maxEntries) {
      const byAge = [...this.seen.entries()].sort((a, b) => a[1] - b[1]);
      const overflow = this.seen.size - this.maxEntries;
      for (let i = 0; i < overflow; i++) this.seen.delete(byAge[i][0]);
    }
  }
}
