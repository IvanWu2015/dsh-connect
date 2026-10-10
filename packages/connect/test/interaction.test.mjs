/**
 * The interaction bridge: how a question/approval raised on the host turns into
 * a card in the chat, and what happens when it cannot.
 *
 * The bridge is the fix for "the agent offers options but Feishu shows none".
 * It used to subscribe to a host `apiProxy` service that does not exist, so
 * every question silently fell through. It is now a listener on the two host
 * waterfalls (`user-questions/request`, `approval/request`) — which makes the
 * registration contract the load-bearing part:
 *
 * - registered with `prepend: true`, because the host's own Web-GUI forwarder
 *   parks the waterfall on a promise that never settles with no browser tab
 *   open — a listener placed after it would never run at all;
 * - registered on the plugin's unscoped context, which every scoped dispatch
 *   admits;
 * - and always able to say `next()`, so an unclaimed request still reaches the
 *   host's normal path.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { InteractionBridge, BindingStore, messages, resolveConnectConfig } from "../lib/index.js";

const zh = messages("zh");

/** Sentinel returned by `next()`, so an assertion can tell "handed on" apart. */
const NEXT = Symbol("next");
const next = () => Promise.resolve(NEXT);

const tick = () => new Promise((resolve) => { setTimeout(resolve, 0); });

const tempDir = () => mkdtempSync(join(tmpdir(), "dsh-connect-interaction-"));

/** Minimal cordis context: records listeners so a test can drive a waterfall. */
function fakeContext() {
  const listeners = new Map();
  return {
    listeners,
    ctx: {
      get() { return undefined; },
      effect(callback) {
        const dispose = callback();
        return () => { dispose?.(); };
      },
      on(name, listener, options) {
        const entry = { listener, options };
        const list = listeners.get(name) ?? [];
        list.push(entry);
        listeners.set(name, list);
        return () => {
          const index = list.indexOf(entry);
          if (index !== -1) list.splice(index, 1);
        };
      },
    },
  };
}

/** The single listener registered for `name`. */
function answerer(harness, name) {
  const entries = harness.listeners.get(name) ?? [];
  assert.equal(entries.length, 1, `expected exactly one ${name} listener`);
  return entries[0];
}

/** A prompt that stays up until the signal it was handed aborts. */
const untilAborted = (messageId) => ({ signal }) => new Promise((resolve) => {
  signal.addEventListener("abort", () => resolve({ choice: undefined, messageId }), { once: true });
});

/**
 * A channel adapter stand-in. `onPrompt` decides what a prompt resolves to and
 * receives `{ index }` so a test can vary the answer per round.
 */
function fakeAdapter({ id = "feishu", supportsChoices, onPrompt } = {}) {
  const calls = { prompts: [], texts: [], closed: [] };
  return {
    calls,
    adapter: {
      id,
      ...(supportsChoices === undefined ? {} : { supportsChoices }),
      async start() {},
      async stop() {},
      onInbound() {},
      async sendText(_target, text) { calls.texts.push(text); },
      async sendCard() {},
      async streamText() {},
      async closeMenu(messageId, summary) { calls.closed.push({ messageId, summary }); },
      async promptChoice(target, prompt, updateMessageId, signal) {
        calls.prompts.push({ target, prompt, updateMessageId, signal });
        if (onPrompt === undefined) return { choice: undefined, messageId: "" };
        return onPrompt({ target, prompt, updateMessageId, signal, index: calls.prompts.length - 1 });
      },
    },
  };
}

/** Build a bridge over one binding, returning everything a test needs. */
function bridgeFor(adapter, bindingOverrides = {}) {
  const bindings = new BindingStore(tempDir());
  bindings.put({
    channel: "feishu",
    chatKey: "oc_1",
    chatType: "p2p",
    sessionId: "sess-1",
    ownerKey: "ou_1",
    createdAt: 1,
    lastActiveAt: 1,
    ...bindingOverrides,
  });
  const harness = fakeContext();
  const bridge = new InteractionBridge(
    harness.ctx,
    new Map([[adapter.id, adapter]]),
    bindings,
    resolveConnectConfig({}),
  );
  return { bridge, harness, bindings };
}

