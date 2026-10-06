/**
 * Backend for the dsh-connect web settings pane.
 *
 * A host-side service that reads/writes the non-secret plugin settings (the
 * `dsh-connect` config: `channels`, `channelDefaults`, per-channel fields),
 * and reports per-channel credential presence via an optional DSH credential
 * store. Secrets (appSecret/botToken) live in the DSH credentials store, never
 * in the section this service writes.
 *
 * **Two data planes, one interface.** When the `dsh-connect` settings namespace
 * is installed (`namespace.ts`), that *is* the store: reads come from the
 * provider's resolved section and writes go back through it, which is what makes
 * a pane save land in this plugin's entry in the active profile patch
 * (`cordis.patch.yml`), take effect immediately (the namespace's `onChange`
 * reconciles the running adapters) and survive a restart.
 * The JSON state file is the fallback for hosts without a settings service, and
 * is written only when no namespace is live.
 *
 * @module dsh-connect/settings/settings-service
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { CHANNELS, secretConfigPath, withoutDotPath, type ChannelName } from "./channels.js";
import type { SettingsService, SettingsSnapshot, SettingsWarningCode } from "./settings-rpc.js";
import type { FeishuOnboardingRegistry, OnboardingStatus } from "./feishu-onboarding.js";
import { CHANNEL_SECRET_KEYS, type CredentialStore } from "./credential-store.js";
import { maskSecret } from "./secret-disclosure.js";
import type { LiveConnectSection } from "./namespace.js";
import type { ChannelConnectionStatus } from "./channel-status.js";

export interface SettingsServiceOptions {
  /** JSON file to persist non-secret settings when no namespace is live (omit = in-memory only). */
  statePath?: string;
  /** Known channel names (default: built-in channels). */
  channelNames?: readonly ChannelName[];
  /** Report credential presence per channel (optional; default: all false). */
  credentialStore?: CredentialStore;
  /** Error sink (default: console.error). */
  log?: (msg: string) => void;
  /**
   * Seed config used when no state file exists (or `statePath` is unset), so the
   * pane reflects the plugin's live config rather than an empty default. The
   * live config carries only the settings-shape keys (`channels`, `channelDefaults`,
   * per-channel) that the pane edits.
   */
  initialConfig?: Record<string, unknown>;
  /**
   * The live settings namespace, if one is installed. A **getter**, not a value:
   * this service is built during the plugin's `apply`, while the namespace is
   * registered later (the `settings` service is a `dsh-base` row that loads
   * after a user plugin), so the handle does not exist yet at construction time.
   */
  live?: () => LiveConnectSection | undefined;
  /**
   * Called after a credential write lands in the store, so the running adapters
   * pick the new secret up.
   *
   * Writing the store is not enough on its own: an adapter holds the secret it
   * was started with, and the only thing that re-applies one is the plugin's
   * `reconcile` — which the settings namespace fires on a *config* write. The
   * pane saves config and credentials as two separate calls, so without this
   * hook a rotated `appSecret` stayed inert until the next host restart while
   * the pane reported 「已保存」 — the user's fix for a broken bot would appear
   * to have done nothing.
   *
   * A returned promise is **awaited** before the snapshot is built, which is
   * what puts the re-apply's own outcome (a channel that failed to restart, see
   * {@link channelFailures}) into the snapshot the pane receives instead of the
   * next one. The hook was fire-and-forget while `reconcile` was — both are
   * promises that settle quickly (adapters are applied synchronously).
   */
  onCredentialsSaved?: () => void | Promise<void>;
  /**
   * Channels whose adapter failed to start, as `{channel: reason}` — read
   * after a write to report a channel that the save left *not running*.
   *
   * A save can succeed and still not produce a working bot: `ChannelRuntime`
   * logs a throwing `apply` and starts the remaining channels anyway, so the
   * write is committed and the pane would say 「已保存」 over a channel that is
   * silently down. This is the read side of that: the runtime keeps the last
   * failure per channel, and the snapshot reports the ones for channels this
   * write touched.
   *
   * Failures are cleared by a later successful start (see `ChannelRuntime`), so
   * this stays a statement about the *current* state and not a growing history.
   */
  channelFailures?: () => Record<string, string>;
  /**
   * Per-channel **access** state for the pane's second badge — whether the
   * channel is switched on, up, or actually connected — as
   * `{channel: {state, attempts?}}`. See `channel-status.ts` for how a state is
   * composed; this option is only the plumbing.
   *
   * **The parameter is the service's own `enabled` array**, passed straight
   * through to the callback. That is a deliberate one-way dependency and not a
   * redundant argument: the badge's notion of 「未启用」 and the snapshot's own
   * `enabled` field then cannot disagree, because they are the same value.
   *
   * Its absence is meaningful and preserved: when this is not wired, the
   * snapshot carries **no** `channelStatus` key at all and the pane renders no
   * badge — an older host, or a boot where the channel runtime was never
   * created. That is why the snapshot attaches this *unconditionally* when the
   * option exists, breaking the surrounding "spread only when non-empty"
   * convention: elsewhere an empty list is merely an add-nothing, but here
   * 「未启用」 and 「未运行」 are themselves answers, and collapsing them into the
   * absent key would erase the distinction the pane depends on.
   *
   * Like {@link channelFailures} this is a plain getter (the runtime exists by
   * the time this is called), and a throwing probe is logged and dropped rather
   * than failing the snapshot.
   */
  channelStatus?: (enabled: readonly ChannelName[]) => Record<string, ChannelConnectionStatus> | undefined;
  /**
   * The one-click Feishu bot creation registry, if this host has one. Optional,
   * and like {@link live} a **getter, not a value**: the registry needs
   * `save()` — the enable step is a settings write, and it must take the exact
   * same path as a pane save (a partial write here would be a deletion) — while
   * this service is what `save()` belongs to. So the host assigns the registry
   * after building the service, and the getter is read per call.
   *
   * Absent (or resolving to `undefined`) means the three `onboarding.*` RPC
   * endpoints answer `unsupported` rather than pretending.
   */
  onboarding?: () => FeishuOnboardingRegistry | undefined;
  /**
   * The DSH-wide default model, for the pane's read-only row.
   *
   * Read-only **by design**: `agentDefaultModel.saveSelection()` exists and is
   * what the `/model` and `/reasoning` chat commands use, so wiring a write
   * here is technically possible — and deliberately not done. That selection is
   * DSH's, shared with every other session and plugin; a settings pane that
   * silently moved it would change other people's runs as a side effect of
   * editing the Feishu bridge. The pane says where to change it instead.
   *
   * A getter because `agentDefaultModel` arrives through injection and may not
   * be present when this service is built. Returning undefined, throwing, or
   * answering with an empty provider/model all mean the same thing: drop the
   * row rather than render a control the user cannot use.
   */
  agentModel?: () => { provider?: string; model?: string } | undefined;
  /**
   * General-settings keys a shared config on this machine overrides, for the
   * pane's provenance note. Empty (or absent) is the normal case — no shared
   * config, ordinary editable rows.
   */
  sharedOverrideKeys?: () => string[];
}

