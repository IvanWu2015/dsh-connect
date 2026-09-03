import { test } from "node:test";
import assert from "node:assert/strict";

import {
  signDingtalk,
  verifyDingtalkSignature,
  DingtalkWebhook,
  encodeFrame,
  decodeFrames,
  escapeHeader,
  unescapeHeader,
  normalizeBotMessage,
  isAtMentioned,
  buildConnectBody,
  buildTextReplyBody,
  buildMarkdownReplyBody,
} from "../lib/channels/dingtalk/index.js";

test("signDingtalk produces a stable HMAC-SHA256 base64 signature", () => {
  const a = signDingtalk("SEC123", 1700000000000);
  const b = signDingtalk("SEC123", 1700000000000);
  assert.equal(a, b);
  assert.ok(a.length > 20);
  assert.notEqual(a, signDingtalk("SEC456", 1700000000000));
  assert.notEqual(a, signDingtalk("SEC123", 1700000000001));
});

test("verifyDingtalkSignature accepts a matching fresh signature and rejects others", () => {
  const secret = "SECabc";
  const ts = "1700000000000";
  const good = signDingtalk(secret, Number(ts));
  assert.equal(verifyDingtalkSignature(secret, ts, good, Number(ts)), true);
  assert.equal(verifyDingtalkSignature(secret, ts, "tampered", Number(ts)), false);
  assert.equal(verifyDingtalkSignature("SECother", ts, good, Number(ts)), false);
});

test("verifyDingtalkSignature compares URL-decoded values (regression: + vs %2B mismatch)", () => {
  const secret = "SEC+abc/def=";
  const ts = "1700000000000";
  const encoded = signDingtalk(secret, Number(ts)); // encodeURIComponent form
  // Simulate a sender that encoded the base64 with a different-but-equivalent
  // encoding (raw '+' vs '%2B'); both decode to the same bytes.
  const raw = decodeURIComponent(encoded);
  const reEncoded = raw.replace(/\+/g, "%2B");
  assert.notEqual(encoded, reEncoded);
  assert.equal(verifyDingtalkSignature(secret, ts, reEncoded, Number(ts)), true);
});

test("verifyDingtalkSignature rejects stale timestamps (replay guard)", () => {
  const secret = "SECabc";
  const ts = "1700000000000";
  const good = signDingtalk(secret, Number(ts));
  // 10 minutes in the future from the claimed timestamp: outside the 5-min window.
  assert.equal(verifyDingtalkSignature(secret, ts, good, Number(ts) + 10 * 60_000), false);
  assert.equal(verifyDingtalkSignature(secret, "not-a-number", good, Number(ts)), false);
});

test("DingtalkWebhook requires an https:// webhookUrl", () => {
  assert.throws(() => new DingtalkWebhook({ webhookUrl: "http://oapi.dingtalk.com/robot/send?access_token=x" }));
  assert.throws(() => new DingtalkWebhook({ webhookUrl: "not-a-url" }));
  assert.doesNotThrow(() => new DingtalkWebhook({ webhookUrl: "https://oapi.dingtalk.com/robot/send?access_token=x" }));
});

