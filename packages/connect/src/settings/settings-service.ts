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
 * a pane save land in `$DSH_HOME/settings.yaml`, take effect immediately (the
 * namespace's `onChange` reconciles the running adapters) and survive a restart.
 * The JSON state file is the fallback for hosts without a settings service, and
 * is written only when no namespace is live.
 *
 * @module dsh-connect/settings/settings-service
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { CHANNELS, type ChannelName } from "./channels.js";
import type { SettingsService, SettingsSnapshot } from "./settings-rpc.js";
import { CHANNEL_SECRET_KEYS, type CredentialStore } from "./credential-store.js";
import { maskSecret } from "./secret-disclosure.js";
import type { LiveConnectSection } from "./namespace.js";

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
}

function logError(msg: string) {
  if (typeof console !== "undefined") console.error?.("[dsh-connect/settings] " + msg);
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
      return value && typeof value === "object" && !Array.isArray(value) ? value : {};
    } catch (error) {
      log(`failed to read settings state: ${String(error)}`);
      return {};
    }
  }

  function persist(config: Record<string, unknown>) {
    if (!statePath) return;
    try {
      mkdirSync(dirname(statePath), { recursive: true });
      writeFileSync(statePath, JSON.stringify(config, null, 2) + "\n");
    } catch (error) {
      log(`failed to write settings state: ${String(error)}`);
    }
  }

  async function snapshot(config: Record<string, unknown>): Promise<SettingsSnapshot> {
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
        } catch {
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
    return { config, enabled, credentials, secrets, secretPreviews, live: liveHandle() !== undefined };
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
      return snapshot(readConfig());
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
  };
}