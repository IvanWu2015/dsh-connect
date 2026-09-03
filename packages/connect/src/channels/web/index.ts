/**
 * Web channel adapter for dsh-connect: enables DSH Web GUI to mirror and
 * interact with Feishu conversations through the unified ChannelAdapter interface.
 * @module dsh-connect/web
 */
import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { WebAdapter } from "./adapter.js";
import type { BindingStore } from "../../binding.js";

export { WebAdapter } from "./adapter.js";

/** Plugin configuration options. */
export const Config = z.object({
  /** Polling interval in milliseconds for detecting new mirror sessions. Default: 1000ms */
  pollIntervalMs: z.number(),
});

export interface ConnectWebConfig {
  pollIntervalMs?: number;
}

interface ConnectLike {
  registerAdapter(adapter: unknown): void;
  /** Public accessor for the binding routing store (added to ConnectService). */
  bindingStore?: BindingStore;
}

/**
 * Register and start the Web adapter. This enables the DSH Web GUI to
 * automatically detect and interact with mirrored Feishu conversations.
 * `connect` is the already-constructed `ConnectService` instance (passed from
 * the merged entry, not resolved via `ctx.get`), so its public `bindingStore`
 * getter is read directly.
 *
 * When a user runs `/mirror` in Feishu, the resulting webMirrorSessionId
 * becomes accessible through this adapter, allowing the Web GUI to:
 * - View the shared session history
 * - Send messages (subject to lock ownership)
 * - Receive real-time updates through DSH's session event system
 */
export function register(connect: ConnectLike, config: ConnectWebConfig | null = {}, ctx: Context): void {
  // The DSH loader passes `null` for entries without an explicit config.
  config = config ?? {};

  // Read the BindingStore from the connect service's public getter (part of the
  // service contract), not via `ctx.get("connect")`.
  const bindings = connect.bindingStore;

  if (bindings === undefined) {
    ctx.logger?.warn?.("connect-web: BindingStore not available, mirror detection disabled");
    return;
  }

  try {
    const adapter = new WebAdapter(bindings, {
      pollIntervalMs: config.pollIntervalMs,
    });

    connect.registerAdapter(adapter);

    void adapter.start().catch((error) => {
      ctx.logger?.warn?.(`connect-web: start failed: ${String(error)}`);
    });

    ctx.logger?.info?.("connect-web: Web adapter registered, mirror detection active");
  } catch (error) {
    ctx.logger?.warn?.(`connect-web: adapter init failed: ${String(error)}`);
  }
}

/**
 * Compatibility shell for the old split-plugin registration path (when `connect`
 * is an already-active, separate plugin). The merged entry calls `register`
 * directly instead, because `ctx.get("connect")` returns undefined inside this
 * plugin's own `apply`.
 */
export function apply(ctx: Context, config: ConnectWebConfig | null = {}): void {
  const connect = ctx.get("connect") as ConnectLike | undefined;
  if (connect === undefined) {
    throw new Error("connect-web: the dsh-connect service is not present; load it before this adapter");
  }
  register(connect, config, ctx);
}
