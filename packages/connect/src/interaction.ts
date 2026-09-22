/**
 * Interactive user-choices and permission approvals bridged into the chat
 * channel (Feishu first).
 *
 * DSH exposes both as cordis **waterfall** events on the calling agent's scope:
 *
 *   `user-questions/request` — request `{ questions, agent?, signal? }`,
 *     result `{ answers: [{ id, selected, custom? }] }`
 *   `approval/request` — request `{ agent, toolName, callId?, reason?, signal? }`,
 *     result `'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'`
 *
 * A listener that *returns a value* answers the request; calling `next()` hands
 * it to the following listener (the host's Web-GUI forwarder, and ultimately
 * the fail-closed default). So this bridge is a genuine answerer, not a client
 * of something else: it used to subscribe to the host's `apiProxy` mux stream,
 * but no such host service exists, and every question silently fell through —
 * which is why a chat user saw no options at all.
 *
 * Two properties of the dispatch shape the registration:
 *
 * - Listeners are registered with `prepend: true`. The host's api-remotes
 *   plugin registers its own forwarder on these events and *parks* the
 *   waterfall on it while it waits for a Web client to answer; with no browser
 *   tab connected that promise never settles, so a listener registered after it
 *   would never run at all. Going first is the only placement that always runs.
 * - The listener is registered on the plugin's own unscoped context, which
 *   `scopeTarget` admits to every scoped dispatch. `request.agent.id` is what
 *   decides whether one of *our* chats owns the session.
 *
 * Everything stays best-effort: whenever no binding matches, the prompt cannot
 * be delivered, or the request is cancelled, the listener calls `next()` and
 * the host's normal path (Web GUI, then fail-closed) takes over.
 * @module dsh-connect/interaction
 */
import type { Context } from "@deepseek-ai/cordis";
import type { ChannelAdapter, ChoiceOption, ChoicePrompt, OutboundTarget } from "./types.js";
import type { BindingStore, ChatBinding } from "./binding.js";
import { messages, type Language } from "./i18n.js";
import type { ResolvedConnectConfig } from "./runner.js";

/** One question from a `user-questions/request` dispatch. */
export interface AskQuestionLike {
  id: string;
  question: string;
  header?: string;
  detail?: string;
  options?: { label: string; description?: string }[];
  multiSelect?: boolean;
}

/** One answer as the host expects it. */
interface AskAnswerItem {
  id: string;
  selected: string[];
  custom?: string;
}

/** An answer for one question, before it is tagged with that question's id. */
type AskAnswerValue = Omit<AskAnswerItem, "id">;

/** Result of a `user-questions/request` waterfall. */
export interface AskAnswer {
  answers: AskAnswerItem[];
}

/** Payload of a `user-questions/request` waterfall. */
export interface AskRequestEvent {
  questions: AskQuestionLike[];
  agent?: { id?: string };
  signal?: AbortSignal;
}

/** Result of an `approval/request` waterfall. */
export type ApprovalOutcome = "allowed-once" | "rejected" | "cancelled" | "unavailable";

/** Payload of an `approval/request` waterfall. */
export interface ApprovalRequestEvent {
  readonly agent?: { id?: string };
  readonly toolName: string;
  readonly callId?: string;
  readonly reason?: string;
  readonly signal?: AbortSignal;
}

/**
 * Structural seam over the host's event bus.
 *
 * The host event names are declared by the host packages via `declare module
 * '@deepseek-ai/cordis'`, so they only typecheck when the host's own `.d.ts`
 * files are in the program. This package compiles standalone, and cordis'
 * `Events` interface has no index signature — hence one local structural face
 * plus a single cast in the constructor, rather than augmenting global state
 * that a host build could then collide with.
 */
interface EventSeam {
  on<TRequest, TResult>(
    name: string,
    listener: (request: TRequest, next: () => Promise<TResult>) => Promise<TResult>,
    options?: { prepend?: boolean },
  ): () => void;
}

interface PendingBase {
  kind: "question" | "approval";
  chatKey: string;
  chatType: "p2p" | "group";
  adapter: ChannelAdapter;
  sessionId: string;
  language: Language;
  messageId?: string;
  controller: AbortController;
  settled: boolean;
}

interface PendingQuestion extends PendingBase {
  kind: "question";
  questions: AskQuestionLike[];
  /** Keyed by question id, so the values carry no id of their own. */
  answers: Map<string, AskAnswerValue>;
  current: number;
  /**
   * Woken whenever an answer is recorded, so a text-reply flow can stop
   * waiting the moment the user's message lands (instead of polling).
   */
  waiters: Set<() => void>;
}

