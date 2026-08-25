/**
 * The `connect` service (`ctx.connect`): adapter registry, inbound routing,
 * authorization, and the proactive `notify` entry point for work arrangement.
 * @module dsh-connect/service
 */
import { Service, type Context } from "@deepseek-ai/cordis";
import { readFileSync, existsSync } from "node:fs";
import { basename, join, dirname } from "node:path";
import type { ChannelAdapter, InboundMessage } from "./types.js";
import { AgentRunner, resolveConnectConfig, type ConnectConfig, type ResolvedConnectConfig } from "./runner.js";
import { BindingStore } from "./binding.js";
import { InteractionBridge } from "./interaction.js";
import { InboundDedup } from "./dedup.js";
import { withOutboundRetry, type RetryOptions } from "./retry.js";
import { ReminderStore, type ScheduledReminder } from "./scheduler.js";
import { messages } from "./i18n.js";

/** Minimal workspace registry face used by the connect service (typed loosely to avoid a hard dependency). */
interface WorkspaceRegistryLike {
  create?(path: string, title?: string): Promise<unknown>;
  resolveByPath?(path: string): Promise<{ attachSession?(sessionId: string): Promise<void> } | undefined>;
}

/** Shared configuration loaded from dsh.shared.config.json */
interface SharedConfig {
  workspace?: {
    defaultWorkDir?: string;
    additionalWorkspaces?: string[];
  };
  state?: {
    stateDir?: string;
  };
  mirror?: {
    autoCreate?: boolean;
  };
  language?: "zh" | "en";
}

/** Load shared configuration from project root or current directory. */
function loadSharedConfig(): SharedConfig {
  const candidates = [
    join(process.cwd(), "dsh.shared.config.json"),
    join(dirname(process.cwd()), "dsh.shared.config.json"),
  ];
  
  for (const path of candidates) {
    if (existsSync(path)) {
      try {
        const raw = readFileSync(path, "utf8");
        return JSON.parse(raw);
      } catch {
        // Ignore parse errors, fall back to defaults
      }
    }
  }
  
  return {};
}

function runnerKey(channel: string, chatKey: string): string {
  return `${channel}\u0000${chatKey}`;
}

/**
 * Bounded retry for outbound delivery. Attempts are cheap; a few extra calls
 * on a permanent failure are preferable to silently dropping a message on a
 * transient one. streamText is deliberately excluded (see withOutboundRetry).
 */
const OUTBOUND_RETRY: RetryOptions = { attempts: 3, baseDelayMs: 250, maxDelayMs: 2000 };

export class ConnectService extends Service {
  readonly config: ResolvedConnectConfig;
  private readonly adapters = new Map<string, ChannelAdapter>();
  private readonly runners = new Map<string, AgentRunner>();
  private readonly bindings: BindingStore;
  private readonly interaction: InteractionBridge;
  /** Sliding-window duplicate guard for re-delivered inbound events. */
  private readonly dedup = new InboundDedup();
  /** Persistent chat-level reminders (`/remind`) + the delivery loop. */
  readonly reminders: ReminderStore;
  private reminderTimer?: NodeJS.Timeout;
  private workspacesRegistered = false;

  constructor(ctx: Context, config: ConnectConfig | null = {}) {
    super(ctx, "connect");

    // The DSH loader constructs this class directly and passes `null` when the
    // plugin has no explicit config (no schema coercion on this path).
    config = config ?? {};

    // Load shared configuration and merge with provided config
    const sharedConfig = loadSharedConfig();
    const mergedConfig: ConnectConfig = {
      ...config,
      // Shared config takes precedence for workspace and state settings
      workDir: sharedConfig.workspace?.defaultWorkDir ?? config.workDir,
      workspaces: [
        ...(sharedConfig.workspace?.additionalWorkspaces ?? []),
        ...(config.workspaces ?? []),
      ],
      stateDir: sharedConfig.state?.stateDir ?? config.stateDir,
      language: sharedConfig.language ?? config.language,
      autoMirror: sharedConfig.mirror?.autoCreate ?? config.autoMirror,
    };
    
    this.config = resolveConnectConfig(mergedConfig);
    this.bindings = new BindingStore(this.config.stateDir);
    this.interaction = new InteractionBridge(ctx, this.adapters, this.bindings, this.config);
    this.reminders = new ReminderStore(this.config.stateDir);
    this.startReminderLoop();
  }

