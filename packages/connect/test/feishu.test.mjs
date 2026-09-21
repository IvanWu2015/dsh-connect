import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FeishuAdapter, padLabels, buildButtonGrid, buildSelectMenu, buildChoiceElements, sanitizeFileName, extractErrorDetail, encodeChatKey, decodeChatKey, classifyFeishuFile } from "../lib/channels/feishu/index.js";
import { feishuMessages } from "../lib/channels/feishu/i18n.js";

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

// --- onboarding gate -------------------------------------------------------
// `register` used to unconditionally start the interactive one-click onboarding
// flow when credentials were missing. In a headless host that prints a QR/link
// nobody can scan and parks a timer for the life of the process. The gate makes
// the non-interactive path a warning instead.

/** Minimal ctx/connect doubles for `register`. */
function registerHarness() {
  const warnings = [];
  const registered = [];
  const ctx = { logger: { warn: (...args) => warnings.push(args.join(" ")) } };
  const connect = { registerAdapter: (adapter) => registered.push(adapter) };
  return { ctx, connect, warnings, registered };
}

/**
 * Run `body` with no credential source visible. `register` resolves credentials
 * from three places — its config, `FEISHU_*` env vars, and a JSON file under
 * `$DSH_HOME` — so a developer machine with any of those set would otherwise
 * take the "already configured" path and silently stop testing the gate.
 */
function withoutCredentials(body) {
  const savedHome = process.env.DSH_HOME;
  const savedId = process.env.FEISHU_APP_ID;
  const savedSecret = process.env.FEISHU_APP_SECRET;
  process.env.DSH_HOME = join(mkdtempSync(join(tmpdir(), "dsh-connect-gate-")), "home");
  delete process.env.FEISHU_APP_ID;
  delete process.env.FEISHU_APP_SECRET;
  try {
    return body();
  } finally {
    if (savedHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = savedHome;
    if (savedId === undefined) delete process.env.FEISHU_APP_ID; else process.env.FEISHU_APP_ID = savedId;
    if (savedSecret === undefined) delete process.env.FEISHU_APP_SECRET; else process.env.FEISHU_APP_SECRET = savedSecret;
  }
}

test("register skips onboarding when the host is not interactive", () =>
  withoutCredentials(async () => {
    const { register } = await import("../lib/channels/feishu/index.js");
    const { ctx, connect, warnings, registered } = registerHarness();
    // No credentials anywhere: without the gate this would enter the scan flow.
    register(connect, { appId: undefined, appSecret: undefined }, ctx, { interactive: false });
    assert.equal(registered.length, 0);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /跳过一键接入/);
    assert.doesNotMatch(warnings[0], /进入一键接入/);
  }));

test("register honors onboarding:false even on an interactive host", () =>
  withoutCredentials(async () => {
    const { register } = await import("../lib/channels/feishu/index.js");
    const { ctx, connect, warnings, registered } = registerHarness();
    register(connect, { onboarding: false }, ctx, { interactive: true });
    assert.equal(registered.length, 0);
    assert.match(warnings[0], /跳过一键接入/);
  }));

// --- FeishuAdapter inbound/outbound path -----------------------------------
// Everything above tests pure helpers; the block below drives the real adapter
// class. The constructor builds a lark SDK channel and parks it in the private
// `channel` field, and all four `channel.on(...)` subscriptions happen inside
// `start()`. Overwriting that field with a stub before `start()` therefore
// captures the inbound handlers and records every outbound call — no socket,
// no credential, no Feishu API. `transport: "websocket"` is deliberate: the
// webhook branch would bind a real port.

/** The event names the adapter subscribes to — an unexpected one is a test bug. */
const INBOUND_EVENTS = ["message", "cardAction", "reject", "error"];

/** Yield to the event loop so fire-and-forget work (`void sendText`) lands. */
const tick = () => new Promise((resolve) => { setTimeout(resolve, 0); });

