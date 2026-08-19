/**
 * Telegram channel adapter: Bot API long-polling intake, message
 * normalization into `dsh-connect`'s `InboundMessage`, and replies via
 * sendMessage / editMessageText with HTML parse mode. Interactive choice
 * prompts render as inline-keyboard buttons handled through callback queries.
 *
 * @module dsh-connect-telegram/adapter
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
import type { Language } from "dsh-connect";
import { TelegramClient, type TelegramMessage, type TelegramUpdate } from "./client.js";
import { telegramMessages, type TelegramMessages } from "./i18n.js";

export interface TelegramConfig {
  botToken?: string;
  language?: Language;
  /** Group messages require the bot to be @-mentioned in the text (default true). */
  requireMention?: boolean;
  /** Polling timeout (seconds). */
  pollingTimeoutSeconds?: number;
  /** HTTP base URL override (local Bot API server). */
  baseUrl?: string;
}

/** Choice buttons live on the message's inline keyboard; pending lookup by callback data. */
interface PendingChoice {
  chatId: string;
  resolve: (choice: string | undefined) => void;
  timer: NodeJS.Timeout;
}

const CHOICE_TIMEOUT_MS = 60_000;

/** Encode chatId + messageId into the opaque message id the core passes around. */
export function encodeMessageRef(chatId: string, messageId: number): string {
  return `${chatId}:${messageId}`;
}

/** Split an opaque message ref back into chatId + messageId. */
export function decodeMessageRef(ref: string): { chatId: string; messageId: number } {
  const idx = ref.lastIndexOf(":");
  const chatId = idx >= 0 ? ref.slice(0, idx) : ref;
  const messageId = idx >= 0 ? Number(ref.slice(idx + 1)) : Number(ref);
  return { chatId, messageId: Number.isFinite(messageId) ? messageId : NaN };
}

