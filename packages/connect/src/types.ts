/**
 * Channel-agnostic vocabulary shared between the `dsh-connect` core and every
 * channel adapter (Feishu first, DingTalk/WeChat later).
 * @module dsh-connect/types
 */

/** Coarse chat surface classification: one-on-one or group. */
export type ChatType = "p2p" | "group";

/** A normalized inbound message from any channel. */
export interface InboundMessage {
  /** Channel adapter id that produced this message, e.g. `"feishu"`. */
  readonly channel: string;
  /** Stable chat key the adapter owns (open_id / chat_id, …). */
  readonly chatKey: string;
  readonly chatType: ChatType;
  /** Stable sender key (open_id / user_id, …). */
  readonly senderKey: string;
  /** Plain-text body (adapters normalize rich media to text + tags). */
  readonly text: string;
  /** Opaque reference to the triggering message, for replying in-thread. */
  readonly replyRef?: string;
  /** Local file paths of images attached to the message (downloaded by the adapter). */
  readonly images?: readonly string[];
  /** Local file paths of non-image attachments (files/audio/video) downloaded by the adapter. */
  readonly files?: readonly string[];
  /** Set when image download failed (e.g. missing im:resource permission). */
  readonly imageError?: string;
  /** Set when a non-image attachment download failed. */
  readonly fileError?: string;
}

/** Where an outbound message goes. */
export interface OutboundTarget {
  readonly chatKey: string;
  readonly chatType: ChatType;
  readonly replyRef?: string;
  /** Channel-specific user ids to @-mention on delivery (groups only; best-effort). */
  readonly atUsers?: readonly string[];
}

/** A brief status card pushed on turn completion or error. */
export interface SummaryCard {
  readonly markdown: string;
}

/** One selectable option in an interactive choice prompt. */
export interface ChoiceOption {
  /** Opaque id returned to the caller when this option is chosen. */
  readonly id: string;
  readonly label: string;
}

/** One named group of a choice prompt; `ids` refer to `ChoicePrompt.options`. */
export interface ChoiceSection {
  readonly title?: string;
  /** Option ids belonging to this section, in display order. */
  readonly ids: readonly string[];
  /** Number of columns per row for this section (overrides prompt default). */
  readonly columnsPerRow?: number;
}

/** An interactive single-choice prompt rendered by the channel as buttons. */
export interface ChoicePrompt {
  readonly title: string;
  readonly description?: string;
  readonly options: readonly ChoiceOption[];
  /** Optional named groups — channels render these as separated sections. */
  readonly sections?: readonly ChoiceSection[];
  /** Optional footnote rendered at the bottom of the card. */
  readonly footer?: string;
  /** Number of columns per row for button grid (default: 2). Use 1 for full-width items. */
  readonly columnsPerRow?: number;
}

/** Result of an interactive choice: the picked option and the card's message id. */
export interface ChoiceResult {
  readonly choice: string | undefined;
  /** Message id of the card; pass it back as `updateMessageId` to reuse the card. */
  readonly messageId: string;
}

/** Why a driven turn ended. */
export type TurnReason =
  | "completed"
  | "aborted"
  | "blocked"
  | "error"
  | "max-tokens"
  | "interrupted"
  | "unknown";

/** Settled outcome of one agent turn. */
export interface TurnOutcome {
  readonly reason: TurnReason;
  /** Last non-empty assistant text of the turn. */
  readonly text: string;
  readonly code?: string;
  readonly message?: string;
  /** `provider/model` used by the turn's last LLM request. */
  readonly model?: string;
  /** Total input tokens (sum of every request) across the turn. */
  readonly inputTokens?: number;
  /** Total output tokens across the turn. */
  readonly outputTokens?: number;
  /** Total cache-read tokens across the turn. */
  readonly cacheReadTokens?: number;
  /** Input tokens of the turn's last request (≈ current context size). */
  readonly contextSize?: number;
  /** Context window of the turn's last request (for compaction advice). */
  readonly contextWindow?: number;
  /** Number of steps executed in the turn. */
  readonly steps?: number;
  /** Wall-clock duration of the turn (from `turn/start` to `turn/end`). */
  readonly elapsedMs?: number;
}

/** Push-based async iterable bridge: producers push, consumers `for await`. */
export interface AsyncQueue<T> extends AsyncIterable<T> {
  push(value: T): void;
  end(): void;
}

/**
 * A channel's transport face. The core drives agents and hands the adapter
 * normalized text; the adapter owns wire encoding, streaming, and auth policy.
 */
export interface ChannelAdapter {
  readonly id: string;
  /** Establish the long-connection / subscription; must be reconnect-safe. */
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Deliver one text/markdown message (best-effort, non-streaming). */
  sendText(target: OutboundTarget, text: string): Promise<void>;
  /** Deliver a status/summary card. */
  sendCard(target: OutboundTarget, card: SummaryCard): Promise<void>;
  /**
   * Deliver a local file (image / document / audio / video) to the chat.
   * Optional: channels without file support omit it, and the runner falls
   * back to sending the file's path as text.
   */
  sendFile?(target: OutboundTarget, filePath: string, options?: { filename?: string }): Promise<void>;
  /**
   * Stream `chunks` into one progressively-updated reply. Resolves when the
   * producer is exhausted (`chunks` ends) and the adapter has finalized it.
   */
  streamText(target: OutboundTarget, chunks: AsyncIterable<string>): Promise<void>;
  /**
   * Present an interactive single-choice prompt. When `updateMessageId` is given,
   * reuse that card (replace its content in place) instead of sending a new one —
   * this is what lets a menu chain navigate on a single card. Resolves with the
   * picked option id (or `undefined` on dismiss/timeout) plus the card message id.
   */
  promptChoice(target: OutboundTarget, prompt: ChoicePrompt, updateMessageId?: string): Promise<ChoiceResult>;
  /** Replace a menu card with a completion notice (closes the interaction). */
  closeMenu(messageId: string, summary: string): Promise<void>;
  /** Register the inbound handler; called for every normalized message. */
  onInbound(handler: (msg: InboundMessage) => void | Promise<void>): void;
}