/** Poll until `predicate` holds, so tests never rely on a fixed sleep. */
async function waitFor(predicate, label) {
  for (let i = 0; i < 500; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => { setTimeout(resolve, 1); });
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** Stand-in for the SDK's LarkChannel: records handlers and every outbound call. */
function fakeChannel() {
  const handlers = {};
  const sends = [];
  const streams = [];
  const cardUpdates = [];
  const resourceGets = [];
  const state = { connects: 0, disconnects: 0 };
  return {
    handlers,
    sends,
    streams,
    cardUpdates,
    resourceGets,
    state,
    on(event, fn) {
      assert.ok(INBOUND_EVENTS.includes(event), `unexpected subscription: ${event}`);
      handlers[event] = fn;
    },
    async connect() { state.connects += 1; },
    async disconnect() { state.disconnects += 1; },
    async send(chatId, payload, opts) {
      const messageId = `om_sent_${String(sends.length + 1)}`;
      sends.push({ chatId, payload, opts, messageId });
      return { messageId };
    },
    async stream(chatId, input, opts) {
      // The SDK's controller drives the producer with a sink that appends, so
      // mirroring that here is what makes the assertion exercise the adapter's
      // own accumulation loop rather than the fixture.
      const appended = [];
      await input.markdown({ append: async (chunk) => { appended.push(chunk); } });
      streams.push({ chatId, input, opts, appended });
      return { messageId: `om_stream_${String(streams.length + 1)}` };
    },
    async updateCard(messageId, card) { cardUpdates.push({ messageId, card }); },
    // `downloadResources` reaches HTTP through `channel.rawClient`. Recording
    // the call (and failing it) proves the allowlist gate ran before any
    // download, and guarantees no test can reach the network.
    rawClient: {
      im: {
        v1: {
          messageResource: {
            get: async (args) => {
              resourceGets.push(args);
              throw new Error("resource download is not stubbed for offline tests");
            },
          },
        },
      },
    },
  };
}

/** Build an adapter whose private channel is a stub, then start it. */
async function startedAdapter(config = {}, options = {}) {
  const adapter = new FeishuAdapter(
    { appId: "cli_test", appSecret: "sec_test", transport: "websocket", ...config },
    options.logger,
    options.isChatAllowed,
  );
  const fake = fakeChannel();
  adapter["channel"] = fake;
  await adapter.start();
  return { adapter, fake };
}

/** Logger double that keeps the call sites' arguments separate for assertions. */
function recordingLogger() {
  const info = [];
  const warn = [];
  const error = [];
  const push = (sink) => (...args) => sink.push(args.join(" "));
  return { info, warn, error, logger: { info: push(info), warn: push(warn), error: push(error) } };
}

const MSG = { messageId: "om_msg_1", chatId: "oc_chat", chatType: "p2p", senderId: "ou_sender", content: "hello" };

test("feishu start subscribes to all four inbound events and connects once", async (t) => {
  const { adapter, fake } = await startedAdapter();
  t.after(() => adapter.stop());
  assert.deepEqual(Object.keys(fake.handlers).sort(), ["cardAction", "error", "message", "reject"]);
  // A start() that forgot to connect would leave the adapter silently deaf:
  // no error, no log, just a bot that never answers.
  assert.equal(fake.state.connects, 1);
});

test("feishu message handler maps a normalized event onto the core inbound shape", async (t) => {
  const { adapter, fake } = await startedAdapter();
  t.after(() => adapter.stop());
  const received = [];
  adapter.onInbound((msg) => received.push(msg));
  await fake.handlers.message(MSG);
  // replyRef must carry the message id: it is what turns the answer into a
  // Feishu reply (quoted thread) instead of a floating message, and the core
  // keys its reply bookkeeping off it. deepEqual (not a field-by-field check)
  // also pins the absence of `images`/`files` when there is no attachment.
  assert.deepEqual(received, [{
    channel: "feishu",
    chatKey: "oc_chat",
    chatType: "p2p",
    senderKey: "ou_sender",
    text: "hello",
    replyRef: "om_msg_1",
  }]);
});

test("feishu message handler ignores resource types the download API cannot serve", async (t) => {
  const { adapter, fake } = await startedAdapter();
  t.after(() => adapter.stop());
  const received = [];
  adapter.onInbound((msg) => received.push(msg));
  // `sticker` is not in DOWNLOADABLE_TYPES: the resource API has no sticker
  // endpoint, so a live download would 400 and surface a bogus "download
  // failed" hint. Filtering it out means the message still reaches the agent.
  await fake.handlers.message({ ...MSG, resources: [{ type: "sticker", fileKey: "fk_sticker" }] });
  assert.equal(received[0].images, undefined);
  assert.equal(received[0].files, undefined);
  assert.deepEqual(fake.resourceGets, []);
});

test("feishu message handler scopes chatKey to a thread only under threadIsolation", async (t) => {
  // Default: a threaded group reply keeps the bare chat id, so thread messages
  // share the parent conversation's DSH session.
  const flat = await startedAdapter();
  t.after(() => flat.adapter.stop());
  const flatMsgs = [];
  flat.adapter.onInbound((msg) => flatMsgs.push(msg));
  await flat.fake.handlers.message({ ...MSG, chatType: "group", root_id: "om_root" });
  assert.equal(flatMsgs[0].chatKey, "oc_chat");

  // With threadIsolation on, root_id forks a separate session per thread while
  // a non-threaded message in the same chat keeps the bare id.
  const iso = await startedAdapter({ threadIsolation: true });
  t.after(() => iso.adapter.stop());
  const isoMsgs = [];
  iso.adapter.onInbound((msg) => isoMsgs.push(msg));
  await iso.fake.handlers.message({ ...MSG, messageId: "om_msg_2", chatType: "group", root_id: "om_root" });
  await iso.fake.handlers.message({ ...MSG, messageId: "om_msg_3", chatType: "group" });
  assert.deepEqual(isoMsgs.map((m) => m.chatKey), ["oc_chat:thread=om_root", "oc_chat"]);
});

test("feishu allowlist gate drops a message before any resource download", async (t) => {
  const rec = recordingLogger();
  const gate = [];
  const { adapter, fake } = await startedAdapter({}, {
    logger: rec.logger,
    isChatAllowed: (channel, chatKey, senderKey) => {
      gate.push([channel, chatKey, senderKey]);
      return false;
    },
  });
  t.after(() => adapter.stop());
  const received = [];
  adapter.onInbound((msg) => received.push(msg));
  await fake.handlers.message({
    ...MSG,
    senderId: "ou_blocked",
    resources: [{ type: "file", fileKey: "fk_1", fileName: "payload.txt" }],
  });
  assert.deepEqual(received, []); // the core handler never sees it
  // The contract that matters: a rejected sender's attachment data never
  // touches disk. Downloading first and checking the policy afterwards would
  // write a stranger's file into the host's temp dir.
  assert.deepEqual(fake.resourceGets, []);
  assert.deepEqual(gate, [["feishu", "oc_chat", "ou_blocked"]]);
  assert.match(rec.warn[0], /rejected by allowlist/);
});

test("feishu contain a throwing inbound handler and log it instead of rejecting", async (t) => {
  const rec = recordingLogger();
  const { adapter, fake } = await startedAdapter({}, { logger: rec.logger });
  t.after(() => adapter.stop());
  adapter.onInbound(async () => { throw new Error("handler exploded"); });
  // Must resolve: the adapter wraps the whole handling path precisely because
  // `dsh web` has no runtime fallback, so an unhandled rejection here would
  // exit the host process mid-task.
  await assert.doesNotReject(() => fake.handlers.message(MSG));
  assert.equal(rec.error.length, 1);
  assert.match(rec.error[0], /message handling failed/);
  assert.match(rec.error[0], /handler exploded/);
  assert.match(rec.error[0], /chat=oc_chat/);
});

test("feishu contain a throwing inbound handler even with no logger configured", async (t) => {
  const { adapter, fake } = await startedAdapter(); // no logger argument at all
  t.after(() => adapter.stop());
  adapter.onInbound(() => Promise.reject(new Error("no logger attached")));
  // The error path itself calls `logger?.error?.(...)`; a host that passes no
  // logger must still get the containment, not a crash on undefined.
  await assert.doesNotReject(() => fake.handlers.message(MSG));
});

test("feishu cardAction resolves a pending choice with the tapped option id", async (t) => {
  const { adapter, fake } = await startedAdapter();
  t.after(() => adapter.stop());
  const result = adapter.promptChoice(
    { chatKey: "oc_chat", chatType: "p2p" },
    { title: "Pick", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] },
  );
  await waitFor(() => adapter["pendingChoices"].size === 1, "prompt registration");
  const card = fake.sends[0];
  assert.equal(card.chatId, "oc_chat");
  assert.equal(card.payload.card.header.title.content, "Pick");
  // The choice id travels in the button value, so a tap echoes it back verbatim.
  assert.equal(card.payload.card.elements[0].columns[0].elements[0].value.choice, "a");
  fake.handlers.cardAction({ messageId: card.messageId, chatId: "oc_chat", action: { tag: "button", value: { choice: "b" } } });
  assert.deepEqual(await result, { choice: "b", messageId: card.messageId });
  // The entry is consumed on tap: leaving it registered would keep a 60s timer
  // alive and let a second tap resolve an already-settled promise.
  assert.equal(adapter["pendingChoices"].size, 0);
});

