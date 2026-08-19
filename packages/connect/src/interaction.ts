/**
 * Interactive user-choices and permission approvals bridged into the chat
 * channel (Feishu first).
 *
 * DSH's host api-proxy owns the single `userQuestions` provider and the
 * `approval/request` waterfall, so a channel plugin cannot register a second
 * answerer. Instead this bridge acts as an in-process client of the host's
 * `ctx.apiProxy`: it subscribes to the same mux stream the Web GUI uses,
 * watches for `question/requested` and `approval/requested` frames on
 * connect-bound sessions, renders them as chat cards with buttons, and feeds
 * the user's answer back through `apiProxy.respond` — the exact same path a
 * Web client uses. The Web GUI stays fully functional; whoever answers first
 * wins.
 *
 * Everything is best-effort: when the host api-proxy is absent (e.g. a
 * headless host), the bridge is a no-op and the current behavior (question
 * pending until a Web client answers) is unchanged.
 * @module dsh-connect/interaction
 */
import type { Context } from "@deepseek-ai/cordis";
import type { ChannelAdapter, ChoiceOption, ChoicePrompt, OutboundTarget } from "./types.js";
import type { BindingStore, ChatBinding } from "./binding.js";
import { messages, type Language, type Messages } from "./i18n.js";
import type { ResolvedConnectConfig } from "./runner.js";

/** One question from a `question/requested` mux frame (loosely typed). */
export interface AskQuestionLike {
  id: string;
  question: string;
  header?: string;
  detail?: string;
  options?: { label: string; description?: string }[];
  multiSelect?: boolean;
}

/** Loose face of the host's `ctx.apiProxy` service (no hard dependency). */
interface ApiProxyLike {
  events?: {
    mux?: (request: unknown, signal: AbortSignal) => AsyncIterable<{ rpcId: string; payload: Record<string, unknown> }>;
  };
  respond?: (message: unknown, signal?: AbortSignal) => Promise<{ accepted?: boolean }>;
}

interface PendingBase {
  kind: "question" | "approval";
  chatKey: string;
  chatType: "p2p" | "group";
  adapter: ChannelAdapter;
  sessionId: string;
  rpcId: string;
  language: Language;
  messageId?: string;
  controller: AbortController;
  settled: boolean;
}

interface PendingQuestion extends PendingBase {
  kind: "question";
  questions: AskQuestionLike[];
  answers: Map<string, { selected: string[]; custom?: string }>;
  current: number;
}

interface PendingApproval extends PendingBase {
  kind: "approval";
  approvalId: string;
  toolName: string;
  reason?: string;
}

type PendingInteraction = PendingQuestion | PendingApproval;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Decode a free-text chat reply into the answer for one question. Exact label
 * match wins; otherwise space/comma separated numbers are mapped onto the
 * options (multi-select accumulates them); anything else becomes free text.
 */
export function decodeTextAnswer(q: AskQuestionLike, text: string): { selected: string[]; custom?: string } {
  const opts = q.options ?? [];
  const trimmed = text.trim();
  if (opts.length === 0) return { selected: [], custom: trimmed };
  const exact = opts.findIndex((o) => o.label === trimmed);
  if (exact !== -1) return { selected: [opts[exact].label] };
  const parts = trimmed
    .split(/[,，、;；\s]+/)
    .map((s) => s.trim())
    .filter((s) => s !== "");
  const labels = [...new Set(parts.filter((p) => opts.some((o) => o.label === p)))];
  const nums = parts.map((p) => Number(p)).filter((n) => Number.isInteger(n) && n >= 1 && n <= opts.length);
  const picked = q.multiSelect
    ? [...new Set([...labels, ...nums.map((n) => opts[n - 1].label)])]
    : [...new Set([...labels, ...(nums.length > 0 ? [opts[nums[0] - 1].label] : [])])].slice(0, 1);
  if (picked.length > 0) return { selected: picked };
  return { selected: [], custom: trimmed };
}

/** Decode a button choice (`q:<questionId>:<optionIndex>`) back into an answer. */
function decodeChoice(q: AskQuestionLike, choice: string): { selected: string[]; custom?: string } | undefined {
  const prefix = `q:${q.id}:`;
  if (!choice.startsWith(prefix)) return undefined;
  const idx = Number(choice.slice(prefix.length));
  const opt = q.options?.[idx];
  if (opt === undefined) return undefined;
  return { selected: [opt.label] };
}

/**
 * Bridge user choices and permission approvals from DSH into the chat channel.
 * Subscribes once to the host mux stream; frames for connect-bound sessions are
 * rendered as interactive cards and answered via `apiProxy.respond`.
 */
