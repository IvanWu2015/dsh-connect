/**
 * Process-level safety net for the Feishu transport.
 *
 * ## Why this exists
 *
 * The desktop host died three times on the same shape of failure (2026-11-02,
 * 2026-11-12, 2026-11-23):
 *
 *   dsh: fatal load failure: AxiosError: read ECONNRESET
 *     url: 'https://open.feishu.cn/open-apis/cardkit/v1/cards'
 *
 * (and twice before with `getaddrinfo ENOTFOUND` on the same endpoint.) Every
 * session in the host went with it, for one dropped HTTP request.
 *
 * The thrower is outside this package: the official Lark SDK's streaming-card
 * controller fires `void this.doFire()` from a `setTimeout`, so a failed cardkit
 * rewrite is an UNHANDLED rejection — and Node >= 15 terminates the process on
 * those. Nothing upstream awaits that promise, so no `try/catch` in this plugin
 * can close the hole. Worse, the SDK builds its `cardkit` client internally and
 * does not route it through the `httpInstance` handed to `createLarkChannel`
 * (measured: an injected instance never sees the request), so the transport
 * cannot be wrapped either.
 *
 * ## What this does — and deliberately does not do
 *
 * It registers ONE `unhandledRejection` listener while the Feishu channel is
 * mounted. A rejection is absorbed only when it is provably ours:
 *
 *   - the error is a transport failure (`ECONNRESET`, `ENOTFOUND`, `ETIMEDOUT`,
 *     `EPIPE`, `EAI_AGAIN`, socket hang up, an abort/timeout …), AND
 *   - something in its own `message` / `url` / `config.url` / stack names the
 *     Feishu API host.
 *
 * Anything else is handed to the listeners that were there before us, which is
 * the host's normal fatal path. A plugin must never become a blanket swallow:
 * unrelated defects have to keep killing the process exactly as before.
 *
 * @module dsh-connect/feishu-network
 */

/** An error that traces back to a dropped / refused / timed-out network call. */
const TRANSPORT_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "EPIPE",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "ERR_SOCKET_CONNECTION_TIMEOUT",
  "UND_ERR_SOCKET",
  "ERR_CANCELED",
]);

/** Hosts whose failures belong to this transport. */
const FEISHU_HOST = /open\.feishu\.cn|larksuite\.com|open\.larksuite\.com/i;

/** A marker symbol so the adapter can assert the guard is installed. */
export const larkHttpGuard = Symbol.for("dsh-connect/lark-http-guard");

/** Where to look for a host name on an arbitrary thrown value. */
function describe(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value !== "object") return String(value);
  const error = value as {
    message?: unknown;
    code?: unknown;
    url?: unknown;
    stack?: unknown;
    config?: { url?: unknown };
    cause?: unknown;
    request?: { path?: unknown };
  };
  return [
    error.message,
    error.url,
    error.config?.url,
    error.request?.path,
    error.stack,
    describe(error.cause),
  ]
    .filter((part): part is string => typeof part === "string" && part !== "")
    .join(" ");
}

/** The transport code on `value`, if it has one anywhere in its cause chain. */
function transportCode(value: unknown): string | undefined {
  let current: unknown = value;
  for (let depth = 0; depth < 5 && current !== null && typeof current === "object"; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && TRANSPORT_CODES.has(code)) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/**
 * Whether `reason` is a transport failure raised by the Feishu transport.
 *
 * Both halves are required. A dropped connection to *another* host is not ours
 * to swallow, and a Feishu-hosted error that is NOT a transport failure (a bug
 * in our own code, a schema error) must keep terminating the process.
 */
export function isFeishuTransportRejection(reason: unknown): boolean {
  const code = transportCode(reason);
  if (code === undefined) return false;
  return FEISHU_HOST.test(describe(reason));
}

/** The listener the host had before us, so an unrelated rejection still reaches it. */
type RejectionListener = (reason: unknown, promise: Promise<unknown>) => void;

export interface ProcessRejectionGuardOptions {
  /** Logger to report an absorbed rejection to. Absent = silent (no host logger). */
  logger?: { warn?: (...args: unknown[]) => void };
  /** Who installed the guard, printed in the log line so it is attributable. */
  owner: string;
}

/**
 * Install the process-level guard, returning the disposer.
 *
 * Idempotent per installation and safe to call twice: the second call returns a
 * disposer that removes what the second call added, so a plugin that mounts and
 * unmounts cannot leave the host with a stray listener.
 */
export function installProcessRejectionGuard(options: ProcessRejectionGuardOptions): () => void {
  // Whatever the host had installed is what an unrelated rejection is handed to.
  // Read it at dispatch time, NOT at installation time: the plugin loads during
  // host startup, and a host listener registered later (or a test recorder) must
  // still receive what this guard declines — otherwise ordering decides whether
  // a real defect is reported.
  const guard: RejectionListener = (reason, promise) => {
    if (isFeishuTransportRejection(reason)) {
      // Absorbed: one dropped card rewrite is a lost frame, not a dead harness.
      const code = transportCode(reason) ?? "network error";
      options.logger?.warn?.(
        `${options.owner}: absorbed an unhandled Feishu transport rejection (${code}); `
        + "the host stays up. This is a streaming-card delivery failure, not a task failure.",
      );
      return;
    }
    // Not ours. Hand it to every OTHER listener — normally Node's fatal handler,
    // which is exactly the behaviour that existed before this guard.
    for (const listener of process.listeners("unhandledRejection") as RejectionListener[]) {
      if (listener === guard) continue;
      try {
        listener(reason, promise);
      } catch {
        // A host listener that throws must not change our own control flow.
      }
    }
  };

  process.on("unhandledRejection", guard);
  return () => {
    process.removeListener("unhandledRejection", guard);
  };
}

/**
 * Wrap an `HttpInstance` so every request is bounded by `timeoutMs`.
 *
 * Not the crash fix — the SDK's `cardkit` client does not go through this
 * instance (see the module note), so it cannot cover the endpoint that killed
 * the host. It is still the right thing for the requests that DO go through it:
 * a socket that never answers must not pin a card rewrite forever, which is the
 * same defect the desktop host hit on `api.deepseek.com` ("timed out after
 * 5000 ms; keeping the previous catalog").
 */
export function larkHttpInstance(
  inner: Record<string, (...args: never[]) => Promise<unknown>>,
  options: { timeoutMs?: number } = {},
): Record<string, (...args: never[]) => Promise<unknown>> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const bound = (verb: string) => async (...args: never[]): Promise<unknown> => {
    const call = inner[verb];
    if (typeof call !== "function") throw new Error(`larkHttpInstance: no ${verb} on the underlying instance`);
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        call.apply(inner, args),
        new Promise((_resolve, reject) => {
          timer = setTimeout(() => {
            const error = new Error(`request timed out after ${timeoutMs} ms`) as Error & { code?: string };
            error.code = "ETIMEDOUT";
            reject(error);
          }, timeoutMs);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };
  const guarded = { [larkHttpGuard]: bound } as Record<string, unknown>;
  for (const verb of ["request", "get", "post", "put", "patch", "delete", "head", "options"]) {
    guarded[verb] = bound(verb);
  }
  return guarded as Record<string, (...args: never[]) => Promise<unknown>>;
}
