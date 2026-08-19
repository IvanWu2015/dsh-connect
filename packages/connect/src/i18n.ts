/**
 * Minimal user-facing string tables for `dsh-connect`. Every message a user
 * can see (menus, command replies, status lines, hints) lives here in both
 * `zh` and `en`; the configured `language` picks the active table. Keep this
 * file free of imports from the runner so it can be shared by any module.
 * @module dsh-connect/i18n
 */

export type Language = "zh" | "en";

/** All user-visible strings, as template functions where they interpolate. */
export interface Messages {
  // Turn-reason labels (used on "task ended" cards).
  reasonCompleted: string;
  reasonAborted: string;
  reasonBlocked: string;
  reasonError: string;
  reasonMaxTokens: string;
  reasonInterrupted: string;
  reasonUnknown: string;

  // Menu titles.
  menuRoot: string;
  menuWorkspace: string;
  menuChat: string;
  menuSettings: string;
  menuModel: string;
  menuReasoning: string;
  menuNotify: string;

  // Root-menu section titles (4, in display order).
  rootSectionWorkspace: string;
  rootSectionChat: string;
  rootSectionTask: string;
  rootSectionSystem: string;
  rootMenuFooter: string;

  thinkingHint: string;
  toolCalling(name: string, summary: string | undefined): string;
  processingHeartbeat(minutes: number): string;
  processingFailed(detail: string): string;

  // Processing-start acknowledgment + proactive progress notices.
  processingStarted(preview: string): string;
  progressReminder(minutes: number, status: string): string;
  progressThinking: string;
  progressMenuTitle: string;
  progressOff: string;
  progressMinutes(n: number): string;
  progressSet(label: string): string;
  progressSetting(label: string): string;
  menuSettingsProgress: string;
  helpProgress: string;

  // Compact feedback: immediate start notice, then the outcome.
  compactStarted: string;
  compactDone: string;

  // Interactive user choices (ask_user_question) and permission requests.
  questionCardTitle: string;
  questionCardHint: string;
  questionMultiHint: string;
  questionStep(index: number, total: number): string;
  questionTextHint(question: string): string;
  questionWaiting(question: string): string;
  approvalCardTitle: string;
  approvalAsk(toolName: string, reason: string | undefined): string;
  approveLabel: string;
  rejectLabel: string;
  answerReceived: string;
  questionToolCall(text: string): string;
  /** Card summary shown after an approval decision was accepted. */
  approvalDone(outcome: "allowed-once" | "rejected", toolName: string): string;
  /** Card summary shown when the approval is no longer actionable (stale / already handled). */
  approvalStale: string;
  /** Shown when answering an interactive question failed (e.g. it was already answered elsewhere). */
  questionStale: string;
  /** Inline status shown inside the approval card while the decision is being submitted. */
  approvalSubmitting: string;

  // First-time welcome card (sent once per chat).
  welcomeTitle: string;
  welcomeBody(workdir: string): string;

  // Error classification + actionable advice.
  errorAdvicePermission: string;
  errorAdviceNetwork: string;
  errorAdviceModel: string;
  errorAdviceGeneric: string;
  processingFailedAdvice(detail: string, advice: string): string;

  // Destructive-action confirmation.
  confirmTitle: string;
  confirmYes: string;
  confirmNo: string;
  confirmClearText: string;
  confirmNewText: string;
  actionCancelled: string;

  // Progress enhancement.
  toolStepLabel(n: number, name: string): string;
  queuedHint(n: number): string;

  // Notification levels (streaming reply detail).
  notifyFull: string;
  notifyImportant: string;
  notifyResult: string;
  notifyFullDesc: string;
  notifyImportantDesc: string;
  notifyResultDesc: string;
  notifySet(level: string, description: string): string;

  // Task-end stats card.
  taskStatsHeader(duration: string): string;
  taskStatsModel(providerModel: string): string;
  taskStatsTokensIn(tokens: string, cached: string | undefined): string;
  taskStatsTokensOut(tokens: string): string;
  taskStatsSteps(count: number): string;
  taskStatsContext(usedPct: string, window: string): string;
  taskStatsCompactOk: string;
  taskStatsCompactSuggest: string;
  taskDuration(ms: number): string;
  imageDownloadFailed(imageError: string): string;
  fileDownloadFailed(fileError: string): string;
  imagesStaged(locations: string, description: string): string;
  imageDescriptionLabel(description: string): string;
  imageNoDescription: string;
  visionPrompt: string;
  filesStaged(count: number, locations: string): string;
  taskEnded(reasonLabel: string): string;
  errorCode(code: string): string;
  reasonMessage(message: string): string;
  produced(text: string): string;

  newChatDone: string;
  chatCleared: string;
  stopRequested: string;
  dirUsage: string;
  dirNotExists(path: string): string;
  dirNotExistsHint(path: string): string;
  dirUnreadable(path: string): string;
  dirSwitched(path: string): string;
  workspaceUsage: string;
  menuClosed: string;
  menuExit: string;
  menuBack: string;

  menuWorkspaceAction: string;
  menuChatAction: string;
  menuStatusAction: string;
  menuTaskAction: string;
  menuHistoryAction: string;
  menuGoalsAction: string;
  menuScheduleAction: string;
  menuCompactAction: string;
  menuPluginsAction: string;
  menuSettingsAction: string;
  menuNewChat: string;
  menuSettingsModel: string;
  menuSettingsReasoning: string;
  menuSettingsNotify: string;
  menuSettingsOverview: string;
  menuSettingsLanguage: string;
  languageZh: string;
  languageEn: string;
  languageSet(lang: string): string;