  /** Poll the reminder store and deliver anything that has come due. */
  private startReminderLoop(): void {
    const CHECK_MS = 15_000;
    const timer = setInterval(() => {
      void this.fireDueReminders().catch((error) => {
        this.ctx.logger?.error?.(`connect: reminder tick failed: ${String(error)}`);
      });
    }, CHECK_MS);
    timer.unref?.();
    this.reminderTimer = timer;
    try {
      // Cast: cordis Context.on is typed to a fixed event map; "dispose" is the
      // generic lifecycle event the host emits on teardown.
      (this.ctx as { on?: (event: string, cb: () => void) => void }).on?.("dispose", () => clearInterval(timer));
    } catch {
      // Host without the lifecycle event: the unref'd timer dies with the process.
    }
  }

  /** Deliver every due reminder and mark it fired (kept unfired on failure to retry). */
  private async fireDueReminders(): Promise<void> {
    const t = messages(this.config.language);
    for (const reminder of this.reminders.due()) {
      const adapter = this.adapters.get(reminder.channel);
      if (adapter === undefined) continue;
      try {
        await adapter.sendText(
          { chatKey: reminder.chatKey, chatType: reminder.chatType },
          t.reminderFired(reminder.text),
        );
        this.reminders.markFired(reminder.id);
      } catch (error) {
        this.ctx.logger?.warn?.(`connect: reminder delivery failed (${reminder.channel}/${reminder.chatKey}): ${String(error)}`);
      }
    }
  }

  /** Expose the binding store so adapters (e.g. connect-web) can monitor mirror sessions. */
  get bindingStore(): BindingStore {
    return this.bindings;
  }

  /**
   * Register every connect work directory as a DSH workspace (idempotent).
   *
   * DSH's Web GUI groups sessions by workspace: a session is only visible
   * under a workspace when its header `cwd` matches the workspace path AND it
   * is present in the workspace's session account. Without this step the
   * Feishu-created `connect-*` sessions never appear in the Web GUI's
   * workspace browser, even though they live in the shared session store.
   *
   * This method also back-fills the workspace session account with every
   * session the bindings file already knows about, so history created before
   * this feature shows up too.
   */
  async ensureWorkspacesRegistered(): Promise<void> {
    if (this.workspacesRegistered) return;
    this.workspacesRegistered = true;
    const registry = this.ctx.get("workspaceRegistry") as WorkspaceRegistryLike | undefined;
    if (registry?.create === undefined || registry.resolveByPath === undefined) {
      // No workspace service in this DSH process — Web GUI grouping is unavailable.
      return;
    }

    // Deduplicate work dirs (case-insensitive on Windows).
    const seen = new Set<string>();
    const paths: string[] = [];
    for (const p of [this.config.workDir, ...this.config.workspaces]) {
      if (p === undefined || p === "") continue;
      const key = p.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      paths.push(p);
    }

    // 1) Make sure each work dir is a registered workspace.
    const workDirToWorkspace = new Map<string, { attachSession?(sessionId: string): Promise<void> }>();
    for (const p of paths) {
      try {
        await registry.create(p, basename(p));
      } catch {
        // Directory may not exist yet; resolveByPath below will just miss it.
      }
    }

    // 2) Attach every known session to the workspace matching its recorded workDir.
    for (const binding of this.bindings.list()) {
      const candidates = new Map<string, string>();
      if (binding.sessionId !== "") candidates.set(binding.sessionId, binding.sessionId);
      for (const s of binding.sessions ?? []) candidates.set(s.sessionId, s.workDir);
      for (const [sessionId, workDir] of candidates) {
        if (workDir === "") continue;
        try {
          const ws = await registry.resolveByPath(workDir);
          if (ws?.attachSession !== undefined) {
            const prior = workDirToWorkspace.get(workDir.toLowerCase());
            if (prior === undefined) workDirToWorkspace.set(workDir.toLowerCase(), ws);
            await ws.attachSession(sessionId as never);
          }
        } catch {
          // Best-effort: a session whose directory disappeared is skipped.
        }
      }
    }
  }

  /** Register a channel adapter; its inbound messages route through here. */
  registerAdapter(adapter: ChannelAdapter): void {
    if (this.adapters.has(adapter.id)) {
      throw new Error(`connect: channel "${adapter.id}" is already registered`);
    }
    // Wrap outbound delivery with bounded retry so transient channel failures
    // (network blips, 429/5xx) don't silently drop user-visible messages.
    const wrapped = withOutboundRetry(adapter, OUTBOUND_RETRY);
    this.adapters.set(adapter.id, wrapped);
    wrapped.onInbound((msg) => {
      void this.handleInbound(msg).catch((error) => {
        // Inbound handling runs detached; surface failures instead of letting
        // them become silent unhandled rejections.
        this.ctx.logger?.error?.(
          `connect: inbound handling failed (${msg.channel}/${msg.chatKey}): ${String(error)}`,
        );
      });
    });
  }

