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
  DingtalkStreamAdapter,
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

// ── Adapter: the message / binding path ──────────────────────────────────
//
// The STOMP codec above is well covered; the adapter that consumes it is not.
// These tests drive `dispatch` — the single entry the stream client feeds —
// plus the outbound senders, with the stream client replaced by a recorder.
//
// `dispatch` is where the shape the *core* binds on is decided: `chatKey`
// picks the runner and `replyRef` keys both dedup and the reply threading, so
// the assertions below are about values rather than "something came through".
//
// The adapter's constructor builds a real `DingtalkStreamClient`, but that
// client stays inert until `connect()` — no socket is opened — and `client` is
// `private readonly` at the type level only. Swapping it before the first
// `dispatch` therefore keeps this suite network-free. It is also *required*
// for the outbound tests: `stream.ts`'s `sendReply` throws when the socket is
// not open, which is the state a never-connected adapter is in.

/**
 * Build an adapter whose stream client is a recorder.
 *
 * Pass the test context as `t` whenever the test may leave a menu pending: an
 * unanswered `promptChoice` holds a 60 s `setTimeout`, and node:test keeps the
 * process alive for it — one leaked timer turns the suite from ~1 s into a
 * minute of dead waiting. The hook below clears whatever is still outstanding.
 */
function makeAdapter({ requireMention = true, logger, t } = {}) {
  const adapter = new DingtalkStreamAdapter({ clientId: "test-id", clientSecret: "test-secret", requireMention }, logger);
  const replies = [];
  adapter["client"] = {
    onInbound() {},
    async connect() {},
    close() {},
    async sendReply(msgId, body) {
      replies.push({ msgId, body });
    },
  };
  t?.after(() => {
    for (const pending of adapter["pendingMenus"].values()) clearTimeout(pending.timer);
    adapter["pendingMenus"].clear();
  });
  return { adapter, replies };
}

/** Collect the messages the adapter hands to the core. */
function collecting(adapter) {
  const seen = [];
  adapter.onInbound((msg) => {
    seen.push(msg);
  });
  return seen;
}

/** Call the private entry point the stream client's inbound callback uses. */
const feed = (adapter, raw) => adapter["dispatch"](raw);

const P2P = "cid-p2p-1";
const GROUP = "cid-group-1";
const STAFF = "staff-1";

/** A plain p2p text message, the shape every test below varies from. */
function textMessage(overrides = {}) {
  return {
    conversationId: P2P,
    conversationType: "1",
    senderStaffId: STAFF,
    msgId: "om-1",
    msgType: "text",
    text: { content: "hello" },
    ...overrides,
  };
}

async function* chunksOf(...parts) {
  for (const part of parts) yield part;
}

test("dingtalk adapter: a p2p text message normalizes to exactly the inbound shape", async () => {
  const { adapter } = makeAdapter();
  const seen = collecting(adapter);
  await feed(adapter, textMessage());
  // The doc comment on `normalizeBotMessage` promises exactly this key set;
  // deepEqual is what pins that `replyRef` is present-and-correct rather than
  // present-and-undefined, since the core feeds it straight to `dedup`.
  assert.deepEqual(seen, [
    {
      channel: "dingtalk",
      chatKey: P2P,
      chatType: "p2p",
      senderKey: STAFF,
      text: "hello",
      replyRef: "om-1",
    },
  ]);
});

test("dingtalk adapter: a message without a msgId carries no replyRef", async () => {
  const { adapter } = makeAdapter();
  const seen = collecting(adapter);
  await feed(adapter, textMessage({ msgId: undefined }));
  // Without an id the core's dedup module explicitly skips the message rather
  // than collapsing every id-less message in the chat onto one key. An empty
  // string would be worse than absent: `dedup` rejects only `undefined` and
  // `""`, and `sendReply` would address the reply to nobody.
  assert.equal("replyRef" in seen[0], false);
});

