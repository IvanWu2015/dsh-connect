/**
 * Client-side settings model: pure, dependency-free helpers that map between the
 * host snapshot and the edit form, and build the save payloads. Kept separate from
 * the React component so the client settings logic is unit-testable anywhere.
 * The host-only secret-ref mapping lives on the server; the client only carries
 * field names.
 *
 * @module dsh-connect-all/settings-model
 */
import { CHANNEL_SECRET_KEYS } from "./credential-store.js";
import type { ChannelName } from "./channels.js";
import type { SettingsSnapshot } from "./settings-rpc.js";

/** Secret config-keys per channel, for rendering secret inputs. */
export const CHANNEL_SECRET_FIELDS = Object.fromEntries(
  Object.entries(CHANNEL_SECRET_KEYS).map(([ch, map]) => [ch, Object.keys(map ?? {})]),
) as Record<ChannelName, string[]>;

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

/** Build the non-secret config to persist via `settings.save`. */
export function buildConfigSave(form: SettingsForm): Record<string, unknown> {
  const config: Record<string, unknown> = { channels: form.channels };
  if (Object.keys(form.channelDefaults ?? {}).length > 0) config.channelDefaults = form.channelDefaults;
  for (const [ch, cfg] of Object.entries(form.channelConfigs ?? {})) {
    if (cfg && Object.keys(cfg).length > 0) config[ch] = cfg;
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