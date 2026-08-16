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
  /** Set when image download failed (e.g. missing im:resource permission). */
  readonly imageError?: string;
}

/** Where an outbound message goes. */
export interface OutboundTarget {
  readonly chatKey: string;
  readonly chatType: ChatType;
  readonly replyRef?: string;
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

/** An interactive single-choice prompt rendered by the channel as buttons. */
export interface ChoicePrompt {
  readonly title: string;
  readonly description?: string;
  readonly options: readonly ChoiceOption[];
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
