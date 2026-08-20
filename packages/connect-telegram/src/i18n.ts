/**
 * Telegram-adapter user-facing strings (zh/en).
 * @module dsh-connect-telegram/i18n
 */
import type { Language } from "dsh-connect";

export interface TelegramMessages {
  tokenMissing: string;
  pollFailed(error: string): string;
  choiceExpired: string;
  choiceDone: string;
  menuExpired: string;
}

const zh: TelegramMessages = {
  tokenMissing: "connect-telegram: 未配置 botToken（Telegram BotFather 提供的 token），无法连接。",
  pollFailed: (error) => `connect-telegram: 长轮询失败，稍后重试 — ${error}`,
  choiceExpired: "此操作已失效（可能已被处理或已过期）。",
  choiceDone: "✅ 已选择",
  menuExpired: "菜单已过期",
};

const en: TelegramMessages = {
  tokenMissing: "connect-telegram: botToken is not configured (the token BotFather gives you) — cannot connect.",
  pollFailed: (error) => `connect-telegram: long-poll failed, retrying — ${error}`,
  choiceExpired: "This action is no longer active (already handled or expired).",
  choiceDone: "✅ Selected",
  menuExpired: "Menu expired",
};

export function telegramMessages(lang: Language): TelegramMessages {
  return lang === "en" ? en : zh;
}
