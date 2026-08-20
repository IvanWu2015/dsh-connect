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

/** Pending choice buttons live on a message's inline keyboard. */
interface PendingChoice {
  chatId: string;
  /** All (chat+option) keys this prompt registered — removed together on settle. */
  keys: string[];
  resolve: (choice: string | undefined) => void;
  timer: NodeJS.Timeout;
}

const CHOICE_TIMEOUT_MS = 60_000;

/** Key a pending choice by chat + option so concurrent menus never collide. */
function choiceKey(chatId: string, optionId: string): string {
  return `${chatId}\u0000${optionId}`;
}

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

/** Convert plain markdown (bold/italic/inline code/code blocks/headings/links) to Telegram HTML. */
export function markdownToTelegramHtml(markdown: string): string {
  // Token-based conversion: plain text is escaped as-is (Telegram HTML mode
  // rejects unescaped `& < >` anywhere), then markdown spans are converted and
  // their inner content escaped too. Everything the LLM writes — "R&D",
  // "x < y", fenced ```code``` blocks — survives without breaking parse mode.
  let html = "";
  let i = 0;
  const n = markdown.length;
  const MARKERS = ["*", "`", "[", "#"] as const;
  while (i < n) {
    // Skip ahead to the next potential marker, escaping plain text in bulk.
    let next = n;
    for (const m of MARKERS) {
      const idx = markdown.indexOf(m, i);
      if (idx !== -1 && idx < next) next = idx;
    }
    if (next > i) {
      html += escapeHtml(markdown.slice(i, next));
      i = next;
    }
    if (i >= n) break;
    const rest = markdown.slice(i);
    // Fenced code block (```lang\n...\n```) — inner text fully escaped.
    const fence = rest.match(/^```[^\n]*\n([\s\S]*?)(?:```|$)/);
    if (fence !== null) {
      html += `<pre>${escapeHtml(fence[1])}</pre>`;
      i += fence[0].length;
      continue;
    }
    // Inline code.
    const inline = rest.match(/^`([^`\n]+)`/);
    if (inline !== null) {
      html += `<code>${escapeHtml(inline[1])}</code>`;
      i += inline[0].length;
      continue;
    }
    // Bold.
    const bold = rest.match(/^\*\*([^*\n]+)\*\*/);
    if (bold !== null) {
      html += `<b>${escapeHtml(bold[1])}</b>`;
      i += bold[0].length;
      continue;
    }
    // Italic (single asterisk, not part of a bold pair).
    const italic = rest.match(/^\*([^*\n]+)\*/);
    if (italic !== null) {
      html += `<i>${escapeHtml(italic[1])}</i>`;
      i += italic[0].length;
      continue;
    }
    // Link [label](url) — the href is escaped to survive HTML attribute parsing.
    const link = rest.match(/^\[([^\]]+)\]\(([^)\s]+)\)/);
    if (link !== null) {
      html += `<a href="${escapeHtml(link[2])}">${escapeHtml(link[1])}</a>`;
      i += link[0].length;
      continue;
    }
    // Heading — only at the start of a line.
    const atLineStart = i === 0 || markdown[i - 1] === "\n";
    const heading = rest.match(/^#{1,6}\s+([^\n]+)/);
    if (atLineStart && heading !== null) {
      html += `<b>${escapeHtml(heading[1])}</b>`;
      i += heading[0].length;
      continue;
    }
    // Not a real marker after all — emit the character escaped.
    html += escapeHtml(markdown[i]);
    i += 1;
  }
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

export class TelegramAdapter implements ChannelAdapter {
  readonly id = "telegram";
  private readonly client: TelegramClient;
  private readonly t: TelegramMessages;
  private readonly requireMention: boolean;
  private readonly pendingChoices = new Map<string, PendingChoice>();
  private handler?: (msg: InboundMessage) => void | Promise<void>;
  private pollPromise?: Promise<void>;
  private stopped = false;
  /** The bot's own user id (from getMe) — used for precise mention/reply checks. */
  private botId?: number;
  /** The bot's username (from getMe) — used to verify @-mentions. */
  private botUsername?: string;

  constructor(
    config: TelegramConfig,
    private readonly logger?: { warn?: (...args: unknown[]) => void },
  ) {
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
    // Resolve the bot's own identity for precise mention/reply checks. On
    // failure, fall back to a permissive heuristic (logged so it's observable).
    try {
      const me = await this.client.getMe();
      this.botId = me.id;
      this.botUsername = me.username;
    } catch (error) {
      this.logger?.warn?.(`connect-telegram: getMe failed: ${String(error)} — mention checks use a permissive fallback`);
    }
    // Skip the backlog: don't replay old messages on (re)connect. A failure
    // here leaves offset=0 and would replay history — log it instead of hiding.
    try {
      await this.client.resetOffset();
    } catch (error) {
      this.logger?.warn?.(`connect-telegram: resetOffset failed (old messages may be replayed): ${String(error)}`);
    }
    const loop = async (): Promise<void> => {
      while (!this.stopped) {
        try {
          const updates = await this.client.pollUpdates();
          for (const update of updates) {
            // Confirm the offset per update AFTER it is handled, so a failure
            // mid-batch never drops the remaining updates.
            try {
              await this.handleUpdate(update);
            } catch (error) {
              this.logger?.warn?.(`connect-telegram: update ${update.update_id} failed: ${error instanceof Error ? error.message : String(error)}`);
            }
            this.client.confirmOffset(update.update_id);
          }
        } catch (error) {
          this.logger?.warn?.(this.t.pollFailed(error instanceof Error ? error.message : String(error)));
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
    // Only fresh messages are processed. `edited_message` (including the bot's
    // own streamed edits) is ignored — otherwise every in-place stream edit
    // would re-trigger an agent turn.
    const message = update.message;
    if (message === undefined) return;
    const normalized = await this.normalizeMessage(message);
    if (normalized !== undefined) await this.handler?.(normalized);
  }

  private async handleCallbackQuery(query: TelegramCallbackLike): Promise<void> {
    const data = query.data ?? "";
    if (!data.startsWith(CHOICE_PREFIX)) {
      await this.client.answerCallbackQuery(query.id).catch(() => undefined);
      return;
    }
    const choiceId = data.slice(CHOICE_PREFIX.length);
    const queryChatId = query.message?.chat !== undefined ? String(query.message.chat.id) : undefined;
    // Pending entries are keyed by (chat, option) so concurrent menus in
    // different chats never overwrite each other.
    const pending = queryChatId === undefined ? undefined : this.pendingChoices.get(choiceKey(queryChatId, choiceId));
    if (pending !== undefined) {
      // `resolve` is the prompt's settle(): clears its keys and the timer.
      pending.resolve(choiceId);
      await this.client.answerCallbackQuery(query.id, this.t.choiceDone).catch(() => undefined);
    } else {
      await this.client.answerCallbackQuery(query.id, this.t.choiceExpired).catch(() => undefined);
    }
  }
  /** Normalize a Telegram message into dsh-connect's InboundMessage; returns undefined when ignored. */
  private async normalizeMessage(message: TelegramMessage): Promise<InboundMessage | undefined> {
    // Never echo-loop: Telegram delivers the bot's own messages back through
    // getUpdates, and treating them as inbound would re-trigger the agent on
    // every ack / reply / summary card.
    if (message.from?.is_bot === true) return undefined;

    const chat = message.chat;
    const chatId = String(chat.id);
    const chatType: "p2p" | "group" = chat.type === "private" ? "p2p" : "group";
    const senderKey = message.from === undefined ? chatId : String(message.from.id);
    const text = message.text ?? message.caption ?? "";

    // Group mention policy: require an @-mention of this bot (or a reply to it).
    if (chatType === "group" && this.requireMention && !isBotMentioned(message, text, this.botUsername, this.botId)) {
      return undefined;
    }

    // Download attached images / files / audio / video.
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
    const media = message.document ?? message.voice ?? message.video ?? message.audio;
    if (media !== undefined) {
      const name = message.document?.file_name ?? `${media.file_id}.${media === message.voice ? "ogg" : media === message.video ? "mp4" : "mp3"}`;
      const res = await this.client.downloadFileToTemp(media.file_id, name);
      if (res.error !== undefined) fileError = res.error;
      else if (res.path !== "") files.push(res.path);
    }

    // A message with no text and no media has nothing for the agent — ignore
    // (e.g. stickers, service messages) instead of running an empty turn.
    if (text.trim() === "" && images.length === 0 && files.length === 0) return undefined;

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
    // editMessageText REPLACES the whole message text, so the stream must
    // accumulate the full answer and send the complete text on every flush —
    // sending only the incremental delta would wipe the earlier content.
    let messageId: number | undefined;
    let fullText = "";
    let lastFlushAt = 0;
    const chatId = target.chatKey;
    const sendOpts = {
      parse_mode: "HTML" as const,
      ...(target.replyRef === undefined ? {} : { reply_to_message_id: Number(target.replyRef) }),
      disable_web_page_preview: true,
    };

    const flush = async (): Promise<void> => {
      if (fullText === "") return;
      // Telegram caps a message at 4096 characters; truncate (with a marker)
      // so a long answer still delivers instead of failing to send.
      const MAX_TEXT = 4000;
      const body = fullText.length > MAX_TEXT ? `${fullText.slice(0, MAX_TEXT)}\n\n…` : fullText;
      const html = markdownToTelegramHtml(body);
      try {
        if (messageId === undefined) {
          const sent = await this.client.sendMessage(chatId, html, sendOpts);
          messageId = sent.message_id;
        } else {
          await this.client.editMessageText(Number(chatId), messageId, html, { parse_mode: "HTML" });
        }
        lastFlushAt = Date.now();
      } catch (error) {
        // Keep `fullText` intact: a transient failure (429, network) is retried
        // by the next flush carrying the full text — content is never dropped.
        this.logger?.warn?.(`connect-telegram: stream flush failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    };

    for await (const chunk of chunks) {
      fullText += chunk;
      const now = Date.now();
      // Throttle: flush at most every ~700ms, but force a flush past 4KB.
      if (fullText.length >= 4096) {
        await flush();
      } else if (fullText.length >= 200 && now - lastFlushAt >= 700) {
        await flush();
      }
    }
    await flush();
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

    // One pending record per (chat, option) key — concurrent menus in different
    // chats never collide. Timeout resolves `undefined` (dismiss) and replaces
    // the stale keyboard with an expired notice (parity with Feishu).
    return new Promise<ChoiceResult>((resolve) => {
      const registered = prompt.options.map((o) => choiceKey(chatId, o.id));
      const settle = (choice: string | undefined): void => {
        clearTimeout(timer);
        for (const key of registered) this.pendingChoices.delete(key);
        resolve({ choice, messageId: encodeMessageRef(chatId, messageId) });
      };
      const timer = setTimeout(() => {
        void this.client
          .editMessageText(Number(chatId), messageId, `<i>${escapeHtml(this.t.menuExpired)}</i>`, { parse_mode: "HTML" })
          .catch(() => undefined);
        settle(undefined);
      }, CHOICE_TIMEOUT_MS);
      for (const key of registered) {
        this.pendingChoices.set(key, { chatId, keys: registered, resolve: settle, timer });
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

/** True when the message mentions this bot: a reply to it, or an @-mention of its username. */
export function isBotMentioned(message: TelegramMessage, text: string, botUsername?: string, botId?: number): boolean {
  // A reply counts as a mention only when it targets this bot (or any bot,
  // when the bot's own id is unknown) — replying to an arbitrary user in a
  // group must not trigger the agent.
  if (message.reply_to_message !== undefined) {
    const replied = message.reply_to_message.from;
    if (botId !== undefined) return replied?.id === botId;
    return replied?.is_bot === true;
  }
  // @-mention entities: match against the bot's username when known; otherwise
  // accept any mention entity (permissive fallback).
  const entities = message.entities ?? [];
  for (const e of entities) {
    if (e.type !== "mention") continue;
    const mention = text.slice(e.offset, e.offset + e.length);
    if (botUsername === undefined) return true;
    if (mention.toLowerCase() === `@${botUsername.toLowerCase()}`) return true;
  }
  // Clients without entities (rare): a leading @-mention that names the bot.
  if (/^\s*@/.test(text)) {
    if (botUsername === undefined) return true;
    const m = text.match(/^\s*@([A-Za-z0-9_]+)/);
    return m !== null && m[1].toLowerCase() === botUsername.toLowerCase();
  }
  return false;
}

interface TelegramCallbackLike {
  id: string;
  data?: string;
  message?: { chat: { id: number } };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
