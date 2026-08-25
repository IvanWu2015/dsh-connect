/**
 * Pure message normalization for the DingTalk stream mode: raw gateway
 * payloads → dsh-connect `InboundMessage`, and STOMP reply bodies for the
 * reply destination. Kept free of sockets so every branch is unit-testable.
 * @module dsh-connect-dingtalk/message
 */
import type { InboundMessage } from "dsh-connect";

/** Raw inbound message payload pushed by the stream gateway. */
export interface DingtalkBotMessage {
  senderStaffId?: string;
  senderNick?: string;
  /** Stable conversation id ("cid…"). */
  conversationId?: string;
  /** "1" = single chat, "2" = group chat. */
  conversationType?: string;
  msgId?: string;
  msgType?: string;
  text?: { content?: string };
  /** True when the message @-mentioned the bot (group chats). */
  isInAtList?: boolean;
  /** Mentioned users when `isInAtList` is true. */
  atUsers?: Array<{ dingtalkId?: string; staffId?: string }>;
}

/** STOMP destination the gateway pushes inbound bot messages on. */
export const INBOUND_DESTINATION = "/v1.0/im/bot/messages/get";
/** STOMP destination replies are SENT to. */
export const REPLY_DESTINATION = "/v1.0/im/bot/messages/reply";
/** STOMP subscription id used for the inbound topic. */
export const INBOUND_SUBSCRIPTION = "inbound";

/** True when the message @-mentioned the bot (used for group requireMention). */
export function isAtMentioned(msg: DingtalkBotMessage): boolean {
  return msg.isInAtList === true;
}

/**
 * Normalize a gateway payload into an `InboundMessage`. Returns `undefined`
 * for payloads that cannot be routed (missing conversation/sender) or that
 * carry no usable text body.
 */
export function normalizeBotMessage(raw: DingtalkBotMessage, channel = "dingtalk"): InboundMessage | undefined {
  if (typeof raw.conversationId !== "string" || raw.conversationId === "") return undefined;
  if (typeof raw.senderStaffId !== "string" || raw.senderStaffId === "") return undefined;
  const text = raw.msgType === "text" ? (raw.text?.content ?? "") : "";
  return {
    channel,
    chatKey: raw.conversationId,
    chatType: raw.conversationType === "2" ? "group" : "p2p",
    senderKey: raw.senderStaffId,
    text,
    ...(typeof raw.msgId === "string" && raw.msgId !== "" ? { replyRef: raw.msgId } : {}),
  };
}

/** JSON body for a plain-text reply to a message. */
export function buildTextReplyBody(msgId: string, content: string): string {
  return JSON.stringify({ msgKey: "sampleText", msgParam: { content }, msgId });
}

/** JSON body for a markdown reply to a message. */
export function buildMarkdownReplyBody(msgId: string, title: string, text: string): string {
  return JSON.stringify({ msgKey: "sampleMarkdown", msgParam: { title, text }, msgId });
}

/** JSON body for the STOMP CONNECT frame. */
export function buildConnectBody(clientId: string, clientSecret: string): string {
  return JSON.stringify({ clientId, clientSecret, protocolVersion: "1.0" });
}
