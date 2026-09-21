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
import { resolveStateDir } from "./state-dir.js";
import {
  CHANNELS,
  extractConfigSecrets,
  injectSecrets,
  type ChannelApply,
  type ChannelName,
  type ChannelsConfig,
} from "./settings/channels.js";
import { ChannelRuntime } from "./settings/channel-runtime.js";
import { installConnectSection, type SettingsProviderLike } from "./settings/namespace.js";
import { installSettingsRpc } from "./settings/settings-rpc.js";
import { createSettingsService } from "./settings/settings-service.js";
import { CHANNEL_CONFIG_FIELDS } from "./settings/settings-model.js";
import {
  CHANNEL_SECRET_KEYS,
  createCredentialStore,
  type CredentialStore,
  type CredentialsProvider,
} from "./settings/credential-store.js";
import { register as feishuRegister, loadCredentials } from "./channels/feishu/index.js";
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

/**
 * Backward-compat: on boot, seed the credential store from secrets a channel
 * config already carries (e.g. `feishu.appId`/`appSecret` written into the
 * profile before the web-settings pane existed). Keeps the pane's presence
 * reporting honest — an upgraded user whose channels work via config-file
 * secrets sees them as "已配置" instead of "未配置凭据".
 *
 * Non-destructive by design: a ref the store already holds is never re-written
 * (pane-saved credentials always win), and only refs present in the config
 * (non-empty string, at their real flat/nested location) are migrated. Secrets
 * still never reach the settings state file — they only move into the store.
 */
async function seedCredentialRefs(
  provider: CredentialsProvider,
  secretKeys: Record<string, string>,
  secrets: Record<string, string>,
): Promise<void> {
  for (const [configKey, ref] of Object.entries(secretKeys)) {
    const value = secrets[configKey];
    if (value === undefined) continue;
    let alreadyConfigured = false;
    try {
      alreadyConfigured = (await provider.describe(ref)).configured === true;
    } catch {
      alreadyConfigured = false;
    }
    if (alreadyConfigured) continue;
    try {
      await provider.set(ref, value);
    } catch {
      // Per-ref migration failure should never block activation.
    }
  }
}

/**
 * Fold credentials left behind by the legacy one-click onboarding file into the
 * store. Feishu's onboarding predates the credential store and wrote its own
 * JSON, which nothing but the adapter read — so a user who onboarded before the
 * store existed had a working bot that the settings pane reported as
 * 「未配置凭据」 forever. Migration is idempotent and never overwrites a value the
 * store already holds.
 */
async function migrateOnboardedSecrets(
  provider: CredentialsProvider,
  enabled: readonly ChannelName[],
): Promise<void> {
  if (!enabled.includes("feishu")) return;
  let onboarded: { appId: string; appSecret: string } | null = null;
  try {
    onboarded = loadCredentials();
  } catch {
    return;
  }
  if (onboarded === null) return;
  await seedCredentialRefs(provider, CHANNEL_SECRET_KEYS.feishu, {
    appId: onboarded.appId,
    appSecret: onboarded.appSecret,
  });
}

async function migrateConfigSecrets(
  provider: CredentialsProvider,
  cfg: ConnectSettingsConfig,
  enabled: readonly ChannelName[],
): Promise<void> {
  for (const ch of enabled) {
    const secretKeys = CHANNEL_SECRET_KEYS[ch] ?? {};
    if (Object.keys(secretKeys).length === 0) continue;
    const raw = (cfg as Record<string, unknown>)[ch] as Record<string, unknown> | undefined;
    const secrets = extractConfigSecrets(raw, ch, secretKeys);
    if (Object.keys(secrets).length === 0) continue;
    await seedCredentialRefs(provider, secretKeys, secrets);
  }
  await migrateOnboardedSecrets(provider, enabled);
}

/** Cordis plugin name used by loader diagnostics. */
export const name = "connect";

/**
 * Host-plane services this plugin must wait for before `apply` runs. All four
 * are rows in the always-loaded `@deepseek-ai/dsh-base` bundle — the shared core
 * of every base-backed profile — so requiring them cannot stall the plugin in
 * any profile that can load `dsh-connect` at all.
 *
 * `credentials` must be listed here, not read lazily inside `apply`: a
 * `ctx.get("credentials")` at apply time returns `undefined`, because this
 * plugin activates before the credentials row does. That silently disabled the
 * whole credential path — `migrateConfigSecrets` never seeded the store (so an
 * upgraded user's working channels displayed "未配置凭据"), `injectSecrets`
 * never merged store-backed secrets into a channel config, and
 * `settings.saveCredentials` threw `not-configured` for every pane save. Note
 * cordis v4 has no `?` optional-inject marker, so `"credentials?"` would be read
 * as a required service literally named `"credentials?"` — that is a syntax
 * hazard, not a reason the service itself is unavailable.
 */
