import { test } from "node:test";
import assert from "node:assert/strict";

import {
  escapeHtml,
  markdownToTelegramHtml,
  buildInlineKeyboard,
  encodeMessageRef,
  decodeMessageRef,
  isBotMentioned,
  TelegramAdapter,
} from "../lib/channels/telegram/index.js";
import { TelegramClient, telegramFileMethod } from "../lib/channels/telegram/client.js";

test("escapeHtml escapes & < >", () => {
  assert.equal(escapeHtml("a & b < c > d"), "a &amp; b &lt; c &gt; d");
  assert.equal(escapeHtml("plain"), "plain");
});

test("markdownToTelegramHtml converts bold, italic, inline code, headings, links", () => {
  const out = markdownToTelegramHtml("**bold** and *italic* and `code`\n# Title\n[link](https://x.com)");
  assert.ok(out.includes("<b>bold</b>"));
  assert.ok(out.includes("<i>italic</i>"));
  assert.ok(out.includes("<code>code</code>"));
  assert.ok(out.includes("<b>Title</b>"));
  assert.ok(out.includes('<a href="https://x.com">link</a>'));
});

test("markdownToTelegramHtml escapes HTML inside content", () => {
  const out = markdownToTelegramHtml("**a < b**");
  assert.ok(out.includes("<b>a &lt; b</b>"));
});

test("markdownToTelegramHtml escapes plain-text & < > (regression: unescaped raw chars broke parse mode)", () => {
  const out = markdownToTelegramHtml("R&D is x < y and z > w");
  assert.ok(out.includes("R&amp;D"));
  assert.ok(out.includes("x &lt; y"));
  assert.ok(out.includes("z &gt; w"));
  assert.ok(!out.includes("R&D is x < y"));
});

test("markdownToTelegramHtml keeps fenced code blocks intact", () => {
  const out = markdownToTelegramHtml("```js\nconst a = 1 < 2 && true;\n```");
  assert.ok(out.includes("<pre>const a = 1 &lt; 2 &amp;&amp; true;\n</pre>"));
});

test("markdownToTelegramHtml escapes link hrefs", () => {
  const out = markdownToTelegramHtml("[x](https://x.com/?a=1&b=<2>)");
  assert.ok(out.includes('href="https://x.com/?a=1&amp;b=&lt;2&gt;"'));
});

test("isBotMentioned: reply to the bot counts, reply to another user does not", () => {
  const base = { message_id: 1, chat: { id: 1, type: "group" }, text: "hi" };
  assert.equal(
    isBotMentioned({ ...base, reply_to_message: { message_id: 0, chat: { id: 1, type: "group" }, from: { id: 999, is_bot: true } } }, "hi", undefined, 999),
    true,
  );
  assert.equal(
    isBotMentioned({ ...base, reply_to_message: { message_id: 0, chat: { id: 1, type: "group" }, from: { id: 5, is_bot: false } } }, "hi", undefined, 999),
    false,
  );
});

test("isBotMentioned: @mention of the bot's username counts, other mentions do not", () => {
  const base = { message_id: 1, chat: { id: 1, type: "group" }, text: "hello @mybot please" };
  const entityAt = (offset, length) => ({ type: "mention", offset, length });
  const msgWith = (entities) => ({ ...base, entities });
  assert.equal(isBotMentioned(msgWith([entityAt(6, 6)]), base.text, "mybot", 999), true);
  assert.equal(isBotMentioned(msgWith([entityAt(6, 6)]), base.text, "otherbot", 999), false);
});

test("buildInlineKeyboard groups options into rows", () => {
  const options = [
    { id: "a", label: "A" },
    { id: "b", label: "B" },
    { id: "c", label: "C" },
  ];
  const keyboard = buildInlineKeyboard(options, 2);
  assert.equal(keyboard.inline_keyboard.length, 2);
  assert.deepEqual(keyboard.inline_keyboard[0].map((b) => b.callback_data), ["choice:a", "choice:b"]);
  assert.deepEqual(keyboard.inline_keyboard[1].map((b) => b.callback_data), ["choice:c"]);
});

test("encode/decodeMessageRef round-trips chatId and messageId", () => {
  const ref = encodeMessageRef("-100123456789", 42);
  assert.equal(decodeMessageRef(ref).chatId, "-100123456789");
  assert.equal(decodeMessageRef(ref).messageId, 42);
  assert.equal(decodeMessageRef("42").messageId, 42);
});