test("registers both answerers with prepend: true", () => {
  const { adapter } = fakeAdapter();
  const { harness } = bridgeFor(adapter);
  for (const name of ["user-questions/request", "approval/request"]) {
    const entry = answerer(harness, name);
    // Without `prepend` the host's Web-GUI forwarder runs first and parks the
    // waterfall on a promise that never settles when no browser tab is
    // connected — the chat would never see the question at all. This is the
    // actual root cause of "the agent offered options and Feishu showed none".
    assert.deepEqual(entry.options, { prepend: true }, `${name} must be prepended`);
  }
});

test("a host without the event API degrades to no-ops instead of throwing", () => {
  const bindings = new BindingStore(tempDir());
  const ctx = {
    get() { return undefined; },
    effect(callback) { callback(); return () => undefined; },
    on() { throw new Error("no event bus on this host"); },
  };
  assert.doesNotThrow(() => new InteractionBridge(ctx, new Map(), bindings, resolveConnectConfig({})));
});

test("answers a question from the card and reports the option label", async () => {
  const { adapter, calls } = fakeAdapter({
    onPrompt: async () => ({ choice: "q:q1:1", messageId: "om_1" }),
  });
  const { bridge, harness } = bridgeFor(adapter);
  const answer = await answerer(harness, "user-questions/request").listener(
    {
      questions: [{ id: "q1", question: "Which one?", options: [{ label: "A" }, { label: "B" }] }],
      agent: { id: "sess-1" },
    },
    next,
  );
  assert.deepEqual(answer, { answers: [{ id: "q1", selected: ["B"] }] });
  // The card carries one option per choice id, numbered by position, so a tap
  // round-trips through `q:<questionId>:<index>` without any server-side state.
  assert.deepEqual(calls.prompts[0].prompt.options.map((o) => o.id), ["q:q1:0", "q:q1:1"]);
  assert.equal(calls.texts.at(-1), zh.answerReceived);
  assert.equal(bridge.pendingFor("oc_1"), false, "the chat is released after answering");
});

test("a session with no binding in this chat falls through to the host", async () => {
  const { adapter, calls } = fakeAdapter();
  const { harness } = bridgeFor(adapter);
  const answer = await answerer(harness, "user-questions/request").listener(
    { questions: [{ id: "q1", question: "?" }], agent: { id: "sess-other" } },
    next,
  );
  assert.equal(answer, NEXT);
  assert.equal(calls.prompts.length, 0, "an unowned session must never get a card");
});

test("a mirror-only session is claimed, but a channel that cannot present choices is not", async () => {
  const { adapter } = fakeAdapter({ onPrompt: async () => ({ choice: "q:q1:0", messageId: "om_1" }) });
  const { harness } = bridgeFor(adapter, { sessionId: "sess-active", webMirrorSessionId: "sess-1" });
  const mirrored = await answerer(harness, "user-questions/request").listener(
    { questions: [{ id: "q1", question: "?", options: [{ label: "A" }] }], agent: { id: "sess-1" } },
    next,
  );
  assert.deepEqual(mirrored, { answers: [{ id: "q1", selected: ["A"] }] });

  // The web mirror has no inbound face: its promptChoice resolves `undefined`
  // at once, so claiming a session for it would spin the re-present loop
  // forever on a card nobody can ever tap.
  const { adapter: web, calls } = fakeAdapter({ id: "web", supportsChoices: false });
  const second = bridgeFor(web, { channel: "web", chatKey: "web:sess-1", webMirrorSessionId: "sess-1" });
  const answer = await answerer(second.harness, "user-questions/request").listener(
    { questions: [{ id: "q1", question: "?", options: [{ label: "A" }] }], agent: { id: "sess-1" } },
    next,
  );
  assert.equal(answer, NEXT);
  assert.equal(calls.prompts.length, 0);
});

test("an already-cancelled request is handed straight back", async () => {
  const { adapter, calls } = fakeAdapter();
  const { harness } = bridgeFor(adapter);
  const controller = new AbortController();
  controller.abort();
  const answer = await answerer(harness, "user-questions/request").listener(
    { questions: [{ id: "q1", question: "?" }], agent: { id: "sess-1" }, signal: controller.signal },
    next,
  );
  assert.equal(answer, NEXT);
  assert.equal(calls.prompts.length, 0);
});