export class InteractionBridge {
  private readonly pending = new Map<string, PendingInteraction>();
  private started = false;
  private apiProxy?: ApiProxyLike;
  private controller?: AbortController;

  constructor(
    private readonly ctx: Context,
    private readonly adapters: ReadonlyMap<string, ChannelAdapter>,
    private readonly bindings: BindingStore,
    private readonly config: ResolvedConnectConfig,
  ) {
    this.ctx.effect(() => () => this.controller?.abort(), "connect: interaction bridge");
  }

  /** Open the mux subscription (idempotent). No-op when the host api-proxy is absent. */
  start(): void {
    if (this.started) return;
    const apiProxy = this.ctx.get("apiProxy") as ApiProxyLike | undefined;
    if (apiProxy?.events?.mux === undefined || apiProxy.respond === undefined) return;
    this.started = true;
    this.apiProxy = apiProxy;
    this.controller = new AbortController();
    void this.run(this.controller.signal);
  }

  /** Whether a question/approval is waiting on an answer in this chat. */
  pendingFor(chatKey: string): boolean {
    return this.pending.has(chatKey);
  }

  /** Deliver a plain-text chat reply as the answer to the pending question. */
  answerText(chatKey: string, text: string): boolean {
    const p = this.pending.get(chatKey);
    if (p === undefined || p.kind !== "question") return false;
    const q = p.questions[p.current];
    if (q === undefined) return false;
    const answer = decodeTextAnswer(q, text);
    if (answer.selected.length === 0 && (answer.custom === undefined || answer.custom.trim() === "")) return false;
    this.recordAnswer(p, q.id, answer);
    return true;
  }

  private async run(signal: AbortSignal): Promise<void> {
    const stream = this.apiProxy!.events!.mux!({ rpcId: "connect-interaction", payload: {} }, signal);
    try {
      for await (const { rpcId, payload } of stream) {
        try {
          this.onFrame(rpcId, payload);
        } catch (error) {
          this.log(`connect: interaction frame handler error: ${String(error)}`);
        }
      }
    } catch (error) {
      this.log(`connect: interaction mux stream closed: ${String(error)}`);
    }
  }

  private onFrame(rpcId: string, payload: Record<string, unknown>): void {
    switch (payload.type) {
      case "question/requested": {
        const sessionId = String(payload.sessionId ?? "");
        const questions = Array.isArray(payload.questions) ? (payload.questions as AskQuestionLike[]) : [];
        if (sessionId === "" || questions.length === 0) return;
        for (const target of this.targetsFor(sessionId)) {
          this.presentQuestion(target, rpcId, sessionId, questions);
        }
        break;
      }
      case "approval/requested": {
        const sessionId = String(payload.sessionId ?? "");
        const approvalId = String(payload.approvalId ?? "");
        if (sessionId === "" || approvalId === "") return;
        const toolName = String(payload.toolName ?? "?");
        const reason = typeof payload.reason === "string" ? payload.reason : undefined;
        for (const target of this.targetsFor(sessionId)) {
          this.presentApproval(target, rpcId, sessionId, approvalId, toolName, reason);
        }
        break;
      }
      case "question/resolved": {
        // Someone (Web GUI or this bridge) answered/cancelled the ask.
        const questionRpcId = String(payload.questionRpcId ?? "");
        for (const p of [...this.pending.values()]) {
          if (p.kind === "question" && p.rpcId === questionRpcId) this.settle(p);
        }
        break;
      }
      case "session/event": {
        const event = payload.event as { type?: string } | undefined;
        if (event?.type !== "turn/end") return;
        const sessionId = String(payload.sessionId ?? "");
        for (const p of [...this.pending.values()]) {
          if (p.sessionId === sessionId) this.settle(p);
        }
        break;
      }
      default:
        break;
    }
  }

  /** Every connect-bound chat that currently uses this session (active or mirrored). */
  private targetsFor(sessionId: string): { binding: ChatBinding; adapter: ChannelAdapter }[] {
    const out: { binding: ChatBinding; adapter: ChannelAdapter }[] = [];
    for (const binding of this.bindings.list()) {
      if (binding.sessionId !== sessionId && binding.webMirrorSessionId !== sessionId) continue;
      const adapter = this.adapters.get(binding.channel);
      if (adapter === undefined) continue;
      out.push({ binding, adapter });
    }
    return out;
  }

  private presentQuestion(
    target: { binding: ChatBinding; adapter: ChannelAdapter },
    rpcId: string,
    sessionId: string,
    questions: AskQuestionLike[],
  ): void {
    // One pending ask per session — a replayed frame after the mux reopens
    // must not stack duplicate cards.
    for (const p of this.pending.values()) {
      if (p.sessionId === sessionId) return;
    }
    const interaction: PendingQuestion = {
      kind: "question",
      chatKey: target.binding.chatKey,
      chatType: target.binding.chatType,
      adapter: target.adapter,
      sessionId,
      rpcId,
      language: target.binding.language ?? this.config.language,
      questions,
      answers: new Map(),
      current: 0,
      controller: new AbortController(),
      settled: false,
    };
    this.pending.set(interaction.chatKey, interaction);
    this.stepQuestion(interaction);
  }