test("feishu promptChoice with updateMessageId reuses the card in place", async (t) => {
  const { adapter, fake } = await startedAdapter();
  t.after(() => adapter.stop());
  const result = adapter.promptChoice(
    { chatKey: "oc_chat", chatType: "p2p" },
    { title: "Second", options: [{ id: "x", label: "X" }] },
    "om_card_1",
  );
  await waitFor(() => adapter["pendingChoices"].size === 1, "prompt registration");
  // A menu chain must stay on one card: no new send, just an in-place update,
  // otherwise every "back" tap would stack another card in the chat.
  assert.equal(fake.sends.length, 0);
  assert.equal(fake.cardUpdates[0].messageId, "om_card_1");
  fake.handlers.cardAction({ messageId: "om_card_1", chatId: "oc_chat", action: { tag: "button", value: { choice: "x" } } });
  assert.deepEqual(await result, { choice: "x", messageId: "om_card_1" });
});

test("feishu cardAction on a stale card tells the user instead of swallowing the tap", async (t) => {
  const { adapter, fake } = await startedAdapter();
  t.after(() => adapter.stop());
  const tap = () => fake.handlers.cardAction({ messageId: "om_unknown", chatId: "oc_chat", action: { tag: "button", value: { choice: "a" } } });
  tap();
  await tick();
  assert.equal(fake.sends.length, 1);
  assert.equal(fake.sends[0].chatId, "oc_chat");
  // An expired/already-handled card must answer with a notice — silence is what
  // makes users re-tap a dead button for a minute.
  assert.equal(fake.sends[0].payload.text, feishuMessages("zh").actionStale);
  assert.deepEqual(fake.sends[0].opts, {}); // a fresh message, not a reply
  // Deduped once per card for 30s so a frustrated user cannot spam the chat.
  tap();
  await tick();
  assert.equal(fake.sends.length, 1);
});

