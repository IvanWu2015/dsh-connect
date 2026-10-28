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
import { afterEach, test } from "node:test";
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
  /**
   * Teardown functions registered through `ctx.effect`.
   *
   * Cordis runs these when the plugin unloads. The bridge uses one to settle every pending
   * interaction, and ignoring it is why the suite used to hang after its assertions passed:
   * an unanswered question kept its re-present loop (and its timers) alive for ever.
   * `dispose()` lets a test wind that down the way the host does.
   */
  const disposers = [];
  afterEach(() => {
    // Running the registered teardowns is what settles pending interactions: the bridge's
    // own `ctx.effect` teardown aborts every in-flight card, so its re-present loop unwinds
    // instead of keeping the process alive.
    for (const d of disposers.splice(0)) {
      try { d?.(); } catch { /* a teardown failure must not mask the real result */ }
    }
  });
  return {
    listeners,
    /** No bridge registry: the bridge's own effect teardown is what has to run. */
    track() {},
    ctx: {
      get() { return undefined; },
      effect(callback) {
        const dispose = callback();
        const fn = () => { dispose?.(); };
        disposers.push(fn);
        return fn;
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
function fakeAdapter({ id = "feishu", supportsChoices, onPrompt, holdPrompts = false } = {}) {
  const calls = { prompts: [], texts: [], closed: [] };
  /**
   * Prompts held open by the test, so a tap can be delivered at a chosen moment.
   *
   * The cooldown only arms after several expiries, and waiting out a real 15-minute backoff
   * in a test is not acceptable — so the adapter has to be able to answer late, the way a
   * user who returns and taps the expired card does.
   */
  const held = { resolvers: [] };
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
      async promptChoice(target, prompt, updateMessageId, signal, onPresented) {
        calls.prompts.push({ target, prompt, updateMessageId, signal, quiet: prompt.quiet === true });
        if (holdPrompts) {
          // Stays pending until the test taps, so a returning user's tap is what settles it.
          return new Promise((resolve) => { held.resolvers.push(resolve); });
        }
        if (onPrompt === undefined) return { choice: undefined, messageId: "" };
        return onPrompt({
          target, prompt, updateMessageId, signal, onPresented,
          index: calls.prompts.length - 1,
        });
      },
      /** Resolve the most recent prompt with a tap, as a returning user would. */
      tap(choice) {
        const resolve = held.resolvers.at(-1);
        if (resolve === undefined) return false;
        resolve({ choice, messageId: "om_exp" });
        return true;
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
    // A question raised while a chat binding is in play is, by construction, a turn that
    // chat drove -- that is the only way this package hears about a message. Routing now
    // requires that signal (see claimTarget), so the single-surface default must report it;
    // tests about the signal itself pass their own resolver.
    () => true,
  );
  harness.track(bridge);
  return { bridge, harness, bindings };
}

/**
 * A bridge over a session reachable from TWO surfaces at once.
 *
 * This is the real shape of the reported problem: one session, a Feishu chat and its Web
 * GUI mirror, both valid targets. Which one gets the question used to depend on the order
 * the binding store happened to list them in.
 */
function twoSurfaceBridge({ driving }) {
  const bindings = new BindingStore(tempDir());
  // Feishu first, deliberately: it is what the store lists first, so order alone would
  // always pick it.
  bindings.put({
    channel: "feishu",
    chatKey: "oc_1",
    chatType: "p2p",
    sessionId: "sess-1",
    webMirrorSessionId: "sess-1",
    ownerKey: "ou_1",
    createdAt: 1,
    lastActiveAt: 2,
  });
  bindings.put({
    channel: "web",
    chatKey: "web-1",
    chatType: "p2p",
    sessionId: "sess-1",
    ownerKey: "ou_1",
    createdAt: 2,
    lastActiveAt: 1,
  });
  const feishu = fakeAdapter({ id: "feishu", onPrompt: async () => ({ choice: undefined, messageId: "om_f" }) });
  // Held open so the routing tests can answer after asserting where the question went.
  const web = fakeAdapter({ id: "web", holdPrompts: true });
  const harness = fakeContext();
  const bridge = new InteractionBridge(
    harness.ctx,
    new Map([["feishu", feishu.adapter], ["web", web.adapter]]),
    bindings,
    resolveConnectConfig({}),
    driving,
  );
  harness.track(bridge);
  return { bridge, harness, feishu, web };
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

test("a tap on the expired card redraws it at once, without waiting the backoff", async () => {
  // The reported shape: 「菜单过期，不会重新刷新，一段时间回来后，卡在那里」. A user returns to
  // an expired card and taps it. That tap is the clearest possible "I am back" — it must
  // revive the question immediately, not leave them waiting out a backoff that was taken
  // while nobody was here.
  // The first five presentations expire, which arms the cooldown. The tap must arrive AFTER
  // that — otherwise the question is still in its fast phase and needs no reviving, and the
  // test would pass with or without the fix (which it did, on the first attempt).
  const { adapter, calls } = fakeAdapter({ holdPrompts: true });
  const { bridge, harness } = bridgeFor(adapter);
  const dispatched = answerer(harness, "user-questions/request").listener(
    { questions: [{ id: "q1", question: "Pick?", options: [{ label: "A" }] }], agent: { id: "sess-1" } },
    next,
  );

  // Expire five ROUNDS to arm the cooldown. It is EXPIRY (an undefined choice) that advances
  // the counter — a stale tap does not — so a test that tapped to advance would measure
  // nothing, which is exactly what the first attempt did.
  const deadline = Date.now() + 20_000;
  /** Tap the current pending round and wait for the NEXT one to appear. */
  const advance = async (choice) => {
    const before = calls.prompts.length;
    assert.equal(adapter.tap(choice), true, "each expiry must reach the pending prompt");
    while (Date.now() < deadline && calls.prompts.length === before) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return calls.prompts.length > before;
  };
  for (let i = 0; i < 5 && Date.now() < deadline; i += 1) await advance(undefined);
  // Armed: the most recent round must be a quiet one (listening, not repainting).
  assert.ok(calls.prompts.length >= 5, `the budget must be spent first; rounds=${calls.prompts.length}`);

  // The cooldown is now armed, so rounds are QUIET: the bridge keeps listening but stops
  // rewriting the card. That is what makes the next assertion meaningful — counting rounds
  // would pass with or without the fix, because quiet rounds keep arriving either way.
  const repaints = () => calls.prompts.filter((p) => p.quiet !== true).length;
  await advance(undefined);
  const repairsBefore = repaints();
  assert.ok(
    calls.prompts.at(-1).quiet === true,
    "the cooldown must have armed, so the latest round is quiet",
  );

  // Tapping the expired card proves the user is back: the repaint must resume at once,
  // without waiting out a backoff taken while nobody was here.
  assert.equal(adapter.tap("q:q1:99"), true, "the tap must reach the pending prompt");
  while (Date.now() < deadline && repaints() <= repairsBefore) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(
    repaints() > repairsBefore,
    `a tap must redraw the card at once; repaints still ${repaints()}`,
  );

  // Still answerable, and clean up so the process can exit.
  assert.equal(bridge.answerText("oc_1", "A"), true);
  await dispatched;
});

test("an abandoned question slows its redraws instead of going dead", async () => {
  // Reported both ways, a few days apart:
  //   「有一个需要人工处理的选择，但人没在，造成不断的在刷新按钮」 — stop the flood;
  //   「菜单过期，不会重新刷新，一段时间回来后，卡在那里」 — but do not go dead either.
  //
  // The one-way budget satisfied the first and caused the second: after five redraws the
  // flag never cleared, so the card expired and stayed expired forever.
  //
  // A cooldown satisfies both. This asserts the SLOWING, and that the question still waits
  // and can still be answered.
  const { adapter, calls } = fakeAdapter({
    // Every presentation expires unanswered, which is what drives the re-present loop.
    onPrompt: async () => ({ choice: undefined, messageId: "om_exp" }),
  });
  const { bridge, harness } = bridgeFor(adapter);
  let settled = false;
  const dispatched = answerer(harness, "user-questions/request")
    .listener(
      { questions: [{ id: "q1", question: "Pick?", options: [{ label: "A" }] }], agent: { id: "sess-1" } },
      next,
    )
    .finally(() => { settled = true; });

  // The guarantee is the RATE, not a stop: the first few expiries redraw promptly, then the
  // interval widens. An unthrottled loop would keep presenting at full speed through both
  // windows; a permanently-dead one would present no more at all after the budget.
  // Count REPAINTS, not presentations: since the cooldown fix the bridge keeps presenting
  // during the cooldown (so taps are still heard) but marks those rounds `quiet`, and a quiet
  // round does not rewrite the card. Repaints are what the user sees and what the flood was.
  const repaints = () => calls.prompts.filter((p) => p.quiet !== true).length;
  await new Promise((resolve) => setTimeout(resolve, 9_000));
  const afterFirstWindow = repaints();
  await new Promise((resolve) => setTimeout(resolve, 4_000));
  const afterSecondWindow = repaints();

  assert.ok(afterFirstWindow >= 2, `the card must be redrawn at least once; got ${afterFirstWindow}`);
  // Slowed, not stopped: the first window is busy, the second adds at most one more.
  const grew = afterSecondWindow - afterFirstWindow;
  assert.ok(
    grew <= 1,
    `redraws must slow down once the question is clearly unanswered; grew by ${grew} (${afterFirstWindow} -> ${afterSecondWindow})`,
  );
  assert.equal(settled, false, "the question must still be waiting");
  assert.equal(bridge.pendingFor("oc_1"), true, "the interaction must still be pending");
  // The bound stops repainting, not waiting: a typed answer still lands.
  assert.equal(bridge.answerText("oc_1", "A"), true);

  // Let the flow finish. Without this the interaction's re-present timer and its pending
  // waiter outlive the test, which keeps the whole process alive and makes the suite look
  // hung when it has actually passed.
  await dispatched;
});

test("a question goes to the surface the user is typing in, not the first binding", async () => {
  // Reported: 「我直接在PC端上发内容，但提问的按钮并没有在PC端显示，而是去到了飞书…应该在哪个
  // 客户端发起，就在哪问按钮，要不然卡死了又不能操作」.
  //
  // One session, two surfaces. The request carries no origin of its own, so the bridge used
  // to take whichever binding the store listed first — which is Feishu — and a question
  // raised from the PC arrived in chat, where the user was not looking.
  //
  // The reliable signal is which runner is mid-turn: the surface the message came from.
  const { bridge, harness, web } = twoSurfaceBridge({ driving: (channel) => channel === "web" });
  const dispatched = answerer(harness, "user-questions/request").listener(
    { questions: [{ id: "q1", question: "Pick?", options: [{ label: "A" }] }], agent: { id: "sess-1" } },
    next,
  );
  await new Promise((resolve) => setTimeout(resolve, 50));

  // It must be presented on the web surface, and not on Feishu.
  assert.equal(bridge.pendingFor("web-1"), true, "the question must be claimed by the Web surface");
  assert.equal(bridge.pendingFor("oc_1"), false, "Feishu must not be claimed");

  // Answer it before returning. Leaving the waterfall promise pending leaves node:test
  // waiting on a promise that can never settle -- the suite then never exits, with zero live
  // handles, which is exactly the CI failure "Promise resolution is still pending but the
  // event loop has already resolved".
  assert.equal(web.adapter.tap("q:q1:0"), true, "the holding adapter must accept the tap");
  const answer = await dispatched;
  assert.deepEqual(answer.answers, [{ id: "q1", selected: ["A"] }]);
});

test("a question from a turn no chat is driving falls through to the host", async () => {
  // The reported case, twice: 「我直接在PC端上发内容，但提问的按钮…去到了飞书」.
  //
  // A turn started in the desktop Web GUI never passes through a channel adapter, so no
  // runner is driving it. Claiming a binding anyway — which the previous fallback did — took
  // the question to Feishu, where the user was not looking. Worse, claiming it also stops the
  // host from rendering its own question UI, so the desktop user saw nothing at all.
  //
  // With nothing driving, the request must be handed straight back: `next()` is what lets
  // the GUI show the question in the window the user is actually typing in.
  const { bridge, harness } = twoSurfaceBridge({ driving: () => false });
  const answer = await answerer(harness, "user-questions/request").listener(
    { questions: [{ id: "q1", question: "Pick?", options: [{ label: "A" }] }], agent: { id: "sess-1" } },
    next,
  );
  assert.equal(answer, NEXT, "the request must fall through to the host");
  assert.equal(bridge.pendingFor("oc_1"), false, "Feishu must not be claimed");
  assert.equal(bridge.pendingFor("web-1"), false, "nor the web mirror, which cannot present");
});

test("the card is closed before the acknowledgement is sent", async () => {
  // Reported: 「已经明确收到 ✅ 已收到你的回答…这时候就应该主动关闭前面那个按钮选择的位置」.
  // The acknowledgement is what the user reads as "the answer landed", so by the time it
  // appears the buttons must already be gone — otherwise the two contradict each other
  // for as long as the close takes to land.
  //
  // Order, not presence: a close that runs *after* the acknowledgement still satisfies a
  // "the card was closed" assertion, while showing the user exactly the confusing pair of
  // states this is about.
  const order = [];
  const { adapter } = fakeAdapter({ onPrompt: async () => ({ choice: "q:q1:0", messageId: "om_1" }) });
  const originalClose = adapter.closeMenu.bind(adapter);
  const originalSend = adapter.sendText.bind(adapter);
  adapter.closeMenu = async (messageId, summary) => {
    order.push("close");
    return originalClose(messageId, summary);
  };
  adapter.sendText = async (target, text) => {
    order.push("text:" + String(text).slice(0, 10));
    return originalSend(target, text);
  };

  const { harness } = bridgeFor(adapter);
  await answerer(harness, "user-questions/request").listener(
    { questions: [{ id: "q1", question: "Pick?", options: [{ label: "A" }] }], agent: { id: "sess-1" } },
    next,
  );

  const closeAt = order.indexOf("close");
  const ackAt = order.findIndex((entry) => entry.startsWith("text:") && entry.includes("已收到"));
  assert.ok(closeAt >= 0, `the card must be closed; order=${JSON.stringify(order)}`);
  assert.ok(ackAt >= 0, `the acknowledgement must be sent; order=${JSON.stringify(order)}`);
  assert.ok(closeAt < ackAt, `the close must precede the acknowledgement; order=${JSON.stringify(order)}`);
});

test("a question answered by text also has its buttons closed", async () => {
  // Reported: 「用户已经选择完的情况，关闭掉这个按钮菜单，要不然用户容易再误点」.
  //
  // The tap path closes the card. The *text* path is the one that can be forgotten: the
  // answer is recorded without any card interaction, so if the close only happened where
  // a tap was decoded, the user would answer by typing and still be looking at live
  // buttons for a question that is already settled — and tapping one is absorbed
  // silently, so it appears to do nothing rather than tell them it is over.
  const { adapter, calls } = fakeAdapter({
    onPrompt: async ({ signal, onPresented }) => new Promise((resolve) => {
      // What the real adapter does: it knows the card id as soon as the card is sent,
      // well before any tap arrives.
      onPresented?.("om_txt");
      signal.addEventListener("abort", () => resolve({ choice: undefined, messageId: "om_txt" }), { once: true });
    }),
  });
  const { bridge, harness } = bridgeFor(adapter);
  const dispatched = answerer(harness, "user-questions/request").listener(
    { questions: [{ id: "q1", question: "Pick?", options: [{ label: "A" }, { label: "B" }] }], agent: { id: "sess-1" } },
    next,
  );
  await tick();

  assert.equal(bridge.answerText("oc_1", "B"), true);
  const answer = await dispatched;
  assert.deepEqual(answer.answers, [{ id: "q1", selected: ["B"] }]);

  assert.ok(
    calls.closed.length > 0,
    `a text-answered card must be closed too; closed=${JSON.stringify(calls.closed)}`,
  );
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