/** Escape text for Telegram HTML parse mode (only `& < >` need escaping). */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Convert plain markdown (bold/italic/code/inline code) to Telegram HTML. */
export function markdownToTelegramHtml(markdown: string): string {
  let html = markdown;
  // Inline code first (protect from later bold handling).
  html = html.replace(/`([^`\n]+)`/g, (_, code: string) => `<code>${escapeHtml(code)}</code>`);
  // Bold
  html = html.replace(/\*\*([^*\n]+)\*\*/g, (_, s: string) => `<b>${escapeHtml(s)}</b>`);
  // Italic
  html = html.replace(/(^|[^*])\*([^*\n]+)\*/g, (_p, pre: string, s: string) => `${pre}<i>${escapeHtml(s)}</i>`);
  // Headings → bold lines
  html = html.replace(/^#{1,6}\s+(.+)$/gm, (_, s: string) => `<b>${escapeHtml(s)}</b>`);
  // Links [text](url)
  html = html.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label: string, url: string) => `<a href="${url}">${escapeHtml(label)}</a>`);
  return html;
}

/** Render @-mentions into HTML (tg://user?id= links). */
function mentionHtml(users: readonly string[]): string {
  return users
    .map((id) => `<a href="tg://user?id=${id}">@</a>`)
    .join(" ");
}

/** Build the inline-keyboard reply_markup for a choice prompt. */
export function buildInlineKeyboard(options: readonly ChoiceOption[], columnsPerRow: number): unknown {
  const rows: unknown[][] = [];
  for (let i = 0; i < options.length; i += columnsPerRow) {
    const group = options.slice(i, i + columnsPerRow);
    rows.push(group.map((o) => ({ text: o.label, callback_data: `choice:${o.id}` })));
  }
  return { inline_keyboard: rows };
}

/** Pick a callback data prefix that won't collide with menu ids. */
const CHOICE_PREFIX = "choice:";

/** Callback data for a choice button: `choice:<optionId>`. */
function choiceData(optionId: string): string {
  return `${CHOICE_PREFIX}${optionId}`;
}

export class TelegramAdapter implements ChannelAdapter {
  readonly id = "telegram";
  private readonly client: TelegramClient;
  private readonly t: TelegramMessages;
  private readonly requireMention: boolean;
  private readonly pendingChoices = new Map<string, PendingChoice>();
  private handler?: (msg: InboundMessage) => void | Promise<void>;
  private pollPromise?: Promise<void>;
  private stopped = false;

  constructor(config: TelegramConfig) {
    const botToken = config.botToken ?? process.env.TELEGRAM_BOT_TOKEN;
    if (!botToken) {
      throw new Error(telegramMessages(config.language ?? "zh").tokenMissing);
    }
    this.t = telegramMessages(config.language ?? "zh");
    this.requireMention = config.requireMention ?? true;
    this.client = new TelegramClient({
      botToken,
      ...(config.pollingTimeoutSeconds === undefined ? {} : { pollingTimeoutSeconds: config.pollingTimeoutSeconds }),
      ...(config.baseUrl === undefined ? {} : { baseUrl: config.baseUrl }),
    });
  }

  onInbound(handler: (msg: InboundMessage) => void | Promise<void>): void {
    this.handler = handler;
  }

  async start(): Promise<void> {
    this.stopped = false;
    // Skip the backlog: don't replay old messages on (re)connect.
    await this.client.resetOffset().catch(() => undefined);
    const loop = async (): Promise<void> => {
      while (!this.stopped) {
        try {
          const batch = await this.client.pollUpdates();
          for (const update of batch.updates) {
            await this.handleUpdate(update);
          }
        } catch (error) {
          this.t.pollFailed(error instanceof Error ? error.message : String(error));
          await sleep(this.client.config.retryDelayMs ?? 3_000);
        }
      }
    };
    this.pollPromise = loop();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    // The in-flight getUpdates will settle (server closes or times out); wait briefly.
    const p = this.pollPromise;
    if (p !== undefined) await Promise.race([p, sleep(1000)]).catch(() => undefined);
  }

  private async handleUpdate(update: TelegramUpdate): Promise<void> {
    if (update.callback_query !== undefined) {
      await this.handleCallbackQuery(update.callback_query);
      return;
    }
    const message = update.message ?? update.edited_message;
    if (message === undefined) return;
    const normalized = await this.normalizeMessage(message);
    if (normalized !== undefined) this.handler?.(normalized);
  }

  private async handleCallbackQuery(query: TelegramCallbackLike): Promise<void> {
    const data = query.data ?? "";
    if (!data.startsWith(CHOICE_PREFIX)) {
      await this.client.answerCallbackQuery(query.id).catch(() => undefined);
      return;
    }
    const choiceId = data.slice(CHOICE_PREFIX.length);
    const pending = this.pendingChoices.get(choiceId);
    // Verify the callback came from the same chat the prompt was shown in.
    const queryChatId = query.message?.chat !== undefined ? String(query.message.chat.id) : undefined;
    if (pending !== undefined && (queryChatId === undefined || pending.chatId === queryChatId)) {
      clearTimeout(pending.timer);
      this.pendingChoices.delete(choiceId);
      pending.resolve(choiceId);
      await this.client.answerCallbackQuery(query.id, this.t.choiceDone).catch(() => undefined);
    } else {
      await this.client.answerCallbackQuery(query.id, this.t.choiceExpired).catch(() => undefined);
    }

  /** Normalize a Telegram message into dsh-connect's InboundMessage; returns undefined when ignored. */
  private async normalizeMessage(message: TelegramMessage): Promise<InboundMessage | undefined> {
    const chat = message.chat;
    const chatId = String(chat.id);
    const chatType: "p2p" | "group" = chat.type === "private" ? "p2p" : "group";
    const senderKey = message.from === undefined ? chatId : String(message.from.id);
    const text = message.text ?? message.caption ?? "";

    // Group mention policy: require the bot to be @-mentioned (or a reply to the bot).
    if (chatType === "group" && this.requireMention && !isBotMentioned(message, text)) {
      return undefined;
    }

    // Download attached images / files.
    const images: string[] = [];
    const files: string[] = [];
    let imageError: string | undefined;
    let fileError: string | undefined;

    if (message.photo !== undefined && message.photo.length > 0) {
      const largest = message.photo[message.photo.length - 1];
      const res = await this.client.downloadFileToTemp(largest.file_id, `photo_${largest.file_unique_id}.jpg`);
      if (res.error !== undefined) imageError = res.error;
      else if (res.path !== "") images.push(res.path);
    }
    if (message.document !== undefined) {
      const res = await this.client.downloadFileToTemp(message.document.file_id, message.document.file_name);
      if (res.error !== undefined) fileError = res.error;
      else if (res.path !== "") files.push(res.path);
    }

    return {
      channel: "telegram",
      chatKey: chatId,
      chatType,
      senderKey,
      text,
      ...(message.reply_to_message === undefined ? {} : { replyRef: String(message.reply_to_message.message_id) }),
      ...(images.length > 0 ? { images } : {}),
      ...(files.length > 0 ? { files } : {}),
      ...(imageError === undefined ? {} : { imageError }),
      ...(fileError === undefined ? {} : { fileError }),
    };
  }

  async sendText(target: OutboundTarget, text: string): Promise<void> {
    const html = markdownToTelegramHtml(text);
    await this.client.sendMessage(target.chatKey, html, {
      parse_mode: "HTML",
      ...(target.replyRef === undefined ? {} : { reply_to_message_id: Number(target.replyRef) }),
      disable_web_page_preview: true,
    });
  }

  async sendCard(target: OutboundTarget, card: SummaryCard): Promise<void> {
    const html = markdownToTelegramHtml(card.markdown);
    const atPrefix = target.atUsers !== undefined && target.atUsers.length > 0 ? `${mentionHtml(target.atUsers)}\n` : "";
    await this.client.sendMessage(target.chatKey, `${atPrefix}${html}`, {
      parse_mode: "HTML",
      ...(target.replyRef === undefined ? {} : { reply_to_message_id: Number(target.replyRef) }),
      disable_web_page_preview: true,
    });
  }

  async streamText(target: OutboundTarget, chunks: AsyncIterable<string>): Promise<void> {
    // Start with the first chunk; edit in place thereafter.
    let messageId: number | undefined;
    let buffer = "";
    const chatId = target.chatKey;
    const flush = async (): Promise<void> => {
      if (buffer === "") return;
      const html = markdownToTelegramHtml(buffer);
      try {
        if (messageId === undefined) {
          const sent = await this.client.sendMessage(chatId, html, {
            parse_mode: "HTML",
            ...(target.replyRef === undefined ? {} : { reply_to_message_id: Number(target.replyRef) }),
            disable_web_page_preview: true,
          });
          messageId = sent.message_id;
        } else {
          await this.client.editMessageText(chatId, messageId, html, { parse_mode: "HTML" });
        }
      } catch {
        // Transient edit failures (e.g. identical text) are non-fatal.
      }
    };
    for await (const chunk of chunks) {
      buffer += chunk;
      // Throttle edits: flush at most every ~700ms or on >4KB.
      if (buffer.length >= 4096) {
        await flush();
        buffer = "";
      } else {
        // Deferred flush — keep it simple: flush per chunk with a small sleep
        // is too chatty; instead flush only on chunk boundaries at moderate size.
        if (buffer.length >= 200) {
          await flush();
          buffer = "";
        }
      }
    }
    if (buffer !== "") await flush();
  }

  async promptChoice(target: OutboundTarget, prompt: ChoicePrompt, updateMessageId?: string): Promise<ChoiceResult> {
    const keyboard = buildInlineKeyboard(prompt.options, prompt.columnsPerRow ?? 2);
    const title = `<b>${escapeHtml(prompt.title)}</b>`;
    const desc = prompt.description === undefined ? "" : `\n${escapeHtml(prompt.description)}`;
    const text = `${title}${desc}`;
    const chatId = target.chatKey;

    let messageId: number;
    if (updateMessageId !== undefined) {
      const ref = decodeMessageRef(updateMessageId);
      messageId = ref.messageId;
      await this.client.editMessageText(ref.chatId, messageId, text, {
        parse_mode: "HTML",
        reply_markup: keyboard,
      });
    } else {
      const sent = await this.client.sendMessage(chatId, text, {
        parse_mode: "HTML",
        reply_markup: keyboard,
      });
      messageId = sent.message_id;
    }

    // One pending record per option id; resolve on callback. Timeout resolves
    // with `undefined` (dismiss). Callback data uses the option id so the
    // keyboard buttons map straight back here.
    return new Promise<ChoiceResult>((resolve) => {
      const ids = prompt.options.map((o) => o.id);
      const settle = (choice: string | undefined): void => {
        for (const id of ids) this.pendingChoices.delete(id);
        resolve({ choice, messageId: encodeMessageRef(chatId, messageId) });
      };
      const timer = setTimeout(() => settle(undefined), CHOICE_TIMEOUT_MS);
      for (const id of ids) {
        this.pendingChoices.set(id, { chatId, resolve: settle, timer });
      }
    });
  }

  async closeMenu(messageId: string, summary: string): Promise<void> {
    const ref = decodeMessageRef(messageId);
    if (Number.isNaN(ref.messageId)) return;
    try {
      await this.client.editMessageText(ref.chatId, ref.messageId, escapeHtml(summary), { parse_mode: "HTML" });
    } catch {
      // Best-effort: the menu may already be gone.
    }
  }
}

/** True when the message mentions the bot (starts with @, or a reply, or contains the bot's name). */
function isBotMentioned(message: TelegramMessage, text: string): boolean {
  // Reply to the bot counts as a mention.
  if (message.reply_to_message !== undefined) return true;
  // The bot's own messages have `from.is_bot`; a message mentioning the bot via
  // @username entity is captured in `entities`. Simplest robust heuristic:
  // any `@` mention entity, or the text starts with `@`.
  const entities = (message as { entities?: { type: string }[] }).entities;
  if (entities !== undefined && entities.some((e) => e.type === "mention")) return true;
  return /^\s*@/.test(text);
}

interface TelegramCallbackLike {
  id: string;
  data?: string;
  message?: { chat: { id: number } };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