test("a failed card delivery falls through instead of stranding the question", async () => {
  const { adapter } = fakeAdapter({ onPrompt: async () => { throw new Error("chat not found"); } });
  const { bridge, harness } = bridgeFor(adapter);
  const answer = await answerer(harness, "user-questions/request").listener(
    { questions: [{ id: "q1", question: "?", options: [{ label: "A" }] }], agent: { id: "sess-1" } },
    next,
  );
  assert.equal(answer, NEXT);
  // The chat must be released: a leaked entry would silently swallow the user's
  // next message ("pendingFor" is what routes plain text into the answer flow).
  assert.equal(bridge.pendingFor("oc_1"), false);
});

test("cancelling the request mid-card unwinds the flow and falls through", async () => {
  const { adapter } = fakeAdapter({ onPrompt: untilAborted("om_1") });
  const { bridge, harness } = bridgeFor(adapter);
  const controller = new AbortController();
  const dispatched = answerer(harness, "user-questions/request").listener(
    { questions: [{ id: "q1", question: "?", options: [{ label: "A" }] }], agent: { id: "sess-1" }, signal: controller.signal },
    next,
  );
  await tick();
  assert.equal(bridge.pendingFor("oc_1"), true);
  controller.abort();
  assert.equal(await dispatched, NEXT);
  assert.equal(bridge.pendingFor("oc_1"), false);
});

test("an empty card id from the adapter never becomes the card to update", async () => {
  const { adapter, calls } = fakeAdapter({
    onPrompt: async ({ index }) => {
      // Round 1: the adapter reports no card id (it aborted before presenting).
      // The choice does not decode, so the loop retries in place immediately.
      if (index === 0) return { choice: "not-a-choice", messageId: "" };
      return { choice: "q:q1:0", messageId: "om_0" };
    },
  });
  const { harness } = bridgeFor(adapter);
  const answer = await answerer(harness, "user-questions/request").listener(
    { questions: [{ id: "q1", question: "?", options: [{ label: "A" }] }], agent: { id: "sess-1" } },
    next,
  );
  assert.deepEqual(answer, { answers: [{ id: "q1", selected: ["A"] }] });
  assert.equal(calls.prompts.length, 2);
  // "" would be read downstream as "there is a card to update" and every retry
  // would try to re-render a message that does not exist.
  assert.equal(calls.prompts[1].updateMessageId, undefined);
});

test("several questions are asked in turn, reusing one card", async () => {
  const { adapter, calls } = fakeAdapter({
    onPrompt: async ({ index }) => ({ choice: index === 0 ? "q:q1:0" : "q:q2:1", messageId: "om_7" }),
  });
  const { harness } = bridgeFor(adapter);
  const answer = await answerer(harness, "user-questions/request").listener(
    {
      questions: [
        { id: "q1", question: "First?", options: [{ label: "A" }, { label: "B" }] },
        { id: "q2", question: "Second?", options: [{ label: "C" }, { label: "D" }] },
      ],
      agent: { id: "sess-1" },
    },
    next,
  );
  assert.deepEqual(answer.answers, [
    { id: "q1", selected: ["A"] },
    { id: "q2", selected: ["D"] },
  ]);
  assert.equal(calls.prompts.length, 2);
  // The second question navigates the same card instead of stacking a new one.
  assert.equal(calls.prompts[1].updateMessageId, "om_7");
});

