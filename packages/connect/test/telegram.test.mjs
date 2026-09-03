import { test } from "node:test";
import assert from "node:assert/strict";

import {
  escapeHtml,
  markdownToTelegramHtml,
  buildInlineKeyboard,
  encodeMessageRef,
  decodeMessageRef,
  isBotMentioned,
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
