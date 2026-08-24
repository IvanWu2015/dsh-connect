/**
 * DingTalk webhook push channel for DeepSeek Harness.
 *
 * The DingTalk group custom robot (群自定义机器人) is a *one-way* webhook:
 * it can send text / markdown / @mention messages into a group, but cannot
 * receive messages. This package therefore exposes a push service
 * (`ctx.dingtalk`) that any other plugin or script can use to deliver task
 * progress, results, and alerts to a DingTalk group — a natural companion to
 * the bidirectional Feishu adapter.
 *
 * @module dsh-connect-dingtalk
 */
import { Service, type Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { DingtalkWebhook, type DingtalkAt } from "./webhook.js";
import { dingtalkMessages, type DingtalkMessages } from "./i18n.js";

export { DingtalkWebhook, signDingtalk, verifyDingtalkSignature } from "./webhook.js";
export type { DingtalkAt, DingtalkBody, DingtalkResponse, DingtalkWebhookConfig } from "./webhook.js";
export { dingtalkMessages } from "./i18n.js";
export type { DingtalkMessages } from "./i18n.js";

/** Cordis plugin name used by loader diagnostics. */
export const name = "connect-dingtalk";

/** The `connect` service this adapter registers into (optional). */
export const inject = ["connect?"];

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
});

export interface DingtalkConfig {
  webhookUrl?: string;
  secret?: string;
  language?: "zh" | "en";
  defaultAt?: Partial<DingtalkAt>;
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

export function apply(ctx: Context, config: DingtalkConfig | null = {}): void {
  // The DSH loader passes `null` for entries without an explicit config.
  config = config ?? {};
  try {
    // `Service` construction registers `ctx.dingtalk` automatically.
    void new DingtalkService(ctx, config, ctx.logger);
  } catch (error) {
    ctx.logger?.warn?.(`connect-dingtalk: init failed: ${String(error)}`);
  }
}
