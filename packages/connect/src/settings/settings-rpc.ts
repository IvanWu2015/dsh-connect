/**
 * Host-side RPC facade for the dsh-connect web settings pane.
 *
 * Mirrors dsh-im's host RPC pattern: a plugin registers a single channel on
 * `ctx.connection.rpc.handle(...)` and a handler dispatches dotted endpoints,
 * returning `{ ok: true, value }` on success or `{ ok: false, error }` on
 * failure (see dsh-im `plugin-src/host/update-rpc.mjs`).
 *
 * Endpoints:
 * - `settings.get` — current non-secret config + enabled channels + credential presence.
 * - `settings.save` — persist non-secret config (payload must be non-empty).
 * - `credentials.save` — persist secrets to the DSH credential store (payload
 *   `{ channel, values }`, values are {configKey: secret}).
 * - `settings.status` — fresh status snapshot.
 *
 * @module dsh-connect/settings/settings-rpc
 */

/** RPC channel the settings pane calls. */
export const SETTINGS_RPC_CHANNEL = "/dsh-connect";

/** Endpoints the settings pane can invoke on the channel. */
export const SETTINGS_ENDPOINTS = Object.freeze(["settings.get", "settings.save", "credentials.save", "settings.status"]);

/** Error codes considered safe to surface verbatim to the browser. */
const PUBLIC_ERRORS = new Set([
  "settings-failed", "bad-request", "cancelled", "invalid-payload", "unknown-profile",
  "unsupported-runtime", "not-configured", "credential-missing", "credential-invalid",
  "channel-disabled", "save-failed", "state-unavailable", "disposed", "interrupted",
  "unsupported", "invalid-channel", "invalid-credentials",
]);

/** A settings pane `settings.get`/status snapshot. */
export interface SettingsSnapshot {
  /** The current plugin config (non-secret fields). */
  config: Record<string, unknown>;
  /** The channel names currently enabled. */
  enabled: string[];
  /** Per-channel credential presence (true = stored & set). */
  credentials: Record<string, boolean>;
}

/** The service backing the RPC; supplied by the web-settings integration. */
export interface SettingsService {
  get(): Promise<SettingsSnapshot>;
  save(config: Record<string, unknown>): Promise<SettingsSnapshot>;
  /** Persist channel secrets ({configKey: secret}) to the credential store. */
  saveCredentials?(channel: string, values: Record<string, string>): Promise<SettingsSnapshot>;
  status(): Promise<SettingsSnapshot>;
}

function validPayload(endpoint: string, payload: unknown): boolean {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return false;
  const keys = Object.keys(payload);
  if (endpoint === "settings.save") return keys.length > 0;
  if (endpoint === "credentials.save") {
    return keys.length > 0 && typeof (payload as any).channel === "string"
      && (payload as any).values !== null && typeof (payload as any).values === "object"
      && !Array.isArray((payload as any).values);
  }
  // The reads carry no payload.
  return keys.length === 0;
}

/** Build the channel handler for a settings service. */
export function createSettingsRpcHandler(service: SettingsService) {
  return async (endpoint: string, payload: unknown, signal?: { aborted?: boolean }) => {
    if (!SETTINGS_ENDPOINTS.includes(endpoint as never) || !validPayload(endpoint, payload)) {
      return { ok: false, error: { code: "bad-request", message: "Invalid settings request." } };
    }
    if (signal?.aborted) return { ok: false, error: { code: "cancelled", message: "Request cancelled." } };
    try {
      const record = (payload ?? {}) as Record<string, unknown>;
      const value = endpoint === "settings.get"
        ? await service.get()
        : endpoint === "settings.save"
          ? await service.save(record)
          : endpoint === "credentials.save"
            ? await saveCredentialsP(service, record)
            : await service.status();
      return { ok: true, value };
    } catch (error) {
      const code = PUBLIC_ERRORS.has((error as any)?.code) ? (error as any).code : "settings-failed";
      return { ok: false, error: { code, message: code } };
    }
  };
}

async function saveCredentialsP(service: SettingsService, record: Record<string, unknown>): Promise<SettingsSnapshot> {
  if (typeof service.saveCredentials !== "function") {
    const err = new Error("unsupported") as any;
    err.code = "unsupported";
    throw err;
  }
  const channel = record.channel as string;
  const values = (record.values ?? {}) as Record<string, string>;
  return service.saveCredentials(channel, values);
}

/**
 * Register the settings RPC channel, mirroring dsh-im's `installUpdateRpc`.
 * No-ops (returns a no-op disposer) when the host connection is unavailable,
 * so the plugin stays safe to load in any context.
 */
export function installSettingsRpc(ctx: unknown, options: { service: SettingsService }) {
  const conn = (ctx as any)?.connection;
  const handle = conn?.rpc?.handle;
  if (typeof handle !== "function") return () => {};
  return handle(SETTINGS_RPC_CHANNEL, createSettingsRpcHandler(options.service), { authority: "loopback" }) as () => void;
}