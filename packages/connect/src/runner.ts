/**
 * Per-chat agent driver: serializes inbound messages, creates/resumes the bound
 * DSH agent (with preset composition + model selection), and bridges the live
 * `session/event` stream into the adapter's streaming reply.
 * @module dsh-connect/runner
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { copyFile, readFile } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import { SessionId, SessionStore, type Session, type SessionEvent, type TodoItem } from "@deepseek-ai/dsh-session";
import { AgentRegistry, installModelSelection, type Agent, type AgentHandle, type ModelSelection } from "@deepseek-ai/dsh-agent";
import { createUserMessage, ReasoningEffortId, type ContentBlock } from "@deepseek-ai/dsh-llm";
import type { ChannelAdapter, ChoiceOption, InboundMessage, OutboundTarget, SummaryCard, TurnOutcome, TurnReason } from "./types.js";
import { createAsyncQueue } from "./stream.js";
import { helpText, parseCommand, type Command } from "./commands.js";
import type { BindingStore, ChatSessionRecord } from "./binding.js";
import { messages, type Language, type Messages } from "./i18n.js";

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
  };
}

interface ActiveTurn {
  firstSeq: number;
  chunks: ReturnType<typeof createAsyncQueue<string>>;
  lastText: string;
  reasoning: boolean;
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
  for (const event of events) {
    if (event.seq < firstSeq) continue;
    if (event.type === "turn/start") {
      started = true;
      continue;
    }
    if (!started) continue;
    if (event.type === "assistant/message") {
      const joined = event.data.message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("");
      if (joined !== "") text = joined;
    }
    if (event.type === "turn/end") {
      reason = mapReason(event.data.reason.kind);
      if (event.data.reason.kind === "error") {
        code = event.data.reason.error.code;
        message = event.data.reason.error.message;
      }
    }
  }
  return { reason, text, ...(code === undefined ? {} : { code }), ...(message === undefined ? {} : { message }) };
}

function truncate(text: string, max = 500): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
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

type MenuId = "root" | "workspace" | "chat" | "settings" | "model" | "reasoning" | "notify";

interface MenuItem {
  id: string;
  label: string;
  /** Leaf action: after it runs, the menu returns to the root menu on the same card. */
  leaf?: boolean;
  /** `messageId` is the menu card id: pass it to `openMenu` to navigate in place, or close the card. */
  onSelect: (target: OutboundTarget, msg: InboundMessage, messageId: string) => Promise<void>;
}

export class AgentRunner {
  private readonly queue: InboundMessage[] = [];
  private running = false;
  private agent?: Agent;
  private handle?: AgentHandle;
  private turn?: ActiveTurn;
  private workDir: string;
  private streamEnabled = true;
  private summaryEnabled = true;
  private readonly t: Messages;

