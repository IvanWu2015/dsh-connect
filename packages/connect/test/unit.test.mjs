import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseCommand, BindingStore, createAsyncQueue, summarizeTurn, messages, helpText, applyStreamChunk, applyToolCall, toolCallSummary, resolveConnectConfig, questionTextOf, decodeTextAnswer, classifyError, InboundDedup, retry, withOutboundRetry, isLockTimedOut, acquireLock, releaseLockState, lockCanWrite, DEFAULT_LOCK_TIMEOUT_MS, ReminderStore, parseRemindTime, formatRemindAt } from "../lib/index.js";
import { menuTitle, rootMenuSections, reasonLabel, goalPhaseLabel, listWorkspaces, menuRender } from "../lib/index.js";
import { MenuController } from "../lib/index.js";

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

test("BindingStore reports a failed write once, and says when it recovers", () => {
  // Same shape as the reminder test further down: aim the state dir at a path
  // that is a *file*, so `mkdirSync` throws the way a read-only or full disk
  // would. What is at stake is not this write — the binding is live in memory
  // either way — but the next boot, which resumes sessions from this file. A
  // silent failure there means every chat quietly starts over with no history.
  const dir = mkdtempSync(join(tmpdir(), "dsh-connect-binding-"));
  const notADir = join(dir, "occupied");
  const warnings = [];
  const logger = { warn: (...args) => warnings.push(args.join(" ")) };
  const binding = { channel: "feishu", chatKey: "oc_1", chatType: "p2p", sessionId: "s1", ownerKey: "ou_1", createdAt: 1, lastActiveAt: 2 };
  try {
    writeFileSync(notADir, "x");
    const store = new BindingStore(notADir, logger);
    store.put(binding);
    assert.equal(warnings.length, 1, `a failed write must be reported; got ${JSON.stringify(warnings)}`);
    assert.match(warnings[0], /cannot persist bindings/);
    // Still the truth in this process — that is why the write stays best-effort
    // rather than becoming a thrown error at every one of `put`'s call sites.
    assert.equal(store.get("feishu", "oc_1")?.sessionId, "s1");

    // `put` runs on the hot path of every message. One line per message would
    // bury the one line that matters: the state dir is unwritable, not the write.
    store.put({ ...binding, lastActiveAt: 3 });
    store.put({ ...binding, lastActiveAt: 4 });
    assert.equal(warnings.length, 1, "a persistent condition is one report, not one per call");

    // The condition ends: make the path a directory again.
    rmSync(notADir, { force: true });
    mkdirSync(notADir);
    store.put({ ...binding, lastActiveAt: 5 });
    assert.equal(warnings.length, 2, "recovery is worth a line — it is the other half of the report");
    assert.match(warnings[1], /working again/);
    // And "working again" is checked, not asserted by the message alone: a fresh
    // store over the same directory sees the writes that followed the recovery.
    assert.equal(new BindingStore(notADir).get("feishu", "oc_1")?.lastActiveAt, 5);
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

test("parseCommand recognizes /ps (append to running task)", () => {
  assert.deepEqual(parseCommand("/ps 补充一点"), { kind: "ps", text: "补充一点" });
  assert.deepEqual(parseCommand("/append note here"), { kind: "ps", text: "note here" });
  assert.deepEqual(parseCommand("/ps"), { kind: "ps", text: "" });
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

test("resolveConnectConfig defaults notifyLevel to result", () => {
  const defaults = resolveConnectConfig({});
  assert.equal(defaults.notifyLevel, "result");
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
  // Streaming status uses the tool name only (no running counter), so repeat
  // tool calls never log "tool #51" spam that grows the card.
  assert.equal(zh.toolCalling("pwsh", undefined), "🔧 调用工具 `pwsh`");
  assert.equal(en.toolCalling("pwsh", undefined), "🔧 Calling tool `pwsh`");
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
// ── mirror-lock state machine (A1) ────────────────────────────────────────

test("isLockTimedOut: no lock / fresh lock / expired lock", () => {
  assert.equal(isLockTimedOut({}), false);
  assert.equal(isLockTimedOut({ lockOwner: "feishu" }), false, "no acquiredAt is not timed out");
  const now = 1_000_000;
  assert.equal(isLockTimedOut({ lockOwner: "feishu", lockAcquiredAt: now - 1_000 }, now), false);
  assert.equal(isLockTimedOut({ lockOwner: "feishu", lockAcquiredAt: now - DEFAULT_LOCK_TIMEOUT_MS - 1 }, now), true);
  assert.equal(isLockTimedOut({ lockOwner: "feishu", lockAcquiredAt: now - 60_000, lockTimeoutMs: 30_000 }, now), true, "custom timeout respected");
});

test("canWrite: free, timed out, owner, foreign owner", () => {
  const now = 1_000_000;
  assert.equal(lockCanWrite({}, "web"), true, "no lock = free");
  assert.equal(lockCanWrite({ lockOwner: "feishu", lockAcquiredAt: now - 1 }, "web", now), false);
  assert.equal(lockCanWrite({ lockOwner: "feishu", lockAcquiredAt: now - 1 }, "feishu", now), true, "owner can write");
  assert.equal(lockCanWrite({ lockOwner: "feishu", lockAcquiredAt: now - DEFAULT_LOCK_TIMEOUT_MS - 1 }, "web", now), true, "timed-out lock = free");
});

test("acquireLock: free, renew, foreign-live, foreign-timed-out", () => {
  const now = 1_000_000;
  const base = { channel: "web", chatKey: "oc_1", chatType: "p2p", sessionId: "s1", ownerKey: "u1", createdAt: 1, lastActiveAt: 2, sessions: [] };
  const free = acquireLock(base, "web", now);
  assert.ok(free !== undefined);
  assert.equal(free.lockOwner, "web");
  assert.equal(free.lockAcquiredAt, now);

  const owned = acquireLock({ ...base, lockOwner: "web", lockAcquiredAt: now - 1 }, "web", now);
  assert.ok(owned !== undefined, "same owner renews");
  assert.equal(owned.lockAcquiredAt, now);

  assert.equal(acquireLock({ ...base, lockOwner: "feishu", lockAcquiredAt: now - 1 }, "web", now), undefined, "foreign live lock refuses");

  const expired = acquireLock({ ...base, lockOwner: "feishu", lockAcquiredAt: now - DEFAULT_LOCK_TIMEOUT_MS - 1 }, "web", now);
  assert.ok(expired !== undefined, "foreign timed-out lock is acquirable");
  assert.equal(expired.lockOwner, "web");
});

test("releaseLockState: clears owner, preserves queue and other fields", () => {
  const state = {
    channel: "feishu", chatKey: "oc_1", chatType: "p2p", sessionId: "s1", ownerKey: "u1",
    createdAt: 1, lastActiveAt: 2, lockOwner: "feishu", lockAcquiredAt: 100,
    queuedMessages: [{ text: "hi", senderKey: "u1", timestamp: 99, channel: "web" }],
    sessions: [],
  };
  const next = releaseLockState(state);
  assert.equal(next.lockOwner, undefined);
  assert.equal(next.lockAcquiredAt, undefined);
  assert.equal(next.sessionId, "s1", "non-lock fields preserved");
  assert.deepEqual(next.queuedMessages, state.queuedMessages, "queue preserved for the caller to drain");
});

test("queued messages keep their source channel through the binding store", () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-connect-test-"));
  try {
    const store = new BindingStore(dir);
    store.put({
      channel: "feishu", chatKey: "oc_1", chatType: "p2p", sessionId: "s1", ownerKey: "u1",
      createdAt: 1, lastActiveAt: 2, sessions: [],
      lockOwner: "feishu", lockAcquiredAt: 100,
      queuedMessages: [{ text: "hi", senderKey: "u1", timestamp: 99, channel: "web" }],
    });
    const reloaded = new BindingStore(dir);
    assert.equal(reloaded.get("feishu", "oc_1")?.queuedMessages?.[0]?.channel, "web");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── inbound dedup (A3) ────────────────────────────────────────────────────

test("InboundDedup drops re-delivered ids within the window", () => {
  const dedup = new InboundDedup(5 * 60_000);
  const now = 1_000_000;
  assert.equal(dedup.isDuplicate("feishu", "oc_1", "om_1", now), false, "first arrival is not a duplicate");
  assert.equal(dedup.isDuplicate("feishu", "oc_1", "om_1", now + 1), true, "same id re-delivered is a duplicate");
  assert.equal(dedup.isDuplicate("feishu", "oc_1", "om_2", now + 2), false, "different id is fresh");
  assert.equal(dedup.isDuplicate("feishu", "oc_2", "om_1", now + 3), false, "same id in another chat is fresh");
  assert.equal(dedup.isDuplicate("feishu", "oc_1", undefined, now + 4), false, "messages without an id are never deduped");
  assert.equal(dedup.isDuplicate("feishu", "oc_1", "", now + 5), false, "empty id is never deduped");
});

test("InboundDedup forgets ids after the window", () => {
  const dedup = new InboundDedup(10_000);
  const now = 1_000_000;
  assert.equal(dedup.isDuplicate("feishu", "oc_1", "om_1", now), false);
  assert.equal(dedup.isDuplicate("feishu", "oc_1", "om_1", now + 10_001), false, "expired id is fresh again");
});

// ── outbound retry (A2) ───────────────────────────────────────────────────

test("retry: succeeds immediately without extra attempts", async () => {
  let calls = 0;
  const value = await retry(async () => { calls += 1; return "ok"; }, { baseDelayMs: 1 });
  assert.equal(value, "ok");
  assert.equal(calls, 1);
});

test("retry: recovers from transient failures and gives up after attempts", async () => {
  let calls = 0;
  const flaky = await retry(async () => {
    calls += 1;
    if (calls < 3) throw new Error("ECONNRESET");
    return "recovered";
  }, { attempts: 3, baseDelayMs: 1, maxDelayMs: 5 });
  assert.equal(flaky, "recovered");
  assert.equal(calls, 3);

  let calls2 = 0;
  await assert.rejects(
    retry(async () => { calls2 += 1; throw new Error("boom"); }, { attempts: 3, baseDelayMs: 1, maxDelayMs: 5 }),
    /boom/,
  );
  assert.equal(calls2, 3, "permanent failure still uses all attempts");
});

test("retry: isTransient predicate skips non-transient errors", async () => {
  let calls = 0;
  await assert.rejects(
    retry(async () => { calls += 1; throw new Error("permission denied"); }, {
      attempts: 3, baseDelayMs: 1,
      isTransient: (e) => !String(e).includes("permission denied"),
    }),
    /permission denied/,
  );
  assert.equal(calls, 1, "non-transient error is not retried");
});

test("withOutboundRetry: retries deliveries, passes streamText/start/stop through", async () => {
  let sendCalls = 0;
  const raw = {
    id: "stub",
    start: async () => "started",
    stop: async () => "stopped",
    sendText: async () => { sendCalls += 1; if (sendCalls < 2) throw new Error("ECONNRESET"); },
    sendCard: async () => {},
    streamText: async () => "streamed",
    promptChoice: async () => ({ choice: "x", messageId: "m" }),
    closeMenu: async () => {},
    onInbound: () => {},
  };
  const wrapped = withOutboundRetry(raw, { attempts: 3, baseDelayMs: 1, maxDelayMs: 5 });
  assert.equal(wrapped.id, "stub");
  await wrapped.sendText({ chatKey: "c", chatType: "p2p" }, "hi");
  assert.equal(sendCalls, 2, "transient sendText failure retried");

  // streamText must NOT retry (a partially-streamed reply cannot be resumed).
  let streamCalls = 0;
  raw.streamText = async () => { streamCalls += 1; throw new Error("mid-stream"); };
  await assert.rejects(wrapped.streamText({ chatKey: "c", chatType: "p2p" }, []), /mid-stream/);
  assert.equal(streamCalls, 1, "streamText failure is not retried");

  assert.equal(await wrapped.start(), "started");
  assert.equal(await wrapped.stop(), "stopped");
});

test("withOutboundRetry forwards every optional member instead of dropping it", async () => {
  // The wrapper builds a fresh object literal, so an optional member it does not
  // name is *gone* from the adapter the service holds — and `service.ts` stores
  // the wrapped one. That is not hypothetical: `sendFile` went missing this way,
  // and because `runner.ts` uses `adapter.sendFile === undefined` as the
  // capability test, `/send <path>` silently degraded to sending the path as
  // text on every channel. Add an optional member to `ChannelAdapter` and it
  // must be forwarded here too; this test is what says so.
  const calls = [];
  const raw = {
    id: "stub",
    start: async () => {}, stop: async () => {}, onInbound: () => {},
    sendText: async () => {}, sendCard: async () => {},
    promptChoice: async () => ({ choice: "x", messageId: "m" }),
    closeMenu: async () => {}, streamText: async () => {},
    sendFile: async (target, filePath, opts) => { calls.push([target.chatKey, filePath, opts]); },
    connectionStatus: () => ({ state: "connected", reconnectAttempts: 2 }),
  };
  const wrapped = withOutboundRetry(raw, { attempts: 2, baseDelayMs: 1, maxDelayMs: 2 });

  assert.equal(wrapped.sendFile === undefined, false, "sendFile was dropped by the wrapper");
  assert.equal(wrapped.connectionStatus === undefined, false, "connectionStatus was dropped by the wrapper");

  // Not just present — wired to the real adapter, arguments intact.
  await wrapped.sendFile({ chatKey: "c", chatType: "p2p" }, "C:/tmp/a.txt", { filename: "a.txt" });
  assert.deepEqual(calls, [["c", "C:/tmp/a.txt", { filename: "a.txt" }]]);
  assert.deepEqual(wrapped.connectionStatus(), { state: "connected", reconnectAttempts: 2 });
});

test("a member the adapter omits is still omitted after wrapping", () => {
  // The other half of the contract: presence is the feature test, so a channel
  // with no probe must not acquire a stub one that answers `undefined` forever
  // — that would turn 「没有探针」 into 「探针说未知」 at every call site.
  const bare = {
    id: "bare",
    start: async () => {}, stop: async () => {}, onInbound: () => {},
    sendText: async () => {}, sendCard: async () => {},
    promptChoice: async () => ({ choice: "x", messageId: "m" }),
    closeMenu: async () => {}, streamText: async () => {},
  };
  const wrapped = withOutboundRetry(bare);
  assert.equal("sendFile" in wrapped, false);
  assert.equal("connectionStatus" in wrapped, false);
});

test("withOutboundRetry: optional members survive the wrap, and only when present", async () => {
  // This wrapper builds a fresh object literal, so any member it does not
  // explicitly forward is dropped from the adapter the service actually holds.
  // `sendFile` was lost this way, which made runner.ts's `adapter.sendFile ===
  // undefined` check always true and degraded `/send <path>` to sending the
  // path as text on every channel. Presence is itself the capability test, so
  // absence matters as much as presence.
  const sent = [];
  const raw = {
    id: "stub",
    start: async () => {},
    stop: async () => {},
    sendText: async () => {},
    sendCard: async () => {},
    streamText: async () => {},
    promptChoice: async () => ({ choice: undefined, messageId: "m" }),
    closeMenu: async () => {},
    onInbound: () => {},
    sendFile: async (target, filePath, options) => { sent.push([target.chatKey, filePath, options]); },
    connectionStatus: () => ({ state: "connected", attempts: 0 }),
  };
  const wrapped = withOutboundRetry(raw, { attempts: 1, baseDelayMs: 1 });

  assert.equal(typeof wrapped.sendFile, "function", "sendFile is forwarded");
  await wrapped.sendFile({ chatKey: "c", chatType: "p2p" }, "/tmp/a.txt", { filename: "a.txt" });
  assert.deepEqual(sent, [["c", "/tmp/a.txt", { filename: "a.txt" }]], "sendFile args are passed through");

  assert.equal(typeof wrapped.connectionStatus, "function", "connectionStatus is forwarded");
  assert.deepEqual(wrapped.connectionStatus(), { state: "connected", attempts: 0 });

  const bare = withOutboundRetry({ ...raw, sendFile: undefined, connectionStatus: undefined }, { attempts: 1 });
  assert.equal(bare.sendFile, undefined, "an adapter without sendFile stays without one");
  assert.equal(bare.connectionStatus, undefined, "an adapter without a probe stays without one");
});

// ── /export surface (A6) ──────────────────────────────────────────────────

test("parseCommand: /export accepts markdown; pdf falls back to markdown", () => {
  assert.deepEqual(parseCommand("/export"), { kind: "export" });
  assert.deepEqual(parseCommand("/export markdown"), { kind: "export", format: "markdown" });
  assert.deepEqual(parseCommand("/export md"), { kind: "export", format: "markdown" });
  assert.deepEqual(parseCommand("/export pdf"), { kind: "export", format: "markdown" });
});

test("helpText no longer advertises pdf export", () => {
  const zh = helpText(messages("zh"));
  const en = helpText(messages("en"));
  assert.ok(zh.includes("/export"), "zh help mentions /export");
  assert.ok(en.includes("/export"), "en help mentions /export");
  assert.ok(!zh.includes("pdf"), "zh help no longer advertises pdf");
  assert.ok(!en.includes("pdf"), "en help no longer advertises pdf");
});
// ── Stage B: /remind scheduler (B2) ─────────────────────────────────────

test("parseCommand: /remind, /send, /broadcast parse into typed commands", () => {
  assert.deepEqual(parseCommand("/remind 10分钟 喝水"), { kind: "remind", text: "10分钟 喝水" });
  assert.deepEqual(parseCommand("/remindme 14:30 开会"), { kind: "remind", text: "14:30 开会" });
  assert.deepEqual(parseCommand("/alert 2h 站起来"), { kind: "remind", text: "2h 站起来" });
  assert.deepEqual(parseCommand("/send notes.md"), { kind: "send", path: "notes.md" });
  assert.deepEqual(parseCommand("/file C:\\tmp\\a.png"), { kind: "send", path: "C:\\tmp\\a.png" });
  assert.deepEqual(parseCommand("/broadcast 全体注意"), { kind: "broadcast", text: "全体注意" });
  assert.deepEqual(parseCommand("/announce deploy ok"), { kind: "broadcast", text: "deploy ok" });
});

test("parseRemindTime handles relative minutes / hours / clock time", () => {
  const now = Date.parse("2026-01-01T12:00:00Z");
  assert.equal(parseRemindTime("10分钟", now), now + 10 * 60_000);
  assert.equal(parseRemindTime("10m", now), now + 10 * 60_000);
  assert.equal(parseRemindTime("10", now), now + 10 * 60_000);
  assert.equal(parseRemindTime("2小时", now), now + 2 * 3_600_000);
  assert.equal(parseRemindTime("2h", now), now + 2 * 3_600_000);
  // Clock time resolves against the LOCAL day: build a locally-constructed
  // "now" so the assertions hold in every host timezone.
  const base = new Date();
  base.setHours(12, 0, 0, 0);
  const atNow = base.getTime();
  const future = new Date(atNow);
  future.setHours(14, 30, 0, 0); // later today
  const past = new Date(atNow);
  past.setHours(9, 0, 0, 0); // earlier today → rolls to tomorrow
  past.setDate(past.getDate() + 1);
  assert.equal(parseRemindTime("14:30", atNow), future.getTime());
  assert.equal(parseRemindTime("09:00", atNow), past.getTime());
  // invalid
  assert.equal(parseRemindTime("", now), undefined);
  assert.equal(parseRemindTime("abc", now), undefined);
  assert.equal(parseRemindTime("0m", now), undefined);
  assert.equal(parseRemindTime("25:99", now), undefined);
});

test("formatRemindAt renders clock times and dates per language", () => {
  const due = new Date();
  due.setHours(14, 30, 0, 0);
  const now = new Date(due);
  now.setHours(12, 0, 0, 0);
  assert.ok(formatRemindAt(due.getTime(), "zh", now.getTime()).includes("14:30"), "zh same-day shows the time");
  assert.ok(formatRemindAt(due.getTime(), "en", now.getTime()).includes("14:30"), "en same-day shows the time");
  // A due time on another day includes the localized date + the time.
  const later = new Date(due);
  later.setDate(later.getDate() + 4);
  const rendered = formatRemindAt(later.getTime(), "en", now.getTime());
  assert.ok(rendered.includes("14:30"), "other-day render includes the time");
  const day = later.toLocaleDateString("en-US", { month: "numeric", day: "numeric" });
  assert.ok(rendered.includes(day), "other-day render includes the date");
});

test("ReminderStore add/list/due/markFired round-trips and persists across instances", () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-connect-remind-"));
  try {
    const store = new ReminderStore(dir);
    const { reminder: r, persisted } = store.add({ channel: "feishu", chatKey: "oc_1", chatType: "group", text: "喝水", dueAt: Date.now() + 60_000, ownerKey: "ou_1" });
    assert.equal(persisted, true, "a writable state dir persists");
    assert.equal(store.list().length, 1);
    assert.equal(store.listFor("feishu", "oc_1")[0].id, r.id);
    assert.equal(store.listFor("feishu", "oc_2").length, 0);
    assert.equal(store.due(Date.now() + 120_000).length, 1, "due window covers it");
    assert.equal(store.due(Date.now() + 30_000).length, 0, "not due yet");

    // Persistence: a fresh store over the same dir reloads the reminder.
    const reloaded = new ReminderStore(dir);
    assert.equal(reloaded.listFor("feishu", "oc_1")[0].id, r.id);

    // markFired removes it from the due set without deleting it.
    reloaded.markFired(r.id);
    assert.equal(reloaded.due(Date.now() + 120_000).length, 0);
    assert.equal(reloaded.list().length, 1, "fired reminder is retained in the store");
    assert.equal(reloaded.remove(r.id), true);
    assert.equal(reloaded.list().length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ReminderStore tolerates a corrupt store file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-connect-remind-"));
  try {
    const store = new ReminderStore(dir);
    store.add({ channel: "feishu", chatKey: "oc_1", chatType: "p2p", text: "x", dueAt: 1, ownerKey: "ou_1" });
    const fs = await import("node:fs");
    fs.writeFileSync(join(dir, "reminders.json"), "{not json");
    const reloaded = new ReminderStore(dir);
    assert.equal(reloaded.list().length, 0, "corrupt file starts empty");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ReminderStore reports a failed write instead of swallowing it", () => {
  // The reminder is live in memory either way, so the failure is not an error —
  // it is the second half of the outcome, and the caller cannot state it without
  // being told. Point the store at a path that is a *file*: `mkdirSync` and
  // `readFileSync` both throw, which is exactly a read-only or full state dir.
  const dir = mkdtempSync(join(tmpdir(), "dsh-connect-remind-"));
  const notADir = join(dir, "occupied");
  try {
    writeFileSync(notADir, "x");
    const store = new ReminderStore(notADir);
    const { reminder, persisted } = store.add({ channel: "feishu", chatKey: "oc_1", chatType: "p2p", text: "x", dueAt: 1, ownerKey: "ou_1" });
    assert.equal(persisted, false, "an unwritable store must say so");
    // The live list is still the truth: this reminder will fire this session.
    assert.equal(store.list().length, 1);
    assert.equal(store.due(2).length, 1);
    assert.equal(reminder.text, "x");
    // And it really is gone on restart — the reason the caller had to be told.
    assert.equal(new ReminderStore(notADir).list().length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("helpText advertises /remind, /send and /broadcast", () => {
  const zh = helpText(messages("zh"));
  const en = helpText(messages("en"));
  assert.ok(zh.includes("/remind"), "zh help mentions /remind");
  assert.ok(zh.includes("/send"), "zh help mentions /send");
  assert.ok(zh.includes("/broadcast"), "zh help mentions /broadcast");
  assert.ok(en.includes("/remind") && en.includes("/send") && en.includes("/broadcast"));
});

test("menuTitle maps every menu id to a localized title", () => {
  const zh = messages("zh");
  for (const id of ["root", "workspace", "chat", "settings", "model", "reasoning", "notify", "language", "progress"]) {
    assert.ok(menuTitle(id, zh).length > 0, `title for ${id}`);
  }
});

test("rootMenuSections groups workspace/chat in 1 col and task/system in 2 col", () => {
  const zh = messages("zh");
  const secs = rootMenuSections(zh);
  assert.equal(secs.length, 4);
  assert.equal(secs[0].columnsPerRow, 1);
  assert.equal(secs[2].columnsPerRow, 2);
  assert.ok(secs[1].ids.includes("chat"));
});

test("reasonLabel maps known reasons and falls back to unknown", () => {
  const zh = messages("zh");
  assert.equal(reasonLabel("completed", zh), zh.reasonCompleted);
  assert.equal(reasonLabel("bogus", zh), zh.reasonUnknown);
});

test("goalPhaseLabel maps phases and passes through unknown", () => {
  const zh = messages("zh");
  assert.equal(goalPhaseLabel("active", zh), zh.goalPhaseActive);
  assert.equal(goalPhaseLabel("custom", zh), "custom");
});

test("listWorkspaces dedupes ignoring trailing slashes and case", () => {
  const ws = listWorkspaces({
    workDir: "C:/a",
    currentDirLabel: "work",
    workspaces: ["c:/A", "C:\\a", "D:/b"],
    registry: { list: () => [{ path: "E:/c", title: "extra" }, { path: "C:/A", title: "dup" }] },
  });
  const paths = ws.map((w) => w.path);
  assert.ok(paths.includes("C:/a"));
  assert.ok(paths.includes("D:/b"));
  assert.ok(paths.includes("E:/c"));
  assert.equal(ws.filter((w) => w.path.toLowerCase().replace(/[\\/]+$/,"") === "c:/a").length, 1);
});

test("settings submenu routes each item to its own menu (no workspace collapse)", async () => {
  // Regression: a stale menu could route every settings item to the workspace
  // menu. The controller must expose the correct per-item menu ids.
  const t = messages("zh");
  const mc = new MenuController({ t });
  const items = await mc.menuItems("settings");
  const ids = items.map((i) => i.id);
  assert.deepEqual(ids, ["model", "reasoning", "notify", "progress", "language", "overview"]);
  // The language item navigates to the "language" submenu; progress to "progress".
  const lang = items.find((i) => i.id === "language");
  assert.ok(lang !== undefined, "settings has language item");
  assert.equal(lang.label, t.menuSettingsLanguage);
  const progress = items.find((i) => i.id === "progress");
  assert.ok(progress !== undefined, "settings has progress item");
});

test("language and progress submenus expose only their own options", async () => {
  const t = messages("zh");
  const mc = new MenuController({ t });
  assert.deepEqual((await mc.menuItems("language")).map((i) => i.id), ["lang:zh", "lang:en"]);
  const progress = await mc.menuItems("progress");
  assert.ok(progress.length >= 2, "progress presets present");
  assert.ok(progress.every((i) => i.id.startsWith("progress:")), "progress ids are scope-prefixed");
});

test("menuRender: only data-heavy menus use a dropdown, the rest stay buttons", () => {
  assert.equal(menuRender("model"), "dropdown");
  assert.equal(menuRender("chat"), "dropdown");
  assert.equal(menuRender("workspace"), "dropdown");
  // Settings/language/notify/progress must remain button grids — a full
  // submenu collapsing into a single closed select reads as an empty card.
  assert.equal(menuRender("settings"), "buttons");
  assert.equal(menuRender("language"), "buttons");
  assert.equal(menuRender("notify"), "buttons");
  assert.equal(menuRender("progress"), "buttons");
  assert.equal(menuRender("reasoning"), "buttons");
  assert.equal(menuRender("root"), "buttons");
});

// ---------------------------------------------------------------------------
// openMenu navigation
// ---------------------------------------------------------------------------

/**
 * `menuItems` builds each submenu; `openMenu` is what actually *routes* a tap,
 * and until now nothing called it. The four branches below are the whole of its
 * control flow, and two of them exist only because of failure modes seen in the
 * wild: a tap belonging to a card that has already been replaced (the
 * "此操作已失效" report) and a `back` that has to walk a stack rather than
 * remember one parent.
 *
 * The taps are scripted rather than derived from the rendered options on
 * purpose: a test that can only press buttons the previous render offered could
 * never press a stale one, which is exactly the case worth covering.
 */

/**
 * A `MenuHost` stand-in. `promptChoice` is the only adapter method these tests
 * reach, and it answers from a queue of scripted taps: each call records the
 * `(prompt, cardId)` it was asked with, pops the next tap, and hands back the
 * card it is editing. A drained queue answers `undefined` — the "user closed
 * the card" case — which is also what ends the recursion these tests drive.
 */
function menuHost(t, taps) {
  const prompts = [];
  const sent = [];
  const closed = [];
  const calls = { showStatus: 0, newChat: 0 };
  const target = { channel: "stub", chatKey: "chat-menu" };
  return {
    t,
    adapter: {
      async promptChoice(at, prompt, cardId) {
        prompts.push({ at, prompt, cardId });
        // A real adapter edits the card it was handed, so the id it reports
        // back is that same card — falling back to a new one only when there
        // was none, i.e. the menu was opened fresh.
        return { choice: taps.shift(), messageId: cardId ?? "card-1" };
      },
      async closeMenu(messageId, text) {
        closed.push({ messageId, text });
      },
      async sendText(at, text) {
        sent.push({ at, text });
      },
    },
    workDir: "",
    language: "en",
    bindings: { get: () => undefined },
    channel: "stub",
    chatKey: "chat-menu",
    notifyLevel: "result",
    progressTimeoutMs: 300_000,
    // No `llm` service: only the model submenu consults it, and these tests
    // never open that one.
    ctx: { get: () => undefined },
    prompts,
    sent,
    closed,
    calls,
    target,
    defaultSelection: () => ({ provider: "", model: "" }),
    listWorkspaces: () => [{ path: "C:/proj", title: "proj" }],
    menuTitle: (id) => menuTitle(id, t),
    rootMenuSections: () => rootMenuSections(t),
    async newChat() {
      calls.newChat += 1;
    },
    async showStatus() {
      calls.showStatus += 1;
    },
    async showTasks() {},
    async showHistory() {},
    async showGoals() {},
    async showSchedule() {},
    async showPlugins() {},
    async showSettings() {},
    async compact() {},
    async collectWorkdirSessions() {
      return [];
    },
    async switchTo() {},
    async confirmAction() {
      return false;
    },
    async setLanguage() {},
    async setReasoning() {},
    async setNotifyLevel() {},
    async setProgressTimeout() {},
    async setModel() {},
  };
}

const menuInbound = { channel: "stub", chatKey: "chat-menu", chatType: "p2p", senderKey: "u1", text: "/menu" };

test("openMenu: a tap from a stale card redraws the same menu on the same card", async () => {
  const t = messages("en");
  // "session:gone" is an id no root item has — the shape a tap carries when the
  // card it came from was already replaced by a redraw.
  const host = menuHost(t, ["session:gone", undefined]);
  await new MenuController(host).openMenu(host.target, menuInbound, "root");

  assert.equal(host.prompts.length, 2, "a stale tap must redraw the menu rather than be swallowed");
  const [first, second] = host.prompts;
  assert.equal(first.prompt.title, t.menuRoot);
  assert.equal(first.cardId, undefined, "the first render opens a fresh card");
  assert.equal(second.prompt.title, t.menuRoot, "the redraw must stay on the same menu");
  assert.deepEqual(second.prompt.options, first.prompt.options, "with the same options to choose from");
  assert.equal(second.cardId, "card-1", "and edit that card in place, not post a second one");
  assert.deepEqual(host.sent, [], "a stale tap must not invent an answer of its own");
  assert.equal(host.calls.showStatus, 0, "and must not fire any item it does not have");
  // The exit row is always last, and `back` is offered only when there is
  // somewhere to go back to — a root card showing "back" would be a dead end.
  assert.deepEqual(first.prompt.options.map((o) => o.id).at(-1), "menu:exit");
  assert.ok(
    !first.prompt.options.some((o) => o.id === "menu:back"),
    "the root menu has no parent to go back to",
  );
});

test("openMenu: exit closes the card with the closed notice", async () => {
  const t = messages("en");
  const host = menuHost(t, ["menu:exit"]);
  await new MenuController(host).openMenu(host.target, menuInbound, "root", [], "card-7");

  assert.deepEqual(host.closed, [{ messageId: "card-7", text: t.menuClosed }]);
  assert.equal(host.prompts.length, 1, "exit must not redraw anything after it");
  assert.deepEqual(host.sent, []);
});

test("openMenu: a leaf press reports its feedback, then returns to the root menu on the same card", async () => {
  const t = messages("en");
  const host = menuHost(t, ["dir:C:/proj", undefined]);
  await new MenuController(host).openMenu(host.target, menuInbound, "workspace", ["root"], "card-4");

  // The action itself ran…
  assert.equal(host.workDir, "C:/proj", "selecting a workspace must switch to it");
  assert.equal(host.calls.newChat, 1, "and start a new chat there");
  // …its feedback was delivered…
  assert.deepEqual(host.sent, [{ at: host.target, text: t.dirSwitched("C:/proj") }]);
  // …and the card came back to the root menu rather than staying on the
  // submenu the tap came from, so the user is not left one level deep.
  assert.equal(host.prompts.length, 2);
  assert.equal(host.prompts[1].prompt.title, t.menuRoot, "a leaf ends at the root menu, not at its parent");
  assert.equal(host.prompts[1].cardId, host.prompts[0].cardId, "on the card the tap came from");
  assert.ok(
    host.prompts[0].prompt.options.some((o) => o.id === "menu:back"),
    "a submenu opened with a stack must offer a way back",
  );
});

test("openMenu: back pops one level and keeps the stack below it", async () => {
  const t = messages("en");
  // `["settings", "root"]` is the stack the settings submenu opens with, so the
  // frames are [root, settings] and the first `back` must land on root — not on
  // settings, and not on an empty stack.
  const host = menuHost(t, ["menu:back", "menu:back", undefined]);
  await new MenuController(host).openMenu(host.target, menuInbound, "settings", ["settings", "root"], "card-9");

  assert.deepEqual(
    host.prompts.map((p) => p.prompt.title),
    [t.menuSettings, t.menuRoot, t.menuSettings],
    "back must walk one frame at a time, root → settings, not reset to the top or stop at the root",
  );
  // The intermediary frame is the load-bearing one: it proves the popped stack
  // was handed on (`["settings"]`, so root still offers `back`) instead of being
  // discarded along with the frame that was consumed.
  assert.ok(
    host.prompts[1].prompt.options.some((o) => o.id === "menu:back"),
    "the shortened stack must still offer a way back",
  );
  assert.equal(host.prompts[1].cardId, "card-9", "every frame of the walk edits the one card");
  assert.deepEqual(host.sent, [], "navigation alone never posts a message");
});

