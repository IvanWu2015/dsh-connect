/**
 * The `dsh-connect` user-settings namespace.
 *
 * DSH ships a first-party user-settings seam (`ctx.settings`, backed by
 * `$DSH_HOME/settings.yaml` via `@deepseek-ai/dsh-settings-file`, hot-reloaded,
 * atomic, file-locked, comment-preserving). Registering a namespace is how a
 * plugin makes its configuration user-editable *and effective*: the official
 * Plugins page renders the fields from the schema, writes go through the
 * provider, and `scope.watch()` tells the plugin to re-read.
 *
 * Two properties of that seam shape this module:
 *
 * - **`installSection` is the consumer entry point.** It registers the plugin's
 *   own composition entry as the schema's *base* layer while the settings
 *   service is present, and falls back to that entry if the service detaches.
 *   Bare `register` would make `$DSH_HOME/settings.yaml` the only source and
 *   silently drop a YAML-configured profile.
 * - **The schema is applied to `mergeLayers(base, userSection)` at registration
 *   time**, so a stored section that fails validation throws out of
 *   `installSection`. Every install here is therefore guarded: a hand-edited
 *   `settings.yaml` with a typo must degrade to the plugin config, not abort
 *   the plugin's `apply`.
 *
 * **Secrets are deliberately not part of this schema.** They live in the DSH
 * credential store (`ctx.credentials`), which is where the onboarding flow and
 * the `FEISHU_*`-style env layering already put them; `settings.yaml` is a
 * plain document users are invited to paste into bug reports. `sectionOf()`
 * projects secret keys *out* of the base for the same reason — schemastery
 * preserves undeclared keys verbatim, so anything left in the base rides out
 * through `describe()` and the settings RPC. The same projection guards the
 * write path (`LiveConnectSection.write`), which is the mirror hazard: an
 * undeclared key in a *submitted* section would be preserved into the document.
 *
 * `installSection` returns nothing, so the write handle it hands back is built
 * here: `setSource` already wires a thunk onto `scope.get()`, which reads the
 * registration's resolved value at call time — live in both directions.
 *
 * @module dsh-connect/settings/namespace
 */

import z from "@deepseek-ai/schemastery";
import { CHANNELS, type ChannelName, type ChannelsConfig, type LoggerLike } from "./channels.js";
import {
  CHANNEL_CONFIG_FIELDS,
  CHANNEL_DEFAULT_FIELDS,
  type ConfigField,
} from "./settings-model.js";

/** The settings namespace this plugin owns. */
export const CONNECT_SETTINGS_NS = "dsh-connect";

/** Channel-agnostic defaults section of the namespace. */
export type ConnectSectionDefaults = Record<string, unknown> & { language?: string; notifyLevel?: string };

/**
 * The resolved namespace value. Every field is optional: a user who only ever
 * edits `channels` leaves the rest absent, and each adapter applies its own
 * default for anything missing.
 */
export interface ConnectSection {
  channels?: ChannelName[];
  channelDefaults?: ConnectSectionDefaults;
  feishu?: Record<string, unknown>;
  telegram?: Record<string, unknown>;
  dingtalk?: Record<string, unknown>;
  web?: Record<string, unknown>;
}

/** schemastery schema for one non-secret config field. */
function fieldSchema(field: ConfigField): z<any> {
  switch (field.kind) {
    case "number":
      return z.number().required(false);
    case "boolean":
      return z.boolean().required(false);
    case "select":
      return field.options !== undefined && field.options.length > 0
        ? z.union(field.options.map((option) => z.const(option))).required(false)
        : z.string().required(false);
    default:
      return z.string().required(false);
  }
}

/** Build an object schema from a field table (unknown keys pass through). */
function objectSchema(fields: readonly ConfigField[]): z<any> {
  return z.object(
    Object.fromEntries(fields.map((field) => [field.key, fieldSchema(field)])),
  );
}

/**
 * The namespace schema, derived from the same field tables the settings pane
 * renders. Deriving rather than restating them is the point: a field added to
 * `CHANNEL_CONFIG_FIELDS` becomes user-editable and hot-appliable in one edit,
 * and a field that the pane exposes can never be silently unrepresentable in
 * `settings.yaml`.
 *
 * `required(false)` on every field means an absent key stays absent — it does
 * *not* materialize a default. That matters for `dmMode`, whose first option is
 * the permissive one: a schema-provided default would silently open DMs for
 * every user who never touched the field.
 */
