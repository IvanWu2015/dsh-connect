import { test } from "node:test";
import assert from "node:assert/strict";

import { WebAdapter } from "../lib/index.js";

/** Minimal BindingStore stand-in covering the API the WebAdapter touches. */
class MockBindingStore {
  constructor() {
    this.bindings = new Map();
    this.listeners = new Set();
  }
  get(channel, chatKey) {
    return this.bindings.get(`${channel}\u0000${chatKey}`);
  }
  put(binding) {
    const key = `${binding.channel}\u0000${binding.chatKey}`;
    const existed = this.bindings.has(key);
    this.bindings.set(key, binding);
    for (const listener of this.listeners) {
      listener(binding, existed ? "update" : "add");
    }
  }
  onChange(callback) {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }
  list() {
    return [...this.bindings.values()];
  }
}

function makeBinding(overrides = {}) {
  return {
    channel: "feishu",
    chatKey: "chat-1",
    chatType: "p2p",
    sessionId: "session-1",
    ownerKey: "user-1",
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
    webMirrorSessionId: "session-1",
    sessions: [],
    ...overrides,
  };
}

test("start and stop run cleanly", async () => {
  const store = new MockBindingStore();
  const adapter = new WebAdapter(store, { pollIntervalMs: 100 });
  await adapter.start();
  await adapter.stop();
});

test("records newly detected mirror sessions", async () => {
  const store = new MockBindingStore();
  const adapter = new WebAdapter(store, { pollIntervalMs: 100 });
  await adapter.start();
  store.put(makeBinding({ webMirrorSessionId: "session-abc" }));
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(adapter.isSessionMirrored("session-abc"), true);
  assert.equal(adapter.isSessionMirrored("nope"), false);
  await adapter.stop();
});

test("getMirrorSource returns channel:chatKey of the source chat", async () => {
  const store = new MockBindingStore();
  const adapter = new WebAdapter(store, { pollIntervalMs: 100 });
  await adapter.start();
  store.put(makeBinding({ chatKey: "chat-789", webMirrorSessionId: "session-123" }));
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(adapter.getMirrorSource("session-123"), "feishu:chat-789");
  await adapter.stop();
});

test("does NOT synthesize inbound messages for new mirrors (regression: spurious web runners burned LLM turns)", async () => {
  const store = new MockBindingStore();
  const adapter = new WebAdapter(store, { pollIntervalMs: 100 });
  const received = [];
  adapter.onInbound((msg) => received.push(msg));
  await adapter.start();
  store.put(makeBinding({ webMirrorSessionId: "session-xyz" }));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(received.length, 0);
  await adapter.stop();
});

test("outbound methods are contract-satisfying no-ops", async () => {
  const store = new MockBindingStore();
  const adapter = new WebAdapter(store, { pollIntervalMs: 100 });
  await adapter.start();
  await adapter.sendText({ chatKey: "session-1", chatType: "p2p" }, "hello");
  await adapter.sendCard({ chatKey: "session-1", chatType: "p2p" }, { markdown: "hi" });
  await adapter.streamText({ chatKey: "session-1", chatType: "p2p" }, (async function* () { yield "a"; yield "b"; })());
  const choice = await adapter.promptChoice({ chatKey: "session-1", chatType: "p2p" }, { title: "t", options: [{ id: "a", label: "A" }] });
  assert.equal(choice.choice, undefined);
  await adapter.closeMenu("m", "done");
  await adapter.stop();
});
