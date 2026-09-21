import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";

import { apply, name, inject } from "../lib/index.js";
import { SETTINGS_RPC_CHANNEL, createSettingsHttpHandler, installSettingsRpc } from "../lib/settings/settings-rpc.js";

// Build a real root context with the host services ConnectService expects. We
// call `apply` directly (not through the cordis loader), so we also pin a fake
// `ctx.webServer.register` to capture the settings route.
function makeCtx({ withConnection = true, withWebServer = true, withCredentials = true } = {}) {
  const ctx = new Context();
  ctx.provide("agents", {});
  ctx.provide("sessions", {});
  ctx.provide("agentDefaultModel", { currentSelection: () => ({ provider: "p", model: "m" }) });
  const routes = [];
  // Map-backed stand-in for `@deepseek-ai/dsh-credentials-local`. `apply` reads it
  // through the `credentials` inject, so a missing provide() here is how the
  // "no credential store" degradation path gets exercised.
  const store = new Map();
  const credentials = {
    resolve: async (ref) => store.get(ref) ?? null,
    describe: async (ref) => ({ configured: store.has(ref) }),
    set: async (ref, value) => { store.set(ref, value); },
    unset: async (ref) => { store.delete(ref); },
  };
  if (withCredentials) ctx.provide("credentials", credentials);
  if (withConnection) {
    // `connection` is only consulted for its request fence; the settings channel
    // is mounted on `webServer` (see settings-rpc.ts for why `rpc.handle` can't
    // be used for a third-party channel).
    ctx.provide("connection", { requestRejection: () => undefined });
    if (withWebServer) {
      ctx.provide("webServer", {
        register: (route) => { routes.push(route); return () => {}; },
      });
    }
  }
  return { ctx, routes, store };
}

const snapshot = { config: {}, enabled: [], credentials: {} };

function stubService(overrides = {}) {
  return {
    get: async () => snapshot,
    save: async () => snapshot,
    status: async () => snapshot,
    ...overrides,
  };
}

test("plugin metadata: name and injects", () => {
  assert.equal(name, "connect");
  // `credentials` must be a declared inject, not a lazy `ctx.get()`: this plugin
  // activates before the credentials row does, so a lazy read always returned
  // undefined and silently disabled the entire credential path.
  assert.deepEqual(inject, ["agents", "sessions", "agentDefaultModel", "credentials"]);
});

test("apply with no channels activates none and does not throw", async () => {
  const { ctx, routes } = makeCtx();
  await apply(ctx, { channels: [] });
  // Let the deferred `inject(["connection","webServer"], ...)` scope settle first.
  await new Promise((r) => setImmediate(r));
  const route = routes.find((r) => r.path === SETTINGS_RPC_CHANNEL);
  assert.ok(route, "settings RPC route should be registered on webServer");
  assert.equal(route.kind, "prefix");
  assert.equal(typeof route.handler, "function");
});

// Regression: the settings channel is mounted by us, NOT via the host's
// `connection.rpc.handle`. That helper is context-tracked and resolves
// `webServer` against the connection service's own construction fiber, so it
// throws `cannot get property "webServer" without inject` for any third-party
// channel — leaving the route unmounted and the pane hanging on "加载中".
test("apply does not mount the settings RPC channel when the host has no webServer", async () => {
  const { ctx, routes } = makeCtx({ withWebServer: false });
  await apply(ctx, { channels: [] });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(routes, []);
});

// No channel is enabled here on purpose: `feishu.register` with no credentials
// would enter one-click onboarding, leaving timers that keep the test process
// alive. (The gate in `register` now skips it off a TTY, but keeping the channel
// list empty also keeps these tests from depending on stdout's shape.)
test("apply without a host connection still succeeds (safe no-op)", async () => {
  const { ctx, routes } = makeCtx({ withConnection: false });
  await apply(ctx, { channels: [] });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(routes, []);
});

test("apply with a settingsStatePath wires the settings service (no throw)", async () => {
  const { ctx } = makeCtx({ withConnection: false });
  await apply(ctx, { channels: [], settingsStatePath: "settings.json" });
});

