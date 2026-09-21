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
 * - `channel.<name>` / `channel.<name>.hint` — one card per channel
 * - `f.<key>` / `f.<key>.hint` — a non-secret config field (`CHANNEL_CONFIG_FIELDS`)
 * - `s.<channel>.<key>` / `.hint` — a secret field (`CHANNEL_SECRET_FIELDS`)
 * - `o.<value>` — a `select` option value, shared across fields
 * - `status.<state>` — the save-button status line
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
    statePathHint: '没有 settings.yaml 命名空间时，配置回退存放在这个 JSON 文件里。',
    livePlane: '配置存放在 settings.yaml，保存后立即生效。',
    filePlane: '配置存放在本地设置文件，重启 dsh 后生效。',
    reachable: '已配置凭据',
    unreachable: '未配置凭据',
    configured: '已配置，重新填写可覆盖',
    current: '当前值：',
    notConfigured: '未配置',
    previewNote: '为便于确认，此处只显示脱敏后的部分字符；输入框留空表示不修改。',
    secrets: '凭据与密钥',
    expand: '展开',
    collapse: '收起',
    advanced: '高级选项',
    tabsAria: '渠道切换',

    'status.loading': '加载中…',
    'status.idle': '就绪',
    'status.saving': '保存中…',
    'status.saved': '已保存',
    'status.error': '保存失败',

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
    'f.webhookPort': '回调端口',
    'f.webhookPort.hint': '仅「回调地址」接入方式使用，默认 3000。',
    'f.webhookPath': '回调路径',
    'f.webhookPath.hint': '仅「回调地址」接入方式使用，例如 /feishu/events。',
    'f.pollingTimeoutSeconds': '轮询超时（秒）',
    'f.pollingTimeoutSeconds.hint': '单次长轮询等待秒数，默认 30。',
    'f.baseUrl': '接口地址',
    'f.baseUrl.hint': 'Telegram Bot API 地址，只有在自建反向代理时才需要修改。',
    'f.defaultAt': '默认 @ 成员',
    'f.defaultAt.hint': '群消息默认 @ 的成员，多个用逗号分隔。',
    'f.pollIntervalMs': '轮询间隔（毫秒）',
    'f.pollIntervalMs.hint': '网页渠道检查新消息的间隔，默认 1000。',
    'f.notifyLevel': '通知级别',
    'f.notifyLevel.hint': '控制机器人把多少过程信息发到聊天里。',

    's.feishu.appId': 'App ID',
    's.feishu.appId.hint': '开放平台「凭证与基础信息」中的 App ID，非机密，完整显示。',
    's.feishu.appSecret': 'App Secret',
    's.feishu.appSecret.hint': '与 App ID 配对的应用密钥，属于机密，仅显示首尾各 4 位。',
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
    statePathHint: 'Where the config falls back to when no settings.yaml namespace is live.',
    livePlane: 'Stored in settings.yaml — a save takes effect immediately.',
    filePlane: 'Stored in a local settings file — a save applies after dsh restarts.',
    reachable: 'Credentials set',
    unreachable: 'Credentials missing',
    configured: 'Configured — type to replace',
    current: 'Current value: ',
    notConfigured: 'Not configured',
    previewNote: 'Shown masked, so you can confirm the stored value without exposing it. Leave the input empty to keep it.',
    secrets: 'Credentials & secrets',
    expand: 'Expand',
    collapse: 'Collapse',
    advanced: 'Advanced',
    tabsAria: 'Channel switcher',

    'status.loading': 'Loading…',
    'status.idle': 'Ready',
    'status.saving': 'Saving…',
    'status.saved': 'Saved',
    'status.error': 'Save failed',

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
    'f.webhookPort': 'Callback port',
    'f.webhookPort.hint': 'Used only by the callback-URL transport; defaults to 3000.',
    'f.webhookPath': 'Callback path',
    'f.webhookPath.hint': 'Used only by the callback-URL transport, e.g. /feishu/events.',
    'f.pollingTimeoutSeconds': 'Poll timeout (s)',
    'f.pollingTimeoutSeconds.hint': 'How long one long poll waits; defaults to 30.',
    'f.baseUrl': 'API base URL',
    'f.baseUrl.hint': 'The Telegram Bot API endpoint — only change it if you run your own proxy.',
    'f.defaultAt': 'Default @-list',
    'f.defaultAt.hint': 'Members to @ by default on group messages, comma-separated.',
    'f.pollIntervalMs': 'Poll interval (ms)',
    'f.pollIntervalMs.hint': 'How often the web channel checks for new messages; defaults to 1000.',
    'f.notifyLevel': 'Notify level',
    'f.notifyLevel.hint': 'How much of the working process the bot posts into the chat.',

    's.feishu.appId': 'App ID',
    's.feishu.appId.hint': 'The App ID from the open platform’s credentials page. Not a secret — shown in full.',
    's.feishu.appSecret': 'App Secret',
    's.feishu.appSecret.hint': 'The app secret paired with the App ID. Confidential — only the first and last 4 characters are shown.',
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
