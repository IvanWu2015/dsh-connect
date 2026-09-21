/**
 * Feishu/Lark channel adapter: long-connection (WebSocket) event intake via the
 * official SDK's high-level `createLarkChannel`, normalized message routing into
 * `dsh-connect`, and streaming replies back to Feishu.
 * @module dsh-connect/feishu
 */
import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { FeishuAdapter, type FeishuConfig } from "./adapter.js";
import { loadCredentials, onboardFeishu, saveCredentials } from "./onboard.js";
import { feishuMessages } from "./i18n.js";

export { FeishuAdapter } from "./adapter.js";
export type { FeishuConfig } from "./adapter.js";
export { padLabels, buildButtonGrid, buildSelectMenu, buildChoiceElements, sanitizeFileName, extractErrorDetail, classifyFeishuFile } from "./adapter.js";
export { encodeChatKey, decodeChatKey } from "../../chat-key.js";
export { loadCredentials, onboardFeishu, saveCredentials } from "./onboard.js";
export type { FeishuCredentials } from "./onboard.js";

/** Plugin config; secrets may come from config, the FEISHU_* environment, or one-click onboarding. */
export const Config = z.object({
  appId: z.string().role("secret"),
  appSecret: z.string().role("secret"),
  transport: z.union([z.const("websocket"), z.const("webhook")]),
  verificationToken: z.string().role("secret"),
  encryptKey: z.string().role("secret"),
  webhookPort: z.number().min(1).max(65535),
  webhookPath: z.string(),
  requireMention: z.boolean(),
  dmMode: z.union([z.const("open"), z.const("allowlist"), z.const("pair"), z.const("disabled")]),
  threadIsolation: z.boolean(),
  language: z.union([z.const("zh"), z.const("en")]),
  /** Set false to never enter the interactive one-click onboarding flow. */
  onboarding: z.boolean(),
});

interface ConnectLike {
  registerAdapter(adapter: unknown): void;
  /** Allowlist gate usable by adapters before they download message resources. */
  isChatAllowed?(channel: string, chatKey: string, senderKey: string): boolean;
}

function start(connect: ConnectLike, config: FeishuConfig, logger?: { warn?: (...args: unknown[]) => void }): void {
  try {
    // Bind the service method: FeishuAdapter invokes it as `this.isChatAllowed(...)`,
    // so a bare reference would lose the ConnectService `this` (and crash on this.config).
    const adapter = new FeishuAdapter(config, logger, connect.isChatAllowed?.bind(connect));
    connect.registerAdapter(adapter);
    void adapter.start().catch((error) => {
      logger?.warn?.(`connect-feishu: start failed: ${String(error)}`);
    });
  } catch (error) {
    logger?.warn?.(`connect-feishu: adapter init failed: ${String(error)}`);
  }
}

/** What `register` needs beyond the config, injected by the merged entry. */
export interface FeishuRegisterOptions {
  /**
   * The DSH credential store. Onboarding results are written here as well as to
   * the legacy JSON file, so the pane's 「已配置凭据」 badge reflects the app that
   * was actually just created instead of staying permanently unconfigured.
   */
  credentialStore?: { save(channel: "feishu", values: Record<string, string>): Promise<void> };
  /**
   * Whether an interactive onboarding flow is acceptable. Defaults to whether
   * stdout is a TTY; tests pass it explicitly.
   */
  interactive?: boolean;
}

/**
 * Register and start the Feishu adapter. `connect` is the already-constructed
 * `ConnectService` instance (passed from the merged entry, not resolved via
 * `ctx.get` — that returns undefined during the same plugin's `apply`). When no
 * credentials are configured, the plugin enters one-click onboarding (scan a QR /
 * open a link) and connects with the credentials the flow returns.
 */
export function register(
  connect: ConnectLike,
  config: FeishuConfig | null = {},
  ctx: Context,
  options: FeishuRegisterOptions = {},
): void {
  // The DSH loader passes `null` for entries without an explicit config.
  config = config ?? {};

  const stored = loadCredentials();
  const appId = config.appId ?? process.env.FEISHU_APP_ID ?? stored?.appId;
  const appSecret = config.appSecret ?? process.env.FEISHU_APP_SECRET ?? stored?.appSecret;

  if (appId !== undefined && appSecret !== undefined) {
    start(connect, { ...config, appId, appSecret }, ctx.logger);
    return;
  }

  const t = feishuMessages(config.language ?? "zh");

  // Onboarding is interactive by definition: it prints a QR/link and waits for a
  // human. A headless service host (the normal `dsh web --profile web` boot) has
  // no TTY and nobody to scan, so starting it there just parks a timer and logs a
  // link that scrolls away. Warn with the actionable alternative instead.
  const interactive = options.interactive ?? process.stdout.isTTY === true;
  if (config.onboarding === false || !interactive) {
    ctx.logger?.warn?.(t.onboardingSkipped);
    return;
  }

  ctx.logger?.warn?.(t.onboardingEnter);
  void onboardFeishu(ctx.logger, config.language ?? "zh").then(async (credentials) => {
    if (credentials === null) {
      ctx.logger?.warn?.(t.onboardingIncomplete);
      return;
    }
    // Legacy mirror: older builds (and a downgrade) read this file. Best-effort.
    saveCredentials(credentials);
    // The DSH credential store is the source of truth from here on: the next
    // boot's `injectSecrets` fills the channel config from it, so onboarding
    // does not run again and the settings pane reports the app as configured.
    try {
      await options.credentialStore?.save("feishu", {
        appId: credentials.appId,
        appSecret: credentials.appSecret,
      });
    } catch (error) {
      ctx.logger?.warn?.(`connect-feishu: could not persist credentials to the store: ${String(error)}`);
    }
    ctx.logger?.warn?.(t.onboardingSuccess(credentials.appId));
    start(connect, { ...config, appId: credentials.appId, appSecret: credentials.appSecret }, ctx.logger);
  });
}

/**
 * Compatibility shell for the old split-plugin registration path (when `connect`
 * is an already-active, separate plugin). The merged entry calls `register`
 * directly instead, because `ctx.get("connect")` returns undefined inside this
 * plugin's own `apply`.
 */
export function apply(ctx: Context, config: FeishuConfig | null = {}): void {
  const connect = ctx.get("connect") as ConnectLike | undefined;
  if (connect === undefined) {
    throw new Error("connect-feishu: the dsh-connect service is not present; load it before this adapter");
  }
  register(connect, config, ctx);
}
