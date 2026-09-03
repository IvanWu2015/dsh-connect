/**
 * DingTalk group-robot webhook transport. A webhook URL is created from a
 * group's "custom robot" (群自定义机器人): the group owner adds a robot, gets
 * an `access_token`, and optionally enables a signing secret. This transport
 * only *pushes* — DingTalk custom webhooks cannot receive messages, so this
 * package is a one-way notice channel (progress / results / alerts), not a
 * bidirectional conversation adapter like the Feishu one.
 *
 * @module dsh-connect/channels/dingtalk/webhook
 */
import { createHmac, timingSafeEqual } from "node:crypto";

/** DingTalk webhook configuration. */
export interface DingtalkWebhookConfig {
  /** Full webhook URL, e.g. `https://oapi.dingtalk.com/robot/send?access_token=xxx`. */
  webhookUrl: string;
  /** Optional signing secret (`SEC...`) — when set, requests are signed. */
  secret?: string;
  /** HTTP timeout in ms (default 10s). */
  timeoutMs?: number;
  /** Backoff delays between retries for transient network errors (default 1s/2s/4s). */
  retryDelaysMs?: readonly number[];
  /** Extra delay for the 130101 frequency-limit retry (default 10s). */
  rateLimitDelayMs?: number;
}

/** Body shape accepted by the DingTalk robot API. */
export type DingtalkBody = {
  msgtype: "text";
  text: { content: string };
  at?: { atMobiles?: string[]; atUserIds?: string[]; isAtAll?: boolean };
} | {
  msgtype: "markdown";
  markdown: { title: string; text: string };
  at?: { atMobiles?: string[]; atUserIds?: string[]; isAtAll?: boolean };
};

/** Response of the DingTalk robot API. */
export interface DingtalkResponse {
  errcode: number;
  errmsg: string;
}

/** How to address people in a DingTalk group. */
export interface DingtalkAt {
  /** Phone numbers — required by DingTalk for `atMobiles` (robots can't resolve names). */
  mobiles?: readonly string[];
  /** User ids (unionid/`userId` when known). */
  userIds?: readonly string[];
  /** @everyone. */
  all?: boolean;
}

/** DingTalk caps markdown body text at 20000 chars. */
export const MARKDOWN_LIMIT = 20_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Compute the DingTalk webhook signature. The SDK expects
 * `timestamp + "\n" + secret` signed with HMAC-SHA256, base64-encoded, then
 * URL-encoded as the `sign` query param.
 */
export function signDingtalk(secret: string, timestampMs: number): string {
  const stringToSign = `${timestampMs}\n${secret}`;
  const mac = createHmac("sha256", secret).update(stringToSign, "utf8").digest("base64");
  return encodeURIComponent(mac);
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value; // not URL-encoded — compare as-is
  }
}

/**
 * Verify an incoming signature against a secret (used by webhook receivers, if
 * ever needed). Both sides are compared after URL-decoding, so a sender that
 * encoded `+` as `%2B` (or vice versa) still verifies, and the timestamp must
 * be fresh (default: ±5 minutes) to be replay-resistant.
 */
export function verifyDingtalkSignature(
  secret: string,
  timestampMs: string,
  sign: string,
  nowMs: number = Date.now(),
  maxAgeMs: number = 5 * 60_000,
): boolean {
  const ts = Number(timestampMs);
  if (!Number.isFinite(ts) || Math.abs(nowMs - ts) > maxAgeMs) return false;
  const expected = signDingtalk(secret, ts);
  const a = Buffer.from(safeDecode(sign));
  const b = Buffer.from(safeDecode(expected));
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Replace non-url-safe chars in a DingTalk webhook URL's query (idempotent-safe). */
function withSignature(url: string, secret: string, timestampMs: number): string {
  const sign = signDingtalk(secret, timestampMs);
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}timestamp=${timestampMs}&sign=${sign}`;
}

/** Errors that are safe to retry: transient network issues and the frequency limit. */
function isRetryable(error: unknown): boolean {
  const errcode = (error as { errcode?: number }).errcode;
  if (errcode === 130101) return true; // 发送频率限制 (20/min per robot)
  if (error instanceof TypeError) return true; // fetch network failure
  return false;
}

function delayFor(config: DingtalkWebhookConfig, error: unknown, attempt: number): number {
  const errcode = (error as { errcode?: number }).errcode;
  if (errcode === 130101) return config.rateLimitDelayMs ?? 10_000; // rate limit: wait for the window to pass
  const backoff = config.retryDelaysMs;
  if (backoff !== undefined && backoff.length > 0) return backoff[Math.min(attempt, backoff.length - 1)] ?? 1_000;
  return 1_000 * 2 ** attempt; // 1s, 2s, 4s…
}

const MAX_ATTEMPTS = 3;

/**
 * Minimal DingTalk group-robot webhook client built on the global `fetch`
 * (Node ≥ 18 / ≥ 20 — no third-party HTTP dependency). Transient failures
 * (network errors, the 20/min frequency limit) are retried with backoff.
 */
export class DingtalkWebhook {
  readonly config: DingtalkWebhookConfig;

  constructor(config: DingtalkWebhookConfig) {
    if (!config.webhookUrl || !config.webhookUrl.startsWith("https://")) {
      throw new Error("connect-dingtalk: webhookUrl must be a https:// DingTalk robot URL");
    }
    this.config = config;
  }

  /**
   * Send a markdown message. `title` is shown as the message's card title in
   * DingTalk; `text` is the markdown body (truncated to 20000 chars, the API
   * limit). Optionally @-mention people.
   */
  async sendMarkdown(title: string, text: string, at?: DingtalkAt): Promise<DingtalkResponse> {
    const body = text.length > MARKDOWN_LIMIT ? `${text.slice(0, MARKDOWN_LIMIT)}\n\n…(已截断)` : text;
    return this.send({ msgtype: "markdown", markdown: { title, text: body }, at: atBody(at) });
  }

  /** Send a plain-text message (content shown verbatim, `\n` newlines allowed). */
  async sendText(content: string, at?: DingtalkAt): Promise<DingtalkResponse> {
    return this.send({ msgtype: "text", text: { content }, at: atBody(at) });
  }

  private async send(body: DingtalkBody, attempt = 0): Promise<DingtalkResponse> {
    const { webhookUrl, secret, timeoutMs = 10_000 } = this.config;
    const url = secret ? withSignature(webhookUrl, secret, Date.now()) : webhookUrl;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`connect-dingtalk: HTTP ${response.status} ${response.statusText}`);
      }
      const parsed = (await response.json()) as DingtalkResponse;
      if (parsed.errcode !== 0) {
        const error = new Error(`connect-dingtalk: DingTalk error ${parsed.errcode}: ${parsed.errmsg}`);
        (error as { errcode?: number }).errcode = parsed.errcode;
        throw error;
      }
      return parsed;
    } catch (error) {
      if (isRetryable(error) && attempt < MAX_ATTEMPTS) {
        await sleep(delayFor(this.config, error, attempt));
        return this.send(body, attempt + 1);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

interface AtPayload {
  atMobiles?: string[];
  atUserIds?: string[];
  isAtAll?: boolean;
}

function atBody(at?: DingtalkAt): AtPayload | undefined {
  if (at === undefined) return undefined;
  return {
    ...(at.mobiles !== undefined && at.mobiles.length > 0 ? { atMobiles: [...at.mobiles] } : {}),
    ...(at.userIds !== undefined && at.userIds.length > 0 ? { atUserIds: [...at.userIds] } : {}),
    ...(at.all === true ? { isAtAll: true } : {}),
  };
}
