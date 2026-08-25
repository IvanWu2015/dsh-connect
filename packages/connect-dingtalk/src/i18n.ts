/**
 * DingTalk-adapter user-facing strings (zh/en).
 * @module dsh-connect-dingtalk/i18n
 */
import type { Language } from "dsh-connect";

export interface DingtalkMessages {
  webhookMissing: string;
  webhookInvalid: string;
  sendFailed(error: string): string;
  /** Title used by markdown replies (stream mode). */
  cardTitle: string;
}

const zh: DingtalkMessages = {
  webhookMissing: "connect-dingtalk: 未配置 webhookUrl（钉钉群自定义机器人的 Webhook 地址），无法推送。",
  webhookInvalid: "connect-dingtalk: webhookUrl 必须是 https:// 开头的钉钉机器人地址。",
  sendFailed: (error) => `connect-dingtalk: 推送失败 — ${error}`,
  cardTitle: "DSH 任务摘要",
};

const en: DingtalkMessages = {
  webhookMissing: "connect-dingtalk: webhookUrl is not configured (the DingTalk group custom robot's webhook URL) — nothing to push to.",
  webhookInvalid: "connect-dingtalk: webhookUrl must be an https:// DingTalk robot URL.",
  sendFailed: (error) => `connect-dingtalk: push failed — ${error}`,
  cardTitle: "DSH Summary",
};

export function dingtalkMessages(lang: Language): DingtalkMessages {
  return lang === "en" ? en : zh;
}
