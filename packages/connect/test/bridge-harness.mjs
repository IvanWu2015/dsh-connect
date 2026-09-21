/**
 * The offline bridge harness: a real `ConnectService` + real `AgentRunner`
 * driven by a *scripted* agent and a *recording* adapter.
 *
 * Extracted from `e2e-bridge.mjs`'s offline leg, which proved the wiring works,
 * so that `runner.test.mjs` can assert on the same code path without a second
 * copy of it. Everything here is in-process and network-free: no model key, no
 * host process, no channel SDK. The only two things faked are the two things
 * that would need the outside world —
 *
 *   `agents`  — an `AgentRegistry` whose `create`/`resume` hand back a
 *               `scriptedAgent` that emits the host's real session-event
 *               vocabulary (`turn/start` → `step/start` → `request/context` →
 *               `assistant/message` → `turn/end`) on a real cordis `Context`.
 *   adapter   — a `ChannelAdapter` that records every delivery instead of
 *               putting bytes on a wire.
 *
 * Everything between them is production code: the allowlist, the dedup window,
 * the binding store, the mirror lock, `driveAgent`, the streaming drain,
 * `summarizeTurn`, `sendTurnStats`, `sendSummary`.
 *
 * ## Caveat callers must know: the state directory
 *
 * `ConnectService` merges `dsh.shared.config.json` (read from cwd, then its
 * parent) *over* the config passed to `apply` — and the shared file wins. This
 * repo's own `dsh.shared.config.json` pins `state.stateDir` to `.dsh-connect`,
 * so a `stateDir` handed to `makeBridge` from a cwd inside the repo would be
 * silently discarded and every store would read and write the *repo's*
 * `.dsh-connect` instead of the throwaway one.
 *
 * `makeBridge` therefore refuses to run under those conditions: it compares the
 * resolved dir against the one asked for and throws rather than quietly write
 * somewhere else. Callers must `process.chdir()` into a directory with no
 * shared config first — `runner.test.mjs` does it at module scope, `e2e-bridge`
 * inside its offline leg.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { Context } from "@deepseek-ai/cordis";

import * as connect from "../lib/index.js";

/** Poll `predicate` until it holds or `timeoutMs` elapses. Returns the verdict. */
export async function waitFor(predicate, timeoutMs, intervalMs = 25) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return predicate();
}

/** Flatten a `createUserMessage()` result down to the text it carries. */
export function userMessageText(message) {
  const content = message?.content ?? message?.message?.content ?? [];
  if (typeof content === "string") return content;
  return (Array.isArray(content) ? content : [])
    .map((block) => (typeof block === "string" ? block : (block?.text ?? "")))
    .join("");
}

/** Every text delivered to an adapter, in order — the ack is index 0. */
export function texts(adapter) {
  return adapter.sent.filter((m) => m.kind === "text");
}

/** Every card delivered to an adapter, in order. */
export function cards(adapter) {
  return adapter.sent.filter((m) => m.kind === "card");
}

/**
 * A stand-in for `dsh-agent`'s `Agent` that satisfies exactly the contract
 * `AgentRunner` consumes, and nothing more:
 *
 *   `id` / `session.id` — `onSessionEvent` drops every event whose session id
 *   doesn't match the run's agent, so these must be equal.
 *   `session.seq` — snapshot point for `firstSeq`; `summarizeTurn` ignores
 *   events below it.
 *   `session.snapshotEvents()` — the durable event log.
 *   `followup(message)` — starts the turn.
 *   `whenIdle()` — resolves when the turn settles.
 *   `ctx.on("session/event" | "agent/assistant-stream")` — the live feed.
 *
 * `plan` selects which shape of turn to script:
 *
 *   `answer`        the assistant's text (default `"answer"`); `""` scripts a
 *                   turn that produces nothing, so `TurnOutcome.text` is `""`.
 *   `reason`        the `turn/end` reason kind (default `"completed"`). Use
 *                   `"aborted"` for a non-completed turn: `{kind:"error"}`
 *                   would dereference `reason.error.code` in `summarizeTurn`
 *                   and throw, so it cannot be scripted this way.
 *   `usage`         `assistant/message` usage; `null` omits the event.
 *   `context`       `false` omits `request/context` (so no model is recorded
 *                   and `hasStats` can be made false).
 *   `steps`         how many `step/start` events to emit.
 *   `whenIdleError` message for a `whenIdle()` rejection — the only way to
 *                   reach `runTurn`'s catch, since `driveAgent` calls
 *                   `agent.followup(...)` *without* awaiting it, so a rejecting
 *                   `followup` escapes as an unhandled rejection instead.
 */
