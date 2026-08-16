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
import { HELP_TEXT, parseCommand, type Command } from "./commands.js";
import type { BindingStore, ChatSessionRecord } from "./binding.js";

export interface ConnectConfig {
  /** Agent preset id composed into each session; `undefined` = roster default. */
  agentPreset?: string;
  /** Absolute working directory for each bound agent; defaults to process cwd. */
  workDir?: string;
  /** Optional workspace directories offered by the `/dir` chooser. */
  workspaces?: string[];
  /** Vision-capable model used to describe images when the main model can't. */
  visionModel?: { provider: string; model: string };
  allowUsers?: string[];
  allowChats?: string[];
  stateDir?: string;
}

export interface ResolvedConnectConfig {
  agentPreset?: string;
  workDir?: string;
  workspaces: string[];
  visionModel?: { provider: string; model: string };
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

const REASON_LABELS: Record<TurnReason, string> = {
  completed: "✅ 完成",
  aborted: "⏹️ 已中止",
  blocked: "🚫 阻塞",
  error: "❌ 出错",
  "max-tokens": "⚠️ 达到输出上限",
  interrupted: "⚠️ 被中断",
  unknown: "❓ 未知",
};

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

const MENU_TITLES: Record<MenuId, string> = {
  root: "主菜单",
  workspace: "切换工作目录",
  chat: "切换对话",
  settings: "设置",
  model: "切换模型",
  reasoning: "推理强度",
  notify: "通知设置",
};

export class AgentRunner {
  private readonly queue: InboundMessage[] = [];
  private running = false;
  private agent?: Agent;
  private handle?: AgentHandle;
  private turn?: ActiveTurn;
  private workDir: string;
  private streamEnabled = true;
  private summaryEnabled = true;

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
        turn.chunks.push("🤔 深度思考中…\n");
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
        .sendText(this.target(msg), `⚠️ 处理失败：${truncate(detail)}`)
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
    if (rawImages === undefined || rawImages.length === 0) return content;

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
    const note = [
      "[用户发送了图片，图片已保存到以下路径（可用工具查看）：",
      locationText,
      description !== ""
        ? `图片内容说明：\n${description}`
        : "（未能自动分析图片内容，请用文件/终端工具查看这些图片。）",
      "]",
    ].join("\n");
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
          { type: "text", text: "请详细描述这些图片的内容（物体、场景、文字、布局、氛围等），供一个无法直接查看图片的主模型理解。" },
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
    const lines = [`**任务结束**：${REASON_LABELS[outcome.reason]}`];
    if (outcome.code !== undefined) lines.push(`错误码：\`${outcome.code}\``);
    if (outcome.message !== undefined) lines.push(`原因：${truncate(outcome.message)}`);
    if (outcome.text !== "") lines.push(`已产出：${truncate(outcome.text, 300)}`);
    const card: SummaryCard = { markdown: lines.join("\n") };
    await this.adapter.sendCard(this.target(msg), card).catch(() => undefined);
  }

