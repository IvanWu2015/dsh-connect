import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseCommand, BindingStore, createAsyncQueue, summarizeTurn, messages, helpText, applyStreamChunk, applyToolCall, toolCallSummary, resolveConnectConfig, questionTextOf, decodeTextAnswer, classifyError } from "../lib/index.js";

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

test("messages switches between zh and en", () => {
  const zh = messages("zh");
  const en = messages("en");
  assert.equal(zh.menuRoot, "主菜单");
  assert.equal(en.menuRoot, "Main menu");
  assert.equal(zh.newChatDone, "已开启新会话。");
  assert.equal(en.newChatDone, "New conversation started.");
  // Interpolating helpers pick the active table too.
  assert.equal(zh.dirSwitched("D:\\x"), "已切换到工作区：\nD:\\x\n（已开启新会话）");
  assert.equal(en.dirSwitched("D:\\x"), "Switched to workspace:\nD:\\x\n(new conversation started)");
});

test("helpText renders in the selected language", () => {
  assert.match(helpText(messages("zh")), /可用命令/);
  assert.match(helpText(messages("en")), /Available commands/);
  assert.doesNotMatch(helpText(messages("en")), /[\u4e00-\u9fff]/);
});

/** Drive {@link applyStreamChunk} over a sequence and collect the pushed queue. */
function streamChunks(chunks) {
  const received = [];
  const state = {
    chunks: { push: (text) => received.push(text) },
    lastText: "",
    reasoning: false,
    hintPushed: false,
    lastIndex: undefined,
    pushedAny: false,
    lastPushAt: 0,
  };
  for (const chunk of chunks) applyStreamChunk(state, "🤔 深度思考中…\n\n", chunk);
  return { received, state };
}

test("applyStreamChunk keeps a single-line text stream intact", () => {
  const { received, state } = streamChunks([
    { type: "text-delta", index: 1, text: "Hello" },
    { type: "text-delta", index: 1, text: " world" },
  ]);
  assert.deepEqual(received, ["Hello", " world"]);
  assert.equal(state.lastText, "Hello world");
  assert.equal(state.reasoning, false);
});

test("applyStreamChunk inserts a thinking hint once and expands reasoning breaks", () => {
  const { received, state } = streamChunks([
    { type: "reasoning-delta", index: 0, text: "first" },
    { type: "reasoning-delta", index: 0, text: ".\nsecond" },
    { type: "reasoning-delta", index: 0, text: ".\r\nthird" },
    { type: "reasoning-delta", index: 0, text: "" },
  ]);
  assert.deepEqual(received, [
    "🤔 深度思考中…\n\n",
    "first",
    ".\n\nsecond",
    ".\n\nthird",
  ]);
  assert.equal(state.lastText, ""); // reasoning never feeds lastText
  assert.equal(state.hintPushed, true);
});

test("applyStreamChunk keeps existing paragraph breaks at exactly two newlines", () => {
  const { received } = streamChunks([
    { type: "reasoning-delta", index: 0, text: "a.\n\nb" },
    { type: "reasoning-delta", index: 0, text: "\n\n\nc" },
  ]);
  assert.deepEqual(received, ["🤔 深度思考中…\n\n", "a.\n\nb", "\n\nc"]);
});

test("applyStreamChunk normalizes reasoning delivered via block-end too", () => {
  const { received } = streamChunks([
    { type: "block-end", index: 0, block: { type: "reasoning", text: "line1\nline2" } },
  ]);
  assert.deepEqual(received, ["🤔 深度思考中…\n\n", "line1\n\nline2"]);
});

test("applyStreamChunk separates blocks and the reasoning phase from the answer", () => {
  const { received } = streamChunks([
    { type: "reasoning-delta", index: 0, text: "think" },
    { type: "block-end", index: 0, block: { type: "reasoning", text: "think" } }, // already streamed → skipped
    { type: "text-delta", index: 1, text: "answer" },
    { type: "text-delta", index: 2, text: "second block" },
  ]);
  assert.deepEqual(received, [
    "🤔 深度思考中…\n\n",
    "think",
    "\n\n", // reasoning → answer
    "answer",
    "\n\n", // block 1 → block 2
    "second block",
  ]);
});