test("each question's card reports its own position in the sequence", async () => {
  // Reported bug: 「到第二个问题的时候，问题序号没更新」 — the second card still
  // read 「问题 1/2」. The step counter is derived from `interaction.current` at
  // the moment the prompt text is built, so reusing one card is exactly the case
  // where a stale value would hide: the update has to carry the *new* number.
  const { adapter, calls } = fakeAdapter({
    onPrompt: async ({ index }) => ({ choice: index === 0 ? "q:q1:0" : "q:q2:0", messageId: "om_7" }),
  });
  const { harness } = bridgeFor(adapter);
  await answerer(harness, "user-questions/request").listener(
    {
      questions: [
        { id: "q1", question: "First?", options: [{ label: "A" }, { label: "B" }] },
        { id: "q2", question: "Second?", options: [{ label: "C" }, { label: "D" }] },
      ],
      agent: { id: "sess-1" },
    },
    next,
  );

  assert.equal(calls.prompts.length, 2);
  assert.ok(
    calls.prompts[0].prompt.description.includes(zh.questionStep(1, 2)),
    `the first card must say 1/2; got ${JSON.stringify(calls.prompts[0].prompt.description)}`,
  );
  assert.ok(
    calls.prompts[1].prompt.description.includes(zh.questionStep(2, 2)),
    `the second card must say 2/2; got ${JSON.stringify(calls.prompts[1].prompt.description)}`,
  );
});

test("the last answer replaces the card with a done state instead of leaving live buttons", async () => {
  // Reported bug: after the final choice the buttons stayed on screen, so the
  // user could not tell the interaction had finished. An approval already closes
  // its card; a question with options did not, and a tap on a dead button is
  // absorbed as "expired" — which reads as the bot ignoring the user.
  const { adapter, calls } = fakeAdapter({
    onPrompt: async ({ index }) => ({ choice: index === 0 ? "q:q1:0" : "q:q2:0", messageId: "om_7" }),
  });
  const { harness } = bridgeFor(adapter);
  await answerer(harness, "user-questions/request").listener(
    {
      questions: [
        { id: "q1", question: "First?", options: [{ label: "A" }] },
        { id: "q2", question: "Second?", options: [{ label: "C" }] },
      ],
      agent: { id: "sess-1" },
    },
    next,
  );

  assert.ok(
    calls.closed.length > 0,
    "the card must be closed once every question is answered",
  );
  assert.equal(calls.closed[calls.closed.length - 1].messageId, "om_7");
});

test("a single-question card is closed too, not left waiting", async () => {
  // The one-question case is the common one, and it must not be a special case
  // that keeps its buttons.
  const { adapter, calls } = fakeAdapter({
    onPrompt: async () => ({ choice: "q:q1:0", messageId: "om_9" }),
  });
  const { harness } = bridgeFor(adapter);
  await answerer(harness, "user-questions/request").listener(
    {
      questions: [{ id: "q1", question: "Only?", options: [{ label: "A" }, { label: "B" }] }],
      agent: { id: "sess-1" },
    },
    next,
  );
  assert.ok(calls.closed.length > 0, "a single-question card must be closed after the tap");
  assert.equal(calls.closed[calls.closed.length - 1].messageId, "om_9");
});

test("a card that expires and is re-presented keeps the same question and its step number", async () => {
  // The card expires without a tap (the adapter answers `undefined`), the bridge
  // waits and presents again. Every one of those presentations must still describe
  // the question actually being asked.
  //
  // Scope note, so this test is not read as stronger than it is: with the current
  // design the step counter cannot advance *within* one `askOne` call, so this
  // cannot distinguish a rebuilt prompt from a hoisted one. It pins the observable
  // contract (repeats keep the right number) rather than the implementation, and the
  // rebuild in `askOne` is defensive — it removes the trap for a future change that
  // does advance the counter mid-question.
  let round = 0;
  const { adapter, calls } = fakeAdapter({
    onPrompt: async () => {
      round += 1;
      // First two rounds expire; the third is the tap.
      return round < 3
        ? { choice: undefined, messageId: "om_3" }
        : { choice: "q:q2:0", messageId: "om_3" };
    },
  });
  const { bridge, harness } = bridgeFor(adapter);
  const dispatched = answerer(harness, "user-questions/request").listener(
    {
      questions: [
        { id: "q1", question: "Free text?" },
        { id: "q2", question: "Pick one?", options: [{ label: "C" }, { label: "D" }] },
      ],
      agent: { id: "sess-1" },
    },
    next,
  );
  await tick();
  assert.equal(bridge.answerText("oc_1", "typed"), true);
  await dispatched;

  // Every presentation of question 2 carries 2/2 — including the repeats.
  assert.ok(calls.prompts.length >= 3, `expected repeats; got ${calls.prompts.length}`);
  for (const [i, call] of calls.prompts.entries()) {
    assert.ok(
      call.prompt.description.includes(zh.questionStep(2, 2)),
      `presentation ${i} lost the step number; got ${JSON.stringify(call.prompt.description)}`,
    );
  }
});

