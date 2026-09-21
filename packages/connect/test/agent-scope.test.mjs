/**
 * The streaming reply rests on one non-obvious host guarantee: a listener
 * registered on `agent.ctx` receives `agent/assistant-stream` frames for *that
 * agent only*.
 *
 * That matters more now than it used to. `Session.events` and the
 * `assistant/chunk` session event type were both removed in DSH `0.1.5-rc.2`, so
 * this scope-filtered event is the sole live feed for model deltas. If the
 * filtering ever stops, every bridge in the process starts rendering every other
 * chat's tokens into its own card — a failure that looks like garbage output
 * rather than a crash.
 *
 * The guarantee is not a documented API; it falls out of `dsh-scope`:
 * `Agent.ctx` is `createScope(loopCtx, agent).ctx`, the scope key is the agent
 * *object itself*, and cordis drops any listener whose context carries a scope
 * tag that is not on the dispatching carrier's ancestry chain. These tests pin
 * that behaviour against the installed host version, so a host upgrade that
 * changes it fails here rather than in a chat window.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { Context } from "@deepseek-ai/cordis";
import { agentEvents } from "@deepseek-ai/dsh-agent";
import { createScope, scopeOf } from "@deepseek-ai/dsh-scope";

/** A `chunk` frame shaped like the ones `dsh-agent-loop` publishes. */
function chunkFrame(text) {
  return {
    type: "chunk",
    attemptId: 1,
    revision: 1,
    index: 0,
    time: 0,
    chunk: { type: "text-delta", index: 0, text },
  };
}

/** Stand-in for the `ReactLoopAgent` instance, which is all the scope key is. */
function makeAgent(id) {
  return { id };
}

/**
 * Build a root context plus two independently scoped agents, mirroring how the
 * loop constructs them (`createScope(loopCtx, this)`) and how it publishes
 * (`agentEvents(loopCtx, this)`).
 */
function makeRig(t) {
  const root = new Context();
  const agentA = makeAgent("a");
  const agentB = makeAgent("b");
  const scopeA = createScope(root, agentA);
  const scopeB = createScope(root, agentB);
  // Dispose the scopes so the derived fibers do not outlive the test. The root
  // context is a bare `new Context()` and owns no resources of its own.
  t.after(() => {
    scopeA.rawDispose();
    scopeB.rawDispose();
  });
  return { root, agentA, agentB, ctxA: scopeA.ctx, ctxB: scopeB.ctx };
}

test("agent.ctx is scoped to the agent object itself", (t) => {
  const { agentA, ctxA } = makeRig(t);
  // The key is the agent instance, compared by identity — not its id string.
  assert.equal(scopeOf(ctxA), agentA);
});

test("a listener on agent.ctx receives that agent's assistant-stream frames", (t) => {
  const { root, agentA, ctxA } = makeRig(t);
  const seen = [];
  ctxA.on("agent/assistant-stream", ({ frame }) => seen.push(frame.chunk.text));

  agentEvents(root, agentA).emit("agent/assistant-stream", { frame: chunkFrame("hello") });

  assert.deepEqual(seen, ["hello"]);
});

test("...and does not receive another agent's frames", (t) => {
  const { root, agentA, agentB, ctxA, ctxB } = makeRig(t);
  const seenA = [];
  const seenB = [];
  ctxA.on("agent/assistant-stream", ({ frame }) => seenA.push(frame.chunk.text));
  ctxB.on("agent/assistant-stream", ({ frame }) => seenB.push(frame.chunk.text));

  // B's dispatch reaches B only. The second assertion keeps the rig honest:
  // without it, a rig that simply never fires would pass this test too.
  agentEvents(root, agentB).emit("agent/assistant-stream", { frame: chunkFrame("not mine") });
  assert.deepEqual(seenA, [], "frames leaked across agents — the bridge would render another chat's tokens");
  assert.deepEqual(seenB, ["not mine"]);

  agentEvents(root, agentA).emit("agent/assistant-stream", { frame: chunkFrame("mine") });
  assert.deepEqual(seenA, ["mine"]);
  assert.deepEqual(seenB, ["not mine"], "B must not pick up A's frames either");
});
