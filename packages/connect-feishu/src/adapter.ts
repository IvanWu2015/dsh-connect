/**
 * Feishu transport over the official SDK's `createLarkChannel`. The SDK handles
 * WebSocket handshake, auto-reconnect, message normalization, @-mention policy,
 * streaming typewriter cards, and media — the adapter only maps DSH shapes.
 * @module dsh-connect-feishu/adapter
 */
import { createLarkChannel, LoggerLevel, type CardActionEvent } from "@larksuiteoapi/node-sdk";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ChannelAdapter,
  ChoiceOption,
  ChoicePrompt,
  ChoiceResult,
  InboundMessage,
  OutboundTarget,
  SummaryCard,
} from "dsh-connect";

/** Zero-width / variation-selector chars that render at width 0. */
const ZERO_WIDTH = new Set([0x200b, 0x200c, 0x200d, 0xfe0e, 0xfe0f]);

/** Approximate rendered width: full-width (CJK/emoji) chars count 2, others 1. */
function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (ZERO_WIDTH.has(cp)) continue;
    w += cp > 0xff ? 2 : 1;
  }
  return w;
}

/** Pad every label with trailing spaces up to the same display width. */
function padLabels(options: readonly ChoiceOption[]): ChoiceOption[] {
  const widths = options.map((o) => displayWidth(o.label));
  const max = Math.max(0, ...widths);
  // Cap the padding target so very long labels don't force wrapping everywhere.
  const target = Math.min(20, max);
  return options.map((o) => {
    const pad = Math.max(0, target - displayWidth(o.label));
    if (pad === 0) return o;
    // Full-width spaces (U+3000, 2 units) resist collapsing; a trailing
    // half-width space covers an odd leftover unit.
    const full = Math.floor(pad / 2);
    const half = pad % 2;
    return { ...o, label: o.label + "　".repeat(full) + (half ? " " : "") };
  });
}

/**
 * Render options as an equal-width button grid: 3 buttons per row via
 * `column_set` (three weighted columns), padding the last row with empty
 * columns so every row is a uniform 3-cell layout. Labels are padded to the
 * same display width so the buttons themselves render uniformly.
 */
function buildButtonGrid(options: readonly ChoiceOption[]): unknown[] {
  const padded = padLabels(options);
  const rows: unknown[] = [];
  for (let i = 0; i < padded.length; i += 3) {
    const group = padded.slice(i, i + 3);
    const columns = group.map((opt) => ({
      tag: "column",
      width: "weighted",
      weight: 1,
      vertical_align: "center",
      elements: [
        {
          tag: "button",
          text: { tag: "plain_text", content: opt.label },
          type: "default",
          value: { choice: opt.id },
        },
      ],
    }));
    while (columns.length < 3) {
      columns.push({ tag: "column", width: "weighted", weight: 1, vertical_align: "center", elements: [] });
    }
    rows.push({
      tag: "column_set",
      horizontal_spacing: "small",
      flex_mode: "none",
      columns,
    });
  }
  return rows;
}

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
  resources?: { type: string; fileKey: string }[];
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

  /** Download attached images to local temp files and return their paths. */
  private async downloadImages(msg: NormalizedMsg): Promise<string[]> {
    const resources = msg.resources?.filter((r) => r.type === "image") ?? [];
    if (resources.length === 0) return [];
    const dir = join(tmpdir(), "dsh-connect-images");
    try {
      mkdirSync(dir, { recursive: true });
    } catch {
      return [];
    }
    const paths: string[] = [];
    for (const r of resources) {
      try {
        const buf = await this.channel.downloadResource(r.fileKey, "image");
        const file = join(dir, `${msg.messageId}-${r.fileKey.replace(/[^a-zA-Z0-9]/g, "_")}`);
        writeFileSync(file, buf);
        paths.push(file);
      } catch {
        // Skip a failed download.
      }
    }
    return paths;
  }

  async start(): Promise<void> {
    this.channel.on("message", async (msg: NormalizedMsg) => {
      const images = await this.downloadImages(msg);
      await this.handler?.({
        channel: "feishu",
        chatKey: msg.chatId,
        chatType: msg.chatType,
        senderKey: msg.senderId,
        text: msg.content,
        replyRef: msg.messageId,
        ...(images.length > 0 ? { images } : {}),
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

  async promptChoice(target: OutboundTarget, prompt: ChoicePrompt, updateMessageId?: string): Promise<ChoiceResult> {
    const card = {
      header: { title: { tag: "plain_text", content: prompt.title }, template: "blue" },
      elements: [
        ...(prompt.description === undefined
          ? []
          : [{ tag: "div", text: { tag: "plain_text", content: prompt.description } }]),
        ...buildButtonGrid(prompt.options),
      ],
    };

    let messageId: string;
    if (updateMessageId !== undefined) {
      // Reuse the existing card: replace its content in place so a menu chain
      // navigates on one card instead of stacking new ones.
      await this.channel.updateCard(updateMessageId, card);
      messageId = updateMessageId;
    } else {
      ({ messageId } = await this.channel.send(
        target.chatKey,
        { card },
        { ...(target.replyRef === undefined ? {} : { replyTo: target.replyRef }) },
      ));
    }

    return await new Promise<ChoiceResult>((resolve) => {
      const timer = setTimeout(async () => {
        this.pendingChoices.delete(messageId);
        // Replace the stale menu with an expired notice instead of leaving it silent.
        await this.channel
          .updateCard(messageId, {
            header: { title: { tag: "plain_text", content: "菜单已过期" }, template: "grey" },
            elements: [{ tag: "note", elements: [{ tag: "plain_text", content: "请重新打开菜单。" }] }],
          })
          .catch(() => undefined);
        resolve({ choice: undefined, messageId });
      }, CHOICE_TIMEOUT_MS);
      this.pendingChoices.set(messageId, {
        resolve: (choice) => {
          this.pendingChoices.delete(messageId);
          clearTimeout(timer);
          resolve({ choice, messageId });
        },
        timer,
      });
    });
  }

  async closeMenu(messageId: string, summary: string): Promise<void> {
    await this.channel
      .updateCard(messageId, {
        header: { title: { tag: "plain_text", content: "✅ 完成" }, template: "green" },
        elements: [{ tag: "div", text: { tag: "plain_text", content: summary } }],
      })
      .catch(() => undefined);
  }
}
