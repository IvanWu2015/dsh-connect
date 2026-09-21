/**
 * End-to-end bridge verification: inbound message → agent turn → outbound reply.
 *
 * Every other suite stops short of this. `smoke.mjs` asserts the *transport*
 * contract (`sends > 0` — any message at all reached the adapter); the unit
 * suites assert pieces in isolation. Nothing has ever driven a real inbound
 * through a real `ConnectService` + real `AgentRunner` and asserted that the
 * agent's actual answer came back out of the adapter.
 *
 * Two legs, strongest-first:
 *
 *   Leg 1 — offline, always runs. Real `ConnectService` and real `AgentRunner`,
 *   with a *scripted* agent standing in for the model. The scripted agent emits
 *   the same event vocabulary the host's `dsh-agent` emits (`turn/start` →
 *   `step/start` → `request/context` → `assistant/message` → `turn/end`), so
 *   everything between the adapter and the agent is the production code path:
 *   the dedup window, the binding store, the lock, `driveAgent`, the streaming
 *   card, `summarizeTurn`, and `sendTurnStats`. No network, no model key, no
 *   host process — so it runs everywhere, including CI.
 *
 *   Leg 2 — live, runs when a `dsh` launcher is on PATH. Spawns a real host
 *   against a throwaway `DSH_HOME` wired to a mock Telegram Bot API and a mock
 *   OpenAI-compatible endpoint, posts one inbound update, and waits for the
 *   assistant's answer to come back through `sendMessage`. This is the only
 *   evidence that the plugin still works against the *current* host build.
 *   When the environment can't support it (no `dsh` on PATH, no built `lib/`)
 *   it prints a loud `E2E SKIP` — never a silent pass.
 *
 * Prints `E2E OK` on success. `run-all.mjs` treats that marker as the signal
 * (like `SMOKE OK`) because a live `ConnectService` keeps handles alive past
 * the assertions.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Context } from "@deepseek-ai/cordis";

import * as connect from "../lib/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, "..");

const ANSWER = "pong-from-e2e";
const INBOUND_TEXT = "ping from the e2e bridge test";

/** Poll `predicate` until it holds or `timeoutMs` elapses. Returns the verdict. */
async function waitFor(predicate, timeoutMs, intervalMs = 25) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return predicate();
}

/** Flatten a `createUserMessage()` result down to the text it carries. */
function userMessageText(message) {
  const content = message?.content ?? message?.message?.content ?? [];
  if (typeof content === "string") return content;
  return (Array.isArray(content) ? content : [])
    .map((block) => (typeof block === "string" ? block : (block?.text ?? "")))
    .join("");
}

// ---------------------------------------------------------------------------
// Leg 1: the real bridge, in-process, with a scripted agent
// ---------------------------------------------------------------------------

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
 * The emitted sequence mirrors a one-step turn that ends with `completed`,
 * which is what makes `runTurn` skip the error/summary branch and send the
 * stats card carrying the answer.
 */
function scriptedAgent(id, answer) {
  const ctx = new Context();
  const events = [];
  const session = { id, seq: 0, snapshotEvents: () => events.slice() };
  let seq = 0;

  const agent = {
    id,
    ctx,
    session,
    status: "idle",
    options: { provider: "e2e-provider", model: "e2e-model" },
    /** Every user message the runner handed us — assertion material. */
    followupCalls: [],
    async followup(message) {
      agent.followupCalls.push(message);
      const emit = (type, data) => {
        const event = { seq: ++seq, time: Date.now(), type, data };
        events.push(event);
        session.seq = seq;
        ctx.emit("session/event", session, event);
      };
      emit("turn/start", {});
      emit("step/start", {});
      emit("request/context", { provider: "e2e-provider", model: "e2e-model", contextWindow: 65536 });
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
      emit("assistant/message", {
        usage: { inputTokens: 1234, outputTokens: 56, cacheReadTokens: 0 },
        message: { content: [{ type: "text", text: answer }] },
      });
      emit("turn/end", { reason: { kind: "completed" } });
    },
    async whenIdle() {},
  };
  return agent;
}