export function scriptedAgent(id, plan = {}) {
  const {
    answer = "answer",
    reason = "completed",
    usage = { inputTokens: 1234, outputTokens: 56, cacheReadTokens: 0 },
    context = true,
    steps = 1,
    whenIdleError,
  } = plan;

  const ctx = new Context();
  const events = [];
  const session = { id, seq: 0, snapshotEvents: () => events.slice() };
  let seq = 0;

  const agent = {
    id,
    ctx,
    session,
    status: "idle",
    options: { provider: "harness-provider", model: "harness-model" },
    /** Every user message the runner handed us — assertion material. */
    followupCalls: [],
    /** How many turns this agent has been asked to run. */
    async followup(message) {
      agent.followupCalls.push(message);
      const emit = (type, data) => {
        const event = { seq: ++seq, time: Date.now(), type, data };
        events.push(event);
        session.seq = seq;
        ctx.emit("session/event", session, event);
      };
      emit("turn/start", {});
      for (let i = 0; i < steps; i++) emit("step/start", {});
      if (context) emit("request/context", { provider: "harness-provider", model: "harness-model", contextWindow: 65536 });
      if (answer !== "") {
        // The live delta feed: this is what drives the streaming card and sets
        // `turn.lastText`. It is a separate event from `session/event`.
        ctx.emit("agent/assistant-stream", {
          frame: {
            type: "chunk",
            attemptId: 1,
            revision: 1,
            index: 0,
            time: Date.now(),
            chunk: { type: "text-delta", index: 0, text: answer },
          },
        });
      }
      if (answer !== "" && usage !== null) {
        emit("assistant/message", {
          usage,
          message: { content: [{ type: "text", text: answer }] },
        });
      }
      emit("turn/end", { reason: { kind: reason } });
    },
    async whenIdle() {
      if (whenIdleError !== undefined) throw new Error(whenIdleError);
    },
  };
  return agent;
}

/** A recording adapter — the far end of the bridge, and the assertion surface. */
export function recordingAdapter(id) {
  const sent = [];
  const adapter = {
    id,
    sent,
    async start() {},
    async stop() {},
    async sendText(target, text) {
      sent.push({ kind: "text", target, text });
    },
    async sendCard(target, card) {
      sent.push({ kind: "card", target, markdown: card.markdown });
    },
    async streamText(target, chunks) {
      // The real adapter drains the chunk queue into an editable card; here we
      // only need to prove the queue is properly terminated and carries the
      // model's output.
      let text = "";
      for await (const chunk of chunks) text += chunk;
      sent.push({ kind: "stream", target, text });
    },
    async promptChoice() {
      return { choice: undefined, messageId: "harness-msg" };
    },
    async closeMenu() {},
    onInbound() {},
  };
  return adapter;
}

/**
 * Build a live bridge: a real root `Context` with the host services
 * `dsh-connect` injects, a real `ConnectService`, and a Map-backed
 * `AgentRegistry` whose sessions are scripted.
 *
 * `planFor(sessionId, ordinal)` picks the script for each session the runner
 * creates; pass a single plan object to use it for every session.
 *
 * Returns handles rather than a class so a test can reach into exactly the
 * private state it needs (`bindings`, `runners`) without a second harness.
 */
/** The separator `runnerKey` uses in service.ts — spelled out, not embedded. */
const NUL = String.fromCharCode(0);