  constructor(
    private readonly ctx: Context,
    private readonly config: ResolvedConnectConfig,
    private readonly channel: string,
    private readonly chatKey: string,
    private readonly chatType: "p2p" | "group",
    private readonly adapter: ChannelAdapter,
    private readonly bindings: BindingStore,
  ) {
    this.workDir = config.workDir ?? this.resolveDefaultWorkDir();
    this.t = messages(config.language);
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
    }
  }

  private rootMenuSections(): readonly { title: string; ids: readonly string[] }[] {
    return [
      { title: this.t.rootSectionWorkspace, ids: ["workspace"] },
      { title: this.t.rootSectionChat, ids: ["chat", "history"] },
      { title: this.t.rootSectionTask, ids: ["task", "goals", "schedule"] },
      { title: this.t.rootSectionSystem, ids: ["status", "plugins", "compact", "settings"] },
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
      void this.handleCommand(command, msg);
      return;
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
    if (event.type === "assistant/chunk") {
      const chunk = event.data.chunk;
      if (chunk.type === "text-delta") {
        turn.chunks.push(chunk.text);
        turn.lastText += chunk.text;
      } else if (chunk.type === "reasoning-delta" && !turn.reasoning) {
        turn.reasoning = true;
        turn.chunks.push(this.t.thinkingHint);
      }
    }
  }

  private target(msg: InboundMessage): OutboundTarget {
    return {
      chatKey: this.chatKey,
      chatType: this.chatType,
      ...(msg.replyRef === undefined ? {} : { replyRef: msg.replyRef }),
    };
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
    try {
      const agent = await this.ensureAgent(msg);
      const outcome = await this.driveAgent(agent, msg);
      this.touchBinding(msg);
      if (outcome.reason !== "completed" && this.summaryEnabled) {
        await this.sendSummary(msg, outcome);
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await this.adapter
        .sendText(this.target(msg), this.t.processingFailed(truncate(detail)))
        .catch(() => undefined);
    }
  }

  private async ensureAgent(msg: InboundMessage): Promise<Agent> {
    await (this.ctx.get("loader") as { await?: () => Promise<void> } | undefined)?.await?.();

    const binding = this.bindings.get(this.channel, this.chatKey);
    const live = binding === undefined ? undefined : this.agents.get(SessionId(binding.sessionId));
    if (live !== undefined) {
      this.agent = live;
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
    return handle.agent;
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

  private async composeSetup(selection: ModelSelection): Promise<{
    agentPreset?: string;
    setup: (agentCtx: Context) => void | Promise<void>;
  }> {
    const presets = this.ctx.get("agentPresets") as
      | { resolve(id?: string): Promise<{ id: string }>; mount(agentCtx: Context, id: string): Promise<unknown> }
      | undefined;

    if (presets === undefined) {
      return {
        setup: (agentCtx) => {
          installModelSelection(agentCtx, { current: selection, assembled: undefined });
        },
      };
    }

    const resolved = await presets.resolve(this.config.agentPreset);
    return {
      agentPreset: resolved.id,
      setup: async (agentCtx) => {
        installModelSelection(agentCtx, { current: selection, assembled: undefined });
        await presets.mount(agentCtx, resolved.id);
      },
    };
  }

  private watchAgent(agent: Agent): void {
    // Scope-filtered: receives only this agent's session events.
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
    if (!this.streamEnabled) {
      agent.followup(await userMessage());
      await agent.whenIdle();
      await this.sessions.flush(agent.session);
      const outcome = summarizeTurn(agent.session.events, firstSeq);
      if (outcome.text !== "") {
        await this.adapter.sendText(this.target(msg), outcome.text).catch(() => undefined);
      }
      return outcome;
    }

    const chunks = createAsyncQueue<string>();
    this.turn = { firstSeq, chunks, lastText: "", reasoning: false };

    const streamPromise = this.adapter.streamText(this.target(msg), chunks);

    agent.followup(await userMessage());

    await agent.whenIdle();
    await this.sessions.flush(agent.session);
    chunks.end();
    await streamPromise;

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
    if (rawImages === undefined || rawImages.length === 0) {
      if (msg.imageError !== undefined) {
        content.push({ type: "text", text: this.t.imageDownloadFailed(msg.imageError) });
      }
      return content;
    }

    // Copy images into the agent's work directory so its tools can access them.
    const paths = await this.stageImages(rawImages);
    const locationText = paths.map((p) => `- ${p}`).join("\n");

    const mainVision = await this.modelSupportsVision(this.agent?.options.provider, this.agent?.options.model);
    if (mainVision) {
      const imageBlocks = await this.imageBlocks(paths);
      if (imageBlocks.length > 0) {
        return [{ type: "text", text: msg.text }, ...imageBlocks];
      }
      return content;
    }

    const description = await this.describeImages(paths);
    const note = this.t.imagesStaged(locationText, description);
    content.push({ type: "text", text: note });
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
    if (vision === null) return "";
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
    if (attachments?.saveImage === undefined || llm?.stream === undefined) return "";

    const refs: unknown[] = [];
    for (const path of paths) {
      try {
        const buf = await readFile(path);
        refs.push(await attachments.saveImage({ data: new Uint8Array(buf), mediaType: detectImageMediaType(buf) }));
      } catch {
        // Skip unreadable images.
      }
    }
    if (refs.length === 0) return "";

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
      return text.trim();
    } catch {
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
      return info?.inputModalities?.includes("image") ?? false;
    } catch {
      return false;
    }
  }

  private async findVisionModel(): Promise<{ provider: string; model: string } | null> {
    if (this.config.visionModel !== undefined) return this.config.visionModel;
    const llm = this.ctx.get("llm") as
      | {
          listProviders?: () => { id: string }[];
          listModels?: (p: string) => Promise<{ id: string }[]>;
          resolveModelInfo?: (p: string, m: string) => Promise<{ inputModalities?: readonly string[] }>;
        }
      | undefined;
    if (llm?.listProviders === undefined || llm.resolveModelInfo === undefined) return null;
    for (const p of llm.listProviders() ?? []) {
      let models: { id: string }[] = [];
      try {
        models = (await llm.listModels?.(p.id)) ?? [];
      } catch {
        continue;
      }
      for (const m of models) {
        try {
          const info = await llm.resolveModelInfo(p.id, m.id);
          if (info.inputModalities?.includes("image")) return { provider: p.id, model: m.id };
        } catch {
          // Try the next model.
        }
      }
    }
    return null;
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
    await this.adapter.sendCard(this.target(msg), card).catch(() => undefined);
  }

  private async handleCommand(command: Command, msg: InboundMessage): Promise<void> {
    const target = this.target(msg);
    switch (command.kind) {
      case "new": {
        await this.newChat(msg);
        await this.adapter.sendText(target, this.t.newChatDone);
        break;
      }
      case "clear": {
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
      case "workspaces": {
        await this.showAllWorkspaces(target);
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

  private recordSession(sessionId: string, title: string, ownerKey: string): void {
    const binding = this.bindings.get(this.channel, this.chatKey);
    const others = (binding?.sessions ?? []).filter((s) => s.sessionId !== sessionId);
    const sessions: ChatSessionRecord[] = [
      { sessionId, title, createdAt: Date.now(), lastActiveAt: Date.now(), workDir: this.workDir },
      ...others,
    ].slice(0, 50);
    this.bindings.put({
      channel: this.channel,
      chatKey: this.chatKey,
      chatType: this.chatType,
      sessionId,
      ownerKey,
      createdAt: binding?.createdAt ?? Date.now(),
      lastActiveAt: Date.now(),
      sessions,
    });
  }

  private async newChat(msg: InboundMessage): Promise<void> {
    await this.disposeAgent();
    const binding = this.bindings.get(this.channel, this.chatKey);
    if (binding !== undefined) {
      this.bindings.put({ ...binding, sessionId: "", ownerKey: msg.senderKey, lastActiveAt: Date.now() });
    }
  }

  private async clearChat(msg: InboundMessage): Promise<void> {
    const binding = this.bindings.get(this.channel, this.chatKey);
    const current = binding?.sessionId;
    await this.disposeAgent();
    if (binding !== undefined && current !== undefined && current !== "") {
      const sessions = binding.sessions.filter((s) => s.sessionId !== current);
      this.bindings.put({ ...binding, sessionId: "", sessions, ownerKey: msg.senderKey, lastActiveAt: Date.now() });
    }
  }

  private async switchTo(sessionId: string, ownerKey: string): Promise<void> {
    const binding = this.bindings.get(this.channel, this.chatKey);
    if (binding === undefined) return;
    const sessions = binding.sessions.map((s) => (s.sessionId === sessionId ? { ...s, lastActiveAt: Date.now() } : s));
    this.bindings.put({ ...binding, sessionId, sessions, ownerKey, lastActiveAt: Date.now() });
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
    const { choice, messageId } = await this.adapter.promptChoice(
      target,
      {
        title: this.menuTitle(menuId),
        options,
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
    if (item === undefined) return;
    await item.onSelect(target, msg, messageId);
    if (item.leaf === true) {
      // Return to the root menu on the same card so the user can keep operating.
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
          },
        }));
      }
      case "chat": {
        const binding = this.bindings.get(this.channel, this.chatKey);
        const sessions = binding?.sessions ?? [];
        const active = binding?.sessionId;
        const items: MenuItem[] = sessions.map((s) => ({
          id: `session:${s.sessionId}`,
          label: `${s.sessionId === active ? "●" : "○"} ${s.title || s.sessionId}`,
          leaf: true,
          onSelect: async (t, m) => {
            await this.switchTo(s.sessionId, m.senderKey);
          },
        }));
        items.push({
          id: "action:new",
          label: this.t.menuNewChat,
          leaf: true,
          onSelect: async (t, m) => {
            await this.newChat(m);
          },
        });
        return items;
      }
      case "settings":
        return [
          { id: "model", label: this.t.menuSettingsModel, onSelect: (t, m, cardId) => this.openMenu(t, m, "model", ["settings", "root"], cardId) },
          { id: "reasoning", label: this.t.menuSettingsReasoning, onSelect: (t, m, cardId) => this.openMenu(t, m, "reasoning", ["settings", "root"], cardId) },
          { id: "notify", label: this.t.menuSettingsNotify, onSelect: (t, m, cardId) => this.openMenu(t, m, "notify", ["settings", "root"], cardId) },
          { id: "overview", label: this.t.menuSettingsOverview, leaf: true, onSelect: async (t) => { await this.showSettings(t); } },
        ];
      case "model":
        return await this.modelMenuItems();
      case "reasoning":
        return this.reasoningMenuItems();
      case "notify":
        return [
          {
            id: "stream",
            label: this.t.streamLabel(this.streamEnabled),
            leaf: true,
            onSelect: async () => {
              this.streamEnabled = !this.streamEnabled;
            },
          },
          {
            id: "summary",
            label: this.t.summaryLabel(this.summaryEnabled),
            leaf: true,
            onSelect: async () => {
              this.summaryEnabled = !this.summaryEnabled;
            },
          },
        ];
    }
  }

  private async showStatus(target: OutboundTarget): Promise<void> {
    const agent = this.agent;
    if (agent === undefined) {
      await this.adapter.sendText(target, this.t.statusNoSession(this.workDir));
      return;
    }
    const label = agent.status === "running" ? this.t.statusRunning : this.t.statusIdle;
    const model = `${agent.options.provider ?? "-"}/${agent.options.model ?? "-"}`;
    const lines = [
      this.t.statusField(label),
      this.t.modelField(model),
      this.t.workdirField(this.workDir),
      this.t.queuedField(this.queue.length),
      this.t.sessionField(agent.id),
    ];
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
    lines.push(this.t.streamLabel(this.streamEnabled));
    lines.push(this.t.summaryLabel(this.summaryEnabled));
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
      },
    }));
    if (items.length === 0) {
      items.push({ id: "model:none", label: this.t.noModelsFound, onSelect: async () => {} });
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
      const result = await compaction.compactNow(agent, new AbortController().signal);
      if (result === null) {
        await this.adapter.sendText(target, this.t.nothingToCompact);
      } else {
        await this.adapter.sendText(target, this.t.contextCompacted);
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      await this.adapter.sendText(target, this.t.compactFailed(truncate(msg)));
    }
  }

  private async showHistory(target: OutboundTarget, limit: number): Promise<void> {
    const agent = this.agent;
    if (agent === undefined) {
      await this.adapter.sendText(target, this.t.noActiveSession);
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
    const agent = this.agent;
    if (agent === undefined) {
      await this.adapter.sendText(target, this.t.noActiveSession);
      return;
    }
    const reminders = foldReminders(agent.session.events);
    if (reminders.length === 0) {
      await this.adapter.sendText(target, this.t.noReminders);
      return;
    }
    const now = Date.now();
    const locale = this.config.language === "en" ? "en-US" : "zh-CN";
    const lines = reminders.map((r) => {
      const due = Date.parse(r.scheduledAt) <= now;
      const state = due ? this.t.reminderDue : this.t.reminderClock;
      const kind = r.kind === "every" ? this.t.reminderEvery(Math.round((r.everySeconds ?? 0) / 60)) : this.t.reminderOnce;
      const when = new Date(Date.parse(r.scheduledAt)).toLocaleString(locale);
      return this.t.reminderLine(state, r.id, r.prompt, kind, when);
    });
    await this.adapter.sendText(target, this.t.remindersCount(reminders.length, lines.join("\n")));
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
}
