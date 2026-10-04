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
 * A non-secret, user-editable config field. `kind` drives how the pane renders
 * the control and how `coerceConfigValue` normalizes the raw input (text →
 * string, number → finite number, boolean → false on empty, select → one of
 * `options`, list → a non-empty `string[]`).
 */
export interface ConfigField {
  key: string;
  kind: 'text' | 'number' | 'boolean' | 'select' | 'list';
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
];

/**
 * The plugin-wide defaults the pane edits outside any channel (通用设置) — the
 * same values the chat commands set. Grouped for rendering; `GENERAL_FIELDS` is
 * the flat view used by the projection and form code, which don't group.
 *
 * Every one of these is resolved once when the plugin starts and copied into
 * each runner as it is created, so a pane edit reaches the profile but is only
 * picked up by a **restart**. The pane says so on every row rather than
 * implying an immediacy it cannot deliver. `workDir`, `language` and
 * `autoMirror` can additionally be overridden by `dsh.shared.config.json`; the
 * pane notes that too, but only where it actually applies.
 */
export const GENERAL_FIELD_GROUPS: readonly { title: string; fields: readonly ConfigField[] }[] = [
  {
    title: 'g.group.locale',
    fields: [
      { key: 'language', kind: 'select', options: ['zh', 'en'], label: 'language' },
      { key: 'notifyLevel', kind: 'select', options: ['full', 'important', 'result'], label: 'notifyLevel' },
      { key: 'progressTimeoutMs', kind: 'number', label: 'progressTimeoutMs' },
    ],
  },
  {
    title: 'g.group.workspace',
    fields: [
      { key: 'workDir', kind: 'text', label: 'workDir' },
      { key: 'workspaces', kind: 'list', label: 'workspaces' },
    ],
  },
  {
    title: 'g.group.access',
    fields: [
      { key: 'allowUsers', kind: 'list', label: 'allowUsers' },
      { key: 'allowChats', kind: 'list', label: 'allowChats' },
    ],
  },
  {
    title: 'g.group.agent',
    fields: [
      { key: 'agentPreset', kind: 'text', label: 'agentPreset' },
      { key: 'autoMirror', kind: 'boolean', label: 'autoMirror' },
      { key: 'streamHeartbeatMs', kind: 'number', label: 'streamHeartbeatMs' },
    ],
  },
];

/** Flat view of the general settings fields, for projection and form code. */
export const GENERAL_FIELDS: readonly ConfigField[] = GENERAL_FIELD_GROUPS.flatMap((g) => g.fields);

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
    case 'list': {
      // A `string[]` field (`workspaces`/`allowUsers`/`allowChats`). The raw
      // input is a textarea, so one entry per line — commas are also accepted
      // so a pasted `a, b, c` does what the user means rather than becoming a
      // single absurd path.
      const items = (Array.isArray(raw) ? raw : String(raw).split(/[\n,]/))
        .map((s) => String(s).trim())
        .filter((s) => s.length > 0);
      // Empty means "unset", i.e. drop the key — deliberately not `[]`. These
      // are `z.array` keys, and an absent volatile array already resolves to
      // `[]` on the way in (`namespace.ts`), so projecting one back out would
      // only stamp `workspaces: []` / `allowUsers: []` noise into every profile
      // that ever saved while leaving them blank. Clearing to inherited is also
      // exactly what the user means by emptying the box.
      return items.length > 0 ? items : undefined;
    }
    default:
      return String(raw);
  }
}

/** The edit form the pane works on. */
export interface SettingsForm {
  channels: ChannelName[];
  channelDefaults: Record<string, unknown>;
  channelConfigs: Record<string, Record<string, unknown>>;
  /** Secret inputs the user is *typing*: written on save, never seeded by a read. */
  secrets: Record<string, Record<string, string>>;
  /**
   * Whether a value is already stored for a secret key, for the placeholder.
   * Separate from `secrets` because the two have opposite lifetimes: presence
   * comes from the snapshot and the typed values start empty and are cleared
   * after a save — a read must never be able to populate an input.
   */
  secretPresence: Record<string, Record<string, boolean>>;
  /**
   * Host-masked previews of the stored secrets, so the user can confirm what
   * they configured. Rendered as read-only text and **never** fed into
   * `secrets`: a masked value is not a credential, and treating one as a value
   * to save would overwrite a working secret with its own mask.
   */
  secretPreviews: Record<string, Record<string, string>>;
  /**
   * Values for the general (plugin-wide) keys, keyed per `GENERAL_FIELDS`.
   * Flat rather than grouped — the grouping is a rendering concern. These are
   * written to the *top level* of the section, beside `channels`, because they
   * are the same keys the chat commands set (`/notice`, `/model`, …), not
   * per-channel options.
   */
  general: Record<string, unknown>;
  /**
   * General keys whose current value actually comes from `dsh.shared.config.json`
   * and therefore shadows whatever the profile holds. The pane prints a
   * provenance note on those rows and only those.
   *
   * A list rather than a boolean, and carried on the form rather than read at
   * render time: the pane already holds exactly one snapshot-derived object, and
   * a separate "just the snapshot, for this one flag" slot would be the ninth
   * hook — one more than the client bundle's stub is set up to feed. Empty on a
   * clean install, where there is no shared config, so the note simply never
   * appears.
   */
  sharedOverrideKeys: string[];
  /**
   * The DSH-owned default model, carried for a read-only display row. It is
   * *not* part of this form's config and must never reach a save payload: it
   * belongs to DSH, and the pane deliberately has no write path for it (see
   * the note on `renderModelRow` in the client). Absent when the host could
   * not read a selection, in which case the pane omits the row rather than
   * rendering an empty control.
   */
  agentModel?: { provider: string; model: string };
  settingsStatePath?: string;
  /** True when the section lives in the settings namespace: a save is immediate and durable. */
  live: boolean;
}

