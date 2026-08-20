/**
 * Minimal Telegram Bot API client built on the global `fetch` — long-polling
 * update intake, message send / edit / photo, file download, and inline
 * keyboards. Zero third-party HTTP dependency (Node ≥ 18 / ≥ 20).
 *
 * @module dsh-connect-telegram/client
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const API_BASE = "https://api.telegram.org";

/** Raw Telegram update (subset of the full schema we use). */
export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

export interface TelegramMessage {
  message_id: number;
  chat: { id: number; type: string; title?: string };
  from?: { id: number; is_bot?: boolean; first_name?: string; username?: string };
  text?: string;
  caption?: string;
  reply_to_message?: TelegramMessage;
  entities?: { type: string; offset: number; length: number }[];
  photo?: { file_id: string; file_unique_id: string; width: number; height: number }[];
  document?: { file_id: string; file_name?: string };
  voice?: { file_id: string };
  video?: { file_id: string };
  audio?: { file_id: string };
  sticker?: { file_id: string };
}

export interface TelegramCallbackQuery {
  id: string;
  from: { id: number; username?: string };
  message?: TelegramMessage;
  data?: string;
}

/** Options accepted by `sendMessage` (parse_mode, reply_markup, …). */
export interface SendMessageOptions {
  parse_mode?: "HTML" | "MarkdownV2";
  reply_to_message_id?: number;
  reply_markup?: unknown;
  disable_web_page_preview?: boolean;
}

export interface TelegramClientConfig {
  botToken: string;
  /** getUpdates polling timeout (seconds). Default 50. */
  pollingTimeoutSeconds?: number;
  /** getUpdates long-poll gap after an error. Default 3s. */
  retryDelayMs?: number;
  /** HTTP timeout for each API call (ms). Default 15s. */
  timeoutMs?: number;
  /** Optional base URL override (e.g. for a local Bot API server). */
  baseUrl?: string;
}

/** Normalized photo/file location after download. */
export interface DownloadedResource {
  path: string;
  kind: "image" | "file";
  error?: string;
}

export class TelegramClient {
  readonly config: TelegramClientConfig;
  private offset = 0;

  constructor(config: TelegramClientConfig) {
    if (!config.botToken) throw new Error("connect-telegram: botToken is required");
    this.config = config;
  }

  private base(): string {
    return this.config.baseUrl ?? API_BASE;
  }