  private async handleCommand(command: Command, msg: InboundMessage): Promise<void> {
    const target = this.target(msg);
    switch (command.kind) {
      case "new": {
        await this.newChat(msg);
        await this.adapter.sendText(target, "已开启新会话。");
        break;
      }
      case "clear": {
        await this.clearChat(msg);
        await this.adapter.sendText(target, "会话已清空。");
        break;
      }
      case "stop": {
        this.agent?.cancel({ kind: "user" });
        await this.adapter.sendText(target, "已请求停止当前任务。");
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
          await this.adapter.sendText(target, "请输入绝对路径，例如 `/dir D:\\projects\\my-app`。");
          break;
        }
        try {
          if (!existsSync(path) || !statSync(path).isDirectory()) {
            await this.adapter.sendText(target, `目录不存在或不是文件夹：${path}`);
            break;
          }
        } catch {
          await this.adapter.sendText(target, `无法访问目录：${path}`);
          break;
        }
        this.workDir = path;
        await this.newChat(msg);
        await this.adapter.sendText(target, `工作目录已切换为：\n${path}\n（已开启新会话）`);
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
          await this.adapter.sendText(target, "用法：`/workspace <绝对路径>`，例如 `/workspace D:\\projects\\new-app`。");
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
        await this.adapter.sendText(target, HELP_TEXT);
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
    add(this.workDir, "当前目录");
    for (const w of registry?.list?.() ?? []) add(w.path, w.title);
    for (const p of this.config.workspaces) add(p, p);
    return out;
  }

  private async openMenu(target: OutboundTarget, msg: InboundMessage, menuId: MenuId, stack: MenuId[] = [], cardId?: string): Promise<void> {
    const items = await this.menuItems(menuId);
    const options: ChoiceOption[] = items.map((i) => ({ id: i.id, label: i.label }));
    options.push({ id: "menu:exit", label: "❌ 退出" });
    if (stack.length > 0) options.push({ id: "menu:back", label: "🔙 返回" });
    const { choice, messageId } = await this.adapter.promptChoice(target, { title: MENU_TITLES[menuId], options }, cardId);
    if (choice === undefined) return;
    if (choice === "menu:exit") {
      await this.adapter.closeMenu(messageId, "菜单已关闭。");
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
          { id: "workspace", label: "📁 切换工作目录", onSelect: (t, m, cardId) => this.openMenu(t, m, "workspace", ["root"], cardId) },
          { id: "chat", label: "💬 切换对话", onSelect: (t, m, cardId) => this.openMenu(t, m, "chat", ["root"], cardId) },
          { id: "status", label: "📊 查看状态", leaf: true, onSelect: async (t) => { await this.showStatus(t); } },
          { id: "task", label: "📋 查看任务", leaf: true, onSelect: async (t) => { await this.showTasks(t); } },
          { id: "history", label: "🗒️ 历史消息", leaf: true, onSelect: async (t) => { await this.showHistory(t, 10); } },
          { id: "goals", label: "🎯 目标", leaf: true, onSelect: async (t) => { await this.showGoals(t); } },
          { id: "schedule", label: "⏰ 定时提醒", leaf: true, onSelect: async (t) => { await this.showSchedule(t); } },
          { id: "compact", label: "🗜️ 压缩上下文", leaf: true, onSelect: async (t) => { await this.compact(t); } },
          { id: "plugins", label: "🔌 查看插件", leaf: true, onSelect: async (t) => { await this.showPlugins(t); } },
          { id: "settings", label: "⚙️ 设置", onSelect: (t, m, cardId) => this.openMenu(t, m, "settings", ["root"], cardId) },
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
          label: "➕ 新建对话",
          leaf: true,
          onSelect: async (t, m) => {
            await this.newChat(m);
          },
        });
        return items;
      }
      case "settings":
        return [
          { id: "model", label: "🤖 切换模型", onSelect: (t, m, cardId) => this.openMenu(t, m, "model", ["settings", "root"], cardId) },
          { id: "reasoning", label: "🧠 推理强度", onSelect: (t, m, cardId) => this.openMenu(t, m, "reasoning", ["settings", "root"], cardId) },
          { id: "notify", label: "🔔 通知设置", onSelect: (t, m, cardId) => this.openMenu(t, m, "notify", ["settings", "root"], cardId) },
          { id: "overview", label: "📄 配置总览", leaf: true, onSelect: async (t) => { await this.showSettings(t); } },
        ];
      case "model":
        return await this.modelMenuItems();
      case "reasoning":
        return this.reasoningMenuItems();
      case "notify":
        return [
          {
            id: "stream",
            label: `流式输出：${this.streamEnabled ? "开" : "关"}`,
            leaf: true,
            onSelect: async () => {
              this.streamEnabled = !this.streamEnabled;
            },
          },
          {
            id: "summary",
            label: `结束摘要：${this.summaryEnabled ? "开" : "关"}`,
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
      await this.adapter.sendText(target, `状态：无活动会话\n工作目录：${this.workDir}`);
      return;
    }
    const label = agent.status === "running" ? "🟢 运行中" : "⚪ 空闲";
    const model = `${agent.options.provider ?? "-"}/${agent.options.model ?? "-"}`;
    const lines = [
      `状态：${label}`,
      `模型：${model}`,
      `工作目录：${this.workDir}`,
      `待处理消息：${this.queue.length}`,
      `会话：${agent.id}`,
    ];
    const tokenMeter = this.ctx.get("tokenMeter") as
      | { measure?: (s: unknown) => { totalTokens: number; surfaceTokens: number } }
      | undefined;
    try {
      const m = tokenMeter?.measure?.(agent.session);
      if (m !== undefined) lines.push(`上下文：${m.totalTokens} tokens（会话 ${m.surfaceTokens}）`);
    } catch {
      // Token meter unavailable: skip.
    }
    await this.adapter.sendText(target, lines.join("\n"));
  }

