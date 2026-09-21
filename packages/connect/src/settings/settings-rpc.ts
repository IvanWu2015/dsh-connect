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
import type { IncomingMessage, ServerResponse } from "node:http";

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
  /**
   * Per-channel, per-config-key secret **presence** (true = a value is stored
   * for that key) — never the values themselves. The pane uses it to tell an
   * untouched input («已配置») from an empty one.
   *
   * This used to echo the values, which put an `appSecret` into browser state
   * and every screenshot of the settings page. What leaves the host now is
   * either this boolean or the masked {@link secretPreviews} below — a usable
   * secret still leaves exactly once, when the adapter consumes it
   * (`injectSecrets`).
   */
  secrets?: Record<string, Record<string, boolean>>;
  /**
   * Per-channel, per-config-key **display preview**, for the user to confirm
   * what they configured without being able to copy it back out.
   *
   * Already masked on the host by `maskSecret` (`./secret-disclosure.js`), so
   * it is lossy by construction: identifiers such as an `appId` come through
   * whole, an `appSecret` keeps only its first and last four characters, and a
   * `webhookUrl` keeps its origin and path with the `access_token` in the query
   * masked. A key is present here only when a value is stored for it, which
   * makes an empty entry the same statement as `secrets[key] === false`.
   *
   * **Display-only.** The pane renders it as text; it must never be written
   * back as a credential, and `buildCredentialSaves` ignores it — the secret
   * inputs are still write-only and still start blank.
   */
  secretPreviews?: Record<string, Record<string, string>>;
  /**
   * True when the `dsh-connect` settings namespace is live, i.e. this config is
   * stored in `$DSH_HOME/settings.yaml` and a save takes effect immediately.
   * False means the legacy JSON state file is behind this pane: the settings
   * path control still applies, and a save needs a restart.
   */
  live?: boolean;
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

/** Endpoint segment accepted by a Connection RPC path (host-compatible). */
const ENDPOINT_SEGMENT_PATTERN = /^[A-Za-z0-9_$.-]+$/;

/** Upper bound on an accepted settings request body; settings payloads are tiny. */
const MAX_BODY_BYTES = 1024 * 1024;

/** The Host/Origin + browser-auth fence exposed by the host `connection` service. */
interface ConnectionFence {
  /** HTTP status to reject with, or `undefined` to allow the request through. */
  requestRejection?(request: IncomingMessage): number | undefined;
}

/** A named `webServer` route (subset of the host's route shape we rely on). */
interface PrefixRoute {
  kind: "prefix";
  path: string;
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
}

/** The `webServer` host service surface this module needs. */
interface WebServerLike {
  register?(route: PrefixRoute): () => void;
}

/** The inject-scope context `installSettingsRpc` expects (connection + webServer). */
interface SettingsRpcScope {
  connection?: ConnectionFence;
  webServer?: WebServerLike;
  effect?<T>(execute: () => T, label?: string): (() => void) | T;
}

/**
 * Derive the endpoint from a request path, exactly like the host's own
 * Connection router: the remainder of `channel/` must be non-empty segments
 * matching {@link ENDPOINT_SEGMENT_PATTERN}.
 */
function endpointFromPath(channel: string, pathname: string): string | undefined {
  if (!pathname.startsWith(`${channel}/`)) return undefined;
  const endpoint = pathname.slice(channel.length + 1);
  const segments = endpoint.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === ".." || !ENDPOINT_SEGMENT_PATTERN.test(segment))) return undefined;
  return endpoint;
}