function logError(msg: string) {
  if (typeof console !== "undefined") console.error?.("[dsh-connect/settings] " + msg);
}

/**
 * Drop per-channel secret keys before a config leaves the host.
 *
 * Removed by their *config path*, not by their config key: a credential table
 * names `clientId`, but the schema puts DingTalk's at `stream.clientId`, and a
 * filter that compared top-level key names would walk straight past the nested
 * one — reading the secret out of the config and, because the pane rebuilds its
 * save payload from this same object, writing it back on the next click.
 * `secretConfigPath` is the only thing that knows the difference.
 *
 * Applied in `snapshot`, which is the one boundary every read crosses, so both
 * data planes are covered and neither has to remember: the live plane's resolved
 * section is *allowed* to carry a secret the user wrote by hand (the documented
 * posture for the plugin entry, and what the deployed profile does), and the
 * fallback file is plaintext besides. It costs the pane nothing to lose them —
 * the config plane is not where a secret is displayed; the pane renders
 * `secrets`/`secretPreviews`, which come from the credential store and are
 * masked there.
 *
 * It also keeps them out of the *write* path: `snapshotToForm` carries the
 * config into the form and `buildConfigSave` re-emits whatever keys it finds
 * there, so an unfiltered read could hand a hand-written secret straight back to
 * the server inside the next save payload.
 *
 * Only these keys go: a plane is a loose store rather than the declared schema,
 * and a save can carry keys the pane does not render (the shared config's
 * `language`, a hand-written key), so everything else has to survive the read.
 * Nothing is removed from the document — this filters on the way out, and the
 * service never writes a read back.
 */