// --- TelegramClient with a mocked fetch ------------------------------------

function makeClient(respond) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const method = url.split("/").pop() ?? "";
    let params = {};
    if (init !== undefined && typeof init.body === "string") params = JSON.parse(init.body);
    return {
      ok: true,
      json: async () => ({ ok: true, result: respond(method, params) }),
    };
  };
  const client = new TelegramClient({
    botToken: "test:token",
    pollingTimeoutSeconds: 50,
    baseUrl: "https://mock.example",
  });
  client["__restoreFetch"] = originalFetch;
  return client;
}

test("pollUpdates does not advance the offset; confirmOffset does (per-update ack)", async () => {
  const calls = [];
  const client = makeClient((method, params) => {
    calls.push({ method, params });
    if (method === "getUpdates") {
      if (params.offset !== 0) return [];
      return [{ update_id: 1, message: { message_id: 1, chat: { id: 1, type: "private" }, text: "hi" } }];
    }
    return undefined;
  });
  try {
    const updates = await client.pollUpdates();
    assert.equal(updates.length, 1);
    // Offset must NOT be advanced before the caller confirms.
    assert.equal(client["offset"], 0);
    client.confirmOffset(1);
    assert.equal(client["offset"], 2);
    const next = await client.pollUpdates();
    assert.equal(next.length, 0);
    assert.equal(calls[0].method, "getUpdates");
    assert.equal(calls[0].params.timeout, 50);
  } finally {
    globalThis.fetch = client["__restoreFetch"];
  }
});
// ── Stage B: sendFile classification (B3) ────────────────────────────────

test("telegramFileMethod picks sendPhoto vs sendDocument by extension", () => {
  assert.equal(telegramFileMethod("a.png"), "sendPhoto");
  assert.equal(telegramFileMethod("A.JPEG"), "sendPhoto");
  assert.equal(telegramFileMethod("clip.gif"), "sendPhoto");
  assert.equal(telegramFileMethod("report.pdf"), "sendDocument");
  assert.equal(telegramFileMethod("data.zip"), "sendDocument");
  assert.equal(telegramFileMethod("noext"), "sendDocument");
});

// ── Adapter: the message / binding path ──────────────────────────────────
//
// Everything above tests the adapter's *pure* helpers. These tests drive the
// adapter itself — `handleUpdate` → `normalizeMessage` → the inbound handler,
// and the outbound senders back out — because that is the seam the core
// actually binds on: `service.routeInbound` keys bindings and runners by
// (channel, chatKey), and `dedup` keys re-delivery protection by `replyRef`.
// A change here silently changes which chat a reply lands in, so the
// assertions below are about *values*, not about "a message came through".
//
// The Bot API client is replaced with a recording stub before the first
// `handleUpdate`: the constructor only builds an inert `TelegramClient` (no
// request leaves the process until `start()`), and `client` is
// `private readonly` at the type level only, so nothing here touches the
// network while the adapter's own logic stays fully under test.

/** Build an adapter whose Bot API is a recording stub. */
function makeAdapter({ requireMention = true, logger } = {}) {
  const adapter = new TelegramAdapter({ botToken: "test:token", requireMention }, logger);
  const calls = [];
  /** fileId → the result `downloadFileToTemp` should resolve. */
  const downloads = new Map();
  let nextMessageId = 700;

  const client = {
    config: {},
    async sendMessage(chatId, text, opts = {}) {
      calls.push({ method: "sendMessage", chatId, text, opts });
      return { message_id: (nextMessageId += 1) };
    },
    async editMessageText(chatId, messageId, text, opts = {}) {
      calls.push({ method: "editMessageText", chatId, messageId, text, opts });
      return {};
    },
    async answerCallbackQuery(id, text) {
      calls.push({ method: "answerCallbackQuery", id, text });
      return true;
    },
    async sendPhoto(chatId, photoPath, caption, opts) {
      calls.push({ method: "sendPhoto", chatId, photoPath, caption, opts });
      return {};
    },
    async sendDocument(chatId, documentPath, opts) {
      calls.push({ method: "sendDocument", chatId, documentPath, opts });
      return {};
    },
    async downloadFileToTemp(fileId, fileName) {
      calls.push({ method: "downloadFileToTemp", fileId, fileName });
      return downloads.get(fileId) ?? { path: `/tmp/${fileName}`, kind: "file" };
    },
  };
  adapter["client"] = client;
  return { adapter, calls, downloads };
}

