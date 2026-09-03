/**
 * DingTalk channel for DeepSeek Harness — two modes:
 *
 * 1. Webhook push (one-way): the DingTalk group custom robot (群自定义机器人)
 *    webhook can send text / markdown / @mention messages into a group. This
 *    exposes a push service (`ctx.dingtalk`) for task progress, results and
 *    alerts.
 * 2. Stream mode (bidirectional, zero dependencies): with `stream.clientId`
 *    / `stream.clientSecret` set, a STOMP-over-WebSocket adapter is
 *    registered into `dsh-connect`, so group @-mentions / DMs trigger the
 *    agent and replies stream back. Menus are numbered text lists (the user
 *    answers with a number); proactive pushes still use the webhook service.
 *
 * @module dsh-connect/dingtalk
 */
import { Service, type Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { DingtalkWebhook, type DingtalkAt } from "./webhook.js";
import { dingtalkMessages, type DingtalkMessages } from "./i18n.js";
import { DingtalkStreamAdapter, type DingtalkStreamAdapterConfig } from "./adapter.js";

export { DingtalkWebhook, signDingtalk, verifyDingtalkSignature } from "./webhook.js";
export type { DingtalkAt, DingtalkBody, DingtalkResponse, DingtalkWebhookConfig } from "./webhook.js";
export { dingtalkMessages } from "./i18n.js";
export type { DingtalkMessages } from "./i18n.js";
export { DingtalkStreamAdapter } from "./adapter.js";
export type { DingtalkStreamAdapterConfig } from "./adapter.js";
export { DingtalkStreamClient, DEFAULT_STREAM_URL } from "./stream.js";
export { encodeFrame, decodeFrames, escapeHeader, unescapeHeader } from "./stomp.js";
export type { StompFrame } from "./stomp.js";
export {
  buildConnectBody,
  buildMarkdownReplyBody,
  buildTextReplyBody,
  isAtMentioned,
  normalizeBotMessage,
  INBOUND_DESTINATION,
  REPLY_DESTINATION,
} from "./message.js";
export type { DingtalkBotMessage } from "./message.js";

/** Plugin config; secrets may come from config or the DINGTALK_* environment. */
export const Config = z.object({
  webhookUrl: z.string().role("secret"),
  secret: z.string().role("secret"),
  language: z.union([z.const("zh"), z.const("en")]),
  /** Optional default @-mentions for every push (mobiles / user ids / all). */
  defaultAt: z.object({
    mobiles: z.array(z.string()),
    userIds: z.array(z.string()),
    all: z.boolean(),
  }),
  /** Stream mode (bidirectional): the DingTalk app's Client ID / Client Secret. */
  stream: z.object({
    clientId: z.string().role("secret"),
    clientSecret: z.string().role("secret"),
    url: z.string(),
    requireMention: z.boolean(),
  }),
});

export interface DingtalkConfig {
  webhookUrl?: string;
  secret?: string;
  language?: "zh" | "en";
  defaultAt?: Partial<DingtalkAt>;
  /** Stream mode (bidirectional) credentials; secrets also via DINGTALK_STREAM_CLIENT_ID / _SECRET. */
  stream?: Partial<DingtalkStreamAdapterConfig>;
}

/**
 * The push service exposed on the Cordis context. Other plugins can inject
 * `dingtalk` and call `sendMarkdown` / `sendText` to deliver into the group.
 */
export class DingtalkService extends Service {
  private readonly webhook: DingtalkWebhook;
  private readonly t: DingtalkMessages;
  readonly defaultAt?: Partial<DingtalkAt>;

  constructor(ctx: Context, config: DingtalkConfig, logger?: { warn?: (...args: unknown[]) => void }) {
    super(ctx, "dingtalk");
    const webhookUrl = config.webhookUrl ?? process.env.DINGTALK_WEBHOOK_URL;
    if (!webhookUrl) {
      throw new Error(dingtalkMessages(config.language ?? "zh").webhookMissing);
    }
    this.t = dingtalkMessages(config.language ?? "zh");
    this.defaultAt = config.defaultAt;
    try {
      this.webhook = new DingtalkWebhook({
        webhookUrl,
        ...(config.secret ?? process.env.DINGTALK_WEBHOOK_SECRET ? { secret: config.secret ?? process.env.DINGTALK_WEBHOOK_SECRET } : {}),
      });
    } catch (error) {
      logger?.warn?.(this.t.webhookInvalid);
      throw error;
    }
  }

  /** Push a markdown card into the DingTalk group. */
  async sendMarkdown(title: string, text: string, at?: DingtalkAt): Promise<void> {
    const merged = at === undefined ? this.defaultAt : { ...this.defaultAt, ...at };
    try {
      await this.webhook.sendMarkdown(title, text, merged as DingtalkAt | undefined);
    } catch (error) {
      this.ctx.logger?.warn?.(this.t.sendFailed(error instanceof Error ? error.message : String(error)));
    }
  }

  /** Push plain text into the DingTalk group. */
  async sendText(content: string, at?: DingtalkAt): Promise<void> {
    const merged = at === undefined ? this.defaultAt : { ...this.defaultAt, ...at };
    try {
      await this.webhook.sendText(content, merged as DingtalkAt | undefined);
    } catch (error) {
      this.ctx.logger?.warn?.(this.t.sendFailed(error instanceof Error ? error.message : String(error)));
    }
  }
}

interface ConnectLike {
  registerAdapter(adapter: unknown): void;
}

/**
 * Register and start the DingTalk channel. `connect` may be undefined: when the
 * stream credentials are absent, or when `connect` is not provided, DingTalk
 * degrades to one-way webhook push (`ctx.dingtalk`). The webhook service is
 * always constructed. `connect` is the already-constructed `ConnectService`
 * instance (passed from the merged entry, not resolved via `ctx.get`).
 */
export function register(connect: ConnectLike | undefined, config: DingtalkConfig | null = {}, ctx: Context): void {
  // The DSH loader passes `null` for entries without an explicit config.
  config = config ?? {};

  // Stream mode (bidirectional): register a ChannelAdapter into dsh-connect.
  const stream = config.stream ?? {};
  const clientId = stream.clientId ?? process.env.DINGTALK_STREAM_CLIENT_ID;
  const clientSecret = stream.clientSecret ?? process.env.DINGTALK_STREAM_CLIENT_SECRET;
  if (clientId !== undefined && clientSecret !== undefined) {
    if (connect === undefined) {
      ctx.logger?.warn?.("connect-dingtalk: stream mode requires the dsh-connect service; skipping adapter");
    } else {
      try {
        const adapter = new DingtalkStreamAdapter(
          { ...stream, clientId, clientSecret, language: config.language },
          ctx.logger,
        );
        connect.registerAdapter(adapter);
        void adapter.start().catch((error) => {
          ctx.logger?.warn?.(`connect-dingtalk: stream adapter start failed: ${String(error)}`);
        });
      } catch (error) {
        ctx.logger?.warn?.(`connect-dingtalk: stream adapter init failed: ${String(error)}`);
      }
    }
  }

  // Webhook push service (one-way). `Service` construction registers
  // `ctx.dingtalk` automatically; it throws when no webhookUrl is configured.
  try {
    void new DingtalkService(ctx, config, ctx.logger);
  } catch (error) {
    ctx.logger?.warn?.(`connect-dingtalk: init failed: ${String(error)}`);
  }
}

/**
 * Compatibility shell for the old split-plugin registration path (when `connect`
 * is an already-active, separate plugin). The merged entry calls `register`
 * directly instead, because `ctx.get("connect")` returns undefined inside this
 * plugin's own `apply`.
 */
export function apply(ctx: Context, config: DingtalkConfig | null = {}): void {
  const connect = ctx.get("connect") as ConnectLike | undefined;
  register(connect, config, ctx);
}
