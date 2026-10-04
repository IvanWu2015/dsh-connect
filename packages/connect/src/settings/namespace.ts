/**
 * The `dsh-connect` user-settings seam.
 *
 * DSH 0.2 replaced the plugin-facing settings API. The old `ctx.settings`
 * namespace contract (`installSection(owner, ns, schema, entry, hooks)` backed by
 * a `$DSH_HOME/settings.yaml` section keyed by the plugin *name*) is gone; what
 * is left is `SettingsForms`, which edits a plugin's **profile entry** and
 * hot-commits the fields that plugin declared `volatile`:
 *
 * - **Reads come from our own config.** A field declared with
 *   `z.…volatile()` arrives in `apply()` as a *reference* (`{ get() }`) rather
 *   than a value, and the loader updates that reference in place when the
 *   profile entry changes — no remount, no `apply()` re-entry. So there is no
 *   read API to call: the live state is `refs.get()`, and this module's
 *   `materializeConfig()` turns the ref-carrying config into a plain snapshot.
 * - **Writes go through `SettingsForms.replace(ns, section)`**, where `ns` is
 *   the profile entry id (`connect`) — *not* the package name. `replace` resets
 *   every live field to its inherited value and then applies the supplied ones,
 *   which is exactly "this is the user's complete visible config" — and why a
 *   *partial* section is a destructive write: a field the caller omits is
 *   reset, not preserved. Callers that mean to preserve something must merge
 *   it in first ({@link mergeSections}).
 * - **`volatileForm(schema)` must not be empty**, or `replace` refuses the
 *   write with `Plugin entry "connect" has no volatile fields`. That is why
 *   `paneConfigFields()` exists and must keep declaring the pane's field set.
 *
 * **Only volatile *leaves* may be declared — never a volatile container.**
 * `projectForm(form, base)` projects the *base* layer down to volatile fields
 * before the write is merged: if `feishu` itself were volatile it would be
 * copied whole into the settings document, `appSecret` and all. Declaring the
 * leaves keeps every non-pane key (`appSecret`, `appId`, …) in the raw
 * remainder, where `strip()` leaves ordinary config untouched. This is the same
 * hazard `sectionOf()` guards on the write path, from the other side: an
 * undeclared key in a *submitted* section must not reach the document either.
 *
 * Secrets therefore never appear in either declared surface: they live in the
 * DSH credential store (`ctx.credentials`), which is where onboarding and the
 * `FEISHU_*`-style env layering already put them, and `settings`-side documents
 * are plain files users are invited to paste into bug reports.
 *
 * @module dsh-connect/settings/namespace
 */

import z from "@deepseek-ai/schemastery";
import { CHANNELS, type ChannelName, type LoggerLike } from "./channels.js";
import { CHANNEL_CONFIG_FIELDS, CHANNEL_DEFAULT_FIELDS, GENERAL_FIELDS } from "./settings-model.js";

/**
 * The section key the pre-0.2 harness read from `$DSH_HOME/settings.yaml`, keyed
 * by plugin *name*. Nothing writes it any more; `legacy-import.ts` reads it once
 * so an upgrading user's pane settings survive the switch to the new store.
 */
export const LEGACY_CONNECT_SECTION = "dsh-connect";

/**
 * The automatic-page policy for our entry. `auto: false` stops the host's
 * Plugins page from generating a second, generic form for `connect`: this
 * plugin ships its own client pane (`client/settings-client.mjs`), and two
 * editors writing the same fields through different UIs is how a save silently
 * reverts. Register it with `settings.configure(policy, ctx.fiber)` — the
 * `owner` argument matters, see `index.ts`.
 */
export const CONNECT_PRESENTATION: Record<string, unknown> = { auto: false };

/**
 * The shared cross-ESM volatile protocol (`cosmokit`'s `Symbol.for` key).
 *
 * Looked up by symbol rather than by importing `@deepseek-ai/cosmokit`: the
 * host may hand us refs created by *its* copy of the library, and `Symbol.for`
 * is the one identifier that is identical across copies. Sniffing the key (as
 * cosmokit's own `isVolatile` does) is more forgiving than `instanceof`, which
 * would fail across an ESM/CJS duplicate.
 */
const VOLATILE_WRITE = Symbol.for("cosmokit.volatile.write");

/** A config reference: a stable handle whose value the loader replaces in place. */
export interface ConfigRef<T = unknown> {
  /** The current immutable snapshot; `undefined` for a field absent from the config. */
  get(): T;
}