test("dingtalk adapter: unroutable payloads are dropped before the handler", async () => {
  // A payload with no conversation or no sender cannot be bound to a chat, so
  // there is nowhere to deliver an answer. The core would happily create a
  // runner keyed by `undefined` if these reached it.
  for (const raw of [
    textMessage({ conversationId: undefined }),
    textMessage({ conversationId: "" }),
    textMessage({ senderStaffId: undefined }),
    textMessage({ senderStaffId: "" }),
  ]) {
    const { adapter } = makeAdapter();
    const seen = collecting(adapter);
    await feed(adapter, raw);
    assert.deepEqual(seen, [], `expected ${JSON.stringify(raw)} to be dropped`);
  }
});

test("dingtalk adapter: group messages are gated on an @-mention of the bot", async () => {
  // No @-mention: the gateway pushes every group message, so without this gate
  // the agent would answer every message in every group the bot sits in.
  const silent = makeAdapter();
  const silentSeen = collecting(silent.adapter);
  await feed(silent.adapter, textMessage({ conversationId: GROUP, conversationType: "2", isInAtList: false }));
  assert.deepEqual(silentSeen, []);

  // An @-mention delivers, and the chat is typed as a group.
  const mentioned = makeAdapter();
  const mentionedSeen = collecting(mentioned.adapter);
  await feed(mentioned.adapter, textMessage({ conversationId: GROUP, conversationType: "2", isInAtList: true }));
  assert.equal(mentionedSeen.length, 1);
  assert.equal(mentionedSeen[0].chatType, "group");
  assert.equal(mentionedSeen[0].chatKey, GROUP);

  // The gate is group-only: a p2p message has no @-mention to give.
  const p2p = makeAdapter();
  const p2pSeen = collecting(p2p.adapter);
  await feed(p2p.adapter, textMessage({ isInAtList: false }));
  assert.equal(p2pSeen.length, 1);

  // requireMention: false opts out entirely — the config used when the bot is
  // driven from a script rather than a group chat.
  const open = makeAdapter({ requireMention: false });
  const openSeen = collecting(open.adapter);
  await feed(open.adapter, textMessage({ conversationId: GROUP, conversationType: "2", isInAtList: false }));
  assert.equal(openSeen.length, 1);
});

test("dingtalk adapter: a numeric reply resolves the pending menu instead of starting a turn", async (t) => {
  const { adapter, replies } = makeAdapter({ t });
  const seen = collecting(adapter);
  const pending = adapter.promptChoice(
    { chatKey: P2P, chatType: "p2p", replyRef: "om-1" },
    { title: "Pick one", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] },
  );
  for (let i = 0; i < 50 && adapter["pendingMenus"].size === 0; i++) await new Promise((r) => setTimeout(r, 5));

  // The numbered list is the whole interface — it must be sent before any
  // answer can arrive, and the numbers must line up with the option order.
  assert.equal(replies.length, 1);
  const body = JSON.parse(replies[0].body);
  assert.equal(body.msgKey, "sampleText");
  assert.equal(body.msgId, "om-1");
  assert.equal(body.msgParam.content, "Pick one\n\n1. A\n2. B");

  const menuId = [...adapter["pendingMenus"].keys()][0];
  await feed(adapter, textMessage({ text: { content: " 2 " } }));
  // Consumed as an answer: it must NOT also reach the core, or the agent would
  // start a turn on the string "2" while the prompt is still waiting.
  assert.deepEqual(seen, []);
  assert.deepEqual(await pending, { choice: "b", messageId: menuId });
  assert.equal(adapter["pendingMenus"].size, 0, "the answered menu must not stay pending");
});

test("dingtalk adapter: a number outside the menu falls through to the core", async (t) => {
  const { adapter } = makeAdapter({ t });
  const seen = collecting(adapter);
  adapter.promptChoice(
    { chatKey: P2P, chatType: "p2p", replyRef: "om-1" },
    { title: "Pick one", options: [{ id: "a", label: "A" }] },
  );
  for (let i = 0; i < 50 && adapter["pendingMenus"].size === 0; i++) await new Promise((r) => setTimeout(r, 5));

  // "7" is not one of the options. Swallowing it would silently drop a real
  // message; the menu stays pending and the message goes to the agent.
  await feed(adapter, textMessage({ text: { content: "7" } }));
  assert.equal(seen.length, 1);
  assert.equal(seen[0].text, "7");
  assert.equal(adapter["pendingMenus"].size, 1, "the menu must still be pending after a non-answer");
});

