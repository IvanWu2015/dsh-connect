/**
 * Feishu/Lark channel adapter: long-connection (WebSocket) event intake via the
 * official SDK's high-level `createLarkChannel`, normalized message routing into
 * `dsh-connect`, and streaming replies back to Feishu.
 * @module dsh-connect-feishu
 */
import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { FeishuAdapter, type FeishuConfig } from "./adapter.js";

export { FeishuAdapter } from "./adapter.js";
export type { FeishuConfig } from "./adapter.js";

/** Cordis plugin name used by loader diagnostics. */
export const name = "connect-feishu";

/** The `connect` service this adapter registers into. */
export const inject = ["connect"];

/** Plugin config; secrets may come from config or the FEISHU_* environment. */
export const Config = z.object({
  appId: z.string().role("secret"),
  appSecret: z.string().role("secret"),
  transport: z.union([z.const("websocket"), z.const("webhook")]),
  verificationToken: z.string().role("secret"),
  encryptKey: z.string().role("secret"),
  requireMention: z.boolean(),
  dmMode: z.union([z.const("open"), z.const("allowlist"), z.const("pair"), z.const("disabled")]),
});

/**
 * Register and start the Feishu adapter. `connect` comes from `inject`, so it
 * is guaranteed present; the adapter owns connection lifecycle and auto-reconnect.
 */
export function apply(ctx: Context, config: FeishuConfig = {}): void {
  const connect = ctx.get("connect");
  if (connect === undefined) {
    throw new Error("connect-feishu: the dsh-connect service is not present; load it before this adapter");
  }
  const adapter = new FeishuAdapter(config, ctx.logger);
  connect.registerAdapter(adapter);
  void adapter.start().catch((error) => {
    ctx.logger?.warn?.(`connect-feishu: start failed: ${String(error)}`);
  });
}
