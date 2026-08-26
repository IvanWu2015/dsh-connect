/**
 * Streaming helpers for `dsh-connect`.
 * @module dsh-connect/stream
 */
import type { SessionEvent } from "@deepseek-ai/dsh-session";
import type { TurnOutcome, TurnReason } from "./types.js";
import type { AsyncQueue } from "./types.js";

export function createAsyncQueue<T>(): AsyncQueue<T> {
  const buffer: T[] = [];
  let waiter: (() => void) | undefined;
  let ended = false;

  const wake = () => {
    waiter?.();
    waiter = undefined;
  };

  const queue: AsyncQueue<T> = {
    push(value) {
      if (ended) return;
      buffer.push(value);
      wake();
    },
    end() {
      if (ended) return;
      ended = true;
      wake();
    },
    async *[Symbol.asyncIterator]() {
      for (;;) {
        if (buffer.length > 0) {
          yield buffer.shift() as T;
          continue;
        }
        if (ended) return;
        await new Promise<void>((resolve) => {
          waiter = resolve;
        });
      }
    },
  };

  return queue;
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

export function mapReason(kind: string): TurnReason {
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

export function truncate(text: string, max = 500): string {
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
export function fmtTokens(n: number): string {
  return n.toLocaleString("en-US");
}

export function textOf(message: { content: readonly { type?: string; text?: string }[] } | undefined): string {
  if (message === undefined) return "";
  return message.content
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text ?? "")
    .join("");
}