export async function makeBridge({ stateDir, language = "en", config = {}, planFor = {}, presets } = {}) {
  const dir = stateDir ?? mkdtempSync(join(tmpdir(), "dsh-connect-harness-"));
  const ctx = new Context();

  const registry = new Map();
  /**
   * Session lifecycle counters. `creates` is the "a brand-new session was spun
   * up" signal; `resumes` counts only *successful* resumes, and `resumeMisses`
   * the attempts that had nothing to resume.
   *
   * `resumeMisses > 0` is the normal first-turn shape, not an anomaly: on a
   * fresh chat `maybeSendWelcome` persists a binding with `sessionId: ""`
   * *before* `ensureAgent` runs, so the runner asks to resume the empty id, the
   * host has no such session, and it falls through to `create`.
   */
  const counts = { creates: 0, resumes: 0, resumeMisses: 0 };
  const agentCtx = new Context();
  const plan = typeof planFor === "function" ? planFor : () => planFor;

  const agents = {
    get: (id) => registry.get(String(id)),
    async create({ sessionId, setup }) {
      counts.creates += 1;
      // `composeSetup` degrades to a no-op when the host has no presets; call
      // it anyway so the composed setup is exercised rather than assumed.
      await setup?.(agentCtx);
      const id = String(sessionId);
      const agent = scriptedAgent(id, plan(id, counts.creates));
      registry.set(id, agent);
      return { agent, session: agent.session };
    },
    async resume({ resumeSessionId, setup }) {
      await setup?.(agentCtx);
      const id = String(resumeSessionId);
      const existing = registry.get(id);
      // Only a session this process actually knows can be resumed — there is no
      // session store on disk here. The host behaves the same way for an id it
      // has never seen, and `AgentRunner` treats a failed resume as "fall
      // through to a fresh session", so throwing here is the faithful choice:
      // a resume that always succeeded would hide that fallback entirely.
      if (existing === undefined) {
        counts.resumeMisses += 1;
        throw new Error(`harness: no session ${JSON.stringify(id)} to resume`);
      }
      counts.resumes += 1;
      return { agent: existing, session: existing.session };
    },
  };

  ctx.provide("agents", agents);
  ctx.provide("sessions", { flush: async () => {} });
  /**
   * Everything the plugin routes through `logger.info`. Captured rather than
   * printed so a test can assert on a diagnostic instead of a side effect —
   * the preset-degradation path is *only* observable this way, since it
   * deliberately fails soft.
   */
  const logs = [];
  ctx.provide("logger", { info: (message) => logs.push(String(message)), warn: (message) => logs.push(String(message)) });
  // The host's preset roster. Absent by default, which is the shallow path
  // `composeSetup` takes on a host with no presets at all; a test that wants
  // the resolution path supplies its own stub.
  if (presets !== undefined) ctx.provide("agentPresets", presets);
  ctx.provide("agentDefaultModel", { currentSelection: () => ({ provider: "harness-provider", model: "harness-model" }) });
  // The credential store is a row in the always-loaded dsh-base bundle, so the
  // plugin requires it; an in-memory stand-in keeps this harness offline.
  const credentials = new Map();
  ctx.provide("credentials", {
    async resolve(ref) { return credentials.get(ref) ?? null; },
    async describe(ref) { return { configured: credentials.has(ref) }; },
    async set(ref, value) { credentials.set(ref, value); },
    async unset(ref) { credentials.delete(ref); },
  });

  // No channels by default: `activateChannels` defaults to ALL built-ins, and
  // feishu with no credentials would enter the interactive onboarding flow.
  await connect.apply(ctx, { channels: [], stateDir: dir, language, ...config });

  const service = ctx.get("connect");
  if (service === undefined) throw new Error("harness: ConnectService was not registered on the context");
  // Fail loudly if the state dir was overridden. The merge above is silent, and
  // the failure it causes is not: the bridge reads and writes a *different*
  // `.dsh-connect` than the caller thinks, so a test can pass while leaking
  // state across runs, and a caller that then deletes `dir` deletes nothing
  // while the real dir keeps growing. Cheaper to refuse than to debug.
  const effective = resolve(service.config.stateDir ?? "");
  if (effective !== resolve(dir)) {
    throw new Error(
      `harness: stateDir was overridden by dsh.shared.config.json — asked for ${resolve(dir)}, got ${effective}. ` +
        "process.chdir() into a directory with no shared config before calling makeBridge().",
    );
  }

  const bridge = {
    ctx,
    service,
    /** The registry the runner calls into — `registry.get(sessionId)`. */
    registry,
    counts,
    /** The credential store stand-in, for asserting onboarding writes land. */
    credentials,
    /** Every `connect:` line the plugin logged, in order. */
    logs,
    /** The state dir in effect — identical to the one asked for, or `makeBridge` threw. */
    stateDir: effective,
    /** Adapters registered through `addAdapter`, in registration order. */
    adapters: [],

    /** Register a recording adapter and hand it back. */
    addAdapter(id) {
      const adapter = recordingAdapter(id);
      service.registerAdapter(adapter);
      bridge.adapters.push(adapter);
      return adapter;
    },

    /** The runner `ConnectService` built for a (channel, chatKey) pair, if any. */
    runnerFor(channel, chatKey) {
      return service["runners"].get([channel, chatKey].join(NUL));
    },

    /** The persisted binding record for a chat, if any. */
    binding(channel, chatKey) {
      return service["bindings"].get(channel, chatKey);
    },

    /** Seed a binding record before any turn runs (e.g. to hold the mirror lock). */
    seedBinding(binding) {
      service["bindings"].put(binding);
    },

    /** One inbound message, through the real `handleInbound` gate. */
    inbound(msg) {
      return service.handleInbound({ chatType: "p2p", ...msg });
    },

    /** The scripted agent registered for a session id, if any. */
    agentOf(sessionId) {
      return registry.get(String(sessionId));
    },

    /**
     * Tear the context down. This is not tidiness: the binding and reminder
     * stores flush on timers, and a live service happily rewrites
     * `bindings.json` into the state dir minutes after the assertions pass —
     * including after the caller has already deleted it.
     */
    async dispose() {
      await ctx.fiber.dispose();
    },
  };
  return bridge;
}
