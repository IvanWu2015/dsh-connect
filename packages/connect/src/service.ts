/**
 * The `connect` service (`ctx.connect`): adapter registry, inbound routing,
 * authorization, and the proactive `notify` entry point for work arrangement.
 * @module dsh-connect/service
 */
import { Service, type Context } from "@deepseek-ai/cordis";
import type { ChannelAdapter, InboundMessage } from "./types.js";
import { AgentRunner, resolveConnectConfig, type ConnectConfig, type ResolvedConnectConfig } from "./runner.js";
import { BindingStore } from "./binding.js";

function runnerKey(channel: string, chatKey: string): string {
  return `${channel}\u0000${chatKey}`;
}

export class ConnectService extends Service {
  readonly config: ResolvedConnectConfig;
  private readonly adapters = new Map<string, ChannelAdapter>();
  private readonly runners = new Map<string, AgentRunner>();
  private readonly bindings: BindingStore;

  constructor(ctx: Context, config: ConnectConfig = {}) {
    super(ctx, "connect");
    this.config = resolveConnectConfig(config);
    this.bindings = new BindingStore(this.config.stateDir);
  }

  /** Register a channel adapter; its inbound messages route through here. */
  registerAdapter(adapter: ChannelAdapter): void {
    if (this.adapters.has(adapter.id)) {
      throw new Error(`connect: channel "${adapter.id}" is already registered`);
    }
    this.adapters.set(adapter.id, adapter);
    adapter.onInbound((msg) => {
      void this.handleInbound(msg);
    });
  }

  getAdapter(id: string): ChannelAdapter | undefined {
    return this.adapters.get(id);
  }

  /** Allowlist check. Empty lists allow everyone on that axis. */
  isAllowed(msg: InboundMessage): boolean {
    if (this.config.allowUsers.length > 0 && !this.config.allowUsers.includes(msg.senderKey)) return false;
    if (this.config.allowChats.length > 0 && !this.config.allowChats.includes(msg.chatKey)) return false;
    return true;
  }

  /** Entry point every adapter forwards normalized messages into. */
  async handleInbound(msg: InboundMessage): Promise<void> {
    if (!this.isAllowed(msg)) return;
    const adapter = this.adapters.get(msg.channel);
    if (adapter === undefined) return;

    const key = runnerKey(msg.channel, msg.chatKey);
    let runner = this.runners.get(key);
    if (runner === undefined) {
      runner = new AgentRunner(
        this.ctx,
        this.config,
        msg.channel,
        msg.chatKey,
        msg.chatType,
        adapter,
        this.bindings,
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
}