test("applyStreamChunk falls back to block-end text for blocks without deltas", () => {
  const { received, state } = streamChunks([
    { type: "block-start", index: 0, blockType: "text" },
    { type: "block-end", index: 0, block: { type: "text", text: "whole block" } },
    { type: "block-end", index: 1, block: { type: "text", text: "tail" } },
  ]);
  assert.deepEqual(received, ["whole block", "\n\n", "tail"]);
  assert.equal(state.lastText, "whole blocktail");
});

test("applyStreamChunk skips duplicate block-end after streamed deltas", () => {
  const { received } = streamChunks([
    { type: "text-delta", index: 1, text: "streamed" },
    { type: "block-end", index: 1, block: { type: "text", text: "streamed" } },
  ]);
  assert.deepEqual(received, ["streamed"]);
});

test("applyToolCall inserts a status line, ends reasoning, and resets the block index", () => {
  const received = [];
  const state = {
    chunks: { push: (text) => received.push(text) },
    lastText: "answer",
    reasoning: true,
    hintPushed: true,
    lastIndex: 2,
    pushedAny: true,
    lastPushAt: 0,
  };
  applyToolCall(state, "🔧 调用工具 `pwsh` — Analyze recent events");
  assert.deepEqual(received, ["\n\n🔧 调用工具 `pwsh` — Analyze recent events\n\n"]);
  assert.equal(state.reasoning, false);
  assert.equal(state.lastIndex, undefined);
  assert.equal(state.pushedAny, true);
  assert.ok(state.lastPushAt > 0);
});

test("toolCallSummary extracts description from tool arguments", () => {
  assert.equal(
    toolCallSummary('{"command": "ls", "description": "List files in current directory"}'),
    "List files in current directory",
  );
  assert.equal(toolCallSummary('{"file_path": "D:\\\\a\\\\very\\\\long\\\\path\\\\that\\\\exceeds\\\\the\\\\sixty\\\\character\\\\summary\\\\limit\\\\file.txt"}').length, 61);
  assert.equal(toolCallSummary("not json"), undefined);
  assert.equal(toolCallSummary(undefined), undefined);
  assert.equal(toolCallSummary('{"command": "ls"}'), undefined);
  // Whitespace is folded to one line so multi-line descriptions stay tidy.
  assert.equal(toolCallSummary('{"description": "Run a command\\n  with extra   spaces"}'), "Run a command with extra spaces");
});

test("messages expose tool-call and heartbeat strings in both languages", () => {
  const zh = messages("zh");
  const en = messages("en");
  assert.equal(zh.toolCalling("pwsh", "分析事件"), "🔧 调用工具 `pwsh` — 分析事件");
  assert.equal(zh.toolCalling("pwsh", undefined), "🔧 调用工具 `pwsh`");
  assert.equal(en.processingHeartbeat(2), "⏳ Still processing (~2 min)…");
  assert.equal(zh.processingHeartbeat(2), "⏳ 仍在处理中（已运行约 2 分钟）…");
});

test("applyStreamChunk with level=important streams only the hint, not reasoning", () => {
  const received = [];
  const state = {
    chunks: { push: (text) => received.push(text) },
    lastText: "",
    reasoning: false,
    hintPushed: false,
    lastIndex: undefined,
    pushedAny: false,
    lastPushAt: 0,
  };
  applyStreamChunk(state, "🤔 深度思考中…\n\n", { type: "reasoning-delta", index: 0, text: "secret reasoning" }, "important");
  applyStreamChunk(state, "🤔 深度思考中…\n\n", { type: "reasoning-delta", index: 0, text: "more" }, "important");
  applyStreamChunk(state, "🤔 深度思考中…\n\n", { type: "block-end", index: 0, block: { type: "reasoning", text: "full reasoning" } }, "important");
  applyStreamChunk(state, "🤔 深度思考中…\n\n", { type: "text-delta", index: 1, text: "answer" }, "important");
  assert.deepEqual(received, ["🤔 深度思考中…\n\n", "answer"]);
  assert.equal(state.lastText, "answer");
});

