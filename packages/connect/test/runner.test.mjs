/**
 * The bridge core: `ConnectService` routing + `AgentRunner`'s turn.
 *
 * Coverage used to stop at the settings stack (rpc 94%, credential-store 97%)
 * while the code that actually carries a chat message was nearly untouched —
 * `runner.js` sat at 9.1%. Every assertion here runs the *production* path
 * between two fakes: a recording adapter on one end, a scripted agent on the
 * other, and in between the real allowlist, dedup window, binding store, mirror
 * lock, `ensureAgent`, `driveAgent`, `summarizeTurn`, `sendTurnStats` and
 * `sendSummary`. No network, no model key, no host process.
 *
 * Four groups, each pinning a contract that would otherwise only be discovered
 * in production:
 *
 *   A — the mirror lock: who may write, who gets queued, who is told to wait,
 *       and what a timed-out lock does. (`feishu` here means "a channel with a
 *       Web mirror"; `stub` stands for Telegram/DingTalk, which have none.)
 *   B — a failing turn still answers the user and still frees the lock.
 *   C — what is *not* reported: a non-completed turn reports its output once,
 *       and a silent turn reports nothing at all.
 *   D — session lifecycle: reuse a live session, create one for a fresh chat,
 *       re-create when the binding points at a session that no longer exists.
 *   E — per-chat overrides win over the plugin config.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { cards, makeBridge, scriptedAgent, texts, waitFor } from "./bridge-harness.mjs";

// `ConnectService` merges `dsh.shared.config.json` *over* the config it is
// given, and the shared file wins. This repo has one (it pins `stateDir` to
// `.dsh-connect`), so a bridge built from inside the repo would write every
// binding into `packages/connect/.dsh-connect` no matter what `stateDir` the
// test asks for — state leaking between runs, and a test that "passes" against
// the wrong files. `makeBridge` refuses to run in that case instead of writing
// somewhere else, so the suite chdirs out of the repo first. `node --test` runs
// each file in its own process, so this chdir cannot affect any other suite.
const sandbox = mkdtempSync(join(tmpdir(), "dsh-connect-runner-sandbox-"));
process.chdir(sandbox);
// The sandbox itself has no back-reference from any bridge (each owns a nested
// dir), so nothing else will ever remove it. `maxRetries`/`retryDelay` are not
// optional on Windows: a file handle an antivirus scan still holds makes the
// first unlink fail. The chdir is not cosmetic either — Windows returns EPERM
// for a process's own working directory, so the sandbox must be let go first.
process.on("exit", () => {
  try {
    process.chdir(tmpdir());
  } catch {
    /* nothing left to do but try the unlink anyway */
  }
  rmSync(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

/**
 * Build a bridge for one test, then tear it down and delete its state dir
 * whatever happens. `dispose()` is not tidiness: the binding store flushes on a
 * timer, so a live service happily rewrites `bindings.json` minutes later —
 * including after the directory has been deleted.
 */
async function withBridge(options, body) {
  const bridge = await makeBridge({
    stateDir: mkdtempSync(join(tmpdir(), "dsh-connect-runner-")),
    language: "en",
    ...options,
  });
  try {
    return await body(bridge);
  } finally {
    await bridge.dispose();
    // The specific directory the harness reported, never a glob: this is a
    // shared temp root.
    rmSync(bridge.stateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

/**
 * A binding as the store would have persisted it: a chat that has already seen
 * the welcome card (so the card assertions below are not diluted by it) and
 * that has no session yet.
 *
 * `sessionId: ""` is the shape a genuinely fresh chat has — `maybeSendWelcome`
 * persists exactly this before `ensureAgent` runs — and it is what makes the
 * runner attempt to resume the empty id, miss, and fall through to `create`.
 */
function bindingFor(channel, chatKey, overrides = {}) {
  const now = Date.now();
  return {
    channel,
    chatKey,
    chatType: "p2p",
    sessionId: "",
    ownerKey: "user-1",
    createdAt: now,
    lastActiveAt: now,
    welcomedAt: now,
    sessions: [],
    ...overrides,
  };
}

let replySeq = 0;
/** One inbound message. The reply ref must be unique per chat — it is the dedup key. */
function inboundFor(channel, chatKey, overrides = {}) {
  replySeq += 1;
  return {
    channel,
    chatKey,
    chatType: "p2p",
    senderKey: "user-1",
    text: `message on ${chatKey}`,
    replyRef: `${channel}-${chatKey}-${replySeq}`,
    ...overrides,
  };
}

/** Let a detached turn finish whatever it had already started. */
const settle = (ms = 100) => new Promise((resolve) => setTimeout(resolve, ms));

/** The acknowledgement is always the first text a turn emits. */
const EN_ACK = "✅ Received — starting to process";

// ---------------------------------------------------------------------------
// A. The mirror lock
// ---------------------------------------------------------------------------

test("A1 web message while feishu holds a live lock: queued, not run", () =>
  withBridge({}, async (bridge) => {
    const adapter = bridge.addAdapter("web");
    bridge.seedBinding(
      bindingFor("web", "chat-queued", {
        lockOwner: "feishu",
        lockAcquiredAt: Date.now(),
        lockTimeoutMs: 60 * 60_000,
      }),
    );

    await bridge.inbound(inboundFor("web", "chat-queued"));
    await waitFor(() => texts(adapter).length > 0, 5_000);
    await settle();

    assert.deepEqual(
      texts(adapter).map((m) => m.text),
      ["📥 Message queued (position 1), will execute after lock release"],
      "the Web side must be told it was queued, not silently dropped",
    );
    // The message is parked on the binding, not just announced: it is what the
    // releasing runner later replays.
    const parked = bridge.binding("web", "chat-queued").queuedMessages;
    assert.equal(parked?.length, 1, "the message must be parked on the binding for replay");
    assert.equal(parked[0].text, "message on chat-queued");
    assert.equal(parked[0].channel, "web", "the true source channel must survive queueing");
    // The gate is *before* the agent: no session may be spun up for a message
    // that was only parked.
    assert.equal(bridge.counts.creates, 0, "a queued message must not start a session");
    assert.deepEqual(cards(adapter), [], "a queued message produces no answer card");
  }));

test("A2 feishu message while web holds the lock: read-only notice, nothing queued", () =>
  withBridge({}, async (bridge) => {
    const adapter = bridge.addAdapter("feishu");
    bridge.seedBinding(
      bindingFor("feishu", "chat-locked", {
        lockOwner: "web",
        lockAcquiredAt: Date.now(),
        lockTimeoutMs: 60 * 60_000,
      }),
    );

    await bridge.inbound(inboundFor("feishu", "chat-locked"));
    await waitFor(() => texts(adapter).length > 0, 5_000);
    await settle();

    assert.deepEqual(
      texts(adapter).map((m) => m.text),
      ["⚠️ Session is locked by Web, currently in read-only mode"],
    );
    // Feishu is not queued the way Web is: the two sides have different
    // contracts (the GUI's write is parked; the chat's is refused), and only
    // one of them must ever park a message.
    assert.equal(bridge.binding("feishu", "chat-locked").queuedMessages, undefined);
    assert.equal(bridge.counts.creates, 0);
    assert.deepEqual(cards(adapter), []);
  }));

test("A3 a channel without a Web mirror never consults the lock", () =>
  withBridge({}, async (bridge) => {
    const adapter = bridge.addAdapter("stub");
    // A feishu lock on a stub binding is not a state the bridge produces, but
    // it is exactly the state that proves the invariant: Telegram/DingTalk have
    // no mirror to arbitrate with, so the lock must be neither consulted nor
    // touched. `usesLock` is `channel === "feishu" || channel === "web"`.
    const stale = { lockOwner: "feishu", lockAcquiredAt: Date.now(), lockTimeoutMs: 60 * 60_000 };
    bridge.seedBinding(bindingFor("stub", "chat-nolock", stale));

    await bridge.inbound(inboundFor("stub", "chat-nolock"));
    await waitFor(() => cards(adapter).length > 0, 5_000);

    assert.equal(bridge.counts.creates, 1, "the turn must run despite the foreign lock");
    assert.ok(texts(adapter)[0].text.startsWith(EN_ACK), `expected the ack first; got ${JSON.stringify(texts(adapter)[0].text)}`);
    // Untouched, including the timestamp: a channel outside the lock must not
    // renew, release, or steal it.
    const after = bridge.binding("stub", "chat-nolock");
    assert.equal(after.lockOwner, "feishu");
    assert.equal(after.lockAcquiredAt, stale.lockAcquiredAt);
  }));

test("A4 a timed-out lock is released with a notice, then the turn runs", () =>
  withBridge({}, async (bridge) => {
    const adapter = bridge.addAdapter("web");
    bridge.seedBinding(
      bindingFor("web", "chat-timeout", {
        lockOwner: "feishu",
        // Ten minutes of silence against a one-minute timeout.
        lockAcquiredAt: Date.now() - 10 * 60_000,
        lockTimeoutMs: 60_000,
      }),
    );

    await bridge.inbound(inboundFor("web", "chat-timeout"));
    await waitFor(() => cards(adapter).length > 0, 5_000);

    const sent = texts(adapter).map((m) => m.text);
    // The user is told the lock expired — otherwise the other side's messages
    // start arriving again with no explanation.
    assert.ok(
      sent.includes("⏰ Session lock timed out (1 minutes of inactivity), auto-released"),
      `expected the timeout notice; got ${JSON.stringify(sent)}`,
    );
    assert.ok(sent.some((t) => t.startsWith(EN_ACK)), `the turn must run after the release; got ${JSON.stringify(sent)}`);
    assert.equal(bridge.counts.creates, 1);
    // Released, re-acquired by us for the turn, then released again — so a
    // request that arrives now is not queued behind a lock nobody holds.
    const after = bridge.binding("web", "chat-timeout");
    assert.equal(after.lockOwner, undefined);
    assert.equal(after.lockAcquiredAt, undefined);
  }));

test("A5 a completed feishu turn gives the lock back", () =>
  withBridge({}, async (bridge) => {
    const adapter = bridge.addAdapter("feishu");
    bridge.seedBinding(bindingFor("feishu", "chat-release"));

    await bridge.inbound(inboundFor("feishu", "chat-release"));
    await waitFor(() => cards(adapter).length > 0, 5_000);

    const after = bridge.binding("feishu", "chat-release");
    // Discriminating, not vacuous: `autoCreateWebMirror` (on by default for
    // feishu) parks the lock on this very binding mid-turn, so a runner that
    // forgot to release would leave `lockOwner === "feishu"` here.
    assert.equal(after.webMirrorSessionId, after.sessionId, "the mirror must point at the session the turn created");
    assert.equal(after.lockOwner, undefined, "the lock must be released when the turn ends");
    assert.equal(after.lockAcquiredAt, undefined);
  }));

// ---------------------------------------------------------------------------
// B. A failing turn
// ---------------------------------------------------------------------------

test("B1 a turn that throws still answers the user and still frees the lock", () =>
  withBridge({ planFor: { whenIdleError: "boom" } }, async (bridge) => {
    const adapter = bridge.addAdapter("web");
    bridge.seedBinding(bindingFor("web", "chat-fail"));

    await bridge.inbound(inboundFor("web", "chat-fail"));
    await waitFor(() => texts(adapter).length > 1, 5_000);
    await settle();

    const sent = texts(adapter);
    assert.ok(sent[0].text.startsWith(EN_ACK), `the ack must still be sent; got ${JSON.stringify(sent[0].text)}`);
    // `detail` is the thrown message, verbatim; only the advice suffix comes
    // from the classifier, so match on the prefix and let that vary.
    assert.ok(
      sent[1].text.startsWith("⚠️ Processing failed: boom\n\n💡 Suggestion: "),
      `expected the failure notice second; got ${JSON.stringify(sent[1].text)}`,
    );
    // A failed turn reports no stats — a "📊 Task done" card here would be a lie.
    assert.ok(
      !cards(adapter).some((c) => c.markdown.includes("📊 Task done")),
      `a failed turn must not report stats; got ${JSON.stringify(cards(adapter))}`,
    );
    // Without the catch's release the chat would be locked out of its own
    // session until the timeout fired.
    const after = bridge.binding("web", "chat-fail");
    assert.equal(after.lockOwner, undefined, "the lock must be released on the error path too");
  }));

// ---------------------------------------------------------------------------
// C. What gets reported
// ---------------------------------------------------------------------------

test("C1 a non-completed turn reports its output once, in the summary", () =>
  withBridge({ planFor: { answer: "partial answer", reason: "aborted" } }, async (bridge) => {
    const adapter = bridge.addAdapter("stub");
    bridge.seedBinding(bindingFor("stub", "chat-aborted"));

    await bridge.inbound(inboundFor("stub", "chat-aborted"));
    await waitFor(() => cards(adapter).length >= 2, 5_000);
    await settle();

    const sent = cards(adapter);
    assert.equal(sent.length, 2, `expected the stats card and the summary, and nothing else; got ${JSON.stringify(sent)}`);
    // The stats card is the durable report of the run; the output belongs to
    // the summary, so it must not be duplicated here (the streaming card
    // already showed it live).
    assert.ok(sent[0].markdown.includes("📊 Task done"), `expected the stats card first; got ${sent[0].markdown}`);
    assert.ok(!sent[0].markdown.includes("partial answer"), `the stats card must not repeat the output; got ${sent[0].markdown}`);
    assert.ok(sent[1].markdown.includes("**Task ended** — ⏹️ Aborted"), `expected the abort label; got ${sent[1].markdown}`);
    assert.ok(sent[1].markdown.includes("Output: partial answer"), `the summary must carry the partial output; got ${sent[1].markdown}`);
  }));

test("C2 a turn with neither stats nor output sends no card at all", () =>
  withBridge({ planFor: { answer: "", usage: null, context: false } }, async (bridge) => {
    const adapter = bridge.addAdapter("stub");
    bridge.seedBinding(bindingFor("stub", "chat-silent"));

    await bridge.inbound(inboundFor("stub", "chat-silent"));
    // Nothing observable ends this turn, so wait on the turn itself.
    await waitFor(() => bridge.agentOf(bridge.binding("stub", "chat-silent").sessionId)?.followupCalls.length === 1, 5_000);
    await settle();

    // No model, no tokens, no text, and the turn completed: a bare stats card
    // with only a duration would be pure noise.
    assert.deepEqual(cards(adapter), [], "a silent turn must send no card");
    const streamed = adapter.sent.filter((m) => m.kind === "stream");
    assert.equal(streamed.length, 1, "the streaming card must still be opened and closed");
    assert.equal(streamed[0].text, "");
  }));

// ---------------------------------------------------------------------------
// D. Session lifecycle
// ---------------------------------------------------------------------------

test("D1 a second message reuses the live session instead of creating another", () =>
  withBridge({}, async (bridge) => {
    const adapter = bridge.addAdapter("stub");
    const chat = "chat-reuse";

    await bridge.inbound(inboundFor("stub", chat, { text: "first" }));
    await waitFor(() => cards(adapter).length > 0, 5_000);
    const first = bridge.binding("stub", chat).sessionId;
    assert.ok(first !== "", "the first turn must record a session id");

    await bridge.inbound(inboundFor("stub", chat, { text: "second" }));
    const agent = bridge.agentOf(first);
    await waitFor(() => agent.followupCalls.length === 2, 5_000);

    // The live-reuse fast path: a session this process already holds must be
    // answered directly — no `resume` round trip, and above all no second
    // session for the same conversation.
    assert.equal(bridge.counts.creates, 1, "one chat must own one session");
    assert.equal(bridge.counts.resumes, 0, "a live session must be reused, not resumed");
    assert.equal(bridge.registry.size, 1);
    assert.equal(bridge.binding("stub", chat).sessionId, first, "the binding must keep pointing at the same session");
    // Both turns reached the *same* agent, in order.
    assert.equal(agent.followupCalls.length, 2);
  }));

test("D2 a binding whose session is gone falls back to a fresh session", () =>
  withBridge({}, async (bridge) => {
    const adapter = bridge.addAdapter("stub");
    // What a restart leaves behind when the host no longer has the session.
    bridge.seedBinding(bindingFor("stub", "chat-stale", { sessionId: "sess-gone" }));

    await bridge.inbound(inboundFor("stub", "chat-stale"));
    await waitFor(() => bridge.binding("stub", "chat-stale").sessionId !== "sess-gone", 5_000);
    await settle();

    // The resume was attempted and missed — this is the counter that proves the
    // fallback was exercised rather than skipped.
    assert.equal(bridge.counts.resumeMisses, 1, "the stale id must be offered to `resume` first");
    assert.equal(bridge.counts.creates, 1, "a failed resume must fall through to a create");
    const next = bridge.binding("stub", "chat-stale").sessionId;
    assert.ok(next.startsWith("connect-"), `expected a generated session id; got ${next}`);
    assert.ok(bridge.agentOf(next), "the new session must be the one the chat now talks to");
    assert.equal(cards(adapter).length, 1, "the turn must complete normally on the fresh session");
  }));

test("D3 a session the registry still holds is reused without creating or resuming", () =>
  withBridge({}, async (bridge) => {
    const adapter = bridge.addAdapter("stub");
    const seeded = scriptedAgent("sess-existing");
    bridge.registry.set("sess-existing", seeded);
    bridge.seedBinding(bindingFor("stub", "chat-live", { sessionId: "sess-existing" }));

    await bridge.inbound(inboundFor("stub", "chat-live", { text: "hello again" }));
    await waitFor(() => seeded.followupCalls.length === 1, 5_000);

    assert.equal(bridge.counts.creates, 0, "an existing session must not be re-created");
    assert.equal(bridge.counts.resumes, 0, "the live-reuse path must not go through `resume`");
    assert.equal(bridge.counts.resumeMisses, 0);
    assert.equal(bridge.registry.size, 1);
    assert.ok(cards(adapter).length > 0, "the reused session must answer");
  }));

// ---------------------------------------------------------------------------
// E. Per-chat overrides
// ---------------------------------------------------------------------------

test("E1 per-chat settings on the binding win over the plugin config", () =>
  withBridge({}, async (bridge) => {
    const adapter = bridge.addAdapter("stub");
    bridge.seedBinding(
      bindingFor("stub", "chat-overrides", {
        language: "zh",
        notifyLevel: "full",
        progressTimeoutMs: 1_000,
      }),
    );

    await bridge.inbound(inboundFor("stub", "chat-overrides"));
    await waitFor(() => texts(adapter).length > 0, 5_000);

    // The bridge itself was built with `language: "en"`; the ack proves the
    // binding's override took effect, since the reply text is the only
    // observable consequence.
    assert.ok(
      texts(adapter)[0].text.startsWith("✅ 已收到，开始处理"),
      `expected the zh acknowledgement; got ${JSON.stringify(texts(adapter)[0].text)}`,
    );

    // The runner is built lazily on the first inbound and reads these once at
    // construction, so the same read that produced the zh ack produced these.
    const runner = bridge.runnerFor("stub", "chat-overrides");
    assert.ok(runner, "the inbound must have created a runner for this chat");
    assert.equal(runner.language, "zh");
    assert.equal(runner.notifyLevel, "full");
    assert.equal(runner.progressTimeoutMs, 1_000);
  }));

test("E2 a chat with no overrides takes the plugin config", () =>
  withBridge({}, async (bridge) => {
    const adapter = bridge.addAdapter("stub");

    await bridge.inbound(inboundFor("stub", "chat-defaults"));
    await waitFor(() => texts(adapter).length > 0, 5_000);

    assert.ok(texts(adapter)[0].text.startsWith(EN_ACK));
    const runner = bridge.runnerFor("stub", "chat-defaults");
    assert.equal(runner.language, "en");
    assert.equal(runner.notifyLevel, "result");
    assert.equal(runner.progressTimeoutMs, 5 * 60_000, "the documented 5-minute default");
  }));

// ---------------------------------------------------------------------------
// F. The allowlist gate, against thread-scoped chat keys
// ---------------------------------------------------------------------------

test("F1 a thread-scoped chat key matches the allowlist on its base chat id", () =>
  withBridge({ config: { allowChats: ["oc_allowed"] } }, async (bridge) => {
    const { service } = bridge;
    // `allowChats` is documented as chat ids, and that is what an adapter
    // holding only the pre-download chat id passes in. The core, however, sees
    // the key the channel encoded — with Feishu threadIsolation that is
    // `chatId:thread=<rootId>`. Comparing the raw keys made the two gates
    // disagree: the adapter's pre-check passed and the core then dropped every
    // thread message of an allowlisted chat, with nothing logged.
    assert.equal(service.isChatAllowed("feishu", "oc_allowed", "u1"), true, "adapter pre-check shape");
    assert.equal(service.isChatAllowed("feishu", "oc_allowed:thread=om_root", "u1"), true, "core re-check shape");
    // The reduction must not turn the allowlist into "allow everything".
    assert.equal(service.isChatAllowed("feishu", "oc_other", "u1"), false);
    assert.equal(service.isChatAllowed("feishu", "oc_other:thread=om_root", "u1"), false);
    // A chat id that merely *contains* the separator is not a thread key: only
    // the suffix is stripped, never an arbitrary prefix match.
    assert.equal(service.isChatAllowed("feishu", "oc_allowed:thread=", "u1"), true, "empty thread id → base id");
  }));

test("F2 a thread message in an allowlisted chat is routed, not silently dropped", () =>
  withBridge({ config: { allowChats: ["oc_allowed"] } }, async (bridge) => {
    // chatType is irrelevant to the gate; the chat *key* is what is under test.
    // Two channel ids, because `registerAdapter` rejects a duplicate.
    const allowed = bridge.addAdapter("allowed");
    await bridge.inbound(inboundFor("allowed", "oc_allowed:thread=om_root"));
    // Routing builds the runner synchronously; before the fix this chat had
    // none and the adapter was never told the message existed.
    assert.ok(bridge.runnerFor("allowed", "oc_allowed:thread=om_root"), "the allowed thread must get a runner");
    await waitFor(() => texts(allowed).length > 0, 5_000);
    assert.ok(texts(allowed)[0].text.startsWith(EN_ACK), "the allowed thread must get a real turn");

    // A chat that was never allowlisted stays denied — the fix widens the key
    // comparison, not the policy.
    const denied = bridge.addAdapter("denied");
    await bridge.inbound(inboundFor("denied", "oc_other:thread=om_root"));
    await settle();
    assert.equal(bridge.runnerFor("denied", "oc_other:thread=om_root"), undefined, "no runner for a denied chat");
    assert.deepEqual(texts(denied), [], "a non-allowlisted chat must stay silent");
  }));
