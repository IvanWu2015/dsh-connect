/**
 * `dsh-connect` — the single all-in-one plugin that bridges DeepSeek Harness to
 * chat platforms. It bundles the channel-agnostic `connect` service (adapter
 * registry, inbound routing, authorization, proactive notify), every channel
 * adapter (Feishu/Lark, Telegram, DingTalk, Web mirror), and the web-settings
 * stack (host RPC + credential store + settings pane) into one package.
 *
 * Install one plugin, write one `dsh-connect` config block, and enable exactly
 * the channels you use via `channels`.
 *
 * @module dsh-connect
 */
import { join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { ConnectService } from "./service.js";
import type { ConnectConfig } from "./runner.js";
import {
  activateChannels,
  CHANNELS,
  injectSecrets,
  type ChannelApply,
  type ChannelName,
} from "./settings/channels.js";
import { installSettingsRpc } from "./settings/settings-rpc.js";
import { createSettingsService } from "./settings/settings-service.js";
import { CHANNEL_CONFIG_FIELDS } from "./settings/settings-model.js";
import {
  createCredentialStore,
  type CredentialStore,
  type CredentialsProvider,
} from "./settings/credential-store.js";
import { register as feishuRegister } from "./channels/feishu/index.js";
import { register as telegramRegister } from "./channels/telegram/index.js";
import { register as dingtalkRegister } from "./channels/dingtalk/index.js";
import { register as webRegister } from "./channels/web/index.js";

export { ConnectService } from "./service.js";
export { AgentRunner, resolveConnectConfig } from "./runner.js";
export { MenuController } from "./menu-controller.js";
export type { MenuHost } from "./menu-controller.js";
export type { ConnectConfig, ResolvedConnectConfig } from "./runner.js";
export { applyStreamChunk, applyToolCall, classifyError, questionTextOf, summarizeTurn, toolCallSummary } from "./stream.js";
export type { ErrorCategory, NotifyLevel, StreamChunkLike, StreamState } from "./stream.js";
export { InteractionBridge, decodeTextAnswer } from "./interaction.js";
export type { AskQuestionLike } from "./interaction.js";
export { BindingStore } from "./binding.js";
export type { ChatBinding, ChatSessionRecord } from "./binding.js";
export { createAsyncQueue } from "./stream.js";
export { menuTitle, rootMenuSections, reasonLabel, goalPhaseLabel, listWorkspaces, menuRender } from "./menus.js";
export type { MenuId, MenuItem } from "./menus.js";
export { InboundDedup } from "./dedup.js";
export { retry, withOutboundRetry } from "./retry.js";
export type { RetryOptions } from "./retry.js";
export { acquire as acquireLock, canWrite as lockCanWrite, isLockTimedOut, release as releaseLockState, DEFAULT_LOCK_TIMEOUT_MS } from "./mirror-lock.js";
export type { LockState, QueuedMessage } from "./mirror-lock.js";
export { ReminderStore, formatRemindAt, parseRemindTime } from "./scheduler.js";
export type { ScheduledReminder } from "./scheduler.js";
export { parseCommand, helpText } from "./commands.js";
export type { Command } from "./commands.js";
export { messages } from "./i18n.js";
export type { Language, Messages } from "./i18n.js";
export type {
  ChatType,
  ChoiceOption,
  ChoicePrompt,
  ChoiceResult,
  InboundMessage,
  OutboundTarget,
  SummaryCard,
  TurnReason,
  TurnOutcome,
  AsyncQueue,
  ChannelAdapter,
} from "./types.js";

// Channel adapters (exposed as namespaces so each channel's Config/apply/register
// never collide with the merged plugin's own top-level exports).
export * as feishu from "./channels/feishu/index.js";
export * as telegram from "./channels/telegram/index.js";
export * as dingtalk from "./channels/dingtalk/index.js";
export * as web from "./channels/web/index.js";

// Web-settings stack (host RPC + credential store + persistence + client model).
export * as settings from "./settings/index.js";

/** Cordis plugin name used by loader diagnostics. */
export const name = "connect";

/**
 * Host-plane services this plugin must wait for before `apply` runs. All three
 * are provided by the base bundle. The credential store is NOT listed here:
 * cordis v4 has no `?` optional-inject marker — `"credentials?"` would be treated
 * as a required service literally named "credentials?" and stall the plugin. The
 * store is instead fetched lazily inside `apply` via the optional `ctx.get()`.
 */
export const inject = ["agents", "sessions", "agentDefaultModel"];

/**
 * Full plugin config: the channel-agnostic core fields plus the channel
 * selector (`channels`), shared `channelDefaults`, per-channel config, and the
 * web-settings state path. Each channel's own `Config` schema is also exported
 * (as `feishu.Config`, etc.) for reference; the merged entry validates loosely.
 */
export const Config = z.object({
  /** Agent preset id composed into each bound session; omit for the roster default. */
  agentPreset: z.string(),
  /** Absolute working directory per agent; defaults to the process cwd. */
  workDir: z.string(),
  /** Optional workspace directories offered by the `/dir` chooser. */
  workspaces: z.array(z.string()),
  /** Vision-capable model used to describe images when the main model can't see them. */
  visionModel: z.object({ provider: z.string(), model: z.string() }),
  /** User-facing message language: `zh` (default) or `en`. */
  language: z.union([z.const("zh"), z.const("en")]),
  /** Sender allowlist; empty = all senders allowed. */
  allowUsers: z.array(z.string()),
  /** Chat allowlist; empty = all chats allowed. */
  allowChats: z.array(z.string()),
  /** Directory for the bindings.json routing store. */
  stateDir: z.string(),
  /** Automatically create a Web mirror for new sessions (default: true). */
  autoMirror: z.boolean(),
  /** Liveness heartbeat interval ms for the streaming card; 0 disables it (default: 60000). */
  streamHeartbeatMs: z.number(),
  /** Default notification level for streaming replies. Default 'result' (final answer only) keeps cards short. */
  notifyLevel: z.union([z.const("full"), z.const("important"), z.const("result")]),
  /** Proactive progress-notice interval ms when a turn stays silent (default: 300000 = 5 min; 0 disables). */
  progressTimeoutMs: z.number(),
  /** Channels to activate; default: all built-in channels. */
  channels: z.array(z.union([z.const("feishu"), z.const("telegram"), z.const("dingtalk"), z.const("web")])),
  /** Keys applied to every channel that doesn't set its own (e.g. a shared `language`). */
  channelDefaults: z.any(),
  feishu: z.any(),
  telegram: z.any(),
  dingtalk: z.any(),
  web: z.any(),
  /** Optional path to persist web-settings edits (non-secret). */
  settingsStatePath: z.string(),
});

/** The merged plugin's config type (core fields + channel selector + settings). */
export interface ConnectSettingsConfig extends ConnectConfig {
  /** Channels to activate; default: all built-in channels. */
  channels?: ChannelName[];
  /** Keys applied to every channel that doesn't set its own (e.g. a shared `language`). */
  channelDefaults?: Record<string, unknown>;
  feishu?: Record<string, unknown>;
  telegram?: Record<string, unknown>;
  dingtalk?: Record<string, unknown>;
  web?: Record<string, unknown>;
  /** Optional path to persist web-settings edits (non-secret). */
  settingsStatePath?: string;
}

/** Convenience alias for the settings stack's channel-orchestration config. */
export type { ChannelsConfig, ChannelApply } from "./settings/channels.js";

declare module "@deepseek-ai/cordis" {
  interface Context {
    connect: ConnectService;
  }
}

/**
 * Register the `connect` service and start the enabled channel adapters, then
 * expose the web-settings RPC. `connect` is constructed first and passed *by
 * instance* into each channel's `register` — never resolved via
 * `ctx.get("connect")`, which returns undefined inside this plugin's own
 * `apply` (the fiber is still LOADING until this function resolves).
 */
export async function apply(ctx: Context, config: ConnectSettingsConfig | null = {}): Promise<void> {
  // Shallow-clone so we never mutate the caller's config object. Only core
  // fields are consumed by ConnectService; the rest are channel/settings.
  const cfg: ConnectSettingsConfig = { ...(config ?? {}) };
  const connect = new ConnectService(ctx, cfg);

  // Optional DSH credentials store: report presence + inject secrets into each
  // channel config so store-backed secrets reach the adapter without the config
  // file carrying them (they apply on the next plugin load).
  const credentialsProvider = (ctx as { get?: (name: string) => unknown }).get?.("credentials") as CredentialsProvider | undefined;
  let credentialStore: CredentialStore | undefined;
  if (credentialsProvider) {
    try { credentialStore = createCredentialStore(credentialsProvider); } catch { credentialStore = undefined; }
  }
  const wanted = cfg.channels ?? CHANNELS;
  const finalCfg = credentialStore
    ? await injectSecrets(cfg, wanted, (name) => credentialStore.get(name))
    : cfg;

  // Each channel's register receives the connect instance directly.
  const channels: Record<string, ChannelApply<Context>> = {
    feishu: (_ctx, channelConfig) => feishuRegister(connect, channelConfig, _ctx),
    telegram: (_ctx, channelConfig) => telegramRegister(connect, channelConfig, _ctx),
    dingtalk: (_ctx, channelConfig) => dingtalkRegister(connect, channelConfig, _ctx),
    web: (_ctx, channelConfig) => webRegister(connect, channelConfig, _ctx),
  };

  activateChannels<Context>(ctx, finalCfg, channels);

  // Expose the web-settings RPC. The host `connection` service is loaded as a
  // base plugin AFTER this user plugin's apply runs, so a plain optional inject
  // would see `ctx.connection === undefined` (installSettingsRpc would no-op and
  // no `/dsh-connect` channel would be mounted → the settings pane hangs on
  // "加载中"). Instead defer the registration into a nested injection scope that
  // waits for `connection` to be ready — the same pattern dsh-api-gateway uses
  // for its `/api` RPC. If the host never provides `connection` (non-web
  // runtime), the callback never runs and the RPC is simply absent.
  // Web settings pane state. The pane edits a settings-shape config persisted to
  // a JSON file and seeded from the live plugin config so it reflects the
  // channels actually enabled. Only NON-SECRET editable fields are seeded per
  // channel (secrets live in the credential store, never in the state file).
  // Default the file path under the state dir so Save persists out of the box.
  const settingsSeed: Record<string, unknown> = {
    channels: finalCfg.channels ?? CHANNELS,
    ...(finalCfg.channelDefaults ? { channelDefaults: finalCfg.channelDefaults } : {}),
  };
  for (const ch of CHANNELS) {
    const raw = (finalCfg as unknown as Record<string, Record<string, unknown>>)[ch] ?? {};
    const nonSecret: Record<string, unknown> = {};
    for (const field of CHANNEL_CONFIG_FIELDS[ch] ?? []) {
      if (raw[field.key] !== undefined) nonSecret[field.key] = raw[field.key];
    }
    if (Object.keys(nonSecret).length) settingsSeed[ch] = nonSecret;
  }
  const settingsStatePath = finalCfg.settingsStatePath
    ?? (cfg.stateDir ? join(cfg.stateDir, "dsh-connect-settings.json") : undefined);
  const settingsService = createSettingsService({ statePath: settingsStatePath, credentialStore, initialConfig: settingsSeed });
  if (typeof (ctx as { inject?: unknown }).inject === "function") {
    (ctx as Context).inject(["connection"], (connectionCtx) => {
      installSettingsRpc(connectionCtx, { service: settingsService });
    });
  } else {
    // Fallback for a bare context without the inject-scope API: try directly.
    installSettingsRpc(ctx, { service: settingsService });
  }
}

// The DSH loader (cordis-plugin-loader) resolves a plugin entry to the module's
// DEFAULT export via `unwrapExports()` (`exports.default ?? exports`), then
// hands it to `ctx.registry.plugin()`. An object `{ apply, name, inject }` makes
// the loader route through `apply` — the function that activates the channel
// adapters and installs the web-settings RPC.
//
// Previously the default export was the `ConnectService` class. That "worked"
// on the surface (the class was constructed, no error) but `apply` was never
// called, so `activateChannels` and `installSettingsRpc` were silently skipped:
// no channel was bound and no `/dsh-connect` RPC route was mounted (the web
// settings pane hung on "加载中"). Routing through `apply` fixes it.
export default { apply, name, inject };