test("dingtalk adapter: free text while a menu is pending is not consumed", async (t) => {
  const { adapter } = makeAdapter({ t });
  const seen = collecting(adapter);
  void adapter.promptChoice(
    { chatKey: P2P, chatType: "p2p", replyRef: "om-1" },
    { title: "Pick one", options: [{ id: "a", label: "A" }] },
  );
  for (let i = 0; i < 50 && adapter["pendingMenus"].size === 0; i++) await new Promise((r) => setTimeout(r, 5));

  await feed(adapter, textMessage({ text: { content: "what do you mean?" } }));
  assert.equal(seen.length, 1);
  assert.equal(adapter["pendingMenus"].size, 1);
});

test("dingtalk adapter: with no menu pending, a bare number is an ordinary message", async () => {
  const { adapter } = makeAdapter();
  const seen = collecting(adapter);
  // `tryResolveMenu` bails on the empty map first; without that guard a user
  // who simply types a number would get no answer at all.
  await feed(adapter, textMessage({ text: { content: "2" } }));
  assert.equal(seen.length, 1);
  assert.equal(seen[0].text, "2");
});

test("dingtalk adapter: sendText / sendCard skip a target with no replyRef", async () => {
  const { adapter, replies } = makeAdapter();
  // A replyRef-less target is the core's proactive push (a reminder, a startup
  // notice) which this adapter does not own — the webhook service does. Sending
  // anyway would throw from `sendReply` on a closed socket.
  await adapter.sendText({ chatKey: P2P, chatType: "p2p" }, "hi");
  await adapter.sendCard({ chatKey: P2P, chatType: "p2p" }, { markdown: "hi" });
  assert.deepEqual(replies, []);
});

test("dingtalk adapter: sendText and sendCard emit the msgKey envelopes", async () => {
  const { adapter, replies } = makeAdapter();
  await adapter.sendText({ chatKey: P2P, chatType: "p2p", replyRef: "om-9" }, "plain **text**");
  // Text is NOT markdown-converted here — the adapter is text-forward, and the
  // dingtalk markdown envelope is a separate key. Passing markdown through
  // `sampleText` is intentional; the core decides which sender to use.
  assert.deepEqual(JSON.parse(replies[0].body), {
    msgKey: "sampleText",
    msgParam: { content: "plain **text**" },
    msgId: "om-9",
  });

  await adapter.sendCard({ chatKey: P2P, chatType: "p2p", replyRef: "om-9" }, { markdown: "**bold**" });
  assert.deepEqual(JSON.parse(replies[1].body), {
    msgKey: "sampleMarkdown",
    msgParam: { title: adapter["t"].cardTitle, text: "**bold**" },
    msgId: "om-9",
  });
});

test("dingtalk adapter: streamText accumulates and sends once", async () => {
  const { adapter, replies } = makeAdapter();
  await adapter.streamText({ chatKey: P2P, chatType: "p2p", replyRef: "om-1" }, chunksOf("Ping", " ", "pong"));
  // DingTalk has no editable card in this path, so the whole answer goes out in
  // one `sampleText` — a per-chunk send would spam the thread.
  assert.equal(replies.length, 1);
  assert.equal(JSON.parse(replies[0].body).msgParam.content, "Ping pong");
});

test("dingtalk adapter: streamText stays silent on an empty answer", async () => {
  const { adapter, replies } = makeAdapter();
  await adapter.streamText({ chatKey: P2P, chatType: "p2p", replyRef: "om-1" }, chunksOf("", "  \n "));
  // A turn that produces no text must not post an empty bubble.
  assert.deepEqual(replies, []);
});

test("dingtalk adapter: closeMenu is a no-op", async () => {
  const { adapter, replies } = makeAdapter();
  // Documented as intentionally empty — there is no card to replace. Pinned so
  // that "no-op" stays a decision rather than becoming an oversight.
  await adapter.closeMenu("om-1", "done");
  assert.deepEqual(replies, []);
});