  private async showTasks(target: OutboundTarget): Promise<void> {
    const todos = this.readTodos();
    if (todos.length === 0) {
      await this.adapter.sendText(target, "当前没有任务清单。");
      return;
    }
    const lines = todos.map((todo) => {
      const mark = todo.status === "completed" ? "✅" : todo.status === "in_progress" ? "🔄" : "⬜";
      return `${mark} ${todo.content}`;
    });
    await this.adapter.sendText(target, `当前任务（${todos.length} 项）：\n${lines.join("\n")}`);
  }

  private async showSettings(target: OutboundTarget): Promise<void> {
    const binding = this.bindings.get(this.channel, this.chatKey);
    const agent = this.agent;
    const model = agent ? `${agent.options.provider ?? "-"}/${agent.options.model ?? "-"}` : "-";
    const sel = this.defaultSelection();
    const lines = [
      "⚙️ 设置：",
      `模型：${model}`,
      `推理强度：${sel.reasoningEffort ?? "默认"}`,
      `Agent 预设：${this.config.agentPreset ?? "默认"}`,
      `工作目录：${this.workDir}`,
      `工作区列表：${this.config.workspaces.length === 0 ? "（未配置）" : ""}`,
    ];
    for (const w of this.config.workspaces) lines.push(`  - ${w}`);
    lines.push(`对话数：${binding?.sessions.length ?? 0}`);
    lines.push(`流式输出：${this.streamEnabled ? "开" : "关"}`);
    lines.push(`结束摘要：${this.summaryEnabled ? "开" : "关"}`);
    lines.push(`发送者白名单：${this.config.allowUsers.length === 0 ? "全部放行" : `${this.config.allowUsers.length} 人`}`);
    lines.push(`会话白名单：${this.config.allowChats.length === 0 ? "全部放行" : `${this.config.allowChats.length} 个`}`);
    lines.push(`状态目录：${this.config.stateDir ?? ".dsh-connect"}`);
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
      items.push({ id: "model:none", label: "（未发现可用模型）", onSelect: async () => {} });
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
        out.push({ provider: p.id, model: m.id, name: `${m.name || m.id}（${p.name || p.id}）` });
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
      { id: "low", name: "低 (low)" },
      { id: "medium", name: "中 (medium)" },
      { id: "high", name: "高 (high)" },
    ];
    const items: MenuItem[] = [
      {
        id: "effort:default",
        label: `${current.reasoningEffort === undefined ? "● " : ""}默认（跟随模型）`,
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
      await this.adapter.sendText(target, "未获取到插件清单。");
      return;
    }
    const shown = all.slice(0, 50);
    const lines = shown.map((e) => {
      const status = e.disabled ? "⛔ 禁用" : "✅ 启用";
      return `${status}  ${e.id}${e.options.name ? `  (${e.options.name})` : ""}`;
    });
    if (all.length > shown.length) lines.push(`… 共 ${all.length} 个，仅显示前 ${shown.length} 个`);
    await this.adapter.sendText(target, `插件（${all.length}）：\n${lines.join("\n")}`);
  }

