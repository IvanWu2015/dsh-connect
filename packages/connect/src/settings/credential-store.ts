/**
 * Host-side credential store for dsh-connect channels. Adapts the DSH
 * `credentials` provider (`resolve/describe/set/unset`, env-style refs) into a
 * per-channel interface, so secrets live in the DSH credential store instead of
 * the plugin config (mirroring dsh-im's `credential-store.mjs`). The web
 * settings pane reports `configured` booleans and may echo store-backed secret
 * values (e.g. an appId) so an upgraded user can confirm them, but secrets
 * never persist to the settings state file — the credential store is the only
 * place secret values are held.
 *
 * @module dsh-connect/settings/credential-store
 */
import { CHANNELS, type ChannelName } from "./channels.js";

/**
 * One resolved credential: the non-empty secret value plus the source layer
 * that supplied it (`env`, `file`, `project-env`, `user-env`). Mirrors the
 * host's `ResolvedCredential` from `@deepseek-ai/dsh-credentials`.
 *
 * `resolve` returns this *object*, not a bare string. Reading it as a string
 * silently yields nothing — see `resolveValue`.
 */
export interface ResolvedCredential {
  value: string;
  source: string;
}

/** The seam the DSH host provides; `describe` reports source metadata. */
export interface CredentialsProvider {
  /**
   * Resolve one ref to its value, or `undefined`/`null` while unconfigured.
   * The host returns a `{value, source}` record; a plain string is also
   * accepted so hand-written stubs stay valid.
   */
  resolve(ref: string): Promise<ResolvedCredential | string | null | undefined>;
  describe(ref: string): Promise<{ configured: boolean; [k: string]: unknown }>;
  set(ref: string, value: string): Promise<void>;
  unset(ref: string): Promise<void>;
}

/** Unwrap either resolution shape to a non-empty string, else undefined. */
function resolveValue(resolved: ResolvedCredential | string | null | undefined): string | undefined {
  const value = typeof resolved === "string" ? resolved : resolved?.value;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Maps each channel's secret *config key* to its credential ref, so the
 * settings service and activation can enrich a channel config from the store.
 *
 * This is the **authoritative list of refs a channel owns**: every ref that
 * `save` can write appears here. A ref reachable only through
 * {@link CREDENTIAL_GROUPS} would be writable-but-unclearable — `save` and
 * `clear` both derive from this table for exactly that reason. */
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

/**
 * Credential sets that satisfy a channel, as groups-of-refs.
 *
 * Within a group every ref must be configured; between groups any one group
 * being complete is enough. The grouping exists for DingTalk, which has two
 * mutually exclusive transports — webhook push (url + signing secret) and
 * stream mode (client id + secret). A flat all-of list would report a
 * webhook-only user as "未配置凭据" because their stream refs are empty.
 *
 * An empty group list means the channel needs no credentials at all, so it is
 * always satisfied — `web` mirrors the DSH Web UI in-process and holds no
 * secret. Reporting that as unconfigured was pure noise in the pane's badge.
 */
export const CREDENTIAL_GROUPS: Record<ChannelName, readonly (readonly string[])[]> = Object.freeze({
  feishu: [["DSH_CONNECT_FEISHU_APP_ID", "DSH_CONNECT_FEISHU_APP_SECRET"]],
  telegram: [["DSH_CONNECT_TELEGRAM_BOT_TOKEN"]],
  dingtalk: [
    ["DSH_CONNECT_DINGTALK_WEBHOOK_URL", "DSH_CONNECT_DINGTALK_SECRET"],
    ["DSH_CONNECT_DINGTALK_CLIENT_ID", "DSH_CONNECT_DINGTALK_CLIENT_SECRET"],
  ],
  web: [],
}) as Record<ChannelName, readonly (readonly string[])[]>;

/**
 * Flat, de-duplicated view of every ref named by {@link CREDENTIAL_GROUPS},
 * in declaration order. Kept because existing callers and tests import it;
 * new code should prefer `CHANNEL_SECRET_KEYS` for the refs a channel owns.
 */
export const CREDENTIAL_REFS: Record<ChannelName, readonly string[]> = Object.freeze(
  Object.fromEntries(
    CHANNELS.map((channel) => [channel, groupRefs(channel)]),
  ),
) as Record<ChannelName, readonly string[]>;

/** De-duplicated union of every ref named by a channel's groups. */
function groupRefs(channel: ChannelName): readonly string[] {
  const seen = new Set<string>();
  for (const group of CREDENTIAL_GROUPS[channel] ?? []) {
    for (const ref of group) seen.add(ref);
  }
  return Object.freeze([...seen]);
}

/**
 * Every ref a channel may have written, i.e. the union of the refs named by its
 * groups and its config-key table. `clear` uses this so it cannot leave behind
 * a ref that `save` was able to write.
 */
function ownedRefs(channel: ChannelName): readonly string[] {
  const seen = new Set<string>(groupRefs(channel));
  for (const ref of Object.values(CHANNEL_SECRET_KEYS[channel] ?? {})) seen.add(ref);
  return [...seen];
}

/** A channel credential store bound to a DSH provider. */
export interface CredentialStore {
  /**
   * Whether the channel is usable, i.e. some group of {@link CREDENTIAL_GROUPS}
   * is fully configured. A channel with no groups is always usable.
   */
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
  return Object.freeze({
    async configured(channel: ChannelName) {
      const groups = CREDENTIAL_GROUPS[channel] ?? [];
      // No credential requirement at all (e.g. the in-process Web mirror):
      // nothing to be missing, so the channel counts as configured.
      if (groups.length === 0) return true;
      for (const group of groups) {
        const described = await Promise.all(group.map((ref) => provider.describe(ref)));
        if (described.every((d) => d.configured === true)) return true;
      }
      return false;
    },
    async save(channel: ChannelName, values: Record<string, string>) {
      // Iterate the config-key table, not the group union: it is the complete
      // list of refs this channel owns. Deriving the write set from the groups
      // silently dropped DingTalk's stream credentials, because only the
      // webhook group was represented there — the pane reported `ok: true`
      // while the clientId/clientSecret the user typed were never stored.
      for (const ref of Object.values(CHANNEL_SECRET_KEYS[channel] ?? {})) {
        const value = values[ref];
        if (value !== undefined) await provider.set(ref, value);
      }
    },
    async get(channel: ChannelName) {
      const map = CHANNEL_SECRET_KEYS[channel] ?? {};
      const entries = await Promise.all(
        Object.entries(map).map(async ([configKey, ref]) => {
          const value = resolveValue(await provider.resolve(ref));
          return [configKey, value] as const;
        }),
      );
      const out: Record<string, string> = {};
      for (const [configKey, value] of entries) {
        if (value !== undefined) out[configKey] = value;
      }
      return out;
    },
    async clear(channel: ChannelName) {
      const outcomes = await Promise.allSettled(ownedRefs(channel).map((ref) => provider.unset(ref)));
      if (outcomes.some((o) => o.status === "rejected")) {
        throw new Error(`Unable to clear ${channel} credentials.`);
      }
    },
  });
}