/** A recording adapter — the far end of the bridge, and the assertion surface. */
function recordingAdapter(id) {
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
      return { choice: undefined, messageId: "e2e-msg" };
    },
    async closeMenu() {},
    onInbound() {},
  };
  return adapter;
}

async function offlineLeg() {
  const stateDir = mkdtempSync(join(tmpdir(), "dsh-connect-e2e-"));
  const ctx = new Context();

  const registry = new Map();
  let created = 0;
  const agentCtx = new Context();
  const agents = {
    get: (id) => registry.get(String(id)),
    async create({ sessionId, setup }) {
      created += 1;
      // `composeSetup` degrades to a no-op when the host has no presets; call
      // it anyway so the composed setup is exercised rather than assumed.
      await setup?.(agentCtx);
      const agent = scriptedAgent(String(sessionId), ANSWER);
      registry.set(String(sessionId), agent);
      return { agent, session: agent.session };
    },
    async resume() {
      throw new Error("e2e: resume is not expected on a fresh chat");
    },
  };

  ctx.provide("agents", agents);
  ctx.provide("sessions", { flush: async () => {} });
  ctx.provide("agentDefaultModel", { currentSelection: () => ({ provider: "e2e-provider", model: "e2e-model" }) });
  // The credential store is a row in the always-loaded dsh-base bundle, so the
  // plugin requires it; an in-memory stand-in keeps this leg offline.
  const credentials = new Map();
  ctx.provide("credentials", {
    async resolve(ref) { return credentials.get(ref) ?? null; },
    async describe(ref) { return { configured: credentials.has(ref) }; },
    async set(ref, value) { credentials.set(ref, value); },
    async unset(ref) { credentials.delete(ref); },
  });

  // No channels: `activateChannels` defaults to ALL built-ins, and feishu with
  // no credentials would enter the interactive onboarding flow.
  await connect.apply(ctx, { channels: [], stateDir, language: "en" });

  const service = ctx.get("connect");
  assert.ok(service, "ConnectService must be registered on the context");

  const adapter = recordingAdapter("stub");
  service.registerAdapter(adapter);

  const inbound = {
    channel: "stub",
    chatKey: "chat-e2e",
    chatType: "p2p",
    senderKey: "user-e2e",
    text: INBOUND_TEXT,
    replyRef: "om-e2e-1",
  };

  await service.handleInbound(inbound);

  // The turn runs on a detached drain, so poll rather than sleep a fixed
  // amount — a fixed sleep is either flaky or needlessly slow. `answerCard` is
  // the single source of truth for "the reply arrived": the exact same
  // predicate gates the wait and the assertion below, so a mutation that
  // breaks delivery cannot be masked by the wait quietly timing out.
  const answerCard = () => adapter.sent.find((m) => m.kind === "card" && m.markdown.includes(ANSWER));
  // The run's own failure path is a `sendText` *after* the ack — independent of
  // locale, unlike matching the advice string itself.
  const failureText = () => adapter.sent.filter((m) => m.kind === "text")[1];
  await waitFor(() => answerCard() !== undefined || failureText() !== undefined, 10_000);

  const agent = [...registry.values()][0];
  const dump = JSON.stringify(adapter.sent, null, 2);

  assert.equal(failureText(), undefined, `the turn failed instead of answering; adapter saw:\n${dump}`);
  assert.ok(agent, "the runner must have created exactly one agent session");
  assert.equal(created, 1, "one inbound message must create exactly one session");

  // 1) inbound reached the agent as a user message
  assert.equal(agent.followupCalls.length, 1, `expected exactly one agent turn; adapter saw:\n${dump}`);
  const promptText = userMessageText(agent.followupCalls[0]);
  assert.ok(
    promptText.includes(INBOUND_TEXT),
    `the agent must receive the inbound text verbatim; got ${JSON.stringify(promptText)}`,
  );

  // 2) the agent's answer came back out through the adapter
  const card = answerCard();
  assert.ok(card, `the assistant's answer must reach the adapter; adapter saw:\n${dump}`);
  assert.equal(card.target.chatKey, "chat-e2e", "the reply must go to the originating chat");

  // 3) the streaming card saw the same text (the live delta path, not just the
  //    durable post-turn card)
  const streamed = adapter.sent.find((m) => m.kind === "stream");
  assert.ok(streamed, `the streaming card must be driven and terminated; adapter saw:\n${dump}`);
  assert.ok(streamed.text.includes(ANSWER), `the streaming card must carry the answer; got ${JSON.stringify(streamed.text)}`);

  // 4) re-delivery of the same message id is still dropped upstream of the agent
  await service.handleInbound({ ...inbound });
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(agent.followupCalls.length, 1, "a re-delivered message id must not start a second turn");

  // Tear the context down before returning. This is not tidiness: the binding
  // and reminder stores flush on timers, and a live service happily rewrites
  // `bindings.json` into the state dir minutes after the assertions pass —
  // including after the caller has already deleted it.
  await ctx.fiber.dispose();
  return { stateDir };
}

