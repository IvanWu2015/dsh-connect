/**
 * Every user-visible string in the dsh-connect settings pane, in both shipped
 * languages.
 *
 * Kept in its own dependency-free module — rather than inline in the component —
 * so a test can import it directly and assert the two languages cover exactly
 * the same keys. That assertion is the whole point: the host's `t()` resolves
 * `lookup(ns, key, chain) ?? lookup("common", key, chain) ?? key`, and a key
 * missing from `zh` **silently renders the `en` string**, so a Chinese UI with
 * one untranslated key reads as half-English with no error anywhere. Checking
 * coverage mechanically is the only way that stays fixed.
 *
 * Key scheme:
 * - plain keys  — chrome (titles, buttons, status words)
 * - `view.<name>` — a primary-navigation view label (`PANE_VIEWS`)
 * - `channel.<name>` / `channel.<name>.hint` — one card per channel
 * - `f.<key>` / `f.<key>.hint` — a non-secret *per-channel* config field
 *   (`CHANNEL_CONFIG_FIELDS` / `CHANNEL_DEFAULT_FIELDS`)
 * - `g.<key>` / `g.<key>.hint` — a *general* (plugin-wide) config field
 *   (`GENERAL_FIELDS`). Separate from `f.*` on purpose: the channel-level
 *   `language` is 「回复语言」 while the general one is 「语言」, so one shared
 *   wording would be wrong in one of the two places.
 * - `s.<channel>.<key>` / `.hint` — a secret field (`CHANNEL_SECRET_FIELDS`)
 * - `o.<value>` — a `select` option value, shared across fields
 * - `onboard.<step>` — the one-click Feishu creation flow (label, hint, each
 *   result line and each subscription outcome)
 * - `status.<state>` — the save-button status line
 * - `cs.<state>` — a *connection* state badge beside the credentials badge
 *   (`CHANNEL_CONNECTION_STATES`). Deliberately not folded into `status.*`: that
 *   one reports on the save the user just pressed, this one on the channel's
 *   live transport, and one wording cannot be true about both. `cs.reconnecting.n`
 *   carries the attempt count in a `{n}` placeholder, substituted at the call
 *   site — the locale test asserts the placeholder survives in both languages.
 * - `w.<code>` — a non-fatal warning code from the host (`SettingsWarningCode`)
 */

