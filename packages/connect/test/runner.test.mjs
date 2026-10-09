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
 * Twelve groups, each pinning a contract that would otherwise only be
 * discovered in production:
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
 *   F — the allowlist gate, against thread-scoped chat keys.
 *   G — agent-preset resolution degrades instead of failing the turn.
 *   H — `/remind` tells the truth about both halves of "set".
 *   I — a task-end card the channel refuses is reported, not swallowed.
 *   J — a resume that falls back to a fresh session is said out loud, in chat.
 *   K — the two timers that keep a long turn from looking frozen (the liveness
 *       heartbeat and the progress watchdog), and that both edit the streaming
 *       card in place rather than posting bubbles.
 *   L — the per-chat override *writers*: what `/model`, `/reasoning`, `/lang`
 *       and `/notify` persist, including for a chat with no binding at all.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
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

// ---------------------------------------------------------------------------
// G. Preset resolution degrades instead of killing the turn
// ---------------------------------------------------------------------------

/**
 * A stand-in for the host `agentPresets` service.
 *
 * `resolve` reproduces the host's two behaviours that matter here: an unknown
 * id *throws*, and `resolve(undefined)` answers from the roster default rather
 * than from the caller's id. `mount` records what actually composed an agent —
 * the only place a fallback can be observed, since the whole point of the
 * degradation is that it leaves no visible trace on the reply.
 */
function presetStub(roster, rosterDefault = "standard") {
  const mounted = [];
  return {
    mounted,
    async resolve(id) {
      const wanted = id ?? rosterDefault;
      const found = roster.find((row) => row.id === wanted);
      if (found === undefined) {
        const available = roster.map((row) => row.id);
        throw new Error(`agent-presets: preset "${wanted}" not found (available: ${available.join(", ") || "none"})`);
      }
      return found;
    },
    async list() {
      return roster.map((row) => ({ ...row }));
    },
    async mount(_agentCtx, id) {
      mounted.push(id);
    },
  };
}

/**
 * Which presets composed an agent, deduplicated.
 *
 * A fresh chat mounts more than once by design: the runner resumes the empty
 * session id its binding starts with, the harness misses and falls through to
 * `create`, and `setup` is composed on both attempts. The property under test
 * is *which* preset was used, never how many lifecycle attempts it took, so
 * the assertions go through here rather than reading the raw call list.
 */
const mountedSet = (presets) => [...new Set(presets.mounted)].sort();

test("G1 a configured preset the roster does not have falls back instead of failing the turn", () => {
  const presets = presetStub([{ id: "standard" }, { id: "ptc" }]);
  return withBridge({ config: { agentPreset: "code" }, presets }, async (bridge) => {
    const adapter = bridge.addAdapter("stub");
    const chat = "chat-stale-preset";
    await bridge.inbound(inboundFor("stub", chat, { text: "hello" }));
    await waitFor(() => cards(adapter).length > 0, 5_000);

    // The turn ran at all, which is the whole point: `resolve` used to throw
    // out of `composeSetup`, before any agent existed, so every message in
    // every bound chat died with the raw host text and nothing else.
    assert.ok(bridge.binding("stub", chat).sessionId !== "", "the turn must have composed an agent");
    assert.deepEqual(mountedSet(presets), ["standard"], "the fallback must be what actually composes the agent");
    // Both halves of the diagnostic: why it was refused, and what replaced it.
    assert.ok(
      bridge.logs.some((line) => line.includes('agent preset "code" is unusable')),
      `the cause must be logged: ${JSON.stringify(bridge.logs)}`,
    );
    assert.ok(
      bridge.logs.some((line) => line.includes('falling back to agent preset "standard"')),
      `the substitution must be logged: ${JSON.stringify(bridge.logs)}`,
    );
  });
});

test("G2 a preset that resolves but reports itself broken is not mounted", () => {
  // The host keeps a broken preset on the roster and refuses it only at mount
  // time, so a caller that trusts `resolve` alone hands the failure straight to
  // `mount` — after the log line that would have named the real cause.
  const presets = presetStub([{ id: "half-baked", broken: "invalid cordis.yml" }, { id: "standard" }]);
  return withBridge({ config: { agentPreset: "half-baked" }, presets }, async (bridge) => {
    const adapter = bridge.addAdapter("stub");
    await bridge.inbound(inboundFor("stub", "chat-broken-preset", { text: "hello" }));
    await waitFor(() => cards(adapter).length > 0, 5_000);

    assert.deepEqual(mountedSet(presets), ["standard"], "a broken preset must never reach mount");
    assert.ok(
      bridge.logs.some((line) => line.includes("failed to load: invalid cordis.yml")),
      `the preset's own reason must be surfaced: ${JSON.stringify(bridge.logs)}`,
    );
  });
});

test("G3 with no usable preset at all the agent is still composed and the turn still runs", () => {
  const presets = presetStub([]);
  return withBridge({ config: { agentPreset: "code" }, presets }, async (bridge) => {
    const adapter = bridge.addAdapter("stub");
    const chat = "chat-no-presets";
    await bridge.inbound(inboundFor("stub", chat, { text: "hello" }));
    await waitFor(() => cards(adapter).length > 0, 5_000);

    assert.deepEqual(mountedSet(presets), [], "an empty roster has nothing to mount");
    assert.ok(bridge.binding("stub", chat).sessionId !== "", "a degraded turn must still record a session");
    assert.ok(
      bridge.logs.some((line) => line.includes("composing the agent without one")),
      `the degraded composition must be logged: ${JSON.stringify(bridge.logs)}`,
    );
  });
});