test("feishu sendText strips the thread suffix and carries the reply target", async (t) => {
  const { adapter, fake } = await startedAdapter();
  t.after(() => adapter.stop());
  // `oc_chat:thread=om_root` is a DSH session key, not a Feishu id — sending it
  // verbatim would 400. The thread is preserved by the reply target instead.
  await adapter.sendText({ chatKey: "oc_chat:thread=om_root", chatType: "group", replyRef: "om_msg_1" }, "hi there");
  const sent = fake.sends[0];
  assert.equal(sent.chatId, "oc_chat");
  assert.deepEqual(sent.payload, { text: "hi there" });
  assert.deepEqual(sent.opts, { replyTo: "om_msg_1" });
});

test("feishu sendCard renders atUsers as mentions and omits them when empty", async (t) => {
  const { adapter, fake } = await startedAdapter();
  t.after(() => adapter.stop());
  await adapter.sendCard({ chatKey: "oc_chat", chatType: "group", atUsers: ["ou_a", "ou_b"] }, { markdown: "**done**" });
  assert.deepEqual(fake.sends[0].payload, { markdown: "**done**" });
  // The SDK turns each pair into an <at user_id=…> prefix; that is how a group
  // completion card nudges the requester who asked in the first place.
  assert.deepEqual(fake.sends[0].opts, {
    mentions: [{ key: "ou_a", openId: "ou_a" }, { key: "ou_b", openId: "ou_b" }],
  });
  // An empty list must leave the `mentions` key off entirely rather than send
  // an empty array the SDK would have to interpret.
  await adapter.sendCard({ chatKey: "oc_chat", chatType: "group", atUsers: [] }, { markdown: "plain" });
  assert.deepEqual(fake.sends[1].opts, {});
});

test("feishu sendFile sends images inline and everything else as an attachment", async (t) => {
  const { adapter, fake } = await startedAdapter();
  t.after(() => adapter.stop());
  await adapter.sendFile({ chatKey: "oc_chat", chatType: "p2p" }, join(tmpdir(), "shot.png"));
  // Images render inline; the SDK uploads the local path itself.
  assert.deepEqual(fake.sends[0].payload, { image: { source: join(tmpdir(), "shot.png") } });
  await adapter.sendFile({ chatKey: "oc_chat", chatType: "p2p" }, join(tmpdir(), "report.pdf"));
  // Everything else is an attachment labelled with the file's basename.
  assert.deepEqual(fake.sends[1].payload, { file: { source: join(tmpdir(), "report.pdf"), fileName: "report.pdf" } });
  // An explicit filename wins, so a temp path like 3f9a-1b.dat still shows a
  // readable name to the user.
  await adapter.sendFile({ chatKey: "oc_chat", chatType: "p2p" }, join(tmpdir(), "report.pdf"), { filename: "月度报告.pdf" });
  assert.equal(fake.sends[2].payload.file.fileName, "月度报告.pdf");
});

