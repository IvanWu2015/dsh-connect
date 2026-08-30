/**
 * `dsh-connect-all` — all-in-one channel bundle for `dsh-connect`.
 *
 * Instead of installing one plugin per IM channel (`dsh-connect-feishu`,
 * `dsh-connect-telegram`, `dsh-connect-dingtalk`, `dsh-connect-web`), install
 * this single plugin and enable exactly the channels you use with the
 * `channels` config. Each channel is still a separate cordis adapter rendered
 * through the `connect` service, but you only write one config block and one
 * entry in the profile.
 *
 * @module dsh-connect-all
 */
import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { apply as feishuApply } from "dsh-connect-feishu";
import { apply as telegramApply } from "dsh-connect-telegram";
import { apply as dingtalkApply } from "dsh-connect-dingtalk";
import { apply as webApply } from "dsh-connect-web";
import { activateChannels, CHANNELS, injectSecrets, type ChannelApply, type ConnectAllConfig } from "./channels.js";
import { installSettingsRpc } from "./settings-rpc.js";
import { createSettingsService } from "./settings-service.js";
import { createCredentialStore, type CredentialsProvider } from "./credential-store.js";

export { activateChannels, CHANNELS } from "./channels.js";
export { SETTINGS_RPC_CHANNEL } from "./settings-rpc.js";
export type { ChannelName, ChannelApply, ConnectAllConfig } from "./channels.js";

export const name = "dsh-connect-all";

/** The `connect` service must be loaded first; it collects each adapter. */
export const inject = ["connect", "credentials?"];

/** Plugin config: which channels to enable + each channel's own config. */
export const Config = z.object({
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

/**
 * Register and start the enabled channel adapters into `connect`. Each
 * channel's `apply` is synchronous and self-registers via `connect`. A single
 * failing channel is caught so the others still come up. Optional DSH
 * credential-store secrets are injected into each channel config, so secrets
 * saved in the web settings pane reach the adapter without living in the
 * config file (they apply on the next plugin load).
 */
export async function apply(ctx: Context, config: ConnectAllConfig | null = {}): Promise<void> {
  // Shallow-clone so we never mutate the caller's config object.
  const cfg: ConnectAllConfig = { ...(config ?? {}) };
  const channels: Record<string, ChannelApply<Context>> = {
    feishu: (c, cfg) => feishuApply(c, cfg),
    telegram: (c, cfg) => telegramApply(c, cfg),
    dingtalk: (c, cfg) => dingtalkApply(c, cfg),
    web: (c, cfg) => webApply(c, cfg),
  };

  // Optional DSH credentials store: report presence + inject secrets.
  const credentialsProvider = (ctx as any).get?.("credentials") as CredentialsProvider | undefined;
  let credentialStore: import("./credential-store.js").CredentialStore | undefined;
  if (credentialsProvider) {
    try { credentialStore = createCredentialStore(credentialsProvider); } catch { credentialStore = undefined; }
  }
  const wanted = cfg.channels ?? CHANNELS;
  const finalCfg = credentialStore
    ? await injectSecrets(cfg, wanted, (name) => credentialStore.get(name))
    : cfg;

  activateChannels<Context>(ctx, finalCfg, channels);

  // Expose the web-settings RPC (no-ops safely when there is no host connection).
  installSettingsRpc(ctx, { service: createSettingsService({ statePath: finalCfg.settingsStatePath, credentialStore }) });
}