/** Build the initial form from a snapshot. */
export function snapshotToForm(snapshot: SettingsSnapshot): SettingsForm {
  const config = snapshot.config ?? {};
  const channels = (snapshot.enabled ?? []) as ChannelName[];
  // Seeded for *every* channel the pane knows, not only the enabled ones. A
  // save is a whole-section replace: a declared channel block the payload omits
  // is reset to its inherited value (see `namespace.ts`). Seeding from
  // `enabled` alone therefore meant that switching a channel off and saving —
  // for any reason, even one unrelated to that channel — silently reset every
  // declared field of it (`transport`, `dmMode`, `webhookPort`, …), with
  // nothing in the UI to suggest it. Rendering a switched-off channel's stored
  // values is also simply more honest than showing it blank.
  const channelConfigs: Record<string, Record<string, unknown>> = {};
  for (const ch of Object.keys(CHANNEL_CONFIG_FIELDS) as ChannelName[]) {
    channelConfigs[ch] = (config[ch] ?? {}) as Record<string, unknown>;
  }
  // Seeded by field table rather than by copying the whole top-level config:
  // `config` also holds keys this pane does not edit (`stateDir`, `visionModel`,
  // …), and the form is what a save sends back — anything seeded here is
  // something the pane would then be responsible for preserving.
  const general: Record<string, unknown> = {};
  for (const field of GENERAL_FIELDS) {
    const value = config[field.key];
    if (value === undefined) continue;
    // Arrays are copied so the form never aliases the snapshot it was built
    // from: `setGeneral` mutates the form in place, which would otherwise edit
    // the snapshot the host handed us.
    general[field.key] = Array.isArray(value) ? [...value] : value;
  }
  return {
    channels,
    channelDefaults: (config.channelDefaults ?? {}) as Record<string, unknown>,
    channelConfigs,
    general,
    // Copied, like `general`'s arrays: the form is mutated in place by the
    // setters, and aliasing the snapshot here would edit the host's own object.
    sharedOverrideKeys: [...(snapshot.sharedOverrideKeys ?? [])],
    ...(snapshot.agentModel ? { agentModel: snapshot.agentModel } : {}),
    // Deliberately empty even though `secretPreviews` carries something: an
    // input is a place to *type a new* secret, and prefilling it with the mask
    // would either overwrite the stored secret with its own preview on save, or
    // train the user to think a masked value is the real one. The preview is
    // rendered beside the input instead.
    secrets: {},
    secretPresence: (snapshot.secrets ?? {}) as Record<string, Record<string, boolean>>,
    secretPreviews: (snapshot.secretPreviews ?? {}) as Record<string, Record<string, string>>,
    settingsStatePath: config.settingsStatePath as string | undefined,
    live: snapshot.live === true,
  };
}

/** Drop keys whose value is `undefined`/`null` so cleared inputs aren't persisted. */
function stripEmpty(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined && v !== null) out[k] = v;
  return out;
}

/**
 * Build the non-secret config to persist via `settings.save`.
 *
 * Sent as the *whole* visible config, and that is deliberate — see the note on
 * `SettingsForms.replace` in `settings/namespace.ts`. A payload that tried to
 * send only what changed would not shrink the profile entry by a single key
 * (`replace` merges the caller's section over the *inherited* one, so every
 * volatile field is written to the profile either way) and *would* quietly
 * revert anything the user had saved earlier: a field this save omits resolves
 * to its inherited value, not to its previously saved one.
 */
export function buildConfigSave(form: SettingsForm): Record<string, unknown> {
  const config: Record<string, unknown> = { channels: form.channels };
  const defaults = stripEmpty(form.channelDefaults ?? {});
  if (Object.keys(defaults).length > 0) config.channelDefaults = defaults;
  for (const [ch, cfg] of Object.entries(form.channelConfigs ?? {})) {
    const clean = stripEmpty(cfg ?? {});
    if (Object.keys(clean).length > 0) config[ch] = clean;
  }
  // General keys sit at the top level beside `channels` — they are plugin-wide
  // defaults, not per-channel options. Emitted only when set: an empty list is
  // skipped, not written as `[]` (see `coerceConfigValue`), which keeps a
  // profile that never configured them free of empty-array noise. `agentModel`
  // is deliberately absent: it belongs to DSH, and this pane does not write it.
  for (const field of GENERAL_FIELDS) {
    const value = form.general?.[field.key];
    if (value === undefined || value === null) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    config[field.key] = value;
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