/**
 * Live channel lifecycle for dsh-connect.
 *
 * `activateChannels` starts a fixed set of adapters once, at load time. Once
 * the channel list is user-editable (the `dsh-connect` settings namespace) the
 * plugin needs the other half of that story: a channel removed from
 * `channels[]` has to be *stopped*, and one whose config changed has to be
 * restarted with the new values.
 *
 * Two properties this class exists to guarantee:
 *
 * - **Stop before start.** A reconfigured Feishu adapter must release its long
 *   connection before the replacement opens one. Two live connections for the
 *   same app deliver every event twice, which looks like the bot answering
 *   itself rather than like a crash.
 * - **Serialised applies.** A settings edit can fire `onChange` more than once
 *   in a burst (and the provider's file watcher debounces on its own schedule).
 *   Applies are chained, so a stop can never interleave with the next start.
 *
 * Kept free of cordis and channel-SDK imports so it is unit-testable with fake
 * adapters.
 * @module dsh-connect/settings/channel-runtime
 */

import {
  CHANNELS,
  injectSecrets,
  type ChannelApply,
  type ChannelName,
  type ChannelsConfig,
  type LoggerLike,
} from "./channels.js";

/**
 * Deterministically serialise a config value for comparison.
 *
 * `JSON.stringify` alone would be enough for values from one source, but the
 * effective config is a spread of `channelDefaults` and per-channel overrides
 * whose key order depends on how the user wrote the YAML. Sorting keys keeps a
 * cosmetic reorder in `settings.yaml` from tearing down a healthy connection.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

/**
 * Deep-copy a plain config object, falling back to the original when it holds
 * something `structuredClone` cannot carry (a function from a test fixture, or
 * a class instance from a hand-written config).
 */
function clone<T>(value: T): T {
  try {
    return structuredClone(value);
  } catch {
    return value;
  }
}

/** Why a channel was stopped — used only for the log line. */
export type StopReason = "disabled" | "reconfigured" | "shutdown";

export interface ChannelRuntimeOptions<Ctx extends LoggerLike> {
  /** Context handed to each channel's `apply`. */
  ctx: Ctx;
  /** Channel name → its plugin `apply`, as in `activateChannels`. */
  channels: Record<string, ChannelApply<Ctx>>;
  /**
   * Stop a channel that is running. Wired to `ConnectService.unregisterAdapter`
   * so the adapter is dropped from the routing map *and* torn down; a runtime
   * that only knew how to start would leak connections on every settings edit.
   */
  teardown: (name: ChannelName) => Promise<void>;
  /**
   * Refresh store-backed secrets before computing each channel's effective
   * config (same source `apply` uses at boot). Optional so tests can skip it.
   */
  getSecrets?: (name: ChannelName) => Promise<Record<string, string>>;
}

/**
 * Owns which channels are currently running and reconciles that set against a
 * desired config on every change.
 */
export class ChannelRuntime<Ctx extends LoggerLike = LoggerLike> {
  private readonly opts: ChannelRuntimeOptions<Ctx>;
  /** Channel → the effective config it was started with. */
  private readonly running = new Map<ChannelName, unknown>();
  /** Tail of the apply chain; see "Serialised applies" above. */
  private chain: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(options: ChannelRuntimeOptions<Ctx>) {
    this.opts = options;
  }

  /** Channels currently up, in activation order. */
  active(): ChannelName[] {
    return [...this.running.keys()];
  }

  /**
   * Bring the running set in line with `config`. Channels that are new start,
   * channels that are gone or whose effective config changed restart.
   *
   * Never rejects: a channel that fails to start or stop is logged and the
   * others still get their chance. A settings change should not be able to take
   * the whole bridge down.
   */
  apply(config: ChannelsConfig | null | undefined): Promise<void> {
    const run = this.chain.then(
      () => this.reconcile(config ?? {}),
      () => this.reconcile(config ?? {}),
    );
    // Keep the chain alive regardless of this apply's outcome.
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Stop every running channel. Waits for an in-flight apply first. */
  async dispose(): Promise<void> {
    this.disposed = true;
    await this.chain;
    for (const name of [...this.running.keys()]) await this.stop(name, "shutdown");
  }

  private log(message: string): void {
    this.opts.ctx.logger?.warn?.(message);
  }

  private async reconcile(config: ChannelsConfig): Promise<void> {
    if (this.disposed) return;
    const desired = await this.desired(config);

    // Stop first, start second: see the module comment on double delivery.
    for (const [name, current] of [...this.running]) {
      const next = desired.get(name);
      if (next === undefined) {
        await this.stop(name, "disabled");
      } else if (stableStringify(current) !== stableStringify(next)) {
        await this.stop(name, "reconfigured");
      }
    }

    for (const [name, channelConfig] of desired) {
      // Still running and unchanged (nothing above removed it).
      if (this.running.has(name)) continue;
      const apply = this.opts.channels[name];
      if (apply === undefined) continue;
      try {
        apply(this.opts.ctx, channelConfig);
        this.running.set(name, channelConfig);
      } catch (error) {
        this.log(`connect: channel "${name}" failed to start: ${String(error)}`);
      }
    }
  }

  /** Channel → effective config, mirroring `activateChannels`' merge exactly. */
  private async desired(config: ChannelsConfig): Promise<Map<ChannelName, unknown>> {
    const wanted = config.channels ?? CHANNELS;
    const defaults = config.channelDefaults ?? {};
    // Resolve secrets before the diff so a rotated credential counts as a
    // change and restarts the channel that needs it.
    const source =
      this.opts.getSecrets === undefined
        ? config
        : await injectSecrets(
            config,
            wanted.filter((name) => this.opts.channels[name] !== undefined),
            this.opts.getSecrets,
          );

    const out = new Map<ChannelName, unknown>();
    for (const name of wanted) {
      if (this.opts.channels[name] === undefined) {
        this.log(`connect: unknown channel "${name}"; skipped`);
        continue;
      }
      const overrides = (source as Record<string, unknown>)[name] ?? {};
      // Clone rather than alias: a config resolved from the settings namespace
      // is deep-frozen by the provider, so handing an adapter a nested object
      // it later writes to would throw in strict mode instead of quietly
      // working the way it does for a YAML-sourced config.
      out.set(name, { ...clone(defaults), ...clone(overrides as Record<string, unknown>) });
    }
    return out;
  }

  private async stop(name: ChannelName, reason: StopReason): Promise<void> {
    // Drop it from the running set first: if teardown throws, the channel is
    // still off the books, and the next apply will try to start it again
    // rather than believing a half-stopped adapter is healthy.
    this.running.delete(name);
    try {
      await this.opts.teardown(name);
    } catch (error) {
      this.log(`connect: channel "${name}" failed to stop (${reason}): ${String(error)}`);
    }
  }
}