// ---------------------------------------------------------------------------
// Leg 2: the live host
// ---------------------------------------------------------------------------

/** Minimal Telegram Bot API. Only the methods the adapter actually calls. */
function startMockTelegram() {
  const state = { pending: [], sent: [], calls: [], nextId: 1 };
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      const method = (req.url ?? "/").split("/").filter(Boolean).pop() ?? "";
      let payload = {};
      try { payload = body === "" ? {} : JSON.parse(body); } catch { payload = {}; }
      state.calls.push(method);

      const reply = (result) => {
        const text = JSON.stringify({ ok: true, result });
        res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
        res.end(text);
      };

      if (method === "getMe") return reply({ id: 100, username: "e2e_bot", is_bot: true });
      if (method === "getUpdates") {
        // `offset: -1` is the startup "skip the backlog" call.
        if (payload.offset === -1 || payload.timeout === 0) return reply([]);
        const deadline = Date.now() + Number(payload.timeout ?? 0) * 1000;
        const tick = () => {
          if (state.pending.length > 0) return reply(state.pending.splice(0));
          if (Date.now() >= deadline) return reply([]);
          setTimeout(tick, 50);
        };
        return tick();
      }
      if (method === "sendMessage") {
        state.sent.push({ chatId: String(payload.chat_id), text: String(payload.text ?? "") });
        return reply({ message_id: state.nextId++, chat: { id: Number(payload.chat_id), type: "private" }, date: 0, text: payload.text });
      }
      if (method === "editMessageText") return reply({ message_id: payload.message_id ?? 0, chat: { id: Number(payload.chat_id) }, date: 0, text: payload.text });
      return reply({ message_id: state.nextId++ });
    });
  });
  return { server, state };
}

/** Minimal OpenAI-compatible Chat Completions endpoint, streamed as SSE. */
function startMockLlm(answer) {
  const state = { requests: [] };
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      if (req.method === "GET" && (req.url ?? "").includes("/models")) {
        const text = JSON.stringify({ object: "list", data: [{ id: "e2e-model", object: "model" }] });
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(text);
      }
      if (!(req.url ?? "").includes("chat/completions")) {
        res.writeHead(404, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: { message: `unrouted ${req.method} ${req.url}` } }));
      }
      try { state.requests.push(JSON.parse(body || "{}")); } catch { state.requests.push({ raw: body }); }
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      const frame = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
      const base = { id: "chatcmpl-e2e", object: "chat.completion.chunk", created: 0, model: "e2e-model" };
      frame({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: answer }, finish_reason: null }] });
      frame({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } });
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  return { server, state };
}

function listen(server) {
  return new Promise((done) => server.listen(0, "127.0.0.1", () => done(server.address().port)));
}

function closeServer(server) {
  return new Promise((done) => {
    server.closeAllConnections?.();
    server.close(() => done());
  });
}

