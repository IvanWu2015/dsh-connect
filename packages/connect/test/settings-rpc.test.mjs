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

test("installSettingsRpc no-ops without a host rpc handle", () => {
  const dispose = installSettingsRpc({}, { service: { get: async () => snapshot, save: async () => snapshot, status: async () => snapshot } });
  assert.equal(typeof dispose, "function");
});

test("installSettingsRpc registers the channel when rpc.handle exists", () => {
  const calls = [];
  const ctx = { connection: { rpc: { handle: (channel, handler, opts) => { calls.push({ channel, handler, opts }); return () => {}; } } } };
  const dispose = installSettingsRpc(ctx, { service: { get: async () => snapshot, save: async () => snapshot, status: async () => snapshot } });
  assert.equal(typeof dispose, "function");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].channel, SETTINGS_RPC_CHANNEL);
  assert.deepEqual(calls[0].opts, { authority: "loopback" });
  assert.equal(typeof calls[0].handler, "function");
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