  private async call<T>(method: string, body?: Record<string, unknown>, opts?: { timeoutMs?: number }): Promise<T> {
    const url = `${this.base()}/bot${this.config.botToken}/${method}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts?.timeoutMs ?? this.config.timeoutMs ?? 15_000);
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: body === undefined ? "{}" : JSON.stringify(body),
        signal: controller.signal,
      });
      const parsed = (await response.json()) as { ok: boolean; result?: T; description?: string; error_code?: number };
      if (!parsed.ok || parsed.result === undefined) {
        throw new Error(`Telegram API ${method}: ${parsed.description ?? `error ${parsed.error_code ?? "?"}`}`);
      }
      return parsed.result;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Long-poll for new updates. Does NOT advance the offset — the caller confirms each update via {@link confirmOffset} after processing it, so a failure mid-batch never loses the remaining updates. */
  async pollUpdates(): Promise<TelegramUpdate[]> {
    // The generic per-call HTTP timeout (15s) must not kill a long poll:
    // give getUpdates a client-side timeout comfortably above the server-side
    // long-poll window (otherwise every idle poll is aborted at 15s and the
    // "50s long poll" degrades into short polling + sleep churn).
    const longPollMs = ((this.config.pollingTimeoutSeconds ?? 50) + 10) * 1000;
    return this.call<TelegramUpdate[]>(
      "getUpdates",
      {
        offset: this.offset,
        timeout: this.config.pollingTimeoutSeconds ?? 50,
        allowed_updates: ["message", "callback_query"],
      },
      { timeoutMs: longPollMs },
    );
  }

  /** Advance the polling offset past `updateId` — call only after the update was fully handled. */
  confirmOffset(updateId: number): void {
    this.offset = Math.max(this.offset, updateId + 1);
  }

  /** Skip all pending updates (used on startup so we don't replay history). */
  async resetOffset(): Promise<void> {
    const result = await this.call<TelegramUpdate[]>("getUpdates", { offset: -1, timeout: 0 });
    if (result.length > 0) {
      this.offset = result[result.length - 1].update_id + 1;
    }
  }

  /** Fetch the bot's own identity (id + username) — used for @-mention / reply-to checks. */
  async getMe(): Promise<{ id: number; username?: string }> {
    return this.call<{ id: number; username?: string }>("getMe", {});
  }

  async sendMessage(chatId: number | string, text: string, opts: SendMessageOptions = {}): Promise<TelegramMessage> {
    return this.call<TelegramMessage>("sendMessage", {
      chat_id: chatId,
      text,
      ...(opts.parse_mode === undefined ? {} : { parse_mode: opts.parse_mode }),
      ...(opts.reply_to_message_id === undefined ? {} : { reply_to_message_id: opts.reply_to_message_id }),
      ...(opts.reply_markup === undefined ? {} : { reply_markup: opts.reply_markup }),
      ...(opts.disable_web_page_preview === undefined ? {} : { disable_web_page_preview: opts.disable_web_page_preview }),
    });
  }

  async editMessageText(chatId: number | string, messageId: number, text: string, opts: SendMessageOptions = {}): Promise<unknown> {
    return this.call("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text,
      ...(opts.parse_mode === undefined ? {} : { parse_mode: opts.parse_mode }),
      ...(opts.reply_markup === undefined ? {} : { reply_markup: opts.reply_markup }),
    });
  }

  async sendPhoto(chatId: number | string, photoPath: string, caption?: string, opts: SendMessageOptions = {}): Promise<TelegramMessage> {
    // sendPhoto needs multipart; the fetch FormData path with a Blob is the
    // modern zero-dependency route. Read the file into a Blob.
    const { readFileSync } = await import("node:fs");
    const buffer = readFileSync(photoPath);
    const blob = new Blob([buffer]);
    const form = new FormData();
    form.append("chat_id", String(chatId));
    form.append("photo", blob, photoPath.split(/[\\/]/).pop() ?? "photo");
    if (caption !== undefined) form.append("caption", caption);
    if (opts.parse_mode !== undefined) form.append("parse_mode", opts.parse_mode);
    if (opts.reply_to_message_id !== undefined) form.append("reply_to_message_id", String(opts.reply_to_message_id));

    const url = `${this.base()}/bot${this.config.botToken}/sendPhoto`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs ?? 15_000);
    try {
      const response = await fetch(url, { method: "POST", body: form, signal: controller.signal });
      const parsed = (await response.json()) as { ok: boolean; result?: TelegramMessage; description?: string };
      if (!parsed.ok || parsed.result === undefined) {
        throw new Error(`Telegram API sendPhoto: ${parsed.description ?? "unknown error"}`);
      }
      return parsed.result;
    } finally {
      clearTimeout(timer);
    }
  }

  async answerCallbackQuery(callbackQueryId: string, text?: string): Promise<boolean> {
    return this.call<boolean>("answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      ...(text === undefined ? {} : { text }),
    });
  }

  /** Download a file (photo / document / …) by file_id into a temp dir; returns the local path. */
  async downloadFile(fileId: string, dir: string, fileName?: string): Promise<DownloadedResource> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs ?? 30_000);
    try {
      const file = await this.call<{ file_path?: string }>("getFile", { file_id: fileId });
      if (file.file_path === undefined) throw new Error("getFile returned no file_path");
      const url = `${this.base()}/file/bot${this.config.botToken}/${file.file_path}`;
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) throw new Error(`download HTTP ${response.status}`);
      const buffer = Buffer.from(await response.arrayBuffer());
      const safeName = sanitizeFileName(fileName ?? file.file_path.split("/").pop() ?? fileId);
      const dest = join(dir, safeName);
      mkdirSync(dir, { recursive: true });
      writeFileSync(dest, buffer);
      return { path: dest, kind: "file" };
    } catch (error) {
      return { path: "", kind: "file", error: error instanceof Error ? error.message : String(error) };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Convenience: download to the OS temp dir. */
  async downloadFileToTemp(fileId: string, fileName?: string): Promise<DownloadedResource> {
    const dir = join(tmpdir(), "dsh-connect-telegram");
    return this.downloadFile(fileId, dir, fileName);
  }
}

/** Strip path separators / control chars from a downloaded file's name. */
export function sanitizeFileName(name: string): string {
  const clean = name
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
    .trim()
    .slice(0, 200);
  return clean === "" ? "file" : clean;
}