  getAdapter(id: string): ChannelAdapter | undefined {
    return this.adapters.get(id);
  }

  /** Allowlist gate for inbound messages (users + chats). Empty list = allow all. */
  isAllowed(msg: InboundMessage): boolean {
    return this.isChatAllowed(msg.channel, msg.chatKey, msg.senderKey);
  }

  /**
   * Adapter-side pre-check (channel + chat key + sender key only, no message
   * object). Channel adapters call this *before* downloading message resources
   * so rejected senders' files never touch disk.
   */
  isChatAllowed(channel: string, chatKey: string, senderKey: string): boolean {
    if (this.config.allowUsers.length > 0 && !this.config.allowUsers.includes(senderKey)) return false;
    if (this.config.allowChats.length > 0 && !this.config.allowChats.includes(chatKey)) return false;
    void channel; // allowlists are global; kept for a future per-channel policy
    return true;
  }

  /** Entry point every adapter forwards normalized messages into. */
  async handleInbound(msg: InboundMessage): Promise<void> {
    if (!this.isAllowed(msg)) return;
    const adapter = this.adapters.get(msg.channel);
    if (adapter === undefined) return;

    // Channel SDKs can re-deliver the same event after a reconnect; skip the
    // duplicate so the user's message is not queued twice.
    if (this.dedup.isDuplicate(msg.channel, msg.chatKey, msg.replyRef)) {
      this.ctx.logger?.warn?.(`connect: dropped duplicate inbound (${msg.channel}/${msg.chatKey} msg=${msg.replyRef})`);
      return;
    }

    // A question (ask_user_question) is waiting on this chat: plain text is
    // the user's answer. Commands (starting with "/") still go to the runner
    // so /stop etc. keep working while the agent waits.
    if (!msg.text.trim().startsWith("/") && this.interaction.pendingFor(msg.chatKey)) {
      this.interaction.answerText(msg.chatKey, msg.text);
      return;
    }

    // Subscribe to host question/approval frames (idempotent, best-effort).
    this.interaction.start();

    // Make sure the DSH workspace registry knows about our work dirs and
    // sessions before the first runner spins up. Awaiting guarantees the
    // workspace exists before a new session is created and attached to it
    // (the registry flag makes subsequent calls a no-op).
    await this.ensureWorkspacesRegistered();

    this.routeInbound(msg);
  }

  /**
   * Route a message to the runner of its (channel, chatKey) pair, creating
   * the runner lazily. Also used to replay queued mirror-lock messages into
   * the runner of their own channel instead of whichever runner released
   * the lock.
   */
  private routeInbound(msg: InboundMessage): void {
    const key = runnerKey(msg.channel, msg.chatKey);
    let runner = this.runners.get(key);
    if (runner === undefined) {
      const adapter = this.adapters.get(msg.channel);
      if (adapter === undefined) return;
      runner = new AgentRunner(
        this.ctx,
        this.config,
        msg.channel,
        msg.chatKey,
        msg.chatType,
        adapter,
        this.bindings,
        this.adapters,
        (m) => this.routeInbound(m),
        this.reminders,
      );
      this.runners.set(key, runner);
    }
    runner.enqueue(msg);
  }

  /**
   * Proactive push for work arrangement: goals/jobs/schedule hooks call this to
   * deliver progress or completion notices back to a bound chat.
   */
  async notify(channel: string, chatKey: string, chatType: "p2p" | "group", markdown: string): Promise<void> {
    const adapter = this.adapters.get(channel);
    if (adapter === undefined) return;
    await adapter.sendText({ chatKey, chatType }, markdown);
  }

  /**
   * Broadcast a message to every bound chat. Admin-gated: requires a
   * non-empty `allowUsers` and a sender listed in it. Returns how many
   * chats received the message; per-chat delivery failures are skipped.
   */
  async broadcast(senderKey: string, markdown: string): Promise<{ ok: boolean; reason?: "disabled" | "not-admin"; count?: number }> {
    if (this.config.allowUsers.length === 0) return { ok: false, reason: "disabled" };
    if (!this.config.allowUsers.includes(senderKey)) return { ok: false, reason: "not-admin" };
    let count = 0;
    const seen = new Set<string>();
    for (const binding of this.bindings.list()) {
      const key = `${binding.channel}\u0000${binding.chatKey}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const adapter = this.adapters.get(binding.channel);
      if (adapter === undefined) continue;
      try {
        await adapter.sendText({ chatKey: binding.chatKey, chatType: binding.chatType }, markdown);
        count += 1;
      } catch (error) {
        this.ctx.logger?.warn?.(`connect: broadcast skipped (${binding.channel}/${binding.chatKey}): ${String(error)}`);
      }
    }
    return { ok: true, count };
  }
}
