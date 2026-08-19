/**
 * Feishu-adapter user-facing strings. The `language` config picks `zh` or
 * `en`; the Feishu adapter itself only produces a handful of messages (image
 * download errors, menu expiry, completion cards), so a small table suffices.
 * @module dsh-connect-feishu/i18n
 */
import type { Language } from "dsh-connect";

export interface FeishuMessages {
  tempDirFailed(error: string): string;
  imageDownloadLog(fileKey: string, detail: string): string;
  fileDownloadLog(fileKey: string, detail: string): string;
  errorDetail(detail: string): string;
  imageDownloadError(failed: number, detail: string): string;
  fileDownloadError(failed: number, detail: string): string;
  menuExpired: string;
  menuExpiredHint: string;
  /** Shown when the user taps a button on a card whose interaction is no longer pending. */
  actionStale: string;
  doneHeader: string;
  onboardingEnter: string;
  onboardingIncomplete: string;
  onboardingSuccess(appId: string): string;
  onboardingFailed(code: string): string;
  onboardingLink(url: string): string;
  onboardingLinkExpiry(minutes: number): string;
}

const zh: FeishuMessages = {
  tempDirFailed: (error) => `无法创建临时目录：${error}`,
  imageDownloadLog: (fileKey, detail) => `connect-feishu: 图片下载失败 (${fileKey}): ${detail}`,
  fileDownloadLog: (fileKey, detail) => `connect-feishu: 文件下载失败 (${fileKey}): ${detail}`,
  errorDetail: (detail) => `（错误详情：${detail}）`,
  imageDownloadError: (failed, detail) =>
    `有 ${failed} 张图片下载失败，请按上面的错误详情确认飞书应用权限（下载用户消息图片需要 im:message 系列权限）并重新发版${detail}`,
  fileDownloadError: (failed, detail) =>
    `有 ${failed} 个文件下载失败，请按上面的错误详情确认飞书应用权限（下载用户消息文件需要 im:message 系列权限）并重新发版${detail}`,
  menuExpired: "菜单已过期",
  menuExpiredHint: "请重新打开菜单。",
  actionStale: "⚠️ 此操作已失效（可能已被处理或已过期）。",
  doneHeader: "✅ 完成",
  onboardingEnter: "connect-feishu: 未配置 appId/appSecret，进入一键接入模式（扫码或点击链接自动创建飞书应用）。",
  onboardingIncomplete: "connect-feishu: 一键接入未完成，可重启重试，或手动配置 appId/appSecret。",
  onboardingSuccess: (appId) => `connect-feishu: 一键接入成功（${appId}），正在连接…`,
  onboardingFailed: (code) => `[connect-feishu] 一键接入失败：${code}`,
  onboardingLink: (url) => `[connect-feishu] 未配置飞书凭据，进入一键接入。请用飞书扫码或点击链接完成：${url}`,
  onboardingLinkExpiry: (minutes) => `[connect-feishu] 链接约 ${minutes} 分钟内有效，仅限一人使用。`,
};

const en: FeishuMessages = {
  tempDirFailed: (error) => `Cannot create temp directory: ${error}`,
  imageDownloadLog: (fileKey, detail) => `connect-feishu: image download failed (${fileKey}): ${detail}`,
  fileDownloadLog: (fileKey, detail) => `connect-feishu: file download failed (${fileKey}): ${detail}`,
  errorDetail: (detail) => ` (error detail: ${detail})`,
  imageDownloadError: (failed, detail) =>
    `Failed to download ${failed} image(s). Check the Feishu app permissions per the error detail above (downloading user-message images requires the im:message family) and release a new version${detail}`,
  fileDownloadError: (failed, detail) =>
    `Failed to download ${failed} file(s). Check the Feishu app permissions per the error detail above (downloading user-message files requires the im:message family) and release a new version${detail}`,
  menuExpired: "Menu expired",
  menuExpiredHint: "Please reopen the menu.",
  actionStale: "⚠️ This action is no longer active (already handled or expired).",
  doneHeader: "✅ Done",
  onboardingEnter: "connect-feishu: no appId/appSecret configured — entering one-click onboarding (scan or open the link to auto-create the Feishu app).",
  onboardingIncomplete: "connect-feishu: onboarding not completed — restart to retry, or configure appId/appSecret manually.",
  onboardingSuccess: (appId) => `connect-feishu: onboarding succeeded (${appId}), connecting…`,
  onboardingFailed: (code) => `[connect-feishu] onboarding failed: ${code}`,
  onboardingLink: (url) => `[connect-feishu] no Feishu credentials configured — entering one-click onboarding. Scan with Feishu or open the link to complete: ${url}`,
  onboardingLinkExpiry: (minutes) => `[connect-feishu] the link is valid for about ${minutes} minutes and usable by one person.`,
};

export function feishuMessages(lang: Language): FeishuMessages {
  return lang === "en" ? en : zh;
}