/** Read a request body as UTF-8 text, rejecting past {@link MAX_BODY_BYTES}. */
function readBody(req: IncomingMessage, limit = MAX_BODY_BYTES): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let overLimit = false;
    req.on("data", (chunk: Buffer) => {
      if (overLimit) return;
      size += chunk.length;
      if (size > limit) {
        overLimit = true;
        chunks.length = 0;
        reject(new Error("body exceeds limit"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** Write a JSON response with an accurate content length. */
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": String(Buffer.byteLength(text)) });
  res.end(text);
}

/**
 * Coerce a handler result into the Connection response envelope the browser
 * client validates. `error.details` must always be an object — the client's
 * `parseConnectionResponse` throws on a missing one.
 */
function responseEnvelope(rpcId: string, result: { ok?: boolean; value?: unknown; error?: unknown }): unknown {
  if (result?.ok === true) return { type: "server-response", rpcId, result: { ok: true, value: result.value } };
  const error = (result?.error ?? {}) as { code?: unknown; message?: unknown; details?: unknown };
  const details = error.details !== null && typeof error.details === "object" ? error.details : {};
  return {
    type: "server-response",
    rpcId,
    result: { ok: false, error: { code: String(error.code ?? "settings-failed"), message: String(error.message ?? ""), details } },
  };
}

/**
 * Build the raw HTTP handler for {@link SETTINGS_RPC_CHANNEL}. Mirrors the
 * host's own Connection RPC adapter (method/content-type/envelope checks plus
 * the Host/Origin and browser-auth fence) so the pane sees the same protocol
 * and the same failure codes as a first-party channel.
 */
export function createSettingsHttpHandler(service: SettingsService, connection?: ConnectionFence) {
  const handle = createSettingsRpcHandler(service);

  return async function settingsHttpHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Same fence the host applies to `/api`: trusted Host/Origin, then browser auth.
    const rejection = connection?.requestRejection?.(req);
    if (rejection !== undefined) {
      res.writeHead(rejection, { "content-type": "text/plain" });
      res.end(rejection === 401 ? "unauthorized" : "forbidden");
      return;
    }

    const endpoint = endpointFromPath(SETTINGS_RPC_CHANNEL, new URL(req.url ?? "/", "http://dsh.internal").pathname);
    if (req.method !== "POST" || endpoint === undefined) {
      res.writeHead(404);
      res.end();
      return;
    }

    const contentType = String(req.headers["content-type"] ?? "").split(";", 1)[0]?.trim().toLowerCase();
    if (contentType !== "application/json") {
      res.writeHead(415);
      res.end("content type must be application/json");
      return;
    }

    let raw: string;
    try {
      raw = await readBody(req);
    } catch {
      res.writeHead(400);
      res.end("body is not JSON");
      return;
    }

    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      res.writeHead(400);
      res.end("body is not JSON");
      return;
    }

    const envelope = (body ?? {}) as { type?: unknown; rpcId?: unknown; method?: unknown; payload?: unknown };
    const rpcId = typeof envelope.rpcId === "string" ? envelope.rpcId : "invalid-request";
    if (envelope.type !== "client-request" || typeof envelope.rpcId !== "string" || typeof envelope.method !== "string") {
      sendJson(res, 200, responseEnvelope(rpcId, { ok: false, error: { code: "bad-request", message: "invalid client-request message" } }));
      return;
    }
    if (envelope.method !== endpoint) {
      sendJson(res, 200, responseEnvelope(rpcId, {
        ok: false,
        error: { code: "bad-request", message: `method ${JSON.stringify(envelope.method)} does not match endpoint ${JSON.stringify(endpoint)}` },
      }));
      return;
    }

    // Abort the caller's signal when the browser goes away before we answer.
    const aborter = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) aborter.abort();
    });

    const result = await handle(endpoint, envelope.payload, aborter.signal) as { ok?: boolean; value?: unknown; error?: unknown };
    sendJson(res, 200, responseEnvelope(rpcId, result));
  };
}

/**
 * Mount the settings RPC channel on the host webserver.
 *
 * Mounts a `prefix` route for {@link SETTINGS_RPC_CHANNEL} directly on the
 * `webServer` host service — the same thing the host's own
 * `connection.rpc.handle()` does internally (`owner.webServer.register(route)`
 * with the `/api` fence), and the same thing `dsh-api-gateway` does for its
 * WebSocket route.
 *
 * Why not `connection.rpc.handle()`: the host's `HostConnectionService` is
 * context-tracked, so its `get rpc()` captures `this.ctx`. cordis resolves that
 * read to a *shadow* of the service's construction context, and service
 * resolution then walks **that** fiber chain — which never contains the
 * `webServer` provider (a sibling fiber). The call therefore dies with
 * `cannot get property "webServer" without inject`, the route is never mounted,
 * and every `settings.*` call falls through to the static fallback (HTTP 405),
 * leaving the pane stuck on "加载中". Injecting `webServer` into the calling
 * scope — or declaring it in the plugin's `inject` — does not help, because the
 * shadow overrides the caller's fiber.
 *
 * @param ctx - an injection scope holding `connection` and `webServer`.
 * @param options - the settings service backing the channel.
 * @returns a disposer removing the route (no-op if the host has no webserver).
 */
export function installSettingsRpc(ctx: unknown, options: { service: SettingsService }): () => void {
  const scope = (ctx ?? {}) as SettingsRpcScope;
  const register = scope.webServer?.register;
  if (typeof register !== "function") return () => {};

  const route: PrefixRoute = {
    kind: "prefix",
    path: SETTINGS_RPC_CHANNEL,
    handler: createSettingsHttpHandler(options.service, scope.connection),
  };

  // Register through the scope's effect so the route is torn down with the fiber.
  if (typeof scope.effect === "function") {
    const disposed = scope.effect(() => register.call(scope.webServer, route), `dsh-connect: ${SETTINGS_RPC_CHANNEL} settings rpc`);
    return typeof disposed === "function" ? (disposed as () => void) : () => {};
  }
  return register.call(scope.webServer, route);
}