test("a text-answered question still advances the step count for the next card", async () => {
  // The mixed path, and the one most likely to leave a stale number: question 1 has
  // no options so it is answered by chat text (no card at all), and question 2 then
  // presents a card. That card must say 2/2, not 1/2 — the counter is shared across
  // both answer styles, so it has to advance on the text path too.
  const { adapter, calls } = fakeAdapter({
    onPrompt: async () => ({ choice: "q:q2:0", messageId: "om_5" }),
  });
  const { bridge, harness } = bridgeFor(adapter);
  const dispatched = answerer(harness, "user-questions/request").listener(
    {
      questions: [
        { id: "q1", question: "Free text?" },
        { id: "q2", question: "Pick one?", options: [{ label: "C" }, { label: "D" }] },
      ],
      agent: { id: "sess-1" },
    },
    next,
  );
  await tick();
  assert.equal(bridge.answerText("oc_1", "my typed answer"), true);
  const answer = await dispatched;

  assert.deepEqual(answer.answers, [
    { id: "q1", selected: [], custom: "my typed answer" },
    { id: "q2", selected: ["C"] },
  ]);
  assert.equal(calls.prompts.length, 1, "only the second question presents a card");
  assert.ok(
    calls.prompts[0].prompt.description.includes(zh.questionStep(2, 2)),
    `the card after a text-answered first question must say 2/2; got ${JSON.stringify(calls.prompts[0].prompt.description)}`,
  );
});

test("a tap aimed at an already-answered question is accepted, not dropped", async () => {
  // A reused card can deliver a tap after the bridge has moved on: the user aims at
  // the option still on screen while the next question is already current. Treating
  // that as an unrecognised id discarded a real answer and left the flow waiting on
  // a question the user believed they had just answered — with a card that never
  // changed, which is indistinguishable from a freeze.
  let round = 0;
  const { adapter } = fakeAdapter({
    onPrompt: async () => {
      round += 1;
      // Round 1: answer q1. Round 2: deliver q1's id AGAIN (the stale-card tap),
      // which must be recorded rather than discarded. Round 3: answer q2.
      if (round === 1) return { choice: "q:q1:0", messageId: "om_7" };
      if (round === 2) return { choice: "q:q1:1", messageId: "om_7" };
      return { choice: "q:q2:0", messageId: "om_7" };
    },
  });
  const { harness } = bridgeFor(adapter);
  const answer = await answerer(harness, "user-questions/request").listener(
    {
      questions: [
        { id: "q1", question: "First?", options: [{ label: "A" }, { label: "B" }] },
        { id: "q2", question: "Second?", options: [{ label: "C" }] },
      ],
      agent: { id: "sess-1" },
    },
    next,
  );
  assert.deepEqual(answer.answers, [
    { id: "q1", selected: ["A"] },
    { id: "q2", selected: ["C"] },
  ]);
});

test("a genuinely unrecognised tap tells the user instead of looping in silence", async () => {
  // The failure mode that reads as "the bot is stuck": the adapter returns a choice
  // no option matches, the loop re-presents the identical card, and nothing is said.
  // One notice is posted so the user knows the tap did not register and is told how
  // to get through (reply with the number or text).
  let round = 0;
  const { adapter, calls } = fakeAdapter({
    onPrompt: async () => {
      round += 1;
      return round === 1
        ? { choice: "q:bogus:9", messageId: "om_1" }
        : { choice: "q:q1:0", messageId: "om_1" };
    },
  });
  const { harness } = bridgeFor(adapter);
  const answer = await answerer(harness, "user-questions/request").listener(
    { questions: [{ id: "q1", question: "Pick?", options: [{ label: "A" }] }], agent: { id: "sess-1" } },
    next,
  );
  assert.deepEqual(answer.answers, [{ id: "q1", selected: ["A"] }]);
  assert.ok(
    calls.texts.some((t) => t.includes(zh.answerNotRecognised)),
    `the user must be told the tap did not register; sent ${JSON.stringify(calls.texts)}`,
  );
});