  private async createWorkspace(path: string, target: OutboundTarget): Promise<void> {
    if (!isAbsolute(path)) {
      await this.adapter.sendText(target, "请输入绝对路径，例如 `/workspace D:\\projects\\new-app`。");
      return;
    }
    try {
      if (!existsSync(path) || !statSync(path).isDirectory()) {
        await this.adapter.sendText(target, `目录不存在或不是文件夹：${path}\n（请先创建该目录，再执行 /workspace）`);
        return;
      }
    } catch {
      await this.adapter.sendText(target, `无法访问目录：${path}`);
      return;
    }
    const registry = this.ctx.get("workspaceRegistry") as
      | { create?: (path: string, title?: string) => Promise<{ title: string; path: string }> }
      | undefined;
    if (registry?.create === undefined) {
      await this.adapter.sendText(target, "工作区服务不可用。");
      return;
    }
    try {
      const ws = await registry.create(path);
      await this.adapter.sendText(target, `工作区已创建：\n${ws.title}  (${ws.path})`);
    } catch (error) {
      await this.adapter.sendText(target, `创建失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async compact(target: OutboundTarget): Promise<void> {
    const agent = this.agent;
    if (agent === undefined) {
      await this.adapter.sendText(target, "当前没有活动会话，无法压缩。");
      return;
    }
    if (agent.status !== "idle") {
      await this.adapter.sendText(target, "当前会话正在运行，请稍后再试（或先 /stop）。");
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
      await this.adapter.sendText(target, "压缩服务不可用（当前预设未挂载压缩后端）。");
      return;
    }
    try {
      const result = await compaction.compactNow(agent, new AbortController().signal);
      if (result === null) {
        await this.adapter.sendText(target, "没有可压缩的历史。");
      } else {
        await this.adapter.sendText(target, "上下文已压缩。");
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      await this.adapter.sendText(target, `压缩失败：${truncate(msg)}`);
    }
  }

  private async showHistory(target: OutboundTarget, limit: number): Promise<void> {
    const agent = this.agent;
    if (agent === undefined) {
      await this.adapter.sendText(target, "当前没有活动会话。");
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
      await this.adapter.sendText(target, "会话里还没有消息。");
      return;
    }
    await this.adapter.sendText(target, `最近 ${rows.length} 条消息：\n${rows.reverse().join("\n\n")}`);
  }

  private async showGoals(target: OutboundTarget): Promise<void> {
    const agent = this.agent;
    if (agent === undefined) {
      await this.adapter.sendText(target, "当前没有活动会话。");
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
      await this.adapter.sendText(target, "当前没有进行中的目标。");
      return;
    }
    const phaseLabels: Record<string, string> = {
      active: "🟢 进行中",
      paused: "⏸️ 已暂停",
      blocked: "🚫 受阻",
      complete: "✅ 已完成",
    };
    const lines = [
      `🎯 目标：${view.objective}`,
      `状态：${phaseLabels[view.phase] ?? view.phase}`,
      `轮次：${view.roundsStarted}/${view.maxGoalRounds}`,
      `自动续跑：${view.activation === "armed" ? "已武装" : "已解除"}`,
    ];
    if (view.blockedReason !== undefined) lines.push(`受阻原因：${view.blockedReason.message}`);
    await this.adapter.sendText(target, lines.join("\n"));
  }

  private async showSchedule(target: OutboundTarget): Promise<void> {
    const agent = this.agent;
    if (agent === undefined) {
      await this.adapter.sendText(target, "当前没有活动会话。");
      return;
    }
    const reminders = foldReminders(agent.session.events);
    if (reminders.length === 0) {
      await this.adapter.sendText(target, "本会话没有定时提醒。可对 Agent 说「5 分钟后提醒我…」来创建（需在配置里挂载 schedule 插件）。");
      return;
    }
    const now = Date.now();
    const lines = reminders.map((r) => {
      const due = Date.parse(r.scheduledAt) <= now;
      const state = due ? "⚠️ 已到期" : "⏰";
      const kind = r.kind === "every" ? `每 ${Math.round((r.everySeconds ?? 0) / 60)} 分钟` : "一次性";
      const when = new Date(Date.parse(r.scheduledAt)).toLocaleString("zh-CN");
      return `${state} [${r.id}] ${r.prompt}（${kind}，${when}）`;
    });
    await this.adapter.sendText(target, `定时提醒（${reminders.length}）：\n${lines.join("\n")}`);
  }

  private async showAllWorkspaces(target: OutboundTarget): Promise<void> {
    const registry = this.ctx.get("workspaceRegistry") as
      | { list?: () => readonly { path: string; title: string; sessionIds?: readonly unknown[] }[] }
      | undefined;
    const all = registry?.list?.() ?? [];
    if (all.length === 0) {
      await this.adapter.sendText(target, "还没有工作区。可用 `/workspace <绝对路径>` 新建。");
      return;
    }
    const lines = all.map((w, i) => {
      const sess = w.sessionIds !== undefined ? `  · ${w.sessionIds.length} 会话` : "";
      return `${i + 1}. ${w.title}${w.title !== w.path ? `  (${w.path})` : ""}${sess}`;
    });
    await this.adapter.sendText(target, `工作区（${all.length}）：\n${lines.join("\n")}`);
  }
}
