/**
 * Per-chat agent driver: serializes inbound messages, creates/resumes the bound
 * DSH agent (with preset composition + model selection), and bridges two live
 * feeds into the adapter's streaming reply: the durable `session/event` stream
 * (turn, tool, todo and settlement events) and the transient
 * `agent/assistant-stream` frames that carry the model's deltas. Since
 * 0.1.5-rc.2 the deltas are no longer session events — `assistant/chunk` is
 * gone — so the two subscriptions are separate and both are required.
 * @module dsh-connect/runner
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { copyFile, readFile } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import { SessionId, SessionStore, type Session, type SessionEvent } from "@deepseek-ai/dsh-session";
// `todo/write` and its `TodoItem` payload are declared by the todo tool, not by
// dsh-session: the base bundle merges them into `SessionEventMap` at build time,
// so this plugin only sees the event type if the declaring package is in the
// program. The base bundle always ships it, so this is a compile-time-only edge
// and the entry is erased (`import type`) — no runtime import of the tool.
import type { TodoItem } from "@deepseek-ai/dsh-tool-todo";
import { AgentRegistry, type Agent, type AgentHandle, type ModelSelection } from "@deepseek-ai/dsh-agent";
import { createUserMessage, ReasoningEffortId, type ContentBlock } from "@deepseek-ai/dsh-llm";
import type { ChannelAdapter, ChoiceOption, InboundMessage, OutboundTarget, SummaryCard, TurnOutcome, TurnReason } from "./types.js";
import {
  createAsyncQueue,
  applyStreamChunk,
  applyToolCall,
  toolCallSummary,
  questionTextOf,
  summarizeTurn,
  classifyError,
  mapReason,
  showsLiveStatus,
  truncate,
  fmtTokens,
  textOf,
  type NotifyLevel,
  type StreamChunkLike,
  type StreamState,
} from "./stream.js";
import { helpText, parseCommand, type Command } from "./commands.js";
import { resolveStateDir } from "./state-dir.js";
import { menuTitle, rootMenuSections, reasonLabel, goalPhaseLabel, listWorkspaces, PROGRESS_PRESET_MS, type MenuId, type MenuItem } from "./menus.js";
import { MenuController, type MenuHost } from "./menu-controller.js";
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
  /** Fallback sender allowlist (open ids / user ids) for channels without their own. */
  allowUsers?: string[];
  /** Fallback chat allowlist for channels without their own. */
  allowChats?: string[];
  /**
   * Per-channel access control, keyed by channel id. A channel listed here uses
   * these lists *instead of* the top-level `allowUsers`/`allowChats`, because
   * identifiers are channel-specific and one global list cannot be right for two
   * channels at once.
   */
  channelAccess?: Record<string, { allowUsers?: string[]; allowChats?: string[] }>;
  stateDir?: string;
  /** Automatically create Web mirror for new sessions (default: true). */
  autoMirror?: boolean;
  /** Liveness heartbeat interval ms for the streaming card; 0 disables it (default: 60000). */
  streamHeartbeatMs?: number;
  /** Streaming reply detail. Default 'result' (final answer only) keeps chat cards short. */
  notifyLevel?: NotifyLevel;
  /** Proactive progress-notice interval ms: when a turn goes silent for this long, a standalone status card is sent (default: 300000 = 5 min; 0 disables). */
  progressTimeoutMs?: number;
  /** Compact the session automatically once context usage crosses `autoCompactThresholdPct` (default: false). */
  autoCompact?: boolean;
  /** Context-window usage percentage that triggers `autoCompact` (default: 80). */
  autoCompactThresholdPct?: number;
}

export interface ResolvedConnectConfig {
  agentPreset?: string;
  workDir?: string;
  workspaces: string[];
  visionModel?: { provider: string; model: string };
  language: Language;
  allowUsers: string[];
  allowChats: string[];
  /** Resolved per-channel access control; a missing channel falls back to the two above. */
  channelAccess: Record<string, { allowUsers: string[]; allowChats: string[] }>;
  stateDir?: string;
  autoMirror: boolean;
  streamHeartbeatMs: number;
  notifyLevel: NotifyLevel;
  progressTimeoutMs: number;
  autoCompact: boolean;
  autoCompactThresholdPct: number;
}

/**
 * Pull each channel's own `allowUsers`/`allowChats` out of its config block.
 *
 * A channel appears in the result **only if its block declares one of the two
 * keys**. That distinction is load-bearing: `isChatAllowed` reads a
 * present-but-empty list as "this channel allows everyone", so recording every
 * channel unconditionally would silently opt each one out of the top-level
 * fallback the user set for it.
 *
 * Strings are filtered rather than trusted because this reads raw profile YAML
 * and a stray `null` in a hand-edited list would otherwise become a list entry
 * that can never match a sender.
 */