  private presentApproval(
    target: { binding: ChatBinding; adapter: ChannelAdapter },
    rpcId: string,
    sessionId: string,
    approvalId: string,
    toolName: string,
    reason: string | undefined,
  ): void {
    for (const p of this.pending.values()) {
      if (p.sessionId === sessionId) return;
    }
    const interaction: PendingApproval = {
      kind: "approval",
      chatKey: target.binding.chatKey,
      chatType: target.binding.chatType,
      adapter: target.adapter,
      sessionId,
      rpcId,
      approvalId,
      toolName,
      ...(reason === undefined ? {} : { reason }),
      language: target.binding.language ?? this.config.language,
      controller: new AbortController(),
      settled: false,
    };
    this.pending.set(interaction.chatKey, interaction);
    void this.presentApprovalLoop(interaction);
  }

  /** Advance to the next unanswered question, or settle once all are answered. */
  private stepQuestion(interaction: PendingQuestion): void {
    while (
      interaction.current < interaction.questions.length &&
      interaction.answers.has(interaction.questions[interaction.current].id)
    ) {
      interaction.current += 1;
    }
    if (interaction.current >= interaction.questions.length) {
      void this.settleQuestion(interaction);
      return;
    }
    const q = interaction.questions[interaction.current];
    const hasOptions = Array.isArray(q.options) && q.options.length > 0;
    if (hasOptions) {
      void this.presentQuestionButtons(interaction, q);
    } else {
      void this.presentQuestionText(interaction, q);
    }
  }

  private async presentQuestionButtons(interaction: PendingQuestion, q: AskQuestionLike): Promise<void> {
    const t = messages(interaction.language);
    const options: ChoiceOption[] = (q.options ?? []).map((o, i) => ({
      id: `q:${q.id}:${i}`,
      label: o.label,
    }));
    const prompt: ChoicePrompt = {
      title: t.questionCardTitle,
      description: this.questionPromptText(interaction, q),
      options,
      footer: q.multiSelect === true ? `${t.questionCardHint}\n${t.questionMultiHint}` : t.questionCardHint,
    };
    // One answered question steps the interaction to the next one; settling is
    // the flow's job (stepQuestion → settleQuestion), not this loop's.
    await this.presentLoop(interaction, prompt, (choice) => {
      if (choice === undefined) return undefined;
      const answer = decodeChoice(q, choice);
      if (answer === undefined) return undefined;
      this.recordAnswer(interaction, q.id, answer);
      return "answered";
    });
  }

  private async presentQuestionText(interaction: PendingQuestion, q: AskQuestionLike): Promise<void> {
    const t = messages(interaction.language);
    const target = this.outbound(interaction);
    await interaction.adapter.sendText(target, t.questionTextHint(q.question)).catch(() => undefined);
    while (!interaction.controller.signal.aborted && !interaction.settled) {
      if (interaction.answers.has(q.id)) return;
      await delay(60_000);
      if (interaction.controller.signal.aborted || interaction.settled || interaction.answers.has(q.id)) return;
      await interaction.adapter.sendText(target, t.questionWaiting(q.question)).catch(() => undefined);
    }
  }

  private async presentApprovalLoop(interaction: PendingApproval): Promise<void> {
    const t = messages(interaction.language);
    const prompt: ChoicePrompt = {
      title: t.approvalCardTitle,
      description: t.approvalAsk(interaction.toolName, interaction.reason),
      options: [
        { id: "approval:allow", label: t.approveLabel },
        { id: "approval:reject", label: t.rejectLabel },
      ],
    };
    const result = await this.presentLoop(interaction, prompt, async (choice, messageId) => {
      if (choice !== "approval:allow" && choice !== "approval:reject") return undefined;
      const outcome = choice === "approval:allow" ? "allowed-once" : "rejected";
      // Submit the decision through the host respond path and wait for the
      // verdict — this is what tells the user whether their tap actually took
      // effect (the Web GUI may have answered first, or the request expired).
      const accepted = await this.respond(interaction.rpcId, {
        sessionId: interaction.sessionId,
        approvalId: interaction.approvalId,
        outcome,
      });
      if (accepted) {
        // Replace the buttons with a clear "done" state so the user sees the
        // decision landed even if the chat keeps streaming afterwards.
        await interaction.adapter
          .closeMenu(messageId, t.approvalDone(outcome, interaction.toolName))
          .catch(() => undefined);
      } else {
        // Not accepted: the approval was already handled elsewhere, or is
        // stale. Say so explicitly instead of silently ignoring the tap.
        await interaction.adapter
          .closeMenu(messageId, t.approvalStale)
          .catch(() => undefined);
        await interaction.adapter
          .sendText(this.outbound(interaction), t.approvalStale)
          .catch(() => undefined);
      }
      return "answered";
    });
    if (result === "answered") this.settle(interaction);
  }