test("G4 a preset that does resolve is mounted as asked, with nothing logged", () => {
  // The guard against the obvious failure mode of this whole feature: a
  // fallback that fires when nothing is wrong, silently overriding the user's
  // choice of preset.
  const presets = presetStub([{ id: "standard" }, { id: "ptc" }]);
  return withBridge({ config: { agentPreset: "ptc" }, presets }, async (bridge) => {
    const adapter = bridge.addAdapter("stub");
    await bridge.inbound(inboundFor("stub", "chat-good-preset", { text: "hello" }));
    await waitFor(() => cards(adapter).length > 0, 5_000);

    assert.deepEqual(mountedSet(presets), ["ptc"], "the configured preset must win over the fallback");
    assert.deepEqual(
      bridge.logs.filter((line) => line.includes("agent preset")),
      [],
      "a healthy resolution must not log at all",
    );
  });
});

test("G5 a stale roster default degrades too — the shape this actually failed in", () => {
  // Production had no plugin-level `agentPreset`, so `resolve(undefined)` fell
  // through to `agent-presets.default` in settings.yaml — the stale id. The
  // plugin never sees that id, so the log has to name it as the default.
  const presets = presetStub([{ id: "standard" }, { id: "ptc" }], "code");
  return withBridge({ presets }, async (bridge) => {
    const adapter = bridge.addAdapter("stub");
    await bridge.inbound(inboundFor("stub", "chat-stale-default", { text: "hello" }));
    await waitFor(() => cards(adapter).length > 0, 5_000);

    assert.deepEqual(mountedSet(presets), ["standard"]);
    assert.ok(
      bridge.logs.some((line) => line.includes("agent preset the roster default is unusable")),
      `a stale default must be named as the default: ${JSON.stringify(bridge.logs)}`,
    );
  });
});

// ---------------------------------------------------------------------------
// H. /remind tells the truth about both halves of "set"
// ---------------------------------------------------------------------------

/**
 * The failure this pins: `save()` used to swallow its own error, so a reminder
 * whose store could not be written was confirmed with 「已设置」 and was then
 * gone by morning. Neither answer is honest on its own — the reminder *is* live
 * in this process, so refusing would be a lie in the other direction. The
 * confirmation has to carry both.
 */