/** Collect the messages the adapter hands to the core. */
function collecting(adapter) {
  const seen = [];
  adapter.onInbound((msg) => {
    seen.push(msg);
  });
  return seen;
}

/** Call the adapter's private update entry point the polling loop uses. */
const feed = (adapter, update) => adapter["handleUpdate"](update);

const PRIVATE_CHAT = { id: 42, type: "private" };
const USER = { id: 7, is_bot: false, username: "alice" };

/** A plain private-chat text message, the shape every test below varies from. */
function textMessage(overrides = {}) {
  return { message_id: 100, chat: PRIVATE_CHAT, from: USER, text: "hello", ...overrides };
}

async function* chunksOf(...parts) {
  for (const part of parts) yield part;
}

test("telegram adapter: a p2p text message normalizes to exactly the inbound shape", async () => {
  const { adapter } = makeAdapter();
  const seen = collecting(adapter);
  await feed(adapter, { update_id: 1, message: textMessage() });
  // deepEqual, not a field-by-field check: `normalizeMessage` builds the
  // optional keys by conditional spread, so this pins that a message with no
  // media and no reply carries none of them (an always-present `images: []`
  // would make the core's "has attachments" checks permanently true).
  assert.deepEqual(seen, [
    { channel: "telegram", chatKey: "42", chatType: "p2p", senderKey: "7", text: "hello" },
  ]);
});

test("telegram adapter: a reply binds replyRef to the replied-to message id", async () => {
  const { adapter } = makeAdapter();
  const seen = collecting(adapter);
  await feed(adapter, {
    update_id: 1,
    message: textMessage({ message_id: 101, reply_to_message: textMessage({ message_id: 99 }) }),
  });
  // `sendText` turns `target.replyRef` straight into `reply_to_message_id`, so
  // this value is what decides which message the bot's answer threads under.
  assert.equal(seen[0].replyRef, "99");
});

test("telegram adapter: the bot's own messages never reach the handler", async () => {
  const { adapter } = makeAdapter();
  const seen = collecting(adapter);
  // Telegram echoes the bot's own sends back through getUpdates; treating them
  // as inbound would re-trigger the agent on every ack, card and summary the
  // bridge itself just delivered — an unbounded turn loop.
  await feed(adapter, { update_id: 1, message: textMessage({ from: { id: 999, is_bot: true, username: "mybot" } }) });
  assert.deepEqual(seen, []);
});

test("telegram adapter: edited_message is ignored", async () => {
  const { adapter } = makeAdapter();
  const seen = collecting(adapter);
  // The bridge edits the streaming card in place. `edited_message` carries the
  // same fields as `message`, so accepting it would fire a fresh agent turn on
  // every streamed edit — but `handleUpdate` reads `update.message` only.
  await feed(adapter, { update_id: 1, edited_message: textMessage({ text: "hello (edited)" }) });
  assert.deepEqual(seen, []);
});

test("telegram adapter: group messages are gated on a mention of this bot", async () => {
  const GROUP_CHAT = { id: 50, type: "supergroup" };
  const mention = { type: "mention", offset: 0, length: 6 };

  // No mention: the gateway pushes every group message, so without this gate
  // the agent would answer every message in every group the bot is in.
  const silent = makeAdapter();
  silent.adapter["botUsername"] = "mybot";
  silent.adapter["botId"] = 999;
  const silentSeen = collecting(silent.adapter);
  await feed(silent.adapter, { update_id: 1, message: textMessage({ chat: GROUP_CHAT, text: "general chatter" }) });
  assert.deepEqual(silentSeen, []);

  // An @-mention of *this* bot delivers, and the chat is typed as a group.
  const mentioned = makeAdapter();
  mentioned.adapter["botUsername"] = "mybot";
  mentioned.adapter["botId"] = 999;
  const mentionedSeen = collecting(mentioned.adapter);
  await feed(mentioned.adapter, {
    update_id: 1,
    message: textMessage({ chat: GROUP_CHAT, text: "@mybot please", entities: [mention] }),
  });
  assert.equal(mentionedSeen.length, 1);
  assert.equal(mentionedSeen[0].chatType, "group");
  assert.equal(mentionedSeen[0].chatKey, "50");

  // requireMention: false opts the gate out entirely (the config the e2e leg
  // uses), so a bare group message must still be delivered.
  const open = makeAdapter({ requireMention: false });
  const openSeen = collecting(open.adapter);
  await feed(open.adapter, { update_id: 1, message: textMessage({ chat: GROUP_CHAT, text: "no mention" }) });
  assert.equal(openSeen.length, 1);
});

