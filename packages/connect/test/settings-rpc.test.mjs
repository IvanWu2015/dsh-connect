import { test } from "node:test";
import assert from "node:assert/strict";

import {
  SETTINGS_RPC_CHANNEL,
  createSettingsRpcHandler,
  installSettingsRpc,
} from "../lib/settings/settings-rpc.js";

const snapshot = { config: { channels: ["feishu"] }, enabled: ["feishu"], credentials: { feishu: true } };

test("settings.get returns an ok envelope with the snapshot", async () => {
  const service = { get: async () => snapshot, save: async () => snapshot, status: async () => snapshot };
  const handler = createSettingsRpcHandler(service);
  const res = await handler("settings.get", {}, undefined);
  assert.deepEqual(res, { ok: true, value: snapshot });
});

test("settings.save forwards the payload config", async () => {
  const saved = [];
  const service = { get: async () => snapshot, save: async (c) => { saved.push(c); return snapshot; }, status: async () => snapshot };
  const handler = createSettingsRpcHandler(service);
  await handler("settings.save", { channels: ["telegram"] }, undefined);
  assert.deepEqual(saved, [{ channels: ["telegram"] }]);
});

test("unknown endpoint -> bad-request", async () => {
  const handler = createSettingsRpcHandler({ get: async () => snapshot, save: async () => snapshot, status: async () => snapshot });
  const res = await handler("settings.destroy", {}, undefined);
  assert.equal(res.ok, false);
  assert.equal(res.error.code, "bad-request");
});

test("non-empty payload on settings.get -> bad-request", async () => {
  const handler = createSettingsRpcHandler({ get: async () => snapshot, save: async () => snapshot, status: async () => snapshot });
  const res = await handler("settings.get", { lang: "en" }, undefined);
  assert.equal(res.ok, false);
  assert.equal(res.error.code, "bad-request");
});

test("empty payload on settings.save -> bad-request", async () => {
  const handler = createSettingsRpcHandler({ get: async () => snapshot, save: async () => snapshot, status: async () => snapshot });
  const res = await handler("settings.save", {}, undefined);
  assert.equal(res.ok, false);
  assert.equal(res.error.code, "bad-request");
});

test("aborted signal -> cancelled", async () => {
  const handler = createSettingsRpcHandler({ get: async () => snapshot, save: async () => snapshot, status: async () => snapshot });
  const res = await handler("settings.get", {}, { aborted: true });
  assert.deepEqual(res, { ok: false, error: { code: "cancelled", message: "Request cancelled." } });
});

test("service throw -> settings-failed envelope", async () => {
  const handler = createSettingsRpcHandler({ get: async () => { throw new Error("boom"); }, save: async () => snapshot, status: async () => snapshot });
  const res = await handler("settings.get", {}, undefined);
  assert.equal(res.ok, false);
  assert.equal(res.error.code, "settings-failed");
});

test("installSettingsRpc no-ops without a webServer", () => {
  const dispose = installSettingsRpc({}, { service: { get: async () => snapshot, save: async () => snapshot, status: async () => snapshot } });
  assert.equal(typeof dispose, "function");
});

// The channel is mounted on `webServer` directly, NOT through the host's
// `connection.rpc.handle`: that helper is context-tracked and resolves
// `webServer` against the connection service's own construction fiber, so it
// throws `cannot get property "webServer" without inject` for a third-party
// channel and the route is never mounted.
test("installSettingsRpc mounts a prefix route on webServer", () => {
  const routes = [];
  const ctx = { webServer: { register: (route) => { routes.push(route); return () => { routes.pop(); }; } } };
  const dispose = installSettingsRpc(ctx, { service: { get: async () => snapshot, save: async () => snapshot, status: async () => snapshot } });
  assert.equal(typeof dispose, "function");
  assert.equal(routes.length, 1);
  assert.equal(routes[0].kind, "prefix");
  assert.equal(routes[0].path, SETTINGS_RPC_CHANNEL);
  assert.equal(typeof routes[0].handler, "function");
  dispose();
  assert.equal(routes.length, 0);
});
test("credentials.save dispatches channel+values to the service", async () => {
  const calls = [];
  const service = { get: async () => snapshot, save: async () => snapshot, saveCredentials: async (ch, v) => { calls.push([ch, v]); return snapshot; }, status: async () => snapshot };
  const handler = createSettingsRpcHandler(service);
  const res = await handler("credentials.save", { channel: "feishu", values: { appSecret: "sec" } }, undefined);
  assert.equal(res.ok, true);
  assert.deepEqual(calls, [["feishu", { appSecret: "sec" }]]);
});

test("credentials.save rejects a payload missing values", async () => {
  const service = { get: async () => snapshot, save: async () => snapshot, saveCredentials: async () => snapshot, status: async () => snapshot };
  const handler = createSettingsRpcHandler(service);
  const res = await handler("credentials.save", { channel: "feishu" }, undefined);
  assert.equal(res.ok, false);
  assert.equal(res.error.code, "bad-request");
});

test("credentials.save returns unsupported when the service lacks it", async () => {
  const service = { get: async () => snapshot, save: async () => snapshot, status: async () => snapshot };
  const handler = createSettingsRpcHandler(service);
  const res = await handler("credentials.save", { channel: "feishu", values: { appSecret: "sec" } }, undefined);
  assert.equal(res.ok, false);
  assert.equal(res.error.code, "unsupported");
});