/** Build a throwaway `DSH_HOME` whose web profile loads this plugin. */
function makeTempHome(connectDir, { telegramPort, llmPort, stateDir }) {
  const home = mkdtempSync(join(tmpdir(), "dsh-connect-e2e-home-"));
  const profile = join(home, "profiles", "web");
  mkdirSync(join(profile, "node_modules"), { recursive: true });

  writeFileSync(
    join(profile, "package.json"),
    `${JSON.stringify(
      {
        name: "dsh-profile-web",
        private: true,
        dependencies: { "dsh-connect": `link:${connectDir}` },
        dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-connect"] } },
      },
      null,
      2,
    )}\n`,
  );

  // A junction, not a copy: the profile must load the same built `lib/` the
  // offline leg just exercised.
  symlinkSync(connectDir, join(profile, "node_modules", "dsh-connect"), "junction");

  // The profile patch layer addresses dsh-base rows by id, so a plugin under
  // test does not need to be a bundle of its own to be configurable.
  writeFileSync(
    join(profile, "cordis.patch.yml"),
    [
      "# generated by test/e2e-bridge.mjs — throwaway",
      "- id: connect",
      "  config:",
      '    channels: ["telegram"]',
      `    stateDir: ${JSON.stringify(stateDir)}`,
      "    language: en",
      "    telegram:",
      "      botToken: e2e-fake-token",
      `      baseUrl: http://127.0.0.1:${telegramPort}`,
      "      pollingTimeoutSeconds: 1",
      "      requireMention: false",
      "- id: agent-default-model",
      "  config:",
      "    provider: e2e-mock",
      "    model: e2e-model",
      "- id: llm-pi-ai",
      "  config:",
      "    providers:",
      "      e2e-mock:",
      "        displayName: E2E Mock",
      "        apiKeyEnv: E2E_MOCK_API_KEY",
      "        api: openai-completions",
      `        baseURL: http://127.0.0.1:${llmPort}/v1`,
      "        models:",
      "          - id: e2e-model",
      "            name: E2E Mock",
      "            contextWindow: 65536",
      "            maxTokens: 4096",
      "",
    ].join("\n"),
  );

  return home;
}

/**
 * `dsh` is a host-provided CLI; the live leg is meaningless without it.
 *
 * Resolve it to `[command, prefixArgs]` we can spawn *without* a shell. On
 * Windows `dsh` is a `.cmd` shim, and spawning that through a shell makes
 * `child.pid` the shell's pid — so signals and `taskkill /T` end up aimed at
 * the wrong process and the host leaks. Reaching the real `bin.js` directly
 * keeps the handle honest.
 */
