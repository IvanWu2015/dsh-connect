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
