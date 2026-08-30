/**
 * Client-side RPC helper for the dsh-connect web settings pane.
 *
 * The frontend talks to the host over the `/dsh-connect` channel; the channel
 * returns `{ ok, value }`/`{ ok:false, error }` envelopes (see `settings-rpc.js`).
 * This helper unwraps the envelope and throws a typed error on failure, so the
 * UI can catch it and render a message. Pure + dependency-free for easy testing.
 *
 * @module dsh-connect-all/rpc-client
 */

import type { SettingsSnapshot } from "./settings-rpc.js";

/** The `ctx.connection.rpc.call` signature the settings pane uses. */
export type RpcCall = (
  endpoint: string,
  payload?: unknown,
  signal?: AbortSignal,
) => Promise<{ ok: boolean; value?: unknown; error?: { code: string; message: string } }>;

/** A typed RPC failure, surfaced to the settings UI. */
export class RpcError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "RpcError";
    this.code = code;
  }
}

/** Invoke one endpoint and unwrap the envelope (throws `RpcError` on failure). */
export function callRpc<T = unknown>(
  rpcCall: RpcCall,
  endpoint: string,
  payload?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  return rpcCall(endpoint, payload, signal).then((res) => {
    if (res.ok) return res.value as T;
    const code = res.error?.code ?? "settings-failed";
    throw new RpcError(code, res.error?.message ?? code);
  });
}

/** Load the current settings snapshot via `settings.get`. */
export function loadSettings(rpcCall: RpcCall): Promise<SettingsSnapshot> {
  return callRpc<SettingsSnapshot>(rpcCall, "settings.get", {});
}

/** Persist the settings via `settings.save`. */
export function saveSettings(rpcCall: RpcCall, config: Record<string, unknown>): Promise<SettingsSnapshot> {
  return callRpc<SettingsSnapshot>(rpcCall, "settings.save", config);
}

/** Persist channel secrets to the credential store via `credentials.save`. */
export function saveCredentials(
  rpcCall: RpcCall,
  channel: string,
  values: Record<string, string>,
): Promise<SettingsSnapshot> {
  return callRpc<SettingsSnapshot>(rpcCall, "credentials.save", { channel, values });
}

/** Ask the host for a fresh status snapshot via `settings.status`. */
export function loadStatus(rpcCall: RpcCall): Promise<SettingsSnapshot> {
  return callRpc<SettingsSnapshot>(rpcCall, "settings.status", {});
}