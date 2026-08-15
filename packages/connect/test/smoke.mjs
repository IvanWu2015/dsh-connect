/**
 * Runtime smoke test: load both plugins into a real Cordis context and verify
 * the plugin contract (Service registration, adapter registry, authorization,
 * proactive notify) without any network or model access.
 *
 * Lives under packages/connect so `@deepseek-ai/cordis` (a package devDependency)
 * resolves through the package's node_modules.
 */
import assert from "node:assert/strict";
import { Context } from "@deepseek-ai/cordis";
import * as connect from "../lib/index.js";
import * as feishu from "../../connect-feishu/lib/index.js";

// ── cordis plugin contract (compile-time exports are mirrored at runtime) ──
assert.equal(connect.name, "connect");
assert.deepEqual(connect.inject, ["agents", "sessions", "agentDefaultModel"]);
assert.equal(typeof connect.apply, "function");
assert.equal(typeof connect.ConnectService, "function");

assert.equal(feishu.name, "connect-feishu");
assert.deepEqual(feishu.inject, ["connect"]);
assert.equal(typeof feishu.apply, "function");
assert.equal(typeof feishu.FeishuAdapter, "function");

// ── load the core into a fresh root context ──
const ctx = new Context();
ctx.provide("agents", {});
ctx.provide("sessions", {});
ctx.provide("agentDefaultModel", { currentSelection: () => ({ provider: "p", model: "m" }) });

connect.apply(ctx, { allowUsers: ["u1"], allowChats: ["c1"] });

const service = ctx.get("connect");
assert.ok(service, "ctx.connect service must be registered");
assert.equal(typeof service.registerAdapter, "function");
assert.equal(typeof service.handleInbound, "function");
assert.equal(typeof service.notify, "function");

// ── authorization ──
const allowed = { channel: "stub", chatKey: "c1", chatType: "p2p", senderKey: "u1", text: "hi" };
assert.equal(service.isAllowed(allowed), true);
assert.equal(service.isAllowed({ ...allowed, chatKey: "c2" }), false);
assert.equal(service.isAllowed({ ...allowed, senderKey: "u9" }), false);

// a service with empty allowlists allows everyone
const openCtx = new Context();
openCtx.provide("agents", {});
openCtx.provide("sessions", {});
openCtx.provide("agentDefaultModel", { currentSelection: () => ({ provider: "p", model: "m" }) });
connect.apply(openCtx, {});
const openService = openCtx.get("connect");
assert.equal(openService.isAllowed({ channel: "feishu", chatKey: "any", chatType: "p2p", senderKey: "any", text: "x" }), true, "empty allowlists default to allow");

// ── adapter registry ──
const adapter = {
  id: "stub",
  start: async () => {},
  stop: async () => {},
  sendText: async () => {},
  sendCard: async () => {},
  streamText: async () => {},
  promptChoice: async () => ({ choice: undefined, messageId: "stub-msg" }),
  closeMenu: async () => {},
  onInbound: () => {},
};
service.registerAdapter(adapter);
assert.equal(service.getAdapter("stub"), adapter);
assert.throws(() => service.registerAdapter(adapter), /already registered/);

// ── proactive notify reaches the adapter ──
let sent;
adapter.sendText = async (target, text) => {
  sent = { target, text };
};
await service.notify("stub", "c1", "p2p", "任务完成");
assert.ok(sent, "notify must call the adapter");
assert.equal(sent.text, "任务完成");
assert.equal(sent.target.chatKey, "c1");

// ── feishu adapter constructs (without connecting) ──
process.env.FEISHU_APP_ID = "cli_test";
process.env.FEISHU_APP_SECRET = "secret_test";
const feishuAdapter = new feishu.FeishuAdapter({ requireMention: true });
assert.equal(feishuAdapter.id, "feishu");
assert.throws(
  () => new feishu.FeishuAdapter({ appId: "", appSecret: "" }),
  /appId and appSecret are required/,
);

console.log("SMOKE OK: connect service + feishu adapter contract verified");