test("telegram adapter: a message with neither text nor media starts no turn", async () => {
  const { adapter } = makeAdapter();
  const seen = collecting(adapter);
  // Stickers and service messages normalize to `text: ""`; forwarding them
  // would run a full agent turn on an empty prompt.
  await feed(adapter, { update_id: 1, message: textMessage({ text: undefined, sticker: { file_id: "st1" } }) });
  assert.deepEqual(seen, []);
});

test("telegram adapter: a caption stands in for text on a media message", async () => {
  const { adapter, downloads } = makeAdapter();
  downloads.set("ph1", { path: "/tmp/dsh-connect-telegram/photo_x.jpg", kind: "image" });
  const seen = collecting(adapter);
  await feed(adapter, {
    update_id: 1,
    message: textMessage({
      text: undefined,
      caption: "look at this",
      photo: [{ file_id: "ph1", file_unique_id: "x", width: 90, height: 90 }],
    }),
  });
  assert.equal(seen[0].text, "look at this");
  assert.deepEqual(seen[0].images, ["/tmp/dsh-connect-telegram/photo_x.jpg"]);
});

test("telegram adapter: a failed download still routes, carrying imageError", async () => {
  const { adapter, downloads } = makeAdapter();
  // A missing `im:resource` permission / expired file_id is the common case.
  // Dropping the message would leave the user with no reply at all; the core
  // surfaces `imageError` back to them instead.
  downloads.set("ph1", { path: "", kind: "image", error: "download HTTP 403" });
  const seen = collecting(adapter);
  await feed(adapter, {
    update_id: 1,
    message: textMessage({
      text: "what is this",
      photo: [{ file_id: "ph1", file_unique_id: "x", width: 90, height: 90 }],
    }),
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].imageError, "download HTTP 403");
  assert.equal(seen[0].images, undefined);
});

test("telegram adapter: sendText replies into the originating chat with HTML escaping", async () => {
  const { adapter, calls } = makeAdapter();
  await adapter.sendText({ chatKey: "42", chatType: "p2p", replyRef: "99" }, "**a < b**");
  assert.deepEqual(calls, [
    {
      method: "sendMessage",
      chatId: "42",
      text: "<b>a &lt; b</b>",
      opts: { parse_mode: "HTML", reply_to_message_id: 99, disable_web_page_preview: true },
    },
  ]);
  // Without a replyRef the key must be absent, not NaN: `Number(undefined)`
  // would be sent as `reply_to_message_id: null` and reject the whole send.
  const { adapter: bare, calls: bareCalls } = makeAdapter();
  await bare.sendText({ chatKey: "42", chatType: "p2p" }, "hi");
  assert.equal("reply_to_message_id" in bareCalls[0].opts, false);
});

test("telegram adapter: sendCard prefixes @-mentions", async () => {
  const { adapter, calls } = makeAdapter();
  await adapter.sendCard({ chatKey: "50", chatType: "group", atUsers: ["7", "8"] }, { markdown: "done" });
  assert.ok(calls[0].text.startsWith('<a href="tg://user?id=7">@</a> <a href="tg://user?id=8">@</a>\n'));
  assert.ok(calls[0].text.endsWith("done"));
});

test("telegram adapter: sendFile routes by extension to sendPhoto / sendDocument", async () => {
  const { adapter, calls } = makeAdapter();
  await adapter.sendFile({ chatKey: "42", chatType: "p2p", replyRef: "99" }, "C:\\tmp\\chart.png");
  await adapter.sendFile({ chatKey: "42", chatType: "p2p", replyRef: "99" }, "/tmp/report.pdf");
  assert.deepEqual(
    calls.map((c) => c.method),
    ["sendPhoto", "sendDocument"],
  );
  assert.deepEqual(calls[0].opts, { reply_to_message_id: 99 });
});