test("H1 a reminder whose store cannot be written is confirmed and flagged, not silently lost", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-connect-remind-fail-"));
  try {
    // A directory where `reminders.json` should be: `readFileSync` fails (so the
    // store starts empty) and `writeFileSync` fails on every save. This is a real
    // shape — a half-finished sync or restore leaves exactly this behind — and it
    // is the only knob that fails the *write* without breaking the binding store
    // that shares this state dir.
    mkdirSync(join(dir, "reminders.json"));
    const bridge = await makeBridge({ stateDir: dir, language: "en" });
    try {
      const adapter = bridge.addAdapter("stub");
      await bridge.inbound(inboundFor("stub", "chat-remind", { text: "/remind 10m drink water" }));
      await waitFor(() => texts(adapter).length > 0, 5_000);

      const sent = texts(adapter);
      assert.equal(sent.length, 1, `expected exactly the confirmation; got ${JSON.stringify(sent.map((m) => m.text))}`);
      const text = sent[0].text;
      assert.ok(text.includes("Reminder set"), `the reminder must still be confirmed as set; got ${JSON.stringify(text)}`);
      assert.ok(
        text.includes("could not be written"),
        `the failed write must be part of the confirmation; got ${JSON.stringify(text)}`,
      );

      // And the reminder really is live: it is what makes the second half true.
      assert.equal(bridge.service.reminders.list().length, 1, "the reminder must be live in this process regardless");
    } finally {
      await bridge.dispose();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test("H2 a reminder that does persist is confirmed and nothing more", () =>
  withBridge({}, async (bridge) => {
    const adapter = bridge.addAdapter("stub");
    await bridge.inbound(inboundFor("stub", "chat-remind-ok", { text: "/remind 10m drink water" }));
    await waitFor(() => texts(adapter).length > 0, 5_000);

    const text = texts(adapter)[0].text;
    assert.ok(text.includes("Reminder set"), `got ${JSON.stringify(text)}`);
    assert.ok(
      !text.includes("could not be written"),
      `a successful write must not warn about the write; got ${JSON.stringify(text)}`,
    );
    assert.equal(bridge.service.reminders.list().length, 1);
  }));

// ---------------------------------------------------------------------------
// I. a task-end card the channel refuses is reported, not swallowed
// ---------------------------------------------------------------------------

/**
 * `sendCard(...).catch(() => undefined)` made a rejected card indistinguishable
 * from a card with nothing to say. They are opposite outcomes: the stats card is
 * the durable record of the turn — the result text, tokens, duration — and the
 * streaming card it replaces is meanwhile frozen on its last frame. Delivery
 * failing is the one case where the log *is* the only possible report, because
 * the channel that would carry a notice is the thing that just failed.
 */
test("I1 a refused task-end card is logged with its chat and reason", () =>
  withBridge({}, async (bridge) => {
    const adapter = bridge.addAdapter("stub");
    // A card the client cannot render, a revoked card permission, a transient
    // 5xx — the runner cannot tell them apart and does not need to; it needs to
    // stop pretending the delivery happened.
    adapter.sendCard = async () => { throw new Error("card rejected by the channel"); };

    await bridge.inbound(inboundFor("stub", "chat-card-fail", { text: "hello" }));
    const reported = await waitFor(
      () => bridge.logs.some((line) => line.includes("stats card could not be delivered")),
      5_000,
    );
    assert.ok(reported, `the dropped card must be reported; logs were ${JSON.stringify(bridge.logs)}`);

    const line = bridge.logs.find((l) => l.includes("stats card could not be delivered"));
    assert.ok(line.includes("stub/chat-card-fail"), `the chat must be identified; got ${JSON.stringify(line)}`);
    assert.ok(line.includes("card rejected by the channel"), `the reason must survive; got ${JSON.stringify(line)}`);

    // The turn itself ran: the failure is in delivery, not in the work, and the
    // acknowledgement proves the runner got as far as the end of the turn. Matched
    // by prefix because the ack carries a preview of the message after it, so no
    // equality check can hold — same as every other ack assertion in this file.
    assert.ok(
      texts(adapter).some((m) => m.text.startsWith(EN_ACK)),
      `the turn must still have run to completion; sent ${JSON.stringify(texts(adapter))}`,
    );
    assert.deepEqual(cards(adapter), [], "a card that throws delivers nothing");
  }));

test("I2 a card that is delivered reports nothing about delivery", () =>
  withBridge({}, async (bridge) => {
    const adapter = bridge.addAdapter("stub");
    await bridge.inbound(inboundFor("stub", "chat-card-ok", { text: "hello" }));
    assert.ok(await waitFor(() => cards(adapter).length > 0, 5_000), "the healthy path must deliver its card");

    assert.ok(
      !bridge.logs.some((line) => line.includes("could not be delivered")),
      `a delivered card must not warn about delivery; logs were ${JSON.stringify(bridge.logs)}`,
    );
  }));

// ---------------------------------------------------------------------------
// J. a resume that falls back to a fresh session is said out loud
// ---------------------------------------------------------------------------

/**
 * `connect: resume of <id> failed, creating fresh session` went to the log and
 * nowhere else. The chat is the one place the user is looking, and it is the one
 * place that showed nothing: they send a follow-up into a conversation that looks
 * intact and get a reply with no memory of it. The session is not lost — it is
 * still in the store and still viewable in the Web GUI — so the honest report is
 * "continuing in a new one", delivered before the reply is, not after.
 */
test("J1 a resume that falls back tells the chat, before the reply", () =>
  withBridge({}, async (bridge) => {
    const adapter = bridge.addAdapter("stub");
    // A binding that points at a session this host cannot produce — a deleted
    // session store, a moved work dir, a wiped state dir. Exactly the shape the
    // harness's own `resume` treats as un-resumable.
    bridge.seedBinding(bindingFor("stub", "chat-gone", { sessionId: "s-gone" }));

    await bridge.inbound(inboundFor("stub", "chat-gone", { text: "still there?" }));
    const reported = await waitFor(
      () => texts(adapter).some((m) => m.text.includes("Could not resume the previous session")),
      5_000,
    );
    assert.ok(reported, `the fallback must be reported to the chat; sent ${JSON.stringify(texts(adapter))}`);

    const noticeIndex = texts(adapter).findIndex((m) => m.text.includes("Could not resume the previous session"));
    const notice = texts(adapter)[noticeIndex].text;
    // The reason survives: a one-off is distinguishable from a permanent cause
    // (a missing session store) only if the chat carries the actual error.
    assert.ok(notice.includes("no session"), `the reason must survive; got ${JSON.stringify(notice)}`);
    // And it says what actually happened, rather than implying the history is gone.
    assert.ok(notice.includes("new one"), `the notice must say a new session was started; got ${JSON.stringify(notice)}`);

    // Order matters: the acknowledgement comes first, so the user is never told
    // their session was replaced before being told the message was received.
    assert.ok(
      texts(adapter)[0].text.startsWith(EN_ACK),
      `the ack must still open the turn; sent ${JSON.stringify(texts(adapter))}`,
    );
    assert.ok(noticeIndex > 0, "the notice must follow the ack, not precede it");

    // The claim in the notice, checked against the store rather than the message:
    // the binding now points at the fresh session, which is what makes this fire
    // once per breakage instead of once per message.
    const after = bridge.binding("stub", "chat-gone");
    assert.ok(after.sessionId.startsWith("connect-"), `the binding must point at the new session; got ${after.sessionId}`);
    assert.notEqual(after.sessionId, "s-gone");
    assert.equal(bridge.counts.creates, 1, "a fresh session must really have been created");
  }));

test("J2 a brand-new chat is not told its session could not be resumed", () =>
  withBridge({}, async (bridge) => {
    const adapter = bridge.addAdapter("stub");
    // `maybeSendWelcome` persists `sessionId: ""` for a first-time chat, so the
    // resume of "" fails on this path too. There is no lost conversation here, and
    // a notice saying otherwise would land on the first message of every chat.
    await bridge.inbound(inboundFor("stub", "chat-first-ever", { text: "hi" }));
    assert.ok(
      await waitFor(() => texts(adapter).some((m) => m.text.startsWith(EN_ACK)), 5_000),
      "the turn must have run",
    );
    assert.ok(
      !texts(adapter).some((m) => m.text.includes("Could not resume")),
      `a first message must not claim a session was lost; sent ${JSON.stringify(texts(adapter))}`,
    );
  }));

// ---------------------------------------------------------------------------
// K. The two timers that keep a long turn from looking frozen
// ---------------------------------------------------------------------------

/**
 * The text of the one streaming card the turn opened.
 *
 * Progress notices are deliberately *not* their own messages: both timers push
 * into the chunk stream that the adapter drains into the already-open editable
 * card ("Edit the existing streaming card in place instead of sending a new
 * message… so progress updates never clutter the chat with new bubbles"). The
 * recording adapter concatenates that stream into one record, so a marker found
 * here is an edit of the card, and a marker found in `texts()` would be a
 * bubble — the two assertions every test below makes.
 */
function streamedText(adapter) {
  const record = adapter.sent.find((m) => m.kind === "stream");
  assert.ok(
    record,
    `the turn must have opened a streaming card; sent ${JSON.stringify(adapter.sent.map((m) => m.kind))}`,
  );
  return record.text;
}

test("K1 a liveness heartbeat edits the streaming card instead of posting a bubble", () =>
  withBridge({ config: { streamHeartbeatMs: 10 }, planFor: { whenIdleHoldMs: 120 } }, async (bridge) => {
    const adapter = bridge.addAdapter("stub");
    // `full` is the level the heartbeat is gated on; `result` would disable it.
    // Seeded on the binding because that is a path the suite already proves
    // works (E1), rather than a second thing to get wrong at once.
    bridge.seedBinding(bindingFor("stub", "chat-heartbeat", { notifyLevel: "full" }));

    await bridge.inbound(inboundFor("stub", "chat-heartbeat", { text: "something long" }));
    assert.ok(
      await waitFor(() => adapter.sent.some((m) => m.kind === "stream"), 5_000),
      "the turn must have opened a streaming card",
    );

    // The card is only closed once the turn ends, so by now the whole 120ms hold
    // — and therefore every heartbeat inside it — has been drained into it.
    const card = streamedText(adapter);
    assert.ok(card.includes("answer"), `the answer must be on the card; got ${JSON.stringify(card)}`);
    assert.ok(
      card.includes("Still processing"),
      `the heartbeat must have been pushed into the card; got ${JSON.stringify(card)}`,
    );
    assert.ok(
      !texts(adapter).some((m) => m.text.includes("Still processing")),
      `no heartbeat may arrive as a separate message; sent ${JSON.stringify(texts(adapter))}`,
    );
  }));

test("K2 at the default notify level nothing streams into the card, and the result arrives at the end", () =>
  withBridge({ config: { streamHeartbeatMs: 10 }, planFor: { whenIdleHoldMs: 120 } }, async (bridge) => {
    const adapter = bridge.addAdapter("stub");
    // No binding override, so this chat runs at the documented default of
    // `result` (pinned by E2) — "only the final result when the task finishes".
    await bridge.inbound(inboundFor("stub", "chat-no-heartbeat", { text: "something long" }));
    assert.ok(
      await waitFor(() => adapter.sent.some((m) => m.kind === "stream"), 5_000),
      "the turn must have opened a streaming card",
    );

    const card = streamedText(adapter);
    // `result` must not type the answer into the live card as it is produced —
    // that was the bug: the level was honoured for reasoning and tool calls but
    // the answer itself still streamed, so the chat narrated the whole turn.
    assert.ok(
      !card.includes("answer"),
      `the answer must not stream live at the result level; got ${JSON.stringify(card)}`,
    );
    assert.ok(
      !card.includes("Still processing"),
      `a quiet chat must not be interrupted by heartbeats; got ${JSON.stringify(card)}`,
    );
    // The positive half: the answer is not lost, it is delivered once at the end
    // by the task-end card. Without this, the assertions above would also pass
    // for an implementation that simply dropped the output.
    assert.ok(
      cards(adapter).some((c) => c.markdown.includes("answer")),
      `the final result must still be delivered; cards ${JSON.stringify(cards(adapter))}`,
    );
  }));

test("K3 the progress watchdog and the heartbeat both fire, both into the same card", () =>
  // The tick is derived from the configured interval (`progressTimeoutMs / 2`,
  // floored at 250ms), so a 400ms interval is observable inside a sub-second
  // hold instead of only after a 15s constant. The heartbeat is set an order of
  // magnitude faster than the watchdog on purpose: it is the thing that must
  // *not* reset the watchdog's clock.
  withBridge(
    { config: { streamHeartbeatMs: 100 }, planFor: { whenIdleHoldMs: 900 } },
    async (bridge) => {
      const adapter = bridge.addAdapter("stub");
      bridge.seedBinding(
        bindingFor("stub", "chat-progress", { notifyLevel: "full", progressTimeoutMs: 400 }),
      );

      await bridge.inbound(inboundFor("stub", "chat-progress", { text: "a long task" }));
      assert.ok(
        await waitFor(() => adapter.sent.some((m) => m.kind === "stream"), 5_000),
        "the turn must have opened a streaming card",
      );

      const card = streamedText(adapter);
      assert.ok(
        card.includes("Still working on the task (1 min so far)"),
        `the watchdog must have synced a milestone into the card; got ${JSON.stringify(card)}`,
      );
      // The status line is the point of the reminder — a milestone, not a bare
      // minute count. `milestone` is unset here (the scripted turn streams no
      // reasoning), so this is the documented thinking fallback.
      assert.ok(
        card.includes("Latest progress: 🤔 Thinking"),
        `the reminder must carry a status line; got ${JSON.stringify(card)}`,
      );
      // Both timers alive at once, and independent: with heartbeats arriving
      // every ~100ms, an implementation that let one reset the watchdog's
      // `lastProgressNoticeAt` would push no reminder at all inside 900ms.
      assert.ok(
        card.includes("Still processing"),
        `the heartbeat must still be running alongside the watchdog; got ${JSON.stringify(card)}`,
      );
      for (const marker of ["Still working on the task", "Still processing"]) {
        assert.ok(
          !texts(adapter).some((m) => m.text.includes(marker)),
          `${JSON.stringify(marker)} must not arrive as a separate message; sent ${JSON.stringify(texts(adapter))}`,
        );
      }
    },
  ));

test("K4 the progress reminder still fires at a quiet level, and names no tool", () =>
  // The reminder is a *configured* status report (`progressTimeoutMs`), not
  // liveness chatter, so it survives a quieter notification level — gating it on
  // the level would silently discard a setting the user made on purpose. What it
  // must NOT do is re-list tool activity, which is the detail those levels
  // suppress; its milestone is a step count instead of a tool name.
  withBridge(
    { config: { streamHeartbeatMs: 0 }, planFor: { whenIdleHoldMs: 900 } },
    async (bridge) => {
      const adapter = bridge.addAdapter("stub");
      bridge.seedBinding(bindingFor("stub", "chat-quiet-watchdog", { progressTimeoutMs: 400 }));

      await bridge.inbound(inboundFor("stub", "chat-quiet-watchdog", { text: "a long task" }));
      assert.ok(
        await waitFor(() => adapter.sent.some((m) => m.kind === "stream"), 5_000),
        "the turn must have opened a streaming card",
      );
      const card = streamedText(adapter);
      assert.ok(
        card.includes("Still working on the task"),
        `the configured reminder must still fire at a quiet level; got ${JSON.stringify(card)}`,
      );
      // The heartbeat, unlike the reminder, is pure liveness and stays gated.
      assert.ok(
        !card.includes("Still processing"),
        `the heartbeat must stay gated at a quiet level; got ${JSON.stringify(card)}`,
      );
    },
  ));

test("K5 a long result is delivered whole, not clipped at 300 characters", () =>
  withBridge(
    {
      planFor: {
        // Comfortably past the old 300-char cap, with a unique tail to look for.
        answer: `${"x".repeat(400)}TAIL-UNIQUE-END`,
      },
    },
    async (bridge) => {
      const adapter = bridge.addAdapter("stub");
      await bridge.inbound(inboundFor("stub", "chat-long-result", { text: "produce a long answer" }));
      // Wait for the *task-end* card, not merely for any output: the ack text
      // arrives long before the turn settles, and asserting against it would
      // race the very card this test is about.
      assert.ok(
        await waitFor(() => cards(adapter).some((c) => c.markdown.includes("TAIL-UNIQUE-END")), 5_000),
        `the task-end card must carry the whole answer; got ${JSON.stringify(cards(adapter).map((c) => c.markdown.slice(0, 200)))}`,
      );
    },
  ));

test("K8 the important level gets milestones, not a running commentary", () =>
  // The reported bug: with the setting on 输出重要节点 the chat still received
  // live status chatter every minute. Both timers were gated on `!== "result"`,
  // so `important` — a level documented as three discrete events — received the
  // heartbeat and the watchdog.
  withBridge(
    {
      config: { streamHeartbeatMs: 100 },
      // Tool activity is scripted explicitly: without it there would be no tool
      // lines to suppress and the assertions below would pass vacuously.
      planFor: { whenIdleHoldMs: 900, toolCalls: ["pwsh", "edit"] },
    },
    async (bridge) => {
      const adapter = bridge.addAdapter("stub");
      bridge.seedBinding(
        bindingFor("stub", "chat-important", { notifyLevel: "important", progressTimeoutMs: 400 }),
      );

      await bridge.inbound(inboundFor("stub", "chat-important", { text: "a long task" }));
      assert.ok(
        await waitFor(() => adapter.sent.some((m) => m.kind === "stream"), 5_000),
        "the turn must have opened a streaming card",
      );
      await waitFor(() => cards(adapter).length > 0, 5_000);

      const card = streamedText(adapter);
      // The heartbeat is liveness chatter: gated off at `important`.
      assert.ok(
        !card.includes("Still processing"),
        `the heartbeat must not reach an important-level chat; got ${JSON.stringify(card)}`,
      );
      // Tool activity is the "current work status" the user removed; it must not
      // appear as a stream line or as a separate bubble at this level.
      for (const toolLine of ["调用工具", "Calling tool", "analyze", "report.md"]) {
        assert.ok(
          !card.includes(toolLine),
          `tool activity ${JSON.stringify(toolLine)} must not stream at this level; got ${JSON.stringify(card)}`,
        );
      }
      // The configured 5-minute reminder is NOT chatter and still fires.
      assert.ok(
        card.includes("Still working on the task"),
        `the configured progress reminder must still fire; got ${JSON.stringify(card)}`,
      );
      assert.ok(
        cards(adapter).some((c) => c.markdown.includes("answer")),
        `the final answer must still be delivered; cards ${JSON.stringify(cards(adapter))}`,
      );
    },
  ));

test("K6 /status reports the turn's real completion time, not the moment it was asked", () =>
  // The turn is scripted to have ended two hours ago. That gap is what makes
  // this test able to fail: with the event stamped at the current time, an
  // implementation that read `new Date()` instead of `event.time` would be
  // indistinguishable from a correct one.
  withBridge({ planFor: { turnEndedAtMs: Date.now() - 2 * 60 * 60_000 } }, async (bridge) => {
    const adapter = bridge.addAdapter("stub");
    await bridge.inbound(inboundFor("stub", "chat-status-time", { text: "a task" }));
    assert.ok(
      await waitFor(() => cards(adapter).length > 0 || texts(adapter).length > 0, 5_000),
      "the turn must have reported something",
    );

    const runner = bridge.runnerFor("stub", "chat-status-time");
    assert.ok(runner, "the inbound must have created a runner");
    assert.ok(
      await waitFor(() => runner["agent"] !== undefined, 5_000),
      "the runner must have attached an agent",
    );
    const target = { channel: "stub", chatKey: "chat-status-time" };
    const sentBefore = texts(adapter).length;
    await runner.showStatus(target);
    const status = texts(adapter).slice(sentBefore).map((m) => m.text).join("\n");
    // The bridge runs in English (`language: "en"`), so the line reads "Completed:".
    assert.ok(status.includes("Completed:"), `the status must report the last turn; got ${JSON.stringify(status)}`);

    const match = /Completed:\s*(\d{1,2}):(\d{2}):(\d{2})\s*(AM|PM)?/.exec(status);
    assert.ok(match, `the status must carry a completion time; got ${JSON.stringify(status)}`);
    let h = Number(match[1]) % 12;
    if (match[4] === "PM") h += 12;
    const completed = new Date();
    completed.setHours(h, Number(match[2]), Number(match[3]), 0);
    const expected = new Date(Date.now() - 2 * 60 * 60_000);
    const deltaMinutes = Math.abs(completed.getTime() - expected.getTime()) / 60_000;
    assert.ok(
      Math.min(deltaMinutes, 24 * 60 - deltaMinutes) < 2,
      `the completion time must come from the turn/end event (${expected.toLocaleTimeString("en-US")}), not the clock; got ${match[0]}`,
    );
  }));

test("K7 /status does not claim a task is running when this process is not driving one", () =>
  withBridge({ planFor: { whenIdleHoldMs: 50 } }, async (bridge) => {
    const adapter = bridge.addAdapter("stub");
    await bridge.inbound(inboundFor("stub", "chat-orphan", { text: "a task" }));
    assert.ok(await waitFor(() => texts(adapter).length > 0, 5_000), "the turn must have started");

    const runner = bridge.runnerFor("stub", "chat-orphan");
    assert.ok(runner, "the inbound must have created a runner");
    assert.ok(
      await waitFor(() => runner["agent"] !== undefined, 5_000),
      "the runner must have attached an agent",
    );

    // Simulate what a host restart leaves behind: the resumed session still
    // holds a turn that was cut off mid-flight, so the agent reads "running"
    // while nothing drives it and no progress notice can ever arrive.
    runner["agent"].status = "running";
    runner["turn"] = undefined;
    runner["running"] = false;
    const target = { channel: "stub", chatKey: "chat-orphan" };
    const sentBefore = texts(adapter).length;
    await runner.showStatus(target);
    const status = texts(adapter).slice(sentBefore).map((m) => m.text).join("\n");

    assert.ok(
      !status.includes("Processing task"),
      `an orphaned turn must not be reported as processing; got ${JSON.stringify(status)}`,
    );
    assert.ok(
      status.includes("cut off"),
      `the status must say the previous task was interrupted; got ${JSON.stringify(status)}`,
    );
  }));

// ---------------------------------------------------------------------------
// N. Per-channel access control
// ---------------------------------------------------------------------------

test("N1 a channel's own allowlist overrides the global one", () =>
  withBridge(
    {
      config: {
        channels: ["feishu", "telegram"],
        // The global list names a Feishu id. Telegram must not be judged by it:
        // a Feishu open_id can never equal a numeric Telegram user id, so one
        // shared list would lock every Telegram sender out.
        allowUsers: ["ou_feishu_only"],
        telegram: { allowUsers: ["12345"] },
      },
    },
    async (bridge) => {
      const { service } = bridge;
      assert.equal(service.isChatAllowed("telegram", "999", "12345"), true, "telegram's own list admits its user");
      assert.equal(service.isChatAllowed("telegram", "999", "54321"), false, "and refuses one it does not name");
      // Feishu's block never set the key, so it keeps the global fallback.
      assert.equal(service.isChatAllowed("feishu", "oc_x", "ou_feishu_only"), true);
      assert.equal(service.isChatAllowed("feishu", "oc_x", "ou_someone_else"), false);
    },
  ));

test("N2 a channel declaring an empty list allows everyone, overriding the global one", () =>
  withBridge(
    {
      config: {
        channels: ["feishu", "telegram"],
        allowUsers: ["ou_only_this"],
        // Explicitly empty: "this channel is unrestricted". Reading it as
        // "absent" would silently re-apply a restriction the user opted out of.
        telegram: { allowUsers: [] },
      },
    },
    async (bridge) => {
      const { service } = bridge;
      assert.equal(service.isChatAllowed("telegram", "999", "anyone"), true);
      assert.equal(service.isChatAllowed("feishu", "oc_x", "anyone"), false);
    },
  ));

test("N3 allowChats is per channel too, and compares on the base chat id", () =>
  withBridge(
    { config: { channels: ["feishu", "telegram"], telegram: { allowChats: ["777"] } } },
    async (bridge) => {
      const { service } = bridge;
      assert.equal(service.isChatAllowed("telegram", "777", "u"), true);
      assert.equal(service.isChatAllowed("telegram", "888", "u"), false);
      // A thread-scoped key reduces to its base chat id, so a thread of an
      // allowlisted chat is not dropped.
      assert.equal(service.isChatAllowed("telegram", "777:thread=42", "u"), true);
      // Feishu declared nothing, so it stays unrestricted.
      assert.equal(service.isChatAllowed("feishu", "oc_x", "u"), true);
    },
  ));

// ---------------------------------------------------------------------------
// M. Automatic context compaction
// ---------------------------------------------------------------------------

/**
 * A stand-in for DSH's compaction service. `compactNow` is the only entry point
 * the runner uses; returning `null` is the real service's "nothing to compact"
 * answer.
 */
function compactionService(calls) {
  return {
    serviceFor: (_agent, name) =>
      name === "compaction"
        ? {
            async compactNow() {
              calls.push(Date.now());
              return { ok: true };
            },
          }
        : undefined,
  };
}

/** A plan reporting `pct` percent usage of a 100k window. */
function planAtUsage(pct) {
  return {
    context: true,
    contextWindow: 100_000,
    usage: { inputTokens: pct * 1000, outputTokens: 10, cacheReadTokens: 0 },
  };
}

test("M1 auto-compaction fires at turn end once usage crosses the threshold", () =>
  withBridge(
    { config: { autoCompact: true, autoCompactThresholdPct: 80 }, planFor: planAtUsage(85) },
    async (bridge) => {
      const adapter = bridge.addAdapter("stub");
      const calls = [];
      bridge.ctx.provide("agentPresets", compactionService(calls));

      await bridge.inbound(inboundFor("stub", "chat-autocompact", { text: "fill the window" }));
      assert.ok(
        await waitFor(() => calls.length > 0, 5_000),
        "compaction must run: the turn reported 85% against an 80% threshold",
      );
    },
  ));

test("M2 auto-compaction stays off when the switch is off, even above the threshold", () =>
  withBridge({ config: { autoCompact: false }, planFor: planAtUsage(95) }, async (bridge) => {
    const adapter = bridge.addAdapter("stub");
    const calls = [];
    bridge.ctx.provide("agentPresets", compactionService(calls));

    await bridge.inbound(inboundFor("stub", "chat-nocompact", { text: "fill the window" }));
    // Wait for the turn to finish before asserting the negative, or this would
    // pass merely by running first.
    assert.ok(
      await waitFor(() => cards(adapter).length > 0, 5_000),
      "the turn must have completed",
    );
    assert.equal(calls.length, 0, "compaction must not run while the switch is off");
  }));

test("M3 auto-compaction stays put below the threshold", () =>
  withBridge(
    { config: { autoCompact: true, autoCompactThresholdPct: 80 }, planFor: planAtUsage(40) },
    async (bridge) => {
      const adapter = bridge.addAdapter("stub");
      const calls = [];
      bridge.ctx.provide("agentPresets", compactionService(calls));

      await bridge.inbound(inboundFor("stub", "chat-under", { text: "a short turn" }));
      assert.ok(await waitFor(() => cards(adapter).length > 0, 5_000), "the turn must have completed");
      assert.equal(calls.length, 0, "40% must not trigger an 80% threshold");
    },
  ));

test("M4 a per-chat override turns auto-compaction on for that chat", () =>
  withBridge(
    { config: { autoCompact: false, autoCompactThresholdPct: 80 }, planFor: planAtUsage(90) },
    async (bridge) => {
      bridge.addAdapter("stub");
      const calls = [];
      bridge.ctx.provide("agentPresets", compactionService(calls));
      bridge.seedBinding(bindingFor("stub", "chat-override-on", { autoCompact: true }));

      await bridge.inbound(inboundFor("stub", "chat-override-on", { text: "fill the window" }));
      assert.ok(
        await waitFor(() => calls.length > 0, 5_000),
        "the binding's autoCompact must override the plugin config",
      );
      assert.equal(bridge.runnerFor("stub", "chat-override-on").autoCompact, true);
    },
  ));

test("M5 every turn-end card reports the context percentage", () =>
  withBridge({ planFor: planAtUsage(85) }, async (bridge) => {
    const adapter = bridge.addAdapter("stub");
    await bridge.inbound(inboundFor("stub", "chat-pct", { text: "a task" }));
    assert.ok(
      await waitFor(() => cards(adapter).some((c) => c.markdown.includes("Context usage")), 5_000),
      `every turn must report context usage; got ${JSON.stringify(cards(adapter).map((c) => c.markdown))}`,
    );
    const card = cards(adapter).find((c) => c.markdown.includes("Context usage"));
    assert.ok(
      card.markdown.includes("85%"),
      `the report must carry the actual percentage; got ${JSON.stringify(card.markdown)}`,
    );
  }));

test("M6 the turn-end card names the auto-compaction rule when it is on", () =>
  withBridge(
    { config: { autoCompact: true, autoCompactThresholdPct: 80 }, planFor: planAtUsage(30) },
    async (bridge) => {
      const adapter = bridge.addAdapter("stub");
      await bridge.inbound(inboundFor("stub", "chat-armed", { text: "a task" }));
      assert.ok(
        await waitFor(() => cards(adapter).some((c) => c.markdown.includes("Context usage")), 5_000),
        "the turn-end card must report context usage",
      );
      const card = cards(adapter).find((c) => c.markdown.includes("Context usage"));
      // With auto-compaction on, telling the user to send /compact by hand
      // would be wrong — it is already handled.
      assert.ok(
        !card.markdown.includes("/compact"),
        `an armed chat must not be told to compact by hand; got ${JSON.stringify(card.markdown)}`,
      );
      assert.ok(
        card.markdown.includes("Auto-compaction is on"),
        `the card must state the active rule; got ${JSON.stringify(card.markdown)}`,
      );
    },
  ));

// ---------------------------------------------------------------------------
// L. The per-chat override writers
// ---------------------------------------------------------------------------

/**
 * `/model`, `/reasoning`, `/lang`, `/notify` and `/progress` are the only way
 * the settings the pane exposes ever reach a *chat*. Both halves matter and only
 * one of them was covered: E1/E2 prove a binding's override is *read* when the
 * runner is built, and nothing proved anything is ever *written* — a setter that
 * updated `this.language` but forgot `bindings.put` would pass the whole suite
 * while silently reverting on the next process restart.
 */

/**
 * Wait for the turn to have *ended*, not merely to have been acknowledged.
 *
 * The ack is sent as the turn starts, so `waitFor(() => texts(adapter).length >
 * 0)` returns while the turn is still in flight — and a fresh chat has no
 * binding at all until the turn finishes and `recordSession` writes one. A test
 * that reads the binding at the ack is racing the turn it just started, and one
 * that *deletes* a binding at the ack can have it re-created a moment later,
 * quietly exercising the wrong branch of the setter it means to test.
 */
function turnRecorded(bridge, channel, chatKey) {
  return waitFor(() => (bridge.binding(channel, chatKey)?.sessionId ?? "") !== "", 5_000);
}

test("L1 a model change saves the selection, carries the reasoning effort, and starts a new session", () =>
  withBridge({}, async (bridge) => {
    const adapter = bridge.addAdapter("stub");
    // The host's *current* selection is what the carry-over reads. Switching
    // model must not silently drop the effort the user had chosen: the key
    // would be gone from the profile and the next turn would run at whatever
    // the provider defaults to, with nothing in the chat to show it.
    bridge.defaultModel.currentSelection = () => ({
      provider: "harness-provider",
      model: "harness-model",
      reasoningEffort: "high",
    });
    const saved = [];
    bridge.defaultModel.saveSelection = async (selection) => {
      saved.push(selection);
    };

    const msg = inboundFor("stub", "chat-model");
    await bridge.inbound(msg);
    assert.ok(await turnRecorded(bridge, "stub", "chat-model"), "the turn must have completed");

    const runner = bridge.runnerFor("stub", "chat-model");
    const before = bridge.binding("stub", "chat-model");
    assert.ok(before.sessionId !== "", "the turn must have bound a session");
    assert.equal(before.sessions.length, 1, "and recorded it in the chat's session list");

    await runner.setModel("prov-x", "model-y", msg);

    assert.deepEqual(
      saved,
      [{ provider: "prov-x", model: "model-y", reasoningEffort: "high" }],
      "the new model must be saved with the effort that was already in force",
    );

    const after = bridge.binding("stub", "chat-model");
    // A model change is a new conversation: the next message must not resume the
    // old session and answer under the new model as if it had always been there.
    assert.equal(after.sessionId, "", "the binding must stop pointing at the old session");
    // …but the chat's history is not the model's business. Losing it here would
    // drop the session from the switch list on a single model change.
    assert.deepEqual(after.sessions, before.sessions, "the session list must survive the reset untouched");
    assert.equal(runner.agent, undefined, "the live agent must have been let go");
    assert.equal(
      bridge.agentOf(before.sessionId).cancelCalls.length,
      1,
      "the abandoned session's agent must be cancelled, not leaked",
    );
    // Cancelling stops the work; the handle is the host's own registration of
    // the session. Both have to go, and only one of them can be observed from
    // the agent — an un-released handle is invisible until the host runs out.
    assert.equal(bridge.counts.handleDisposals, 1, "the host handle must be released as well as the agent cancelled");
  }));

test("L2 clearing the reasoning effort writes a selection with no effort key at all", () =>
  withBridge({}, async (bridge) => {
    const adapter = bridge.addAdapter("stub");
    bridge.defaultModel.currentSelection = () => ({
      provider: "harness-provider",
      model: "harness-model",
      reasoningEffort: "high",
    });
    const saved = [];
    bridge.defaultModel.saveSelection = async (selection) => {
      saved.push(selection);
    };

    const msg = inboundFor("stub", "chat-effort");
    await bridge.inbound(msg);
    assert.ok(await turnRecorded(bridge, "stub", "chat-effort"), "the turn must have completed");

    await bridge.runnerFor("stub", "chat-effort").setReasoning(undefined, msg);

    assert.equal(saved.length, 1, "the effort is the thing being changed, so the selection must be written");
    // `undefined` is the explicit *clear*. A payload carrying
    // `reasoningEffort: undefined` is indistinguishable from one that omits the
    // key once it is serialized, and forwarding the old value instead would look
    // identical in the UI while quietly leaving the effort on.
    assert.ok(
      !("reasoningEffort" in saved[0]),
      `the key must be absent, not undefined; got ${JSON.stringify(saved[0])}`,
    );
    assert.deepEqual(Object.keys(saved[0]).sort(), ["model", "provider"]);
  }));

test("L3 a language change is persisted on the binding and switches the reply at once", () =>
  withBridge({}, async (bridge) => {
    const adapter = bridge.addAdapter("stub");
    const msg = inboundFor("stub", "chat-lang");
    await bridge.inbound(msg);
    assert.ok(await turnRecorded(bridge, "stub", "chat-lang"), "the turn must have completed");

    const runner = bridge.runnerFor("stub", "chat-lang");
    assert.equal(runner.language, "en", "the bridge was built with `language: \"en\"`");
    const sessionBefore = bridge.binding("stub", "chat-lang").sessionId;

    await runner.setLanguage("zh", { channel: "stub", chatId: "chat-lang" }, msg);

    assert.equal(runner.language, "zh", "the switch must take effect for this chat immediately");
    // The binding already existed, so this is the *update* branch — the session
    // it points at must come through untouched. A pass here through the create
    // branch would look identical on the assertion below while having thrown the
    // chat's session away.
    assert.equal(
      bridge.binding("stub", "chat-lang").sessionId,
      sessionBefore,
      "changing the language must not disturb the session",
    );
    // The setting is a *chat* setting, so it has to outlive the process. It is
    // read back as `stored?.language` when the runner is next constructed (E1).
    assert.equal(bridge.binding("stub", "chat-lang").language, "zh", "and be written to the binding");
    const confirmation = texts(adapter).at(-1).text;
    assert.ok(
      confirmation.includes("语言已切换为 中文"),
      `the confirmation must come from the language just chosen; got ${JSON.stringify(confirmation)}`,
    );
  }));

test("L4 a setting changed on a chat with no binding creates one that claims no session", () =>
  withBridge({}, async (bridge) => {
    const adapter = bridge.addAdapter("stub");
    const msg = inboundFor("stub", "chat-orphan");
    await bridge.inbound(msg);
    // The wait is load-bearing rather than polite: `recordSession` writes the
    // binding as the turn *ends*, so dropping it before this point would race the
    // very write this test is about to delete — and the setter would then take
    // the update branch while the assertions below still passed.
    assert.ok(await turnRecorded(bridge, "stub", "chat-orphan"), "the turn must have completed");

    // A binding that is simply gone — a pruned or hand-edited `bindings.json`, a
    // state dir that was reset — while the runner for that chat is still live.
    // Nothing else recreates it, so if the setter only handled the update branch
    // the override would be accepted and then silently discarded.
    bridge.dropBinding("stub", "chat-orphan");
    await bridge
      .runnerFor("stub", "chat-orphan")
      .setNotifyLevel("important", { channel: "stub", chatId: "chat-orphan" }, msg);

    const created = bridge.binding("stub", "chat-orphan");
    assert.ok(created, "the setting must land somewhere durable rather than evaporate");
    assert.equal(created.notifyLevel, "important");
    assert.equal(created.chatType, "p2p", "the new record must still be routeable");
    assert.equal(created.ownerKey, "user-1", "…and owned by whoever asked for the change");
    // `sessionId: ""` is the honest value here: the chat has no session right
    // now. A fabricated id would make the next turn try to resume a session that
    // never existed and — through the J1 notice — tell the user their
    // conversation had been lost.
    assert.equal(created.sessionId, "", "the new binding must not claim a session");
    assert.deepEqual(created.sessions, []);
    assert.ok(
      texts(adapter).at(-1).text.includes("Notification level set to: Key milestones"),
      `the change must still be confirmed; sent ${JSON.stringify(texts(adapter))}`,
    );
  }));