  /**
   * Keep one interactive card alive until the user answers (or the ask is
   * cancelled). The channel's choice prompt expires after its own idle
   * timeout; on expiry the same card is re-presented in place so the choice
   * stays clickable for as long as the agent waits. Resolves `"answered"`
   * when `onChoice` accepted a choice, `"stopped"` otherwise.
   *
   * `onChoice` may be async and receives the card's message id (for feedback
   * such as updating the card once the decision is delivered). A thrown
   * `onChoice` error resolves the loop as `"stopped"` (best-effort channel).
   */
  private async presentLoop(
    interaction: PendingInteraction,
    prompt: ChoicePrompt,
    onChoice: (choice: string | undefined, messageId: string) => "answered" | undefined | Promise<"answered" | undefined>,
  ): Promise<"answered" | "stopped"> {
    while (!interaction.controller.signal.aborted && !interaction.settled) {
      try {
        const { choice, messageId } = await interaction.adapter.promptChoice(
          this.outbound(interaction),
          prompt,
          interaction.messageId,
        );
        interaction.messageId = messageId;
        if ((await onChoice(choice, messageId)) === "answered") return "answered";
      } catch {
        return "stopped";
      }
      await delay(1200);
    }
    return "stopped";
  }

  private questionPromptText(interaction: PendingQuestion, q: AskQuestionLike): string {
    const t = messages(interaction.language);
    const total = interaction.questions.length;
    const prefix = total > 1 ? `${t.questionStep(interaction.current + 1, total)}\n` : "";
    const header = q.header === undefined || q.header === "" ? "" : `**${q.header}**\n`;
    const detail = q.detail === undefined || q.detail === "" ? "" : `\n${q.detail}`;
    const multi = q.multiSelect === true ? `\n${t.questionMultiHint}` : "";
    return `${prefix}${header}${q.question}${detail}${multi}`;
  }

  private recordAnswer(interaction: PendingQuestion, qid: string, answer: { selected: string[]; custom?: string }): void {
    if (interaction.answers.has(qid)) return;
    interaction.answers.set(qid, answer);
    this.stepQuestion(interaction);
  }

  /** All questions answered — deliver the answers through the host respond path. */
  private async settleQuestion(interaction: PendingQuestion): Promise<void> {
    if (interaction.settled) return;
    interaction.settled = true;
    const answers = interaction.questions.map((q) => {
      const a = interaction.answers.get(q.id);
      return {
        id: q.id,
        selected: a?.selected ?? [],
        ...(a?.custom !== undefined && a.custom.trim() !== "" ? { custom: a.custom.trim() } : {}),
      };
    });
    const accepted = await this.respond(interaction.rpcId, {
      sessionId: interaction.sessionId,
      answer: { answers },
    });
    const t = messages(interaction.language);
    if (accepted) {
      await interaction.adapter.sendText(this.outbound(interaction), t.answerReceived).catch(() => undefined);
    } else {
      // The host did not accept the answers (already answered elsewhere, or
      // the question expired) — tell the user their reply had no effect.
      await interaction.adapter.sendText(this.outbound(interaction), t.questionStale).catch(() => undefined);
    }
    this.settle(interaction);
  }

  private async respond(rpcId: string, value: unknown): Promise<boolean> {
    if (this.apiProxy?.respond === undefined) return false;
    try {
      const res = await this.apiProxy.respond({
        type: "client-response",
        rpcId,
        result: { ok: true, value },
      });
      return res?.accepted === true;
    } catch (error) {
      this.log(`connect: interaction respond failed: ${String(error)}`);
      return false;
    }
  }

  /** Stop presenting and drop the interaction (answered, cancelled, or the turn ended). */
  private settle(interaction: PendingInteraction): void {
    if (this.pending.get(interaction.chatKey) === interaction) this.pending.delete(interaction.chatKey);
    interaction.settled = true;
    interaction.controller.abort();
  }

  private outbound(p: { chatKey: string; chatType: "p2p" | "group" }): OutboundTarget {
    return { chatKey: p.chatKey, chatType: p.chatType };
  }

  private log(message: string): void {
    (this.ctx.get("logger") as { info?: (...args: unknown[]) => void } | undefined)?.info?.(message);
  }
}