test("telegram adapter: a callback query settles the pending choice and clears its keys", async () => {
  const { adapter, calls } = makeAdapter();
  const pending = adapter.promptChoice({ chatKey: "42", chatType: "p2p" }, {
    title: "Pick one",
    options: [{ id: "a", label: "A" }, { id: "b", label: "B" }],
  });

  // Wait for `promptChoice` to register its keys before tapping.
  for (let i = 0; i < 50 && adapter["pendingChoices"].size === 0; i++) await new Promise((r) => setTimeout(r, 5));
  const sent = calls.find((c) => c.method === "sendMessage");
  assert.equal(sent.opts.reply_markup.inline_keyboard[0][0].callback_data, "choice:a");

  await feed(adapter, { update_id: 1, callback_query: { id: "cb1", data: "choice:b", message: { chat: { id: 42 } } } });
  const result = await pending;
  assert.equal(result.choice, "b");
  assert.equal(calls.find((c) => c.method === "answerCallbackQuery").text, adapter["t"].choiceDone);
  // Both option keys must go — a stale entry would leave the map growing for
  // the process lifetime and swallow a later menu's first tap.
  assert.equal(adapter["pendingChoices"].size, 0);

  // A second tap on the now-dead keyboard is reported as expired rather than
  // resolving a prompt nobody is waiting on.
  await feed(adapter, { update_id: 2, callback_query: { id: "cb2", data: "choice:b", message: { chat: { id: 42 } } } });
  assert.equal(calls.at(-1).text, adapter["t"].choiceExpired);
});

test("telegram adapter: a non-choice callback query is acknowledged and ignored", async () => {
  const { adapter, calls } = makeAdapter();
  await feed(adapter, { update_id: 1, callback_query: { id: "cb1", data: "other:thing", message: { chat: { id: 42 } } } });
  assert.deepEqual(calls, [{ method: "answerCallbackQuery", id: "cb1", text: undefined }]);
});

test("telegram adapter: streamText sends once and then edits the same message", async () => {
  const { adapter, calls } = makeAdapter();
  await adapter.streamText({ chatKey: "42", chatType: "p2p" }, chunksOf("hel", "lo"));
  // Below the 200-char / 700 ms flush thresholds the whole answer arrives in
  // one final flush — and `editMessageText` REPLACES the text, so the body
  // must always be the full accumulation, never just the latest delta.
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "sendMessage");
  assert.equal(calls[0].text, "hello");
});

test("telegram adapter: streamText truncates past the 4096-character API cap", async () => {
  const { adapter, calls } = makeAdapter();
  // 5000 chars forces an immediate flush (>= 4096) while the stream is still
  // open; an untruncated body would be rejected by the Bot API and the user
  // would see the streaming card fail rather than a clipped answer.
  await adapter.streamText({ chatKey: "42", chatType: "p2p" }, chunksOf("x".repeat(5000)));
  assert.equal(calls[0].method, "sendMessage");
  assert.equal(calls[0].text, `${"x".repeat(4000)}\n\n…`);
  assert.equal(calls[1].method, "editMessageText");
  assert.equal(calls[1].messageId, calls[0].method === "sendMessage" ? 701 : undefined);
});

test("telegram adapter: a failed stream flush keeps the text for the next one", async () => {
  const warnings = [];
  const { adapter, calls } = makeAdapter({ logger: { warn: (...args) => warnings.push(args.join(" ")) } });
  let failFirst = true;
  const realSend = adapter["client"].sendMessage;
  adapter["client"].sendMessage = async (...args) => {
    if (failFirst) {
      failFirst = false;
      throw new Error("429 Too Many Requests");
    }
    return realSend(...args);
  };

  await adapter.streamText({ chatKey: "42", chatType: "p2p" }, chunksOf("y".repeat(5000)));
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].includes("429 Too Many Requests"));
  // The retry carries the whole answer, not the delta that followed the
  // failure — a delta-only retry would deliver "…" and silently lose the rest.
  assert.equal(calls[0].text, `${"y".repeat(4000)}\n\n…`);
});
