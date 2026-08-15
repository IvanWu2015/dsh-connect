import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseCommand, BindingStore, createAsyncQueue, summarizeTurn } from "../lib/index.js";

test("parseCommand passes through plain messages", () => {
  assert.deepEqual(parseCommand("帮我跑测试"), { kind: "message", text: "帮我跑测试" });
  assert.deepEqual(parseCommand("  leading spaces  "), { kind: "message", text: "leading spaces" });
});

test("parseCommand recognizes every control command", () => {
  assert.deepEqual(parseCommand("/new"), { kind: "new" });
  assert.deepEqual(parseCommand("/reset"), { kind: "new" });
  assert.deepEqual(parseCommand("/clear"), { kind: "clear" });
  assert.deepEqual(parseCommand("/stop"), { kind: "stop" });
  assert.deepEqual(parseCommand("/cancel"), { kind: "stop" });
  assert.deepEqual(parseCommand("/status"), { kind: "status" });
  assert.deepEqual(parseCommand("/task"), { kind: "task" });
  assert.deepEqual(parseCommand("/tasks"), { kind: "task" });
  assert.deepEqual(parseCommand("/dir"), { kind: "dir" });
  assert.deepEqual(parseCommand("/dir D:\\projects\\x"), { kind: "dir", path: "D:\\projects\\x" });
  assert.deepEqual(parseCommand("/dir D:\\projects\\my app"), { kind: "dir", path: "D:\\projects\\my app" });
  assert.deepEqual(parseCommand("/cd"), { kind: "dir" });
  assert.deepEqual(parseCommand("/chat"), { kind: "chat" });
  assert.deepEqual(parseCommand("/sessions"), { kind: "chat" });
  assert.deepEqual(parseCommand("/help"), { kind: "help" });
});

test("BindingStore put/get/delete round-trips", () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-connect-test-"));
  try {
    const store = new BindingStore(dir);
    store.put({ channel: "feishu", chatKey: "oc_1", chatType: "group", sessionId: "s1", ownerKey: "ou_1", createdAt: 1, lastActiveAt: 2 });
    assert.equal(store.get("feishu", "oc_1")?.sessionId, "s1");
    assert.equal(store.get("feishu", "oc_2"), undefined);

    // Persistence: a fresh store over the same dir reloads the binding.
    const reloaded = new BindingStore(dir);
    assert.equal(reloaded.get("feishu", "oc_1")?.sessionId, "s1");

    store.delete("feishu", "oc_1");
    assert.equal(store.get("feishu", "oc_1"), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("createAsyncQueue delivers items in order then ends", async () => {
  const queue = createAsyncQueue();
  const received = [];
  const consumer = (async () => {
    for await (const chunk of queue) received.push(chunk);
  })();

  queue.push("a");
  queue.push("b");
  queue.end();
  queue.push("c"); // dropped after end
  await consumer;

  assert.deepEqual(received, ["a", "b"]);
});

test("summarizeTurn derives a completed outcome", () => {
  const events = [
    { seq: 0, type: "turn/start", data: { turn: 1 } },
    { seq: 1, type: "assistant/message", data: { turn: 1, step: 1, message: { content: [{ type: "text", text: "hello" }] } } },
    { seq: 2, type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } },
  ];
  const outcome = summarizeTurn(events, 0);
  assert.equal(outcome.reason, "completed");
  assert.equal(outcome.text, "hello");
  assert.equal(outcome.code, undefined);
});

test("summarizeTurn derives an error outcome and ignores seed", () => {
  const events = [
    { seq: 0, type: "assistant/message", data: { turn: 0, step: 1, message: { content: [{ type: "text", text: "seed text" }] } } },
    { seq: 1, type: "turn/start", data: { turn: 1 } },
    { seq: 2, type: "turn/end", data: { turn: 1, reason: { kind: "error", error: { code: "X", message: "boom" } } } },
  ];
  const outcome = summarizeTurn(events, 1);
  assert.equal(outcome.reason, "error");
  assert.equal(outcome.code, "X");
  assert.equal(outcome.message, "boom");
  assert.equal(outcome.text, "");
});
