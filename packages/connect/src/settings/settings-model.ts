/**
 * Client-side settings model: pure, dependency-free helpers that map between the
 * host snapshot and the edit form, and build the save payloads. Kept separate from
 * the React component so the client settings logic is unit-testable anywhere.
 * The host-only secret-ref mapping lives on the server; the client only carries
 * field names.
 *
 * @module dsh-connect/settings/settings-model
 */
import { CHANNEL_SECRET_KEYS } from "./credential-store.js";
import type { ChannelName } from "./channels.js";
import type { SettingsSnapshot } from "./settings-rpc.js";

/** Secret config-keys per channel, for rendering secret inputs. */
export const CHANNEL_SECRET_FIELDS = Object.fromEntries(
  Object.entries(CHANNEL_SECRET_KEYS).map(([ch, map]) => [ch, Object.keys(map ?? {})]),
) as Record<ChannelName, string[]>;

/**
 * A non-secret, user-editable per-channel config field. `kind` drives how the
 * pane renders the control and how `coerceConfigValue` normalizes the raw input
 * (text → string, number → finite number, boolean → false on empty, select →
 * one of `options`).
 */
export interface ConfigField {
  key: string;
  kind: 'text' | 'number' | 'boolean' | 'select';
  options?: string[];
  /** Human label; defaults to the key if absent. */
  label?: string;
}

/**
 * Non-secret per-channel fields the pane exposes, mirroring the keys used by
 * each channel adapter config (see `examples/profile-cordis.patch.yml`). Order
 * is the render order; keep secrets separate (`CHANNEL_SECRET_FIELDS`).
 */
export const CHANNEL_CONFIG_FIELDS = {
  feishu: [
    { key: 'transport', kind: 'select', options: ['websocket', 'webhook'], label: 'transport' },
    { key: 'requireMention', kind: 'boolean', label: 'requireMention' },
    { key: 'dmMode', kind: 'select', options: ['open', 'allowlist', 'pair', 'disabled'], label: 'dmMode' },
    { key: 'language', kind: 'select', options: ['zh', 'en'], label: 'language' },
    { key: 'webhookPort', kind: 'number', label: 'webhookPort' },
    { key: 'webhookPath', kind: 'text', label: 'webhookPath' },
  ],
  telegram: [
    { key: 'requireMention', kind: 'boolean', label: 'requireMention' },
    { key: 'language', kind: 'select', options: ['zh', 'en'], label: 'language' },
    { key: 'pollingTimeoutSeconds', kind: 'number', label: 'pollingTimeoutSeconds' },
    { key: 'baseUrl', kind: 'text', label: 'baseUrl' },
  ],
  dingtalk: [
    { key: 'language', kind: 'select', options: ['zh', 'en'], label: 'language' },
    { key: 'defaultAt', kind: 'text', label: 'defaultAt' },
  ],
  web: [
    { key: 'pollIntervalMs', kind: 'number', label: 'pollIntervalMs' },
  ],
} as const satisfies Record<ChannelName, readonly ConfigField[]>;

/** Channel-agnostic keys applied to every channel that doesn't set its own. */
export const CHANNEL_DEFAULT_FIELDS: readonly ConfigField[] = [
  { key: 'language', kind: 'select', options: ['zh', 'en'], label: 'language' },
  { key: 'notifyLevel', kind: 'select', options: ['full', 'important', 'result'], label: 'notifyLevel' },
];

/** Normalize a raw form input for a field `kind` (empty → undefined = not saved). */
export function coerceConfigValue(kind: ConfigField['kind'], raw: unknown): unknown {
  if (raw === undefined || raw === null || raw === '') return undefined;
  switch (kind) {
    case 'number': {
      const n = Number(raw);
      return Number.isFinite(n) ? n : undefined;
    }
    case 'boolean':
      return typeof raw === 'boolean' ? raw : raw === true || raw === 'true';
    case 'select':
      return String(raw);
    default:
      return String(raw);
  }
}

/** The edit form the pane works on. */
export interface SettingsForm {
  channels: ChannelName[];
  channelDefaults: Record<string, unknown>;
  channelConfigs: Record<string, Record<string, unknown>>;
  secrets: Record<string, Record<string, string>>;
  settingsStatePath?: string;
}

/** Build the initial form from a snapshot. */
export function snapshotToForm(snapshot: SettingsSnapshot): SettingsForm {
  const config = snapshot.config ?? {};
  const channels = (snapshot.enabled ?? []) as ChannelName[];
  const channelConfigs: Record<string, Record<string, unknown>> = {};
  for (const ch of channels) channelConfigs[ch] = (config[ch] ?? {}) as Record<string, unknown>;
  return {
    channels,
    channelDefaults: (config.channelDefaults ?? {}) as Record<string, unknown>,
    channelConfigs,
    secrets: {},
    settingsStatePath: config.settingsStatePath as string | undefined,
  };
}

/** Drop keys whose value is `undefined`/`null` so cleared inputs aren't persisted. */
function stripEmpty(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined && v !== null) out[k] = v;
  return out;
}

/** Build the non-secret config to persist via `settings.save`. */
export function buildConfigSave(form: SettingsForm): Record<string, unknown> {
  const config: Record<string, unknown> = { channels: form.channels };
  const defaults = stripEmpty(form.channelDefaults ?? {});
  if (Object.keys(defaults).length > 0) config.channelDefaults = defaults;
  for (const [ch, cfg] of Object.entries(form.channelConfigs ?? {})) {
    const clean = stripEmpty(cfg ?? {});
    if (Object.keys(clean).length > 0) config[ch] = clean;
  }
  if (form.settingsStatePath) config.settingsStatePath = form.settingsStatePath;
  return config;
}

/** Build the `credentials.save` payloads for every channel with secret values. */
export function buildCredentialSaves(form: SettingsForm): { channel: string; values: Record<string, string> }[] {
  const out: { channel: string; values: Record<string, string> }[] = [];
  for (const [ch, values] of Object.entries(form.secrets ?? {})) {
    if (values && Object.keys(values).length > 0) out.push({ channel: ch, values });
  }
  return out;
}