/** Whether a parsed config value is a volatile reference rather than plain data. */
export function isConfigRef(value: unknown): value is ConfigRef {
  return typeof value === "object" && value !== null && VOLATILE_WRITE in value;
}

/**
 * Copy a ref-carrying config into plain data: every reference replaced by its
 * current snapshot, recursively, so callers can hand the result to code that
 * only understands plain objects (the adapters, the settings pane, tests).
 *
 * The copy is *fresh* rather than the snapshot itself, deliberately: snapshots
 * are deeply frozen, and both `ChannelRuntime` (which spreads a channel's
 * config into a new object) and the pane (which holds a form to edit) want
 * mutable data. Cycles in ordinary config are tolerated via `seen`; a snapshot
 * cannot contain references (the loader commits plain data), but the walk
 * treats them uniformly so it does not matter.
 *
 * **A key that materializes to `undefined` is dropped, not copied.** Every
 * declared volatile leaf is present in the parsed config even when the profile
 * never set it — `z.object({transport: z.any().volatile()})` resolves an absent
 * `transport` to a reference to `undefined` — so a faithful copy would hand the
 * adapters `{transport: undefined, language: undefined, …}`. That is not the
 * same as absent: `ChannelRuntime` resolves a channel as
 * `{...channelDefaults, ...overrides}`, and since `language` is a key of *both*
 * tables, a channel's own `language: undefined` would mask the shared
 * `channelDefaults.language` every other channel still gets. Config here is
 * JSON-shaped (a profile entry, a YAML document, the settings RPC), where
 * `undefined` can only ever mean "this key was not set", so dropping it restores
 * exactly the shape a plain `z.any()` field used to produce.
 */
export function materializeConfig<T>(value: T): T {
  return walk(value, new WeakMap()) as T;
}

function walk<T>(value: T, seen: WeakMap<object, unknown>): unknown {
  if (value === null || typeof value !== "object") return value;
  if (isConfigRef(value)) return walk(value.get(), seen);
  const known = seen.get(value as object);
  if (known !== undefined) return known;
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    seen.set(value, out);
    for (const item of value) out.push(walk(item, seen));
    return out;
  }
  const out: Record<string, unknown> = {};
  seen.set(value, out);
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const materialized = walk(child, seen);
    if (materialized !== undefined) out[key] = materialized;
  }
  return out;
}

/**
 * The volatile half of the plugin `Config`, derived from the same field tables
 * the settings pane renders. Deriving rather than restating them is the point:
 * a field added to `CHANNEL_CONFIG_FIELDS` becomes user-editable *and*
 * hot-appliable in one edit, and a field the pane offers can never be missing
 * from the schema (a write of an undeclared path is refused by the host).
 *
 * Every leaf is `z.any()` on purpose. A stricter node would let a stale value
 * in a profile — a `webhookPort` written as a string, a `dmMode` from a version
 * that spelled it differently — abort config validation and keep the bridge
 * from loading at all. The pane's own `coerceConfigValue` is what keeps types
 * honest; the schema's job here is only to say "these paths are live-editable".
 *
 * `channels` is a loose `z.array(z.string())` for the same reason, and it is
 * safe because `ChannelRuntime` skips a name it has no adapter for (with a log
 * line) instead of throwing. Its explicit `.default([...CHANNELS])` is load
 * bearing, not cosmetic: a volatile *array* resolves an absent key to `[]`
 * rather than `undefined`, so a profile that never set `channels` would
 * otherwise materialize an empty list and start no adapter at all, where the
 * documented default — and the pre-volatile behaviour — is every channel. A
 * default also keeps `replace()`'s reset target honest: an omitted `channels`
 * in a section resets to all channels, not to none. `[...CHANNELS]` rather than
 * `CHANNELS` so the schema cannot hand out the module's own array.
 */
export function paneConfigFields(): Record<string, z<any>> {
  const fields: Record<string, z<any>> = {
    channels: z.array(z.string()).default([...CHANNELS]).volatile(),
  };
  const defaults: Record<string, z<any>> = {};
  for (const field of CHANNEL_DEFAULT_FIELDS) defaults[field.key] = z.any().volatile();
  fields.channelDefaults = z.object(defaults);
  for (const name of CHANNELS) {
    const channel: Record<string, z<any>> = {};
    for (const field of CHANNEL_CONFIG_FIELDS[name]) channel[field.key] = z.any().volatile();
    if (Object.keys(channel).length > 0) fields[name] = z.object(channel);
  }
  return fields;
}