export const inject = ["agents", "sessions", "agentDefaultModel", "credentials"];

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

  // DSH credentials store: report presence + inject secrets into each channel
  // config so store-backed secrets reach the adapter without the config file
  // carrying them. `credentials` is a declared inject (see `inject` above), so
  // it is guaranteed present by the time `apply` runs; the optional `ctx.get()`
  // read is kept only so a bare context (unit tests) degrades to "no store"
  // rather than throwing.
  const credentialsProvider = (ctx as { get?: (name: string) => unknown }).get?.("credentials") as CredentialsProvider | undefined;
  let credentialStore: CredentialStore | undefined;
  if (credentialsProvider) {
    try { credentialStore = createCredentialStore(credentialsProvider); } catch { credentialStore = undefined; }
  }
  const wanted = cfg.channels ?? CHANNELS;
  // Migrate config-file secrets into the store before activation, so an upgraded
  // user's already-working channels report as configured (and the store becomes
  // the single source of truth). Best-effort: never blocks the plugin load.
  if (credentialStore && credentialsProvider) {
    try {
      await migrateConfigSecrets(credentialsProvider, cfg, wanted);
    } catch {
      // Ignore a migration failure; activation continues with existing config.
    }
  }
  const finalCfg = credentialStore
    ? await injectSecrets(cfg, wanted, (name) => credentialStore.get(name))
    : cfg;

  // Each channel's register receives the connect instance directly.
  const channels: Record<string, ChannelApply<Context>> = {
    // Feishu additionally gets the credential store so a completed one-click
    // onboarding lands in the DSH store (and not only in its own legacy file).
    feishu: (_ctx, channelConfig) => feishuRegister(connect, channelConfig, _ctx, { credentialStore }),
    telegram: (_ctx, channelConfig) => telegramRegister(connect, channelConfig, _ctx),
    dingtalk: (_ctx, channelConfig) => dingtalkRegister(connect, channelConfig, _ctx),
    web: (_ctx, channelConfig) => webRegister(connect, channelConfig, _ctx),
  };

  // Channel lifecycle is owned by a runtime, not a one-shot activation: once
  // the channel list is user-editable, dropping a channel has to *stop* its
  // adapter (a live Feishu long connection would otherwise outlive its config)
  // and a reconfigured channel has to restart before the old transport is
  // still delivering. See `settings/channel-runtime.ts`.
  const runtime = new ChannelRuntime<Context>({
    ctx,
    channels,
    teardown: (name) => connect.unregisterAdapter(name),
    getSecrets: credentialStore ? (name) => credentialStore.get(name) : undefined,
  });
  await runtime.apply(finalCfg);

  // Register the `dsh-connect` namespace so the channel selection and the
  // per-channel non-secret options become user-editable and *effective*:
  // `installSection` layers the plugin's own config (as `base`) under the
  // user's `settings.yaml` section, and every change re-reconciles the running
  // adapters through the runtime above. The panel's own RPC
  // (`settings/settings-rpc.ts`) is a separate transport onto the same idea and
  // is kept for the pane's compatibility path.
  //
  // Deferred through `inject` for the same reason as the RPC below: `settings`
  // is a `dsh-base` row loaded after a user plugin's `apply` runs, so a plain
  // optional read would see `undefined` and never register anything. If the
  // host never provides it the callback never runs and the plugin config
  // stands on its own — which is exactly what `installConnectSection` falls
  // back to.
  const installNamespace = (scopeCtx: Context): void => {
    installConnectSection<Context>({
      owner: scopeCtx,
      settings: (scopeCtx as { get?: (name: string) => unknown }).get?.("settings") as
        | SettingsProviderLike
        | undefined,
      entry: finalCfg,
      onChange: (section) => {
        void runtime.apply(section as ChannelsConfig);
      },
    });
  };
  if (typeof (ctx as { inject?: unknown }).inject === "function") {
    (ctx as Context).inject(["settings"], installNamespace);
  } else {
    // Bare context (unit tests): no inject-scope API, install directly.
    installNamespace(ctx);
  }

  // Expose the web-settings RPC. The host `connection`/`webServer` services are
  // loaded as base plugins AFTER this user plugin's apply runs, so a plain
  // optional inject would see `ctx.connection === undefined` and mount nothing
  // (the settings pane then hangs on "加载中"). Instead defer the registration
  // into a nested injection scope that waits for both to be ready — the same
  // pattern dsh-api-gateway uses for its `/api` route. If the host never
  // provides them (non-web runtime), the callback never runs and the RPC is
  // simply absent.
  //
  // Both services are required in the injected set: `installSettingsRpc` mounts
  // the channel as a `prefix` route on `webServer` itself (see its doc for why
  // `connection.rpc.handle` cannot be used for a third-party channel), and it
  // reads `connection.requestRejection` for the Host/Origin + browser-auth
  // fence.
  //
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
  // Resolve through the shared helper and off the *merged* config, so the state
  // file lands beside `bindings.json` and can't disagree with the stores. This
  // used to read the raw `cfg.stateDir`, which made the path `undefined` for
  // every profile that never set `stateDir` — and an undefined path made the
  // settings service degrade to in-memory, so a pane save silently vanished.
  const settingsStatePath = finalCfg.settingsStatePath
    ?? join(resolveStateDir(finalCfg), "dsh-connect-settings.json");
  const settingsService = createSettingsService({ statePath: settingsStatePath, credentialStore, initialConfig: settingsSeed });
  if (typeof (ctx as { inject?: unknown }).inject === "function") {
    (ctx as Context).inject(["connection", "webServer"], (scopeCtx) => {
      installSettingsRpc(scopeCtx, { service: settingsService });
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
