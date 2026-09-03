import { test } from "node:test";
import assert from "node:assert/strict";

import { callRpc, loadSettings, saveSettings, saveCredentials, loadStatus, RpcError } from "../lib/settings/rpc-client.js";

test("callRpc unwraps an ok envelope", async () => {
  const res = await callRpc(async () => ({ ok: true, value: "hello" }), "settings.get", {});
  assert.equal(res, "hello");
});

test("callRpc throws RpcError on failure", async () => {
  await assert.rejects(
    callRpc(async () => ({ ok: false, error: { code: "credential-missing", message: "credential-missing" } }), "settings.get", {}),
    (e) => e instanceof RpcError && e.code === "credential-missing",
  );
});

test("callRpc defaults error code to settings-failed", async () => {
  await assert.rejects(
    callRpc(async () => ({ ok: false, error: undefined }), "settings.get", {}),
    (e) => e instanceof RpcError && e.code === "settings-failed",
  );
});

test("loadSettings calls settings.get with empty payload", async () => {
  const calls = [];
  await loadSettings(async (ep, payload) => { calls.push([ep, payload]); return { ok: true, value: { config: {} } }; });
  assert.deepEqual(calls, [["settings.get", {}]]);
});

test("saveSettings calls settings.save with the config", async () => {
  const calls = [];
  await saveSettings(async (ep, payload) => { calls.push([ep, payload]); return { ok: true, value: { config: payload } }; }, { channels: ["web"] });
  assert.deepEqual(calls, [["settings.save", { channels: ["web"] }]]);
});

test("loadStatus calls settings.status", async () => {
  const calls = [];
  await loadStatus(async (ep) => { calls.push(ep); return { ok: true, value: {} }; });
  assert.deepEqual(calls, ["settings.status"]);
});

test("saveCredentials calls credentials.save with channel and values", async () => {
  const calls = [];
  await saveCredentials(async (ep, payload) => { calls.push([ep, payload]); return { ok: true, value: {} }; }, "feishu", { appSecret: "sec" });
  assert.deepEqual(calls, [["credentials.save", { channel: "feishu", values: { appSecret: "sec" } }]]);
});