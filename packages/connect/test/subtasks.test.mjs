/**
 * The decomposition list shown in the chat.
 *
 * Two rules here are easy to get quietly wrong and are the reason this is a separate,
 * pure module rather than inline rendering: the cap must not hide the step being worked
 * on, and a list that has not visibly changed must not cost an API call. Both are
 * asserted directly.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { renderSubtasks, MAX_SUBTASKS, MIN_SUBTASKS } from "../lib/subtasks.js";

const todo = (content, status = "pending") => ({ content, status });

test("a single todo is not a decomposition and renders nothing", () => {
  // One entry is just the task itself. Posting a "plan" for it adds a bubble and tells
  // the user nothing they did not already know.
  assert.equal(renderSubtasks([]), undefined);
  assert.equal(renderSubtasks([todo("only one", "in_progress")]), undefined);
  assert.equal(MIN_SUBTASKS, 2);
});

test("the list carries the completion count and one mark per status", () => {
  const r = renderSubtasks([
    todo("done step", "completed"),
    todo("active step", "in_progress"),
    todo("later step", "pending"),
  ]);
  assert.ok(r);
  assert.match(r.body, /1\/3 已完成/);
  assert.match(r.body, /✅ done step/);
  assert.match(r.body, /🔄 active step/);
  assert.match(r.body, /⬜ later step/);
});

test("a long list is capped, and the cap says how many it hid", () => {
  const many = Array.from({ length: MAX_SUBTASKS + 7 }, (_, i) => todo("step " + (i + 1)));
  const r = renderSubtasks(many);
  assert.ok(r);
  // Match the three marks explicitly. A character class like /^[✅🔄⬜]/ also matches
  // "…" (U+2026), which sits inside that Unicode range, so the truncation line would be
  // counted as an entry — the test would then fail against correct code.
  const shown = r.body.split("\n").filter((l) => /^(?:✅|🔄|⬜) /.test(l));
  assert.equal(shown.length, MAX_SUBTASKS, "no more than the cap may be listed");
  assert.match(r.body, /另有 7 项/, "a truncated list must not silently hide work");
  assert.match(r.body, /0\/17 已完成/, "the count still describes the whole list");
});

test("the cap keeps the in-progress step visible rather than only the first N", () => {
  // The entries being worked on are the ones the user wants, and on a long list they
  // are usually not at the top — a naive slice would hide exactly the active step.
  const many = Array.from({ length: MAX_SUBTASKS + 3 }, (_, i) => todo("step " + (i + 1)));
  many[MAX_SUBTASKS + 2] = todo("the active one", "in_progress");
  const r = renderSubtasks(many);
  assert.ok(r);
  assert.match(r.body, /🔄 the active one/, "the active step must survive the cap");
});

test("an unchanged list renders the same key, so no write is issued", () => {
  // The key is what the caller compares to decide whether to edit. Two renders of the
  // same todos must agree, and any status or content change must differ.
  const a = [todo("one", "pending"), todo("two", "pending")];
  assert.equal(renderSubtasks(a).key, renderSubtasks([...a]).key);
  assert.notEqual(renderSubtasks(a).key, renderSubtasks([todo("one", "completed"), todo("two", "pending")]).key);
  assert.notEqual(renderSubtasks(a).key, renderSubtasks([todo("one", "pending"), todo("changed", "pending")]).key);
});
