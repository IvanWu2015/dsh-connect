/**
 * Per-chat agent driver: serializes inbound messages, creates/resumes the bound
 * DSH agent (with preset composition + model selection), and bridges the live
 * `session/event` stream into the adapter's streaming reply.
 * @module dsh-connect/runner
 */
import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import { SessionId, SessionStore, type Session, type SessionEvent, type TodoItem } from "@deepseek-ai/dsh-session";
import { AgentRegistry, installModelSelection, type Agent, type AgentHandle, type ModelSelection } from "@deepseek-ai/dsh-agent";
import { createUserMessage, ReasoningEffortId } from "@deepseek-ai/dsh-llm";
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
  allowUsers?: string[];
  allowChats?: string[];
  stateDir?: string;
}

export interface ResolvedConnectConfig {
  agentPreset?: string;
  workDir?: string;
  workspaces: string[];
  allowUsers: string[];
  allowChats: string[];
  stateDir?: string;
}

export function resolveConnectConfig(config: ConnectConfig): ResolvedConnectConfig {
  return {
    agentPreset: config.agentPreset,
    workDir: config.workDir,
    workspaces: config.workspaces ?? [],
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

type MenuId = "root" | "workspace" | "chat" | "settings" | "model" | "reasoning" | "notify";

interface MenuItem {
  id: string;
  label: string;
  onSelect: (target: OutboundTarget, msg: InboundMessage) => Promise<void>;
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
    if (!this.streamEnabled) {
      agent.followup(
        createUserMessage({
          content: [{ type: "text", text: msg.text }],
          source: { kind: "user" },
        }),
      );
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

    agent.followup(
      createUserMessage({
        content: [{ type: "text", text: msg.text }],
        source: { kind: "user" },
      }),
    );

    await agent.whenIdle();
    await this.sessions.flush(agent.session);
    chunks.end();
    await streamPromise;

    const outcome = summarizeTurn(agent.session.events, firstSeq);
    const text = outcome.text !== "" ? outcome.text : this.turn.lastText;
    this.turn = undefined;
    return { ...outcome, text };
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

  private async openMenu(target: OutboundTarget, msg: InboundMessage, menuId: MenuId, stack: MenuId[] = []): Promise<void> {
    const items = await this.menuItems(menuId);
    const options: ChoiceOption[] = items.map((i) => ({ id: i.id, label: i.label }));
    if (stack.length > 0) options.push({ id: "menu:back", label: "🔙 返回" });
    const choice = await this.adapter.promptChoice(target, { title: MENU_TITLES[menuId], options });
    if (choice === undefined) return;
    if (choice === "menu:back") {
      const parent = stack[stack.length - 1];
      await this.openMenu(target, msg, parent, stack.slice(0, -1));
      return;
    }
    const item = items.find((i) => i.id === choice);
    if (item === undefined) return;
    await item.onSelect(target, msg);
  }

  private async menuItems(menuId: MenuId): Promise<MenuItem[]> {
    switch (menuId) {
      case "root":
        return [
          { id: "workspace", label: "📁 切换工作目录", onSelect: (t, m) => this.openMenu(t, m, "workspace", ["root"]) },
          { id: "chat", label: "💬 切换对话", onSelect: (t, m) => this.openMenu(t, m, "chat", ["root"]) },
          { id: "status", label: "📊 查看状态", onSelect: (t) => this.showStatus(t) },
          { id: "task", label: "📋 查看任务", onSelect: (t) => this.showTasks(t) },
          { id: "settings", label: "⚙️ 设置", onSelect: (t, m) => this.openMenu(t, m, "settings", ["root"]) },
        ];
      case "workspace": {
        const workspaces = this.listWorkspaces();
        return workspaces.map((w) => ({
          id: `dir:${w.path}`,
          label: `${w.path === this.workDir ? "● " : ""}${w.title}${w.title !== w.path ? `  (${w.path})` : ""}`,
          onSelect: async (t, m) => {
            this.workDir = w.path;
            await this.newChat(m);
            await this.adapter.sendText(t, `工作目录已切换为：\n${w.path}`);
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
          onSelect: async (t, m) => {
            await this.switchTo(s.sessionId, m.senderKey);
            await this.adapter.sendText(t, `已切换到对话：${s.title || s.sessionId}`);
          },
        }));
        items.push({
          id: "action:new",
          label: "➕ 新建对话",
          onSelect: async (t, m) => {
            await this.newChat(m);
            await this.adapter.sendText(t, "已开启新对话。");
          },
        });
        return items;
      }
      case "settings":
        return [
          { id: "model", label: "🤖 切换模型", onSelect: (t, m) => this.openMenu(t, m, "model", ["settings", "root"]) },
          { id: "reasoning", label: "🧠 推理强度", onSelect: (t, m) => this.openMenu(t, m, "reasoning", ["settings", "root"]) },
          { id: "notify", label: "🔔 通知设置", onSelect: (t, m) => this.openMenu(t, m, "notify", ["settings", "root"]) },
          { id: "overview", label: "📄 配置总览", onSelect: (t) => this.showSettings(t) },
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
            onSelect: async (t) => {
              this.streamEnabled = !this.streamEnabled;
              await this.adapter.sendText(t, `流式输出已${this.streamEnabled ? "开启" : "关闭"}。`);
            },
          },
          {
            id: "summary",
            label: `结束摘要：${this.summaryEnabled ? "开" : "关"}`,
            onSelect: async (t) => {
              this.summaryEnabled = !this.summaryEnabled;
              await this.adapter.sendText(t, `结束摘要已${this.summaryEnabled ? "开启" : "关闭"}。`);
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
    await this.adapter.sendText(target, [
      `状态：${label}`,
      `模型：${model}`,
      `工作目录：${this.workDir}`,
      `待处理消息：${this.queue.length}`,
      `会话：${agent.id}`,
    ].join("\n"));
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
      onSelect: async (t, m) => {
        await this.setModel(c.provider, c.model, m);
        await this.adapter.sendText(t, `模型已切换为：${c.name}`);
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
        onSelect: async (t, m) => {
          await this.setReasoning(undefined, m);
          await this.adapter.sendText(t, "推理强度已设为默认。");
        },
      },
    ];
    for (const e of efforts) {
      items.push({
        id: `effort:${e.id}`,
        label: `${e.id === current.reasoningEffort ? "● " : ""}${e.name}`,
        onSelect: async (t, m) => {
          await this.setReasoning(e.id, m);
          await this.adapter.sendText(t, `推理强度已切换为：${e.name}`);
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
}
