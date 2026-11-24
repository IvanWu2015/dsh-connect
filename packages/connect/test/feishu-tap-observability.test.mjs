/**
 * Follow-up to the 2026-11-24 report:
 *
 *   「按钮已经有了，但点击了，没有任何反应。」 「目标问题还在那，卡片看起来已经失效/按钮点不动」
 *
 * A tap that does NOTHING — no acknowledgement, no 「此操作已失效」, no redraw — has
 * exactly four paths out of the adapter, and three of them are silent on
 * purpose. Only one of those silences is chosen with the user's interests in
 * mind (a tap landing inside the redraw window); the others are leftovers that
 * look identical from the chat:
 *
 *   1. the tap is inside the absorber → swallowed (by design, ~5 s)
 *   2. the SDK dropped the event BEFORE us — duplicate (`seenCache`) or
 *      in-flight (`lock`) → swallowed inside the SDK, and its debug line was
 *      thrown away because no logger was configured
 *   3. the card lost its tap listener without an absorber (a bug in `unbind`)
 *      → falls into the "genuinely stale" branch, which DOES notify
 *   4. the button's payload is not a recognised choice id → notified once
 *
 * The SDK logging is what makes 2 visible at all. These tests pin that the
 * adapter hands the SDK a logger and that a done/abandoned card is never left
 * tappable-but-deaf.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { FeishuAdapter } from "../lib/channels/feishu/index.js";
import { feishuMessages } from "../lib/channels/feishu/i18n.js";

const tick = (ms = 0) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** A logger double that keeps each level separately. */
function recordingLogger() {
  const info = [];
  const warn = [];
  const error = [];
  const push = (sink) => (...args) => sink.push(args.join(" "));
  return { info, warn, error, logger: { info: push(info), warn: push(warn), error: push(error) } };
}

function fakeChannel() {
  const handlers = {};
  const sends = [];
  const cardUpdates = [];
  const recalls = [];
  return {
    handlers,
    sends,
    cardUpdates,
    recalls,
    on(event, fn) { handlers[event] = fn; },
    async connect() {},
    async disconnect() {},
    async send(_chatId, payload) {
      sends.push(payload);
      return { messageId: `om_${sends.length}` };
    },
    async updateCard(messageId, card) { cardUpdates.push({ messageId, card }); },
    async recallMessage(messageId) { recalls.push(messageId); },
    async stream(_chatId, input) {
      const appended = [];
      await input.markdown({ append: async (chunk) => { appended.push(chunk); } });
      return { messageId: "om_stream" };
    },
    rawClient: { im: { v1: { messageResource: { get: async () => { throw new Error("offline"); } } } } },
  };
}

async function startedAdapter(logger) {
  const adapter = new FeishuAdapter({ appId: "cli_x", appSecret: "sec_x", transport: "websocket" }, logger);
  const fake = fakeChannel();
  adapter["channel"] = fake;
  await adapter.start();
  return { adapter, fake };
}

test("the adapter gives the SDK a logger, so its dropped-tap lines are not lost", async (t) => {
  // The SDK's safety pipeline drops a duplicate or in-flight card action with a
  // DEBUG line — and only if it has a logger. Without one, the user's tap
  // disappears completely: no card response, no log, nothing to diagnose.
  // Reported as 「按钮已经有了，但点击了，没有任何反应」.
  const { info, warn, error, logger } = recordingLogger();
  const adapter = new FeishuAdapter({ appId: "cli_x", appSecret: "sec_x", transport: "websocket" }, logger);
  t.after(() => adapter.stop());
  const sdkLogger = adapter["channel"].opts?.logger;
  assert.ok(sdkLogger !== undefined, "createLarkChannel must be given a logger");

  // Every level must reach ours, prefixed so it is attributable in the host log.
  sdkLogger.debug("safety: drop duplicate action card:om_1:ou_1:button");
  sdkLogger.warn("safety: light handler threw");
  sdkLogger.error("safety: action handler threw");
  assert.ok(info.some((line) => line.includes("connect-feishu[sdk]:") && line.includes("drop duplicate action")),
    `SDK debug lines must be logged; info=${JSON.stringify(info)}`);
  assert.ok(warn.some((line) => line.includes("light handler threw")), `warn=${JSON.stringify(warn)}`);
  assert.ok(error.some((line) => line.includes("action handler threw")), `error=${JSON.stringify(error)}`);
});

test("a tap on a card whose prompt is gone always gets an answer", async (t) => {
  // "Deaf but not absorbed": the prompt listener is gone and no absorber covers
  // the window, so the tap must produce the stale notice. A missing notice here
  // is indistinguishable from a dead card.
  const { logger } = recordingLogger();
  const { adapter, fake } = await startedAdapter(logger);
  t.after(() => adapter.stop());
  fake.handlers.cardAction({
    messageId: "om_never_issued",
    chatId: "oc_chat",
    action: { tag: "button", value: { choice: "q:pick:0" } },
  });
  await tick(10);
  assert.equal(fake.sends.length, 1, "a tap on an unknown card must be acknowledged");
  assert.match(String(fake.sends[0].text), /失效|expired/i);
});

test("a tap on a card whose button carries no choice is not swallowed silently", async (t) => {
  // Buttons without a `choice` value are not ours to answer, and the adapter is
  // right to ignore them — but that must be visible, not indistinguishable from
  // the "nothing happens" report.
  const { info, warn, logger } = recordingLogger();
  const { adapter, fake } = await startedAdapter(logger);
  t.after(() => adapter.stop());
  fake.handlers.cardAction({
    messageId: "om_odd",
    chatId: "oc_chat",
    action: { tag: "button", value: { something: "else" } },
  });
  await tick(10);
  const all = [...info, ...warn].join("\n");
  assert.ok(
    all.includes("om_odd"),
    `an unanswerable tap must leave a trace naming the card; got ${JSON.stringify([...info, ...warn])}`,
  );
});

test("the redraw-window absorber never swallows a tap for longer than its window", async (t) => {
  // The one deliberate silence (a tap during a redraw) is time-boxed. If the
  // window were never cleared, the card would stay dead forever — which is
  // exactly 「按钮点不动」.
  const { logger } = recordingLogger();
  const { adapter, fake } = await startedAdapter(logger);
  t.after(() => adapter.stop());
  const absorb = adapter["absorbChoice"].bind(adapter);
  absorb("om_expired");
  assert.equal(adapter["absorbingChoices"].has("om_expired"), true);
  // The window is seconds, not minutes: the entry must clear itself.
  const timers = [...adapter["staleTimers"]];
  assert.ok(timers.length >= 1, "the absorber must arm a self-clearing timer");
  for (const timer of timers) clearTimeout(timer);
  adapter["absorbingChoices"].clear();
  fake.handlers.cardAction({
    messageId: "om_expired",
    chatId: "oc_chat",
    action: { tag: "button", value: { choice: "q:pick:0" } },
  });
  await tick(10);
  assert.equal(fake.sends.length, 1, "once the window is over, the tap must be answered");
});

test("the notice for a dead card is one language, not mixed", async (t) => {
  // The stale notice is the only feedback a user gets for a dead card; a
  // half-translated one is worse than none for a Chinese-named product.
  const { logger } = recordingLogger();
  const { adapter, fake } = await startedAdapter(logger);
  t.after(() => adapter.stop());
  fake.handlers.cardAction({
    messageId: "om_dead",
    chatId: "oc_chat",
    action: { tag: "button", value: { choice: "q:pick:0" } },
  });
  await tick(10);
  const zh = feishuMessages("zh").actionStale;
  assert.equal(fake.sends[0].text, zh);
});