// Regression: this path used to fall back to `undefined` whenever the plugin
// config carried no `stateDir` — and it consulted neither the environment
// variable nor the shared default. `settings-service` treats an empty path as
// "in-memory", so every pane save was acknowledged and then dropped on reload.
test("apply resolves the settings state file from DSH_CONNECT_STATE_DIR", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-connect-state-"));
  const saved = process.env.DSH_CONNECT_STATE_DIR;
  process.env.DSH_CONNECT_STATE_DIR = dir;
  try {
    const { ctx, routes } = makeCtx();
    await apply(ctx, { channels: [] });
    await new Promise((r) => setImmediate(r));
    const route = routes.find((r) => r.path === SETTINGS_RPC_CHANNEL);
    assert.ok(route, "settings RPC route should be registered");
    await withServer((req, res) => route.handler(req, res), async (port) => {
      const res = await rpcPost(port, "settings.save", { payload: { language: "en" } });
      assert.equal(res.status, 200);
      assert.equal((await res.json()).result.ok, true);
    });
    const file = join(dir, "dsh-connect-settings.json");
    assert.ok(existsSync(file), "settings state file should land under the resolved state dir");
    assert.equal(JSON.parse(readFileSync(file, "utf8")).language, "en");
  } finally {
    if (saved === undefined) delete process.env.DSH_CONNECT_STATE_DIR;
    else process.env.DSH_CONNECT_STATE_DIR = saved;
  }
});

test("installSettingsRpc no-ops without a webServer and returns a disposer otherwise", () => {
  assert.equal(typeof installSettingsRpc({}, { service: stubService() }), "function");
  const routes = [];
  const dispose = installSettingsRpc(
    { webServer: { register: (route) => { routes.push(route); return () => { routes.pop(); }; } } },
    { service: stubService() },
  );
  assert.equal(routes.length, 1);
  assert.equal(routes[0].path, SETTINGS_RPC_CHANNEL);
  assert.equal(typeof dispose, "function");
});