test("an option-free question is answered by a plain chat message", async () => {
  const { adapter, calls } = fakeAdapter();
  const { bridge, harness } = bridgeFor(adapter);
  const dispatched = answerer(harness, "user-questions/request").listener(
    { questions: [{ id: "q1", question: "在哪个目录？" }], agent: { id: "sess-1" } },
    next,
  );
  // The bridge cannot block on the host: it advertises the text prompt and then
  // parks on `answerText`, which the service calls for every non-command message.
  let accepted = false;
  for (let i = 0; i < 50 && !accepted; i += 1) {
    accepted = bridge.answerText("oc_1", "D:\\projects\\demo");
    if (!accepted) await tick();
  }
  assert.equal(accepted, true);
  assert.equal(calls.texts[0], zh.questionTextHint("在哪个目录？"));
  assert.deepEqual(await dispatched, { answers: [{ id: "q1", selected: [], custom: "D:\\projects\\demo" }] });
});

test("a text reply unblocks a question whose card never resolves", async () => {
  // THE REPORTED FREEZE: 「卡在第一个问题，一直不动」「怎么选，都不会变」.
  // `askOne` awaited `promptChoice` and nothing else, so if the card never
  // resolved — unresponsive buttons, a lost tap, an adapter that never calls back —
  // the loop sat inside that one await forever. A typed answer was recorded into
  // `answers` but nothing ever looked, so the user's one remaining escape route did
  // nothing at all. The card and the text path are two ways to answer one question,
  // and they now race.
  const { adapter } = fakeAdapter({
    // Never resolves from a tap: this is the stuck card.
    onPrompt: async ({ signal }) => new Promise((resolve) => {
      signal.addEventListener("abort", () => resolve({ choice: undefined, messageId: "om_stuck" }), { once: true });
    }),
  });
  const { bridge, harness } = bridgeFor(adapter);
  const dispatched = answerer(harness, "user-questions/request").listener(
    { questions: [{ id: "q1", question: "Pick?", options: [{ label: "A" }, { label: "B" }] }], agent: { id: "sess-1" } },
    next,
  );
  await tick();
  assert.equal(bridge.pendingFor("oc_1"), true, "the question must be pending");

  // The user types the answer because tapping does nothing.
  assert.equal(bridge.answerText("oc_1", "A"), true);

  // Must complete rather than hang: the assertion is that this promise settles.
  const answer = await dispatched;
  assert.deepEqual(answer.answers, [{ id: "q1", selected: ["A"] }]);
  assert.equal(bridge.pendingFor("oc_1"), false, "the interaction must be released");
});

test("an unanswered question presents its card once, not once per timeout", async () => {
  // THE REPORTED SPAM: the same 「需要你的选择（问题 1/2）」 card arrived over and over.
  //
  // The card was presented *inside* the wait loop, and that loop is driven by a
  // 5-second timeout whose only job is to notice a typed answer. So every 5 seconds
  // the loop went round, presented again, and the user got another copy of a card
  // they had already decided not to tap. The timeout was never meant to re-send
  // anything; presenting once and keeping that promise across iterations is the fix.
  const { adapter, calls } = fakeAdapter({ onPrompt: untilAborted("om_once") });
  const { bridge, harness } = bridgeFor(adapter);
  const dispatched = answerer(harness, "user-questions/request").listener(
    { questions: [{ id: "q1", question: "Pick?", options: [{ label: "A" }, { label: "B" }] }], agent: { id: "sess-1" } },
    next,
  );
  await tick();

  // Hold for well over two ANSWER_RACE_MS windows (5 s each) with no answer given.
  await new Promise((resolve) => setTimeout(resolve, 12_000));

  assert.equal(
    calls.prompts.length,
    1,
    `the card must be presented exactly once while unanswered; it was presented ${calls.prompts.length} times`,
  );
  assert.equal(bridge.pendingFor("oc_1"), true, "the question must still be waiting");

  // And the escape route still works: a typed answer unblocks it.
  assert.equal(bridge.answerText("oc_1", "B"), true);
  const answer = await dispatched;
  assert.deepEqual(answer.answers, [{ id: "q1", selected: ["B"] }]);
  assert.equal(bridge.pendingFor("oc_1"), false);
});

