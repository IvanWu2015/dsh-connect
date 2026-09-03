/**
 * Feishu transport over the official SDK's `createLarkChannel`. The SDK handles
 * WebSocket handshake, auto-reconnect, message normalization, @-mention policy,
 * streaming typewriter cards, and media — the adapter only maps DSH shapes.
 * @module dsh-connect/channels/feishu/adapter
 */
import { createLarkChannel, adaptDefault, LoggerLevel, type CardActionEvent } from "@larksuiteoapi/node-sdk";
import { createServer, type Server } from "node:http";
import { readdir, rm, stat, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import type {
  ChannelAdapter,
  ChoiceOption,
  ChoicePrompt,
  ChoiceResult,
  InboundMessage,
  OutboundTarget,
  SummaryCard,
} from "../../types.js";
import type { Language } from "../../i18n.js";
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
 * Render options as a single-select dropdown (`select_static`) inside an
 * `action` container. Selecting an entry fires the card action with
 * `action.tag === "select_static"` and the picked option id in `action.option`.
 */
export function buildSelectMenu(options: readonly ChoiceOption[], placeholder = "请选择", initial?: string): unknown[] {
  return [
    {
      tag: "action",
      actions: [
        {
          tag: "select_static",
          placeholder: { tag: "plain_text", content: placeholder },
          ...(initial === undefined ? {} : { initial_option: initial }),
          options: options.map((o) => ({ text: { tag: "plain_text", content: o.label }, value: o.id })),
        },
      ],
    },
  ];
}

/** Largest option count that still renders as a button grid in auto mode. */
const AUTO_DROPDOWN_THRESHOLD = 6;

/**
 * Extract the chosen option id from a card action. Buttons carry the id in
 * `action.value.choice`; a `select_static` dropdown delivers the picked
 * option's id in `action.option` (a string).
 */
function choiceIdOf(evt: CardActionEvent): string | undefined {
  if (evt.action.tag === "select_static" || evt.action.tag === "select_person") {
    return evt.action.option;
  }
  const value = evt.action.value as { choice?: string } | undefined;
  return value?.choice;
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
  // Dropdown mode: an option-heavy set renders as a single select (Feishu
  // `select_static`) so the card stays compact. `auto` picks dropdown when the
  // flat list is large; explicit `buttons` always uses the grid. Sections do
  // not apply to a dropdown (it is one flat select), so a grouped prompt
  // stays on buttons unless explicitly forced to dropdown.
  const render = prompt.render ?? "buttons";
  const dropdown =
    render === "dropdown" ||
    (render === "auto" && (sections === undefined || sections.length === 0) && options.length > AUTO_DROPDOWN_THRESHOLD);
  if (dropdown) return buildSelectMenu(options, undefined, prompt.initialOption);
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

/** Collect a Node.js readable stream into a single Buffer with a size cap and a hard timeout. */
function collectStream(stream: NodeJS.ReadableStream, maxBytes = 20 * 1024 * 1024, timeoutMs = 60_000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    // Abort the stream on overflow/timeout. The SDK hands us a web
    // ReadableStream (no .destroy) — cancel it; Node streams also accept cancel
    // semantics via destroy.
    const abortStream = (): void => {
      const anyStream = stream as { destroy?: () => void; cancel?: () => Promise<unknown> };
      anyStream.destroy?.();
      const cancel = anyStream.cancel?.();
      if (cancel !== undefined) void cancel.catch(() => undefined);
    };
    const done = (value: Buffer): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const failed = (err: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    };
    const timer = setTimeout(() => {
      abortStream();
      failed(new Error(`download timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    stream.on("data", (chunk: Buffer | string) => {
      if (settled) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buf.length;
      if (total > maxBytes) {
        abortStream();
        failed(new Error(`download exceeds the ${Math.round(maxBytes / 1024 / 1024)}MB limit`));
        return;
      }
      chunks.push(buf);
    });
    stream.on("end", () => done(Buffer.concat(chunks)));
    stream.on("error", (err: Error) => failed(err));
  });
}

/**
 * Encode a chatKey with an optional thread id. With `threadIsolation` on, a
 * group message inside a thread gets `chatId:thread=<rootId>` as its chatKey,
 * so each thread binds its own DSH session while outbound sends still target
 * the base chat id (replies land in the thread via replyRef).
 */
export function encodeChatKey(chatId: string, threadId?: string): string {
  return threadId === undefined || threadId === "" ? chatId : `${chatId}:thread=${threadId}`;
}

/** Decode a possibly thread-scoped chatKey back to its base chat id. */
export function decodeChatKey(chatKey: string): { chatId: string; threadId?: string } {
  const sep = chatKey.indexOf(":thread=");
  if (sep === -1) return { chatId: chatKey };
  return { chatId: chatKey.slice(0, sep), threadId: chatKey.slice(sep + 8) };
}

/** Image extensions Feishu delivers as inline images; everything else is a file. */
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);

/** Classify a local file name for the Feishu upload API (image vs stream file). */
export function classifyFeishuFile(filename: string): "image" | "file" {
  const ext = extname(filename).toLowerCase();
  return IMAGE_EXTENSIONS.has(ext) ? "image" : "file";
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
  /** HTTP port for `transport: "webhook"` (default 9000). */
  webhookPort?: number;
  /** HTTP path the Feishu event callback posts to (default "/"). */
  webhookPath?: string;
  /** Group messages must @-mention the bot (default true). */
  requireMention?: boolean;
  /** Single-chat policy (SDK values): open / allowlist / pair / disabled. */
  dmMode?: "open" | "allowlist" | "pair" | "disabled";
  /** Bind one DSH session per group thread instead of one per chat (default false). */
  threadIsolation?: boolean;
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
  /** Cards whose stale-button tap was already noticed (dedupe, self-clearing). */
  private readonly staleNoticed = new Set<string>();
  private readonly staleTimers = new Set<NodeJS.Timeout>();
  private readonly t: FeishuMessages;
  private readonly transport: "websocket" | "webhook";
  private readonly webhookPort: number;
  private readonly webhookPath: string;
  private readonly threadIsolation: boolean;
  private server?: Server;
  private handler?: (msg: InboundMessage) => void | Promise<void>;

  constructor(
    config: FeishuConfig,
    private readonly logger?: { info?: (...args: unknown[]) => void; warn?: (...args: unknown[]) => void; error?: (...args: unknown[]) => void },
    private readonly isChatAllowed?: (channel: string, chatKey: string, senderKey: string) => boolean,
  ) {
    const appId = config.appId ?? process.env.FEISHU_APP_ID;
    const appSecret = config.appSecret ?? process.env.FEISHU_APP_SECRET;
    if (!appId || !appSecret) {
      throw new Error("connect-feishu: appId and appSecret are required (config or FEISHU_APP_ID / FEISHU_APP_SECRET)");
    }
    this.t = feishuMessages(config.language ?? "zh");

    this.transport = config.transport ?? "websocket";
    this.webhookPort = config.webhookPort ?? 9000;
    this.webhookPath = config.webhookPath ?? "/";
    this.threadIsolation = config.threadIsolation ?? false;
    this.channel = createLarkChannel({
      appId,
      appSecret,
      transport: this.transport,
      ...(this.transport === "webhook"
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
      await mkdir(imagesDir, { recursive: true });
      await mkdir(filesDir, { recursive: true });
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
        await writeFile(file, buf);
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

  /**
   * Housekeeping for the per-channel temp dirs: remove downloads older than
   * 24h so a busy bot doesn't fill the OS temp partition. Best-effort — a
   * failure to clean is logged, never fatal.
   */
  private async cleanupTempDirs(): Promise<void> {
    const dirs = [join(tmpdir(), "dsh-connect-images"), join(tmpdir(), "dsh-connect-files")];
    const MAX_AGE_MS = 24 * 60 * 60 * 1000;
    const now = Date.now();
    for (const dir of dirs) {
      let entries: string[];
      try {
        entries = await readdir(dir);
      } catch {
        continue; // directory never created — nothing to clean
      }
      for (const entry of entries) {
        const p = join(dir, entry);
        try {
          const st = await stat(p);
          if (now - st.mtimeMs > MAX_AGE_MS) await rm(p, { force: true });
        } catch (error) {
          this.logger?.warn?.(`connect-feishu: temp cleanup failed for ${p}: ${String(error)}`);
        }
      }
    }
  }

  async start(): Promise<void> {
    // Sweep stale downloads once at startup (cheap, bounded by dir size).
    await this.cleanupTempDirs().catch(() => undefined);

    this.channel.on("message", async (msg: NormalizedMsg) => {
      // First-line diagnostic: if the Feishu app is subscribed to
      // im.message.receive_v1 this fires for every inbound message. Its absence
      // when the user sends a message means events aren't being delivered at all.
      this.logger?.info?.(`connect-feishu: received message chat=${msg.chatId} sender=${msg.senderId} type=${msg.chatType} len=${String(msg.content?.length ?? 0)}`);
      // Allowlist gate BEFORE downloading anything: rejected senders' files
      // never touch disk (the core re-checks later for the full policy).
      if (this.isChatAllowed !== undefined && !this.isChatAllowed("feishu", msg.chatId, msg.senderId)) {
        this.logger?.warn?.(`connect-feishu: message from chat=${msg.chatId} sender=${msg.senderId} rejected by allowlist (skipped download)`);
        return;
      }
      // Guard the whole handling path: a throw here (download failure, adapter
      // error, or a throw from the core handler) must never become an unhandled
      // rejection — dsh web has no runtime fallback and the whole process would
      // exit mid-task.
      try {
      const dl = await this.downloadResources(msg);
      // With thread isolation, a message inside a group thread gets its own
      // chatKey (hence its own DSH session). The base chat id still drives the
      // allowlist gate above.
      const threadId = this.threadIsolation ? (msg as { root_id?: string }).root_id : undefined;
      await this.handler?.({
        channel: "feishu",
        chatKey: encodeChatKey(msg.chatId, threadId),
        chatType: msg.chatType,
        senderKey: msg.senderId,
        text: msg.content,
        replyRef: msg.messageId,
        ...(dl.images.length > 0 ? { images: dl.images } : {}),
        ...(dl.files.length > 0 ? { files: dl.files } : {}),
        ...(dl.imageError === undefined ? {} : { imageError: dl.imageError }),
        ...(dl.fileError === undefined ? {} : { fileError: dl.fileError }),
      });
      } catch (error) {
        this.logger?.error?.(`connect-feishu: message handling failed (chat=${msg.chatId} sender=${msg.senderId}): ${String(error)}`);
      }
    });

    this.channel.on("cardAction", (evt: CardActionEvent) => {
      const pending = this.pendingChoices.get(evt.messageId);
      if (pending === undefined) {
        // The card's interaction is no longer pending: it was already handled,
        // expired, or replaced by a newer card. Tell the user instead of
        // silently ignoring the tap — a stale authorization captions the
        // "did my tap do anything?" confusion. Wait: the core now also updates
        // the card in place on acceptance, so most stale taps hit cards the
        // user can see are done; this is the fallback for anything else.
        const choice = choiceIdOf(evt);
        if (choice !== undefined && !this.staleNoticed.has(evt.messageId)) {
          this.staleNoticed.add(evt.messageId);
          // Keep the notice once per card to avoid spam on repeated taps.
          const timer = setTimeout(() => {
            this.staleNoticed.delete(evt.messageId);
            this.staleTimers.delete(timer);
          }, 30_000);
          this.staleTimers.add(timer);
          void this.sendText({ chatKey: evt.chatId, chatType: "p2p" }, this.t.actionStale).catch(() => undefined);
        }
        return;
      }
      this.pendingChoices.delete(evt.messageId);
      clearTimeout(pending.timer);
      pending.resolve(choiceIdOf(evt));
    });

    this.channel.on("reject", (evt: unknown) => {
      // Log a compact reason — never the full event JSON (it carries message
      // content / sender PII).
      const e = evt as { reason?: unknown; code?: unknown; message?: unknown; msg?: { chatId?: string } } | undefined;
      const why = [e?.reason, e?.code, e?.message].map((v) => String(v)).filter((v) => v !== "" && v !== "undefined").join(" / ");
      const where = e?.msg?.chatId === undefined ? "" : ` chat=${e.msg.chatId}`;
      this.logger?.warn?.(`connect-feishu: inbound message rejected — ${why || "no detail"}${where}`);
    });

    this.channel.on("error", (err: unknown) => {
      this.logger?.error?.(`connect-feishu: inbound dispatcher error: ${String(err)}`);
    });

    await this.channel.connect();

    // Webhook transport: the SDK's doConnect only wires the dispatcher for WS;
    // for `transport: "webhook"` it expects the host to plug `channel.dispatcher`
    // into an HTTP handler. We host it here (URL verification is answered
    // automatically by the SDK's adaptDefault with autoChallenge).
    if (this.transport === "webhook") {
      // TS marks LarkChannel#dispatcher private even though it is public at
      // runtime; the SDK ships no exported type for it either.
      const dispatcher = (this.channel as unknown as { dispatcher: never }).dispatcher;
      const handler = adaptDefault(this.webhookPath, dispatcher, { autoChallenge: true });
      this.server = createServer((req, res) => {
        void handler(req, res).catch((error: unknown) => {
          this.logger?.error?.(`connect-feishu: webhook dispatch failed: ${String(error)}`);
          res.statusCode = 500;
          res.end("internal error");
        });
      });
      await new Promise<void>((resolve, reject) => {
        this.server!.once("error", reject);
        this.server!.listen(this.webhookPort, () => {
          this.server!.removeListener("error", reject);
          resolve();
        });
      });
      this.logger?.warn?.(`connect-feishu: webhook transport listening on http://0.0.0.0:${this.webhookPort}${this.webhookPath === "/" ? "" : this.webhookPath}`);
    }
  }

  async stop(): Promise<void> {
    // Release the webhook listener first so no new callbacks arrive mid-teardown.
    const server = this.server;
    this.server = undefined;
    if (server !== undefined) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    // Cancel outstanding choice/stale timers so stop() doesn't leave handles
    // that fire after disconnect.
    for (const pending of this.pendingChoices.values()) clearTimeout(pending.timer);
    this.pendingChoices.clear();
    for (const timer of this.staleTimers) clearTimeout(timer);
    this.staleTimers.clear();
    this.staleNoticed.clear();
    await this.channel.disconnect();
  }

  /** Base chat id for outbound sends (strips any `:thread=` suffix). */
  private chatIdOf(chatKey: string): string {
    return decodeChatKey(chatKey).chatId;
  }

  async sendText(target: OutboundTarget, text: string): Promise<void> {
    await this.channel.send(
      this.chatIdOf(target.chatKey),
      { text },
      this.sendOpts(target),
    );
  }

  async sendCard(target: OutboundTarget, card: SummaryCard): Promise<void> {
    await this.channel.send(
      this.chatIdOf(target.chatKey),
      { markdown: card.markdown },
      this.sendOpts(target),
    );
  }

  async streamText(target: OutboundTarget, chunks: AsyncIterable<string>): Promise<void> {
    await this.channel.stream(
      this.chatIdOf(target.chatKey),
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

  /**
   * Deliver a local file to the chat. The SDK uploads the source itself:
   * images are sent inline, everything else as an attachment.
   */
  async sendFile(target: OutboundTarget, filePath: string, options?: { filename?: string }): Promise<void> {
    const filename = options?.filename ?? basename(filePath);
    if (classifyFeishuFile(filename) === "image") {
      await this.channel.send(this.chatIdOf(target.chatKey), { image: { source: filePath } }, this.sendOpts(target));
    } else {
      await this.channel.send(this.chatIdOf(target.chatKey), { file: { source: filePath, fileName: filename } }, this.sendOpts(target));
    }
  }

  /**
   * Build the send options shared by text/markdown deliveries: an optional
   * reply target and @-mentions (SDK renders `<at user_id=…>` prefixes for
   * both text and post messages, so group completion cards can nudge the
   * requester).
   */
  private sendOpts(target: OutboundTarget): { replyTo?: string; mentions?: { key: string; openId: string }[] } {
    return {
      ...(target.replyRef === undefined ? {} : { replyTo: target.replyRef }),
      ...(target.atUsers === undefined || target.atUsers.length === 0
        ? {}
        : { mentions: target.atUsers.map((id) => ({ key: id, openId: id })) }),
    };
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
      messageId = updateMessageId;
    } else {
      ({ messageId } = await this.channel.send(
        this.chatIdOf(target.chatKey),
        { card },
        { ...(target.replyRef === undefined ? {} : { replyTo: target.replyRef }) },
      ));
    }

    // Register the pending choice BEFORE the async card update. Rapid taps on
    // the previous menu arrive while updateCard is still in flight; if the
    // pending record only exists after the redraw, those taps hit the stale
    // branch and the menu appears to swallow them ("can't go back"). Register
    // first, then redraw, so every tap has a live listener.
    let resolvePending!: (r: ChoiceResult) => void;
    const pending = new Promise<ChoiceResult>((resolve) => { resolvePending = resolve; });
    const registerPending = (id: string, timer: NodeJS.Timeout): void => {
      this.pendingChoices.set(id, {
        resolve: (choice) => {
          this.pendingChoices.delete(id);
          clearTimeout(timer);
          resolvePending({ choice, messageId: id });
        },
        timer,
      });
    };

    const timer = setTimeout(async () => {
      this.pendingChoices.delete(messageId);
      // Replace the stale menu with an expired notice instead of leaving it silent.
      await this.channel
        .updateCard(messageId, {
          header: { title: { tag: "plain_text", content: this.t.menuExpired }, template: "grey" },
          elements: [{ tag: "note", elements: [{ tag: "plain_text", content: this.t.menuExpiredHint }] }],
        })
        .catch(() => undefined);
      resolvePending({ choice: undefined, messageId });
    }, CHOICE_TIMEOUT_MS);
    registerPending(messageId, timer);

    if (updateMessageId !== undefined) {
      // Reuse the existing card when possible so a menu chain stays on one card.
      // But never leave the previous menu's content on screen: if the in-place
      // update fails, fall back to a fresh card so the correct options always
      // render, and rebind the tap listener to the fresh card's message id.
      try {
        await this.channel.updateCard(updateMessageId, card);
      } catch (error) {
        this.logger?.warn?.(`connect-feishu: menu card update failed (${String(error)}); sending a fresh card`);
        this.pendingChoices.delete(messageId);
        try {
          const sent = await this.channel.send(this.chatIdOf(target.chatKey), { card }, { ...(target.replyRef === undefined ? {} : { replyTo: target.replyRef }) });
          messageId = sent.messageId;
        } catch (sendError) {
          this.logger?.warn?.(`connect-feishu: fresh menu card send failed (${String(sendError)})`);
          messageId = updateMessageId;
        }
        registerPending(messageId, timer);
      }
    }
    return pending;
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