  streamLabel(on: boolean): string;
  summaryLabel(on: boolean): string;
  statusNoSession(workdir: string): string;
  statusRunning: string;
  statusIdle: string;
  statusExecuting: string;
  statusWaiting: string;
  statusField(status: string): string;
  modelField(model: string): string;
  workdirField(workdir: string): string;
  queuedField(n: number): string;
  queueEmpty: string;
  queueDetail(n: number): string;
  lastTurnReason(reason: string): string;
  lastTurnTime(time: string): string;
  noTurnHistory: string;
  sessionField(id: string): string;
  contextField(total: number, surface: number): string;

  noTodos: string;
  currentTodos(n: number, list: string): string;
  settingsHeader: string;
  modelSetting(model: string): string;
  reasoningSetting(effort: string): string;
  agentPresetSetting(preset: string): string;
  workdirSetting(workdir: string): string;
  workspacesSetting: string;
  notConfigured: string;
  chatCountField(n: number): string;
  allowUsersField(n: number, all: boolean): string;
  allowChatsField(n: number, all: boolean): string;
  stateDirField(dir: string): string;

  noModelsFound: string;
  defaultLabel: string;
  modelName(name: string, provider: string): string;
  effortLow: string;
  effortMedium: string;
  effortHigh: string;
  effortDefault: string;

  noPlugins: string;
  pluginDisabled: string;
  pluginEnabled: string;
  pluginsTruncated(all: number, shown: number): string;
  pluginsCount(n: number): string;
  workspaceServiceUnavailable: string;
  workspaceCreated(title: string, path: string): string;
  createFailed(error: string): string;
  noActiveSessionCompact: string;
  sessionRunning: string;
  compactionUnavailable: string;
  nothingToCompact: string;
  contextCompacted: string;
  compactFailed(message: string): string;

  noActiveSession: string;
  noMessagesYet: string;
  recentMessages(n: number, list: string): string;
  noActiveGoals: string;
  goalPhaseActive: string;
  goalPhasePaused: string;
  goalPhaseBlocked: string;
  goalPhaseComplete: string;
  goalObjective(objective: string): string;
  goalStatus(status: string): string;
  goalRounds(started: number, max: number): string;
  goalAutoRun(armed: boolean): string;
  goalBlockedReason(message: string): string;

  noReminders: string;
  reminderDue: string;
  reminderClock: string;
  reminderEvery(minutes: number): string;
  reminderOnce: string;
  reminderLine(state: string, id: string, prompt: string, kind: string, when: string): string;
  remindersCount(n: number, list: string): string;
  noWorkspaces: string;
  workspaceSessions(n: number): string;
  workspacesCount(n: number, list: string): string;

  currentDir: string;

  // Mirror / session sharing.
  mirrorCreated(sessionId: string): string;
  mirrorAlreadyExists(sessionId: string): string;
  mirrorNotConfigured: string;
  sessionLockedBy(channel: string): string;
  sessionReadOnly: string;
  lockReleased: string;
  lockTimeoutReleased(minutes: number): string;
  unlockSuccess: string;
  unlockNoLock: string;
  lockRenewed(minutes: number): string;
  messageQueued(position: number): string;
  queueProcessed(count: number): string;
  exportMarkdown(path: string): string;
  exportPdfNotSupported: string;
  exportNoSession: string;
  exportFailed(error: string): string;
  mirrorStatus(sessionId: string, lockedBy?: string, timeoutMin?: number, queuedCount?: number): string;
  webMirrorIndicator: string;
  sessionAvailableOnWeb: string;

  // `/help` command lines.
  helpHeader: string;
  helpMenu: string;
  helpSettings: string;
  helpStatus: string;
  helpTask: string;
  helpChat: string;
  helpDir: string;
  helpWorkspace: string;
  helpPlugins: string;
  helpCompact: string;
  helpHistory: string;
  helpGoals: string;
  helpSchedule: string;
  helpModel: string;
  helpNotify: string;
  helpWorkspaces: string;
  helpNew: string;
  helpClear: string;
  helpStop: string;
  helpOther: string;
}