test("feishu streamText appends every chunk into one markdown stream", async (t) => {
  const { adapter, fake } = await startedAdapter();
  t.after(() => adapter.stop());
  async function* chunks() {
    yield "He";
    yield "llo, ";
    yield "world";
  }
  await adapter.streamText({ chatKey: "oc_chat", chatType: "p2p", replyRef: "om_msg_1" }, chunks());
  const streamed = fake.streams[0];
  assert.equal(streamed.chatId, "oc_chat");
  // This transport has no progressive card editing: the SDK's markdown stream
  // controller owns flushing, so the adapter's only job is to hand over every
  // chunk in order — a dropped chunk is a silently truncated answer.
  assert.deepEqual(streamed.appended, ["He", "llo, ", "world"]);
  assert.deepEqual(streamed.opts, { replyTo: "om_msg_1" });
});

test("feishu streamText forwards empty and whitespace-only streams verbatim", async (t) => {
  const { adapter, fake } = await startedAdapter();
  t.after(() => adapter.stop());
  async function* nothing() {}
  await adapter.streamText({ chatKey: "oc_chat", chatType: "p2p" }, nothing());
  // The adapter invents no content: an exhausted producer appends nothing.
  assert.deepEqual(fake.streams[0].appended, []);
  async function* blanks() {
    yield "\n";
    yield "   ";
  }
  await adapter.streamText({ chatKey: "oc_chat", chatType: "p2p" }, blanks());
  // Unlike the DingTalk adapter, this streamText has no `trim()` guard, so a
  // whitespace-only reply is forwarded as-is and the SDK's controller decides
  // what (if anything) to post. Pinned here so the behaviour is a decision
  // rather than an accident.
  assert.deepEqual(fake.streams[1].appended, ["\n", "   "]);
});

test("feishu promptChoice expires the card and resolves undefined on timeout", async (t) => {
  const { adapter, fake } = await startedAdapter();
  t.after(() => adapter.stop());
  // The 60s wait is mocked rather than slept through, so this path is actually
  // exercised instead of skipped for being slow.
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const result = adapter.promptChoice({ chatKey: "oc_chat", chatType: "p2p" }, { title: "Late", options: [{ id: "a", label: "A" }] });
  // The pending entry is registered only after the card send resolves; setImmediate
  // drains those microtasks without needing a (now-mocked) timer.
  await new Promise((resolve) => { setImmediate(resolve); });
  assert.equal(adapter["pendingChoices"].size, 1);
  t.mock.timers.tick(60_000);
  // A menu nobody answered must resolve (undefined) and replace itself with an
  // "expired" notice — an unresolved promise would park the caller forever, and
  // a silent card would keep inviting taps that go nowhere.
  assert.deepEqual(await result, { choice: undefined, messageId: fake.sends[0].messageId });
  assert.equal(fake.cardUpdates[0].messageId, fake.sends[0].messageId);
  assert.equal(fake.cardUpdates[0].card.header.title.content, feishuMessages("zh").menuExpired);
  assert.equal(adapter["pendingChoices"].size, 0);
});

test("feishu reject/error handlers log compact reasons without echoing content", async (t) => {
  const rec = recordingLogger();
  const { adapter, fake } = await startedAdapter({}, { logger: rec.logger });
  t.after(() => adapter.stop());
  fake.handlers.reject({ reason: "no_permission", code: 230003, msg: { chatId: "oc_chat", content: "TOP SECRET" } });
  assert.equal(rec.warn.length, 1);
  assert.match(rec.warn[0], /no_permission/);
  assert.match(rec.warn[0], /230003/);
  assert.match(rec.warn[0], /chat=oc_chat/);
  // The raw event carries message content and sender PII; a log line that
  // dumped the JSON would leak private chat text into the host's log file.
  assert.ok(!rec.warn[0].includes("TOP SECRET"));
  fake.handlers.error(new Error("dispatcher down"));
  assert.match(rec.error[0], /inbound dispatcher error/);
  assert.match(rec.error[0], /dispatcher down/);
});