interface PendingApproval extends PendingBase {
  kind: "approval";
  toolName: string;
  reason?: string;
}

type PendingInteraction = PendingQuestion | PendingApproval;

/** How one interactive prompt loop ended. */
type LoopResult = "answered" | "stopped";

/** How a wait for a text answer ended. */
type WaitResult = "answered" | "timeout" | "stopped";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Whether the host has already given up on a request (its signal fired).
 * A free function on purpose: reading `req.signal?.aborted` directly and
 * re-checking it later would be narrowed away by the first check's early
 * return, even though the signal can fire across an `await`.
 */
function hostCancelled(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/**
 * Decode a free-text chat reply into the answer for one question. Exact label
 * match wins; otherwise space/comma separated numbers are mapped onto the
 * options (multi-select accumulates them); anything else becomes free text.
 */
export function decodeTextAnswer(q: AskQuestionLike, text: string): AskAnswerValue {
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
 * Answer the host's user-question and approval waterfalls from the chat
 * channel. Registered once, eagerly, at construction time.
 */
export class InteractionBridge {
  private readonly pending = new Map<string, PendingInteraction>();

  constructor(
    private readonly ctx: Context,
    private readonly adapters: ReadonlyMap<string, ChannelAdapter>,
    private readonly bindings: BindingStore,
    private readonly config: ResolvedConnectConfig,
  ) {
    const seam = ctx as unknown as EventSeam;
    ctx.effect(
      () => this.register(seam, "user-questions/request", this.answerQuestion.bind(this)),
      "connect: user-questions answerer",
    );
    ctx.effect(
      () => this.register(seam, "approval/request", this.answerApproval.bind(this)),
      "connect: approval answerer",
    );
    ctx.effect(
      () => () => {
        // Teardown: unblock every in-flight card so its loop unwinds.
        for (const p of [...this.pending.values()]) this.settle(p);
      },
      "connect: interaction bridge",
    );
  }

  /** Register one waterfall listener, tolerating a host without the event API. */
  private register<TRequest, TResult>(
    seam: EventSeam,
    name: string,
    listener: (request: TRequest, next: () => Promise<TResult>) => Promise<TResult>,
  ): () => void {
    try {
      return seam.on<TRequest, TResult>(name, listener, { prepend: true });
    } catch (error) {
      this.log(`connect: could not register the "${name}" answerer: ${String(error)}`);
      return () => undefined;
    }
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

  // ── user-questions/request ─────────────────────────────────────────────────

  private async answerQuestion(req: AskRequestEvent, next: () => Promise<AskAnswer>): Promise<AskAnswer> {
    const questions = Array.isArray(req.questions) ? req.questions : [];
    const sessionId = req.agent?.id;
    if (sessionId === undefined || sessionId === "" || questions.length === 0) return next();
    if (hostCancelled(req.signal)) return next();
    const target = this.claimTarget(sessionId);
    if (target === undefined) return next();

    const interaction: PendingQuestion = {
      kind: "question",
      chatKey: target.binding.chatKey,
      chatType: target.binding.chatType,
      adapter: target.adapter,
      sessionId,
      language: target.binding.language ?? this.config.language,
      questions,
      answers: new Map(),
      current: 0,
      waiters: new Set(),
      controller: new AbortController(),
      settled: false,
    };
    this.pending.set(interaction.chatKey, interaction);
    const onAbort = (): void => this.settle(interaction);
    req.signal?.addEventListener("abort", onAbort, { once: true });

    try {
      const answers = await this.runQuestions(interaction);
      if (answers === undefined) return next();
      const t = messages(interaction.language);
      await interaction.adapter.sendText(this.outbound(interaction), t.answerReceived).catch(() => undefined);
      this.log(`connect: answered ${answers.length} question(s) from ${interaction.chatKey}`);
      return { answers };
    } catch (error) {
      // The card could not be delivered (or the channel errored): hand the
      // request back so the Web GUI — or the host's fail-closed default — gets it.
      this.log(`connect: question presentation failed (${interaction.chatKey}): ${String(error)}`);
      return next();
    } finally {
      req.signal?.removeEventListener("abort", onAbort);
      this.settle(interaction);
    }
  }

  /** Ask every question in turn. `undefined` = the flow was interrupted. */
  private async runQuestions(interaction: PendingQuestion): Promise<AskAnswerItem[] | undefined> {
    for (let i = 0; i < interaction.questions.length; i += 1) {
      interaction.current = i;
      const q = interaction.questions[i];
      if (interaction.answers.has(q.id)) continue;
      const answered = await this.askOne(interaction, q);
      if (!answered) return undefined;
    }
    return interaction.questions.map((q) => {
      const a = interaction.answers.get(q.id);
      const custom = a?.custom?.trim();
      return {
        id: q.id,
        selected: a?.selected ?? [],
        ...(custom === undefined || custom === "" ? {} : { custom }),
      };
    });
  }

  private async askOne(interaction: PendingQuestion, q: AskQuestionLike): Promise<boolean> {
    const options = Array.isArray(q.options) ? q.options : [];
    if (options.length === 0) return this.askByText(interaction, q);

    const t = messages(interaction.language);
    const prompt: ChoicePrompt = {
      title: t.questionCardTitle,
      description: this.questionPromptText(interaction, q),
      options: options.map((o, i): ChoiceOption => ({ id: `q:${q.id}:${i}`, label: o.label })),
      footer: q.multiSelect === true ? `${t.questionCardHint}\n${t.questionMultiHint}` : t.questionCardHint,
    };

    while (!interaction.controller.signal.aborted && !interaction.settled) {
      const { choice, messageId } = await interaction.adapter.promptChoice(
        this.outbound(interaction),
        prompt,
        interaction.messageId,
        interaction.controller.signal,
      );
      // An adapter aborted before presenting has no card to point at; keep the
      // last real id so the next round still targets the right message.
      if (messageId !== "") interaction.messageId = messageId;
      if (choice !== undefined) {
        const answer = decodeChoice(q, choice);
        if (answer !== undefined) {
          this.recordAnswer(interaction, q.id, answer);
          return true;
        }
        continue;
      }
      // The card expired without a tap. Re-present the same card in place so
      // the choice stays clickable for as long as the agent is waiting.
      if (interaction.controller.signal.aborted || interaction.settled) break;
      await delay(1000);
    }
    return false;
  }

  /** Options-free question: the user answers by sending an ordinary message. */
  private async askByText(interaction: PendingQuestion, q: AskQuestionLike): Promise<boolean> {
    const t = messages(interaction.language);
    const target = this.outbound(interaction);
    await interaction.adapter.sendText(target, t.questionTextHint(q.question)).catch(() => undefined);
    while (!interaction.controller.signal.aborted && !interaction.settled) {
      if (interaction.answers.has(q.id)) return true;
      const waited = await this.waitForAnswer(interaction, 60_000);
      if (waited === "answered") return true;
      if (waited === "stopped") return false;
      await interaction.adapter.sendText(target, t.questionWaiting(q.question)).catch(() => undefined);
    }
    return false;
  }

  /**
   * Wait until an answer is recorded, the flow stops, or `timeoutMs` elapses.
   * Resolves (never rejects) and always removes its own listener and timer.
   */
  private waitForAnswer(interaction: PendingQuestion, timeoutMs: number): Promise<WaitResult> {
    return new Promise<WaitResult>((resolve) => {
      let done = false;
      let timer: NodeJS.Timeout | undefined;
      const finish = (result: WaitResult): void => {
        if (done) return;
        done = true;
        if (timer !== undefined) clearTimeout(timer);
        interaction.waiters.delete(onWake);
        interaction.controller.signal.removeEventListener("abort", onStop);
        resolve(result);
      };
      const onWake = (): void => finish("answered");
      const onStop = (): void => finish("stopped");
      interaction.waiters.add(onWake);
      interaction.controller.signal.addEventListener("abort", onStop, { once: true });
      timer = setTimeout(() => finish("timeout"), timeoutMs);
      timer.unref?.();
      // The signal may have fired between the loop check and this registration.
      if (interaction.controller.signal.aborted) finish("stopped");
    });
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

  private recordAnswer(interaction: PendingQuestion, qid: string, answer: AskAnswerValue): void {
    if (interaction.answers.has(qid)) return;
    interaction.answers.set(qid, answer);
    for (const wake of [...interaction.waiters]) wake();
  }

  // ── approval/request ───────────────────────────────────────────────────────

  private async answerApproval(req: ApprovalRequestEvent, next: () => Promise<ApprovalOutcome>): Promise<ApprovalOutcome> {
    const sessionId = req.agent?.id;
    if (sessionId === undefined || sessionId === "" || hostCancelled(req.signal)) return next();
    const target = this.claimTarget(sessionId);
    if (target === undefined) return next();

    const t = messages(target.binding.language ?? this.config.language);
    const interaction: PendingApproval = {
      kind: "approval",
      chatKey: target.binding.chatKey,
      chatType: target.binding.chatType,
      adapter: target.adapter,
      sessionId,
      language: target.binding.language ?? this.config.language,
      toolName: req.toolName,
      ...(req.reason === undefined ? {} : { reason: req.reason }),
      controller: new AbortController(),
      settled: false,
    };
    this.pending.set(interaction.chatKey, interaction);
    const onAbort = (): void => this.settle(interaction);
    req.signal?.addEventListener("abort", onAbort, { once: true });

    const prompt: ChoicePrompt = {
      title: t.approvalCardTitle,
      description: t.approvalAsk(req.toolName, req.reason),
      options: [
        { id: "approval:allow", label: t.approveLabel },
        { id: "approval:reject", label: t.rejectLabel },
      ],
    };

    try {
      while (!interaction.controller.signal.aborted && !interaction.settled) {
        const { choice, messageId } = await interaction.adapter.promptChoice(
          this.outbound(interaction),
          prompt,
          interaction.messageId,
          interaction.controller.signal,
        );
        if (messageId !== "") interaction.messageId = messageId;

        if (choice !== "approval:allow" && choice !== "approval:reject") {
          if (interaction.controller.signal.aborted || interaction.settled) break;
          // Card expired without a tap — re-present it and keep waiting. The
          // host cancels the request itself if it stops caring (its signal
          // fires, which aborts us and lands on `next()` below).
          await delay(1000);
          continue;
        }

        if (hostCancelled(req.signal)) {
          // Decided, but too late: the host already gave up on this request.
          await interaction.adapter.closeMenu(messageId, t.approvalStale).catch(() => undefined);
          return next();
        }
        const outcome: ApprovalOutcome = choice === "approval:allow" ? "allowed-once" : "rejected";
        // Replace the buttons with a clear "done" state so the user sees the
        // decision landed even if the chat keeps streaming afterwards.
        await interaction.adapter.closeMenu(messageId, t.approvalDone(outcome, req.toolName)).catch(() => undefined);
        this.log(`connect: approval ${outcome} for ${req.toolName} from ${interaction.chatKey}`);
        return outcome;
      }
      return next();
    } catch (error) {
      this.log(`connect: approval presentation failed (${interaction.chatKey}): ${String(error)}`);
      return next();
    } finally {
      req.signal?.removeEventListener("abort", onAbort);
      this.settle(interaction);
    }
  }

  // ── shared ─────────────────────────────────────────────────────────────────

  /**
   * Pick the one chat that owns `sessionId` and can actually present a prompt.
   *
   * Only the first match is claimed: two cards for one question would leave the
   * second one unanswerable (the answer is delivered to the agent, not to a
   * specific card), and the Web GUI would render a duplicate.
   *
   * The `web` channel is a GUI mirror whose outbound face is a no-op by design
   * — it can neither show a card nor report a tap, so claiming it would spin
   * the re-present loop forever. Declining it leaves the request to the host's
   * own forwarder, which is precisely the Web GUI.
   */
  private claimTarget(sessionId: string): { binding: ChatBinding; adapter: ChannelAdapter } | undefined {
    for (const binding of this.bindings.list()) {
      if (binding.sessionId !== sessionId && binding.webMirrorSessionId !== sessionId) continue;
      const adapter = this.adapters.get(binding.channel);
      if (adapter === undefined || adapter.supportsChoices === false) continue;
      if (this.pending.has(binding.chatKey)) continue;
      return { binding, adapter };
    }
    return undefined;
  }

  /** Stop presenting and drop the interaction (answered, cancelled, or torn down). */
  private settle(interaction: PendingInteraction): void {
    interaction.settled = true;
    if (this.pending.get(interaction.chatKey) === interaction) this.pending.delete(interaction.chatKey);
    interaction.controller.abort();
  }

  private outbound(p: { chatKey: string; chatType: "p2p" | "group" }): OutboundTarget {
    return { chatKey: p.chatKey, chatType: p.chatType };
  }

  private log(message: string): void {
    (this.ctx.get("logger") as { info?: (...args: unknown[]) => void } | undefined)?.info?.(message);
  }
}
