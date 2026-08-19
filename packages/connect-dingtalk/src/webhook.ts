/**
 * DingTalk group-robot webhook transport. A webhook URL is created from a
 * group's "custom robot" (群自定义机器人): the group owner adds a robot, gets
 * an `access_token`, and optionally enables a signing secret. This transport
 * only *pushes* — DingTalk custom webhooks cannot receive messages, so this
 * package is a one-way notice channel (progress / results / alerts), not a
 * bidirectional conversation adapter like the Feishu one.
 *
 * @module dsh-connect-dingtalk/webhook
 */
import { createHmac, createHash, timingSafeEqual } from "node:crypto";

/** DingTalk webhook configuration. */
export interface DingtalkWebhookConfig {
  /** Full webhook URL, e.g. `https://oapi.dingtalk.com/robot/send?access_token=xxx`. */
  webhookUrl: string;
  /** Optional signing secret (`SEC...`) — when set, requests are signed. */
  secret?: string;
  /** HTTP timeout in ms (default 10s). */
  timeoutMs?: number;
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

/** Verify an incoming signature against a secret (used by webhook receivers, if ever needed). */
export function verifyDingtalkSignature(secret: string, timestampMs: string, sign: string): boolean {
  const expected = signDingtalk(secret, Number(timestampMs));
  const a = Buffer.from(sign);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Replace non-url-safe chars in a DingTalk webhook URL's query (idempotent-safe). */
function withSignature(url: string, secret: string, timestampMs: number): string {
  const sign = signDingtalk(secret, timestampMs);
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}timestamp=${timestampMs}&sign=${sign}`;
}

/**
 * Minimal DingTalk group-robot webhook client built on the global `fetch`
 * (Node ≥ 18 / ≥ 20 — no third-party HTTP dependency).
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
   * DingTalk; `text` is the markdown body. Optionally @-mention people.
   */
  async sendMarkdown(title: string, text: string, at?: DingtalkAt): Promise<DingtalkResponse> {
    return this.send({ msgtype: "markdown", markdown: { title, text }, at: atBody(at) });
  }

  /** Send a plain-text message (content shown verbatim, `\n` newlines allowed). */
  async sendText(content: string, at?: DingtalkAt): Promise<DingtalkResponse> {
    return this.send({ msgtype: "text", text: { content }, at: atBody(at) });
  }

  private async send(body: DingtalkBody): Promise<DingtalkResponse> {
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
        throw new Error(`connect-dingtalk: DingTalk error ${parsed.errcode}: ${parsed.errmsg}`);
      }
      return parsed;
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

/** MD5 helper kept for parity with the official SDK's nonce flows (unused now). */
export function md5Hex(input: string): string {
  return createHash("md5").update(input, "utf8").digest("hex");
}
