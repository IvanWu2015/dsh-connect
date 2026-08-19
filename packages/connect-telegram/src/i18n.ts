/**
 * Telegram-adapter user-facing strings (zh/en).
 * @module dsh-connect-telegram/i18n
 */
import type { Language } from "dsh-connect";

export interface TelegramMessages {
  tokenMissing: string;
  pollFailed(error: string): string;
  imageDownloadError(failed: number, detail: string): string;
  fileDownloadError(failed: number, detail: string): string;
  downloadFailed(error: string): string;
  choiceTimeout: string;
  choiceExpired: string;
  choiceDone: string;
  menuExpired: string;
  menuExpiredHint: string;
}

const zh: TelegramMessages = {
  tokenMissing: "connect-telegram: 未配置 botToken（Telegram BotFather 提供的 token），无法连接。",
  pollFailed: (error) => `connect-telegram: 长轮询失败，稍后重试 — ${error}`,
  imageDownloadError: (failed, detail) => `有 ${failed} 张图片下载失败${detail}`,
  fileDownloadError: (failed, detail) => `有 ${failed} 个文件下载失败${detail}`,
  downloadFailed: (error) => `文件下载失败：${error}`,
  choiceTimeout: "选择已超时，请重新操作。",
  choiceExpired: "此菜单已过期，请重新打开。",
  choiceDone: "✅ 已选择",
  menuExpired: "菜单已过期",
  menuExpiredHint: "请重新打开菜单。",
};

const en: TelegramMessages = {
  tokenMissing: "connect-telegram: botToken is not configured (the token BotFather gives you) — cannot connect.",
  pollFailed: (error) => `connect-telegram: long-poll failed, retrying — ${error}`,
  imageDownloadError: (failed, detail) => `Failed to download ${failed} image(s)${detail}`,
  fileDownloadError: (failed, detail) => `Failed to download ${failed} file(s)${detail}`,
  downloadFailed: (error) => `File download failed: ${error}`,
  choiceTimeout: "The choice timed out — please try again.",
  choiceExpired: "This menu has expired — please reopen it.",
  choiceDone: "✅ Selected",
  menuExpired: "Menu expired",
  menuExpiredHint: "Please reopen the menu.",
};

export function telegramMessages(lang: Language): TelegramMessages {
  return lang === "en" ? en : zh;
}