function resolveDsh() {
  const explicit = process.env.DSH_CLI;
  if (explicit !== undefined) return existsSync(explicit) ? [process.execPath, [explicit]] : undefined;

  const found = spawnSync(process.platform === "win32" ? "where" : "which", ["dsh"], { encoding: "utf8" });
  if (found.status !== 0) return undefined;
  const candidates = String(found.stdout).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (const candidate of candidates) {
    // The npm global layout: <prefix>/dsh + <prefix>/node_modules/@deepseek-ai/dsh/lib/bin.js
    const entry = join(dirname(candidate), "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
    if (existsSync(entry)) {
      const probe = spawnSync(process.execPath, [entry, "--version"], { encoding: "utf8", timeout: 60_000 });
      if (probe.status === 0) return [process.execPath, [entry]];
    }
  }
  return undefined;
}

async function liveLeg() {
  const skip = (reason) => {
    console.log(`E2E SKIP (live leg): ${reason}`);
    return { skipped: reason };
  };
  if (!existsSync(join(pkgRoot, "lib", "index.js"))) return skip("lib/ is not built — run `pnpm --filter dsh-connect build`");
  const dsh = resolveDsh();
  if (dsh === undefined) return skip("no `dsh` launcher on PATH (set DSH_CLI to a dsh entry script to override)");

  const stateDir = mkdtempSync(join(tmpdir(), "dsh-connect-e2e-state-"));
  const llm = startMockLlm(ANSWER);
  const telegram = startMockTelegram();
  const llmPort = await listen(llm.server);
  const telegramPort = await listen(telegram.server);

  const home = makeTempHome(pkgRoot, { telegramPort, llmPort, stateDir });
  let host;
  try {
    const [command, prefixArgs] = dsh;
    // 3210+ sits outside the range the user's own hosts occupy (3080/3090/3091).
    const port = 3210 + (process.pid % 200);
    host = spawn(command, [...prefixArgs, "web", "--port", String(port), "--no-open"], {
      env: { ...process.env, DSH_HOME: home, E2E_MOCK_API_KEY: "e2e-mock-key" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let log = "";
    host.stdout.on("data", (chunk) => { log += String(chunk); });
    host.stderr.on("data", (chunk) => { log += String(chunk); });
    let exited;
    host.on("exit", (code) => { exited = code ?? -1; });

    // The adapter has started once it has asked the Bot API who it is.
    const started = await waitFor(() => telegram.state.calls.includes("getMe") || exited !== undefined, 90_000);
    if (!started || exited !== undefined) throw new Error(`host did not start the telegram adapter (exit=${exited})\n${log}`);

    telegram.state.pending.push({
      update_id: 1,
      message: {
        message_id: 1,
        date: 0,
        text: "ping from the live e2e leg",
        from: { id: 42, is_bot: false, username: "e2e_user" },
        chat: { id: 42, type: "private" },
      },
    });

    const answered = await waitFor(() => telegram.state.sent.some((m) => m.text.includes(ANSWER)), 90_000);
    if (!answered) {
      // Deliberately not dumping the raw model requests: they carry the whole
      // agent system prompt, which buries the one line that matters.
      throw new Error(
        [
          "no assistant reply reached the Bot API.",
          `model calls: ${llm.state.requests.length} (last prompt had ${llm.state.requests.at(-1)?.messages?.length ?? 0} messages)`,
          `bot api calls: ${JSON.stringify(telegram.state.calls)}`,
          `sent: ${JSON.stringify(telegram.state.sent.map((m) => `${m.chatId}: ${m.text.slice(0, 80)}`))}`,
          `host log:\n${log}`,
        ].join("\n"),
      );
    }

    // Assert on both ends of the round trip: the model was actually consulted...
    assert.ok(llm.state.requests.length > 0, "the host must have called the model endpoint");
    // ...and the answer was delivered back into the chat.
    const delivered = telegram.state.sent.find((m) => m.text.includes(ANSWER));
    assert.equal(delivered.chatId, "42", "the reply must go back to the originating chat");
    console.log(`      live round trip: model call(s)=${llm.state.requests.length}, bot API methods=${JSON.stringify(telegram.state.calls)}`);
    return { skipped: undefined };
  } finally {
    if (host !== undefined && host.exitCode === null) {
      // On Windows a shell-spawned child needs a taskkill of its tree, or the
      // host keeps the profile's file handles open and the rm below fails.
      if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(host.pid), "/T", "/F"], { stdio: "ignore" });
      else host.kill("SIGKILL");
    }
    await closeServer(llm.server);
    await closeServer(telegram.server);
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    rmSync(stateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

// ---------------------------------------------------------------------------

const cleanup = [];

/**
 * Leave no trace, on every exit path. `maxRetries` matters on Windows: a file
 * handle that has not been released yet (an antivirus scan, a lingering flush)
 * makes the first unlink fail, and `force: true` would swallow that silently.
 */
function sweep() {
  for (const dir of cleanup) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

function bail(leg, error) {
  console.error(`E2E FAIL (${leg}):`, error?.message ?? error);
  sweep();
  process.exit(1);
}

try {
  const offline = await offlineLeg();
  cleanup.push(offline.stateDir);
  console.log(`      offline round trip: ${JSON.stringify(INBOUND_TEXT)} → ${JSON.stringify(ANSWER)} → adapter`);
} catch (error) {
  bail("offline leg", error);
}

let live;
try {
  live = await liveLeg();
} catch (error) {
  bail("live leg", error);
}

sweep();

console.log(
  live.skipped === undefined
    ? `E2E OK: inbound → agent turn → outbound verified offline and against a live dsh host`
    : `E2E OK (offline leg only — live leg skipped: ${live.skipped})`,
);
// Exit explicitly rather than hanging. Nothing can run after `process.exit`,
// which is what makes the sweep above final.
process.exit(0);
