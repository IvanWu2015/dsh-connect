/**
 * Per-chat agent driver: serializes inbound messages, creates/resumes the bound
 * DSH agent (with preset composition + model selection), and bridges the live
 * `session/event` stream into the adapter's streaming reply.
 * @module dsh-connect/runner
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { copyFile, readFile } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import { SessionId, SessionStore, type Session, type SessionEvent, type TodoItem } from "@deepseek-ai/dsh-session";
import { AgentRegistry, type Agent, type AgentHandle, type ModelSelection } from "@deepseek-ai/dsh-agent";
import { createUserMessage, ReasoningEffortId, type ContentBlock } from "@deepseek-ai/dsh-llm";
import type { ChannelAdapter, ChoiceOption, InboundMessage, OutboundTarget, SummaryCard, TurnOutcome, TurnReason } from "./types.js";
import { createAsyncQueue } from "./stream.js";
import { helpText, parseCommand, type Command } from "./commands.js";
import type { BindingStore, ChatBinding, ChatSessionRecord } from "./binding.js";
import { messages, type Language, type Messages } from "./i18n.js";
import {
  DEFAULT_LOCK_TIMEOUT_MS,
  acquire as lockAcquire,
  canWrite as lockCanWrite,
  isLockTimedOut as lockIsTimedOut,
  release as lockRelease,
  type QueuedMessage,
} from "./mirror-lock.js";
import { formatRemindAt, parseRemindTime, type ReminderStore } from "./scheduler.js";

export interface ConnectConfig {
  /** Agent preset id composed into each session; `undefined` = roster default. */
  agentPreset?: string;
  /** Absolute working directory for each bound agent; defaults to process cwd. */
  workDir?: string;
  /** Optional workspace directories offered by the `/dir` chooser. */
  workspaces?: string[];
  /** Vision-capable model used to describe images when the main model can't. */
  visionModel?: { provider: string; model: string };
  /** User-facing message language: `zh` (default) or `en`. */
  language?: Language;
  allowUsers?: string[];
  allowChats?: string[];
  stateDir?: string;
  /** Automatically create Web mirror for new sessions (default: true). */
  autoMirror?: boolean;
  /** Liveness heartbeat interval ms for the streaming card; 0 disables it (default: 60000). */
  streamHeartbeatMs?: number;
  /** Default notification level for streaming replies (default: `important`). */
  notifyLevel?: NotifyLevel;
  /** Proactive progress-notice interval ms: when a turn goes silent for this long, a standalone status card is sent (default: 300000 = 5 min; 0 disables). */
  progressTimeoutMs?: number;
}

export interface ResolvedConnectConfig {
  agentPreset?: string;
  workDir?: string;
  workspaces: string[];
  visionModel?: { provider: string; model: string };
  language: Language;
  allowUsers: string[];
  allowChats: string[];
  stateDir?: string;
  autoMirror: boolean;
  streamHeartbeatMs: number;
  notifyLevel: NotifyLevel;
  progressTimeoutMs: number;
}

export function resolveConnectConfig(config: ConnectConfig): ResolvedConnectConfig {
  return {
    agentPreset: config.agentPreset,
    workDir: config.workDir,
    workspaces: config.workspaces ?? [],
    visionModel: config.visionModel,
    language: config.language ?? "zh",
    allowUsers: config.allowUsers ?? [],
    allowChats: config.allowChats ?? [],
    stateDir: config.stateDir,
    autoMirror: config.autoMirror ?? true, // Enabled by default
    streamHeartbeatMs: config.streamHeartbeatMs ?? 60_000,
    notifyLevel: config.notifyLevel ?? "important",
    progressTimeoutMs: config.progressTimeoutMs ?? 5 * 60_000, // Proactive progress notice after 5 min of silence
  };
}

interface ActiveTurn {
  firstSeq: number;
  chunks: ReturnType<typeof createAsyncQueue<string>>;
  lastText: string;
  reasoning: boolean;
  /** Whether the thinking hint has been emitted for this turn. */
  hintPushed: boolean;
  /** Block index of the last content pushed into the chunk queue. */
  lastIndex: number | undefined;
  /** Whether any content has been pushed into the chunk queue. */
  pushedAny: boolean;
  /** Turn wall-clock start (for the liveness heartbeat). */
  startedAt: number;
  /** Last time a chunk/status line was pushed (for the liveness heartbeat). */
  lastPushAt: number;
  /** Latest user-visible milestone (thinking / last tool call) for the proactive progress notice. */
  milestone?: string;
  /** Number of tool calls observed in this turn (for the step counter). */
  toolCount: number;
  /** Latest observed context usage (input tokens) and window, for the proactive compaction nudge. */
  contextSize?: number;
  contextWindow?: number;
  /** Whether the proactive context-high nudge was already sent this turn (dedupe). */
  contextNudged: boolean;
  /** User confirmed compaction while the turn was still running — run it once the turn ends. */
  compactAfterTurn: boolean;
}

/** Per-turn streaming assembly state mutated by {@link applyStreamChunk}. */
export interface StreamState {
  chunks: { push(text: string): void };
  lastText: string;
  reasoning: boolean;
  hintPushed: boolean;
  lastIndex: number | undefined;
  pushedAny: boolean;
  lastPushAt: number;
}

/**
 * How much of the agent's live progress the streaming card shows.
 * - `full` — everything: reasoning text, tool calls, heartbeats, answer.
 * - `important` — key milestones only: thinking hint, tool calls, heartbeats, answer (no reasoning text).
 * - `result` — only the final answer.
 */
export type NotifyLevel = "full" | "important" | "result";

/** One assistant chunk event of interest to the streaming bridge. */
export interface StreamChunkLike {
  type: string;
  index?: number;
  text?: string;
  block?: { type?: string; text?: string };
}

/**
 * Assemble one `assistant/chunk` event into the streaming queue with visible
 * structure. DSH streams one block per LLM content block and block boundaries
 * carry no newline of their own, so without separators every block (and the
 * reasoning phase vs the final answer) would be glued together in the chat
 * card. This inserts a blank line between blocks and before the answer, keeps
 * the thinking hint once per turn, expands reasoning soft breaks (Feishu's
 * streaming card collapses single `\n`), and falls back to whole-block text
 * for blocks that arrived only via `block-end`. Every push refreshes
 * `lastPushAt` so the liveness heartbeat knows the card is still moving.
 * @param state - the turn's mutable assembly state.
 * @param thinkingHint - localized hint text pushed at the first reasoning delta.
 * @param chunk - the assistant chunk event's `chunk` payload.
 */
/** Every line-break run becomes a paragraph break (Feishu's streaming card collapses single `\n`). */
function expandLineBreaks(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(/\n+/g, "\n\n");
}

export function applyStreamChunk(state: StreamState, thinkingHint: string, chunk: StreamChunkLike, level: NotifyLevel = "full"): void {
  if (chunk.type === "text-delta" || chunk.type === "reasoning-delta") {
    const isReasoning = chunk.type === "reasoning-delta";
    // Reasoning content is only streamed in `full` mode; `important` shows
    // just the thinking hint and `result` shows nothing until the answer.
    if (isReasoning && level !== "full") {
      if (level === "important" && !state.hintPushed) {
        state.hintPushed = true;
        state.chunks.push(thinkingHint);
        state.pushedAny = true;
        state.lastPushAt = Date.now();
      }
      return;
    }
    if (state.pushedAny) {
      const newBlock = chunk.index !== undefined && state.lastIndex !== undefined && chunk.index !== state.lastIndex;
      const reasoningToAnswer = !isReasoning && state.reasoning;
      if (newBlock || reasoningToAnswer) state.chunks.push("\n\n");
    }
    if (isReasoning) {
      if (!state.hintPushed) {
        state.hintPushed = true;
        state.chunks.push(thinkingHint);
      }
      const text = chunk.text ?? "";
      if (text !== "") {
        state.chunks.push(expandLineBreaks(text));
      }
      state.reasoning = true;
    } else {
      const text = chunk.text ?? "";
      state.chunks.push(text);
      state.lastText += text;
      state.reasoning = false;
    }
    state.lastIndex = chunk.index;
    state.pushedAny = true;
    state.lastPushAt = Date.now();
    return;
  }
  if (chunk.type === "block-end") {
    // Short blocks may arrive whole here with no preceding delta chunks.
    // Fall back to the block text when this index never streamed deltas, so
    // no content is silently dropped (guarded by index against duplication;
    // each step restarts block indices, and a tool call resets `lastIndex`,
    // so a same-index block-end after streamed deltas is reliably detected).
    const index = chunk.index;
    const blockType = chunk.block?.type;
    const text = chunk.block?.text;
    if (blockType === "reasoning" && level !== "full") {
      // Reasoning block text is never streamed outside `full` mode.
      if (level === "important" && !state.hintPushed) {
        state.hintPushed = true;
        state.chunks.push(thinkingHint);
        state.pushedAny = true;
        state.lastPushAt = Date.now();
      }
      return;
    }
    if (typeof text === "string" && text.length > 0 && (index === undefined || index !== state.lastIndex)) {
      if (state.pushedAny) state.chunks.push("\n\n");
      if (blockType === "reasoning" && !state.hintPushed) {
        state.hintPushed = true;
        state.chunks.push(thinkingHint);
      }
      state.chunks.push(blockType === "reasoning" ? expandLineBreaks(text) : text);
      if (blockType !== "reasoning") state.lastText += text;
      state.lastIndex = index;
      state.pushedAny = true;
      state.reasoning = blockType === "reasoning";
      state.lastPushAt = Date.now();
    }
  }
}

/**
 * Push a localized tool-call status line into the streaming queue so long
 * tool-execution stretches stay visibly alive (the Web GUI shows tool calls;
 * the chat card should too). Ends the reasoning phase and drops the block
 * index so the next content block gets its own separator instead of stacking
 * one on top of the tool line's own blank lines.
 * @param state - the turn's mutable assembly state.
 * @param label - the localized status line, e.g. "🔧 调用工具 `pwsh` — …".
 */
export function applyToolCall(state: StreamState, label: string): void {
  state.chunks.push(`\n\n${label}\n\n`);
  state.reasoning = false;
  state.lastIndex = undefined;
  state.pushedAny = true;
  state.lastPushAt = Date.now();
}

/** Pull a short human summary out of a tool call's `arguments` JSON (whitespace folded to one line). */
export function toolCallSummary(argumentsJson: unknown): string | undefined {
  if (typeof argumentsJson !== "string") return undefined;
  const fold = (value: string): string => value.replace(/\s+/g, " ").trim();
  try {
    const parsed = JSON.parse(argumentsJson);
    const description = parsed?.description;
    if (typeof description === "string" && description !== "") {
      const folded = fold(description);
      return folded.length > 60 ? `${folded.slice(0, 60)}…` : folded;
    }
    for (const key of ["file_path", "path"]) {
      const value = parsed?.[key];
      if (typeof value === "string" && value !== "") {
        const folded = fold(value);
        return folded.length > 60 ? `${folded.slice(0, 60)}…` : folded;
      }
    }
  } catch {
    // Not JSON — no summary.
  }
  return undefined;
}

/** Pull the first question's text out of an `ask_user_question` arguments JSON (whitespace folded to one line). */
export function questionTextOf(argumentsJson: unknown): string {
  if (typeof argumentsJson !== "string") return "";
  try {
    const parsed = JSON.parse(argumentsJson);
    const first = Array.isArray(parsed?.questions) ? parsed.questions[0] : undefined;
    const text = typeof first?.question === "string" ? first.question : "";
    const folded = text.replace(/\s+/g, " ").trim();
    return folded.length > 60 ? `${folded.slice(0, 60)}…` : folded;
  } catch {
    // Not JSON — no question text.
  }
  return "";
}

function mapReason(kind: string): TurnReason {
  switch (kind) {
    case "completed":
    case "aborted":
    case "blocked":
    case "error":
    case "max-tokens":
    case "interrupted":
      return kind;
    default:
      return "unknown";
  }
}

export function summarizeTurn(events: readonly SessionEvent[], firstSeq: number): TurnOutcome {
  let started = false;
  let text = "";
  let reason: TurnReason = "unknown";
  let code: string | undefined;
  let message: string | undefined;
  let model: string | undefined;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let contextSize: number | undefined;
  let contextWindow: number | undefined;
  let steps = 0;
  let turnStartTime: number | undefined;
  let turnEndTime: number | undefined;
  for (const event of events) {
    if (event.seq < firstSeq) continue;
    if (event.type === "turn/start") {
      started = true;
      turnStartTime = typeof event.time === "number" ? event.time : undefined;
      continue;
    }
    if (!started) continue;
    if (event.type === "step/start") steps += 1;
    if (event.type === "request/context") {
      const provider = typeof event.data.provider === "string" ? event.data.provider : undefined;
      const m = typeof event.data.model === "string" ? event.data.model : undefined;
      if (provider !== undefined && m !== undefined) model = `${provider}/${m}`;
      if (typeof event.data.contextWindow === "number") contextWindow = event.data.contextWindow;
    }
    if (event.type === "assistant/message") {
      const usage = event.data.usage;
      if (usage !== undefined) {
        inputTokens += typeof usage.inputTokens === "number" ? usage.inputTokens : 0;
        outputTokens += typeof usage.outputTokens === "number" ? usage.outputTokens : 0;
        cacheReadTokens += typeof usage.cacheReadTokens === "number" ? usage.cacheReadTokens : 0;
        if (typeof usage.inputTokens === "number") contextSize = usage.inputTokens;
      }
      const joined = event.data.message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("");
      if (joined !== "") text = joined;
    }
    if (event.type === "turn/end") {
      turnEndTime = typeof event.time === "number" ? event.time : undefined;
      reason = mapReason(event.data.reason.kind);
      if (event.data.reason.kind === "error") {
        code = event.data.reason.error.code;
        message = event.data.reason.error.message;
      }
    }
  }
  const elapsedMs = turnStartTime !== undefined && turnEndTime !== undefined && turnEndTime >= turnStartTime
    ? turnEndTime - turnStartTime
    : undefined;
  return {
    reason,
    text,
    ...(code === undefined ? {} : { code }),
    ...(message === undefined ? {} : { message }),
    ...(model === undefined ? {} : { model }),
    ...(inputTokens > 0 ? { inputTokens } : {}),
    ...(outputTokens > 0 ? { outputTokens } : {}),
    ...(cacheReadTokens > 0 ? { cacheReadTokens } : {}),
    ...(contextSize === undefined ? {} : { contextSize }),
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(steps > 0 ? { steps } : {}),
    ...(elapsedMs === undefined ? {} : { elapsedMs }),
  };
}