function withoutSecrets(config: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...config };
  for (const [channel, keys] of Object.entries(CHANNEL_SECRET_KEYS)) {
    const block = out[channel];
    if (block === null || typeof block !== "object" || Array.isArray(block)) continue;
    const secretKeys = Object.keys(keys ?? {});
    if (secretKeys.length === 0) continue;
    // `withoutDotPath` copies rather than mutates: `out` is shallow, so a
    // mutating delete would reach into the caller's live config and strip the
    // credential the running adapter is still holding.
    let kept = block as Record<string, unknown>;
    for (const key of secretKeys) kept = withoutDotPath(kept, secretConfigPath(channel as ChannelName, key));
    out[channel] = kept;
  }
  return out;
}

/**
 * Build a settings service backed by a JSON state file. `get`/`status` read the
 * current state; `save` merges and persists. A missing/corrupt state file is
 * treated as an empty config (never throws on read).
 */
export function createSettingsService(options: SettingsServiceOptions = {}): SettingsService {
  const channels = options.channelNames ?? CHANNELS;
  const statePath = options.statePath;
  const log = options.log ?? logError;
  const credentialStore = options.credentialStore;
  const initialConfig = options.initialConfig ?? {};

  /** The live namespace handle, or undefined when the provider isn't there yet. */
  function liveHandle(): LiveConnectSection | undefined {
    try {
      return options.live?.();
    } catch (error) {
      log(`failed to resolve the live settings section: ${String(error)}`);
      return undefined;
    }
  }

  function readConfig(): Record<string, unknown> {
    const live = liveHandle();
    if (live) {
      // The *resolved* section (plugin config layered under the user's), which
      // is what the host's own `describe()` reports: the pane edits the config
      // in force, not a diff against it.
      try {
        return { ...live.read() };
      } catch (error) {
        // Do not fall through to the state file: it is stale by definition once
        // a namespace is live, and resurrecting it would be worse than empty.
        log(`failed to read the live settings section: ${String(error)}`);
        return { ...initialConfig };
      }
    }
    if (!statePath || !existsSync(statePath)) return { ...initialConfig };
    try {
      const value = JSON.parse(readFileSync(statePath, "utf8"));
      return value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
    } catch (error) {
      log(`failed to read settings state: ${String(error)}`);
      return {};
    }
  }

  function persist(config: Record<string, unknown>) {
    // No path is the documented in-memory mode, not a failed write.
    if (!statePath) return;
    try {
      mkdirSync(dirname(statePath), { recursive: true });
      writeFileSync(statePath, JSON.stringify(config, null, 2) + "\n");
    } catch (error) {
      // Swallowing here was a lie with a delay on it: `save()` goes on to
      // return a snapshot of the value it just failed to store, the pane reads
      // that as 「已保存」, and the setting is gone at the next restart. The
      // code is forwarded verbatim to the browser (`PUBLIC_ERRORS`), so the
      // pane's own failure path can report it instead.
      log(`failed to write settings state: ${String(error)}`);
      const err = new Error("save-failed") as Error & { code?: string };
      err.code = "save-failed";
      throw err;
    }
  }

  /**
   * Read the channel runtime's failures, or `{}` when there is no runtime to
   * ask (no live namespace) or the probe itself throws — a failure to *describe*
   * a failure must not turn a successful save into a rejected one.
   */
  function channelErrors(): Record<string, string> {
    if (!options.channelFailures) return {};
    try {
      return { ...options.channelFailures() };
    } catch (error) {
      log(`failed to read the channel runtime failures: ${String(error)}`);
      return {};
    }
  }

  /**
   * Read the channel access states for `enabled`, or `undefined` when there is
   * no probe wired.
   *
   * `undefined` is the whole point of the return type: the caller attaches the
   * key only when this is not undefined, so "this host cannot report access
   * state" stays distinguishable from "every channel is disabled". A probe that
   * *throws* resolves to `undefined` for the same reason — failing to describe
   * the state is not the same claim as the state being empty, and a save must
   * not be rejected over it.
   */
  function channelStates(enabled: readonly ChannelName[]): Record<string, ChannelConnectionStatus> | undefined {
    if (!options.channelStatus) return undefined;
    try {
      const statuses = options.channelStatus(enabled);
      return statuses === undefined ? undefined : { ...statuses };
    } catch (error) {
      log(`failed to read the channel connection states: ${String(error)}`);
      return undefined;
    }
  }

  /**
   * Resolve the onboarding registry, or refuse. The getter is read per call
   * because the host assigns the registry *after* building this service (the
   * registry's enable step saves through `save()` below); a host that never
   * assigns one gets the same `unsupported` the RPC layer reports for a missing
   * method, rather than a half-working stub.
   */
  function requireOnboarding(): FeishuOnboardingRegistry {
    const registry = options.onboarding?.();
    if (registry === undefined) {
      const err = new Error("unsupported") as Error & { code?: string };
      err.code = "unsupported";
      throw err;
    }
    return registry;
  }

  async function snapshot(
    rawConfig: Record<string, unknown>,
    warnings: SettingsWarningCode[] = [],
  ): Promise<SettingsSnapshot> {
    // The one boundary every read crosses — `get`, `status`, both save paths —
    // so the secret filter belongs here and not in each read (see
    // `withoutSecrets`).
    const config = withoutSecrets(rawConfig);
    const enabled = (Array.isArray(config.channels) ? config.channels : [...channels])
      .filter((name) => channels.includes(name as ChannelName)) as string[];
    const credentials: Record<string, boolean> = {};
    // One `get()` per channel, projected two ways: presence (a boolean) and a
    // host-masked preview (a lossy string). Neither is a usable secret — the
    // masking happens here, before the value can cross the wire, so no browser
    // tab (or screenshot of one) ever holds an appSecret. See
    // `SettingsSnapshot.secretPreviews` in settings-rpc.ts.
    const secrets: Record<string, Record<string, boolean>> = {};
    const secretPreviews: Record<string, Record<string, string>> = {};
    // Channels whose credential lookup *threw* — presence unknown, which is not
    // the same claim as "not configured" (see `SettingsSnapshot.credentialErrors`).
    const credentialErrors: string[] = [];
    for (const name of channels) {
      if (credentialStore) {
        try {
          credentials[name] = await credentialStore.configured(name);
          const values = await credentialStore.get(name);
          const presence: Record<string, boolean> = {};
          const previews: Record<string, string> = {};
          for (const key of Object.keys(CHANNEL_SECRET_KEYS[name] ?? {})) {
            const value = values[key] ?? "";
            presence[key] = value.length > 0;
            // An unset key is absent from `previews` rather than present-but-
            // empty, so "no entry" and "not configured" are the same statement.
            if (value.length > 0) previews[key] = maskSecret(key, value);
          }
          secrets[name] = presence;
          secretPreviews[name] = previews;
        } catch (error) {
          // Was a bare `catch {}`, with the comment nowhere in sight: an IO
          // error — an unreadable store, a locked file — became
          // 「未配置凭据」, which sent the user to re-enter an appSecret that was
          // never the problem. The boolean is still false (the pane needs
          // *something* to render), but the channel is named in
          // `credentialErrors` so the pane can say the state is unknown instead
          // of asserting it is empty.
          log(`failed to read the stored credentials for "${name}": ${String(error)}`);
          credentialErrors.push(name);
          credentials[name] = false;
          secrets[name] = {};
          secretPreviews[name] = {};
        }
      } else {
        credentials[name] = false;
        secrets[name] = {};
        secretPreviews[name] = {};
      }
    }
    const failures = channelErrors();
    // Same `enabled` the snapshot reports, handed to the probe so the badge's
    // 「未启用」 cannot disagree with the checkbox that produced it.
    const channelStatus = channelStates(enabled as readonly ChannelName[]);

    // Read per call, like `onboarding`: both are wired by the host after this
    // service is built.
    let agentModel: { provider: string; model: string } | undefined;
    try {
      const selection = options.agentModel?.();
      if (selection?.provider && selection.model) {
        agentModel = { provider: selection.provider, model: selection.model };
      }
    } catch (error) {
      // "Cannot say" is not "nothing selected": leaving the row off is the
      // honest answer, and a row showing an empty model would be a claim.
      log(`failed to read the default model: ${String(error)}`);
    }
    let sharedOverrideKeys: string[] = [];
    try {
      sharedOverrideKeys = [...(options.sharedOverrideKeys?.() ?? [])];
    } catch (error) {
      log(`failed to read the shared-config overrides: ${String(error)}`);
    }

    return {
      config,
      enabled,
      credentials,
      secrets,
      secretPreviews,
      live: liveHandle() !== undefined,
      // Attached only when non-empty: the pane's own tests deep-equal whole
      // snapshots, and an always-present `[]` would be noise on the happy path.
      ...(warnings.length > 0 ? { warnings } : {}),
      ...(credentialErrors.length > 0 ? { credentialErrors } : {}),
      ...(Object.keys(failures).length > 0 ? { channelErrors: failures } : {}),
      // Attached whenever the probe is wired, empty result or not — see the
      // option's note: 「未启用」/「未运行」 are answers, so an absent key has to
      // keep meaning "this host cannot say".
      ...(channelStatus === undefined ? {} : { channelStatus }),
      ...(agentModel ? { agentModel } : {}),
      ...(sharedOverrideKeys.length > 0 ? { sharedOverrideKeys } : {}),
    };
  }

  return {
    async get() { return snapshot(readConfig()); },
    async status() { return snapshot(readConfig()); },
    async saveCredentials(channel: string, values: Record<string, string>) {
      if (!credentialStore) {
        const err = new Error("not-configured") as Error & { code?: string };
        err.code = "not-configured";
        throw err;
      }
      const map = CHANNEL_SECRET_KEYS[channel as ChannelName] ?? {};
      const refValues: Record<string, string> = {};
      for (const [configKey, ref] of Object.entries(map)) {
        if (values[configKey] !== undefined) refValues[ref] = values[configKey];
      }
      if (Object.keys(refValues).length === 0) {
        const err = new Error("invalid-credentials") as Error & { code?: string };
        err.code = "invalid-credentials";
        throw err;
      }
      await credentialStore.save(channel as ChannelName, refValues);
      // The adapters are holding the previous secret; hand them the new one
      // before answering the pane (see `onCredentialsSaved`). Awaited so the
      // re-apply is *done* by the time the snapshot below reads the runtime's
      // failures — otherwise the pane gets this save's answer on the next call.
      const warnings: SettingsWarningCode[] = [];
      if (options.onCredentialsSaved) {
        try {
          await options.onCredentialsSaved();
        } catch (error) {
          // The credential *is* stored, so reporting a failed save would be a
          // lie in the other direction — re-sending the same secret changes
          // nothing and the user would be told to try again forever. The lie
          // that remains is 「已保存」 with no hint that the running adapter
          // never picked the new value up, so the pane is told both things:
          // the save succeeded, and it has not taken effect (yet).
          warnings.push("credentialsStoredNotApplied");
          log(`credential store updated but the channel reconcile failed: ${String(error)}`);
        }
      }
      return snapshot(readConfig(), warnings);
    },
    async save(config: Record<string, unknown>) {
      const live = liveHandle();
      if (live) {
        // The payload is browser input, so it is projected onto the namespace's
        // declared keys inside `write` before it can reach the document. A
        // rejection (schema violation) propagates to the pane as a failed save.
        await live.write(config);
        // `replace` resolves after the provider committed the new value, so this
        // read is already fresh — no waiting on the file watcher's debounce.
        return snapshot(readConfig());
      }
      const next = { ...readConfig(), ...config };
      persist(next);
      return snapshot(next);
    },
    // The three onboarding endpoints exist only when this host has a registry.
    // A pane that calls them against one without gets `unsupported` from the
    // RPC layer's own `typeof` check — the same answer as any other optional
    // method — instead of a stub that half-answers.
    ...(options.onboarding === undefined
      ? {}
      : {
          onboardingStart: (channel: string): Promise<OnboardingStatus> => requireOnboarding().start(channel),
          onboardingStatus: (): Promise<OnboardingStatus> => requireOnboarding().status(),
          onboardingCancel: (): Promise<OnboardingStatus> => requireOnboarding().cancel(),
        }),
  };
}