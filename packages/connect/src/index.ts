/**
 * `dsh-connect` — channel-agnostic messaging bridge core for DeepSeek Harness.
 * Provides the `connect` service; channel adapters register into it and route
 * normalized messages to bound DSH agents, then stream replies back.
 * @module dsh-connect
 */
import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { ConnectService } from "./service.js";
import type { ConnectConfig } from "./runner.js";

export { ConnectService } from "./service.js";
export { AgentRunner, resolveConnectConfig } from "./runner.js";
export type { ConnectConfig, ResolvedConnectConfig } from "./runner.js";
export { applyStreamChunk, applyToolCall, classifyError, questionTextOf, summarizeTurn, toolCallSummary } from "./stream.js";
export type { ErrorCategory, NotifyLevel, StreamChunkLike, StreamState } from "./stream.js";
export { InteractionBridge, decodeTextAnswer } from "./interaction.js";
export type { AskQuestionLike } from "./interaction.js";
export { BindingStore } from "./binding.js";
export type { ChatBinding, ChatSessionRecord } from "./binding.js";
export { createAsyncQueue } from "./stream.js";
export { menuTitle, rootMenuSections, reasonLabel, goalPhaseLabel, listWorkspaces } from "./menus.js";
export type { MenuId, MenuItem } from "./menus.js";
export { InboundDedup } from "./dedup.js";
export { retry, withOutboundRetry } from "./retry.js";
export type { RetryOptions } from "./retry.js";
export { acquire as acquireLock, canWrite as lockCanWrite, isLockTimedOut, release as releaseLockState, DEFAULT_LOCK_TIMEOUT_MS } from "./mirror-lock.js";
export type { LockState, QueuedMessage } from "./mirror-lock.js";
export { ReminderStore, formatRemindAt, parseRemindTime } from "./scheduler.js";
export type { ScheduledReminder } from "./scheduler.js";
export { parseCommand, helpText } from "./commands.js";
export type { Command } from "./commands.js";
export { messages } from "./i18n.js";
export type { Language, Messages } from "./i18n.js";
export type {
  ChatType,
  ChoiceOption,
  ChoicePrompt,
  ChoiceResult,
  InboundMessage,
  OutboundTarget,
  SummaryCard,
  TurnReason,
  TurnOutcome,
  AsyncQueue,
  ChannelAdapter,
} from "./types.js";

/** Cordis plugin name used by loader diagnostics. */
export const name = "connect";

/** Host-plane services this plugin requires before it can route messages. */
export const inject = ["agents", "sessions", "agentDefaultModel"];

/** Plugin config; all fields optional — `apply` fills code defaults. */
export const Config = z.object({
  /** Agent preset id composed into each bound session; omit for the roster default. */
  agentPreset: z.string(),
  /** Absolute working directory per agent; defaults to the process cwd. */
  workDir: z.string(),
  /** Optional workspace directories offered by the `/dir` chooser. */
  workspaces: z.array(z.string()),
  /** Vision-capable model used to describe images when the main model can't see them. */
  visionModel: z.object({ provider: z.string(), model: z.string() }),
  /** User-facing message language: `zh` (default) or `en`. */
  language: z.union([z.const("zh"), z.const("en")]),
  /** Sender allowlist; empty = all senders allowed. */
  allowUsers: z.array(z.string()),
  /** Chat allowlist; empty = all chats allowed. */
  allowChats: z.array(z.string()),
  /** Directory for the bindings.json routing store. */
  stateDir: z.string(),
  /** Automatically create a Web mirror for new sessions (default: true). */
  autoMirror: z.boolean(),
  /** Liveness heartbeat interval ms for the streaming card; 0 disables it (default: 60000). */
  streamHeartbeatMs: z.number(),
  /** Default notification level for streaming replies (default: `important`). */
  notifyLevel: z.union([z.const("full"), z.const("important"), z.const("result")]),
  /** Proactive progress-notice interval ms when a turn stays silent (default: 300000 = 5 min; 0 disables). */
  progressTimeoutMs: z.number(),
});

declare module "@deepseek-ai/cordis" {
  interface Context {
    connect: ConnectService;
  }
}

/** Register the `connect` service; adapters resolve it via `inject: ["connect"]`. */
export function apply(ctx: Context, config: ConnectConfig | null = {}): void {
  // The DSH loader passes `null` for entries without an explicit config
  // (and does not run schema coercion on this path), so treat it as empty.
  void new ConnectService(ctx, config ?? {});
}

export default ConnectService;
