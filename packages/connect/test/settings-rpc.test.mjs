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

// --- onboarding ------------------------------------------------------------

const waiting = { phase: "waiting", channel: "feishu", link: { url: "https://open.feishu.cn/x", expiresInSeconds: 600, expiresAt: 1 } };

test("onboarding.start dispatches the channel to the service", async () => {
  const calls = [];
  const service = {
    get: async () => snapshot, save: async () => snapshot, status: async () => snapshot,
    onboardingStart: async (ch) => { calls.push(ch); return waiting; },
  };
  const handler = createSettingsRpcHandler(service);
  const res = await handler("onboarding.start", { channel: "feishu" }, undefined);
  assert.deepEqual(res, { ok: true, value: waiting });
  assert.deepEqual(calls, ["feishu"]);
});

test("onboarding.start answers with the link, not with a result", async () => {
  // The whole start/poll split in one assertion: `ok: true` here means "the
  // flow is running and here is the link", and nothing more. A handler that
  // awaited the flow would hold the response open for ten minutes and lose the
  // link to the abort below.
  const service = {
    get: async () => snapshot, save: async () => snapshot, status: async () => snapshot,
    onboardingStart: async () => waiting,
  };
  const handler = createSettingsRpcHandler(service);
  const res = await handler("onboarding.start", { channel: "feishu" }, undefined);
  assert.equal(res.value.phase, "waiting");
  assert.equal(res.value.outcome, undefined, "a link is not an outcome");
});

test("onboarding.start rejects payload shapes it cannot dispatch", async () => {
  const service = {
    get: async () => snapshot, save: async () => snapshot, status: async () => snapshot,
    onboardingStart: async () => waiting,
  };
  const handler = createSettingsRpcHandler(service);
  // Empty, no channel, wrong type, empty string. The *value* is the service's
  // to judge (`invalid-channel`) — this is shape only, the same posture
  // `credentials.save` takes.
  for (const payload of [{}, { channel: 42 }, { channel: "" }, { channel: null }]) {
    const res = await handler("onboarding.start", payload, undefined);
    assert.equal(res.ok, false, `${JSON.stringify(payload)} should not dispatch`);
    assert.equal(res.error.code, "bad-request");
  }
});

test("onboarding.status and cancel carry no payload", async () => {
  const seen = [];
  const service = {
    get: async () => snapshot, save: async () => snapshot, status: async () => snapshot,
    onboardingStatus: async () => { seen.push("status"); return waiting; },
    onboardingCancel: async () => { seen.push("cancel"); return { phase: "cancelled", channel: "feishu" }; },
  };
  const handler = createSettingsRpcHandler(service);
  assert.equal((await handler("onboarding.status", {}, undefined)).ok, true);
  assert.equal((await handler("onboarding.cancel", {}, undefined)).ok, true);
  assert.deepEqual(seen, ["status", "cancel"]);
  const bad = await handler("onboarding.status", { channel: "feishu" }, undefined);
  assert.equal(bad.error.code, "bad-request", "a read that takes no payload must reject one");
});

test("an unwired onboarding registry reports unsupported on all three", async () => {
  const service = { get: async () => snapshot, save: async () => snapshot, status: async () => snapshot };
  const handler = createSettingsRpcHandler(service);
  for (const [endpoint, payload] of [["onboarding.start", { channel: "feishu" }], ["onboarding.status", {}], ["onboarding.cancel", {}]]) {
    const res = await handler(endpoint, payload, undefined);
    assert.equal(res.ok, false, endpoint);
    assert.equal(res.error.code, "unsupported", endpoint);
  }
});

test("a service's own invalid-channel reaches the browser verbatim", async () => {
  const service = {
    get: async () => snapshot, save: async () => snapshot, status: async () => snapshot,
    onboardingStart: async () => { const err = new Error("invalid-channel"); err.code = "invalid-channel"; throw err; },
  };
  const handler = createSettingsRpcHandler(service);
  const res = await handler("onboarding.start", { channel: "telegram" }, undefined);
  assert.equal(res.error.code, "invalid-channel");
});

test("the handler's abort signal is never wired into the flow", async () => {
  // 铁律. The settings HTTP handler aborts this request the moment the browser
  // navigates away or re-renders (`res.on("close")`), and the
  // device-authorization link is single-use and single-person — a page refresh
  // would silently burn the user's only link. So `start` must answer at once,
  // the flow must outlive the request that started it, and the signal must
  // reach *nothing*: `onboardingStartP` passes only the channel, so there is no
  // parameter for one to travel down. If anyone ever wires it in, this goes red.
  const aborter = new AbortController();
  const args = [];
  let alive = true;
  const flowState = { phase: "waiting", channel: "feishu", link: waiting.link };
  const service = {
    get: async () => snapshot, save: async () => snapshot, status: async () => snapshot,
    onboardingStart: async (...received) => { args.push(received); return flowState; },
    onboardingStatus: async () => (alive ? flowState : { phase: "cancelled", channel: "feishu" }),
    onboardingCancel: async () => { alive = false; return { phase: "cancelled", channel: "feishu" }; },
  };
  const handler = createSettingsRpcHandler(service);

  const answered = await handler("onboarding.start", { channel: "feishu" }, aborter.signal);
  assert.equal(answered.ok, true);
  assert.equal(answered.value.phase, "waiting");
  // Exactly one argument: the channel. A signal in the signature would be a
  // second one, and that is the change this test exists to catch.
  assert.deepEqual(args, [["feishu"]]);

  // The browser goes away mid-run, exactly as `res.on("close")` does.
  aborter.abort();

  // The user reloads and polls again — a new request, so a new (live) signal.
  const reload = new AbortController();
  const after = await handler("onboarding.status", {}, reload.signal);
  assert.equal(after.ok, true, "a poll from the reloaded page must still be served");
  assert.equal(after.value.phase, "waiting", "the flow must outlive the request that started it");
  assert.equal(after.value.link.url, waiting.link.url, "and the same link must come back, unburnt");
  alive = false;
  assert.deepEqual(await handler("onboarding.cancel", {}, reload.signal), { ok: true, value: { phase: "cancelled", channel: "feishu" } }, "cancel still works from the new page");
});