import { test } from "node:test";
import assert from "node:assert/strict";

import { padLabels, buildButtonGrid, buildSelectMenu, buildChoiceElements, sanitizeFileName, extractErrorDetail, encodeChatKey, decodeChatKey, classifyFeishuFile } from "../lib/channels/feishu/index.js";

test("padLabels pads CJK labels to equal display width", () => {
  const options = [
    { id: "a", label: "短" },
    { id: "b", label: "很长很长" },
  ];
  const padded = padLabels(options);
  // The long label (4 CJK chars = width 8) sets the target; the short one (width 2) gets 6 units of padding.
  assert.equal(padded[1].label, "很长很长");
  assert.ok(padded[0].label.startsWith("短"));
  assert.ok(padded[0].label.length > "短".length); // padded
  assert.ok(padded[0].label.length >= padded[1].label.length); // display widths equalized
});

test("padLabels caps padding at 20 display units", () => {
  const options = [
    { id: "a", label: "x" },
    { id: "b", label: "y".repeat(40) },
  ];
  const padded = padLabels(options);
  assert.ok(padded[0].label.length <= 40);
});

test("buildButtonGrid renders 2 weighted columns per row, padded last row", () => {
  const rows = buildButtonGrid([{ id: "a", label: "A" }, { id: "b", label: "B" }, { id: "c", label: "C" }], 2);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].columns.length, 2);
  assert.equal(rows[1].columns.length, 2); // padded
  assert.equal(rows[1].columns[1].elements.length, 0); // empty filler column
  assert.equal(rows[0].columns[0].elements[0].value.choice, "a");
});

test("buildButtonGrid marks ❌ labels as danger buttons", () => {
  const rows = buildButtonGrid([{ id: "del", label: "❌ 删除" }], 1);
  assert.equal(rows[0].columns[0].elements[0].type, "danger");
});

test("buildChoiceElements splits options into titled sections + rest", () => {
  const prompt = {
    title: "菜单",
    options: [
      { id: "new", label: "新对话" },
      { id: "clear", label: "清空" },
      { id: "exit", label: "退出" },
    ],
    sections: [{ title: "会话", ids: ["new", "clear"] }],
  };
  const elements = buildChoiceElements(prompt, 2);
  const captions = elements
    .filter((e) => e.tag === "div" && e.text?.content !== undefined)
    .map((e) => e.text.content);
  assert.ok(captions.some((c) => c.includes("会话")));
  // The section group renders as a button grid; the unlisted option lands in the rest grid.
  const grids = elements.filter((e) => e.tag === "column_set");
  assert.equal(grids.length, 2);
  const restGrid = grids[1];
  assert.equal(restGrid.columns[0].elements[0].value.choice, "exit");
});

test("sanitizeFileName strips path separators and control chars", () => {
  assert.equal(sanitizeFileName('a/b\\c:d*e?f"g<h>i|j\u0000k'), "a_b_c_d_e_f_g_h_i_j_k");
  assert.equal(sanitizeFileName("   "), "file");
  assert.equal(sanitizeFileName("x".repeat(300)).length, 200);
});

test("extractErrorDetail prefers the Feishu business error body", () => {
  const err = {
    response: { status: 400, data: { code: 230003, msg: "app not found" } },
  };
  const detail = extractErrorDetail(err);
  assert.ok(detail.includes("400"));
  assert.ok(detail.includes("230003"));
  assert.ok(detail.includes("app not found"));
});

test("extractErrorDetail falls back to Error message", () => {
  assert.equal(extractErrorDetail(new Error("boom")), "boom");
  assert.equal(extractErrorDetail("plain string"), "plain string");
});
// ── Stage B: thread isolation (B4) + sendFile classification (B3) ───────

test("encodeChatKey/decodeChatKey round-trip with and without a thread", () => {
  assert.equal(encodeChatKey("oc_1"), "oc_1");
  assert.equal(encodeChatKey("oc_1", undefined), "oc_1");
  const threaded = encodeChatKey("oc_1", "om_root");
  assert.equal(threaded, "oc_1:thread=om_root");
  assert.deepEqual(decodeChatKey(threaded), { chatId: "oc_1", threadId: "om_root" });
  assert.deepEqual(decodeChatKey("oc_1"), { chatId: "oc_1" });
  assert.deepEqual(decodeChatKey("oc_1:thread=om_root:extra"), { chatId: "oc_1", threadId: "om_root:extra" });
});

test("classifyFeishuFile picks images vs stream files by extension", () => {
  assert.equal(classifyFeishuFile("a.png"), "image");
  assert.equal(classifyFeishuFile("A.JPG"), "image");
  assert.equal(classifyFeishuFile("photo.webp"), "image");
  assert.equal(classifyFeishuFile("notes.md"), "file");
  assert.equal(classifyFeishuFile("archive.zip"), "file");
  assert.equal(classifyFeishuFile("noext"), "file");
});

test("buildSelectMenu renders a select_static action with option ids", () => {
  const el = buildSelectMenu([{ id: "a", label: "Alpha" }, { id: "b", label: "Beta" }], "choose", "a");
  assert.equal(el[0].tag, "action");
  const select = el[0].actions[0];
  assert.equal(select.tag, "select_static");
  assert.equal(select.placeholder.content, "choose");
  assert.equal(select.initial_option, "a");
  assert.equal(select.options.length, 2);
  assert.deepEqual(select.options[1], { text: { tag: "plain_text", content: "Beta" }, value: "b" });
});

test("buildChoiceElements uses dropdown for large sets in auto mode", () => {
  const opts = Array.from({ length: 8 }, (_, i) => ({ id: String(i), label: "Item " + i }));
  const dropdown = buildChoiceElements({ title: "t", options: opts, render: "auto" }, 2);
  assert.equal(dropdown[0].tag, "action");
  assert.equal(dropdown[0].actions[0].tag, "select_static");
});

test("buildChoiceElements passes initialOption through as the dropdown initial_option", () => {
  const opts = [{ id: "model:a:b", label: "B" }, { id: "model:a:c", label: "C" }];
  const el = buildChoiceElements({ title: "model", options: opts, render: "dropdown", initialOption: "model:a:b" }, 2);
  const select = el[0].actions[0];
  assert.equal(select.tag, "select_static");
  assert.equal(select.initial_option, "model:a:b");
  assert.equal(select.options.length, 2);
});

test("buildChoiceElements keeps buttons for small sets in auto mode", () => {
  const opts = [{ id: "a", label: "A" }, { id: "b", label: "B" }];
  const btns = buildChoiceElements({ title: "t", options: opts, render: "auto" }, 2);
  assert.notEqual(btns[0].tag, "action");
});

test("buildChoiceElements honors explicit dropdown and buttons", () => {
  const opts = [{ id: "a", label: "A" }, { id: "b", label: "B" }];
  assert.equal(buildChoiceElements({ title: "t", options: opts, render: "dropdown" }, 2)[0].tag, "action");
  assert.notEqual(buildChoiceElements({ title: "t", options: opts, render: "buttons" }, 2)[0].tag, "action");
});

test("buildChoiceElements groups keep buttons even when large in auto mode", () => {
  const opts = Array.from({ length: 10 }, (_, i) => ({ id: String(i), label: "G" + i }));
  const sections = [{ title: "S", ids: opts.map((o) => o.id) }];
  const grouped = buildChoiceElements({ title: "t", options: opts, sections, render: "auto" }, 2);
  assert.notEqual(grouped[0].tag, "action");
});