export const ConnectSectionSchema = z.object({
  channels: z.array(z.union(CHANNELS.map((name) => z.const(name)))).required(false),
  channelDefaults: objectSchema(CHANNEL_DEFAULT_FIELDS).required(false),
  feishu: objectSchema(CHANNEL_CONFIG_FIELDS.feishu).required(false),
  telegram: objectSchema(CHANNEL_CONFIG_FIELDS.telegram).required(false),
  dingtalk: objectSchema(CHANNEL_CONFIG_FIELDS.dingtalk).required(false),
  web: objectSchema(CHANNEL_CONFIG_FIELDS.web).required(false),
});

/**
 * Project a channel config onto the namespace's schema: only declared,
 * non-secret keys, with `channels` always present.
 *
 * `channels` is emitted unconditionally because an absent array resolves to
 * `[]` (schemastery's array default), which would read as "activate nothing".
 *
 * Secret keys are dropped here, not by the schema: `redactSecrets` only strips
 * nodes declared with `role("secret")`, and we declare none — so the projection
 * is what keeps an `appSecret` from a legacy profile out of the settings
 * document and off the RPC.
 *
 * The argument is typed `unknown` because this doubles as the *write* guard:
 * a section submitted through the settings RPC is untrusted JSON, and it must
 * go through the same projection before it can reach the document.
 */
export function sectionOf(config: unknown): ConnectSection {
  const source = (config !== null && typeof config === "object" ? config : {}) as Record<string, unknown>;
  const section: ConnectSection = { channels: (source.channels ?? CHANNELS) as ChannelName[] };

  const defaults: Record<string, unknown> = {};
  const rawDefaults = (source.channelDefaults ?? {}) as Record<string, unknown>;
  for (const field of CHANNEL_DEFAULT_FIELDS) {
    if (rawDefaults[field.key] !== undefined) defaults[field.key] = rawDefaults[field.key];
  }
  if (Object.keys(defaults).length > 0) section.channelDefaults = defaults as ConnectSectionDefaults;

  for (const name of CHANNELS) {
    const raw = (source[name] ?? {}) as Record<string, unknown>;
    const projected: Record<string, unknown> = {};
    for (const field of CHANNEL_CONFIG_FIELDS[name]) {
      if (raw[field.key] !== undefined) projected[field.key] = raw[field.key];
    }
    if (Object.keys(projected).length > 0) section[name] = projected;
  }
  return section;
}

/**
 * The slice of the settings service this module calls. Declared structurally so
 * the plugin keeps no dependency on `@deepseek-ai/dsh-settings` — the service is
 * a `dsh-base` row, present whenever dsh-connect loads, and a missing method
 * degrades to "no settings support" rather than a crash.
 */
export interface SettingsProviderLike {
  installSection?(
    owner: unknown,
    ns: string,
    schema: unknown,
    entry: unknown,
    hooks: { setSource: (source: () => unknown) => void; onChange: () => void },
  ): void;
  /** Resolved value of a registered namespace, `undefined` while unregistered. */
  get?(ns: string): unknown;
  /**
   * Replace a registered namespace's *user* section wholesale (validated by the
   * provider, persisted by whichever file provider is wired up). Resolves after
   * the new value is committed, so a read straight after it is fresh.
   *
   * Replace rather than merge, because the settings pane always submits its
   * complete visible config: a merge would make a cleared field un-clearable
   * (the stale value stays in the user layer and reappears on the next read).
   * The declared-key set is identical for both writers of this namespace (this
   * plugin's pane and the host's own Plugins page, which renders the same
   * schema), so a replace cannot drop anything either surface can produce.
   */
  replace?(ns: string, section: unknown, expectedRevision?: number): Promise<unknown>;
}