const zh: Messages = {
  reasonCompleted: "✅ 完成",
  reasonAborted: "⏹️ 已中止",
  reasonBlocked: "🚫 阻塞",
  reasonError: "❌ 出错",
  reasonMaxTokens: "⚠️ 达到输出上限",
  reasonInterrupted: "⚠️ 被中断",
  reasonUnknown: "❓ 未知",

  menuRoot: "主菜单",
  menuWorkspace: "切换工作目录",
  menuChat: "切换对话",
  menuSettings: "设置",
  menuModel: "切换模型",
  menuReasoning: "推理强度",
  menuNotify: "通知设置",

  rootSectionWorkspace: "📁 工作区",
  rootSectionChat: "💬 会话",
  rootSectionTask: "📋 任务",
  rootSectionSystem: "🛠️ 系统",
  rootMenuFooter: "轻触按钮选择 · 操作后自动返回主菜单 · 60 秒无操作自动关闭",

  thinkingHint: "🤔 深度思考中…\n\n",
  toolCalling: (name, summary) => `🔧 调用工具 \`${name}\`${summary === undefined || summary === "" ? "" : ` — ${summary}`}`,
  processingHeartbeat: (minutes) => `⏳ 仍在处理中（已运行约 ${minutes} 分钟）…`,
  processingFailed: (detail) => `⚠️ 处理失败：${detail}`,
  processingStarted: (preview) =>
    preview === "" ? "✅ 已收到，开始处理…" : `✅ 已收到，开始处理：\n「${preview}」`,
  progressReminder: (minutes, status) =>
    `⏳ 任务仍在处理中（已进行 ${minutes} 分钟）\n最近进展：${status}\n可发送 /status 查看详情，或 /stop 停止当前任务`,
  progressThinking: "🤔 思考中",
  progressMenuTitle: "进度提醒间隔",
  progressOff: "关闭",
  progressMinutes: (n) => `${n} 分钟`,
  progressSet: (label) => `进度提醒间隔已设置为：${label}`,
  progressSetting: (label) => `进度提醒：${label}`,
  menuSettingsProgress: "⏱️ 进度提醒",
  helpProgress: "设置长时间无进展时的主动进度提醒间隔（默认 5 分钟）",
  compactStarted: "🔄 正在压缩上下文…（可能需要一点时间）",
  compactDone: "✅ 上下文压缩完成，可继续对话。",
  questionCardTitle: "🤔 需要你的选择",
  questionCardHint: "点击按钮回答，或直接回复文字（编号或选项内容）",
  questionMultiHint: "（可多选：回复多个编号或选项内容，用逗号分隔，如 1,3）",
  questionTextHint: (question) => `✍️ 请直接回复文字回答：${question}`,
  questionWaiting: (question) => `⏳ 仍在等待你的回答：${question}`,
  questionStep: (index, total) => `（问题 ${index}/${total}）`,
  approvalCardTitle: "🔐 需要你的授权",
  approvalAsk: (toolName, reason) =>
    `工具 \`${toolName}\` 请求执行需要你授权的操作${reason === undefined || reason === "" ? "" : `：\n${reason}`}\n是否允许？`,
  approveLabel: "✅ 允许一次",
  rejectLabel: "❌ 拒绝",
  answerReceived: "✅ 已收到你的回答，继续处理…",
  questionToolCall: (text) => `🤔 需要你的选择 — ${text}`,
  approvalDone: (outcome, toolName) =>
    outcome === "allowed-once" ? `✅ 已同意授权：\`${toolName}\`` : `已拒绝授权：\`${toolName}\``,
  approvalStale: "⚠️ 此授权请求已失效（可能已被处理或已过期），本次操作未生效。",
  questionStale: "⚠️ 此问题已失效（可能已被处理或已过期），本次回答未生效。",
  approvalSubmitting: "⏳ 正在提交授权结果…",
  welcomeTitle: "👋 欢迎使用 dsh-connect",
  welcomeBody: (workdir) =>
    [
      `我是接入 DeepSeek Harness 的飞书助手。工作目录：\`${workdir}\``,
      "直接发消息即可开始任务，也可以使用这些命令：",
      "- `/menu` 打开主菜单（工作目录 / 会话 / 设置 / 压缩等）",
      "- `/help` 查看全部命令",
      "- `/status` 查看会话状态与上下文占用",
      "- `/compact` 上下文占用高时压缩",
      "任务进行中会推送进度；需要你选择或授权时会出现带按钮的卡片，点选或直接回复即可。",
    ].join("\n"),
  errorAdvicePermission:
    "可能是权限不足。请检查：飞书应用的权限（开发者后台 → 权限管理，修改后需重新发布版本）、DSH 沙箱与工作目录的访问权限。",
  errorAdviceNetwork: "可能是网络问题。请检查本机网络连接与代理设置，稍后重试。",
  errorAdviceModel: "可能是模型或配额问题。请检查模型配置 / API 额度，或用 /model 切换模型后重试。",
  errorAdviceGeneric: "可发送 /status 查看会话状态，或 /stop 停止当前任务后重试。",
  processingFailedAdvice: (detail, advice) => `⚠️ 处理失败：${detail}\n\n💡 建议：${advice}`,
  confirmTitle: "请确认操作",
  confirmYes: "✅ 确认",
  confirmNo: "↩️ 取消",
  confirmClearText: "清空当前会话将删除本会话的全部历史消息，确定继续吗？",
  confirmNewText: "新建会话将丢弃当前对话上下文（历史仍保留在会话列表中），确定继续吗？",
  actionCancelled: "已取消，未执行任何操作。",
  toolStepLabel: (n, name) => `🔧 第 ${n} 次工具调用 \`${name}\``,
  queuedHint: (n) => `（还有 ${n} 条消息排队中）`,
  notifyFull: "尽量输出过程",
  notifyImportant: "输出重要节点",
  notifyResult: "只输出结果",
  notifyFullDesc: "实时推送思考过程、工具调用和最终回答",
  notifyImportantDesc: "只推送关键节点：思考开始、工具调用、最终回答",
  notifyResultDesc: "只在任务结束后发送最终结果",
  notifySet: (level, description) => `通知级别已设置为：${level}\n${description}`,
  taskStatsHeader: (duration) => `📊 任务完成 · 耗时 ${duration}`,
  taskStatsModel: (providerModel) => `模型：\`${providerModel}\``,
  taskStatsTokensIn: (tokens, cached) => `输入：${tokens} tokens${cached === undefined ? "" : `（缓存 ${cached}）`}`,
  taskStatsTokensOut: (tokens) => `输出：${tokens} tokens`,
  taskStatsSteps: (count) => `步骤：${count}`,
  taskStatsContext: (usedPct, window) => `上下文占用：${usedPct}%（窗口 ${window}）`,
  taskStatsCompactOk: "上下文占用正常，暂无需压缩",
  taskStatsCompactSuggest: "⚠️ 上下文占用较高，建议发送 /compact 压缩上下文",
  taskDuration: (ms) =>
    ms < 60_000 ? `${Math.round(ms / 1000)} 秒` : `${Math.floor(ms / 60_000)} 分 ${Math.round((ms % 60_000) / 1000)} 秒`,
  imageDownloadFailed: (imageError) => `[用户发送了图片，但下载失败：${imageError}]`,
  fileDownloadFailed: (fileError) => `[用户发送了文件，但下载失败：${fileError}]`,
  imagesStaged: (locations, description) =>
    description !== ""
      ? `[用户发送了图片，图片已保存到以下路径（可用工具查看）：\n${locations}\n图片内容说明：\n${description}]`
      : `[用户发送了图片，图片已保存到以下路径（可用工具查看）：\n${locations}\n（未能自动分析图片内容，请用文件/终端工具查看这些图片。）]`,
  imageDescriptionLabel: (description) => `图片内容说明：\n${description}`,
  imageNoDescription: "（未能自动分析图片内容，请用文件/终端工具查看这些图片。）",
  visionPrompt:
    "请详细描述这些图片的内容（物体、场景、文字、布局、氛围等），供一个无法直接查看图片的主模型理解。",
  filesStaged: (count, locations) => `[用户发送了 ${count} 个文件，已保存到以下路径（可用工具查看）：\n${locations}]`,
  taskEnded: (reasonLabel) => `**任务结束**：${reasonLabel}`,
  errorCode: (code) => `错误码：\`${code}\``,
  reasonMessage: (message) => `原因：${message}`,
  produced: (text) => `已产出：${text}`,

  newChatDone: "已开启新会话。",
  chatCleared: "会话已清空。",
  stopRequested: "已请求停止当前任务。",
  dirUsage: "请输入绝对路径，例如 `/dir D:\\projects\\my-app`。",
  dirNotExists: (path) => `目录不存在或不是文件夹：${path}`,
  dirNotExistsHint: (path) => `目录不存在或不是文件夹：${path}\n（请先创建该目录，再执行 /workspace）`,
  dirUnreadable: (path) => `无法访问目录：${path}`,
  dirSwitched: (path) => `工作目录已切换为：\n${path}\n（已开启新会话）`,
  workspaceUsage: "用法：`/workspace <绝对路径>`，例如 `/workspace D:\\projects\\new-app`。",
  menuClosed: "菜单已关闭。",
  menuExit: "❌ 退出",
  menuBack: "🔙 返回",

  menuWorkspaceAction: "📁 切换工作目录",
  menuChatAction: "💬 切换对话",
  menuStatusAction: "📊 查看状态",
  menuTaskAction: "📋 查看任务",
  menuHistoryAction: "🗒️ 历史消息",
  menuGoalsAction: "🎯 目标",
  menuScheduleAction: "⏰ 定时提醒",
  menuCompactAction: "🗜️ 压缩上下文",
  menuPluginsAction: "🔌 查看插件",
  menuSettingsAction: "⚙️ 设置",
  menuNewChat: "➕ 新建对话",
  menuSettingsModel: "🤖 切换模型",
  menuSettingsReasoning: "🧠 推理强度",
  menuSettingsNotify: "🔔 通知设置",
  menuSettingsOverview: "📄 配置总览",
  menuSettingsLanguage: "🌐 语言",
  languageZh: "中文",
  languageEn: "English",
  languageSet: (lang) => `语言已切换为 ${lang}。`,

  streamLabel: (on) => `流式输出：${on ? "开" : "关"}`,
  summaryLabel: (on) => `结束摘要：${on ? "开" : "关"}`,
  statusNoSession: (workdir) => `状态：无活动会话\n工作目录：${workdir}`,
  statusRunning: "🟢 执行中",
  statusIdle: "⚪ 空闲",
  statusExecuting: "🔄 正在处理任务",
  statusWaiting: "⏳ 等待新消息",
  statusField: (status) => `状态：${status}`,
  modelField: (model) => `模型：${model}`,
  workdirField: (workdir) => `工作目录：${workdir}`,
  queuedField: (n) => `待处理消息：${n}`,
  queueEmpty: "（队列空）",
  queueDetail: (n) => `${n} 条消息排队中`,
  lastTurnReason: (reason) => `上次任务：${reason}`,
  lastTurnTime: (time) => `完成时间：${time}`,
  noTurnHistory: "（尚无任务历史）",
  sessionField: (id) => `会话：${id}`,
  contextField: (total, surface) => `上下文：${total} tokens（会话 ${surface}）`,

  noTodos: "当前没有任务清单。",
  currentTodos: (n, list) => `当前任务（${n} 项）：\n${list}`,
  settingsHeader: "⚙️ 设置：",
  modelSetting: (model) => `模型：${model}`,
  reasoningSetting: (effort) => `推理强度：${effort}`,
  agentPresetSetting: (preset) => `Agent 预设：${preset}`,
  workdirSetting: (workdir) => `工作目录：${workdir}`,
  workspacesSetting: "工作区列表：",
  notConfigured: "（未配置）",
  chatCountField: (n) => `对话数：${n}`,
  allowUsersField: (n, all) => `发送者白名单：${all ? "全部放行" : `${n} 人`}`,
  allowChatsField: (n, all) => `会话白名单：${all ? "全部放行" : `${n} 个`}`,
  stateDirField: (dir) => `状态目录：${dir}`,

  noModelsFound: "（未发现可用模型）",
  defaultLabel: "默认",
  modelName: (name, provider) => `${name}（${provider}）`,
  effortLow: "低 (low)",
  effortMedium: "中 (medium)",
  effortHigh: "高 (high)",
  effortDefault: "默认（跟随模型）",

  noPlugins: "未获取到插件清单。",
  pluginDisabled: "⛔ 禁用",
  pluginEnabled: "✅ 启用",
  pluginsTruncated: (all, shown) => `… 共 ${all} 个，仅显示前 ${shown} 个`,
  pluginsCount: (n) => `插件（${n}）：`,
  workspaceServiceUnavailable: "工作区服务不可用。",
  workspaceCreated: (title, path) => `工作区已创建：\n${title}  (${path})`,
  createFailed: (error) => `创建失败：${error}`,
  noActiveSessionCompact: "当前没有活动会话，无法压缩。",
  sessionRunning: "当前会话正在运行，请稍后再试（或先 /stop）。",
  compactionUnavailable: "压缩服务不可用（当前预设未挂载压缩后端）。",
  nothingToCompact: "没有可压缩的历史。",
  contextCompacted: "上下文已压缩。",
  compactFailed: (message) => `压缩失败：${message}`,

  noActiveSession: "当前没有活动会话。",
  noMessagesYet: "会话里还没有消息。",
  recentMessages: (n, list) => `最近 ${n} 条消息：\n${list}`,
  noActiveGoals: "当前没有进行中的目标。",
  goalPhaseActive: "🟢 进行中",
  goalPhasePaused: "⏸️ 已暂停",
  goalPhaseBlocked: "🚫 受阻",
  goalPhaseComplete: "✅ 已完成",
  goalObjective: (objective) => `🎯 目标：${objective}`,
  goalStatus: (status) => `状态：${status}`,
  goalRounds: (started, max) => `轮次：${started}/${max}`,
  goalAutoRun: (armed) => `自动续跑：${armed ? "已武装" : "已解除"}`,
  goalBlockedReason: (message) => `受阻原因：${message}`,

  noReminders:
    "本会话没有定时提醒。可对 Agent 说「5 分钟后提醒我…」来创建（需在配置里挂载 schedule 插件）。",
  reminderDue: "⚠️ 已到期",
  reminderClock: "⏰",
  reminderEvery: (minutes) => `每 ${minutes} 分钟`,
  reminderOnce: "一次性",
  reminderLine: (state, id, prompt, kind, when) => `${state} [${id}] ${prompt}（${kind}，${when}）`,
  remindersCount: (n, list) => `定时提醒（${n}）：\n${list}`,
  noWorkspaces: "还没有工作区。可用 `/workspace <绝对路径>` 新建。",
  workspaceSessions: (n) => `  · ${n} 会话`,
  workspacesCount: (n, list) => `工作区（${n}）：\n${list}`,

  currentDir: "当前目录",

  mirrorCreated: (sessionId) => `✅ Web 镜像会话已创建：${sessionId}\n在 DSH Web 中打开此会话即可查看飞书对话历史。`,
  mirrorAlreadyExists: (sessionId) => `Web 镜像会话已存在：${sessionId}`,
  mirrorNotConfigured: "当前会话未配置 Web 镜像。使用 /mirror 命令创建。",
  sessionLockedBy: (channel) => `⚠️ 会话正被 ${channel === "feishu" ? "飞书" : "Web"} 占用，当前为只读模式`,
  sessionReadOnly: "🔒 会话锁定中，只能查看不能发送消息",
  lockReleased: "🔓 会话锁已释放",
  lockTimeoutReleased: (minutes) => `⏰ 会话锁已超时（${minutes} 分钟无活动），自动释放`,
  unlockSuccess: "🔓 会话锁已手动释放",
  unlockNoLock: "当前没有活跃的会话锁",
  lockRenewed: (minutes) => `🔄 会话锁已续期 ${minutes} 分钟`,
  messageQueued: (position) => `📥 消息已加入队列（第 ${position} 位），等待锁释放后自动执行`,
  queueProcessed: (count) => `✅ 已处理队列中的 ${count} 条消息`,
  exportMarkdown: (path) => `📄 对话历史已导出为 Markdown：\n${path}`,
  exportPdfNotSupported: "⚠️ PDF 导出暂不支持，请使用 Markdown 格式",
  exportNoSession: "当前没有活动会话，无法导出",
  exportFailed: (error) => `❌ 导出失败：${error}`,
  mirrorStatus: (sessionId, lockedBy, timeoutMin, queuedCount) => {
    const lockInfo = lockedBy ? `\n锁定方：${lockedBy === "feishu" ? "飞书" : "Web"}` : "";
    const timeoutInfo = timeoutMin !== undefined ? `\n超时时间：${timeoutMin} 分钟` : "";
    const queueInfo = queuedCount && queuedCount > 0 ? `\n排队消息：${queuedCount} 条` : "";
    return `Web 镜像会话：${sessionId}${lockInfo}${timeoutInfo}${queueInfo}`;
  },
  webMirrorIndicator: "🌐",
  sessionAvailableOnWeb: "（同时在 Web 上可用）",

  helpHeader: "可用命令（本地执行，不消耗模型）：",
  helpMenu: "打开主菜单（层级点选，可返回）",
  helpSettings: "设置：模型 / 推理强度 / 通知 / 配置总览",
  helpStatus: "查看会话状态、模型、工作目录、排队数",
  helpTask: "查看当前任务清单（todo）",
  helpChat: "列出对话，点选切换或新建",
  helpDir: "列出工作目录，点选切换（或 `/dir <绝对路径>` 手动指定）",
  helpWorkspace: "新建工作区",
  helpPlugins: "查看插件清单",
  helpCompact: "压缩当前会话上下文",
  helpHistory: "查看最近会话消息",
  helpGoals: "查看当前目标",
  helpSchedule: "查看本会话的定时提醒",
  helpModel: "查看 / 切换模型",
  helpNotify: "选择通知程度（完整过程 / 重要节点 / 仅结果）",
  helpWorkspaces: "列出所有工作区",
  helpNew: "开启新对话",
  helpClear: "清空当前对话",
  helpStop: "停止当前任务",
  helpOther: "其他文本将作为任务发送给 DSH Agent",
};

