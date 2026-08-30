/**
 * All-in-one channel orchestration for dsh-connect: a small, side-effect-free
 * selector that activates a requested subset of channel adapters. Kept separate
 * from the cordis entry so it is unit-testable without pulling any channel SDK.
 * @module dsh-connect-all/channels
 */

/** Channel adapters the all-in-one bundle can activate. */
export type ChannelName = "feishu" | "telegram" | "dingtalk" | "web";

/** Config for the all-in-one plugin: which channels + their per-channel config. */
export interface ConnectAllConfig {
  /** Optional path to persist web-settings edits (non-secret). */
  settingsStatePath?: string;
  /** Keys applied to every channel that doesn't set its own (e.g. a shared `language`). */
  channelDefaults?: Record<string, unknown>;
  /** Channel names to activate; default: all built-in channels. */
  channels?: ChannelName[];
  feishu?: Record<string, unknown>;
  telegram?: Record<string, unknown>;
  dingtalk?: Record<string, unknown>;
  web?: Record<string, unknown>;
}

/** The only slice of a context the selector touches: a `logger.warn`. */
export interface LoggerLike {
  logger?: { warn?: (...args: unknown[]) => void } | undefined;
}

/** A channel plugin's `apply(ctx, config)`, loosely typed for the selector. */
export type ChannelApply<Ctx extends LoggerLike = LoggerLike> = (ctx: Ctx, config: any) => void;

/** Built-in channels, in a stable order (for docs and the default selector). */
export const CHANNELS: readonly ChannelName[] = ["feishu", "telegram", "dingtalk", "web"];

/**
 * Activate the requested adapters into `ctx` (the `connect` service is
 * expected to be present via the caller's `inject`). `channels` maps a channel
 * name to its plugin `apply`. Unknown names are skipped with a warning; a
 * channel whose `apply` throws is caught so one broken adapter never takes the
 * others down.
 *
 * @returns the channel names that were started.
 */
export function activateChannels<Ctx extends LoggerLike>(
  ctx: Ctx,
  config: ConnectAllConfig | null | undefined,
  channels: Record<string, ChannelApply<Ctx>>,
): string[] {
  const cfg = config ?? {};
  const defaults = cfg.channelDefaults ?? {};
  const wanted = cfg.channels ?? CHANNELS;
  const started: string[] = [];
  for (const name of wanted) {
    const apply = channels[name];
    if (apply === undefined) {
      ctx.logger?.warn?.(`connect-all: unknown channel "${name}"; skipped`);
      continue;
    }
    try {
      const overrides = (cfg as Record<string, unknown>)[name] ?? {};
      apply(ctx, { ...defaults, ...overrides });
      started.push(name);
    } catch (error) {
      ctx.logger?.warn?.(`connect-all: channel "${name}" failed to start: ${String(error)}`);
    }
  }
  return started;
}
/**
 * Secret config-keys that live under a *dotted path* rather than at the channel
 * config root, because the adapter reads them from a sub-object (e.g. dingtalk's
 * bidirectional stream credentials read from `config.stream.clientId`). Keys
 * absent from this map are injected flat. Used by `injectSecrets`.
 */
const NESTED_SECRET_KEYS: Record<ChannelName, Record<string, string>> = {
  feishu: {},
  telegram: {},
  dingtalk: { clientId: "stream.clientId", clientSecret: "stream.clientSecret" },
  web: {},
};

/** Copy `secrets` into `target`, writing nested keys at their dotted path. */
function mergeSecrets(
  target: Record<string, unknown>,
  secrets: Record<string, string>,
  nested: Record<string, string>,
): Record<string, unknown> {
  for (const [key, value] of Object.entries(secrets)) {
    const path = nested[key];
    if (path === undefined) {
      target[key] = value;
      continue;
    }
    const segments = path.split(".");
    let node: Record<string, unknown> = target;
    for (let i = 0; i < segments.length - 1; i += 1) {
      const segment = segments[i];
      const next = node[segment];
      if (next === null || typeof next !== "object" || Array.isArray(next)) {
        node[segment] = {};
      }
      node = node[segment] as Record<string, unknown>;
    }
    node[segments[segments.length - 1]] = value;
  }
  return target;
}

/**
 * Return a shallow-cloned config whose enabled channels are enriched with the
 * secrets returned by `getSecrets` (stored secrets win over channel config).
 * Used by `apply` to feed store-backed credentials into each adapter while
 * leaving the caller's config object untouched. Secrets are placed at the slot
 * each adapter expects — flat keys at the channel root, nested keys (dingtalk's
 * `stream.clientId`/`stream.clientSecret`) under their sub-object.
 */
export async function injectSecrets(
  config: ConnectAllConfig,
  enabled: readonly ChannelName[],
  getSecrets: (channel: ChannelName) => Promise<Record<string, string>>,
): Promise<ConnectAllConfig> {
  const out: ConnectAllConfig = { ...config };
  for (const name of enabled) {
    try {
      const secrets = await getSecrets(name);
      if (Object.keys(secrets).length > 0) {
        // Deep-clone the channel config so we never mutate the caller's nested
        // objects (e.g. `dingtalk.stream`) when writing nested secret keys.
        const base = (out as Record<string, unknown>)[name] ?? {};
        const cloned = structuredClone(base) as Record<string, unknown>;
        (out as Record<string, unknown>)[name] = mergeSecrets(cloned, secrets, NESTED_SECRET_KEYS[name]);
      }
    } catch {
      // A channel's secret resolution failing should never block activation.
    }
  }
  return out;
}