// --- HTTP protocol -------------------------------------------------------
// The pane's browser client validates a strict envelope, so exercise the raw
// handler over a real socket rather than trusting the object shape.
async function withServer(handler, fn) {
  const server = createServer((req, res) => {
    Promise.resolve(handler(req, res)).catch((error) => {
      res.writeHead(500);
      res.end(String(error));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    return await fn(server.address().port);
  } finally {
    // `fetch` keeps its socket alive, so `close()` alone would never settle.
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
}

function rpcPost(port, endpoint, { rpcId = "r1", method, payload = {}, headers = {}, body } = {}) {
  return fetch(`http://127.0.0.1:${port}${SETTINGS_RPC_CHANNEL}/${endpoint}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: body ?? JSON.stringify({ type: "client-request", rpcId, method: method ?? endpoint, payload }),
  });
}

test("settings handler: returns a well-formed success envelope", async () => {
  await withServer(createSettingsHttpHandler(stubService()), async (port) => {
    const res = await rpcPost(port, "settings.get");
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body, { type: "server-response", rpcId: "r1", result: { ok: true, value: snapshot } });
  });
});

test("settings handler: failure envelopes always carry an object `details`", async () => {
  const service = stubService({ get: async () => { const e = new Error("nope"); e.code = "not-configured"; throw e; } });
  await withServer(createSettingsHttpHandler(service), async (port) => {
    const body = await (await rpcPost(port, "settings.get")).json();
    assert.equal(body.result.ok, false);
    assert.equal(body.result.error.code, "not-configured");
    assert.equal(typeof body.result.error.details, "object");
    assert.notEqual(body.result.error.details, null);
  });
});

test("settings handler: rejects non-POST with 404", async () => {
  await withServer(createSettingsHttpHandler(stubService()), async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}${SETTINGS_RPC_CHANNEL}/settings.get`);
    assert.equal(res.status, 404);
  });
});

test("settings handler: rejects a non-JSON content type with 415", async () => {
  await withServer(createSettingsHttpHandler(stubService()), async (port) => {
    const res = await rpcPost(port, "settings.get", { headers: { "content-type": "text/plain" } });
    assert.equal(res.status, 415);
  });
});

test("settings handler: rejects an unparsable body with 400", async () => {
  await withServer(createSettingsHttpHandler(stubService()), async (port) => {
    const res = await rpcPost(port, "settings.get", { body: "not json" });
    assert.equal(res.status, 400);
  });
});

test("settings handler: a method/endpoint mismatch is a bad-request envelope", async () => {
  await withServer(createSettingsHttpHandler(stubService()), async (port) => {
    const body = await (await rpcPost(port, "settings.get", { method: "settings.save" })).json();
    assert.equal(body.result.ok, false);
    assert.equal(body.result.error.code, "bad-request");
  });
});

test("settings handler: an unknown endpoint is a bad-request envelope", async () => {
  await withServer(createSettingsHttpHandler(stubService()), async (port) => {
    const body = await (await rpcPost(port, "settings.nope")).json();
    assert.equal(body.result.ok, false);
    assert.equal(body.result.error.code, "bad-request");
  });
});

test("settings handler: applies the host connection's request fence", async () => {
  const connection = { requestRejection: () => 401 };
  await withServer(createSettingsHttpHandler(stubService(), connection), async (port) => {
    const res = await rpcPost(port, "settings.get");
    assert.equal(res.status, 401);
    assert.equal(await res.text(), "unauthorized");
  });
});

// --- credential wiring ---------------------------------------------------
// Regression for a lazy `ctx.get("credentials")` that always resolved to
// undefined (`credentials` was missing from `inject`), which left the store
// unbuilt: every channel displayed "未配置凭据" and every pane save threw
// `not-configured`. These two tests pin both directions of the wiring.
function routeHandler(routes) {
  const route = routes.find((r) => r.path === SETTINGS_RPC_CHANNEL);
  assert.ok(route, "settings RPC route should be mounted");
  return route.handler;
}

test("apply wires the host credential store into the settings service", async () => {
  const { ctx, routes, store } = makeCtx();
  await apply(ctx, { channels: [] });
  await new Promise((r) => setImmediate(r));

  await withServer(routeHandler(routes), async (port) => {
    const saved = await (await rpcPost(port, "credentials.save", {
      payload: { channel: "feishu", values: { appId: "cli_9", appSecret: "sec_9" } },
    })).json();
    assert.equal(saved.result.ok, true, JSON.stringify(saved));

    // The pane's badge reads `credentials`; it must now reflect the store.
    const snap = await (await rpcPost(port, "settings.get")).json();
    assert.equal(snap.result.value.credentials.feishu, true);
    // Presence, not values: the snapshot crosses to the browser, so the secret
    // itself must not be in it (the save above still reached the right refs —
    // asserted against the store below).
    assert.deepEqual(snap.result.value.secrets.feishu, { appId: true, appSecret: true });
    assert.ok(!JSON.stringify(snap.result.value).includes("sec_9"));
  });

  // Secrets went to the credential store, keyed by ref — not to the config.
  assert.equal(store.get("DSH_CONNECT_FEISHU_APP_ID"), "cli_9");
  assert.equal(store.get("DSH_CONNECT_FEISHU_APP_SECRET"), "sec_9");
  assert.equal(store.get("DSH_CONNECT_TELEGRAM_BOT_TOKEN"), undefined);
});

test("without a credentials service the settings service degrades to not-configured", async () => {
  const { ctx, routes } = makeCtx({ withCredentials: false });
  await apply(ctx, { channels: [] });
  await new Promise((r) => setImmediate(r));

  await withServer(routeHandler(routes), async (port) => {
    const body = await (await rpcPost(port, "credentials.save", {
      payload: { channel: "feishu", values: { appSecret: "sec" } },
    })).json();
    assert.equal(body.result.ok, false);
    assert.equal(body.result.error.code, "not-configured");
  });
});
