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
  processingFailed(detail: string): string;
  imageDownloadFailed(imageError: string): string;
  imagesStaged(locations: string, description: string): string;
  imageDescriptionLabel(description: string): string;
  imageNoDescription: string;
  visionPrompt: string;
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

  streamLabel(on: boolean): string;
  summaryLabel(on: boolean): string;
  statusNoSession(workdir: string): string;
  statusRunning: string;
  statusIdle: string;
  statusField(status: string): string;
  modelField(model: string): string;
  workdirField(workdir: string): string;
  queuedField(n: number): string;
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

  thinkingHint: "🤔 深度思考中…\n",
  processingFailed: (detail) => `⚠️ 处理失败：${detail}`,
  imageDownloadFailed: (imageError) => `[用户发送了图片，但下载失败：${imageError}]`,
  imagesStaged: (locations, description) =>
    description !== ""
      ? `[用户发送了图片，图片已保存到以下路径（可用工具查看）：\n${locations}\n图片内容说明：\n${description}]`
      : `[用户发送了图片，图片已保存到以下路径（可用工具查看）：\n${locations}\n（未能自动分析图片内容，请用文件/终端工具查看这些图片。）]`,
  imageDescriptionLabel: (description) => `图片内容说明：\n${description}`,
  imageNoDescription: "（未能自动分析图片内容，请用文件/终端工具查看这些图片。）",
  visionPrompt:
    "请详细描述这些图片的内容（物体、场景、文字、布局、氛围等），供一个无法直接查看图片的主模型理解。",
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

  streamLabel: (on) => `流式输出：${on ? "开" : "关"}`,
  summaryLabel: (on) => `结束摘要：${on ? "开" : "关"}`,
  statusNoSession: (workdir) => `状态：无活动会话\n工作目录：${workdir}`,
  statusRunning: "🟢 运行中",
  statusIdle: "⚪ 空闲",
  statusField: (status) => `状态：${status}`,
  modelField: (model) => `模型：${model}`,
  workdirField: (workdir) => `工作目录：${workdir}`,
  queuedField: (n) => `待处理消息：${n}`,
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

  thinkingHint: "🤔 Deep thinking…\n",
  processingFailed: (detail) => `⚠️ Processing failed: ${detail}`,
  imageDownloadFailed: (imageError) => `[The user sent an image, but download failed: ${imageError}]`,
  imagesStaged: (locations, description) =>
    description !== ""
      ? `[The user sent images, saved to the following paths (viewable with tools):\n${locations}\nImage description:\n${description}]`
      : `[The user sent images, saved to the following paths (viewable with tools):\n${locations}\n(No image analysis available — inspect the files with the file/terminal tools.)]`,
  imageDescriptionLabel: (description) => `Image description:\n${description}`,
  imageNoDescription: "(No image analysis available — inspect the files with the file/terminal tools.)",
  visionPrompt:
    "Describe these images in detail (objects, scene, text, layout, atmosphere, etc.) for a main model that cannot view images directly.",
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

  streamLabel: (on) => `Streaming output: ${on ? "on" : "off"}`,
  summaryLabel: (on) => `End-of-turn summary: ${on ? "on" : "off"}`,
  statusNoSession: (workdir) => `Status: no active session\nWorkdir: ${workdir}`,
  statusRunning: "🟢 Running",
  statusIdle: "⚪ Idle",
  statusField: (status) => `Status: ${status}`,
  modelField: (model) => `Model: ${model}`,
  workdirField: (workdir) => `Workdir: ${workdir}`,
  queuedField: (n) => `Queued messages: ${n}`,
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
  helpWorkspaces: "list all workspaces",
  helpNew: "start a new conversation",
  helpClear: "clear the current conversation",
  helpStop: "stop the current task",
  helpOther: "any other text is sent to the DSH agent as a task",
};

export function messages(lang: Language): Messages {
  return lang === "en" ? en : zh;
}