test("applyStreamChunk with level=result streams only the answer", () => {
  const received = [];
  const state = {
    chunks: { push: (text) => received.push(text) },
    lastText: "",
    reasoning: false,
    hintPushed: false,
    lastIndex: undefined,
    pushedAny: false,
    lastPushAt: 0,
  };
  applyStreamChunk(state, "🤔 深度思考中…\n\n", { type: "reasoning-delta", index: 0, text: "secret" }, "result");
  applyStreamChunk(state, "🤔 深度思考中…\n\n", { type: "block-end", index: 0, block: { type: "reasoning", text: "secret" } }, "result");
  applyStreamChunk(state, "🤔 深度思考中…\n\n", { type: "text-delta", index: 1, text: "answer" }, "result");
  assert.deepEqual(received, ["answer"]);
});

test("summarizeTurn collects model, tokens, context window, steps and duration", () => {
  const events = [
    { seq: 0, time: 1000, type: "turn/start", data: { turn: 1 } },
    { seq: 1, time: 1001, type: "step/start", data: { turn: 1, step: 1 } },
    { seq: 2, time: 1002, type: "request/context", data: { provider: "deepseek-official", model: "deepseek-v4-pro", contextWindow: 1000000 } },
    { seq: 3, time: 1003, type: "assistant/message", data: { turn: 1, step: 1, message: { content: [{ type: "text", text: "hi" }] }, usage: { inputTokens: 12000, outputTokens: 300, cacheReadTokens: 8000 } } },
    { seq: 4, time: 1004, type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } },
  ];
  const outcome = summarizeTurn(events, 0);
  assert.equal(outcome.model, "deepseek-official/deepseek-v4-pro");
  assert.equal(outcome.inputTokens, 12000);
  assert.equal(outcome.outputTokens, 300);
  assert.equal(outcome.cacheReadTokens, 8000);
  assert.equal(outcome.contextSize, 12000);
  assert.equal(outcome.contextWindow, 1000000);
  assert.equal(outcome.steps, 1);
  assert.equal(outcome.elapsedMs, 4);
});

test("parseCommand recognizes /notify", () => {
  assert.deepEqual(parseCommand("/notify"), { kind: "notify" });
  assert.deepEqual(parseCommand("/notice"), { kind: "notify" });
});

test("parseCommand recognizes /progress", () => {
  assert.deepEqual(parseCommand("/progress"), { kind: "progress" });
  assert.deepEqual(parseCommand("/remind-interval"), { kind: "progress" });
  assert.deepEqual(parseCommand("/progress 5"), { kind: "progress" });
});

test("messages expose notification levels and task stats in both languages", () => {
  const zh = messages("zh");
  const en = messages("en");
  assert.equal(zh.notifyFull, "尽量输出过程");
  assert.equal(en.notifyImportant, "Key milestones");
  assert.equal(zh.notifySet("只输出结果", "只在任务结束后发送最终结果"), "通知级别已设置为：只输出结果\n只在任务结束后发送最终结果");
  assert.equal(en.taskStatsHeader("1 分 5 秒"), "📊 Task done · took 1 分 5 秒");
  assert.equal(zh.taskDuration(65000), "1 分 5 秒");
  assert.equal(en.taskDuration(65000), "1m 5s");
  assert.equal(en.taskStatsTokensIn("12,000", "8,000"), "Input: 12,000 tokens (cached 8,000)");
  assert.equal(zh.taskStatsCompactSuggest, "⚠️ 上下文占用较高，建议发送 /compact 压缩上下文");
});

test("resolveConnectConfig defaults notifyLevel to important", () => {
  const defaults = resolveConnectConfig({});
  assert.equal(defaults.notifyLevel, "important");
  assert.equal(defaults.streamHeartbeatMs, 60000);
  assert.equal(defaults.progressTimeoutMs, 300000);
  const explicit = resolveConnectConfig({ notifyLevel: "full" });
  assert.equal(explicit.notifyLevel, "full");
  const noProgress = resolveConnectConfig({ progressTimeoutMs: 0 });
  assert.equal(noProgress.progressTimeoutMs, 0);
});

