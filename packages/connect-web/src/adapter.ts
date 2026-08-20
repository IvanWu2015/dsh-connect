/**
 * Web channel adapter for dsh-connect: mirrors Feishu conversations to DSH Web GUI.
 * This adapter monitors BindingStore for webMirrorSessionId changes and exposes
 * those sessions to the Web GUI through the standard ChannelAdapter interface.
 * @module dsh-connect-web/adapter
 */
import type {
  ChannelAdapter,
  ChoicePrompt,
  ChoiceResult,
  InboundMessage,
  OutboundTarget,
  SummaryCard,
} from "dsh-connect";
import type { BindingStore, ChatBinding } from "dsh-connect/binding";

/**
 * WebAdapter provides a bridge between dsh-connect's mirror sessions and the
 * DSH Web GUI. It monitors the BindingStore for chats that have been mirrored
 * (have webMirrorSessionId set) so the GUI can open the shared session.
 *
 * Honest limitations (documented in README):
 * - The Web GUI reads mirrored sessions directly from DSH's session store; it
 *   never sends inbound messages through this adapter. The mirror "lock"
 *   (lockOwner) is therefore enforced only on the Feishu side — the Web side
 *   is write-always and cannot be fixed from this repository.
 * - Outbound methods (sendText / sendCard / streamText / promptChoice /
 *   closeMenu) are no-ops by design: the agent writes events into the shared
 *   session store, and the GUI renders them. They exist only to satisfy the
 *   ChannelAdapter contract.
 */
export class WebAdapter implements ChannelAdapter {
  readonly id = "web";

  private handler?: (msg: InboundMessage) => void | Promise<void>;
  private readonly bindings: BindingStore;
  private readonly pollIntervalMs: number;
  private pollTimer?: NodeJS.Timeout;
  private unsubscribe?: () => void;
  private readonly knownMirrors = new Map<string, string>(); // sessionId -> chatKey

  /**
   * Create a WebAdapter instance.
   * @param bindings - The BindingStore to monitor for mirror sessions
   * @param options - Optional configuration
   */
  constructor(
    bindings: BindingStore,
    options: { pollIntervalMs?: number } = {},
    private readonly logger?: { warn?: (...args: unknown[]) => void },
  ) {
    this.bindings = bindings;
    this.pollIntervalMs = options.pollIntervalMs ?? 1000; // Default 1 second polling
  }

  onInbound(handler: (msg: InboundMessage) => void | Promise<void>): void {
    this.handler = handler;
  }

  /**
   * Start monitoring for mirror sessions.
   * Uses event-driven detection with fallback polling.
   */
  async start(): Promise<void> {
    // Subscribe to binding changes for real-time detection
    this.unsubscribe = this.bindings.onChange((binding, changeType) => {
      if (binding.webMirrorSessionId !== undefined) {
        this.recordMirror(binding);
      } else if (changeType === "delete") {
        this.knownMirrors.delete(binding.sessionId);
      }
    });

    // Initial scan for existing mirrors
    this.scanForMirrors();

    // Fallback polling in case events are missed
    this.pollTimer = setInterval(() => {
      this.scanForMirrors();
    }, this.pollIntervalMs);
  }

  /**
   * Stop monitoring and clean up resources.
   */
  async stop(): Promise<void> {
    if (this.unsubscribe !== undefined) {
      this.unsubscribe();
      this.unsubscribe = undefined;
    }
    if (this.pollTimer !== undefined) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  /**
   * Record a newly-detected mirror session. Mirror tracking is purely
   * bookkeeping: the mirror is visible in DSH Web through the session store
   * itself, and synthesizing an inbound "mirror created" message here would
   * spin up a spurious web runner and burn a real agent turn — so we do NOT
   * route anything through the handler.
   */
  private recordMirror(binding: ChatBinding): void {
    const sessionId = binding.webMirrorSessionId;
    if (sessionId === undefined) return;
    const chatKey = `${binding.channel}:${binding.chatKey}`;
    if (!this.knownMirrors.has(sessionId)) {
      this.knownMirrors.set(sessionId, chatKey);
    }
  }

  /**
   * Scan BindingStore for chats with webMirrorSessionId set and record any
   * new mirrors.
   */
  private scanForMirrors(): void {
    try {
      const bindings = this.bindings.list?.() ?? [];
      for (const binding of bindings) {
        if (binding.webMirrorSessionId !== undefined) {
          this.recordMirror(binding);
        }
      }
    } catch {
      // BindingStore may not have list() in older versions — rely on events.
    }
  }

  /**
   * Check if a session is mirrored and available for Web access.
   * @param sessionId - The session ID to check
   */
  isSessionMirrored(sessionId: string): boolean {
    return this.knownMirrors.has(sessionId);
  }

  /**
   * Get the source chat key for a mirrored session.
   * @param sessionId - The session ID
   * @returns The original channel:chatKey or undefined if not mirrored
   */
  getMirrorSource(sessionId: string): string | undefined {
    return this.knownMirrors.get(sessionId);
  }

  /**
   * Send text message to Web GUI.
   * No-op: the Web GUI pulls content from DSH session events, not from adapter
   * calls. Kept only to satisfy the ChannelAdapter contract.
   */
  async sendText(_target: OutboundTarget, _text: string): Promise<void> {
    // The agent writes session events; the GUI renders them.
  }

  /**
   * Send summary card to Web GUI. No-op — see {@link sendText}.
   */
  async sendCard(_target: OutboundTarget, _card: SummaryCard): Promise<void> {
    // No-op by design.
  }

  /**
   * Stream text chunks to Web GUI.
   * The agent already writes chunks into the session; consume the iterable so
   * the producer never stalls on backpressure.
   */
  async streamText(_target: OutboundTarget, chunks: AsyncIterable<string>): Promise<void> {
    for await (const _chunk of chunks) {
      // Already delivered via session events.
    }
  }

  /**
   * Present interactive choice prompt.
   * No-op: the Web GUI renders choices through its own interaction system.
   */
  async promptChoice(_target: OutboundTarget, _prompt: ChoicePrompt, updateMessageId?: string): Promise<ChoiceResult> {
    return {
      choice: undefined,
      messageId: updateMessageId ?? `web-${Date.now()}`,
    };
  }

  /**
   * Close a menu/card in Web GUI. No-op — see {@link sendText}.
   */
  async closeMenu(_messageId: string, _summary: string): Promise<void> {
    // No-op by design.
  }
}
