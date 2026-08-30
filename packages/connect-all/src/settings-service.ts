/**
 * Persistence backend for the dsh-connect web settings pane.
 *
 * A host-side service that reads/writes the non-secret plugin settings (the
 * `dsh-connect-all` config: `channels`, `channelDefaults`, per-channel fields)
 * to a small JSON state file, and reports per-channel credential presence via
 * an optional DSH credential store. Secrets (appSecret/botToken) live in the
 * DSH credentials store, never in this file.
 *
 * @module dsh-connect-all/settings-service
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { CHANNELS, type ChannelName } from "./channels.js";
import type { SettingsService, SettingsSnapshot } from "./settings-rpc.js";
import { CHANNEL_SECRET_KEYS, type CredentialStore } from "./credential-store.js";

export interface SettingsServiceOptions {
  /** JSON file to persist non-secret settings (omit = in-memory only). */
  statePath?: string;
  /** Known channel names (default: built-in channels). */
  channelNames?: readonly ChannelName[];
  /** Report credential presence per channel (optional; default: all false). */
  credentialStore?: CredentialStore;
  /** Error sink (default: console.error). */
  log?: (msg: string) => void;
}

function logError(msg: string) {
  if (typeof console !== "undefined") console.error?.("[dsh-connect-all/settings] " + msg);
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

  function readConfig(): Record<string, unknown> {
    if (!statePath || !existsSync(statePath)) return {};
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
    for (const name of channels) {
      if (credentialStore) {
        try { credentials[name] = await credentialStore.configured(name); } catch { credentials[name] = false; }
      } else {
        credentials[name] = false;
      }
    }
    return { config, enabled, credentials };
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
      const next = { ...readConfig(), ...config };
      persist(next);
      return snapshot(next);
    },
  };
}