function collectChannelAccess(config: ConnectConfig): Record<string, { allowUsers: string[]; allowChats: string[] }> {
  const out: Record<string, { allowUsers: string[]; allowChats: string[] }> = {};
  const strings = (value: unknown): string[] | undefined =>
    Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : undefined;
  for (const [channel, block] of Object.entries(config)) {
    if (block === null || typeof block !== "object" || Array.isArray(block)) continue;
    const entry = block as { allowUsers?: unknown; allowChats?: unknown };
    const allowUsers = strings(entry.allowUsers);
    const allowChats = strings(entry.allowChats);
    if (allowUsers === undefined && allowChats === undefined) continue;
    out[channel] = { allowUsers: allowUsers ?? [], allowChats: allowChats ?? [] };
  }
  return out;
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
    // Per-channel access control, collected from each channel's OWN config block
    // (`feishu.allowUsers`, `telegram.allowUsers`, …) because that is where the
    // pane puts them and where a per-channel setting belongs: the ids are
    // channel-specific, so a Feishu `ou_…` list is not a Telegram one.
    //
    // Only channels that actually declare a key appear here. That distinction is
    // load-bearing: `isChatAllowed` treats a present-but-empty list as "this
    // channel allows everyone", so recording a channel that never configured
    // access would silently opt it out of the global fallback.
    channelAccess: collectChannelAccess(config),
    stateDir: config.stateDir,
    autoMirror: config.autoMirror ?? true, // Enabled by default
    streamHeartbeatMs: config.streamHeartbeatMs ?? 60_000,
    notifyLevel: config.notifyLevel ?? "result",
    progressTimeoutMs: config.progressTimeoutMs ?? 5 * 60_000, // Proactive progress notice after 5 min of silence
    autoCompact: config.autoCompact ?? false, // Off by default: compaction rewrites history, so it is opted into
    // Clamped to 1–99 so a nonsense value cannot mean "compact on every turn"
    // (0) or "never, even when the window is full" (100+).
    autoCompactThresholdPct: Math.min(99, Math.max(1, Math.round(config.autoCompactThresholdPct ?? 80))),
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
  /** Last tool name that pushed a status line (dedupes repeat tool calls). */
  lastToolName?: string;
  /** Latest observed context usage (input tokens) and window, for the proactive compaction nudge. */
  contextSize?: number;
  contextWindow?: number;
  /** Whether the proactive context-high nudge was already sent this turn (dedupe). */
  contextNudged: boolean;
  /** User confirmed compaction while the turn was still running — run it once the turn ends. */
  compactAfterTurn: boolean;
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


/** How often the proactive progress watchdog re-checks whether a status card is due (ms). */
const PROGRESS_WATCHDOG_CHECK_MS = 15_000;

/**
 * The slice of the host `agentPresets` service this runner uses.
 *
 * `list` is optional because it is consulted only while recovering from an
 * unusable configured id: a host that does not expose it still gets
 * {@link FALLBACK_PRESET_ID} tried on its own.
 */
interface PresetService {
  resolve(id?: string): Promise<{ id: string; broken?: string }>;
  list?(): Promise<Array<{ id: string; broken?: string }>>;
  mount(agentCtx: Context, id: string): Promise<unknown>;
}

/**
 * Preset composed when the configured one cannot be used.
 *
 * `standard` is the roster's general-purpose preset and ships in every build,
 * so it is the safest thing to fall back to. The roster still gets asked first
 * — if it disagrees the first mountable row wins, and only a roster with no
 * usable row at all leaves the agent uncomposted.
 */
const FALLBACK_PRESET_ID = "standard";

/** How a preset id reads in a log line: a quoted id, or the roster's default. */
function describePreset(id: string | undefined): string {
  return id === undefined || id === "" ? "the roster default" : JSON.stringify(id);
}

export class AgentRunner implements MenuHost {
  private readonly queue: InboundMessage[] = [];
  private running = false;
  /** Set by `dispose()`; makes the runner permanently inert. */
  private disposed = false;
  private agent?: Agent;
  private handle?: AgentHandle;
  private turn?: ActiveTurn;
  workDir: string;
  language: Language;
  notifyLevel: NotifyLevel;
  progressTimeoutMs: number;
  /** Compact automatically once context usage crosses `autoCompactThresholdPct`. */
  autoCompact: boolean;
  /** Context-window usage percentage that triggers auto-compaction. */
  autoCompactThresholdPct: number;
  t: Messages;
  private readonly menu: MenuController;

  constructor(
    readonly ctx: Context,
    private readonly config: ResolvedConnectConfig,
    readonly channel: string,
    readonly chatKey: string,
    private readonly chatType: "p2p" | "group",
    readonly adapter: ChannelAdapter,
    readonly bindings: BindingStore,
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
    // Per-chat overrides, like the other two above, so /autocompact can change
    // it for one chat without touching the profile.
    this.autoCompact = stored?.autoCompact ?? config.autoCompact;
    this.autoCompactThresholdPct = stored?.autoCompactThresholdPct ?? config.autoCompactThresholdPct;
    this.t = messages(this.language);
    this.menu = new MenuController(this);
  }

  menuTitle(menuId: MenuId): string {
    return menuTitle(menuId, this.t);
  }

  rootMenuSections(): readonly { title: string; ids: readonly string[]; columnsPerRow?: number }[] {
    return rootMenuSections(this.t);
  }

  private reasonLabel(reason: TurnReason): string {
    return reasonLabel(reason, this.t);
  }

  /** Prefer the user's first DSH workspace over the process cwd as default. */
  private resolveDefaultWorkDir(): string {
    const registry = this.ctx.get("workspaceRegistry") as
      | { list?: () => readonly { path: string }[] }
      | undefined;
    const first = registry?.list?.()[0];
    return first?.path ?? process.cwd();
  }

  /**
   * Tear the runner down for good — the counterpoint to `enqueue`.
   *
   * Called when the runner's channel adapter is deactivated (a settings change
   * removed that channel from `channels[]`) or the service shuts down. The
   * runner is inert afterwards: `enqueue` drops work and the drain loop stops
   * before its next turn. `ConnectService` deletes its map entry, so a later
   * message builds a fresh runner instead of reviving this one.
   *
   * `queuedMessages` is cleared rather than replayed: those messages belong to
   * a channel that no longer has an adapter to answer on, so replaying them
   * would run agent turns whose output has nowhere to go.
   */
  async dispose(): Promise<void> {
    this.disposed = true;
    this.queue.length = 0;
    await this.disposeAgent();
    const binding = this.bindings.get(this.channel, this.chatKey);
    if (binding !== undefined && binding.lockOwner !== undefined) {
      this.bindings.put({ ...lockRelease(binding), queuedMessages: [] });
    }
  }

  enqueue(msg: InboundMessage): void {
    if (this.disposed) return;
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
      if (typeof event.data.contextWindow === "number") {
        turn.contextWindow = event.data.contextWindow;
        // Mirrored onto the runner: the turn object is discarded at turn end,
        // but auto-compaction runs after that and needs the last measurement.
        this.lastContextWindow = event.data.contextWindow;
      }
      this.maybeNudgeContext(turn);
      return;
    }
    if (event.type === "assistant/message") {
      const usage = (event.data as { usage?: { inputTokens?: number } }).usage;
      if (usage !== undefined && typeof usage.inputTokens === "number") {
        turn.contextSize = usage.inputTokens;
        this.lastContextSize = usage.inputTokens;
        this.maybeNudgeContext(turn);
      }
    }

    if (event.type === "tool/call") {
      const name = event.data.name as string | undefined;
      if (typeof name !== "string" || name === "") return;
      const summary = toolCallSummary(event.data.arguments);
      turn.toolCount += 1;
      // The milestone the /status report and the progress reminder read. It is
      // deliberately NOT the tool name: a "🔧 调用工具 pwsh" line is the activity
      // detail the quiet levels suppress, so naming the tool here would smuggle
      // the one thing the user removed into the one message they kept. What the
      // reminder is for is "work is still happening", which a count conveys
      // without re-listing the tools.
      //
      // The one exception is a question, which is not activity but a *request*
      // aimed at the user — dropping it would hide the fact that the bot is
      // waiting on them.
      if (name === "ask_user_question") {
        turn.milestone = this.t.questionToolCall(questionTextOf(event.data.arguments));
      } else {
        turn.milestone = this.t.toolProgress(turn.toolCount);
      }
      // Mirrored onto the runner so a reminder that fires after the turn object is
      // gone still reports the real milestone instead of falling back to 「思考中」.
      this.lastMilestone = turn.milestone;
      // Only `full` narrates tool activity. `important` and `result` show the
      // final answer at turn end and nothing in between — a `🔧 调用工具 …` line
      // is live activity, not a milestone, and the user asked for it to go.
      // `turn.milestone` above is still updated before this: the milestone is
      // what the /status report reads, so dropping the *line* must not drop the
      // state that makes /status useful.
      if (!showsLiveStatus(this.notifyLevel)) return;
      // Keep the streaming card short: push a status line only once per distinct
      // tool (not once per call, which would log "tool #51" spam), and label it
      // with the tool name rather than a running counter.
      if (turn.lastToolName === name) return;
      turn.lastToolName = name;
      // Only `full` gets here, so the summary is always shown — the old
      // `notifyLevel === 'full' ? summary : undefined` guard is now unreachable
      // and its ternary would just be a second, silently wrong copy of the gate.
      const label = name === 'ask_user_question'
        ? this.t.questionToolCall(questionTextOf(event.data.arguments))
        : this.t.toolCalling(name, summary);
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
  async confirmAction(target: OutboundTarget, promptText: string, messageId?: string): Promise<boolean> {
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
    if (this.running || this.disposed) return;
    this.running = true;
    try {
      while (this.queue.length > 0 && !this.disposed) {
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

    // Set when the stored session could not be resumed and this turn therefore
    // starts a new one. Reported to the chat only *after* the fresh session exists
    // — see the notice below.
    let resumeFailure: string | undefined;

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
        // An empty id is not a lost conversation. `maybeSendWelcome` writes the
        // binding for a brand-new chat with `sessionId: ""` before the first
        // `ensureAgent`, so this same catch runs once on every chat's first
        // message with nothing to resume — the log line is right, a chat notice
        // saying "could not resume your session" would not be.
        if (binding.sessionId !== "") resumeFailure = String(error);
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

    // The resume above failed. Until now only the log said so, which is the one
    // place a chat user never looks: they send a follow-up into a conversation that
    // looks intact, and the reply arrives with no memory of it. The old session is
    // not lost — it is still in the session store and still viewable in the Web GUI
    // — so the honest report is "continuing in a new one", plus the reason, so a
    // permanent cause (a deleted session store, a moved work dir) is distinguishable
    // from a one-off.
    //
    // Sent only here, after `create` succeeded, and never from the catch: claiming a
    // session was started before it exists would be the same lie in the other
    // direction. `recordSession` has already repointed the binding at the new
    // session, so this fires once per breakage rather than once per message.
    if (resumeFailure !== undefined) {
      await this.adapter
        .sendText(this.target(msg), this.t.resumeFallback(truncate(resumeFailure, 300)))
        .catch((error: unknown) => {
          this.warn(`connect: resume-fallback notice could not be delivered (${this.channel}/${this.chatKey}): ${String(error)}`);
        });
    }

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
  async collectWorkdirSessions(): Promise<{ sessionId: string; title: string }[]> {
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

  defaultSelection(): ModelSelection {
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
   *
   * Preset resolution is best-effort — see {@link resolvePresetId}. This method
   * never throws for a preset reason, so no configuration id can stop a turn
   * from composing an agent at all.
   */
  private async composeSetup(_selection: ModelSelection): Promise<{
    agentPreset?: string;
    setup: (agentCtx: Context) => void | Promise<void>;
  }> {
    const presets = this.ctx.get("agentPresets") as PresetService | undefined;

    if (presets === undefined) {
      return {
        setup: () => undefined,
      };
    }

    const id = await this.resolvePresetId(presets);
    if (id === undefined) {
      return {
        setup: () => undefined,
      };
    }

    return {
      agentPreset: id,
      setup: async (agentCtx) => {
        await presets.mount(agentCtx, id);
      },
    };
  }

  /**
   * Resolve the preset to compose, degrading instead of aborting the turn.
   *
   * The host looks a preset up by id, so one stale id — `agentPresets.default`
   * naming a preset this install does not ship, or a preset directory edited
   * into an unreadable state — used to throw straight out of `composeSetup`.
   * That happens before an agent exists, so *every* turn of every bound chat
   * died with the raw host error and nothing in the session log to explain it.
   * Resolution is therefore best-effort: the configured id is tried, then
   * {@link FALLBACK_PRESET_ID}, and when neither composes the agent is built
   * without a preset — the same shape a host with no `agentPresets` service
   * already produced — so the turn still runs.
   */
  private async resolvePresetId(presets: PresetService): Promise<string | undefined> {
    const wanted = this.config.agentPreset;

    const resolved = await this.tryPreset(presets, wanted);
    if (resolved !== undefined) return resolved;

    const recovered = await this.tryPreset(presets, await this.fallbackPresetId(presets));
    if (recovered !== undefined) {
      this.log(`connect: falling back to agent preset ${JSON.stringify(recovered)}`);
      return recovered;
    }

    this.log("connect: no usable agent preset; composing the agent without one");
    return undefined;
  }

  /**
   * Resolve `id`, reporting why it is unusable instead of throwing.
   *
   * A preset that resolves but reports `broken` counts as unusable: the host's
   * mounting paths refuse those, so composing one would only move this failure
   * to `mount`, after the log line that would have explained it.
   *
   * `undefined` id means "the roster default", which is what `resolve` does
   * with it — the default is as fallible as an explicit id, so it is routed
   * through the same recovery.
   */
  private async tryPreset(presets: PresetService, id: string | undefined): Promise<string | undefined> {
    try {
      const resolved = await presets.resolve(id);
      if (resolved.broken !== undefined) {
        this.log(`connect: agent preset ${describePreset(id)} failed to load: ${resolved.broken}`);
        return undefined;
      }
      return resolved.id;
    } catch (error) {
      this.log(`connect: agent preset ${describePreset(id)} is unusable: ${String(error)}`);
      return undefined;
    }
  }

  /**
   * The id to retry with: {@link FALLBACK_PRESET_ID} while the roster still
   * offers it, otherwise the roster's first mountable row.
   *
   * Never throws — the caller is already handling a failure, and a roster that
   * cannot be listed should still leave the hardcoded id to be tried.
   */
  private async fallbackPresetId(presets: PresetService): Promise<string> {
    try {
      const mountable = ((await presets.list?.()) ?? []).filter((row) => row.broken === undefined);
      return mountable.find((row) => row.id === FALLBACK_PRESET_ID)?.id ?? mountable[0]?.id ?? FALLBACK_PRESET_ID;
    } catch {
      return FALLBACK_PRESET_ID;
    }
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
    // Live model deltas. Deltas used to arrive as `assistant/chunk` session
    // events; that type is gone, and a turn's stream is now durable only at
    // settlement (embedded in `assistant/message` / `assistant/attempt`). The
    // live feed is this separate agent-scoped event instead — `dsh-scope`
    // routes it by its `agent` subject, so a listener on `agent.ctx` sees only
    // this agent's frames, exactly like the `session/event` subscription above
    // (no id filter needed). Frames carry real `StreamChunk`s, so
    // `applyStreamChunk` is unchanged.
    agent.ctx.on("agent/assistant-stream", ({ frame }) => {
      const turn = this.turn;
      if (turn === undefined) return;
      // `start` / `end` only bracket the attempt; the card is driven by chunks.
      if (frame.type !== "chunk") return;
      const chunk = frame.chunk as StreamChunkLike;
      // First reasoning delta = the milestone the proactive progress notice reports.
      if (chunk.type === "reasoning-delta" && turn.milestone === undefined) {
        turn.milestone = this.t.progressThinking;
      }
      applyStreamChunk(turn, this.t.thinkingHint, chunk, this.notifyLevel);
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
    // Recorded here so the progress reminder can still report an honest elapsed time
    // if the turn object is gone by the time it fires. The milestone is cleared for
    // the same reason in reverse: carrying the previous turn's last tool into a new
    // turn's first reminder would describe work that already finished.
    this.workStartedAt = now;
    this.lastMilestone = undefined;
    this.turn = {
      firstSeq, chunks, lastText: "",
      reasoning: false, hintPushed: false, lastIndex: undefined, pushedAny: false,
      startedAt: now, lastPushAt: now, toolCount: 0, lastToolName: undefined, contextNudged: false, compactAfterTurn: false,
    };

    // Liveness heartbeat: while the agent is working, keep the streaming card
    // visibly alive even through long reasoning or tool-execution stretches
    // (a card that sits on "Thinking…" for minutes looks frozen). Configurable
    // via `streamHeartbeatMs`; 0 disables it.
    //
    // `full` only. This is a repeating "still processing" line, and the two
    // quieter levels describe themselves in discrete events: `important` as
    // 「思考开始、工具调用、最终回答」 and `result` as the final answer alone. A
    // per-minute heartbeat is neither, so gating it on `!== "result"` — which is
    // what let `important` receive it — made the setting a lie for anyone who
    // chose 输出重要节点 and then watched a status line arrive every minute.
    const heartbeatMs = this.config.streamHeartbeatMs;
    const heartbeat = heartbeatMs > 0 && showsLiveStatus(this.notifyLevel)
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
    // for `progressTimeoutMs` (default 5 min, user-configurable), re-sync the
    // latest milestone INTO the streaming card (via its chunk stream) so a long
    // turn never looks frozen — WITHOUT posting a separate message. The card is
    // edited in place, keeping the chat history clean. Streaming-card heartbeats
    // deliberately do NOT reset this: the progress watchdog only fires when no
    // explicit milestone sync has been pushed for the configured interval.
    const progressTimeoutMs = this.progressTimeoutMs;
    let lastProgressNoticeAt = now;
    // The tick is derived from the configured interval instead of being fixed at
    // `PROGRESS_WATCHDOG_CHECK_MS`: a fixed 15s tick means `progressTimeoutMs:
    // 30_000` is honoured at 30–45s, i.e. up to 1.5× what the user asked for,
    // and no test can observe the feature without sleeping the constant out.
    // Half the interval lands within 1–1.5× of the request; the 250ms floor
    // stops a pathologically small value from becoming a busy loop; the cap
    // leaves the default (5 min) on the same 15s tick as before.
    const watchdogTickMs = Math.max(250, Math.min(PROGRESS_WATCHDOG_CHECK_MS, Math.round(progressTimeoutMs / 2)));
    // NOT gated on the notification level, unlike the heartbeat above, and the
    // distinction is the whole point of this timer. The heartbeat is *liveness
    // chatter* — a line every 60s saying nothing but "still here" — which the
    // quiet levels exist to suppress. This watchdog is a *status report the user
    // explicitly configured* (`progressTimeoutMs`, default 5 min), it fires once
    // per interval rather than continuously, and it carries the elapsed time and
    // the latest milestone. Turning off the reminder as a side effect of choosing
    // a quieter level would silently discard a setting the user set on purpose.
    //
    // Its milestone is tool-free (see the `tool/call` handler), so keeping it at
    // every level does not smuggle tool activity back into the quiet levels.
    const progressWatchdog = progressTimeoutMs > 0
      ? setInterval(() => {
          const elapsed = Date.now() - lastProgressNoticeAt;
          if (elapsed < progressTimeoutMs) return;
          lastProgressNoticeAt = Date.now();
          const turn = this.turn;
          if (turn !== undefined) {
            const minutes = Math.max(1, Math.round((Date.now() - turn.startedAt) / 60_000));
            const status = turn.milestone ?? this.t.progressThinking;
            // Edit the existing streaming card in place instead of sending a new
            // message: the milestone is appended to the same card via the chunk
            // stream, so progress updates never clutter the chat with new bubbles.
            turn.chunks.push(`\n\n${this.t.progressReminder(minutes, status)}\n\n`);
            return;
          }
          // No turn state, but the timer is still running — which means the agent is
          // still busy. This used to `return` silently, and that is the reported
          // defect: the card took the first reminder and then stopped updating, so
          // the user's last message said 「已进行 5 分钟」 forever while the task ran
          // on. A live card edit is only reachable through `turn.chunks`; with the
          // turn gone there is no card to edit, so the notice has to be its own
          // message. Slightly noisier beats a progress report that silently stops
          // reporting — that is the one job it has.
          const sinceStart = this.workStartedAt;
          const minutes = sinceStart === undefined ? 1 : Math.max(1, Math.round((Date.now() - sinceStart) / 60_000));
          this.log(
            `connect: progress reminder for ${this.chatKey} had no turn to edit; posting it as a message`,
          );
          void this.adapter
            .sendText(this.target(msg), this.t.progressReminder(minutes, this.lastMilestone ?? this.t.progressThinking))
            .catch(() => undefined);
        }, watchdogTickMs)
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
    } else {
      // Auto-compaction, checked here rather than mid-turn because compaction
      // needs an idle agent and because the threshold is about what the *next*
      // turn will have to carry. Running it here means the turn that fills the
      // window still finishes with its full history, and the one after it
      // starts on a compacted session.
      await this.maybeAutoCompact(agent, msg);
    }

    const outcome = summarizeTurn(agent.session.snapshotEvents(), firstSeq);
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

  private warn(message: string): void {
    (this.ctx.get("logger") as { warn?: (...args: unknown[]) => void } | undefined)?.warn?.(message);
  }

  /**
   * Send a task-end card and report a delivery failure instead of discarding it.
   *
   * The catch used to be a bare `undefined`, which made a dropped card and a card
   * with nothing to say indistinguishable. It is neither: this card is the
   * durable record of the turn — the result text and the token/duration summary —
   * and the streaming card it replaces is meanwhile stuck on its last frame. A
   * silent failure here leaves the user watching a frozen "running" indicator
   * with no reason to think anything went wrong.
   *
   * The log is the only report available: the user-facing channel is precisely
   * what just failed, so there is nothing to send the notice on.
   */
  private async sendTaskCard(msg: InboundMessage, card: SummaryCard, kind: string): Promise<void> {
    try {
      await this.adapter.sendCard(this.taskTarget(msg), card);
    } catch (error) {
      this.warn(`connect: ${kind} card could not be delivered to ${this.channel}/${this.chatKey}: ${String(error)}`);
    }
  }

  private readTodos(): TodoItem[] {
    const agent = this.agent;
    if (agent === undefined) return [];
    const events = agent.session.snapshotEvents();
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
    // Full answer here too: on a failed/aborted turn this summary is the only
    // report of what was produced before the stop, and truncating it hides
    // exactly the part the user needs to judge whether any of it is usable.
    if (outcome.text !== "") lines.push(this.t.produced(outcome.text));
    const card: SummaryCard = { markdown: lines.join("\n") };
    await this.sendTaskCard(msg, card, "summary");
  }

  /** Context-window usage at or above this percentage suggests compaction. */
  private static readonly COMPACT_THRESHOLD_PCT = 75;

  /**
   * Send a compact task-end card: the model used, input/output tokens, elapsed
   * time, and whether compaction is advisable given context-window usage.
   */
  private async sendTurnStats(msg: InboundMessage, outcome: TurnOutcome): Promise<void> {
    const hasStats = outcome.model !== undefined || outcome.inputTokens !== undefined || outcome.outputTokens !== undefined;
    const hasResult = outcome.reason === "completed" && outcome.text !== "";
    // No stats and no result to report — nothing to show (a bare stats card with
    // only a duration would be noise).
    if (!hasStats && !hasResult) return;
    const lines: string[] = [
      this.t.taskStatsHeader(outcome.elapsedMs === undefined ? "—" : this.t.taskDuration(outcome.elapsedMs)),
    ];
    if (outcome.model !== undefined) lines.push(this.t.taskStatsModel(outcome.model));
    if (outcome.inputTokens !== undefined) {
      lines.push(this.t.taskStatsTokensIn(fmtTokens(outcome.inputTokens), outcome.cacheReadTokens !== undefined ? fmtTokens(outcome.cacheReadTokens) : undefined));
    }
    if (outcome.outputTokens !== undefined) lines.push(this.t.taskStatsTokensOut(fmtTokens(outcome.outputTokens)));
    if (outcome.steps !== undefined) lines.push(this.t.taskStatsSteps(outcome.steps));
    // Context usage is part of every turn-end report, by request: the user wants
    // to see where the window stands after each round without asking. When the
    // window is unknown the absolute token count is still reported with an
    // explicit "window unknown" rather than omitting the line — a silently
    // missing field reads as "nothing to worry about", which is the opposite of
    // what a usage report is for.
    if (outcome.contextWindow !== undefined && outcome.contextWindow > 0 && outcome.contextSize !== undefined) {
      const pct = Math.round((outcome.contextSize / outcome.contextWindow) * 100);
      lines.push(this.t.taskStatsContext(`${pct}`, fmtTokens(outcome.contextWindow)));
      // The advice names the *active* rule: with auto-compaction on, telling the
      // user to send /compact by hand would be wrong — it is already handled.
      if (this.autoCompact) {
        lines.push(
          pct >= this.autoCompactThresholdPct
            ? this.t.taskStatsAutocompactDue(`${this.autoCompactThresholdPct}`)
            : this.t.taskStatsAutocompactArmed(`${this.autoCompactThresholdPct}`),
        );
      } else {
        lines.push(pct >= AgentRunner.COMPACT_THRESHOLD_PCT ? this.t.taskStatsCompactSuggest : this.t.taskStatsCompactOk);
      }
    } else if (outcome.contextSize !== undefined) {
      lines.push(this.t.taskStatsContextUnknown(fmtTokens(outcome.contextSize)));
    }
    // A finished task's answer must survive the end of the run: the live
    // streaming card shows the output as it is produced, but the stats card is
    // the durable post-task report. When the turn completed and produced text,
    // append the result here instead of leaving a bare stats card.
    if (hasResult) {
      lines.push("");
      // The full answer, NOT `truncate(outcome.text, 300)`. This card is the
      // durable post-task report — under `result` it is the *only* place the
      // answer appears, so a 300-char cap silently shipped a third of a long
      // answer and looked like the agent had stopped mid-sentence.
      lines.push(this.t.produced(outcome.text));
    }
    const card: SummaryCard = { markdown: lines.join("\n") };
    await this.sendTaskCard(msg, card, "stats");
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
          await this.menu.openMenu(target, msg, "workspace", ["root"]);
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
        await this.menu.openMenu(target, msg, "chat", ["root"]);
        break;
      }
      case "menu": {
        await this.menu.openMenu(target, msg, "root");
        break;
      }
      case "settings": {
        await this.menu.openMenu(target, msg, "settings", ["root"]);
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
        await this.menu.openMenu(target, msg, "model", ["root"]);
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
      case "autocompact": {
        await this.handleAutocompact(command.arg, target);
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
    const { persisted } = this.reminders.add({
      channel: this.channel,
      chatKey: this.chatKey,
      chatType: this.chatType,
      text: body,
      dueAt,
      ownerKey: msg.senderKey,
    });
    // Two outcomes and one message would hide half of one: the reminder is live in
    // this process and will fire, but a failed write means it will not survive a
    // restart. Saying only 「已设置」 is how a reminder set for tomorrow quietly
    // disappears overnight, and refusing to set it at all would be the opposite lie.
    const line = this.t.reminderSet(formatRemindAt(dueAt, this.language), body);
    await this.adapter.sendText(target, persisted ? line : `${line}\n${this.t.reminderNotPersisted}`);
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

  async newChat(msg: InboundMessage): Promise<void> {
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

  async switchTo(sessionId: string, ownerKey: string): Promise<void> {
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

  listWorkspaces(): { path: string; title: string }[] {
    return listWorkspaces({
      registry: this.ctx.get("workspaceRegistry") as
        | { list?: () => readonly { path: string; title: string }[] }
        | undefined,
      workDir: this.workDir,
      currentDirLabel: this.t.currentDir,
      workspaces: this.config.workspaces,
    });
  }



  async showStatus(target: OutboundTarget): Promise<void> {
    const agent = this.agent;
    if (agent === undefined) {
      await this.adapter.sendText(target, this.t.statusNoSession(this.workDir));
      return;
    }

    // Determine detailed execution state.
    //
    // `agent.status === "running"` alone is not proof that *we* are running a
    // task: after a host restart the resumed session still holds a turn that was
    // cut off mid-flight (no `turn/end` was ever recorded), so the agent reads
    // "running" forever while nothing is driving it — and, because the watchdog
    // lives inside `driveAgent`, no progress notice will ever come either. That
    // combination is what makes a dead task look like a live one. Only report
    // 正在处理任务 when this process actually owns the turn; otherwise say the
    // previous task was interrupted, which is the truth and is actionable.
    let statusLabel: string;
    if (agent.status === "running" && (this.running || this.turn !== undefined)) {
      statusLabel = this.t.statusExecuting;
    } else if (agent.status === "running") {
      statusLabel = this.t.statusOrphaned;
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
    lines.push(this.t.progressSetting(this.progressTimeoutMs === 0 ? this.t.progressOff : this.t.progressMinutes(Math.round(this.progressTimeoutMs / 60_000))));
    await this.adapter.sendText(target, lines.join("\n"));
  }

  /** Extract the most recent turn's completion info from session events. */
  private getLastTurnInfo(agent: Agent): { reason: TurnReason; completedAt: string } | undefined {
    const events = agent.session.snapshotEvents();
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i];
      if (event.type === "turn/end") {
        const reason = mapReason(event.data.reason.kind);
        // The event's OWN timestamp, never `new Date()`. Reading the clock here
        // made every /status report "completed at <now>" — so a task that had
        // been running for half an hour, or one that never finished at all,
        // was reported as freshly completed the moment the user asked. That is
        // worse than no timestamp: it is a fabricated one, and it sent a real
        // investigation after the wrong event. `turn/end` always carries
        // `time`; the fallback is only for an event shape that lacks it, and
        // says so rather than inventing a plausible-looking hour.
        const at = typeof event.time === "number" ? new Date(event.time) : undefined;
        const completedAt = at === undefined
          ? "—"
          : at.toLocaleTimeString(this.language === "en" ? "en-US" : "zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
        return { reason, completedAt };
      }
    }
    return undefined;
  }

  async showTasks(target: OutboundTarget): Promise<void> {
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

  async showSettings(target: OutboundTarget): Promise<void> {
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
    // Show the directory the stores actually resolve to (config → env → default),
    // not the raw config value, so the status card can't disagree with disk.
    lines.push(this.t.stateDirField(resolveStateDir(this.config)));
    await this.adapter.sendText(target, lines.join("\n"));
  }



  async setModel(provider: string, model: string, msg: InboundMessage): Promise<void> {
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


  async setReasoning(effort: string | undefined, msg: InboundMessage): Promise<void> {
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
  async setLanguage(lang: Language, target: OutboundTarget, msg: InboundMessage): Promise<void> {
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
  async setNotifyLevel(level: NotifyLevel, target: OutboundTarget, msg: InboundMessage): Promise<void> {
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

  /**
   * `/autocompact [on|off|<1-99>]` — turn automatic context compaction on or
   * off for this chat, and set the threshold. A bare invocation reports the
   * current state instead of guessing, since the switch is a safety behaviour
   * and a typo silently disabling it would be the wrong default.
   */
  private async handleAutocompact(arg: string | undefined, target: OutboundTarget): Promise<void> {
    const raw = (arg ?? "").trim().toLowerCase();
    if (raw === "") {
      await this.adapter.sendText(
        target,
        this.t.autocompactStatus(this.autoCompact, `${this.autoCompactThresholdPct}`),
      );
      return;
    }
    if (raw === "on" || raw === "off") {
      await this.setAutoCompact(raw === "on", target);
      return;
    }
    const pct = Number(raw.replace(/%$/, ""));
    if (!Number.isFinite(pct) || pct < 1 || pct > 99) {
      await this.adapter.sendText(target, this.t.autocompactUsage);
      return;
    }
    await this.setAutoCompact(this.autoCompact, target, Math.round(pct));
  }

  /**
   * Persist the per-chat auto-compaction switch and/or threshold. Passing no
   * `pct` leaves the threshold alone, so `/autocompact on` does not silently
   * reset a threshold the user set earlier.
   */
  async setAutoCompact(on: boolean, target: OutboundTarget, pct?: number): Promise<void> {
    this.autoCompact = on;
    if (pct !== undefined) this.autoCompactThresholdPct = pct;
    const binding = this.bindings.get(this.channel, this.chatKey);
    const patch = {
      autoCompact: on,
      autoCompactThresholdPct: this.autoCompactThresholdPct,
      lastActiveAt: Date.now(),
    };
    if (binding !== undefined) {
      this.bindings.put({ ...binding, ...patch });
    } else {
      // Same shape `setNotifyLevel` uses: a chat that has never been bound
      // still records the preference, so it survives until a session exists.
      this.bindings.put({
        channel: this.channel,
        chatKey: this.chatKey,
        chatType: this.chatType,
        sessionId: "",
        ownerKey: "",
        createdAt: Date.now(),
        ...patch,
        sessions: [],
      });
    }
    if (pct !== undefined) {
      await this.adapter.sendText(target, this.t.autocompactThresholdSet(`${this.autoCompactThresholdPct}`));
    } else {
      await this.adapter.sendText(
        target,
        on ? this.t.autocompactOn(`${this.autoCompactThresholdPct}`) : this.t.autocompactOff,
      );
    }
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
  async setProgressTimeout(ms: number, target: OutboundTarget, msg: InboundMessage): Promise<void> {
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
    const options: ChoiceOption[] = PROGRESS_PRESET_MS.map((ms) => ({
      id: `progress:${ms}`,
      label: ms === 0 ? this.t.progressOff : this.t.progressMinutes(ms / 60_000),
    }));
    const { choice } = await this.adapter.promptChoice(target, { title: this.t.progressMenuTitle, options });
    if (choice === undefined || !choice.startsWith("progress:")) return;
    const ms = Number(choice.slice("progress:".length));
    if (!Number.isInteger(ms) || ms < 0) return;
    await this.setProgressTimeout(ms, target, msg);
  }

  async showPlugins(target: OutboundTarget): Promise<void> {
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

  /**
   * Compact the session automatically when context usage has reached
   * `autoCompactThresholdPct`, if the user turned `autoCompact` on.
   *
   * Deliberately silent on the happy path. Compaction is maintenance the user
   * asked to happen on its own, and a chat message every time it fires would be
   * exactly the kind of chatter the `important` level exists to suppress —
   * the chosen notification level governs this notice too. The turn-end stats
   * card reports the resulting usage either way, so the effect is visible
   * without an extra bubble; a *failure* is still reported, because silently
   * not compacting would leave the user believing they are protected.
   *
   * @param agent - the agent whose session may be compacted (must be idle).
   * @param msg - the inbound message, used to resolve the reply target.
   */
  private async maybeAutoCompact(agent: Agent, msg: InboundMessage): Promise<void> {
    if (!this.autoCompact) return;
    const size = this.lastContextSize;
    const window = this.lastContextWindow;
    // No measurement, no decision: a threshold test against an unknown window
    // would either fire on every turn or never, and both are worse than
    // waiting for a turn that does report one.
    if (size === undefined || window === undefined || window <= 0) return;
    const pct = (size / window) * 100;
    if (pct < this.autoCompactThresholdPct) return;
    if (agent.status !== "idle") return;
    try {
      const result = await this.runCompaction(agent);
      if (result === "compacted") {
        this.log(
          `connect: auto-compacted at ${Math.round(pct)}% (threshold ${this.autoCompactThresholdPct}%)`,
        );
        // The measured usage is now stale — it describes the pre-compaction
        // session, and leaving it would make the next turn's report claim the
        // window is still full.
        this.lastContextSize = undefined;
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.log(`connect: auto-compaction failed: ${detail}`);
      await this.adapter
        .sendText(this.target(msg), this.t.compactFailed(truncate(detail)))
        .catch(() => undefined);
    }
  }

  /**
   * Run DSH's compaction service against an idle agent.
   * @returns `compacted`, `nothing` (nothing to compact), or `unavailable`.
   */
  private async runCompaction(agent: Agent): Promise<"compacted" | "nothing" | "unavailable"> {
    const presets = this.ctx.get("agentPresets") as
      | {
          serviceFor?: (
            agent: { ctx: unknown },
            name: string,
          ) => { compactNow?: (a: unknown, signal: AbortSignal) => Promise<unknown> } | undefined;
        }
      | undefined;
    const compaction = presets?.serviceFor?.(agent, "compaction");
    if (compaction?.compactNow === undefined) return "unavailable";
    const result = await compaction.compactNow(agent, new AbortController().signal);
    return result === null ? "nothing" : "compacted";
  }

  /**
   * When the current stretch of work began, kept on the runner rather than only on
   * the turn object.
   *
   * The turn is discarded when `driveAgent` returns, but the agent can still be
   * busy — and the progress reminder needs an elapsed time it can trust even then.
   * Without this the fallback could only guess, and a reminder that reports the
   * wrong duration is worse than one that admits it has none.
   */
  private workStartedAt?: number;
  /** Latest milestone, mirrored off the turn so a reminder can report it after turn state is gone. */
  private lastMilestone?: string;
  /** Latest observed context usage, kept across turns so auto-compaction has a measurement. */
  private lastContextSize?: number;
  /** Latest observed context window, kept across turns so auto-compaction has a measurement. */
  private lastContextWindow?: number;

  async compact(target: OutboundTarget): Promise<void> {
    const agent = this.agent;
    if (agent === undefined) {
      await this.adapter.sendText(target, this.t.noActiveSessionCompact);
      return;
    }
    if (agent.status !== "idle") {
      await this.adapter.sendText(target, this.t.sessionRunning);
      return;
    }
    try {
      // Compaction can take a while — tell the user it started, then report the outcome.
      await this.adapter.sendText(target, this.t.compactStarted);
      // Shares the service lookup with auto-compaction, so the manual and
      // automatic paths can never disagree about whether compaction exists.
      const outcome = await this.runCompaction(agent);
      if (outcome === "unavailable") {
        await this.adapter.sendText(target, this.t.compactionUnavailable);
      } else if (outcome === "nothing") {
        await this.adapter.sendText(target, this.t.nothingToCompact);
      } else {
        // The measurement describes the pre-compaction session; drop it so the
        // next stats card does not report a window that was just freed.
        this.lastContextSize = undefined;
        await this.adapter.sendText(target, this.t.compactDone);
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      await this.adapter.sendText(target, this.t.compactFailed(truncate(msg)));
    }
  }

  async showHistory(target: OutboundTarget, limit: number): Promise<void> {
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
    const events = agent.session.snapshotEvents();
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

  async showGoals(target: OutboundTarget): Promise<void> {
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
    return goalPhaseLabel(phase, this.t);
  }

  async showSchedule(target: OutboundTarget): Promise<void> {
    // Agent-level reminders (session `schedule` tool) + persistent chat-level
    // reminders (`/remind`), merged into one list.
    const agentReminders = this.agent === undefined ? [] : foldReminders(this.agent.session.snapshotEvents());
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
    const events = agent.session.snapshotEvents();
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