/**
 * Channel-agnostic defaults section of the namespace.
 *
 * `notifyLevel` used to be declared here and was dead: no adapter ever read it
 * (they read `language`; the notification level a runner uses comes from the
 * top-level key). It is gone from both the field table and this type, so a
 * legacy `channelDefaults.notifyLevel` in an old profile is projected away on
 * the next save rather than being preserved forever in honour of a key that
 * never did anything. The real, working `notifyLevel` is a top-level key — see
 * `ConnectSection` below.
 */
export type ConnectSectionDefaults = Record<string, unknown> & { language?: string };

/**
 * The pane-editable slice of the config: the whole of what this plugin stores
 * on the user's behalf. Every field is optional — a user who only ever edits
 * `channels` leaves the rest absent, and each adapter applies its own default
 * for anything missing.
 *
 * The top-level keys below `channelDefaults` are the **general settings** the
 * pane edits on its 通用设置 view — the same values the chat commands set. They
 * are declared here because `sectionOf` is the only thing standing between them
 * and a silent reset: `enableFeishuConfig` spreads the whole section it is
 * given, so a general key this type (and that function's loop) forgets is
 * dropped by the next save of any kind. Keep this list in step with
 * `GENERAL_FIELDS`.
 */
export interface ConnectSection {
  channels?: ChannelName[];
  channelDefaults?: ConnectSectionDefaults;
  /** Reply language (`zh`/`en`) for a channel that does not set its own. */
  language?: string;
  /** How much of a run gets pushed to chat: `full` / `important` / `result`. */
  notifyLevel?: string;
  /** Silence a quiet run for this long before warning, in ms. */
  progressTimeoutMs?: number;
  /** Default working directory for new sessions. */
  workDir?: string;
  /** Additional workspace roots offered to new sessions. */
  workspaces?: string[];
  /** Open ids allowed to talk to the bot; empty/absent means everyone. */
  allowUsers?: string[];
  /** Chat ids allowed to talk to the bot; empty/absent means every chat. */
  allowChats?: string[];
  /** Agent preset applied to new sessions. */
  agentPreset?: string;
  /** Mirror a session's workspace automatically when it is created. */
  autoMirror?: boolean;
  /** Heartbeat interval for a streaming answer, in ms. */
  streamHeartbeatMs?: number;
  feishu?: Record<string, unknown>;
  telegram?: Record<string, unknown>;
  dingtalk?: Record<string, unknown>;
  web?: Record<string, unknown>;
}

export interface SectionOptions {
  /**
   * Materialize `channels` even when the source omits the key. True (the
   * default) for the *write* path: there an absent key means "the caller did
   * not speak to the channel list", and a section without `channels` handed to
   * `replace()` is a reset — reading it as "activate nothing" would switch
   * every adapter off. False for the legacy import, where an absent key must
   * stay absent so the profile's own `channels` keeps applying.
   *
   * Note this is about the *key being absent*, not about an empty array: a user
   * who unchecks every channel saves `channels: []`, which is an explicit
   * "none" and is left alone.
   */
  defaultChannels?: boolean;
}

/**
 * Project a config onto the pane's field set: declared, non-secret keys only.
 *
 * Two callers, one guard. For a **read** the input is a materialized snapshot
 * of our own config (a profile may legitimately carry `appSecret`, and it must
 * not travel out through the snapshot the pane receives); for a **write** the
 * input is untrusted JSON from the settings RPC, and an undeclared key would
 * otherwise be preserved into the profile by schemastery's passthrough. Both
 * are the same projection, so both get the same answer.
 *
 * `channels` is emitted unconditionally on the write path because an absent
 * array resolves to `[]` (schemastery's array default), which would read as
 * "activate nothing". Unknown channel names are dropped rather than refused:
 * a name this version does not know is not a reason to reject the whole save.
 */