test("questionTextOf extracts the first ask_user_question question", () => {
  assert.equal(
    questionTextOf('{"questions": [{"id": "a", "question": "选哪个方案？", "options": [{"label": "A"}]}]}'),
    "选哪个方案？",
  );
  assert.equal(questionTextOf('{"questions": []}'), "");
  assert.equal(questionTextOf("not json"), "");
  assert.equal(questionTextOf(undefined), "");
  // Whitespace is folded and long questions are truncated.
  const long = `{"questions": [{"id": "a", "question": "${"很长的".repeat(40)}"}]}`;
  assert.ok(questionTextOf(long).length <= 61);
});

test("decodeTextAnswer maps labels, numbers, and free text", () => {
  const q = { id: "a", question: "?", options: [{ label: "方案A" }, { label: "方案B" }, { label: "方案C" }] };
  assert.deepEqual(decodeTextAnswer(q, "方案B"), { selected: ["方案B"] });
  assert.deepEqual(decodeTextAnswer(q, "2"), { selected: ["方案B"] });
  assert.deepEqual(decodeTextAnswer(q, "  3  "), { selected: ["方案C"] });
  assert.deepEqual(decodeTextAnswer(q, "自定义内容"), { selected: [], custom: "自定义内容" });
  const multi = { ...q, multiSelect: true };
  assert.deepEqual(decodeTextAnswer(multi, "1,3"), { selected: ["方案A", "方案C"] });
  assert.deepEqual(decodeTextAnswer(multi, "方案A、方案C"), { selected: ["方案A", "方案C"] });
  // A question without options is answered by free text.
  assert.deepEqual(decodeTextAnswer({ id: "b", question: "?" }, "任意回复"), { selected: [], custom: "任意回复" });
});

test("classifyError buckets errors into actionable advice categories", () => {
  assert.equal(classifyError("HTTP 403 Forbidden: no permission to access resource"), "permission");
  assert.equal(classifyError("EACCES: permission denied, open 'D:\\x\\file'"), "permission");
  assert.equal(classifyError("sandbox: file access denied under workspace-write mode"), "permission");
  assert.equal(classifyError("timeout of 15000ms exceeded"), "network");
  assert.equal(classifyError("connect ECONNREFUSED 127.0.0.1:3080"), "network");
  assert.equal(classifyError("getaddrinfo ENOTFOUND open.feishu.cn"), "network");
  assert.equal(classifyError("fetch failed: self-signed certificate"), "network");
  assert.equal(classifyError("model unavailable: deepseek-v4-pro has no active adapter"), "model");
  assert.equal(classifyError("quota exceeded: insufficient balance"), "model");
  assert.equal(classifyError("Request failed with status code 429"), "model");
  assert.equal(classifyError("some random failure"), "generic");
  assert.equal(classifyError(""), "generic");
});

test("messages expose welcome / confirm / error-advice / progress strings in both languages", () => {
  const zh = messages("zh");
  const en = messages("en");
  assert.ok(zh.welcomeBody("D:\\work").includes("D:\\work"));
  assert.ok(en.welcomeBody("/tmp").includes("/tmp"));
  assert.equal(zh.confirmYes, "✅ 确认");
  assert.equal(en.confirmNo, "↩️ Cancel");
  assert.equal(zh.toolStepLabel(2, "pwsh"), "🔧 第 2 次工具调用 `pwsh`");
  assert.equal(en.toolStepLabel(2, "pwsh"), "🔧 Tool call #2: `pwsh`");
  assert.equal(zh.queuedHint(3), "（还有 3 条消息排队中）");
  assert.equal(en.queuedHint(3), "(3 more message(s) queued)");
  assert.ok(zh.processingFailedAdvice("boom", zh.errorAdviceNetwork).includes("网络"));
  assert.ok(en.processingFailedAdvice("boom", en.errorAdviceModel).includes("quota"));
  assert.ok(zh.errorAdvicePermission.includes("权限"));
  assert.ok(zh.approvalDone("allowed-once", "pwsh").includes("同意"));
  assert.ok(zh.approvalDone("rejected", "pwsh").includes("拒绝"));
  assert.ok(zh.approvalStale.includes("已失效"));
  assert.ok(zh.questionStale.includes("已失效"));
  assert.ok(en.approvalDone("allowed-once", "pwsh").includes("Approved"));
  assert.ok(en.approvalStale.includes("no longer active"));
});
