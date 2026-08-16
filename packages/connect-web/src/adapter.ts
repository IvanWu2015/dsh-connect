/**
 * Web channel adapter for dsh-connect: mirrors Feishu conversations to DSH Web GUI.
 * This adapter monitors BindingStore for webMirrorSessionId changes and exposes
 * those sessions to the Web GUI through the standard ChannelAdapter interface.
 * @module dsh-connect-web/adapter
 */
import type {
  ChannelAdapter,
  ChoiceOption,
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
 * (have webMirrorSessionId set) and exposes them as inbound messages to the
 * Web GUI.
 * 
 * Key features:
 * - Automatic detection of mirrored Feishu conversations
 * - Session lock awareness (respects lockOwner for write access)
 * - Message queuing when lock is held by another channel
 * - Real-time synchronization with BindingStore changes
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
    options: { pollIntervalMs?: number } = {}
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
        this.handleMirrorDetected(binding);
      } else if (changeType === "delete") {
        // Handle mirror removal if needed
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
   * Handle detection of a new or updated mirror session.
   */
  private handleMirrorDetected(binding: ChatBinding): void {
    const sessionId = binding.webMirrorSessionId;
    if (sessionId === undefined) return;
    
    const chatKey = `${binding.channel}:${binding.chatKey}`;
    
    // Check if this is a new mirror we haven't seen before
    if (!this.knownMirrors.has(sessionId)) {
      this.knownMirrors.set(sessionId, chatKey);
      
      // Synthesize an inbound message to notify Web GUI about the mirror
      if (this.handler !== undefined) {
        const msg: InboundMessage = {
          channel: "web",
          chatKey: sessionId, // Use session ID as chat key for Web
          chatType: binding.chatType,
          senderKey: "system",
          text: `[Mirror] Feishu conversation mirrored from ${binding.channel}:${binding.chatKey}`,
          replyRef: undefined,
        };
        
        void this.handler(msg).catch((error) => {
          console.error(`[WebAdapter] Failed to handle mirror notification: ${String(error)}`);
        });
      }
    }
  }

  /**
   * Scan BindingStore for chats with webMirrorSessionId set.
   * For each new mirror found, synthesize an inbound message to notify
   * the Web GUI about the available session.
   */
  private scanForMirrors(): void {
    try {
      // Use the new entries() method if available
      const bindings = this.bindings.list?.() ?? [];
      for (const binding of bindings) {
        if (binding.webMirrorSessionId !== undefined) {
          this.handleMirrorDetected(binding);
        }
      }
    } catch {
      // Fallback: BindingStore may not have list() method in older versions
      // In that case, rely solely on event-based detection
    }
  }

  /**
   * Check if a session is mirrored and available for Web access.
   * @param sessionId - The session ID to check
   * @returns True if the session is mirrored and accessible
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
   * Get the lock status for a mirrored session.
   * @param sessionId - The session ID to check
   * @returns Lock owner ("feishu" | "web") or undefined if no lock
   */
  getSessionLock(sessionId: string): "feishu" | "web" | undefined {
    // Find the binding that has this sessionId as webMirrorSessionId
    const bindings = this.bindings.findByWebMirror?.(sessionId) ?? [];
    for (const binding of bindings) {
      if (binding.lockOwner !== undefined) {
        return binding.lockOwner;
      }
    }
    return undefined;
  }

  /**
   * Send text message to Web GUI.
   * In the Web context, this typically means updating the session state
   * rather than pushing to a client.
   */
  async sendText(target: OutboundTarget, text: string): Promise<void> {
    // Web GUI pulls messages from session events, so this is a no-op
    // The actual message delivery happens through DSH's session system
    console.log(`[WebAdapter] sendText to ${target.chatKey}: ${text.slice(0, 100)}...`);
  }

  /**
   * Send summary card to Web GUI.
   */
  async sendCard(target: OutboundTarget, card: SummaryCard): Promise<void> {
    console.log(`[WebAdapter] sendCard to ${target.chatKey}: ${card.markdown.slice(0, 100)}...`);
  }

  /**
   * Stream text chunks to Web GUI.
   * Web GUI handles streaming through its own SSE/WebSocket mechanism.
   */
  async streamText(target: OutboundTarget, chunks: AsyncIterable<string>): Promise<void> {
    // Consume the iterable but actual delivery is through DSH session events
    for await (const chunk of chunks) {
      // Chunk is already being written to session by the agent
    }
  }

  /**
   * Present interactive choice prompt.
   * Web GUI renders choices through its own UI components.
   */
  async promptChoice(
    target: OutboundTarget,
    prompt: ChoicePrompt,
    updateMessageId?: string
  ): Promise<ChoiceResult> {
    // Web GUI handles choice prompts through its own interaction system
    // This adapter doesn't directly interact with Web UI
    return {
      choice: undefined,
      messageId: updateMessageId ?? `web-${Date.now()}`,
    };
  }

  /**
   * Close a menu/card in Web GUI.
   */
  async closeMenu(messageId: string, summary: string): Promise<void> {
    console.log(`[WebAdapter] closeMenu ${messageId}: ${summary}`);
  }

  /**
   * Queue a message for later processing when lock is released.
   * Used when Web tries to send while Feishu holds the lock.
   */
  queueMessageForSession(
    channel: string,
    chatKey: string,
    text: string,
    senderKey: string
  ): number {
    const binding = this.bindings.get(channel, chatKey);
    if (binding === undefined) return -1;

    const queued = binding.queuedMessages ?? [];
    queued.push({ text, senderKey, timestamp: Date.now() });
    
    this.bindings.put({ ...binding, queuedMessages: queued });
    return queued.length;
  }

  /**
   * Check if Web can write to a session (lock check).
   * @param channel - The channel requesting access
   * @param chatKey - The chat key
   * @returns True if write access is allowed
   */
  canWrite(channel: string, chatKey: string): boolean {
    const binding = this.bindings.get(channel, chatKey);
    if (binding?.lockOwner === undefined) return true;
    
    // Check timeout
    if (this.isLockTimedOut(binding)) {
      return true;
    }
    
    return binding.lockOwner === channel;
  }

  /**
   * Check if a lock has timed out.
   */
  private isLockTimedOut(binding: ChatBinding): boolean {
    if (binding.lockOwner === undefined || binding.lockAcquiredAt === undefined) {
      return false;
    }
    
    const timeoutMs = binding.lockTimeoutMs ?? 5 * 60 * 1000; // Default 5 minutes
    const elapsed = Date.now() - binding.lockAcquiredAt;
    return elapsed > timeoutMs;
  }
}