/** A live handle onto the installed namespace: read the effective section, write a new one. */
export interface LiveConnectSection {
  /** The section in force right now (base layered under the user's section). */
  read(): ConnectSection;
  /**
   * Replace the user's section with the declared-key projection of `config`.
   * Rejects if the provider's schema refuses the result — the caller is
   * expected to surface that rather than swallow it.
   */
  write(config: unknown): Promise<void>;
}

/** Outcome of wiring the namespace. */
export interface InstallConnectSectionResult {
  /** True when this fiber owns the namespace and receives live updates. */
  live: boolean;
  /** The section in force at install time (resolved, or the entry fallback). */
  section: ConnectSection;
  /**
   * Read/write onto the registration. Present only when this fiber owns a live
   * namespace *and* the provider exposes a write method; otherwise the caller
   * keeps its own fallback (the plugin config, or the legacy state file).
   */
  handle?: LiveConnectSection;
}

export interface InstallConnectSectionOptions<Ctx extends LoggerLike> {
  /** Context whose unload releases the registration. */
  owner: Ctx;
  settings: SettingsProviderLike | undefined;
  /** The plugin's own config: the schema's `base` layer and the fallback. */
  entry: ChannelsConfig | null | undefined;
  /** Called with the in-force section now and on every change. */
  onChange: (section: ConnectSection) => void;
}

/**
 * Register `dsh-connect` and report the section in force.
 *
 * Never throws: a missing settings service, an already-claimed namespace, or a
 * `settings.yaml` section that fails validation all fall back to the plugin's
 * own config with a warning. A user's typo in a settings document must not be
 * able to stop the bridge from starting.
 */
export function installConnectSection<Ctx extends LoggerLike>(
  options: InstallConnectSectionOptions<Ctx>,
): InstallConnectSectionResult {
  const { settings, entry, onChange } = options;
  const entrySection = sectionOf(entry);
  const warn = (message: string): void => {
    options.owner.logger?.warn?.(`connect: ${message}`);
  };

  if (settings?.installSection === undefined) {
    // No settings service: the plugin config is the only source, as it was
    // before this namespace existed.
    onChange(entrySection);
    return { live: false, section: entrySection };
  }

  let source: () => ConnectSection = () => entrySection;
  try {
    settings.installSection(options.owner, CONNECT_SETTINGS_NS, ConnectSectionSchema, entrySection, {
      setSource: (fn) => {
        source = () => fn() as ConnectSection;
      },
      onChange: () => onChange(source()),
    });
  } catch (error) {
    // Two reachable causes, both handled the same way:
    //   - a stored section that fails the schema (a hand-edited settings.yaml);
    //   - the namespace is already registered by an earlier fiber. `register`
    //     is an effect on the *settings service*, which outlives a plugin
    //     reload, so a live config reload lands here.
    // `get()` returns the previously resolved value in the second case, which
    // keeps the user's saved settings effective — only the live watch is gone
    // until the process restarts.
    const resolved = readRegistered(settings);
    if (resolved !== undefined) {
      warn(
        `settings namespace "${CONNECT_SETTINGS_NS}" is already registered ` +
          `(the plugin reloaded without a host restart); using the saved section — ` +
          `restart dsh to re-enable live settings updates`,
      );
      onChange(resolved);
      return { live: false, section: resolved };
    }
    warn(
      `settings namespace "${CONNECT_SETTINGS_NS}" unavailable (${String(error)}); ` +
        `falling back to the plugin config`,
    );
    onChange(entrySection);
    return { live: false, section: entrySection };
  }

  // `source` is reassigned (not rebound) by `setSource`, so a thunk closing
  // over the variable reads whatever the provider's `scope.get()` returns now.
  const read = (): ConnectSection => source();
  const replace = settings.replace?.bind(settings);
  return {
    live: true,
    section: source(),
    ...(replace === undefined
      ? {}
      : {
          handle: {
            read,
            write: async (config: unknown): Promise<void> => {
              await replace(CONNECT_SETTINGS_NS, sectionOf(config));
            },
          },
        }),
  };
}

/** Read a namespace an earlier fiber registered, if any. */
function readRegistered(settings: SettingsProviderLike): ConnectSection | undefined {
  const value = settings.get?.(CONNECT_SETTINGS_NS);
  if (value === null || typeof value !== "object") return undefined;
  return value as ConnectSection;
}
