/**
 * Feishu/Lark channel adapter: long-connection (WebSocket) event intake via the
 * official SDK's high-level `createLarkChannel`, normalized message routing into
 * `dsh-connect`, and streaming replies back to Feishu.
 * @module dsh-connect-feishu
 */
import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { FeishuAdapter, type FeishuConfig } from "./adapter.js";
import { loadCredentials, onboardFeishu, saveCredentials } from "./onboard.js";

export { FeishuAdapter } from "./adapter.js";
export type { FeishuConfig } from "./adapter.js";
export { loadCredentials, onboardFeishu, saveCredentials } from "./onboard.js";
export type { FeishuCredentials } from "./onboard.js";

/** Cordis plugin name used by loader diagnostics. */
export const name = "connect-feishu";

/** The `connect` service this adapter registers into. */
export const inject = ["connect"];

/** Plugin config; secrets may come from config, the FEISHU_* environment, or one-click onboarding. */
export const Config = z.object({
  appId: z.string().role("secret"),
  appSecret: z.string().role("secret"),
  transport: z.union([z.const("websocket"), z.const("webhook")]),
  verificationToken: z.string().role("secret"),
  encryptKey: z.string().role("secret"),
  requireMention: z.boolean(),
  dmMode: z.union([z.const("open"), z.const("allowlist"), z.const("pair"), z.const("disabled")]),
});

interface ConnectLike {
  registerAdapter(adapter: unknown): void;
}

function start(connect: ConnectLike, config: FeishuConfig, logger?: { warn?: (...args: unknown[]) => void }): void {
  try {
    const adapter = new FeishuAdapter(config, logger);
    connect.registerAdapter(adapter);
    void adapter.start().catch((error) => {
      logger?.warn?.(`connect-feishu: start failed: ${String(error)}`);
    });
  } catch (error) {
    logger?.warn?.(`connect-feishu: adapter init failed: ${String(error)}`);
  }
}

/**
 * Register and start the Feishu adapter. `connect` comes from `inject`, so it
 * is guaranteed present. When no credentials are configured, the plugin enters
 * one-click onboarding (scan a QR / open a link) and connects with the
 * credentials the flow returns.
 */
export function apply(ctx: Context, config: FeishuConfig = {}): void {
  const connect = ctx.get("connect") as ConnectLike | undefined;
  if (connect === undefined) {
    throw new Error("connect-feishu: the dsh-connect service is not present; load it before this adapter");
  }

  const stored = loadCredentials();
  const appId = config.appId ?? process.env.FEISHU_APP_ID ?? stored?.appId;
  const appSecret = config.appSecret ?? process.env.FEISHU_APP_SECRET ?? stored?.appSecret;

  if (appId !== undefined && appSecret !== undefined) {
    start(connect, { ...config, appId, appSecret }, ctx.logger);
    return;
  }

  ctx.logger?.warn?.("connect-feishu: 未配置 appId/appSecret，进入一键接入模式（扫码或点击链接自动创建飞书应用）。");
  void onboardFeishu(ctx.logger).then((credentials) => {
    if (credentials === null) {
      ctx.logger?.warn?.("connect-feishu: 一键接入未完成，可重启重试，或手动配置 appId/appSecret。");
      return;
    }
    saveCredentials(credentials);
    ctx.logger?.warn?.(`connect-feishu: 一键接入成功（${credentials.appId}），正在连接…`);
    start(connect, { ...config, appId: credentials.appId, appSecret: credentials.appSecret }, ctx.logger);
  });
}