export const LOCALES = {
  zh: {
    title: 'dsh-connect',
    channels: '渠道',
    defaults: '公共默认',
    defaultsHint: '未单独配置的渠道沿用这里的取值；留空表示沿用各渠道自身的默认值。',
    save: '保存',
    saved: '已保存',
    error: '保存失败',
    loading: '加载中…',
    statePath: '设置文件',
    statePathHint: '宿主没有提供设置命名空间时，配置回退存放在这个 JSON 文件里。',
    livePlane: '配置写入 cordis.patch.yml，保存后立即生效。',
    filePlane: '配置存放在本地设置文件，重启 dsh 后生效。',
    reachable: '已配置凭据',
    unreachable: '未配置凭据',
    configured: '已配置，重新填写可覆盖',
    current: '当前值：',
    notConfigured: '未配置',
    replaceHint: '重新填写会覆盖已保存的值；留空则不修改。',
    currentMasked: '当前值（已脱敏）：',
    previewNote: '凭据直接显示在对应输入框中，便于核对；密钥类只显示脱敏后的首尾字符，需重新填写才能替换。',
    secrets: '凭据与密钥',
    expand: '展开',
    collapse: '收起',
    advanced: '高级选项',
    tabsAria: '渠道切换',
    navAria: '设置分区',
    'view.general': '通用设置',
    'view.channels': '机器人渠道',
    credentialUnknown: '凭据状态未知',
    credentialUnknownHint: '无法读取已存储的凭据，请确认凭据库可访问后重试。',
    channelFailed: '渠道启动失败：',

    'onboard.create': '一键创建并配置飞书机器人',
    'onboard.create.hint': '自动创建一个飞书自建应用、声明所需权限，把凭据存到本地并启用这个渠道。点完在浏览器里确认一次即可。',
    'onboard.starting': '正在申请…',
    'onboard.waiting': '等待在飞书中确认…',
    'onboard.link': '请在浏览器打开下面的链接完成确认（页面里有二维码）：',
    'onboard.linkExpiry': '链接有效期约 {minutes} 分钟，仅能使用一次。',
    'onboard.cancel': '取消',
    'onboard.manual.telegram': 'Telegram 没有创建机器人的接口：请在 Telegram 里找 @BotFather 申请一个机器人，再把拿到的 Bot Token 填到下面。',
    'onboard.manual.dingtalk': '钉钉机器人需要在钉钉开放平台手动创建，再把拿到的凭据填到下面。',

    'onboard.created': '已创建应用',
    'onboard.credentialsStored': '凭据已写入凭据库',
    'onboard.credentialsNotStored': '凭据没有写入凭据库',
    'onboard.legacyMirrorFailed': '旧版的凭据文件也没有写入',
    'onboard.enableRequested': '已在配置里启用飞书渠道',
    'onboard.enableFailed': '没能把飞书渠道写进配置',
    'onboard.notApplied': '凭据已保存，但运行中的渠道没能重新加载，请重启 dsh 后确认。',
    'onboard.applyPending': '流程没有走完，运行中的渠道尚未重新加载，请重启 dsh 后确认。',
    'onboard.needsManual': '事件订阅方式还需要到飞书开放平台手动确认。',
    'onboard.cancelled': '已取消创建',
    'onboard.expired': '确认链接已过期，请重新点击创建。',
    'onboard.createFailed': '创建失败',

    'onboard.subscription.applied': '事件订阅已设为长连接',
    'onboard.subscription.failed': '事件订阅设置失败',
    'onboard.subscription.skipped': '没有可用凭据，未设置事件订阅',
    'onboard.subscription.notAttempted': '未能走到设置事件订阅这一步',

    'w.credentialsStoredNotApplied': '凭据已保存，但运行中的渠道没能重新加载，请重启 dsh 后确认。',

    // The two halves of a save fail independently, so they are reported
    // independently — see `onSave` in `settings-client.mjs`.
    'saveFailedSettings': '配置设置未保存，请重试。',
    'saveFailedCredentials': '凭据未保存，请重新输入后再保存。',

    'status.loading': '加载中…',
    'status.idle': '就绪',
    'status.saving': '保存中…',
    'status.saved': '已保存',
    'status.error': '保存失败',

    'cs.disabled': '未启用',
    'cs.stopped': '未运行',
    'cs.failed': '接入失败',
    'cs.running': '运行中',
    'cs.idle': '空闲',
    'cs.connecting': '连接中',
    'cs.connected': '已连接',
    'cs.reconnecting': '重连中',
    'cs.reconnecting.n': '重连中（第 {n} 次）',

    'channel.feishu': '飞书 / Lark',
    'channel.feishu.hint': '在飞书开放平台创建自建应用，用长连接接收消息。',
    'channel.telegram': 'Telegram',
    'channel.telegram.hint': '通过 Telegram Bot API 长轮询接收消息，机器人向 @BotFather 申请。',
    'channel.dingtalk': '钉钉',
    'channel.dingtalk.hint': '支持 Webhook 推送与 Stream 双向两种模式，填其中一组即可。',
    'channel.web': '网页',
    'channel.web.hint': '直接在 DSH 网页界面里对话，不需要任何凭据。',

    'f.transport': '接入方式',
    'f.transport.hint': '长连接无需公网地址，推荐；回调地址需要 DSH 所在机器可从公网访问。',
    'f.requireMention': '仅响应 @ 提及',
    'f.requireMention.hint': '开启后群聊中只有 @ 机器人才处理；单聊不受影响。',
    'f.dmMode': '单聊策略',
    'f.dmMode.hint': '控制哪些人可以直接私聊机器人。',
    'f.language': '回复语言',
    'f.language.hint': '机器人回复用户时使用的语言。',
    'f.threadIsolation': '话题独立会话',
    'f.threadIsolation.hint': '开启后，同一个群里的每个话题各自拥有独立的会话上下文；关闭则整个群共用一个会话。',
    'f.onboarding': '允许首次扫码创建',
    'f.onboarding.hint': '关闭后，缺少凭据时不再进入扫码引导流程，只提示手动填写。',
    'f.webhookPort': '回调端口',
    'f.webhookPort.hint': '仅「回调地址」接入方式使用，默认 3000。',
    'f.webhookPath': '回调路径',
    'f.webhookPath.hint': '仅「回调地址」接入方式使用，例如 /feishu/events。',
    'f.pollingTimeoutSeconds': '轮询超时（秒）',
    'f.pollingTimeoutSeconds.hint': '单次长轮询等待秒数，默认 30。',
    'f.baseUrl': '接口地址',
    'f.baseUrl.hint': 'Telegram Bot API 地址，只有在自建反向代理时才需要修改。',
    // Access control is per channel because the identifiers are: a Feishu
    // `ou_…` open id cannot match a Telegram numeric user id, so one shared
    // list could only ever be right for one of them. One wording serves every
    // channel (`f.<key>` is channel-agnostic), and the hint says which ids.
    'f.allowUsers': '允许的发送者',
    'f.allowUsers.hint': '每行一个该渠道的用户 ID（如飞书的 open_id）。留空表示不限制发送者；填写后只有名单内的用户可以对话。',
    'f.allowChats': '允许的会话',
    'f.allowChats.hint': '每行一个该渠道的会话 ID。留空表示不限会话；填写后只有名单内的会话会收到回复。',
    'g.allowUsers.hint': '所有渠道共用的兜底名单。某个渠道若在上方单独设置了名单，以该渠道的为准。',
    'g.allowChats.hint': '所有渠道共用的兜底名单；渠道单独设置时以渠道为准。',
    'f.stream.url': 'Stream 地址',
    'f.stream.url.hint': '钉钉 Stream 模式的接入地址，只有在自建代理时才需要修改。',
    'f.stream.requireMention': '仅响应 @ 提及',
    'f.stream.requireMention.hint': '开启后群聊中只有 @ 机器人才处理；单聊不受影响。',
    'f.pollIntervalMs': '轮询间隔（毫秒）',
    'f.pollIntervalMs.hint': '网页渠道检查新消息的间隔，默认 1000。',

    // General settings. These resolve once when the plugin starts and there is
    // no hot reload, so every hint says so — a control that silently does
    // nothing until a restart is worse than one that says it will.
    'g.group.locale': '语言与提醒',
    'g.group.workspace': '工作目录',
    'g.group.access': '访问控制',
    'g.group.agent': '智能体',
    'g.group.context': '上下文',
    'g.autoCompact': '自动压缩上下文',
    'g.autoCompact.hint': '开启后，一轮任务结束时若上下文占用达到下面的阈值，自动压缩会话历史，无需手动发送 /compact。压缩本身不发送聊天消息；失败时才会提示。修改后需重启 dsh 才生效。',
    'g.autoCompactThresholdPct': '自动压缩阈值（%）',
    'g.autoCompactThresholdPct.hint': '上下文占用达到这个百分比时触发自动压缩，默认 80。仅在开启「自动压缩上下文」后生效。修改后需重启 dsh 才生效。',
    'g.language': '语言',
    'g.language.hint': '机器人回复用户使用的语言，对所有渠道生效（渠道卡片里的「回复语言」可单独覆盖）。修改后需重启 dsh 才生效。',
    'g.notifyLevel': '通知级别',
    'g.notifyLevel.hint': '控制机器人把多少过程信息发到聊天里。修改后需重启 dsh 才生效。',
    'g.progressTimeoutMs': '进度提醒超时（毫秒）',
    'g.progressTimeoutMs.hint': '任务超过这个时长没有输出时，给用户发一条进度提醒。修改后需重启 dsh 才生效。',
    'g.workDir': '默认工作目录',
    'g.workDir.hint': '机器人新建会话时使用的目录。修改后需重启 dsh 才生效。',
    'g.workspaces': '额外工作区',
    'g.workspaces.hint': '每行一个目录。这里的内容会与 dsh.shared.config.json 里的 additionalWorkspaces 合并，而不是替换它。修改后需重启 dsh 才生效。',
    'g.allowUsers': '允许的用户',
    'g.allowUsers.hint': '每行一个用户标识；留空表示不限制。修改后需重启 dsh 才生效。',
    'g.allowChats': '允许的会话',
    'g.allowChats.hint': '每行一个会话 ID；留空表示不限制。修改后需重启 dsh 才生效。',
    'g.agentPreset': '智能体预设',
    'g.agentPreset.hint': '新建会话默认使用的预设名称；留空表示沿用 DSH 的默认值。修改后需重启 dsh 才生效。',
    'g.autoMirror': '自动镜像会话',
    'g.autoMirror.hint': '把机器人发起的会话也显示在 DSH 网页界面里。修改后需重启 dsh 才生效。',
    'g.streamHeartbeatMs': '流式心跳（毫秒）',
    'g.streamHeartbeatMs.hint': '流式回复期间向聊天发送心跳的间隔，避免长任务看起来像卡住。修改后需重启 dsh 才生效。',
    'g.sharedOverride': '当前取值来自 dsh.shared.config.json，此处的修改不会生效。',
    'g.model': '默认模型',
    'g.model.note': '此值由 DSH 管理，请在 DSH 里切换。',

    's.feishu.appId': 'App ID',
    's.feishu.appId.hint': '开放平台「凭证与基础信息」中的 App ID，非机密，完整显示。',
    's.feishu.appSecret': 'App Secret',
    's.feishu.appSecret.hint': '与 App ID 配对的应用密钥，属于机密，仅显示首尾各 4 位。',
    's.feishu.verificationToken': 'Verification Token',
    's.feishu.verificationToken.hint': '仅「回调地址」模式需要，在开放平台「事件与回调」里获取；属于机密。用长连接模式可留空。',
    's.feishu.encryptKey': 'Encrypt Key',
    's.feishu.encryptKey.hint': '仅「回调地址」模式需要，与 Verification Token 同页的加密密钥；属于机密。用长连接模式可留空。',
    's.telegram.botToken': 'Bot Token',
    's.telegram.botToken.hint': '@BotFather 生成的机器人令牌，形如 123456:ABC…，属于机密。',
    's.dingtalk.webhookUrl': 'Webhook 地址',
    's.dingtalk.webhookUrl.hint': '群机器人的完整 Webhook 地址；预览保留域名与路径，只遮蔽 access_token。',
    's.dingtalk.secret': '加签密钥',
    's.dingtalk.secret.hint': '群机器人开启「加签」安全设置后才有，属于机密。',
    's.dingtalk.clientId': 'Client ID',
    's.dingtalk.clientId.hint': 'Stream 模式应用的 AppKey，非机密，完整显示。',
    's.dingtalk.clientSecret': 'Client Secret',
    's.dingtalk.clientSecret.hint': 'Stream 模式应用的 AppSecret，属于机密，仅显示首尾各 4 位。',

    'o.default': '（沿用默认）',
    'o.websocket': '长连接（推荐）',
    'o.webhook': '回调地址',
    'o.open': '所有人都可以',
    'o.allowlist': '仅名单内的人',
    'o.pair': '需要先配对',
    'o.disabled': '关闭单聊',
    'o.zh': '中文',
    'o.en': '英文',
    'o.full': '全部过程',
    'o.important': '关键节点',
    'o.result': '仅最终结果',
  },
  en: {
    title: 'dsh-connect',
    channels: 'Channels',
    defaults: 'Defaults',
    defaultsHint: 'Channels without their own value fall back to these; leave a field empty to use each channel’s built-in default.',
    save: 'Save',
    saved: 'Saved',
    error: 'Save failed',
    loading: 'Loading…',
    statePath: 'Settings file',
    statePathHint: 'Where the config falls back to when the host has no settings namespace live.',
    livePlane: 'Written to cordis.patch.yml — a save takes effect immediately.',
    filePlane: 'Stored in a local settings file — a save applies after dsh restarts.',
    reachable: 'Credentials set',
    unreachable: 'Credentials missing',
    configured: 'Configured — type to replace',
    current: 'Current value: ',
    notConfigured: 'Not configured',
    replaceHint: 'Typing a new value replaces the stored one; leaving it empty keeps it.',
    currentMasked: 'Current value (masked): ',
    previewNote: 'Credentials are shown directly in their fields so you can check them. Confidential keys show only masked head and tail characters — retype to replace.',
    secrets: 'Credentials & secrets',
    expand: 'Expand',
    collapse: 'Collapse',
    advanced: 'Advanced',
    tabsAria: 'Channel switcher',
    navAria: 'Settings sections',
    'view.general': 'General',
    'view.channels': 'Bot channels',
    credentialUnknown: 'Credential state unknown',
    credentialUnknownHint: 'The stored credentials could not be read — check that the credential store is reachable, then try again.',
    channelFailed: 'Channel failed to start:',

    'onboard.create': 'Create and configure a Feishu bot in one click',
    'onboard.create.hint': 'Creates a Feishu custom app, declares the permissions it needs, stores the credentials locally, and enables this channel. You confirm once in the browser and it is done.',
    'onboard.starting': 'Requesting…',
    'onboard.waiting': 'Waiting for you to confirm in Feishu…',
    'onboard.link': 'Open this link in a browser to confirm (the page shows a QR code):',
    'onboard.linkExpiry': 'The link is valid for about {minutes} minutes and works only once.',
    'onboard.cancel': 'Cancel',
    'onboard.manual.telegram': 'Telegram has no bot-creation API: ask @BotFather inside Telegram for a bot, then paste the Bot Token into the field below.',
    'onboard.manual.dingtalk': 'A DingTalk bot has to be created by hand on the DingTalk open platform; paste the credentials you get into the fields below.',

    'onboard.created': 'App created',
    'onboard.credentialsStored': 'Credentials written to the credential store',
    'onboard.credentialsNotStored': 'Credentials were not written to the credential store',
    'onboard.legacyMirrorFailed': 'The legacy credential file was not written either',
    'onboard.enableRequested': 'Feishu enabled in the config',
    'onboard.enableFailed': 'Feishu could not be written into the config',
    'onboard.notApplied': 'The credential was saved, but the running channels did not reload it — restart dsh to be sure.',
    'onboard.applyPending': 'The flow did not finish, so the running channels have not reloaded — restart dsh to be sure.',
    'onboard.needsManual': 'The event subscription mode still needs confirming by hand on the Feishu open platform.',
    'onboard.cancelled': 'Creation cancelled',
    'onboard.expired': 'The confirmation link expired — click create again.',
    'onboard.createFailed': 'Creation failed',

    'onboard.subscription.applied': 'Event subscription set to long connection',
    'onboard.subscription.failed': 'Setting the event subscription failed',
    'onboard.subscription.skipped': 'No usable credentials, so the event subscription was not set',
    'onboard.subscription.notAttempted': 'The flow never reached the event subscription step',

    'w.credentialsStoredNotApplied': 'The credential was saved, but the running channels did not reload it — restart dsh to be sure.',

    // The two halves of a save fail independently, so they are reported
    // independently — see `onSave` in `settings-client.mjs`.
    'saveFailedSettings': 'The settings were not saved — please try again.',
    'saveFailedCredentials': 'The credential was not stored — re-enter it and save again.',

    'status.loading': 'Loading…',
    'status.idle': 'Ready',
    'status.saving': 'Saving…',
    'status.saved': 'Saved',
    'status.error': 'Save failed',

    'cs.disabled': 'Not enabled',
    'cs.stopped': 'Not running',
    'cs.failed': 'Connection failed',
    'cs.running': 'Running',
    'cs.idle': 'Idle',
    'cs.connecting': 'Connecting',
    'cs.connected': 'Connected',
    'cs.reconnecting': 'Reconnecting',
    'cs.reconnecting.n': 'Reconnecting (attempt {n})',

    'channel.feishu': 'Feishu / Lark',
    'channel.feishu.hint': 'Create a custom app on the Feishu open platform and receive messages over a long connection.',
    'channel.telegram': 'Telegram',
    'channel.telegram.hint': 'Receive messages by long-polling the Telegram Bot API; get a bot from @BotFather.',
    'channel.dingtalk': 'DingTalk',
    'channel.dingtalk.hint': 'Supports both webhook push and stream mode — fill in either set.',
    'channel.web': 'Web',
    'channel.web.hint': 'Chat straight from the DSH web UI; needs no credentials at all.',

    'f.transport': 'Transport',
    'f.transport.hint': 'A long connection needs no public address and is recommended; a callback URL requires this machine to be reachable from the internet.',
    'f.requireMention': 'Only when @-mentioned',
    'f.requireMention.hint': 'In group chats, handle a message only if the bot was mentioned. Direct messages are unaffected.',
    'f.dmMode': 'Direct messages',
    'f.dmMode.hint': 'Who is allowed to message the bot directly.',
    'f.language': 'Reply language',
    'f.language.hint': 'The language the bot replies to users in.',
    'f.threadIsolation': 'Per-topic sessions',
    'f.threadIsolation.hint': 'When on, each topic in a group chat keeps its own conversation context; when off, the whole group shares one session.',
    'f.onboarding': 'Allow first-run QR setup',
    'f.onboarding.hint': 'When off, a missing credential no longer starts the QR flow; the pane only asks you to fill the fields in.',
    'f.webhookPort': 'Callback port',
    'f.webhookPort.hint': 'Used only by the callback-URL transport; defaults to 3000.',
    'f.webhookPath': 'Callback path',
    'f.webhookPath.hint': 'Used only by the callback-URL transport, e.g. /feishu/events.',
    'f.pollingTimeoutSeconds': 'Poll timeout (s)',
    'f.pollingTimeoutSeconds.hint': 'How long one long poll waits; defaults to 30.',
    'f.baseUrl': 'API base URL',
    'f.baseUrl.hint': 'The Telegram Bot API endpoint — only change it if you run your own proxy.',
    'f.allowUsers': 'Allowed senders',
    'f.allowUsers.hint': 'One user id per line, in this channel\u2019s own format (e.g. a Feishu open_id). Empty means no sender restriction; once set, only listed users are answered.',
    'f.allowChats': 'Allowed chats',
    'f.allowChats.hint': 'One chat id per line, in this channel\u2019s own format. Empty means every chat; once set, only listed chats are answered.',
    'g.allowUsers.hint': 'Fallback list shared by every channel. A channel that sets its own list above uses that instead.',
    'g.allowChats.hint': 'Fallback list shared by every channel; a channel\u2019s own list wins.',
    'f.stream.url': 'Stream URL',
    'f.stream.url.hint': 'The DingTalk Stream endpoint — only change it if you run your own proxy.',
    'f.stream.requireMention': 'Only when @-mentioned',
    'f.stream.requireMention.hint': 'In group chats, handle a message only if the bot was mentioned. Direct messages are unaffected.',
    'f.pollIntervalMs': 'Poll interval (ms)',
    'f.pollIntervalMs.hint': 'How often the web channel checks for new messages; defaults to 1000.',

    // General settings. These resolve once when the plugin starts and there is
    // no hot reload, so every hint says so — a control that silently does
    // nothing until a restart is worse than one that says it will.
    'g.group.locale': 'Language & notices',
    'g.group.workspace': 'Working directories',
    'g.group.access': 'Access control',
    'g.group.agent': 'Agent',
    'g.group.context': 'Context',
    'g.autoCompact': 'Auto-compact context',
    'g.autoCompact.hint': 'When on, a session is compacted automatically at the end of a turn once context usage reaches the threshold below — no need to send /compact by hand. Compaction itself posts no chat message; only a failure does. A change takes effect after dsh restarts.',
    'g.autoCompactThresholdPct': 'Auto-compact threshold (%)',
    'g.autoCompactThresholdPct.hint': 'Context usage at which auto-compaction fires, default 80. Only applies when “Auto-compact context” is on. A change takes effect after dsh restarts.',
    'g.language': 'Language',
    'g.language.hint': 'The language the bot replies to users in, for every channel (a channel card’s “Reply language” overrides it). A change takes effect after dsh restarts.',
    'g.notifyLevel': 'Notify level',
    'g.notifyLevel.hint': 'How much of the working process the bot posts into the chat. A change takes effect after dsh restarts.',
    'g.progressTimeoutMs': 'Progress timeout (ms)',
    'g.progressTimeoutMs.hint': 'How long a task may go without output before the user gets a progress notice. A change takes effect after dsh restarts.',
    'g.workDir': 'Default working directory',
    'g.workDir.hint': 'The directory the bot uses for new sessions. A change takes effect after dsh restarts.',
    'g.workspaces': 'Additional workspaces',
    'g.workspaces.hint': 'One directory per line. These are merged with additionalWorkspaces from dsh.shared.config.json rather than replacing it. A change takes effect after dsh restarts.',
    'g.allowUsers': 'Allowed users',
    'g.allowUsers.hint': 'One user id per line; leave empty to allow everyone. A change takes effect after dsh restarts.',
    'g.allowChats': 'Allowed chats',
    'g.allowChats.hint': 'One chat id per line; leave empty to allow every chat. A change takes effect after dsh restarts.',
    'g.agentPreset': 'Agent preset',
    'g.agentPreset.hint': 'The preset new sessions use by default; leave empty for the DSH default. A change takes effect after dsh restarts.',
    'g.autoMirror': 'Mirror sessions',
    'g.autoMirror.hint': 'Also show bot-created sessions in the DSH web UI. A change takes effect after dsh restarts.',
    'g.streamHeartbeatMs': 'Stream heartbeat (ms)',
    'g.streamHeartbeatMs.hint': 'How often a heartbeat is posted into the chat while a reply streams, so a long task does not look stuck. A change takes effect after dsh restarts.',
    'g.sharedOverride': 'The current value comes from dsh.shared.config.json — editing it here has no effect.',
    'g.model': 'Default model',
    'g.model.note': 'DSH owns this value — switch it inside DSH.',

    's.feishu.appId': 'App ID',
    's.feishu.appId.hint': 'The App ID from the open platform’s credentials page. Not a secret — shown in full.',
    's.feishu.appSecret': 'App Secret',
    's.feishu.appSecret.hint': 'The app secret paired with the App ID. Confidential — only the first and last 4 characters are shown.',
    's.feishu.verificationToken': 'Verification Token',
    's.feishu.verificationToken.hint': 'Only needed by the “callback URL” transport, from the open platform’s events page. Confidential; leave empty when using the websocket transport.',
    's.feishu.encryptKey': 'Encrypt Key',
    's.feishu.encryptKey.hint': 'Only needed by the “callback URL” transport — the encryption key on the same page as the verification token. Confidential; leave empty when using the websocket transport.',
    's.telegram.botToken': 'Bot Token',
    's.telegram.botToken.hint': 'The bot token from @BotFather, like 123456:ABC… — confidential.',
    's.dingtalk.webhookUrl': 'Webhook URL',
    's.dingtalk.webhookUrl.hint': 'The group robot’s full webhook URL; the preview keeps the host and path and masks only the access_token.',
    's.dingtalk.secret': 'Signing secret',
    's.dingtalk.secret.hint': 'Only present once the group robot has the “sign” security setting enabled — confidential.',
    's.dingtalk.clientId': 'Client ID',
    's.dingtalk.clientId.hint': 'The AppKey of the stream-mode app. Not a secret — shown in full.',
    's.dingtalk.clientSecret': 'Client Secret',
    's.dingtalk.clientSecret.hint': 'The AppSecret of the stream-mode app. Confidential — only the first and last 4 characters are shown.',

    'o.default': '(use default)',
    'o.websocket': 'Long connection (recommended)',
    'o.webhook': 'Callback URL',
    'o.open': 'Anyone',
    'o.allowlist': 'Allowlisted users only',
    'o.pair': 'Pairing required',
    'o.disabled': 'Direct messages off',
    'o.zh': 'Chinese',
    'o.en': 'English',
    'o.full': 'Everything',
    'o.important': 'Key milestones',
    'o.result': 'Final result only',
  },
};

/** The union of keys the two languages cover. */
export const LOCALE_KEYS = Object.keys(LOCALES.zh);

/** True when a key is shipped in both languages. */
export function hasLocale(key) {
  return Object.prototype.hasOwnProperty.call(LOCALES.zh, key) && Object.prototype.hasOwnProperty.call(LOCALES.en, key);
}

/**
 * Translate a key that is guaranteed to be present, falling back if it somehow
 * isn't. The host returns the *key itself* for a miss, which would render
 * `f.dmMode` into the UI — a fallback keeps that a legible label instead.
 */
export function tr(t, key, fallback) {
  return hasLocale(key) ? t(key) : fallback;
}

/** Translate an optional key: `undefined` when absent, so callers can skip the node. */
export function optionalText(t, key) {
  return hasLocale(key) ? t(key) : undefined;
}