test("answerText declines when the chat is only waiting on an approval", async () => {
  const { adapter, calls } = fakeAdapter({ onPrompt: untilAborted("om_1") });
  const { bridge, harness } = bridgeFor(adapter);
  const controller = new AbortController();
  const dispatched = answerer(harness, "approval/request").listener(
    { agent: { id: "sess-1" }, toolName: "bash", signal: controller.signal },
    next,
  );
  await tick();
  assert.equal(bridge.pendingFor("oc_1"), true);
  // A tap is the only answer an approval accepts; a chat message must not be
  // recorded as one.
  assert.equal(bridge.answerText("oc_1", "ok"), false);
  assert.equal(calls.prompts.length, 1);
  controller.abort();
  await dispatched;
});

test("approval: an allow tap returns allowed-once and closes the buttons", async () => {
  const { adapter, calls } = fakeAdapter({ onPrompt: async () => ({ choice: "approval:allow", messageId: "om_9" }) });
  const { bridge, harness } = bridgeFor(adapter);
  const outcome = await answerer(harness, "approval/request").listener(
    { agent: { id: "sess-1" }, toolName: "bash", reason: "run tests" },
    next,
  );
  assert.equal(outcome, "allowed-once");
  assert.deepEqual(calls.closed, [{ messageId: "om_9", summary: zh.approvalDone("allowed-once", "bash") }]);
  assert.equal(bridge.pendingFor("oc_1"), false);
});

test("approval: a reject tap returns rejected", async () => {
  const { adapter } = fakeAdapter({ onPrompt: async () => ({ choice: "approval:reject", messageId: "om_9" }) });
  const { harness } = bridgeFor(adapter);
  const outcome = await answerer(harness, "approval/request").listener(
    { agent: { id: "sess-1" }, toolName: "bash" },
    next,
  );
  assert.equal(outcome, "rejected");
});

test("approval decided after the host gave up falls through, with a stale notice", async () => {
  const { adapter, calls } = fakeAdapter({
    // The tap lands at the same moment the host cancels: the card resolves with
    // the user's choice, but the request is already dead.
    onPrompt: ({ signal }) => new Promise((resolve) => {
      signal.addEventListener("abort", () => resolve({ choice: "approval:allow", messageId: "om_9" }), { once: true });
    }),
  });
  const { bridge, harness } = bridgeFor(adapter);
  const controller = new AbortController();
  const dispatched = answerer(harness, "approval/request").listener(
    { agent: { id: "sess-1" }, toolName: "bash", signal: controller.signal },
    next,
  );
  await tick();
  controller.abort();
  assert.equal(await dispatched, NEXT);
  // Silence here is what makes a user believe the tool ran. Say it did not.
  assert.deepEqual(calls.closed, [{ messageId: "om_9", summary: zh.approvalStale }]);
  assert.equal(bridge.pendingFor("oc_1"), false);
});

test("a second request in the same chat is not claimed while one is pending", async () => {
  const { adapter } = fakeAdapter({ onPrompt: untilAborted("om_1") });
  const { harness } = bridgeFor(adapter);
  const first = new AbortController();
  const firstRun = answerer(harness, "user-questions/request").listener(
    { questions: [{ id: "q1", question: "?", options: [{ label: "A" }] }], agent: { id: "sess-1" }, signal: first.signal },
    next,
  );
  await tick();
  // One card at a time: a second prompt in the same chat would fight the first
  // over the same card and leave the user answering the wrong question.
  const second = await answerer(harness, "user-questions/request").listener(
    { questions: [{ id: "q2", question: "?", options: [{ label: "A" }] }], agent: { id: "sess-1" } },
    next,
  );
  assert.equal(second, NEXT);
  first.abort();
  await firstRun;
});