test("DingtalkWebhook.send builds a signed URL and posts markdown JSON", async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
    return { ok: true, status: 200, json: async () => ({ errcode: 0, errmsg: "ok" }) };
  };

  try {
    const webhook = new DingtalkWebhook({
      webhookUrl: "https://oapi.dingtalk.com/robot/send?access_token=abc",
      secret: "SECs",
    });
    const result = await webhook.sendMarkdown("标题", "**正文**", { mobiles: ["13800000000"], all: false });
    assert.deepEqual(result, { errcode: 0, errmsg: "ok" });
    assert.equal(calls.length, 1);
    const call = calls[0];
    assert.ok(call.url.startsWith("https://oapi.dingtalk.com/robot/send?access_token=abc&timestamp="));
    assert.ok(call.url.includes("&sign="));
    const body = call.body;
    assert.equal(body.msgtype, "markdown");
    assert.equal(body.markdown.title, "标题");
    assert.equal(body.markdown.text, "**正文**");
    assert.deepEqual(body.at.atMobiles, ["13800000000"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("DingtalkWebhook.sendText posts a text body without at when omitted", async () => {
  const originalFetch = globalThis.fetch;
  let captured;
  globalThis.fetch = async (_input, init) => {
    captured = JSON.parse(String(init?.body));
    return { ok: true, status: 200, json: async () => ({ errcode: 0, errmsg: "ok" }) };
  };
  try {
    const webhook = new DingtalkWebhook({ webhookUrl: "https://oapi.dingtalk.com/robot/send?access_token=abc" });
    await webhook.sendText("hello");
    assert.equal(captured.msgtype, "text");
    assert.equal(captured.text.content, "hello");
    assert.equal(captured.at, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("DingtalkWebhook truncates markdown bodies past 20000 chars", async () => {
  const originalFetch = globalThis.fetch;
  let captured;
  globalThis.fetch = async (_input, init) => {
    captured = JSON.parse(String(init?.body));
    return { ok: true, status: 200, json: async () => ({ errcode: 0, errmsg: "ok" }) };
  };
  try {
    const webhook = new DingtalkWebhook({ webhookUrl: "https://oapi.dingtalk.com/robot/send?access_token=abc" });
    await webhook.sendMarkdown("长文", "x".repeat(25_000));
    assert.ok(captured.markdown.text.length < 21_000);
    assert.ok(captured.markdown.text.endsWith("…(已截断)"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("DingtalkWebhook retries transient network failures", async () => {
  const originalFetch = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts += 1;
    if (attempts === 1) throw new TypeError("fetch failed");
    return { ok: true, status: 200, json: async () => ({ errcode: 0, errmsg: "ok" }) };
  };
  try {
    const webhook = new DingtalkWebhook({ webhookUrl: "https://oapi.dingtalk.com/robot/send?access_token=abc", retryDelaysMs: [1, 1] });
    const result = await webhook.sendText("retry me");
    assert.deepEqual(result, { errcode: 0, errmsg: "ok" });
    assert.ok(attempts >= 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("DingtalkWebhook retries the 130101 frequency limit", async () => {
  const originalFetch = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts += 1;
    if (attempts < 3) return { ok: true, status: 200, json: async () => ({ errcode: 130101, errmsg: "send too fast" }) };
    return { ok: true, status: 200, json: async () => ({ errcode: 0, errmsg: "ok" }) };
  };
  try {
    const webhook = new DingtalkWebhook({ webhookUrl: "https://oapi.dingtalk.com/robot/send?access_token=abc", rateLimitDelayMs: 1 });
    const result = await webhook.sendText("rate limited");
    assert.deepEqual(result, { errcode: 0, errmsg: "ok" });
    assert.equal(attempts, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("DingtalkWebhook surfaces non-retryable DingTalk business errors", async () => {
  const originalFetch = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts += 1;
    return { ok: true, status: 200, json: async () => ({ errcode: 310000, errmsg: "keywords not in content" }) };
  };
  try {
    const webhook = new DingtalkWebhook({ webhookUrl: "https://oapi.dingtalk.com/robot/send?access_token=abc" });
    await assert.rejects(() => webhook.sendText("boom"), /310000/);
    assert.equal(attempts, 1); // no retry for non-transient errors
  } finally {
    globalThis.fetch = originalFetch;
  }
});
// ── Stage B: STOMP codec (B1) ───────────────────────────────────────────

test("STOMP encodeFrame round-trips through decodeFrames", () => {
  const frame = encodeFrame("SEND", { destination: "/v1.0/im/bot/messages/reply", "content-type": "application/json" }, "{\"a\":1}");
  const { frames, rest } = decodeFrames(frame);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].command, "SEND");
  assert.equal(frames[0].headers.destination, "/v1.0/im/bot/messages/reply");
  assert.equal(frames[0].headers["content-type"], "application/json");
  assert.equal(frames[0].body, "{\"a\":1}");
  assert.equal(rest, "");
});

test("STOMP decodeFrames handles header escaping (colon, newline, backslash)", () => {
  const frame = encodeFrame("MESSAGE", { "message-id": "a:b", note: "line\\nbreak" }, "body");
  const { frames } = decodeFrames(frame);
  assert.equal(frames[0].headers["message-id"], "a:b");
  assert.equal(frames[0].headers.note, "line\\nbreak");
  assert.equal(escapeHeader("a:b\\c\n"), "a\\cb\\\\c\\n");
  assert.equal(unescapeHeader("a\\cb\\\\c\\n"), "a:b\\c\n");
});

test("STOMP decodeFrames splits multiple frames and skips heartbeats", () => {
  const a = encodeFrame("CONNECTED", { version: "1.2" });
  const b = encodeFrame("MESSAGE", { destination: "/x" }, "hello");
  const { frames, rest } = decodeFrames(a + "\n" + b);
  assert.equal(frames.length, 2);
  assert.equal(frames[0].command, "CONNECTED");
  assert.equal(frames[1].command, "MESSAGE");
  assert.equal(frames[1].body, "hello");
  assert.equal(rest, "");
});

test("STOMP decodeFrames keeps partial frames in rest and continues later", () => {
  const frame = encodeFrame("MESSAGE", { destination: "/x" }, "partial body");
  const half = Math.floor(frame.length / 2);
  const first = decodeFrames(frame.slice(0, half));
  assert.equal(first.frames.length, 0);
  assert.ok(first.rest.length > 0, "partial frame is buffered");
  const second = decodeFrames(first.rest + frame.slice(half));
  assert.equal(second.frames.length, 1);
  assert.equal(second.frames[0].body, "partial body");
});

// ── Stage B: message normalization + reply bodies (B1) ──────────────────

test("normalizeBotMessage maps gateway payloads to InboundMessage", () => {
  const p2p = normalizeBotMessage({
    senderStaffId: "staff_1",
    conversationId: "cid_1",
    conversationType: "1",
    msgId: "msg_1",
    msgType: "text",
    text: { content: "hello" },
  });
  assert.deepEqual(p2p, {
    channel: "dingtalk",
    chatKey: "cid_1",
    chatType: "p2p",
    senderKey: "staff_1",
    text: "hello",
    replyRef: "msg_1",
  });
  const group = normalizeBotMessage({
    senderStaffId: "staff_2",
    conversationId: "cid_2",
    conversationType: "2",
    msgId: "msg_2",
    msgType: "text",
    text: { content: "@bot 任务" },
    isInAtList: true,
  });
  assert.equal(group.chatType, "group");
  assert.equal(group.text, "@bot 任务");
});

test("normalizeBotMessage drops unroutable payloads", () => {
  assert.equal(normalizeBotMessage({}), undefined);
  assert.equal(normalizeBotMessage({ conversationId: "cid", senderStaffId: "" }), undefined);
  // Non-text messages carry no usable text body but still route (empty text).
  const pic = normalizeBotMessage({ senderStaffId: "s", conversationId: "c", conversationType: "1", msgType: "picture" });
  assert.equal(pic.text, "");
  assert.equal(pic.chatKey, "c");
});

test("isAtMentioned gates group messages", () => {
  assert.equal(isAtMentioned({ isInAtList: true }), true);
  assert.equal(isAtMentioned({}), false);
  assert.equal(isAtMentioned({ isInAtList: false }), false);
});

test("reply body builders emit the DingTalk msgKey envelope", () => {
  assert.deepEqual(JSON.parse(buildTextReplyBody("m1", "hi")), {
    msgKey: "sampleText",
    msgParam: { content: "hi" },
    msgId: "m1",
  });
  assert.deepEqual(JSON.parse(buildMarkdownReplyBody("m2", "T", "**x**")), {
    msgKey: "sampleMarkdown",
    msgParam: { title: "T", text: "**x**" },
    msgId: "m2",
  });
  assert.deepEqual(JSON.parse(buildConnectBody("cid", "sec")), {
    clientId: "cid",
    clientSecret: "sec",
    protocolVersion: "1.0",
  });
});
