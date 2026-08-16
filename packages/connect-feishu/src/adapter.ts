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
import type { Language } from "dsh-connect";
import { feishuMessages, type FeishuMessages } from "./i18n.js";

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
export function padLabels(options: readonly ChoiceOption[]): ChoiceOption[] {
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
 * Render options as an equal-width button grid: 2 buttons per row via
 * `column_set` (two weighted columns), padding the last row with empty
 * columns so every row is a uniform 2-cell layout. Labels are padded to the
 * same display width so the buttons themselves render uniformly. Destructive
 * actions (labels starting with ❌) render as red danger buttons.
 */
export function buildButtonGrid(options: readonly ChoiceOption[], columnsPerRow: number = 2): unknown[] {
  const padded = padLabels(options);
  const rows: unknown[] = [];
  for (let i = 0; i < padded.length; i += columnsPerRow) {
    const group = padded.slice(i, i + columnsPerRow);
    const columns = group.map((opt) => ({
      tag: "column",
      width: "weighted",
      weight: 1,
      vertical_align: "center",
      elements: [
        {
          tag: "button",
          text: { tag: "plain_text", content: opt.label },
          type: opt.label.startsWith("❌") ? "danger" : "default",
          value: { choice: opt.id },
        },
      ],
    }));
    while (columns.length < columnsPerRow) {
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

/**
 * Assemble the card elements for a choice prompt. When `sections` is given,
 * the options are split into titled groups — each with a bold section caption
 * and a divider before it — instead of one flat grid. Options not listed in
 * any section (typically the trailing exit/back buttons) are rendered after
 * the sections, separated by a divider.
 * 
 * @param prompt - The choice prompt to render
 * @param defaultColumns - Default number of columns per row (default: 2)
 */
export function buildChoiceElements(prompt: ChoicePrompt, defaultColumns: number = 2): unknown[] {
  const { options, sections } = prompt;
  if (sections === undefined || sections.length === 0) return buildButtonGrid(options, defaultColumns);
  const byId = new Map(options.map((o) => [o.id, o]));
  const listed = new Set(sections.flatMap((s) => s.ids));
  const elements: unknown[] = [];
  let firstSection = true;
  for (const section of sections) {
    const group = section.ids.map((id) => byId.get(id)).filter((o): o is ChoiceOption => o !== undefined);
    if (group.length === 0) continue;
    if (!firstSection) elements.push({ tag: "hr" });
    firstSection = false;
    if (section.title !== undefined) {
      elements.push({ tag: "div", text: { tag: "lark_md", content: `**${section.title}**` } });
    }
    // Use section-specific columns if defined, otherwise use prompt default
    const sectionColumns = section.columnsPerRow ?? defaultColumns;
    elements.push(...buildButtonGrid(group, sectionColumns));
  }
  const rest = options.filter((o) => !listed.has(o.id));
  if (rest.length > 0) {
    elements.push({ tag: "hr" });
    elements.push(...buildButtonGrid(rest, defaultColumns));
  }
  return elements;
}

/** Collect a Node.js readable stream into a single Buffer. */
function collectStream(stream: NodeJS.ReadableStream): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer | string) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

/** Strip path separators / control chars from a downloaded file's name. */
export function sanitizeFileName(name: string): string {
  const clean = name
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
    .trim()
    .slice(0, 200);
  return clean === "" ? "file" : clean;
}

/**
 * Extract a human-readable error detail. Feishu business errors (missing
 * permission, invalid resource, …) arrive as HTTP 200/400 with the real
 * `{code, msg}` in the response body; prefer that over the axios fallback
 * message like "Request failed with status code 400" that hides the cause.
 */
export function extractErrorDetail(error: unknown): string {
  const raw = error as
    | { response?: { status?: number; data?: { code?: unknown; msg?: unknown; message?: unknown } } }
    | undefined;
  const body = raw?.response?.data;
  if (body !== undefined && (body.code !== undefined || body.msg !== undefined || body.message !== undefined)) {
    const status = raw?.response?.status;
    const detail = [body.code !== undefined ? `code=${String(body.code)}` : "", body.msg ?? body.message]
      .map((s) => String(s))
      .filter((s) => s !== "")
      .join(" ");
    return `HTTP ${status ?? "?"}${detail ? `（${detail}）` : ""}`;
  }
  return error instanceof Error ? error.message : String(error);
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
  /** User-facing message language: `zh` (default) or `en`. */
  language?: Language;
}

type LarkChannel = ReturnType<typeof createLarkChannel>;

interface NormalizedMsg {
  messageId: string;
  chatId: string;
  chatType: "p2p" | "group";
  senderId: string;
  content: string;
  resources?: { type: string; fileKey: string; fileName?: string }[];
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
  private readonly t: FeishuMessages;
  private handler?: (msg: InboundMessage) => void | Promise<void>;

  constructor(config: FeishuConfig, private readonly logger?: { warn?: (...args: unknown[]) => void; error?: (...args: unknown[]) => void }) {
    const appId = config.appId ?? process.env.FEISHU_APP_ID;
    const appSecret = config.appSecret ?? process.env.FEISHU_APP_SECRET;
    if (!appId || !appSecret) {
      throw new Error("connect-feishu: appId and appSecret are required (config or FEISHU_APP_ID / FEISHU_APP_SECRET)");
    }
    this.t = feishuMessages(config.language ?? "zh");

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

  /** Resource types downloadable via `im.v1.messageResource.get`. Stickers are not supported by the Feishu API. */
  private static readonly DOWNLOADABLE_TYPES = new Set(["image", "file", "audio", "video"]);

  /** Download attached images / files into local temp dirs; return their paths (and any failures). */
  private async downloadResources(msg: NormalizedMsg): Promise<{
    images: string[];
    files: string[];
    imageError?: string;
    fileError?: string;
  }> {
    const resources = msg.resources?.filter((r) => FeishuAdapter.DOWNLOADABLE_TYPES.has(r.type)) ?? [];
    if (resources.length === 0) return { images: [], files: [] };
    const imagesDir = join(tmpdir(), "dsh-connect-images");
    const filesDir = join(tmpdir(), "dsh-connect-files");
    try {
      mkdirSync(imagesDir, { recursive: true });
      mkdirSync(filesDir, { recursive: true });
    } catch (error) {
      return { images: [], files: [], imageError: this.t.tempDirFailed(String(error)), fileError: this.t.tempDirFailed(String(error)) };
    }
    const images: string[] = [];
    const files: string[] = [];
    let imageFailed = 0;
    let fileFailed = 0;
    let firstImageError: string | undefined;
    let firstFileError: string | undefined;
    for (const r of resources) {
      const isImage = r.type === "image";
      const target = isImage ? images : files;
      try {
        const buf = await this.downloadMessageResource(msg.messageId, r.fileKey, r.type);
        const dir = isImage ? imagesDir : filesDir;
        const name = isImage
          ? `${msg.messageId}-${r.fileKey.replace(/[^a-zA-Z0-9]/g, "_")}`
          : `${msg.messageId}-${sanitizeFileName(r.fileName ?? `${r.type}-${r.fileKey}`)}`;
        const file = join(dir, name);
        writeFileSync(file, buf);
        target.push(file);
      } catch (error) {
        const detail = extractErrorDetail(error);
        if (isImage) {
          imageFailed += 1;
          firstImageError ??= detail;
          this.logger?.warn?.(this.t.imageDownloadLog(r.fileKey, detail));
        } else {
          fileFailed += 1;
          firstFileError ??= detail;
          this.logger?.warn?.(this.t.fileDownloadLog(r.fileKey, detail));
        }
      }
    }
    const out: { images: string[]; files: string[]; imageError?: string; fileError?: string } = { images, files };
    if (images.length === 0 && imageFailed > 0) {
      // Keep the real Feishu error code/detail so the user can pinpoint the
      // actual missing permission instead of a generic hint.
      const detail = firstImageError === undefined ? "" : this.t.errorDetail(firstImageError.slice(0, 200));
      out.imageError = this.t.imageDownloadError(imageFailed, detail);
    }
    if (files.length === 0 && fileFailed > 0) {
      const detail = firstFileError === undefined ? "" : this.t.errorDetail(firstFileError.slice(0, 200));
      out.fileError = this.t.fileDownloadError(fileFailed, detail);
    }
    return out;
  }

  /**
   * Download a resource inside a user message.
   *
   * Note: do NOT use the SDK's `downloadResource(fileKey, type)` — it calls
   * `im.v1.image.get` / `im.v1.file.get` (download image / download file), and
   * per the Feishu docs those endpoints **can only download resources uploaded
   * by the bot itself**. Resources inside user-sent messages must be fetched
   * with "get resource file from message" `im.v1.messageResource.get` (with
   * message_id + type=image/file/audio/video), otherwise it returns HTTP 400.
   */
  private async downloadMessageResource(messageId: string, fileKey: string, type: string): Promise<Buffer> {
    const res = await this.channel.rawClient.im.v1.messageResource.get({
      path: { message_id: messageId, file_key: fileKey },
      params: { type },
    });
    return await collectStream(res.getReadableStream());
  }

  async start(): Promise<void> {
    this.channel.on("message", async (msg: NormalizedMsg) => {
      const dl = await this.downloadResources(msg);
      await this.handler?.({
        channel: "feishu",
        chatKey: msg.chatId,
        chatType: msg.chatType,
        senderKey: msg.senderId,
        text: msg.content,
        replyRef: msg.messageId,
        ...(dl.images.length > 0 ? { images: dl.images } : {}),
        ...(dl.files.length > 0 ? { files: dl.files } : {}),
        ...(dl.imageError === undefined ? {} : { imageError: dl.imageError }),
        ...(dl.fileError === undefined ? {} : { fileError: dl.fileError }),
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
    const columnsPerRow = prompt.columnsPerRow ?? 2;
    const card = {
      header: { title: { tag: "plain_text", content: prompt.title }, template: "indigo" },
      elements: [
        ...(prompt.description === undefined
          ? []
          : [{ tag: "div", text: { tag: "plain_text", content: prompt.description } }]),
        ...buildChoiceElements(prompt, columnsPerRow),
        ...(prompt.footer === undefined
          ? []
          : [{ tag: "note", elements: [{ tag: "plain_text", content: prompt.footer }] }]),
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
            header: { title: { tag: "plain_text", content: this.t.menuExpired }, template: "grey" },
            elements: [{ tag: "note", elements: [{ tag: "plain_text", content: this.t.menuExpiredHint }] }],
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
        header: { title: { tag: "plain_text", content: this.t.doneHeader }, template: "green" },
        elements: [{ tag: "div", text: { tag: "plain_text", content: summary } }],
      })
      .catch(() => undefined);
  }
}
