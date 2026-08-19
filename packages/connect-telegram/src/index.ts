/**
 * Telegram channel adapter: getUpdates long-polling intake, normalized message
 * routing into `dsh-connect`, and replies back to Telegram (text / markdown /
 * streaming edits / inline-keyboard choice prompts).
 *
 * @module dsh-connect-telegram
 */
import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { TelegramAdapter, type TelegramConfig } from "./adapter.js";

export { TelegramAdapter } from "./adapter.js";
export type { TelegramConfig } from "./adapter.js";
export { TelegramClient } from "./client.js";
export type { TelegramClientConfig, TelegramMessage, TelegramUpdate } from "./client.js";
export { markdownToTelegramHtml, escapeHtml, buildInlineKeyboard, encodeMessageRef, decodeMessageRef } from "./adapter.js";

/** Cordis plugin name used by loader diagnostics. */
export const name = "connect-telegram";

/** The `connect` service this adapter registers into. */
export const inject = ["connect"];

/** Plugin config; secrets may come from config or the TELEGRAM_BOT_TOKEN environment. */
export const Config = z.object({
  botToken: z.string().role("secret"),
  language: z.union([z.const("zh"), z.const("en")]),
  requireMention: z.boolean(),
  pollingTimeoutSeconds: z.number().min(1).max(60),
  baseUrl: z.string(),
});

interface ConnectLike {
  registerAdapter(adapter: unknown): void;
}

function start(connect: ConnectLike, config: TelegramConfig, logger?: { warn?: (...args: unknown[]) => void }): void {
  try {
    const adapter = new TelegramAdapter(config);
    connect.registerAdapter(adapter);
    void adapter.start().catch((error) => {
      logger?.warn?.(`connect-telegram: start failed: ${String(error)}`);
    });
  } catch (error) {
    logger?.warn?.(`connect-telegram: adapter init failed: ${String(error)}`);
  }
}

/**
 * Register and start the Telegram adapter. `connect` comes from `inject`, so
 * it is guaranteed present.
 */
export function apply(ctx: Context, config: TelegramConfig = {}): void {
  const connect = ctx.get("connect") as ConnectLike | undefined;
  if (connect === undefined) {
    throw new Error("connect-telegram: the dsh-connect service is not present; load it before this adapter");
  }
  const botToken = config.botToken ?? process.env.TELEGRAM_BOT_TOKEN;
  if (botToken === undefined || botToken === "") {
    ctx.logger?.warn?.("connect-telegram: botToken is not configured (config or TELEGRAM_BOT_TOKEN) — adapter disabled.");
    return;
  }
  start(connect, { ...config, botToken }, ctx.logger);
}