export function sectionOf(config: unknown, options: SectionOptions = {}): ConnectSection {
  const source = (config !== null && typeof config === "object" ? config : {}) as Record<string, unknown>;
  const section: ConnectSection = {};

  const rawChannels = source.channels;
  if (Array.isArray(rawChannels)) {
    section.channels = rawChannels.filter((name): name is ChannelName =>
      (CHANNELS as readonly string[]).includes(name as string),
    );
  } else if (options.defaultChannels !== false) {
    section.channels = [...CHANNELS];
  }

  const defaults: Record<string, unknown> = {};
  const rawDefaults = (source.channelDefaults ?? {}) as Record<string, unknown>;
  for (const field of CHANNEL_DEFAULT_FIELDS) {
    if (rawDefaults[field.key] !== undefined) defaults[field.key] = rawDefaults[field.key];
  }
  if (Object.keys(defaults).length > 0) section.channelDefaults = defaults as ConnectSectionDefaults;

  // The general keys. This loop is load-bearing, not bookkeeping: everything
  // that writes a section goes through this projection, and `enableFeishuConfig`
  // spreads the section it is handed — so a key missing from here is silently
  // reset the next time the user saves *anything*, including a save that had
  // nothing to do with it. Adding a field to `GENERAL_FIELDS` without it
  // appearing here is the one mistake this batch can make.
  for (const field of GENERAL_FIELDS) {
    const value = source[field.key];
    if (value === undefined) continue;
    if (field.kind === 'list') {
      // An empty list is skipped rather than written as `[]`: absent already
      // resolves to `[]` for these keys, so emitting one only stamps noise into
      // a profile, and "cleared" is meant to mean "back to inherited".
      if (!Array.isArray(value)) continue;
      // Trimmed, to match `coerceConfigValue`'s list branch. The pane never
      // produces a padded entry, but this is also the guard on *untrusted*
      // JSON from the settings RPC, and a whitespace-only path saved from a
      // hand-edited document is an entry that means nothing.
      const items = value
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
      if (items.length > 0) (section as Record<string, unknown>)[field.key] = items;
      continue;
    }
    (section as Record<string, unknown>)[field.key] = value;
  }

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
 * Layer one section over another: for each channel and for the shared defaults,
 * the override's own keys win and the base's surviving keys are kept.
 *
 * This exists because of how `replace()` treats an omission — see the module
 * doc. A caller that has a section in force and only wants to change part of it
 * must merge, never pass the part alone: `feishu: { transport }` resets every
 * other declared `feishu` field, and a section without `channels` resets the
 * channel list itself, which switches every adapter off.
 */
export function mergeSections(base: ConnectSection, override: ConnectSection): ConnectSection {
  // Start from a plain spread so the flat general keys carry over without this
  // function having to list them. Rebuilding the object key by key — the shape
  // this had before the general settings existed — silently *drops* any key the
  // merge does not explicitly mention, and the only caller here
  // (`legacy-import.ts`) writes `mergeSections(current, legacy)`: a dropped key
  // there is a user's setting erased by an import that was supposed to preserve
  // it. `channels`/`channelDefaults`/per-channel blocks are copied explicitly
  // below because each has merge semantics of its own.
  const merged: ConnectSection = { ...base, ...override };
  const channels = override.channels ?? base.channels;
  if (channels !== undefined) merged.channels = [...channels];
  else delete merged.channels;

  const defaults = { ...base.channelDefaults, ...override.channelDefaults };
  if (Object.keys(defaults).length > 0) merged.channelDefaults = defaults as ConnectSectionDefaults;

  for (const name of CHANNELS) {
    const fields = { ...base[name], ...override[name] };
    if (Object.keys(fields).length > 0) merged[name] = fields;
  }
  return merged;
}

/**
 * The slice of `SettingsForms` this module calls. Declared structurally so the
 * plugin keeps no dependency on `@deepseek-ai/dsh-settings` (a `dsh-base` row we
 * cannot import at build time): a missing method degrades to "no live store"
 * rather than a crash, and the settings service falls back to its JSON file.
 */
export interface SettingsProviderLike {
  /**
   * Register this plugin instance's page policy. `owner` must be the plugin's
   * own fiber — the default is the *service's* fiber, which would make the
   * policy invisible to this instance's page and leak on every reload.
   * @returns Disposer; register it with the plugin's effects.
   */
  configure?(presentation: Record<string, unknown>, owner?: unknown): () => void;
  /**
   * Reset every live field to its inherited value, then apply `section`;
   * ordinary (non-live) config is preserved.
   *
   * `expectedRevision` is deliberately omitted by every caller here: `write`
   * only enforces the revision check when it is defined, and we read our state
   * from config references rather than from `describe()`, so there is no
   * revision to round-trip. Two concurrent editors of the pane would still both
   * land, last write winning — the same behaviour the JSON store had.
   */
  replace?(ns: string, section: unknown, expectedRevision?: number): Promise<unknown>;
}

/** A live handle onto the profile entry: read the effective section, write a new one. */
export interface LiveConnectSection {
  /** The section in force right now, read from the config references. */
  read(): ConnectSection;
  /**
   * Replace the user's section with the declared-key projection of `config`,
   * then hand the new section to `onChange`. Rejects if the host refuses the
   * write (a non-volatile path, a missing entry) — the caller is expected to
   * surface that rather than swallow it.
   */
  write(config: unknown): Promise<void>;
}

/** Outcome of wiring the seam. */
export interface InstallConnectSectionResult {
  /** True when a write handle exists, i.e. a save can land and take effect. */
  live: boolean;
  /** The section in force at install time. */
  section: ConnectSection;
  /** Read/write onto the profile entry; absent when the seam is unavailable. */
  handle?: LiveConnectSection;
}

export interface InstallConnectSectionOptions<Ctx extends LoggerLike> {
  /** The plugin's own context: `logger` for diagnostics, and the fallback owner. */
  owner: Ctx;
  settings: SettingsProviderLike | undefined;
  /** The ref-carrying config this plugin was applied with (see `materializeConfig`). */
  config: unknown;
  /** The profile entry id (`connect`), from the loader entry. */
  ns: string | undefined;
  /**
   * Called with the in-force section at install and after every successful
   * write. A returned promise is **awaited by `write`** before it resolves, so
   * the caller that is answering the user sees the re-apply's own outcome
   * rather than a snapshot taken before it ran. The install-time call does not
   * await — there is no caller waiting on it, and the plugin is mid-`apply`.
   */
  onChange: (section: ConnectSection) => void | Promise<void>;
}

/**
 * Wire the plugin's config references to the host's settings service.
 *
 * Never throws. A host without `SettingsForms`, a context where the entry id
 * cannot be resolved (a bare unit-test context, or a plugin mounted outside the
 * loader) and a refused `replace` all degrade to `live: false` with one warning
 * line — a settings integration that cannot work must never be the reason a
 * bridge fails to start.
 */
export function installConnectSection<Ctx extends LoggerLike>(
  options: InstallConnectSectionOptions<Ctx>,
): InstallConnectSectionResult {
  const { settings, config, ns, onChange } = options;
  const warn = (message: string): void => {
    options.owner.logger?.warn?.(`connect: ${message}`);
  };
  const read = (): ConnectSection => sectionOf(materializeConfig(config));
  const section = read();

  const replace = settings?.replace?.bind(settings);
  if (replace === undefined || ns === undefined) {
    // Two different situations, one outcome. No settings service at all is the
    // normal bare-context case and needs no line. A *present* service with no
    // resolvable entry id is a real misconfiguration: the pane would silently
    // stop persisting, so say so once.
    if (settings !== undefined && ns === undefined) {
      warn(
        "settings service is present but this plugin's profile entry id could not be resolved; " +
          "the settings pane will fall back to its state file",
      );
    }
    onChange(section);
    return { live: false, section };
  }

  const handle: LiveConnectSection = {
    read,
    write: async (value: unknown): Promise<void> => {
      // Materialize first so the write path is shape-agnostic: handed this
      // plugin's own ref-carrying `config` (a plausible caller mistake), a raw
      // `sectionOf` would see `channels` as a reference rather than an array,
      // read it as absent and project *every* channel — turning an unrelated
      // save into "enable all adapters". Cheap, and it is a save, not a hot path.
      await replace(ns, sectionOf(materializeConfig(value)));
      // The loader commits the volatile paths into these references and emits
      // `loader/volatile-update`; reconciling here as well makes a write take
      // effect even on a host that does not dispatch it. A repeat apply of the
      // same values is a no-op (`ChannelRuntime` diffs before it restarts
      // anything), so the belt is free.
      //
      // Awaited, not dropped: the reconcile is what decides whether the newly
      // saved config actually *started* the channels it names, and the caller
      // reads that back to answer the pane. `reconcile` never rejects, so this
      // cannot turn a committed write into a reported failure.
      await onChange(read());
    },
  };
  onChange(section);
  return { live: true, section, handle };
}

declare module "@deepseek-ai/cordis" {
  interface Events {
    /**
     * Dispatched to the owning fiber when the loader commits changed volatile
     * config paths **in place**, without remounting the plugin — a settings-pane
     * save, or an edit to a running profile's patch. The payload is the changed
     * paths; a consumer re-reads the references it was applied with
     * ({@link materializeConfig}) rather than being told the new values.
     *
     * Declared here because cordis's `on()` typechecks event names against this
     * interface and nothing this plugin depends on names the event — an
     * undeclared name would be a type error at the only call site (`index.ts`).
     */
    "loader/volatile-update"(paths: readonly (readonly string[])[]): void;
  }
}