function truncate(text: string, max = 500): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/** Error category used to pick actionable advice for the user. */
export type ErrorCategory = "permission" | "network" | "model" | "generic";

/** Classify an error message into an advice bucket (keyword-based, best-effort). */
export function classifyError(detail: string): ErrorCategory {
  const d = detail.toLowerCase();
  if (/(permission|forbidden|denied|not have access|no access|unauthorized|403|sandbox|acl |isn't permitted|not permitted|access denied)/.test(d)) return "permission";
  if (/(timeout|econnrefused|econnreset|enotfound|enetunreach|etimedout|socket|network|proxy|tls|certificate|fetch failed|connect |unreachable|dns)/.test(d)) return "network";
  if (/(model|quota|rate ?limit|429|insufficient|balance|token(s)? (limit|length)|max_tokens|context length|credit)/.test(d)) return "model";
  return "generic";
}

/** Thousands-separated token count for display. */
function fmtTokens(n: number): string {
  return n.toLocaleString("en-US");
}

function textOf(message: { content: readonly { type?: string; text?: string }[] } | undefined): string {
  if (message === undefined) return "";
  return message.content
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text ?? "")
    .join("");
}

interface ReminderView {
  id: string;
  kind: string;
  prompt: string;
  scheduledAt: string;
  everySeconds?: number;
}

/** Lightweight fold of `schedule/change` events (create / delete / dispatch). */
function foldReminders(events: readonly SessionEvent[]): ReminderView[] {
  const active = new Map<string, ReminderView>();
  for (const e of events) {
    // `schedule/change` is a plugin-extended event type outside dsh-session's map.
    const evt = e as unknown as { type: string; data: unknown };
    if (evt.type !== "schedule/change") continue;
    const d = evt.data as {
      version?: number;
      operation?: string;
      id?: string;
      schedule?: { id: string; kind: string; prompt: string; scheduledAt: string; everySeconds?: number };
      acceptedAt?: string;
    };
    if (d.version !== 1) continue;
    if (d.operation === "create" && d.schedule !== undefined) {
      active.set(d.schedule.id, {
        id: d.schedule.id,
        kind: d.schedule.kind,
        prompt: d.schedule.prompt,
        scheduledAt: d.schedule.scheduledAt,
        everySeconds: d.schedule.everySeconds,
      });
    } else if (d.operation === "delete" && d.id !== undefined) {
      active.delete(d.id);
    } else if (d.operation === "dispatch" && d.id !== undefined) {
      const rec = active.get(d.id);
      if (rec === undefined) continue;
      if (rec.kind === "every" && rec.everySeconds !== undefined && d.acceptedAt !== undefined) {
        const next = Date.parse(d.acceptedAt) + rec.everySeconds * 1000;
        active.set(d.id, { ...rec, scheduledAt: new Date(next).toISOString() });
      } else {
        active.delete(d.id);
      }
    }
  }
  return [...active.values()];
}

/** Sniff an image's media type from its magic bytes (defaults to PNG). */
function detectImageMediaType(buf: Buffer): "image/png" | "image/jpeg" | "image/webp" | "image/gif" {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  if (buf.length >= 6 && buf.toString("ascii", 0, 3) === "GIF") return "image/gif";
  return "image/png";
}

/** Compare two work-directory paths ignoring trailing slashes and case (Windows). */
function sameDir(a: string, b: string): boolean {
  return a.replace(/[\\/]+$/, "").toLowerCase() === b.replace(/[\\/]+$/, "").toLowerCase();
}

type MenuId = "root" | "workspace" | "chat" | "settings" | "model" | "reasoning" | "notify" | "language" | "progress";

interface MenuItem {
  id: string;
  label: string;
  /** Leaf action: after it runs, the menu returns to the root menu on the same card. */
  leaf?: boolean;
  /**
   * `messageId` is the menu card id: pass it to `openMenu` to navigate in place,
   * or close the card. A returned string is sent to the chat as the action's
   * result feedback before the menu returns, so every button press answers
   * visibly instead of leaving the user to guess whether it worked.
   */
  onSelect: (target: OutboundTarget, msg: InboundMessage, messageId: string) => Promise<string | void>;
}

/** How often the proactive progress watchdog re-checks whether a status card is due (ms). */
const PROGRESS_WATCHDOG_CHECK_MS = 15_000;

export class AgentRunner {
  private readonly queue: InboundMessage[] = [];
  private running = false;
  private agent?: Agent;
  private handle?: AgentHandle;
  private turn?: ActiveTurn;
  private workDir: string;
  private language: Language;
  private notifyLevel: NotifyLevel;
  private progressTimeoutMs: number;
  private t: Messages;

  constructor(
    private readonly ctx: Context,
    private readonly config: ResolvedConnectConfig,
    private readonly channel: string,
    private readonly chatKey: string,
    private readonly chatType: "p2p" | "group",
    private readonly adapter: ChannelAdapter,
    private readonly bindings: BindingStore,
    private readonly adapters?: Map<string, ChannelAdapter>,
    /**
     * Route a replayed queued message back into the runner of its own channel
     * (wired by ConnectService). Without it, replayed messages would run in
     * whichever runner happened to release the lock.
     */
    private readonly requeue?: (msg: InboundMessage) => void,
    /** Persistent chat-level reminders (`/remind`), wired by ConnectService. */
    private readonly reminders?: ReminderStore,
  ) {
    this.workDir = config.workDir ?? this.resolveDefaultWorkDir();
    // A per-chat language override (set via the settings menu) wins over config.
    const stored = this.bindings.get(channel, chatKey);
    this.language = stored?.language ?? config.language ?? "zh";
    this.notifyLevel = stored?.notifyLevel ?? config.notifyLevel;
    this.progressTimeoutMs = stored?.progressTimeoutMs ?? config.progressTimeoutMs;
    this.t = messages(this.language);
  }

  private menuTitle(menuId: MenuId): string {
    switch (menuId) {
      case "root":
        return this.t.menuRoot;
      case "workspace":
        return this.t.menuWorkspace;
      case "chat":
        return this.t.menuChat;
      case "settings":
        return this.t.menuSettings;
      case "model":
        return this.t.menuModel;
      case "reasoning":
        return this.t.menuReasoning;
      case "notify":
        return this.t.menuNotify;
      case "language":
        return this.t.menuSettingsLanguage;
      case "progress":
        return this.t.progressMenuTitle;
    }
  }

  private rootMenuSections(): readonly { title: string; ids: readonly string[]; columnsPerRow?: number }[] {
    return [
      { title: this.t.rootSectionWorkspace, ids: ["workspace"], columnsPerRow: 1 },
      { title: this.t.rootSectionChat, ids: ["chat", "history"], columnsPerRow: 1 },
      { title: this.t.rootSectionTask, ids: ["task", "goals", "schedule"], columnsPerRow: 2 },
      { title: this.t.rootSectionSystem, ids: ["status", "plugins", "compact", "settings"], columnsPerRow: 2 },
    ];
  }

  private reasonLabel(reason: TurnReason): string {
    switch (reason) {
      case "completed":
        return this.t.reasonCompleted;
      case "aborted":
        return this.t.reasonAborted;
      case "blocked":
        return this.t.reasonBlocked;
      case "error":
        return this.t.reasonError;
      case "max-tokens":
        return this.t.reasonMaxTokens;
      case "interrupted":
        return this.t.reasonInterrupted;
      default:
        return this.t.reasonUnknown;
    }
  }

  /** Prefer the user's first DSH workspace over the process cwd as default. */
  private resolveDefaultWorkDir(): string {
    const registry = this.ctx.get("workspaceRegistry") as
      | { list?: () => readonly { path: string }[] }
      | undefined;
    const first = registry?.list?.()[0];
    return first?.path ?? process.cwd();
  }

  enqueue(msg: InboundMessage): void {
    const command = parseCommand(msg.text);
    if (command.kind !== "message") {
      // Command handlers touch the adapter directly (no per-call catch) — a
      // transient channel error here must never become an unhandled rejection
      // (Node ≥ 15 crashes the process on those by default).
      void this.handleCommand(command, msg).catch((error) => {
        this.log(`connect: command ${command.kind} failed: ${error instanceof Error ? error.message : String(error)}`);
      });
      return;
    }
    // A task is already running (or queued): tell the user they can append a
    // note to the in-flight task with /ps instead of queueing a brand-new turn
    // behind it. The message still queues as before.
    if (this.running) {
      const hint = this.t.busyHint(truncate(msg.text, 20));
      void this.adapter.sendText(this.target(msg), hint).catch(() => undefined);
    }
    this.queue.push(msg);
    void this.drain();
  }

  /** Route one live session event to the active turn's chunk queue. */
  onSessionEvent(session: Session, event: SessionEvent): void {
    const turn = this.turn;
    if (turn === undefined) return;
    if (this.agent === undefined || session.id !== this.agent.id) return;
    if (event.seq < turn.firstSeq) return;

    // Track context usage while the turn runs so we can nudge the user to
    // compact before the window fills up (deduped to one nudge per turn).
    if (event.type === "request/context") {
      if (typeof event.data.contextWindow === "number") turn.contextWindow = event.data.contextWindow;
      this.maybeNudgeContext(turn);
      return;
    }
    if (event.type === "assistant/message") {
      const usage = (event.data as { usage?: { inputTokens?: number } }).usage;
      if (usage !== undefined && typeof usage.inputTokens === "number") {
        turn.contextSize = usage.inputTokens;
        this.maybeNudgeContext(turn);
      }
    }

    if (event.type === "assistant/chunk") {
      const chunk = event.data.chunk as unknown as StreamChunkLike;
      // First reasoning delta = the milestone the proactive progress notice reports.
      if (chunk.type === "reasoning-delta" && turn.milestone === undefined) {
        turn.milestone = this.t.progressThinking;
      }
      applyStreamChunk(turn, this.t.thinkingHint, chunk, this.notifyLevel);
      return;
    }
    if (event.type === "tool/call") {
      const name = event.data.name as string | undefined;
      if (typeof name !== "string" || name === "") return;
      const summary = toolCallSummary(event.data.arguments);
      turn.toolCount += 1;
      // The proactive progress notice reports the latest milestone even when
      // `result` mode hides the streaming details.
      if (name === "ask_user_question") {
        const question = questionTextOf(event.data.arguments);
        turn.milestone = this.t.questionToolCall(question);
      } else {
        turn.milestone = this.t.toolCalling(name, undefined);
      }
      // `result` mode shows nothing until the final answer; `important` shows
      // the tool name with a step counter, `full` also carries the summary.
      if (this.notifyLevel === "result") return;
      const base = name === "ask_user_question"
        ? this.t.questionToolCall(questionTextOf(event.data.arguments))
        : this.t.toolStepLabel(turn.toolCount, name);
      const label = name === "ask_user_question" || this.notifyLevel !== "full" || summary === undefined
        ? base
        : `${base} — ${summary}`;
      applyToolCall(turn, label);
    }
  }

  /**
   * Proactive context-high nudge: when the turn's observed context usage
   * crosses the compaction threshold, ask the user (once per turn) whether to
   * compact now, instead of waiting until the turn ends to report it.
   */
  private maybeNudgeContext(turn: ActiveTurn): void {
    if (turn.contextNudged) return;
    const size = turn.contextSize;
    const window = turn.contextWindow;
    if (size === undefined || window === undefined || window <= 0) return;
    const pct = Math.round((size / window) * 100);
    if (pct < AgentRunner.COMPACT_THRESHOLD_PCT) return;
    turn.contextNudged = true;
    void (async () => {
      const target: OutboundTarget = { chatKey: this.chatKey, chatType: this.chatType };
      const nudge = this.t.contextHighPrompt(pct);
      try {
        if (await this.confirmAction(target, nudge)) {
          if (this.agent?.status === "running" || this.running) {
            // Compaction needs an idle agent; run it right after this turn ends.
            turn.compactAfterTurn = true;
            await this.adapter.sendText(target, this.t.compactQueued);
          } else {
            await this.compact(target);
          }
        } else {
          await this.adapter.sendText(target, this.t.actionCancelled);
        }
      } catch (error) {
        this.log(`connect: context nudge failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    })();
  }

  private target(msg: InboundMessage): OutboundTarget {
    return {
      chatKey: this.chatKey,
      chatType: this.chatType,
      ...(msg.replyRef === undefined ? {} : { replyRef: msg.replyRef }),
    };
  }

  /** Completion-card target: in groups, @ the requester so they notice the result. */
  private taskTarget(msg: InboundMessage): OutboundTarget {
    return this.chatType === "group"
      ? { ...this.target(msg), atUsers: [msg.senderKey] }
      : this.target(msg);
  }

  /** Send the one-time welcome card on a chat's first message (persisted marker). */
  private async maybeSendWelcome(msg: InboundMessage): Promise<void> {
    const binding = this.bindings.get(this.channel, this.chatKey);
    if (binding !== undefined && binding.welcomedAt !== undefined) return;
    const base = binding ?? {
      channel: this.channel,
      chatKey: this.chatKey,
      chatType: this.chatType,
      sessionId: "",
      ownerKey: msg.senderKey,
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      sessions: [],
    };
    this.bindings.put({ ...base, welcomedAt: Date.now(), lastActiveAt: Date.now() });
    await this.adapter
      .sendCard(this.target(msg), { markdown: `${this.t.welcomeTitle}\n\n${this.t.welcomeBody(this.workDir)}` })
      .catch(() => undefined);
  }

  /** Pick the localized advice text for a failed turn. */
  private errorAdvice(detail: string): string {
    switch (classifyError(detail)) {
      case "permission":
        return this.t.errorAdvicePermission;
      case "network":
        return this.t.errorAdviceNetwork;
      case "model":
        return this.t.errorAdviceModel;
      default:
        return this.t.errorAdviceGeneric;
    }
  }

  /** Present a destructive-action confirmation; true only when the user confirms. */
  private async confirmAction(target: OutboundTarget, promptText: string, messageId?: string): Promise<boolean> {
    const { choice } = await this.adapter.promptChoice(
      target,
      {
        title: this.t.confirmTitle,
        description: promptText,
        options: [
          { id: "confirm:yes", label: this.t.confirmYes },
          { id: "confirm:no", label: this.t.confirmNo },
        ],
      },
      messageId,
    );
    return choice === "confirm:yes";
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length > 0) {
        const msg = this.queue.shift();
        if (msg === undefined) break;
        await this.runTurn(msg);
      }
    } finally {
      this.running = false;
    }
  }

  private async runTurn(msg: InboundMessage): Promise<void> {
    // The mutual-exclusion lock arbitrates between the Feishu side and the Web
    // mirror of the *same* session. Channels without a mirror (Telegram /
    // DingTalk) must not be classified as "web" and must not take part in the
    // lock at all.
    const usesLock = this.channel === "feishu" || this.channel === "web";
    const currentChannel: "feishu" | "web" = this.channel === "feishu" ? "feishu" : "web";

    // Check timeout before attempting to acquire
    if (usesLock) this.checkAndReleaseTimeoutLock();

    if (usesLock && !this.acquireLock(currentChannel)) {
      const binding = this.bindings.get(this.channel, this.chatKey);
      const lockedBy = binding?.lockOwner ?? "unknown";

      // If from Web channel, queue the message instead of rejecting
      if (currentChannel === "web") {
        const position = this.queueMessage(msg);
        await this.adapter
          .sendText(this.target(msg), this.t.messageQueued(position))
          .catch(() => undefined);
      } else {
        // Feishu gets immediate feedback
        await this.adapter
          .sendText(this.target(msg), this.t.sessionLockedBy(lockedBy))
          .catch(() => undefined);
      }
      return;
    }

    try {
      // Acknowledge receipt before the (possibly slow) agent spin-up so the
      // user knows processing started. When more messages are queued, say so.
      const ack = this.t.processingStarted(truncate(msg.text, 60));
      const ackText = this.queue.length > 0 ? `${ack}\n${this.t.queuedHint(this.queue.length)}` : ack;
      await this.adapter
        .sendText(this.target(msg), ackText)
        .catch(() => undefined);

      // First message in this chat: one-time welcome card.
      await this.maybeSendWelcome(msg);

      const agent = await this.ensureAgent(msg);
      const outcome = await this.driveAgent(agent, msg);
      this.touchBinding(msg);

      // Task-end stats: model, tokens, elapsed, and a compaction suggestion.
      await this.sendTurnStats(msg, outcome);

      // Release lock after task completion
      if (usesLock) await this.releaseLock();

      if (outcome.reason !== "completed") {
        await this.sendSummary(msg, outcome);
      }
    } catch (error) {
      // Release lock even on error
      if (usesLock) await this.releaseLock();

      const detail = error instanceof Error ? error.message : String(error);
      await this.adapter
        .sendText(this.target(msg), this.t.processingFailedAdvice(truncate(detail, 400), this.errorAdvice(detail)))
        .catch(() => undefined);
    }
  }

  private async ensureAgent(msg: InboundMessage): Promise<Agent> {
    await (this.ctx.get("loader") as { await?: () => Promise<void> } | undefined)?.await?.();

    const binding = this.bindings.get(this.channel, this.chatKey);
    const live = binding === undefined ? undefined : this.agents.get(SessionId(binding.sessionId));
    if (live !== undefined) {
      this.agent = live;
      // The live agent may have been recreated outside the runner (e.g. by
      // the Web GUI's api-proxy) since we last saw it — make sure we are
      // listening to the current instance so streaming can't silently die.
      this.watchAgent(live);
      return live;
    }

    const selection: ModelSelection = this.defaultSelection();
    const composed = await this.composeSetup(selection);

    if (binding !== undefined) {
      try {
        const handle = await this.agents.resume({
          resumeSessionId: SessionId(binding.sessionId),
          agentOptions: { provider: selection.provider, model: selection.model },
          setup: composed.setup,
        });
        this.handle = handle;
        this.agent = handle.agent;
        this.watchAgent(handle.agent);
        
        // Ensure Web mirror exists for resumed sessions
        this.autoCreateWebMirror(binding.sessionId, msg.senderKey);
        
        // Ensure the session shows up under its workspace in the Web GUI
        void this.attachToWorkspace(binding.sessionId);
        
        return handle.agent;
      } catch (error) {
        (this.ctx.get("logger") as { warn?: (...args: unknown[]) => void } | undefined)?.warn?.(`connect: resume of ${binding.sessionId} failed, creating fresh session: ${String(error)}`);
      }
    }

    const sessionId = SessionId(`connect-${randomUUID()}`);
    const handle = await this.agents.create({
      sessionId,
      meta: {
        cwd: this.workDir,
        ...(composed.agentPreset === undefined ? {} : { agentPreset: composed.agentPreset }),
      },
      agentOptions: { provider: selection.provider, model: selection.model },
      setup: composed.setup,
    });
    this.handle = handle;
    this.agent = handle.agent;
    this.watchAgent(handle.agent);
    this.recordSession(String(sessionId), truncate(msg.text, 40), msg.senderKey);
    
    // Auto-create Web mirror for new sessions (if enabled)
    this.autoCreateWebMirror(String(sessionId), msg.senderKey);
    
    // Ensure the new session shows up under its workspace in the Web GUI
    void this.attachToWorkspace(String(sessionId));
    
    return handle.agent;
  }

  /**
   * Attach a session to the DSH workspace matching its work directory so the
   * Web GUI groups it under the same workspace the Feishu side uses.
   * Best-effort: without a workspace registry this is a no-op.
   */
  private async attachToWorkspace(sessionId: string): Promise<void> {
    const registry = this.ctx.get("workspaceRegistry") as
      | { resolveByPath?: (path: string) => Promise<{ attachSession?(id: string): Promise<void> } | undefined> }
      | undefined;
    if (registry?.resolveByPath === undefined) return;
    try {
      const ws = await registry.resolveByPath(this.workDir);
      await ws?.attachSession?.(sessionId as never);
    } catch (error) {
      this.log(`connect: attachToWorkspace(${sessionId}) skipped: ${String(error)}`);
    }
  }

  /**
   * Historical sessions for the CURRENT work directory: this chat's binding
   * records (filtered by workDir), then any other session the DSH workspace
   * registry attaches to the directory (e.g. Web-created or older-chat
   * sessions). Titles come from the binding record when known, otherwise from
   * the host's session title service. Sorted newest first.
   */
  private async collectWorkdirSessions(): Promise<{ sessionId: string; title: string }[]> {
    const binding = this.bindings.get(this.channel, this.chatKey);
    const byId = new Map<string, string>();
    for (const s of binding?.sessions ?? []) {
      if (sameDir(s.workDir, this.workDir)) byId.set(s.sessionId, s.title);
    }
    for (const sessionId of await this.workspaceSessionIds(this.workDir)) {
      if (byId.has(sessionId)) continue;
      const known = (binding?.sessions ?? []).find((s) => s.sessionId === sessionId);
      const title = known?.title ?? (await this.sessionTitleOf(sessionId)) ?? sessionId;
      byId.set(sessionId, title);
    }
    const lastActive = new Map<string, number>();
    for (const s of binding?.sessions ?? []) lastActive.set(s.sessionId, s.lastActiveAt);
    return [...byId.entries()]
      .map(([sessionId, title]) => ({ sessionId, title }))
      .sort((a, b) => (lastActive.get(b.sessionId) ?? 0) - (lastActive.get(a.sessionId) ?? 0));
  }

  /**
   * Session ids the DSH workspace registry attaches to a work directory.
   * Best-effort: without a workspace registry this returns `[]`.
   */
  private async workspaceSessionIds(workDir: string): Promise<string[]> {
    const registry = this.ctx.get("workspaceRegistry") as
      | {
          resolveByPath?: (path: string) => Promise<{ sessionIds?: readonly unknown[] } | undefined>;
        }
      | undefined;
    if (registry?.resolveByPath === undefined) return [];
    try {
      const ws = await registry.resolveByPath(workDir);
      return (ws?.sessionIds ?? []).map(String);
    } catch {
      return [];
    }
  }

  /** Latest display title of a session via the host query service, or undefined. */
  private async sessionTitleOf(sessionId: string): Promise<string | undefined> {
    const query = this.ctx.get("sessionQuery") as
      | {
          readTitle?: (
            id: string,
            signal?: AbortSignal,
          ) => Promise<string | { title?: unknown } | undefined>;
        }
      | undefined;
    if (query?.readTitle === undefined) return undefined;
    try {
      // `readTitle` returns the folded `SessionTitleSnapshot` object in some
      // host versions and the bare title string in others — accept both.
      const result = await query.readTitle(sessionId);
      if (typeof result === "string") return result;
      if (result !== undefined && typeof result.title === "string") return result.title;
      return undefined;
    } catch {
      return undefined;
    }
  }

  // Service lookups must go through ctx.get(): property access (ctx.agents) is
  // fiber-scoped and rejected from the async Feishu callback with "without inject".
  private get agents(): AgentRegistry {
    return this.ctx.get("agents") as AgentRegistry;
  }

  private get sessions(): SessionStore {
    return this.ctx.get("sessions") as SessionStore;
  }

  private defaultSelection(): ModelSelection {
    const service = this.ctx.get("agentDefaultModel") as { currentSelection?: () => ModelSelection } | undefined;
    return service?.currentSelection?.() ?? { provider: "", model: "" };
  }

  /**
   * Compose the preset-only agent setup.
   *
   * Deliberately does NOT install a static model selection on the agent. The
   * DSH Web GUI switches models through the host api-proxy's session-scoped
   * selection (`selectionFor` + `installModelSelection`), which is installed
   * lazily when a session's model directory is loaded and wins the
   * `agent/request` waterfall. A static selection captured here at create /
   * resume time would take precedence over that and silently pin every request
   * to the default model captured at composition — so a model the user picks
   * in the Web GUI would appear to succeed (the seat and `session.models`
   * report it) while the actual LLM requests keep using the old default.
   * The default model still seeds the agent through `agentOptions` in
   * `ensureAgent`, which `buildRequest` uses as its fallback route.
   */
  private async composeSetup(_selection: ModelSelection): Promise<{
    agentPreset?: string;
    setup: (agentCtx: Context) => void | Promise<void>;
  }> {
    const presets = this.ctx.get("agentPresets") as
      | { resolve(id?: string): Promise<{ id: string }>; mount(agentCtx: Context, id: string): Promise<unknown> }
      | undefined;

    if (presets === undefined) {
      return {
        setup: () => undefined,
      };
    }

    const resolved = await presets.resolve(this.config.agentPreset);
    return {
      agentPreset: resolved.id,
      setup: async (agentCtx) => {
        await presets.mount(agentCtx, resolved.id);
      },
    };
  }

  /** Agents this runner has already attached a `session/event` listener to. */
  private readonly watchedAgents = new WeakSet<Agent>();

  private watchAgent(agent: Agent): void {
    // Scope-filtered: receives only this agent's session events. Deduplicated
    // by object so a re-resumed agent (possibly recreated outside the runner,
    // e.g. by the Web GUI's api-proxy) is re-watched without double-firing on
    // a still-live agent.
    if (this.watchedAgents.has(agent)) return;
    this.watchedAgents.add(agent);
    agent.ctx.on("session/event", (session, event) => {
      this.onSessionEvent(session, event);
    });
  }

  private async driveAgent(agent: Agent, msg: InboundMessage): Promise<TurnOutcome> {
    const firstSeq = agent.session.seq;
    const userMessage = async (): Promise<ReturnType<typeof createUserMessage>> => {
      const content = await this.buildUserContent(msg);
      return createUserMessage({ content, source: { kind: "user" } });
    };

    const chunks = createAsyncQueue<string>();
    const now = Date.now();
    this.turn = {
      firstSeq, chunks, lastText: "",
      reasoning: false, hintPushed: false, lastIndex: undefined, pushedAny: false,
      startedAt: now, lastPushAt: now, toolCount: 0, contextNudged: false, compactAfterTurn: false,
    };

    // Liveness heartbeat: while the agent is working, keep the streaming card
    // visibly alive even through long reasoning or tool-execution stretches
    // (a card that sits on "Thinking…" for minutes looks frozen). Configurable
    // via `streamHeartbeatMs`; 0 disables it.
    const heartbeatMs = this.config.streamHeartbeatMs;
    const heartbeat = heartbeatMs > 0 && this.notifyLevel !== "result"
      ? setInterval(() => {
          const turn = this.turn;
          if (turn === undefined) return;
          const elapsed = Date.now() - turn.lastPushAt;
          if (elapsed < heartbeatMs) return;
          turn.lastPushAt = Date.now();
          const minutes = Math.max(1, Math.round((turn.lastPushAt - turn.startedAt) / 60_000));
          turn.chunks.push(`\n\n${this.t.processingHeartbeat(minutes)}\n\n`);
        }, heartbeatMs)
      : undefined;

    // Proactive progress watchdog: when no standalone card/text has been sent
    // for `progressTimeoutMs` (default 5 min, user-configurable), send a status
    // card reporting the latest milestone so a long turn never looks frozen.
    // Streaming-card heartbeats deliberately do NOT reset this — the user asked
    // for an explicit, separate nudge.
    const progressTimeoutMs = this.progressTimeoutMs;
    let lastStandaloneNoticeAt = now;
    const progressWatchdog = progressTimeoutMs > 0
      ? setInterval(() => {
          const turn = this.turn;
          if (turn === undefined) return;
          const elapsed = Date.now() - lastStandaloneNoticeAt;
          if (elapsed < progressTimeoutMs) return;
          lastStandaloneNoticeAt = Date.now();
          const minutes = Math.max(1, Math.round((Date.now() - turn.startedAt) / 60_000));
          const status = turn.milestone ?? this.t.progressThinking;
          void this.adapter
            .sendText(this.target(msg), this.t.progressReminder(minutes, status))
            .catch(() => undefined);
        }, PROGRESS_WATCHDOG_CHECK_MS)
      : undefined;

    // End the chunk stream unconditionally: if `followup` / `whenIdle` /
    // `flush` throws, the adapter's `for await` over `chunks` must still be
    // released, otherwise the streaming card hangs in "streaming" forever and
    // the chunk queue / adapter promise leak. On the error path we also await
    // (and swallow) the stream promise so its rejection can't escape as an
    // unhandled rejection while the original error propagates.
    const endChunks = (): void => {
      try {
        chunks.end();
      } catch {
        // no-op
      }
    };
    let streamPromise: Promise<void> | undefined;
    try {
      streamPromise = this.adapter.streamText(this.target(msg), chunks);
      agent.followup(await userMessage());
      await agent.whenIdle();
      await this.sessions.flush(agent.session);
    } catch (error) {
      endChunks();
      await streamPromise?.catch(() => undefined);
      throw error;
    } finally {
      if (heartbeat !== undefined) clearInterval(heartbeat);
      if (progressWatchdog !== undefined) clearInterval(progressWatchdog);
    }
    endChunks();
    await streamPromise;

    // The user confirmed a compaction nudge while this turn was still running:
    // the agent is idle now, so compact before summarizing.
    const compactAfterTurn = this.turn.compactAfterTurn;
    if (compactAfterTurn) {
      await this.compact(this.target(msg)).catch((error) => {
        this.log(`connect: deferred compaction failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    }

    const outcome = summarizeTurn(agent.session.events, firstSeq);
    const text = outcome.text !== "" ? outcome.text : this.turn.lastText;
    this.turn = undefined;
    return { ...outcome, text };
  }

  /**
   * Build the user content for one inbound message. When the message carries
   * images, either pass them directly to the main model (if it supports
   * vision) or run a vision sub-task with a capable model and inject its
   * description as text — so a text-only main model never stalls on images.
   */
  private async buildUserContent(msg: InboundMessage): Promise<ContentBlock[]> {
    const content: ContentBlock[] = [{ type: "text", text: msg.text }];
    const rawImages = msg.images;

    // Images: pass directly to the main model when it supports vision,
    // otherwise run a vision sub-task and inject its description as text —
    // a text-only main model never stalls on images.
    if (rawImages !== undefined && rawImages.length > 0) {
      const paths = await this.stageImages(rawImages);
      const locationText = paths.map((p) => `- ${p}`).join("\n");

      const mainVision = await this.modelSupportsVision(this.agent?.options.provider, this.agent?.options.model);
      if (mainVision) {
        const imageBlocks = await this.imageBlocks(paths);
        if (imageBlocks.length > 0) {
          this.log(`connect: main model supports vision — passing ${imageBlocks.length} image block(s) directly`);
          content.push(...imageBlocks);
        } else {
          this.log("connect: main model supports vision but image blocks failed to attach — falling back to paths");
          content.push({ type: "text", text: this.t.imagesStaged(locationText, "") });
        }
      } else {
        const description = await this.describeImages(paths);
        content.push({ type: "text", text: this.t.imagesStaged(locationText, description) });
      }
    } else if (msg.imageError !== undefined) {
      content.push({ type: "text", text: this.t.imageDownloadFailed(msg.imageError) });
    }

    // Non-image attachments (files / audio / video) are staged independently of
    // images: a pure-file message, or a vision-capable main model, must never
    // silently drop them.
    const rawFiles = msg.files;
    if (rawFiles !== undefined && rawFiles.length > 0) {
      const stagedFiles = await this.stageFiles(rawFiles);
      content.push({
        type: "text",
        text: this.t.filesStaged(stagedFiles.length, stagedFiles.map((p) => `- ${p}`).join("\n")),
      });
    }
    if (msg.fileError !== undefined) {
      content.push({ type: "text", text: this.t.fileDownloadFailed(msg.fileError) });
    }
    return content;
  }

  /** Copy images into `<workDir>/.dsh-connect-images` so the agent's tools can reach them. */
  private async stageImages(paths: readonly string[]): Promise<string[]> {
    const dir = join(this.workDir, ".dsh-connect-images");
    try {
      mkdirSync(dir, { recursive: true });
    } catch {
      return [...paths];
    }
    const staged: string[] = [];
    for (const p of paths) {
      const target = join(dir, basename(p));
      try {
        await copyFile(p, target);
        staged.push(target);
      } catch {
        staged.push(p);
      }
    }
    return staged;
  }

  /** Copy non-image attachments into `<workDir>/.dsh-connect-files` so the agent's tools can reach them. */
  private async stageFiles(paths: readonly string[]): Promise<string[]> {
    const dir = join(this.workDir, ".dsh-connect-files");
    try {
      mkdirSync(dir, { recursive: true });
    } catch {
      return [...paths];
    }
    const staged: string[] = [];
    for (const p of paths) {
      const target = join(dir, basename(p));
      try {
        await copyFile(p, target);
        staged.push(target);
      } catch {
        staged.push(p);
      }
    }
    return staged;
  }

  private async imageBlocks(paths: readonly string[]): Promise<ContentBlock[]> {
    const attachments = this.ctx.get("attachments") as
      | { saveImage?: (input: { data: Uint8Array; mediaType: string; name?: string }) => Promise<unknown> }
      | undefined;
    if (attachments?.saveImage === undefined) return [];
    const blocks: ContentBlock[] = [];
    for (const path of paths) {
      try {
        const buf = await readFile(path);
        const mediaType = detectImageMediaType(buf);
        const ref = await attachments.saveImage({ data: new Uint8Array(buf), mediaType });
        blocks.push({ type: "image", attachment: ref } as ContentBlock);
      } catch {
        // Skip unreadable / unsupported images.
      }
    }
    return blocks;
  }

  private async describeImages(paths: readonly string[]): Promise<string> {
    const vision = await this.findVisionModel();
    if (vision === null) {
      this.log("connect: describeImages skipped — no vision model available");
      return "";
    }
    const attachments = this.ctx.get("attachments") as
      | { saveImage?: (input: { data: Uint8Array; mediaType: string }) => Promise<unknown> }
      | undefined;
    const llm = this.ctx.get("llm") as
      | {
          stream?: (options: {
            provider: string;
            model: string;
            messages: unknown[];
            maxTokens?: number;
            signal?: AbortSignal;
          }) => AsyncIterable<{ type: string; text?: string }>;
        }
      | undefined;
    if (attachments?.saveImage === undefined || llm?.stream === undefined) {
      this.log(`connect: describeImages skipped — attachments.saveImage=${attachments?.saveImage !== undefined}, llm.stream=${llm?.stream !== undefined}`);
      return "";
    }

    const refs: unknown[] = [];
    for (const path of paths) {
      try {
        const buf = await readFile(path);
        refs.push(await attachments.saveImage({ data: new Uint8Array(buf), mediaType: detectImageMediaType(buf) }));
      } catch (error) {
        this.log(`connect: saveImage failed for ${path}: ${String(error)}`);
      }
    }
    if (refs.length === 0) {
      this.log("connect: describeImages skipped — no image could be attached");
      return "";
    }

    this.log(`connect: describing ${refs.length} image(s) with ${vision.provider}/${vision.model}`);

    const messages = [
      {
        role: "user",
        content: [
          { type: "text", text: this.t.visionPrompt },
          ...refs.map((ref) => ({ type: "image", attachment: ref })),
        ],
      },
    ];
    try {
      let text = "";
      const stream = llm.stream({ provider: vision.provider, model: vision.model, messages, maxTokens: 2048 });
      for await (const chunk of stream) {
        if (chunk.type === "text-delta" && typeof chunk.text === "string") text += chunk.text;
      }
      this.log(`connect: vision description produced ${text.length} char(s)`);
      return text.trim();
    } catch (error) {
      this.log(`connect: vision description call failed: ${error instanceof Error ? error.message : String(error)}`);
      return "";
    }
  }

  private async modelSupportsVision(provider?: string, model?: string): Promise<boolean> {
    if (provider === undefined || model === undefined) return false;
    const llm = this.ctx.get("llm") as
      | { resolveModelInfo?: (p: string, m: string) => Promise<{ inputModalities?: readonly string[] }> }
      | undefined;
    try {
      const info = await llm?.resolveModelInfo?.(provider, model);
      const supports = info?.inputModalities?.includes("image") ?? false;
      this.log(`connect: main model vision check ${provider}/${model} -> ${supports} (inputModalities=${JSON.stringify(info?.inputModalities)})`);
      return supports;
    } catch (error) {
      this.log(`connect: main model vision check ${provider}/${model} failed: ${String(error)}`);
      return false;
    }
  }

  private async findVisionModel(): Promise<{ provider: string; model: string } | null> {
    if (this.config.visionModel !== undefined) {
      this.log(`connect: vision model configured: ${this.config.visionModel.provider}/${this.config.visionModel.model}`);
      return this.config.visionModel;
    }
    const llm = this.ctx.get("llm") as
      | {
          listProviders?: () => { id: string }[];
          listModels?: (p: string) => Promise<{ id: string }[]>;
          resolveModelInfo?: (p: string, m: string) => Promise<{ inputModalities?: readonly string[] }>;
        }
      | undefined;
    if (llm?.listProviders === undefined || llm.resolveModelInfo === undefined) {
      this.log("connect: vision auto-detection unavailable — llm service lacks listProviders/resolveModelInfo");
      return null;
    }
    const providers = llm.listProviders() ?? [];
    this.log(`connect: vision auto-detection scanning ${providers.length} provider(s): ${providers.map((p) => p.id).join(", ") || "(none)"}`);
    for (const p of providers) {
      let models: { id: string }[] = [];
      try {
        models = (await llm.listModels?.(p.id)) ?? [];
      } catch (error) {
        this.log(`connect: listModels(${p.id}) failed: ${String(error)}`);
        continue;
      }
      this.log(`connect: provider ${p.id} advertises ${models.length} model(s)`);
      for (const m of models) {
        try {
          const info = await llm.resolveModelInfo(p.id, m.id);
          this.log(`connect:   ${p.id}/${m.id} inputModalities=${JSON.stringify(info.inputModalities)}`);
          if (info.inputModalities?.includes("image")) {
            this.log(`connect: vision model selected: ${p.id}/${m.id}`);
            return { provider: p.id, model: m.id };
          }
        } catch (error) {
          this.log(`connect:   resolveModelInfo(${p.id}/${m.id}) failed: ${String(error)}`);
        }
      }
    }
    this.log("connect: no image-capable model found via auto-detection");
    return null;
  }

  private log(message: string): void {
    (this.ctx.get("logger") as { info?: (...args: unknown[]) => void } | undefined)?.info?.(message);
  }

  private readTodos(): TodoItem[] {
    const agent = this.agent;
    if (agent === undefined) return [];
    const events = agent.session.events;
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i];
      if (event.type === "todo/write") return [...event.data.todos];
    }
    return [];
  }

  private touchBinding(msg: InboundMessage): void {    const binding = this.bindings.get(this.channel, this.chatKey);
    if (binding === undefined) return;
    this.bindings.put({ ...binding, ownerKey: msg.senderKey, lastActiveAt: Date.now() });
  }

  private async sendSummary(msg: InboundMessage, outcome: TurnOutcome): Promise<void> {
    const lines = [this.t.taskEnded(this.reasonLabel(outcome.reason))];
    if (outcome.code !== undefined) lines.push(this.t.errorCode(outcome.code));
    if (outcome.message !== undefined) lines.push(this.t.reasonMessage(truncate(outcome.message)));
    if (outcome.text !== "") lines.push(this.t.produced(truncate(outcome.text, 300)));
    const card: SummaryCard = { markdown: lines.join("\n") };
    await this.adapter.sendCard(this.taskTarget(msg), card).catch(() => undefined);
  }

  /** Context-window usage at or above this percentage suggests compaction. */
  private static readonly COMPACT_THRESHOLD_PCT = 75;

  /**
   * Send a compact task-end card: the model used, input/output tokens, elapsed
   * time, and whether compaction is advisable given context-window usage.
   */
  private async sendTurnStats(msg: InboundMessage, outcome: TurnOutcome): Promise<void> {
    if (outcome.model === undefined && outcome.inputTokens === undefined && outcome.outputTokens === undefined) return;
    const lines: string[] = [
      this.t.taskStatsHeader(outcome.elapsedMs === undefined ? "—" : this.t.taskDuration(outcome.elapsedMs)),
    ];
    if (outcome.model !== undefined) lines.push(this.t.taskStatsModel(outcome.model));
    if (outcome.inputTokens !== undefined) {
      lines.push(this.t.taskStatsTokensIn(fmtTokens(outcome.inputTokens), outcome.cacheReadTokens !== undefined ? fmtTokens(outcome.cacheReadTokens) : undefined));
    }
    if (outcome.outputTokens !== undefined) lines.push(this.t.taskStatsTokensOut(fmtTokens(outcome.outputTokens)));
    if (outcome.steps !== undefined) lines.push(this.t.taskStatsSteps(outcome.steps));
    if (outcome.contextSize !== undefined && outcome.contextWindow !== undefined && outcome.contextWindow > 0) {
      const pct = Math.round((outcome.contextSize / outcome.contextWindow) * 100);
      lines.push(this.t.taskStatsContext(`${pct}`, fmtTokens(outcome.contextWindow)));
      lines.push(pct >= AgentRunner.COMPACT_THRESHOLD_PCT ? this.t.taskStatsCompactSuggest : this.t.taskStatsCompactOk);
    }
    const card: SummaryCard = { markdown: lines.join("\n") };
    await this.adapter.sendCard(this.taskTarget(msg), card).catch(() => undefined);
  }

  private async handleCommand(command: Command, msg: InboundMessage): Promise<void> {
    const target = this.target(msg);
    switch (command.kind) {
      case "new": {
        if (!(await this.confirmAction(target, this.t.confirmNewText))) {
          await this.adapter.sendText(target, this.t.actionCancelled);
          break;
        }
        await this.newChat(msg);
        await this.adapter.sendText(target, this.t.newChatDone);
        break;
      }
      case "clear": {
        if (!(await this.confirmAction(target, this.t.confirmClearText))) {
          await this.adapter.sendText(target, this.t.actionCancelled);
          break;
        }
        await this.clearChat(msg);
        await this.adapter.sendText(target, this.t.chatCleared);
        break;
      }
      case "stop": {
        this.agent?.cancel({ kind: "user" });
        await this.adapter.sendText(target, this.t.stopRequested);
        break;
      }
      case "status": {
        await this.showStatus(target);
        break;
      }
      case "task": {
        await this.showTasks(target);
        break;
      }
      case "dir": {
        if (command.path === undefined) {
          await this.openMenu(target, msg, "workspace", ["root"]);
          break;
        }
        const path = command.path;
        if (!isAbsolute(path)) {
          await this.adapter.sendText(target, this.t.dirUsage);
          break;
        }
        try {
          if (!existsSync(path) || !statSync(path).isDirectory()) {
            await this.adapter.sendText(target, this.t.dirNotExists(path));
            break;
          }
        } catch {
          await this.adapter.sendText(target, this.t.dirUnreadable(path));
          break;
        }
        this.workDir = path;
        await this.newChat(msg);
        await this.adapter.sendText(target, this.t.dirSwitched(path));
        break;
      }
      case "chat": {
        await this.openMenu(target, msg, "chat", ["root"]);
        break;
      }
      case "menu": {
        await this.openMenu(target, msg, "root");
        break;
      }
      case "settings": {
        await this.openMenu(target, msg, "settings", ["root"]);
        break;
      }
      case "plugins": {
        await this.showPlugins(target);
        break;
      }
      case "workspace": {
        if (command.path === undefined) {
          await this.adapter.sendText(target, this.t.workspaceUsage);
          break;
        }
        await this.createWorkspace(command.path, target);
        break;
      }
      case "compact": {
        await this.compact(target);
        break;
      }
      case "history": {
        await this.showHistory(target, command.limit ?? 10);
        break;
      }
      case "goals": {
        await this.showGoals(target);
        break;
      }
      case "schedule": {
        await this.showSchedule(target);
        break;
      }
      case "model": {
        await this.openMenu(target, msg, "model", ["root"]);
        break;
      }
      case "notify": {
        await this.openNotifyPicker(target, msg);
        break;
      }
      case "progress": {
        await this.openProgressPicker(target, msg);
        break;
      }
      case "workspaces": {
        await this.showAllWorkspaces(target);
        break;
      }
      case "mirror": {
        await this.handleMirror(target, msg);
        break;
      }
      case "unlock": {
        await this.handleUnlock(target);
        break;
      }
      case "renew": {
        await this.handleRenewLock(target);
        break;
      }
      case "export": {
        await this.handleExport(target, command.format);
        break;
      }
      case "ps": {
        await this.handleAppend(command.text, target, msg);
        break;
      }
      case "remind": {
        await this.handleRemind(command.text, target, msg);
        break;
      }
      case "send": {
        await this.handleSend(command.path, target);
        break;
      }
      case "broadcast": {
        await this.handleBroadcast(command.text, target, msg);
        break;
      }
      case "help": {
        await this.adapter.sendText(target, helpText(this.t));
        break;
      }
      default:
        break;
    }
  }

  private async disposeAgent(): Promise<void> {
    const agent = this.agent;
    const handle = this.handle;
    this.agent = undefined;
    this.handle = undefined;
    this.turn = undefined;
    if (agent !== undefined) {
      agent.cancel({ kind: "disposed" });
      await agent.whenIdle().catch(() => undefined);
    }
    await handle?.dispose().catch(() => undefined);
  }

  /**
   * `/ps <note>` — append a note to the running task. Uses the agent's `steer`
   * inbox: a running driver consumes the note at its next step boundary (so it
   * steers the in-flight task), and an idle driver starts a new turn with it.
   */
  private async handleAppend(text: string, target: OutboundTarget, msg: InboundMessage): Promise<void> {
    if (text === "") {
      await this.adapter.sendText(target, this.t.psUsage);
      return;
    }
    const agent = this.agent;
    if (agent === undefined) {
      await this.adapter.sendText(target, this.t.psNoActiveSession);
      return;
    }
    const note = this.t.psAppendLabel(text);
    const content = await this.buildUserContent({ ...msg, text: note });
    agent.steer(createUserMessage({ content, source: { kind: "user" } }));
    this.touchBinding(msg);
    await this.adapter.sendText(target, this.t.psReceived(text));
  }

  /**
   * `/remind <time> <text>` — persist a chat-level reminder that fires
   * without waking the agent (see src/scheduler.ts).
   */
  private async handleRemind(argText: string, target: OutboundTarget, msg: InboundMessage): Promise<void> {
    if (this.reminders === undefined) {
      await this.adapter.sendText(target, this.t.reminderNoText);
      return;
    }
    const arg = argText.trim();
    if (arg === "") {
      await this.adapter.sendText(target, this.t.reminderNoText);
      return;
    }
    const space = arg.indexOf(" ");
    const time = space === -1 ? arg : arg.slice(0, space);
    const body = space === -1 ? "" : arg.slice(space + 1).trim();
    const dueAt = parseRemindTime(time);
    if (dueAt === undefined) {
      await this.adapter.sendText(target, this.t.reminderParseFailed(time));
      return;
    }
    if (body === "") {
      await this.adapter.sendText(target, this.t.reminderNoText);
      return;
    }
    this.reminders.add({
      channel: this.channel,
      chatKey: this.chatKey,
      chatType: this.chatType,
      text: body,
      dueAt,
      ownerKey: msg.senderKey,
    });
    await this.adapter.sendText(target, this.t.reminderSet(formatRemindAt(dueAt, this.language), body));
  }

  /**
   * `/send <path>` — deliver a file from the workspace through the channel's
   * `sendFile` capability; falls back to sending the path as text.
   */
  private async handleSend(pathArg: string, target: OutboundTarget): Promise<void> {
    if (pathArg === "") {
      await this.adapter.sendText(target, this.t.sendUsage);
      return;
    }
    const path = isAbsolute(pathArg) ? pathArg : join(this.workDir, pathArg);
    let size: number;
    try {
      if (!existsSync(path)) {
        await this.adapter.sendText(target, this.t.sendNotFound(path));
        return;
      }
      const stat = statSync(path);
      if (stat.isDirectory()) {
        await this.adapter.sendText(target, this.t.sendIsDir(path));
        return;
      }
      size = stat.size;
    } catch {
      await this.adapter.sendText(target, this.t.sendNotFound(path));
      return;
    }
    if (size > 20 * 1024 * 1024) {
      await this.adapter.sendText(target, this.t.sendTooLarge(path));
      return;
    }
    if (this.adapter.sendFile === undefined) {
      await this.adapter.sendText(target, `${this.t.sendUnsupported}\n${path}`);
      return;
    }
    try {
      await this.adapter.sendFile(target, path);
      await this.adapter.sendText(target, this.t.sendSent(path));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await this.adapter.sendText(target, this.t.sendFailed(truncate(detail)));
    }
  }

  /**
   * `/broadcast <text>` — admins push a message to every bound chat.
   * Admin gating lives in the connect service (allowUsers).
   */
  private async handleBroadcast(text: string, target: OutboundTarget, msg: InboundMessage): Promise<void> {
    const service = this.ctx.get("connect") as
      | { broadcast?(senderKey: string, markdown: string): Promise<{ ok: boolean; reason?: "disabled" | "not-admin"; count?: number }> }
      | undefined;
    if (service?.broadcast === undefined) {
      await this.adapter.sendText(target, this.t.broadcastUnsupported);
      return;
    }
    const result = await service.broadcast(msg.senderKey, text);
    if (!result.ok) {
      await this.adapter.sendText(target, result.reason === "disabled" ? this.t.broadcastDisabled : this.t.broadcastNotAdmin);
      return;
    }
    await this.adapter.sendText(target, this.t.broadcastSent(result.count ?? 0));
  }

  private recordSession(sessionId: string, title: string, ownerKey: string): void {
    const binding = this.bindings.get(this.channel, this.chatKey);
    const others = (binding?.sessions ?? []).filter((s) => s.sessionId !== sessionId);
    const sessions: ChatSessionRecord[] = [
      { sessionId, title, createdAt: Date.now(), lastActiveAt: Date.now(), workDir: this.workDir },
      ...others,
    ].slice(0, 50);
    // Spread the existing binding so per-chat settings (language, notify
    // level, progress interval, welcomedAt…) survive the first session record.
    this.bindings.put({
      ...(binding ?? { channel: this.channel, chatKey: this.chatKey, chatType: this.chatType }),
      sessionId,
      ownerKey,
      createdAt: binding?.createdAt ?? Date.now(),
      lastActiveAt: Date.now(),
      sessions,
    });
  }

  /**
   * Automatically create a Web mirror for the session.
   * This enables DSH Web GUI to view and interact with the conversation
   * without requiring manual `/mirror` command.
   */
  private autoCreateWebMirror(sessionId: string, ownerKey: string): void {
    // Check if auto-mirror is enabled in config
    if (!this.config.autoMirror) return;
    
    // Only auto-create for Feishu channel (not for Web itself)
    if (this.channel !== "feishu") return;
    
    const binding = this.bindings.get(this.channel, this.chatKey);
    if (binding === undefined) return;
    
    // Check if mirror already exists
    if (binding.webMirrorSessionId !== undefined) {
      return; // Mirror already configured
    }
    
    // Auto-create mirror with default settings
    const defaultTimeoutMs = 5 * 60 * 1000; // 5 minutes
    
    this.bindings.put({
      ...binding,
      webMirrorSessionId: sessionId,
      lockOwner: "feishu", // Feishu owns the lock initially
      lockAcquiredAt: Date.now(),
      lockTimeoutMs: defaultTimeoutMs,
      lastActiveAt: Date.now(),
    });
    
    this.log(`connect: auto-created Web mirror for session ${sessionId}`);
  }

  private async newChat(msg: InboundMessage): Promise<void> {
    await this.disposeAgent();
    const binding = this.bindings.get(this.channel, this.chatKey);
    if (binding !== undefined) {
      // A new chat gets a brand-new session; the previous mirror points at the
      // abandoned session and must be cleared so the next session re-mirrors.
      this.bindings.put({
        ...binding,
        sessionId: "",
        webMirrorSessionId: undefined,
        lockOwner: undefined,
        lockAcquiredAt: undefined,
        queuedMessages: [],
        ownerKey: msg.senderKey,
        lastActiveAt: Date.now(),
      });
    }
  }

  private async clearChat(msg: InboundMessage): Promise<void> {
    const binding = this.bindings.get(this.channel, this.chatKey);
    const current = binding?.sessionId;
    await this.disposeAgent();
    if (binding !== undefined && current !== undefined && current !== "") {
      const sessions = binding.sessions.filter((s) => s.sessionId !== current);
      this.bindings.put({
        ...binding,
        sessionId: "",
        sessions,
        webMirrorSessionId: undefined,
        lockOwner: undefined,
        lockAcquiredAt: undefined,
        queuedMessages: [],
        ownerKey: msg.senderKey,
        lastActiveAt: Date.now(),
      });
    }
  }

  private async switchTo(sessionId: string, ownerKey: string): Promise<void> {
    const binding = this.bindings.get(this.channel, this.chatKey);
    if (binding === undefined) return;
    const sessions = binding.sessions.map((s) => (s.sessionId === sessionId ? { ...s, lastActiveAt: Date.now() } : s));
    // The mirror follows the active session: clear the stale mapping and let
    // `autoCreateWebMirror` re-create it for the newly selected session.
    this.bindings.put({
      ...binding,
      sessionId,
      sessions,
      webMirrorSessionId: undefined,
      lockOwner: undefined,
      lockAcquiredAt: undefined,
      queuedMessages: [],
      ownerKey,
      lastActiveAt: Date.now(),
    });
    await this.disposeAgent();
  }

  private listWorkspaces(): { path: string; title: string }[] {
    const registry = this.ctx.get("workspaceRegistry") as
      | { list?: () => readonly { path: string; title: string }[] }
      | undefined;
    const out: { path: string; title: string }[] = [];
    const seen = new Set<string>();
    const add = (path: string, title: string) => {
      if (path === "") return;
      const key = path.replace(/[\\/]+$/, "").toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ path, title: title || path });
    };
    add(this.workDir, this.t.currentDir);
    for (const w of registry?.list?.() ?? []) add(w.path, w.title);
    for (const p of this.config.workspaces) add(p, p);
    return out;
  }

  private async openMenu(target: OutboundTarget, msg: InboundMessage, menuId: MenuId, stack: MenuId[] = [], cardId?: string): Promise<void> {
    const items = await this.menuItems(menuId);
    const options: ChoiceOption[] = items.map((i) => ({ id: i.id, label: i.label }));
    options.push({ id: "menu:exit", label: this.t.menuExit });
    if (stack.length > 0) options.push({ id: "menu:back", label: this.t.menuBack });
    
    // Determine columns per row based on menu type
    // Workspace and chat lists use 1 column (full width), others use 2 columns
    const columnsPerRow = (menuId === "workspace" || menuId === "chat") ? 1 : 2;
    
    const { choice, messageId } = await this.adapter.promptChoice(
      target,
      {
        title: this.menuTitle(menuId),
        options,
        columnsPerRow,
        ...(menuId === "root" ? { sections: this.rootMenuSections(), footer: this.t.rootMenuFooter } : {}),
      },
      cardId,
    );
    if (choice === undefined) return;
    if (choice === "menu:exit") {
      await this.adapter.closeMenu(messageId, this.t.menuClosed);
      return;
    }
    if (choice === "menu:back") {
      const parent = stack[stack.length - 1];
      await this.openMenu(target, msg, parent, stack.slice(0, -1), messageId);
      return;
    }
    const item = items.find((i) => i.id === choice);
    if (item === undefined) {
      // The tap belonged to a previous card generation (e.g. a rapid second
      // tap on the old menu while the new one was still being redrawn). Don't
      // silently swallow it: redraw the current menu so the chain stays usable.
      await this.openMenu(target, msg, menuId, stack, messageId);
      return;
    }
    const feedback = await item.onSelect(target, msg, messageId);
    if (item.leaf === true) {
      // Every leaf press must answer visibly: send the action's result feedback
      // (if any) before returning to the root menu on the same card.
      if (feedback !== undefined && feedback !== "") {
        await this.adapter.sendText(target, feedback).catch(() => undefined);
      }
      await this.openMenu(target, msg, "root", [], messageId);
    }
  }

  private async menuItems(menuId: MenuId): Promise<MenuItem[]> {
    switch (menuId) {
      case "root":
        return [
          { id: "workspace", label: this.t.menuWorkspaceAction, onSelect: (t, m, cardId) => this.openMenu(t, m, "workspace", ["root"], cardId) },
          { id: "chat", label: this.t.menuChatAction, onSelect: (t, m, cardId) => this.openMenu(t, m, "chat", ["root"], cardId) },
          { id: "status", label: this.t.menuStatusAction, leaf: true, onSelect: async (t) => { await this.showStatus(t); } },
          { id: "task", label: this.t.menuTaskAction, leaf: true, onSelect: async (t) => { await this.showTasks(t); } },
          { id: "history", label: this.t.menuHistoryAction, leaf: true, onSelect: async (t) => { await this.showHistory(t, 10); } },
          { id: "goals", label: this.t.menuGoalsAction, leaf: true, onSelect: async (t) => { await this.showGoals(t); } },
          { id: "schedule", label: this.t.menuScheduleAction, leaf: true, onSelect: async (t) => { await this.showSchedule(t); } },
          { id: "compact", label: this.t.menuCompactAction, leaf: true, onSelect: async (t) => { await this.compact(t); } },
          { id: "plugins", label: this.t.menuPluginsAction, leaf: true, onSelect: async (t) => { await this.showPlugins(t); } },
          { id: "settings", label: this.t.menuSettingsAction, onSelect: (t, m, cardId) => this.openMenu(t, m, "settings", ["root"], cardId) },
        ];
      case "workspace": {
        const workspaces = this.listWorkspaces();
        return workspaces.map((w) => ({
          id: `dir:${w.path}`,
          label: `${w.path === this.workDir ? "● " : ""}${w.title}${w.title !== w.path ? `  (${w.path})` : ""}`,
          leaf: true,
          onSelect: async (t, m) => {
            this.workDir = w.path;
            await this.newChat(m);
            return this.t.dirSwitched(w.path);
          },
        }));
      }
      case "chat": {
        const binding = this.bindings.get(this.channel, this.chatKey);
        const active = binding?.sessionId;
        const hasWebMirror = binding?.webMirrorSessionId !== undefined;

        const items: MenuItem[] = (await this.collectWorkdirSessions()).map(({ sessionId, title }) => {
          const isMirrored = hasWebMirror && binding?.webMirrorSessionId === sessionId;
          const mirrorIndicator = isMirrored ? ` ${this.t.webMirrorIndicator}` : "";
          const activeIndicator = sessionId === active ? "●" : "○";
          return {
            id: `session:${sessionId}`,
            label: `${activeIndicator} ${title || sessionId}${mirrorIndicator}`,
            leaf: true,
            onSelect: async (t, m) => {
              await this.switchTo(sessionId, m.senderKey);
              return this.t.sessionSwitched(title || sessionId);
            },
          };
        });

        if (items.length === 0) {
          items.push({
            id: "none:history",
            label: this.t.noSessionsInWorkdir(this.workDir),
            leaf: true,
            onSelect: async () => this.t.noSessionsInWorkdir(this.workDir),
          });
        }

        items.push({
          id: "action:new",
          label: this.t.menuNewChat,
          leaf: true,
          onSelect: async (t, m, messageId) => {
            // Reuse the menu card for the confirm prompt so no stale card is left behind.
            if (await this.confirmAction(t, this.t.confirmNewText, messageId)) {
              await this.newChat(m);
              return this.t.newChatDone;
            }
            return this.t.actionCancelled;
          },
        });
        return items;
      }
      case "settings":
        return [
          { id: "model", label: this.t.menuSettingsModel, onSelect: (t, m, cardId) => this.openMenu(t, m, "model", ["settings", "root"], cardId) },
          { id: "reasoning", label: this.t.menuSettingsReasoning, onSelect: (t, m, cardId) => this.openMenu(t, m, "reasoning", ["settings", "root"], cardId) },
          { id: "notify", label: this.t.menuSettingsNotify, onSelect: (t, m, cardId) => this.openMenu(t, m, "notify", ["settings", "root"], cardId) },
          { id: "progress", label: this.t.menuSettingsProgress, onSelect: (t, m, cardId) => this.openMenu(t, m, "progress", ["settings", "root"], cardId) },
          { id: "language", label: this.t.menuSettingsLanguage, onSelect: (t, m, cardId) => this.openMenu(t, m, "language", ["settings", "root"], cardId) },
          { id: "overview", label: this.t.menuSettingsOverview, leaf: true, onSelect: async (t) => { await this.showSettings(t); } },
        ];
      case "language":
        return [
          {
            id: "lang:zh",
            label: `${this.language === "zh" ? "● " : ""}${this.t.languageZh}`,
            leaf: true,
            onSelect: async (t, m) => { await this.setLanguage("zh", t, m); },
          },
          {
            id: "lang:en",
            label: `${this.language === "en" ? "● " : ""}${this.t.languageEn}`,
            leaf: true,
            onSelect: async (t, m) => { await this.setLanguage("en", t, m); },
          },
        ];
      case "model":
        return await this.modelMenuItems();
      case "reasoning":
        return this.reasoningMenuItems();
      case "notify":
        return ([
          { id: "full", label: this.t.notifyFull },
          { id: "important", label: this.t.notifyImportant },
          { id: "result", label: this.t.notifyResult },
        ] as const).map((o) => ({
          id: `notify:${o.id}`,
          label: `${this.notifyLevel === o.id ? "● " : ""}${o.label}`,
          leaf: true,
          onSelect: async (t: OutboundTarget, m: InboundMessage) => {
            await this.setNotifyLevel(o.id, t, m);
          },
        }));
      case "progress": {
        const presets: { id: string; label: string; ms: number }[] = [
          { id: "progress:0", label: this.t.progressOff, ms: 0 },
          { id: "progress:120000", label: this.t.progressMinutes(2), ms: 2 * 60_000 },
          { id: "progress:300000", label: this.t.progressMinutes(5), ms: 5 * 60_000 },
          { id: "progress:600000", label: this.t.progressMinutes(10), ms: 10 * 60_000 },
          { id: "progress:900000", label: this.t.progressMinutes(15), ms: 15 * 60_000 },
          { id: "progress:1800000", label: this.t.progressMinutes(30), ms: 30 * 60_000 },
        ];
        return presets.map((o) => ({
          id: o.id,
          label: `${this.progressTimeoutMs === o.ms ? "● " : ""}${o.label}`,
          leaf: true,
          onSelect: async (t: OutboundTarget, m: InboundMessage) => {
            await this.setProgressTimeout(o.ms, t, m);
          },
        }));
      }
    }
  }

  private async showStatus(target: OutboundTarget): Promise<void> {
    const agent = this.agent;
    if (agent === undefined) {
      await this.adapter.sendText(target, this.t.statusNoSession(this.workDir));
      return;
    }

    // Determine detailed execution state
    let statusLabel: string;
    if (agent.status === "running") {
      statusLabel = this.t.statusExecuting;
    } else if (this.queue.length > 0) {
      statusLabel = this.t.statusWaiting;
    } else {
      statusLabel = this.t.statusIdle;
    }

    const model = `${agent.options.provider ?? "-"}/${agent.options.model ?? "-"}`;
    const lines = [
      this.t.statusField(statusLabel),
      this.t.modelField(model),
      this.t.workdirField(this.workDir),
    ];

    // Queue status with detail
    if (this.queue.length === 0) {
      lines.push(`${this.t.queuedField(0)} ${this.t.queueEmpty}`);
    } else {
      lines.push(`${this.t.queuedField(this.queue.length)} ${this.t.queueDetail(this.queue.length)}`);
    }

    // Last turn completion info
    const lastTurn = this.getLastTurnInfo(agent);
    if (lastTurn !== undefined) {
      lines.push(this.t.lastTurnReason(this.reasonLabel(lastTurn.reason)));
      lines.push(this.t.lastTurnTime(lastTurn.completedAt));
    } else {
      lines.push(this.t.noTurnHistory);
    }

    lines.push(this.t.sessionField(agent.id));

    const tokenMeter = this.ctx.get("tokenMeter") as
      | { measure?: (s: unknown) => { totalTokens: number; surfaceTokens: number } }
      | undefined;
    try {
      const m = tokenMeter?.measure?.(agent.session);
      if (m !== undefined) lines.push(this.t.contextField(m.totalTokens, m.surfaceTokens));
    } catch {
      // Token meter unavailable: skip.
    }
    await this.adapter.sendText(target, lines.join("\n"));
  }

  /** Extract the most recent turn's completion info from session events. */
  private getLastTurnInfo(agent: Agent): { reason: TurnReason; completedAt: string } | undefined {
    const events = agent.session.events;
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i];
      if (event.type === "turn/end") {
        const reason = mapReason(event.data.reason.kind);
        // Use the event's timestamp if available, otherwise approximate
        const completedAt = new Date().toLocaleTimeString(this.language === "en" ? "en-US" : "zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
        return { reason, completedAt };
      }
    }
    return undefined;
  }

  private async showTasks(target: OutboundTarget): Promise<void> {
    const todos = this.readTodos();
    if (todos.length === 0) {
      await this.adapter.sendText(target, this.t.noTodos);
      return;
    }
    const lines = todos.map((todo) => {
      const mark = todo.status === "completed" ? "✅" : todo.status === "in_progress" ? "🔄" : "⬜";
      return `${mark} ${todo.content}`;
    });
    await this.adapter.sendText(target, this.t.currentTodos(todos.length, lines.join("\n")));
  }

  private async showSettings(target: OutboundTarget): Promise<void> {
    const binding = this.bindings.get(this.channel, this.chatKey);
    const agent = this.agent;
    const model = agent ? `${agent.options.provider ?? "-"}/${agent.options.model ?? "-"}` : "-";
    const sel = this.defaultSelection();
    const lines = [
      this.t.settingsHeader,
      this.t.modelSetting(model),
      this.t.reasoningSetting(sel.reasoningEffort ?? this.t.effortDefault),
      this.t.agentPresetSetting(this.config.agentPreset ?? this.t.defaultLabel),
      this.t.workdirSetting(this.workDir),
      this.t.workspacesSetting + (this.config.workspaces.length === 0 ? this.t.notConfigured : ""),
    ];
    for (const w of this.config.workspaces) lines.push(`  - ${w}`);
    lines.push(this.t.chatCountField(binding?.sessions.length ?? 0));
    lines.push(this.t.progressSetting(this.progressTimeoutMs === 0 ? this.t.progressOff : this.t.progressMinutes(Math.round(this.progressTimeoutMs / 60_000))));
    lines.push(this.t.allowUsersField(this.config.allowUsers.length, this.config.allowUsers.length === 0));
    lines.push(this.t.allowChatsField(this.config.allowChats.length, this.config.allowChats.length === 0));
    lines.push(this.t.stateDirField(this.config.stateDir ?? ".dsh-connect"));
    await this.adapter.sendText(target, lines.join("\n"));
  }

  private async modelMenuItems(): Promise<MenuItem[]> {
    const choices = await this.listModelChoices();
    const current = this.defaultSelection();
    const items: MenuItem[] = choices.map((c) => ({
      id: `model:${c.provider}:${c.model}`,
      label: `${c.provider === current.provider && c.model === current.model ? "● " : ""}${c.name}`,
      leaf: true,
      onSelect: async (t, m) => {
        await this.setModel(c.provider, c.model, m);
        return this.t.modelSet(c.name);
      },
    }));
    if (items.length === 0) {
      items.push({ id: "model:none", label: this.t.noModelsFound, leaf: true, onSelect: async () => this.t.noModelsFound });
    }
    return items;
  }

  private async listModelChoices(): Promise<{ provider: string; model: string; name: string }[]> {
    const llm = this.ctx.get("llm") as
      | {
          listProviders?: () => { id: string; name: string }[];
          listModels?: (provider: string) => Promise<{ id: string; name: string }[]>;
        }
      | undefined;
    const providers = llm?.listProviders?.() ?? [];
    const out: { provider: string; model: string; name: string }[] = [];
    for (const p of providers) {
      let models: { id: string; name: string }[] = [];
      try {
        models = (await llm?.listModels?.(p.id)) ?? [];
      } catch {
        // Skip providers whose catalog cannot be listed.
      }
      for (const m of models) {
        out.push({ provider: p.id, model: m.id, name: this.t.modelName(m.name || m.id, p.name || p.id) });
      }
    }
    return out;
  }

  private async setModel(provider: string, model: string, msg: InboundMessage): Promise<void> {
    const svc = this.ctx.get("agentDefaultModel") as
      | { saveSelection?: (s: ModelSelection) => Promise<void> }
      | undefined;
    const cur = this.defaultSelection();
    await svc?.saveSelection?.({
      provider,
      model,
      ...(cur.reasoningEffort === undefined ? {} : { reasoningEffort: cur.reasoningEffort }),
    });
    await this.newChat(msg);
  }

  private reasoningMenuItems(): MenuItem[] {
    const current = this.defaultSelection();
    const efforts = [
      { id: "low", name: this.t.effortLow },
      { id: "medium", name: this.t.effortMedium },
      { id: "high", name: this.t.effortHigh },
    ];
    const items: MenuItem[] = [
      {
        id: "effort:default",
        label: `${current.reasoningEffort === undefined ? "● " : ""}${this.t.effortDefault}`,
        leaf: true,
        onSelect: async (t, m) => {
          await this.setReasoning(undefined, m);
          return this.t.reasoningSet(this.t.effortDefault);
        },
      },
    ];
    for (const e of efforts) {
      items.push({
        id: `effort:${e.id}`,
        label: `${e.id === current.reasoningEffort ? "● " : ""}${e.name}`,
        leaf: true,
        onSelect: async (t, m) => {
          await this.setReasoning(e.id, m);
          return this.t.reasoningSet(e.name);
        },
      });
    }
    return items;
  }

  private async setReasoning(effort: string | undefined, msg: InboundMessage): Promise<void> {
    const svc = this.ctx.get("agentDefaultModel") as
      | { saveSelection?: (s: ModelSelection) => Promise<void> }
      | undefined;
    const cur = this.defaultSelection();
    await svc?.saveSelection?.({
      provider: cur.provider,
      model: cur.model,
      ...(effort === undefined ? {} : { reasoningEffort: ReasoningEffortId(effort) }),
    });
    await this.newChat(msg);
  }

  /** Switch the user-facing language for this chat, persisted in its binding. */
  private async setLanguage(lang: Language, target: OutboundTarget, msg: InboundMessage): Promise<void> {
    const changed = lang !== this.language;
    if (changed) {
      this.language = lang;
      this.t = messages(lang);
    }
    // Persist into the chat's binding (create one if the chat has no session yet).
    // Persisting again for the already-active language is harmless and keeps the
    // button press answer visible either way.
    const binding = this.bindings.get(this.channel, this.chatKey);
    if (binding !== undefined) {
      this.bindings.put({ ...binding, language: lang, lastActiveAt: Date.now() });
    } else {
      this.bindings.put({
        channel: this.channel,
        chatKey: this.chatKey,
        chatType: this.chatType,
        sessionId: "",
        ownerKey: msg.senderKey,
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        language: lang,
        sessions: [],
      });
    }
    const label = lang === "zh" ? this.t.languageZh : this.t.languageEn;
    await this.adapter.sendText(target, changed ? this.t.languageSet(label) : this.t.languageAlready(label));
  }

  /**
   * Switch the notification level for this chat (persisted in its binding and
   * effective immediately for the next streaming reply).
   */
  private async setNotifyLevel(level: NotifyLevel, target: OutboundTarget, msg: InboundMessage): Promise<void> {
    this.notifyLevel = level;
    const binding = this.bindings.get(this.channel, this.chatKey);
    if (binding !== undefined) {
      this.bindings.put({ ...binding, notifyLevel: level, lastActiveAt: Date.now() });
    } else {
      this.bindings.put({
        channel: this.channel,
        chatKey: this.chatKey,
        chatType: this.chatType,
        sessionId: "",
        ownerKey: msg.senderKey,
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        notifyLevel: level,
        sessions: [],
      });
    }
    const label = level === "full" ? this.t.notifyFull : level === "important" ? this.t.notifyImportant : this.t.notifyResult;
    const desc = level === "full" ? this.t.notifyFullDesc : level === "important" ? this.t.notifyImportantDesc : this.t.notifyResultDesc;
    await this.adapter.sendText(target, this.t.notifySet(label, desc));
  }

  /** Show the three-level notification picker (used by the `/notify` command). */
  private async openNotifyPicker(target: OutboundTarget, msg: InboundMessage): Promise<void> {
    const options: ChoiceOption[] = [
      { id: "notify:full", label: this.t.notifyFull },
      { id: "notify:important", label: this.t.notifyImportant },
      { id: "notify:result", label: this.t.notifyResult },
    ];
    const { choice } = await this.adapter.promptChoice(target, { title: this.t.menuNotify, options });
    if (choice === undefined) return;
    const level = choice.startsWith("notify:") ? (choice.slice("notify:".length) as NotifyLevel) : undefined;
    if (level !== "full" && level !== "important" && level !== "result") return;
    await this.setNotifyLevel(level, target, msg);
  }

  /**
   * Switch the proactive progress-notice interval for this chat (persisted in
   * its binding and effective for the next turn; 0 disables the watchdog).
   */
  private async setProgressTimeout(ms: number, target: OutboundTarget, msg: InboundMessage): Promise<void> {
    this.progressTimeoutMs = ms;
    const binding = this.bindings.get(this.channel, this.chatKey);
    if (binding !== undefined) {
      this.bindings.put({ ...binding, progressTimeoutMs: ms, lastActiveAt: Date.now() });
    } else {
      this.bindings.put({
        channel: this.channel,
        chatKey: this.chatKey,
        chatType: this.chatType,
        sessionId: "",
        ownerKey: msg.senderKey,
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        progressTimeoutMs: ms,
        sessions: [],
      });
    }
    const label = ms === 0 ? this.t.progressOff : this.t.progressMinutes(Math.round(ms / 60_000));
    await this.adapter.sendText(target, this.t.progressSet(label));
  }

  /** Show the progress-interval picker (used by the `/progress` command). */
  private async openProgressPicker(target: OutboundTarget, msg: InboundMessage): Promise<void> {
    const options: ChoiceOption[] = [
      { id: "progress:0", label: this.t.progressOff },
      { id: "progress:120000", label: this.t.progressMinutes(2) },
      { id: "progress:300000", label: this.t.progressMinutes(5) },
      { id: "progress:600000", label: this.t.progressMinutes(10) },
      { id: "progress:900000", label: this.t.progressMinutes(15) },
      { id: "progress:1800000", label: this.t.progressMinutes(30) },
    ];
    const { choice } = await this.adapter.promptChoice(target, { title: this.t.progressMenuTitle, options });
    if (choice === undefined || !choice.startsWith("progress:")) return;
    const ms = Number(choice.slice("progress:".length));
    if (!Number.isInteger(ms) || ms < 0) return;
    await this.setProgressTimeout(ms, target, msg);
  }

  private async showPlugins(target: OutboundTarget): Promise<void> {
    const loader = this.ctx.get("loader") as
      | { entries?: () => Iterable<{ id: string; options: { name?: string }; disabled: boolean }> }
      | undefined;
    const all = [...(loader?.entries?.() ?? [])];
    if (all.length === 0) {
      await this.adapter.sendText(target, this.t.noPlugins);
      return;
    }
    const shown = all.slice(0, 50);
    const lines = shown.map((e) => {
      const status = e.disabled ? this.t.pluginDisabled : this.t.pluginEnabled;
      return `${status}  ${e.id}${e.options.name ? `  (${e.options.name})` : ""}`;
    });
    if (all.length > shown.length) lines.push(this.t.pluginsTruncated(all.length, shown.length));
    await this.adapter.sendText(target, this.t.pluginsCount(all.length) + lines.join("\n"));
  }

  private async createWorkspace(path: string, target: OutboundTarget): Promise<void> {
    if (!isAbsolute(path)) {
      await this.adapter.sendText(target, this.t.workspaceUsage);
      return;
    }
    try {
      if (!existsSync(path) || !statSync(path).isDirectory()) {
        await this.adapter.sendText(target, this.t.dirNotExistsHint(path));
        return;
      }
    } catch {
      await this.adapter.sendText(target, this.t.dirUnreadable(path));
      return;
    }
    const registry = this.ctx.get("workspaceRegistry") as
      | { create?: (path: string, title?: string) => Promise<{ title: string; path: string }> }
      | undefined;
    if (registry?.create === undefined) {
      await this.adapter.sendText(target, this.t.workspaceServiceUnavailable);
      return;
    }
    try {
      const ws = await registry.create(path);
      await this.adapter.sendText(target, this.t.workspaceCreated(ws.title, ws.path));
    } catch (error) {
      await this.adapter.sendText(target, this.t.createFailed(error instanceof Error ? error.message : String(error)));
    }
  }

  private async compact(target: OutboundTarget): Promise<void> {
    const agent = this.agent;
    if (agent === undefined) {
      await this.adapter.sendText(target, this.t.noActiveSessionCompact);
      return;
    }
    if (agent.status !== "idle") {
      await this.adapter.sendText(target, this.t.sessionRunning);
      return;
    }
    const presets = this.ctx.get("agentPresets") as
      | {
          serviceFor?: (
            agent: { ctx: unknown },
            name: string,
          ) => { compactNow?: (a: unknown, signal: AbortSignal) => Promise<unknown> } | undefined;
        }
      | undefined;
    const compaction = presets?.serviceFor?.(agent, "compaction");
    if (compaction?.compactNow === undefined) {
      await this.adapter.sendText(target, this.t.compactionUnavailable);
      return;
    }
    try {
      // Compaction can take a while — tell the user it started, then report the outcome.
      await this.adapter.sendText(target, this.t.compactStarted);
      const result = await compaction.compactNow(agent, new AbortController().signal);
      if (result === null) {
        await this.adapter.sendText(target, this.t.nothingToCompact);
      } else {
        await this.adapter.sendText(target, this.t.compactDone);
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      await this.adapter.sendText(target, this.t.compactFailed(truncate(msg)));
    }
  }

  private async showHistory(target: OutboundTarget, limit: number): Promise<void> {
    const agent = this.agent;
    if (agent === undefined) {
      // No live agent: there may still be historical sessions for the current
      // work directory. List them instead of a bare "no active session".
      const sessions = await this.collectWorkdirSessions();
      if (sessions.length === 0) {
        await this.adapter.sendText(target, this.t.noSessionsInWorkdir(this.workDir));
        return;
      }
      const lines = sessions.slice(0, limit).map((s, i) => `${i + 1}. ${s.title || s.sessionId}`);
      await this.adapter.sendText(target, this.t.historySessions(sessions.length, lines.join("\n")));
      return;
    }
    const events = agent.session.events;
    const rows: string[] = [];
    for (let i = events.length - 1; i >= 0 && rows.length < limit; i--) {
      const e = events[i];
      if (e.type === "user/message") {
        const text = textOf(e.data);
        if (text !== "") rows.push(`👤 ${truncate(text, 100)}`);
      } else if (e.type === "assistant/message") {
        const text = textOf(e.data.message);
        if (text !== "") rows.push(`🤖 ${truncate(text, 100)}`);
      }
    }
    if (rows.length === 0) {
      await this.adapter.sendText(target, this.t.noMessagesYet);
      return;
    }
    await this.adapter.sendText(target, this.t.recentMessages(rows.length, rows.reverse().join("\n\n")));
  }

  private async showGoals(target: OutboundTarget): Promise<void> {
    const agent = this.agent;
    if (agent === undefined) {
      await this.adapter.sendText(target, this.t.noActiveSession);
      return;
    }
    const goals = this.ctx.get("goals") as
      | {
          get?: (a: unknown) => {
            objective: string;
            phase: string;
            maxGoalRounds: number;
            roundsStarted: number;
            activation: string;
            blockedReason?: { code: string; message: string };
          } | undefined;
        }
      | undefined;
    const view = goals?.get?.(agent);
    if (view === undefined) {
      await this.adapter.sendText(target, this.t.noActiveGoals);
      return;
    }
    const lines = [
      this.t.goalObjective(view.objective),
      this.t.goalStatus(this.goalPhaseLabel(view.phase)),
      this.t.goalRounds(view.roundsStarted, view.maxGoalRounds),
      this.t.goalAutoRun(view.activation === "armed"),
    ];
    if (view.blockedReason !== undefined) lines.push(this.t.goalBlockedReason(view.blockedReason.message));
    await this.adapter.sendText(target, lines.join("\n"));
  }

  private goalPhaseLabel(phase: string): string {
    switch (phase) {
      case "active":
        return this.t.goalPhaseActive;
      case "paused":
        return this.t.goalPhasePaused;
      case "blocked":
        return this.t.goalPhaseBlocked;
      case "complete":
        return this.t.goalPhaseComplete;
      default:
        return phase;
    }
  }

  private async showSchedule(target: OutboundTarget): Promise<void> {
    // Agent-level reminders (session `schedule` tool) + persistent chat-level
    // reminders (`/remind`), merged into one list.
    const agentReminders = this.agent === undefined ? [] : foldReminders(this.agent.session.events);
    const persisted = this.reminders?.listFor(this.channel, this.chatKey) ?? [];
    const now = Date.now();
    const locale = this.language === "en" ? "en-US" : "zh-CN";
    const agentLines = agentReminders.map((r) => {
      const due = Date.parse(r.scheduledAt) <= now;
      const state = due ? this.t.reminderDue : this.t.reminderClock;
      const kind = r.kind === "every" ? this.t.reminderEvery(Math.round((r.everySeconds ?? 0) / 60)) : this.t.reminderOnce;
      const when = new Date(Date.parse(r.scheduledAt)).toLocaleString(locale);
      return this.t.reminderLine(state, r.id, r.prompt, kind, when);
    });
    const persistedLines = persisted.map((r) => {
      const due = r.dueAt <= now;
      const state = due ? this.t.reminderDue : this.t.reminderClock;
      const when = new Date(r.dueAt).toLocaleString(locale);
      return this.t.reminderLine(state, r.id, r.text, this.t.reminderOnce, when);
    });
    const total = agentLines.length + persistedLines.length;
    if (total === 0) {
      await this.adapter.sendText(target, this.t.noReminders);
      return;
    }
    const parts: string[] = [];
    if (agentLines.length > 0) parts.push(...agentLines);
    if (persistedLines.length > 0) {
      parts.push(this.t.reminderPersistedHeader);
      parts.push(...persistedLines);
    }
    await this.adapter.sendText(target, this.t.remindersCount(total, parts.join("\n")));
  }

  private async showAllWorkspaces(target: OutboundTarget): Promise<void> {
    const registry = this.ctx.get("workspaceRegistry") as
      | { list?: () => readonly { path: string; title: string; sessionIds?: readonly unknown[] }[] }
      | undefined;
    const all = registry?.list?.() ?? [];
    if (all.length === 0) {
      await this.adapter.sendText(target, this.t.noWorkspaces);
      return;
    }
    const lines = all.map((w, i) => {
      const sess = w.sessionIds !== undefined ? this.t.workspaceSessions(w.sessionIds.length) : "";
      return `${i + 1}. ${w.title}${w.title !== w.path ? `  (${w.path})` : ""}${sess}`;
    });
    await this.adapter.sendText(target, this.t.workspacesCount(all.length, lines.join("\n")));
  }

  /**
   * Create or show Web mirror session for this chat.
   * The mirror shares the same DSH session but enforces mutual exclusion:
   * when Feishu is executing a task, Web is read-only, and vice versa.
   */
  private async handleMirror(target: OutboundTarget, msg: InboundMessage): Promise<void> {
    const binding = this.bindings.get(this.channel, this.chatKey);
    
    // Check timeout before showing status
    this.checkAndReleaseTimeoutLock();
    
    // Reload binding after potential timeout release
    const updatedBinding = this.bindings.get(this.channel, this.chatKey);
    
    // Check if mirror already exists
    if (updatedBinding?.webMirrorSessionId !== undefined) {
      const queuedCount = updatedBinding.queuedMessages?.length ?? 0;
      const timeoutMin = updatedBinding.lockTimeoutMs ? Math.round(updatedBinding.lockTimeoutMs / 60000) : undefined;
      await this.adapter.sendText(
        target, 
        this.t.mirrorStatus(updatedBinding.webMirrorSessionId, updatedBinding.lockOwner, timeoutMin, queuedCount)
      );
      return;
    }

    // Create new mirror session (reuse current session)
    const agent = this.agent;
    if (agent === undefined) {
      await this.adapter.sendText(target, this.t.mirrorNotConfigured);
      return;
    }

    // The mirror uses the same session ID - it's a shared view
    const mirrorSessionId = agent.id;
    
    // Use custom timeout if provided, otherwise default to 5 minutes
    const command = parseCommand(msg.text);
    const customTimeoutMin = command.kind === "mirror" ? command.timeoutMin : undefined;
    const defaultTimeoutMs = (customTimeoutMin ?? 5) * 60 * 1000;
    
    // Update binding with mirror info and set initial lock to feishu
    const newBinding: ChatBinding = updatedBinding !== undefined
      ? { 
          ...updatedBinding, 
          webMirrorSessionId: mirrorSessionId, 
          lockOwner: "feishu",
          lockAcquiredAt: Date.now(),
          lockTimeoutMs: defaultTimeoutMs,
        }
      : {
          channel: this.channel,
          chatKey: this.chatKey,
          chatType: this.chatType,
          sessionId: mirrorSessionId,
          ownerKey: msg.senderKey,
          createdAt: Date.now(),
          lastActiveAt: Date.now(),
          webMirrorSessionId: mirrorSessionId,
          lockOwner: "feishu",
          lockAcquiredAt: Date.now(),
          lockTimeoutMs: defaultTimeoutMs,
          sessions: [],
        };
    
    this.bindings.put(newBinding);
    
    const timeoutMsg = customTimeoutMin !== undefined ? `（超时时间：${customTimeoutMin} 分钟）` : "";
    await this.adapter.sendText(target, this.t.mirrorCreated(mirrorSessionId) + timeoutMsg);
  }

  /**
   * Manually release session lock.
   */
  private async handleUnlock(target: OutboundTarget): Promise<void> {
    // Check timeout first
    this.checkAndReleaseTimeoutLock();
    
    const binding = this.bindings.get(this.channel, this.chatKey);
    if (binding?.lockOwner === undefined) {
      await this.adapter.sendText(target, this.t.unlockNoLock);
      return;
    }
    
    // Process any queued messages before releasing
    const queuedCount = binding.queuedMessages?.length ?? 0;
    
    await this.releaseLock();
    
    let message = this.t.unlockSuccess;
    if (queuedCount > 0) {
      message += `\n${this.t.queueProcessed(queuedCount)}`;
    }
    
    await this.adapter.sendText(target, message);
  }

  /**
   * Renew the current session lock timeout.
   * Extends the lock by another full timeout period from now.
   */
  private async handleRenewLock(target: OutboundTarget): Promise<void> {
    const binding = this.bindings.get(this.channel, this.chatKey);
    if (binding?.lockOwner === undefined) {
      await this.adapter.sendText(target, this.t.unlockNoLock);
      return;
    }
    
    const currentChannel: "feishu" | "web" = this.channel === "feishu" ? "feishu" : "web";
    if (binding.lockOwner !== currentChannel) {
      await this.adapter.sendText(target, this.t.sessionLockedBy(binding.lockOwner));
      return;
    }
    
    // Renew the lock by resetting the acquisition time
    const timeoutMs = binding.lockTimeoutMs ?? 5 * 60 * 1000;
    this.bindings.put({ 
      ...binding, 
      lockAcquiredAt: Date.now(),
      lastActiveAt: Date.now() 
    });
    
    const timeoutMin = Math.round(timeoutMs / 60000);
    await this.adapter.sendText(target, this.t.lockRenewed(timeoutMin));
  }

  /**
   * Export conversation history as Markdown (a future PDF pipeline can be
   * added here; `/export pdf` currently falls back to Markdown).
   */
  private async handleExport(target: OutboundTarget, format?: "markdown"): Promise<void> {
    const agent = this.agent;
    if (agent === undefined) {
      await this.adapter.sendText(target, this.t.exportNoSession);
      return;
    }

    try {
      const markdown = this.generateMarkdown(agent);
      const fileName = `conversation-${agent.id}-${Date.now()}.md`;
      const filePath = join(this.workDir, fileName);
      
      // Write to file
      writeFileSync(filePath, markdown, "utf8");
      
      await this.adapter.sendText(target, this.t.exportMarkdown(filePath));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await this.adapter.sendText(target, this.t.exportFailed(truncate(detail)));
    }
  }

  /**
   * Generate Markdown representation of the conversation history.
   */
  private generateMarkdown(agent: Agent): string {
    const events = agent.session.events;
    const lines: string[] = [];
    
    // Header
    lines.push(`# Conversation History`);
    lines.push(``);
    lines.push(`- **Session ID**: ${agent.id}`);
    lines.push(`- **Exported At**: ${new Date().toISOString()}`);
    lines.push(`- **Total Events**: ${events.length}`);
    lines.push(``);
    lines.push(`---`);
    lines.push(``);
    
    // Messages
    for (const event of events) {
      if (event.type === "user/message") {
        const text = textOf(event.data);
        if (text) {
          lines.push(`**👤 User**:`);
          lines.push(``);
          lines.push(text);
          lines.push(``);
        }
      } else if (event.type === "assistant/message") {
        const text = textOf(event.data.message);
        if (text) {
          lines.push(`**🤖 Assistant**:`);
          lines.push(``);
          lines.push(text);
          lines.push(``);
        }
      } else if (event.type === "turn/start") {
        lines.push(`*Turn started at ${new Date().toLocaleTimeString()}*`);
        lines.push(``);
      } else if (event.type === "turn/end") {
        const reason = mapReason(event.data.reason.kind);
        lines.push(`*Turn ended: ${this.reasonLabel(reason)}*`);
        lines.push(``);
        lines.push(`---`);
        lines.push(``);
      }
    }
    
    return lines.join("\n");
  }

  /**
   * Check if the current channel has write access to the session.
   * Returns true if allowed to send messages, false if read-only.
   */
  private canWrite(channel: "feishu" | "web"): boolean {
    const binding = this.bindings.get(this.channel, this.chatKey);
    if (binding === undefined) return true; // No binding, free access
    if (lockCanWrite(binding, channel)) {
      // A timed-out lock counts as free; release it so the next acquire sees a clean state.
      if (lockIsTimedOut(binding)) this.releaseTimeoutLock(binding);
      return true;
    }
    return false;
  }

  /**
   * Acquire session lock for the given channel.
   * Returns true if lock acquired, false if already locked by another channel.
   */
  private acquireLock(channel: "feishu" | "web"): boolean {
    let binding = this.bindings.get(this.channel, this.chatKey);
    if (binding === undefined) return true;

    // A timed-out lock is treated as free: release it (with the user notice)
    // before acquiring so the next state is clean.
    if (lockIsTimedOut(binding)) {
      this.releaseTimeoutLock(binding);
      binding = this.bindings.get(this.channel, this.chatKey) ?? binding;
    }

    const next = lockAcquire(binding, channel);
    if (next === undefined) return false; // Locked by another channel
    this.bindings.put({ ...next, lastActiveAt: Date.now() });
    return true;
  }

  /**
   * Queue a message for later execution when lock is released.
   * Returns the position in queue.
   */
  private queueMessage(msg: InboundMessage): number {
    const binding = this.bindings.get(this.channel, this.chatKey);
    if (binding === undefined) return -1;
    
    const queued: QueuedMessage[] = binding.queuedMessages ?? [];
    queued.push({ 
      text: msg.text, 
      senderKey: msg.senderKey, 
      timestamp: Date.now(),
      replyRef: msg.replyRef,
      images: msg.images,
      files: msg.files,
      // Keep the true source channel so replay routes to the right runner.
      channel: msg.channel,
    });
    
    this.bindings.put({ ...binding, queuedMessages: queued });
    return queued.length;
  }

  /**
   * Process all queued messages after lock release.
   * Re-enqueues them into the runner's message queue for actual execution.
   */
  private async processQueuedMessages(): Promise<void> {
    const binding = this.bindings.get(this.channel, this.chatKey);
    if (binding === undefined || !binding.queuedMessages || binding.queuedMessages.length === 0) {
      return;
    }
    
    const messages = [...binding.queuedMessages];
    const count = messages.length;
    
    // Clear queue immediately to prevent duplicate processing
    this.bindings.put({ ...binding, queuedMessages: [] });
    
    // Notify about queued messages being processed.
    await this.adapter
      .sendText(
        { chatKey: this.chatKey, chatType: this.chatType },
        this.t.queueProcessed(count),
      )
      .catch(() => undefined);

    // Replay each queued message through the service routing so it lands in
    // the runner of its own channel (a web message goes to the web runner,
    // never the releasing feishu runner). Without a router we fall back to
    // the local queue so behavior stays functional in isolation.
    for (const queued of messages) {
      const inboundMsg: InboundMessage = {
        channel: queued.channel ?? "web",
        chatKey: this.chatKey,
        chatType: this.chatType,
        senderKey: queued.senderKey,
        text: queued.text,
        replyRef: queued.replyRef,
        images: queued.images,
        files: queued.files,
      };
      if (this.requeue !== undefined) {
        this.requeue(inboundMsg);
      } else {
        this.queue.push(inboundMsg);
      }
    }
    if (this.requeue === undefined) void this.drain();
  }

  /**
   * Release session lock. Awaits the queued-message drain, then clears the
   * lock from a FRESH read: the drain's queue-clearing put must not be
   * overwritten by a stale binding object (which would resurrect the queue
   * and cause duplicate processing on the next release).
   */
  private async releaseLock(): Promise<void> {
    const binding = this.bindings.get(this.channel, this.chatKey);
    if (binding === undefined || binding.lockOwner === undefined) return;

    await this.processQueuedMessages();

    const fresh = this.bindings.get(this.channel, this.chatKey) ?? binding;
    this.bindings.put(lockRelease(fresh));
  }

  /** Check and release timed-out locks (delegates to the pure lock module). */
  private checkAndReleaseTimeoutLock(): void {
    const binding = this.bindings.get(this.channel, this.chatKey);
    if (binding !== undefined && lockIsTimedOut(binding)) {
      this.releaseTimeoutLock(binding);
    }
  }

  /** Release a timed-out lock and notify. */
  private releaseTimeoutLock(binding: ChatBinding): void {
    const timeoutMin = Math.round((binding.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS) / 60000);
    const lockedBy = binding.lockOwner;

    this.bindings.put(lockRelease(binding));

    // Notify users about timeout release
    const adapter = this.adapters?.get(this.channel);
    if (adapter !== undefined && lockedBy !== undefined) {
      void adapter.sendText(
        { chatKey: this.chatKey, chatType: this.chatType },
        this.t.lockTimeoutReleased(timeoutMin),
      ).catch(() => undefined);
    }
  }
}
