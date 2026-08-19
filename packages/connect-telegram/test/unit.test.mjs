import { test } from "node:test";
import assert from "node:assert/strict";

import {
  escapeHtml,
  markdownToTelegramHtml,
  buildInlineKeyboard,
  encodeMessageRef,
  decodeMessageRef,
} from "../lib/index.js";

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
