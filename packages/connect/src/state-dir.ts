/**
 * The single definition of where dsh-connect keeps its state.
 *
 * `bindings.json`, `reminders.json` and the settings document all live in one
 * directory, and every writer must agree on it — otherwise a store silently
 * reads a different file than the one that was written. That agreement used to
 * be maintained by copying the same `stateDir ?? process.env… ?? ".dsh-connect"`
 * expression into each store, and one copy had already drifted (the settings
 * path consulted neither the environment variable nor the default). This module
 * is now the only copy.
 * @module dsh-connect/state-dir
 */

/** Fallback directory, relative to the process cwd. */
export const DEFAULT_STATE_DIR = ".dsh-connect";

/** The part of a plugin config that selects the state directory. */
export interface StateDirConfig {
  /** Explicit directory from the plugin config; wins over everything. */
  stateDir?: string;
}

/** A usable path is a non-empty string; a blank YAML value means "unset". */
function usable(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Resolve the state directory: plugin config, then `DSH_CONNECT_STATE_DIR`,
 * then {@link DEFAULT_STATE_DIR}.
 *
 * A blank `stateDir: ""` is treated as unset rather than honoured — resolving
 * it would drop `bindings.json` into whatever cwd the host happened to boot in.
 */
export function resolveStateDir(config?: StateDirConfig): string {
  if (usable(config?.stateDir)) return config.stateDir;
  if (usable(process.env.DSH_CONNECT_STATE_DIR)) return process.env.DSH_CONNECT_STATE_DIR;
  return DEFAULT_STATE_DIR;
}
