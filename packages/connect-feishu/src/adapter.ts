/**
 * Feishu transport over the official SDK's `createLarkChannel`. The SDK handles
 * WebSocket handshake, auto-reconnect, message normalization, @-mention policy,
 * streaming typewriter cards, and media — the adapter only maps DSH shapes.
 * @module dsh-connect-feishu/adapter
 */
import { createLarkChannel, LoggerLevel, type CardActionEvent } from "@larksuiteoapi/node-sdk";
import type {
  ChannelAdapter,
  ChoicePrompt,
  InboundMessage,
  OutboundTarget,
  SummaryCard,
} from "dsh-connect";

export interface FeishuConfig {
  appId?: string;
  appSecret?: string;
  transport?: "websocket" | "webhook";
  verificationToken?: string;
  encryptKey?: string;
  /** Group messages must @-mention the bot (default true). */
  requireMention?: boolean;
  /** Single-chat policy (SDK values): open / allowlist / pair / disabled. */
  dmMode?: "open" | "allowlist" | "pair" | "disabled";
}

type LarkChannel = ReturnType<typeof createLarkChannel>;

interface NormalizedMsg {
  messageId: string;
  chatId: string;
  chatType: "p2p" | "group";
  senderId: string;
  content: string;
}

interface PendingChoice {
  resolve: (choice: string | undefined) => void;
  timer: NodeJS.Timeout;
}

const CHOICE_TIMEOUT_MS = 60_000;

export class FeishuAdapter implements ChannelAdapter {
  readonly id = "feishu";
  private readonly channel: LarkChannel;
  private readonly pendingChoices = new Map<string, PendingChoice>();
  private handler?: (msg: InboundMessage) => void | Promise<void>;

  constructor(config: FeishuConfig, private readonly logger?: { warn?: (...args: unknown[]) => void; error?: (...args: unknown[]) => void }) {
    const appId = config.appId ?? process.env.FEISHU_APP_ID;
    const appSecret = config.appSecret ?? process.env.FEISHU_APP_SECRET;
    if (!appId || !appSecret) {
      throw new Error("connect-feishu: appId and appSecret are required (config or FEISHU_APP_ID / FEISHU_APP_SECRET)");
    }

    const transport = config.transport ?? "websocket";
    this.channel = createLarkChannel({
      appId,
      appSecret,
      transport,
      ...(transport === "webhook"
        ? {
            webhook: {
              ...(config.verificationToken ? { verificationToken: config.verificationToken } : {}),
              ...(config.encryptKey ? { encryptKey: config.encryptKey } : {}),
            },
          }
        : {}),
      policy: {
        requireMention: config.requireMention ?? true,
        dmMode: config.dmMode ?? "open",
      },
      loggerLevel: LoggerLevel.info,
    });
  }

  onInbound(handler: (msg: InboundMessage) => void | Promise<void>): void {
    this.handler = handler;
  }

  async start(): Promise<void> {
    this.channel.on("message", async (msg: NormalizedMsg) => {
      await this.handler?.({
        channel: "feishu",
        chatKey: msg.chatId,
        chatType: msg.chatType,
        senderKey: msg.senderId,
        text: msg.content,
        replyRef: msg.messageId,
      });
    });

    this.channel.on("cardAction", (evt: CardActionEvent) => {
      const pending = this.pendingChoices.get(evt.messageId);
      if (pending === undefined) return;
      this.pendingChoices.delete(evt.messageId);
      clearTimeout(pending.timer);
      const value = evt.action.value as { choice?: string } | undefined;
      pending.resolve(value?.choice);
    });

    this.channel.on("reject", (evt: unknown) => {
      this.logger?.warn?.(`connect-feishu: rejected inbound message: ${JSON.stringify(evt)}`);
    });

    this.channel.on("error", (err: unknown) => {
      this.logger?.error?.(`connect-feishu: inbound dispatcher error: ${String(err)}`);
    });

    await this.channel.connect();
  }

  async stop(): Promise<void> {
    await this.channel.disconnect();
  }

  async sendText(target: OutboundTarget, text: string): Promise<void> {
    await this.channel.send(
      target.chatKey,
      { text },
      { ...(target.replyRef === undefined ? {} : { replyTo: target.replyRef }) },
    );
  }

  async sendCard(target: OutboundTarget, card: SummaryCard): Promise<void> {
    await this.channel.send(
      target.chatKey,
      { markdown: card.markdown },
      { ...(target.replyRef === undefined ? {} : { replyTo: target.replyRef }) },
    );
  }

  async streamText(target: OutboundTarget, chunks: AsyncIterable<string>): Promise<void> {
    await this.channel.stream(
      target.chatKey,
      {
        markdown: async (sink: { append(chunk: string): Promise<void> }) => {
          for await (const chunk of chunks) {
            await sink.append(chunk);
          }
        },
      },
      { ...(target.replyRef === undefined ? {} : { replyTo: target.replyRef }) },
    );
  }

  async promptChoice(target: OutboundTarget, prompt: ChoicePrompt): Promise<string | undefined> {
    const card = {
      header: { title: { tag: "plain_text", content: prompt.title }, template: "blue" },
      elements: [
        ...(prompt.description === undefined
          ? []
          : [{ tag: "div", text: { tag: "plain_text", content: prompt.description } }]),
        {
          tag: "action",
          actions: prompt.options.map((opt) => ({
            tag: "button",
            text: { tag: "plain_text", content: opt.label },
            type: "default",
            value: { choice: opt.id },
          })),
        },
      ],
    };
    const { messageId } = await this.channel.send(
      target.chatKey,
      { card },
      { ...(target.replyRef === undefined ? {} : { replyTo: target.replyRef }) },
    );
    return await new Promise<string | undefined>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingChoices.delete(messageId);
        resolve(undefined);
      }, CHOICE_TIMEOUT_MS);
      this.pendingChoices.set(messageId, { resolve, timer });
    });
  }
}
