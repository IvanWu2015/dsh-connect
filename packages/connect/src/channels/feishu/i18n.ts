/**
 * Feishu-adapter user-facing strings. The `language` config picks `zh` or
 * `en`; the Feishu adapter itself only produces a handful of messages (image
 * download errors, menu expiry, completion cards), so a small table suffices.
 * @module dsh-connect/channels/feishu/i18n
 */
import type { Language } from "../../i18n.js";

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
  /** Non-interactive host (no TTY): say what to do instead of starting a scan. */
  onboardingSkipped: string;
  onboardingIncomplete: string;
  onboardingSuccess(appId: string): string;
  /** Onboarded, but neither store took the credentials — persist for the next boot. */
  onboardingUnsaved(appId: string): string;
  onboardingFailed(code: string): string;
  onboardingLink(url: string): string;
  onboardingLinkExpiry(minutes: number): string;
  /** The settings pane started the flow (no TTY involved — a human is watching). */
  onboardingStarted: string;
  /** The event subscription was accepted by the API — not proof it is live. */
  onboardingSubscriptionApplied(appId: string): string;
  onboardingSubscriptionFailed(appId: string, reason: string): string;
  /** The channel was written as enabled with transport=websocket. */
  onboardingEnabled(appId: string): string;
  onboardingCancelled: string;
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
  onboardingSkipped: "connect-feishu: 未配置飞书凭据，且当前不是交互式终端，跳过一键接入。请在设置面板 dsh-connect 中填写 appId/appSecret。",
  onboardingIncomplete: "connect-feishu: 一键接入未完成，可重启重试，或手动配置 appId/appSecret。",
  onboardingSuccess: (appId) => `connect-feishu: 一键接入成功（${appId}），正在连接…`,
  onboardingUnsaved: (appId) =>
    `connect-feishu: 一键接入成功（${appId}），但凭据未能保存到本地文件或 DSH 凭据库——本次运行会正常连接，重启 dsh 后需要重新扫码接入，或在设置面板中手动填写 appId/appSecret。`,
  onboardingFailed: (code) => `[connect-feishu] 一键接入失败：${code}`,
  onboardingLink: (url) => `[connect-feishu] 未配置飞书凭据，进入一键接入。请用飞书扫码或点击链接完成：${url}`,
  onboardingLinkExpiry: (minutes) => `[connect-feishu] 链接约 ${minutes} 分钟内有效，仅限一人使用。`,
  onboardingStarted: "[connect-feishu] 设置面板发起了「一键创建飞书机器人」，正在准备授权链接…",
  onboardingSubscriptionApplied: (appId) =>
    `[connect-feishu] 已提交事件订阅方式（长连接）的修改（${appId}），但接口返回成功不等于线上已生效——若飞书提示需提交发布，请到开发者后台完成。`,
  onboardingSubscriptionFailed: (appId, reason) =>
    `[connect-feishu] 事件订阅方式（长连接）未能自动配置（${appId}）：${reason}。请在开发者后台手动把订阅方式改为长连接。`,
  onboardingEnabled: (appId) => `[connect-feishu] 已启用飞书渠道并写好 transport=websocket（${appId}），正在让运行中的渠道采用新凭据…`,
  onboardingCancelled: "[connect-feishu] 一键创建已被用户取消，授权链接已失效。",
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
  onboardingSkipped: "connect-feishu: no Feishu credentials configured and this host is not an interactive terminal — skipping one-click onboarding. Enter appId/appSecret in the dsh-connect settings pane.",
  onboardingIncomplete: "connect-feishu: onboarding not completed — restart to retry, or configure appId/appSecret manually.",
  onboardingSuccess: (appId) => `connect-feishu: onboarding succeeded (${appId}), connecting…`,
  onboardingUnsaved: (appId) =>
    `connect-feishu: onboarding succeeded (${appId}) but the credentials were not saved to the local file or the DSH credential store — this run connects normally, and after a dsh restart you must onboard again (or enter appId/appSecret in the settings pane).`,
  onboardingFailed: (code) => `[connect-feishu] onboarding failed: ${code}`,
  onboardingLink: (url) => `[connect-feishu] no Feishu credentials configured — entering one-click onboarding. Scan with Feishu or open the link to complete: ${url}`,
  onboardingLinkExpiry: (minutes) => `[connect-feishu] the link is valid for about ${minutes} minutes and usable by one person.`,
  onboardingStarted: "[connect-feishu] the settings pane started one-click bot creation — preparing the authorization link…",
  onboardingSubscriptionApplied: (appId) =>
    `[connect-feishu] the event subscription mode change (long connection) was submitted for ${appId}, but a successful API response does not mean it is live — if Feishu asks for a release, finish it in the developer console.`,
  onboardingSubscriptionFailed: (appId, reason) =>
    `[connect-feishu] the event subscription mode (long connection) could not be configured automatically for ${appId}: ${reason}. Set the subscription mode to long connection manually in the developer console.`,
  onboardingEnabled: (appId) => `[connect-feishu] the Feishu channel was enabled with transport=websocket for ${appId}; asking the running channels to adopt the new credentials…`,
  onboardingCancelled: "[connect-feishu] one-click creation was cancelled by the user; the authorization link is now invalid.",
};

export function feishuMessages(lang: Language): FeishuMessages {
  return lang === "en" ? en : zh;
}
