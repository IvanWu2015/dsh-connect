import { test } from "node:test";
import assert from "node:assert/strict";

import { activateChannels, CHANNELS, injectSecrets } from "../lib/channels.js";

function fakeCtx(log = []) {
  return { logger: { warn: (m) => log.push(m) } };
}

test("default activates every built-in channel", () => {
  const calls = [];
  const log = [];
  const channels = Object.fromEntries(CHANNELS.map((n) => [n, (ctx, cfg) => calls.push({ n, cfg })]));
  const started = activateChannels(fakeCtx(log), undefined, channels);
  assert.deepEqual(started, [...CHANNELS]);
  assert.equal(calls.length, CHANNELS.length);
  assert.deepEqual(log, []);
});

test("channels[] activates only the requested subset", () => {
  const calls = [];
  const channels = Object.fromEntries(CHANNELS.map((n) => [n, (ctx, cfg) => calls.push(n)]));
  const started = activateChannels(fakeCtx(), { channels: ["feishu", "dingtalk"] }, channels);
  assert.deepEqual(started, ["feishu", "dingtalk"]);
  assert.deepEqual(calls, ["feishu", "dingtalk"]);
});

test("unknown channel is skipped with a warning", () => {
  const log = [];
  const channels = { feishu: () => {} };
  const started = activateChannels(fakeCtx(log), { channels: ["feishu", "slack"] }, channels);
  assert.deepEqual(started, ["feishu"]);
  assert.ok(log.some((m) => m.includes("unknown channel ") && m.includes("slack")));
});

test("a throwing channel does not stop the others", () => {
  const log = [];
  const calls = [];
  const channels = {
    feishu: () => { throw new Error("boom"); },
    telegram: (ctx, cfg) => calls.push("telegram"),
  };
  const started = activateChannels(fakeCtx(log), { channels: ["feishu", "telegram"] }, channels);
  assert.deepEqual(started, ["telegram"]);
  assert.deepEqual(calls, ["telegram"]);
  assert.ok(log.some((m) => m.includes("feishu") && m.includes("failed to start")));
});

test("per-channel config slice is forwarded to each adapter", () => {
  const seen = {};
  const channels = {
    feishu: (ctx, cfg) => { seen.feishu = cfg; },
    telegram: (ctx, cfg) => { seen.telegram = cfg; },
  };
  activateChannels(fakeCtx(), { channels: ["feishu", "telegram"], feishu: { appId: "x" }, telegram: {} }, channels);
  assert.deepEqual(seen.feishu, { appId: "x" });
  assert.deepEqual(seen.telegram, {});
});
test("channelDefaults seeds every channel; per-channel config wins", () => {
  const seen = {};
  const channels = {
    feishu: (ctx, cfg) => { seen.feishu = cfg; },
    telegram: (ctx, cfg) => { seen.telegram = cfg; },
  };
  activateChannels(fakeCtx(), {
    channels: ["feishu", "telegram"],
    channelDefaults: { language: "en" },
    feishu: { appId: "x" },
    telegram: { language: "zh" },
  }, channels);
  assert.deepEqual(seen.feishu, { language: "en", appId: "x" });
  assert.deepEqual(seen.telegram, { language: "zh" });
});
test("injectSecrets merges store secrets into enabled channels (store wins)", async () => {
  const getSecrets = async (name) => (name === "feishu" ? { appId: "store_id", appSecret: "store_sec" } : {});
  const out = await injectSecrets({ channels: ["feishu"], feishu: { appId: "cfg_id" } }, CHANNELS, getSecrets);
  // the store is the source of truth: it overrides the config for the same key
  assert.equal(out.feishu.appId, "store_id");
  assert.equal(out.feishu.appSecret, "store_sec");
  // channels with no stored secrets are left absent
  assert.equal(out.telegram, undefined);
});

test("injectSecrets does not mutate the caller config", async () => {
  const input = { channels: ["feishu"] };
  const getSecrets = async () => ({ appId: "x" });
  const out = await injectSecrets(input, CHANNELS, getSecrets);
  assert.notEqual(out, input);
  assert.equal(input.feishu, undefined);
  assert.equal(out.feishu.appId, "x");
});

test("injectSecrets nests dingtalk stream secrets under stream without mutating caller", async () => {
  const input = { channels: ["dingtalk"], dingtalk: { language: "zh", stream: { url: "wss://x" } } };
  const getSecrets = async () => ({
    webhookUrl: "https://oapi.dingtalk.com/webhook",
    secret: "SEC",
    clientId: "cid",
    clientSecret: "csec",
  });
  const out = await injectSecrets(input, CHANNELS, getSecrets);
  // flat webhook creds stay at the root; stream creds land under config.stream
  assert.equal(out.dingtalk.webhookUrl, "https://oapi.dingtalk.com/webhook");
  assert.equal(out.dingtalk.secret, "SEC");
  assert.deepEqual(out.dingtalk.stream, { url: "wss://x", clientId: "cid", clientSecret: "csec" });
  // caller config untouched (stream.url preserved on the original, not mutated)
  assert.deepEqual(input.dingtalk.stream, { url: "wss://x" });
  assert.equal(input.dingtalk.clientId, undefined);
});