const en: Messages = {
  reasonCompleted: "✅ Done",
  reasonAborted: "⏹️ Aborted",
  reasonBlocked: "🚫 Blocked",
  reasonError: "❌ Error",
  reasonMaxTokens: "⚠️ Output limit reached",
  reasonInterrupted: "⚠️ Interrupted",
  reasonUnknown: "❓ Unknown",

  menuRoot: "Main menu",
  menuWorkspace: "Switch workdir",
  menuChat: "Switch conversation",
  menuSettings: "Settings",
  menuModel: "Switch model",
  menuReasoning: "Reasoning effort",
  menuNotify: "Notifications",

  rootSectionWorkspace: "📁 Workspace",
  rootSectionChat: "💬 Session",
  rootSectionTask: "📋 Tasks",
  rootSectionSystem: "🛠️ System",
  rootMenuFooter: "Tap a button · returns to the main menu after an action · auto-closes after 60 s idle",

  thinkingHint: "🤔 Deep thinking…\n\n",
  toolCalling: (name, summary) => `🔧 Calling tool \`${name}\`${summary === undefined || summary === "" ? "" : ` — ${summary}`}`,
  processingHeartbeat: (minutes) => `⏳ Still processing (~${minutes} min)…`,
  processingFailed: (detail) => `⚠️ Processing failed: ${detail}`,
  processingStarted: (preview) =>
    preview === "" ? "✅ Received — starting to process…" : `✅ Received — starting to process:\n“${preview}”`,
  progressReminder: (minutes, status) =>
    `⏳ Still working on the task (${minutes} min so far)\nLatest progress: ${status}\nSend /status for details, or /stop to cancel`,
  progressThinking: "🤔 Thinking",
  progressMenuTitle: "Progress reminder interval",
  progressOff: "Off",
  progressMinutes: (n) => `${n} min`,
  progressSet: (label) => `Progress reminder interval set to: ${label}`,
  progressSetting: (label) => `Progress reminder: ${label}`,
  menuSettingsProgress: "⏱️ Progress reminder",
  helpProgress: "set the proactive progress-notice interval when a task stays silent (default 5 minutes)",
  compactStarted: "🔄 Compacting context… (this may take a moment)",
  compactDone: "✅ Context compaction complete — you can continue chatting.",
  questionCardTitle: "🤔 Your input is needed",
  questionCardHint: "Tap a button to answer, or reply with text (number or option label)",
  questionMultiHint: "(multi-select: reply with several numbers or labels, comma-separated, e.g. 1,3)",
  questionTextHint: (question) => `✍️ Please reply with text: ${question}`,
  questionWaiting: (question) => `⏳ Still waiting for your answer: ${question}`,
  questionStep: (index, total) => `(Question ${index}/${total})`,
  approvalCardTitle: "🔐 Permission required",
  approvalAsk: (toolName, reason) =>
    `Tool \`${toolName}\` is requesting an action that needs your authorization${reason === undefined || reason === "" ? "" : `:\n${reason}`}\nAllow it?`,
  approveLabel: "✅ Allow once",
  rejectLabel: "❌ Deny",
  answerReceived: "✅ Got your answer — continuing…",
  questionToolCall: (text) => `🤔 Your input is needed — ${text}`,
  approvalDone: (outcome, toolName) =>
    outcome === "allowed-once" ? `✅ Approved: \`${toolName}\`` : `Rejected: \`${toolName}\``,
  approvalStale: "⚠️ This approval request is no longer active (already handled or expired) — this action had no effect.",
  questionStale: "⚠️ This question is no longer active (already handled or expired) — this answer had no effect.",
  approvalSubmitting: "⏳ Submitting your decision…",
  welcomeTitle: "👋 Welcome to dsh-connect",
  welcomeBody: (workdir) =>
    [
      `I'm a Feishu assistant powered by DeepSeek Harness. Workdir: \`${workdir}\``,
      "Just send a message to start a task, or use these commands:",
      "- `/menu` open the main menu (workdir / sessions / settings / compact…)",
      "- `/help` list all commands",
      "- `/status` session status and context usage",
      "- `/compact` compact the context when it's getting full",
      "While a task runs you'll get progress updates; when your input or approval is needed, a card with buttons appears — just tap or reply.",
    ].join("\n"),
  errorAdvicePermission:
    "This looks like a permission problem. Check the Feishu app permissions (Developer Console → Permissions; release a new version after changes) and the DSH sandbox / workdir access.",
  errorAdviceNetwork: "This looks like a network problem. Check your connection / proxy settings and retry later.",
  errorAdviceModel: "This looks like a model or quota problem. Check the model config / API quota, or switch models with /model and retry.",
  errorAdviceGeneric: "You can run /status to inspect the session, or /stop to cancel the current task and retry.",
  processingFailedAdvice: (detail, advice) => `⚠️ Processing failed: ${detail}\n\n💡 Suggestion: ${advice}`,
  confirmTitle: "Please confirm",
  confirmYes: "✅ Confirm",
  confirmNo: "↩️ Cancel",
  confirmClearText: "Clearing this conversation deletes all of its history. Continue?",
  confirmNewText: "A new conversation discards the current context (history stays in the session list). Continue?",
  actionCancelled: "Cancelled — nothing was changed.",
  toolStepLabel: (n, name) => `🔧 Tool call #${n}: \`${name}\``,
  queuedHint: (n) => `(${n} more message(s) queued)`,
  notifyFull: "Full process",
  notifyImportant: "Key milestones",
  notifyResult: "Result only",
  notifyFullDesc: "Stream reasoning, tool calls and the final answer live",
  notifyImportantDesc: "Only key milestones: thinking start, tool calls, final answer",
  notifyResultDesc: "Only the final result when the task finishes",
  notifySet: (level, description) => `Notification level set to: ${level}\n${description}`,
  taskStatsHeader: (duration) => `📊 Task done · took ${duration}`,
  taskStatsModel: (providerModel) => `Model: \`${providerModel}\``,
  taskStatsTokensIn: (tokens, cached) => `Input: ${tokens} tokens${cached === undefined ? "" : ` (cached ${cached})`}`,
  taskStatsTokensOut: (tokens) => `Output: ${tokens} tokens`,
  taskStatsSteps: (count) => `Steps: ${count}`,
  taskStatsContext: (usedPct, window) => `Context usage: ${usedPct}% (window ${window})`,
  taskStatsCompactOk: "Context usage is fine — no compaction needed",
  taskStatsCompactSuggest: "⚠️ Context usage is high — consider sending /compact",
  taskDuration: (ms) =>
    ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`,
  imageDownloadFailed: (imageError) => `[The user sent an image, but download failed: ${imageError}]`,
  fileDownloadFailed: (fileError) => `[The user sent a file, but download failed: ${fileError}]`,
  imagesStaged: (locations, description) =>
    description !== ""
      ? `[The user sent images, saved to the following paths (viewable with tools):\n${locations}\nImage description:\n${description}]`
      : `[The user sent images, saved to the following paths (viewable with tools):\n${locations}\n(No image analysis available — inspect the files with the file/terminal tools.)]`,
  imageDescriptionLabel: (description) => `Image description:\n${description}`,
  imageNoDescription: "(No image analysis available — inspect the files with the file/terminal tools.)",
  visionPrompt:
    "Describe these images in detail (objects, scene, text, layout, atmosphere, etc.) for a main model that cannot view images directly.",
  filesStaged: (count, locations) => `[The user sent ${count} file(s), saved to the following paths (viewable with tools):\n${locations}]`,
  taskEnded: (reasonLabel) => `**Task ended** — ${reasonLabel}`,
  errorCode: (code) => `Error code: \`${code}\``,
  reasonMessage: (message) => `Reason: ${message}`,
  produced: (text) => `Output: ${text}`,

  newChatDone: "New conversation started.",
  chatCleared: "Conversation cleared.",
  stopRequested: "Stop requested for the current task.",
  dirUsage: "Enter an absolute path, e.g. `/dir D:\\projects\\my-app`.",
  dirNotExists: (path) => `Directory does not exist or is not a folder: ${path}`,
  dirNotExistsHint: (path) => `Directory does not exist or is not a folder: ${path}\n(create the directory first, then run /workspace)`,
  dirUnreadable: (path) => `Cannot access directory: ${path}`,
  dirSwitched: (path) => `Workdir switched to:\n${path}\n(new conversation started)`,
  workspaceUsage: "Usage: `/workspace <absolute path>`, e.g. `/workspace D:\\projects\\new-app`.",
  menuClosed: "Menu closed.",
  menuExit: "❌ Exit",
  menuBack: "🔙 Back",

  menuWorkspaceAction: "📁 Switch workdir",
  menuChatAction: "💬 Switch conversation",
  menuStatusAction: "📊 Status",
  menuTaskAction: "📋 Tasks",
  menuHistoryAction: "🗒️ History",
  menuGoalsAction: "🎯 Goals",
  menuScheduleAction: "⏰ Reminders",
  menuCompactAction: "🗜️ Compact context",
  menuPluginsAction: "🔌 Plugins",
  menuSettingsAction: "⚙️ Settings",
  menuNewChat: "➕ New conversation",
  menuSettingsModel: "🤖 Switch model",
  menuSettingsReasoning: "🧠 Reasoning effort",
  menuSettingsNotify: "🔔 Notifications",
  menuSettingsOverview: "📄 Config overview",
  menuSettingsLanguage: "🌐 Language",
  languageZh: "中文",
  languageEn: "English",
  languageSet: (lang) => `Language switched to ${lang}.`,

  streamLabel: (on) => `Streaming output: ${on ? "on" : "off"}`,
  summaryLabel: (on) => `End-of-turn summary: ${on ? "on" : "off"}`,
  statusNoSession: (workdir) => `Status: no active session\nWorkdir: ${workdir}`,
  statusRunning: "🟢 Executing",
  statusIdle: "⚪ Idle",
  statusExecuting: "🔄 Processing task",
  statusWaiting: "⏳ Waiting for messages",
  statusField: (status) => `Status: ${status}`,
  modelField: (model) => `Model: ${model}`,
  workdirField: (workdir) => `Workdir: ${workdir}`,
  queuedField: (n) => `Queued messages: ${n}`,
  queueEmpty: "(queue empty)",
  queueDetail: (n) => `${n} message(s) queued`,
  lastTurnReason: (reason) => `Last turn: ${reason}`,
  lastTurnTime: (time) => `Completed: ${time}`,
  noTurnHistory: "(no turn history yet)",
  sessionField: (id) => `Session: ${id}`,
  contextField: (total, surface) => `Context: ${total} tokens (session ${surface})`,

  noTodos: "No task list.",
  currentTodos: (n, list) => `Current tasks (${n}):\n${list}`,
  settingsHeader: "⚙️ Settings:",
  modelSetting: (model) => `Model: ${model}`,
  reasoningSetting: (effort) => `Reasoning effort: ${effort}`,
  agentPresetSetting: (preset) => `Agent preset: ${preset}`,
  workdirSetting: (workdir) => `Workdir: ${workdir}`,
  workspacesSetting: "Workspaces:",
  notConfigured: "(not configured)",
  chatCountField: (n) => `Conversations: ${n}`,
  allowUsersField: (n, all) => `Sender allowlist: ${all ? "allow all" : `${n} user(s)`}`,
  allowChatsField: (n, all) => `Chat allowlist: ${all ? "allow all" : `${n} chat(s)`}`,
  stateDirField: (dir) => `State dir: ${dir}`,

  noModelsFound: "(no usable models found)",
  defaultLabel: "Default",
  modelName: (name, provider) => `${name} (${provider})`,
  effortLow: "Low (low)",
  effortMedium: "Medium (medium)",
  effortHigh: "High (high)",
  effortDefault: "Default (follow model)",

  noPlugins: "Could not fetch the plugin list.",
  pluginDisabled: "⛔ Disabled",
  pluginEnabled: "✅ Enabled",
  pluginsTruncated: (all, shown) => `… ${all} total, showing the first ${shown}`,
  pluginsCount: (n) => `Plugins (${n}):`,
  workspaceServiceUnavailable: "Workspace service unavailable.",
  workspaceCreated: (title, path) => `Workspace created:\n${title}  (${path})`,
  createFailed: (error) => `Creation failed: ${error}`,
  noActiveSessionCompact: "No active session to compact.",
  sessionRunning: "The session is running — try again later (or `/stop` first).",
  compactionUnavailable: "Compaction service unavailable (the current preset does not mount a compaction backend).",
  nothingToCompact: "Nothing to compact.",
  contextCompacted: "Context compacted.",
  compactFailed: (message) => `Compaction failed: ${message}`,

  noActiveSession: "No active session.",
  noMessagesYet: "No messages in the session yet.",
  recentMessages: (n, list) => `Recent ${n} message(s):\n${list}`,
  noActiveGoals: "No goal in progress.",
  goalPhaseActive: "🟢 Active",
  goalPhasePaused: "⏸️ Paused",
  goalPhaseBlocked: "🚫 Blocked",
  goalPhaseComplete: "✅ Completed",
  goalObjective: (objective) => `🎯 Goal: ${objective}`,
  goalStatus: (status) => `Status: ${status}`,
  goalRounds: (started, max) => `Rounds: ${started}/${max}`,
  goalAutoRun: (armed) => `Auto-continue: ${armed ? "armed" : "disarmed"}`,
  goalBlockedReason: (message) => `Blocked reason: ${message}`,

  noReminders:
    "No scheduled reminders in this session. Tell the agent “remind me in 5 minutes…” to create one (requires the schedule plugin mounted in the profile).",
  reminderDue: "⚠️ Due",
  reminderClock: "⏰",
  reminderEvery: (minutes) => `every ${minutes} min`,
  reminderOnce: "one-time",
  reminderLine: (state, id, prompt, kind, when) => `${state} [${id}] ${prompt} (${kind}, ${when})`,
  remindersCount: (n, list) => `Scheduled reminders (${n}):\n${list}`,
  noWorkspaces: "No workspaces yet. Create one with `/workspace <absolute path>`.",
  workspaceSessions: (n) => `  · ${n} session(s)`,
  workspacesCount: (n, list) => `Workspaces (${n}):\n${list}`,

  currentDir: "Current directory",

  mirrorCreated: (sessionId) => `✅ Web mirror session created: ${sessionId}\nOpen this session in DSH Web to view the Feishu conversation history.`,
  mirrorAlreadyExists: (sessionId) => `Web mirror session already exists: ${sessionId}`,
  mirrorNotConfigured: "No Web mirror configured for this session. Use /mirror to create one.",
  sessionLockedBy: (channel) => `⚠️ Session is locked by ${channel === "feishu" ? "Feishu" : "Web"}, currently in read-only mode`,
  sessionReadOnly: "🔒 Session locked, view-only mode",
  lockReleased: "🔓 Session lock released",
  lockTimeoutReleased: (minutes) => `⏰ Session lock timed out (${minutes} minutes of inactivity), auto-released`,
  unlockSuccess: "🔓 Session lock manually released",
  unlockNoLock: "No active session lock",
  lockRenewed: (minutes) => `🔄 Session lock renewed for ${minutes} minutes`,
  messageQueued: (position) => `📥 Message queued (position ${position}), will execute after lock release`,
  queueProcessed: (count) => `✅ Processed ${count} queued message(s)`,
  exportMarkdown: (path) => `📄 Conversation history exported to Markdown:\n${path}`,
  exportPdfNotSupported: "⚠️ PDF export is not supported yet, please use Markdown format",
  exportNoSession: "No active session to export",
  exportFailed: (error) => `❌ Export failed: ${error}`,
  mirrorStatus: (sessionId, lockedBy, timeoutMin, queuedCount) => {
    const lockInfo = lockedBy ? `\nLocked by: ${lockedBy === "feishu" ? "Feishu" : "Web"}` : "";
    const timeoutInfo = timeoutMin !== undefined ? `\nTimeout: ${timeoutMin} minutes` : "";
    const queueInfo = queuedCount && queuedCount > 0 ? `\nQueued messages: ${queuedCount}` : "";
    return `Web mirror session: ${sessionId}${lockInfo}${timeoutInfo}${queueInfo}`;
  },
  webMirrorIndicator: "🌐",
  sessionAvailableOnWeb: "(also available on Web)",

  helpHeader: "Available commands (run locally, no model tokens):",
  helpMenu: "open the main menu (hierarchical, back supported)",
  helpSettings: "settings: model / reasoning effort / notifications / config overview",
  helpStatus: "session status, model, workdir, queue length",
  helpTask: "show the current task list (todo)",
  helpChat: "list conversations; tap to switch or create",
  helpDir: "list workdirs; tap to switch (or `/dir <absolute path>` to set manually)",
  helpWorkspace: "create a workspace",
  helpPlugins: "list installed plugins",
  helpCompact: "compact the current session context",
  helpHistory: "show recent session messages",
  helpGoals: "show current goals",
  helpSchedule: "show scheduled reminders for this session",
  helpModel: "view / switch the model",
  helpNotify: "choose notification level (full process / key milestones / result only)",
  helpWorkspaces: "list all workspaces",
  helpNew: "start a new conversation",
  helpClear: "clear the current conversation",
  helpStop: "stop the current task",
  helpOther: "any other text is sent to the DSH agent as a task",
};

export function messages(lang: Language): Messages {
  return lang === "en" ? en : zh;
}
