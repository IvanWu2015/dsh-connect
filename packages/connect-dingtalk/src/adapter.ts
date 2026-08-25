/**
 * DingTalk stream-mode channel adapter: bidirectional bot over the stream
 * gateway. Inbound messages arrive via STOMP push, replies are SENT back to
 * the triggering message's msgId.
 *
 * Capability notes (honest scope):
 * - Group replies require an @-mention (requireMention, default true) — the
 *   gateway pushes every group message, so the adapter gates on isInAtList.
 * - Interactive menus render as a numbered text list: the user answers with a
 *   number and the adapter resolves the choice. Real action-card buttons are
 *   out of scope for this release.
 * - `streamText` accumulates the full reply and sends it once (the stream
 *   gateway has no progressive card editing).
 * - Proactive pushes (reminders / broadcasts) still use the webhook service;
 *   the stream adapter can only reply to inbound messages.
 * @module dsh-connect-dingtalk/adapter
 */
import type {
  ChannelAdapter,
  ChoiceOption,
  ChoicePrompt,
  ChoiceResult,
  InboundMessage,
  Language,
  OutboundTarget,
  SummaryCard,
} from "dsh-connect";
import { DingtalkStreamClient } from "./stream.js";
import {
  buildMarkdownReplyBody,
  buildTextReplyBody,
  isAtMentioned,
  normalizeBotMessage,
  type DingtalkBotMessage,
} from "./message.js";
import { dingtalkMessages, type DingtalkMessages } from "./i18n.js";

export interface DingtalkStreamAdapterConfig {
  clientId: string;
  clientSecret: string;
  /** Gateway URL override (default wss://api.dingtalk.com/connect). */
  url?: string;
  /** Group messages must @-mention the bot (default true). */
  requireMention?: boolean;
  language?: Language;
}

const CHOICE_TIMEOUT_MS = 60_000;

/** One pending text-menu answer, keyed by the opaque menu message id. */
interface PendingMenu {
  conversationId: string;
  options: readonly ChoiceOption[];
  timer: NodeJS.Timeout;
  resolve: (choice: string | undefined) => void;
}

/**
 * Bidirectional DingTalk adapter (stream mode). Deliberately text-forward:
 * no card editing, no button callbacks — just normalized text both ways.
 */
export class DingtalkStreamAdapter implements ChannelAdapter {
  readonly id = "dingtalk";
  private readonly client: DingtalkStreamClient;
  private readonly t: DingtalkMessages;
  private readonly requireMention: boolean;
  private handler?: (msg: InboundMessage) => void | Promise<void>;
  private readonly pendingMenus = new Map<string, PendingMenu>();

  constructor(config: DingtalkStreamAdapterConfig, logger?: { warn?: (...args: unknown[]) => void }) {
    this.requireMention = config.requireMention ?? true;
    this.t = dingtalkMessages(config.language ?? "zh");
    this.client = new DingtalkStreamClient({
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      url: config.url,
      logger,
    });
  }

  async start(): Promise<void> {
    this.client.onInbound((raw) => {
      void this.dispatch(raw).catch(() => undefined);
    });
    await this.client.connect();
  }

  async stop(): Promise<void> {
    this.client.close();
  }

  onInbound(handler: (msg: InboundMessage) => void | Promise<void>): void {
    this.handler = handler;
  }

  /** Gate + normalize + menu-answer routing, then hand to the core. */
  private async dispatch(raw: DingtalkBotMessage): Promise<void> {
    if (this.requireMention && raw.conversationType === "2" && !isAtMentioned(raw)) return;
    const msg = normalizeBotMessage(raw);
    if (msg === undefined) return;
    if (this.tryResolveMenu(msg.chatKey, msg.text)) return;
    await this.handler?.(msg);
  }

  /**
   * A pending text menu is answered when the user replies with a number.
   * Returns true when the message was consumed as a menu answer.
   */
  private tryResolveMenu(conversationId: string, text: string): boolean {
    if (this.pendingMenus.size === 0) return false;
    const index = Number(text.trim());
    if (!Number.isFinite(index)) return false;
    for (const [messageId, pending] of this.pendingMenus) {
      if (pending.conversationId !== conversationId) continue;
      const option = pending.options[index - 1];
      if (option === undefined) return false;
      clearTimeout(pending.timer);
      this.pendingMenus.delete(messageId);
      pending.resolve(option.id);
      return true;
    }
    return false;
  }

  async sendText(target: OutboundTarget, text: string): Promise<void> {
    if (target.replyRef === undefined) return; // proactive push → webhook service
    await this.client.sendReply(target.replyRef, buildTextReplyBody(target.replyRef, text));
  }

  async sendCard(target: OutboundTarget, card: SummaryCard): Promise<void> {
    if (target.replyRef === undefined) return;
    await this.client.sendReply(target.replyRef, buildMarkdownReplyBody(target.replyRef, this.t.cardTitle, card.markdown));
  }

  async streamText(target: OutboundTarget, chunks: AsyncIterable<string>): Promise<void> {
    let full = "";
    for await (const chunk of chunks) full += chunk;
    if (full.trim() === "" || target.replyRef === undefined) return;
    await this.client.sendReply(target.replyRef, buildTextReplyBody(target.replyRef, full));
  }

  async promptChoice(target: OutboundTarget, prompt: ChoicePrompt, _updateMessageId?: string): Promise<ChoiceResult> {
    const lines = [prompt.title, ""];
    prompt.options.forEach((option, i) => lines.push(`${i + 1}. ${option.label}`));
    if (prompt.footer !== undefined) lines.push("", prompt.footer);
    const text = lines.join("\n");
    if (target.replyRef !== undefined) {
      await this.client.sendReply(target.replyRef, buildTextReplyBody(target.replyRef, text));
    }
    const messageId = `${target.chatKey}:${Date.now()}`;
    const result = await new Promise<ChoiceResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingMenus.delete(messageId);
        resolve({ choice: undefined, messageId });
      }, CHOICE_TIMEOUT_MS);
      this.pendingMenus.set(messageId, {
        conversationId: target.chatKey,
        options: [...prompt.options],
        timer,
        resolve: (choice) => {
          this.pendingMenus.delete(messageId);
          clearTimeout(timer);
          resolve({ choice, messageId });
        },
      });
    });
    return result;
  }

  async closeMenu(_messageId: string, _summary: string): Promise<void> {
    // Text menus have no card to replace; a completion notice is unnecessary
    // because the menu prompt is just a numbered list in the thread.
  }
}
