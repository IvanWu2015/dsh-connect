/**
 * Host-side credential store for dsh-connect channels. Adapts the DSH
 * `credentials` provider (`resolve/describe/set/unset`, env-style refs) into a
 * per-channel interface, so secrets live in the DSH credential store instead of
 * the plugin config (mirroring dsh-im's `credential-store.mjs`). The web
 * settings pane only ever sees `configured` booleans, never secret values.
 *
 * @module dsh-connect/settings/credential-store
 */
import { CHANNELS, type ChannelName } from "./channels.js";

/** The seam the DSH host provides; `describe` reports source metadata. */
export interface CredentialsProvider {
  resolve(ref: string): Promise<string | null | undefined>;
  describe(ref: string): Promise<{ configured: boolean; [k: string]: unknown }>;
  set(ref: string, value: string): Promise<void>;
  unset(ref: string): Promise<void>;
}

/** Credential references owned by each channel (alphabetical, stable). */
export const CREDENTIAL_REFS: Record<ChannelName, readonly string[]> = Object.freeze({
  feishu: ["DSH_CONNECT_FEISHU_APP_ID", "DSH_CONNECT_FEISHU_APP_SECRET"],
  telegram: ["DSH_CONNECT_TELEGRAM_BOT_TOKEN"],
  dingtalk: ["DSH_CONNECT_DINGTALK_WEBHOOK_URL", "DSH_CONNECT_DINGTALK_SECRET"],
  web: [],
}) as Record<ChannelName, readonly string[]>;

/** Maps each channel's secret *config key* to its credential ref, so the
 * settings service and activation can enrich a channel config from the store. */
export const CHANNEL_SECRET_KEYS: Record<ChannelName, Record<string, string>> = Object.freeze({
  feishu: { appId: "DSH_CONNECT_FEISHU_APP_ID", appSecret: "DSH_CONNECT_FEISHU_APP_SECRET" },
  telegram: { botToken: "DSH_CONNECT_TELEGRAM_BOT_TOKEN" },
  dingtalk: {
    webhookUrl: "DSH_CONNECT_DINGTALK_WEBHOOK_URL",
    secret: "DSH_CONNECT_DINGTALK_SECRET",
    clientId: "DSH_CONNECT_DINGTALK_CLIENT_ID",
    clientSecret: "DSH_CONNECT_DINGTALK_CLIENT_SECRET",
  },
  web: {},
});

/** A channel credential store bound to a DSH provider. */
export interface CredentialStore {
  /** Whether every ref for the channel is configured (secrets present). */
  configured(channel: ChannelName): Promise<boolean>;
  /** Persist a channel secret under its ref. */
  save(channel: ChannelName, values: Record<string, string>): Promise<void>;
  /** Read the channel's stored secrets as { configKey: value }. */
  get(channel: ChannelName): Promise<Record<string, string>>;
  /** Remove every ref for the channel. */
  clear(channel: ChannelName): Promise<void>;
}

function assertProvider(provider: CredentialsProvider): void {
  for (const method of ["resolve", "describe", "set", "unset"] as const) {
    if (typeof provider[method] !== "function") {
      throw new TypeError(`A DSH credential provider with ${method}() is required`);
    }
  }
}

/** Build a per-channel credential store over a DSH `credentials` provider. */
export function createCredentialStore(provider: CredentialsProvider): CredentialStore {
  assertProvider(provider);
  const refs = (channel: ChannelName) => CREDENTIAL_REFS[channel] ?? [];
  return Object.freeze({
    async configured(channel: ChannelName) {
      const list = refs(channel);
      if (list.length === 0) return false;
      const described = await Promise.all(list.map((ref) => provider.describe(ref)));
      return described.every((d) => d.configured === true);
    },
    async save(channel: ChannelName, values: Record<string, string>) {
      for (const ref of refs(channel)) {
        const value = values[ref];
        if (value !== undefined) await provider.set(ref, value);
      }
    },
    async get(channel: ChannelName) {
      const map = CHANNEL_SECRET_KEYS[channel] ?? {};
      const entries = await Promise.all(
        Object.entries(map).map(async ([configKey, ref]) => {
          const value = await provider.resolve(ref);
          return [configKey, value] as const;
        }),
      );
      const out: Record<string, string> = {};
      for (const [configKey, value] of entries) {
        if (typeof value === "string" && value.length > 0) out[configKey] = value;
      }
      return out;
    },
    async clear(channel: ChannelName) {
      const outcomes = await Promise.allSettled(refs(channel).map((ref) => provider.unset(ref)));
      if (outcomes.some((o) => o.status === "rejected")) {
        throw new Error(`Unable to clear ${channel} credentials.`);
      }
    },
  });
}