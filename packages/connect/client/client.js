window.__ModuleLoader__.load({
  id: "dsh-connect",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __export = (target, all) => {
  for (var name2 in all)
    __defProp(target, name2, { get: all[name2], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);

// client/settings-client.mjs
var settings_client_exports = {};
__export(settings_client_exports, {
  ConnectSettingsTab: () => ConnectSettingsTab,
  NS: () => NS,
  apply: () => apply,
  inject: () => inject,
  locale: () => locale,
  name: () => name
});
module.exports = __toCommonJS(settings_client_exports);
var React = __toESM(require("react"), 1);

// lib/settings/settings-rpc.js
var SETTINGS_RPC_CHANNEL = "/dsh-connect";
var SETTINGS_ENDPOINTS = Object.freeze([
  "settings.get",
  "settings.save",
  "credentials.save",
  "settings.status",
  "onboarding.start",
  "onboarding.status",
  "onboarding.cancel"
]);
var MAX_BODY_BYTES = 1024 * 1024;

// lib/settings/rpc-client.js
var RpcError = class extends Error {
  constructor(code, message) {
    super(message);
    __publicField(this, "code");
    this.name = "RpcError";
    this.code = code;
  }
};
function callRpc(rpcCall, endpoint, payload, signal) {
  return rpcCall(endpoint, payload, signal).then((res) => {
    if (res.ok)
      return res.value;
    const code = res.error?.code ?? "settings-failed";
    throw new RpcError(code, res.error?.message ?? code);
  });
}
function loadSettings(rpcCall) {
  return callRpc(rpcCall, "settings.get", {});
}
function saveSettings(rpcCall, config) {
  return callRpc(rpcCall, "settings.save", config);
}
function saveCredentials(rpcCall, channel, values) {
  return callRpc(rpcCall, "credentials.save", { channel, values });
}

// lib/settings/channels.js
var CHANNELS = ["feishu", "telegram", "dingtalk", "web"];

// lib/settings/credential-store.js
var CHANNEL_SECRET_KEYS = Object.freeze({
  feishu: { appId: "DSH_CONNECT_FEISHU_APP_ID", appSecret: "DSH_CONNECT_FEISHU_APP_SECRET" },
  telegram: { botToken: "DSH_CONNECT_TELEGRAM_BOT_TOKEN" },
  dingtalk: {
    webhookUrl: "DSH_CONNECT_DINGTALK_WEBHOOK_URL",
    secret: "DSH_CONNECT_DINGTALK_SECRET",
    clientId: "DSH_CONNECT_DINGTALK_CLIENT_ID",
    clientSecret: "DSH_CONNECT_DINGTALK_CLIENT_SECRET"
  },
  web: {}
});
var CREDENTIAL_GROUPS = Object.freeze({
  feishu: [["DSH_CONNECT_FEISHU_APP_ID", "DSH_CONNECT_FEISHU_APP_SECRET"]],
  telegram: [["DSH_CONNECT_TELEGRAM_BOT_TOKEN"]],
  dingtalk: [
    ["DSH_CONNECT_DINGTALK_WEBHOOK_URL", "DSH_CONNECT_DINGTALK_SECRET"],
    ["DSH_CONNECT_DINGTALK_CLIENT_ID", "DSH_CONNECT_DINGTALK_CLIENT_SECRET"]
  ],
  web: []
});
var CREDENTIAL_REFS = Object.freeze(Object.fromEntries(CHANNELS.map((channel) => [channel, groupRefs(channel)])));
function groupRefs(channel) {
  const seen = /* @__PURE__ */ new Set();
  for (const group of CREDENTIAL_GROUPS[channel] ?? []) {
    for (const ref of group)
      seen.add(ref);
  }
  return Object.freeze([...seen]);
}

// lib/settings/settings-model.js
var CHANNEL_SECRET_FIELDS = Object.fromEntries(Object.entries(CHANNEL_SECRET_KEYS).map(([ch, map]) => [ch, Object.keys(map ?? {})]));
var CHANNEL_CONFIG_FIELDS = {
  feishu: [
    { key: "transport", kind: "select", options: ["websocket", "webhook"], label: "transport" },
    { key: "requireMention", kind: "boolean", label: "requireMention" },
    { key: "dmMode", kind: "select", options: ["open", "allowlist", "pair", "disabled"], label: "dmMode" },
    { key: "language", kind: "select", options: ["zh", "en"], label: "language" },
    { key: "webhookPort", kind: "number", label: "webhookPort" },
    { key: "webhookPath", kind: "text", label: "webhookPath" }
  ],
  telegram: [
    { key: "requireMention", kind: "boolean", label: "requireMention" },
    { key: "language", kind: "select", options: ["zh", "en"], label: "language" },
    { key: "pollingTimeoutSeconds", kind: "number", label: "pollingTimeoutSeconds" },
    { key: "baseUrl", kind: "text", label: "baseUrl" }
  ],
  dingtalk: [
    { key: "language", kind: "select", options: ["zh", "en"], label: "language" },
    { key: "defaultAt", kind: "text", label: "defaultAt" }
  ],
  web: [
    { key: "pollIntervalMs", kind: "number", label: "pollIntervalMs" }
  ]
};
var CHANNEL_DEFAULT_FIELDS = [
  { key: "language", kind: "select", options: ["zh", "en"], label: "language" }
];
var GENERAL_FIELD_GROUPS = [
  {
    title: "g.group.locale",
    fields: [
      { key: "language", kind: "select", options: ["zh", "en"], label: "language" },
      { key: "notifyLevel", kind: "select", options: ["full", "important", "result"], label: "notifyLevel" },
      { key: "progressTimeoutMs", kind: "number", label: "progressTimeoutMs" }
    ]
  },
  {
    title: "g.group.workspace",
    fields: [
      { key: "workDir", kind: "text", label: "workDir" },
      { key: "workspaces", kind: "list", label: "workspaces" }
    ]
  },
  {
    title: "g.group.access",
    fields: [
      { key: "allowUsers", kind: "list", label: "allowUsers" },
      { key: "allowChats", kind: "list", label: "allowChats" }
    ]
  },
  {
    title: "g.group.agent",
    fields: [
      { key: "agentPreset", kind: "text", label: "agentPreset" },
      { key: "autoMirror", kind: "boolean", label: "autoMirror" },
      { key: "streamHeartbeatMs", kind: "number", label: "streamHeartbeatMs" }
    ]
  }
];
var GENERAL_FIELDS = GENERAL_FIELD_GROUPS.flatMap((g) => g.fields);
function coerceConfigValue(kind, raw) {
  if (raw === void 0 || raw === null || raw === "")
    return void 0;
  switch (kind) {
    case "number": {
      const n = Number(raw);
      return Number.isFinite(n) ? n : void 0;
    }
    case "boolean":
      return typeof raw === "boolean" ? raw : raw === true || raw === "true";
    case "select":
      return String(raw);
    case "list": {
      const items = (Array.isArray(raw) ? raw : String(raw).split(/[\n,]/)).map((s) => String(s).trim()).filter((s) => s.length > 0);
      return items.length > 0 ? items : void 0;
    }
    default:
      return String(raw);
  }
}
function snapshotToForm(snapshot) {
  const config = snapshot.config ?? {};
  const channels = snapshot.enabled ?? [];
  const channelConfigs = {};
  for (const ch of Object.keys(CHANNEL_CONFIG_FIELDS)) {
    channelConfigs[ch] = config[ch] ?? {};
  }
  const general = {};
  for (const field of GENERAL_FIELDS) {
    const value = config[field.key];
    if (value === void 0)
      continue;
    general[field.key] = Array.isArray(value) ? [...value] : value;
  }
  return {
    channels,
    channelDefaults: config.channelDefaults ?? {},
    channelConfigs,
    general,
    // Copied, like `general`'s arrays: the form is mutated in place by the
    // setters, and aliasing the snapshot here would edit the host's own object.
    sharedOverrideKeys: [...snapshot.sharedOverrideKeys ?? []],
    ...snapshot.agentModel ? { agentModel: snapshot.agentModel } : {},
    // Deliberately empty even though `secretPreviews` carries something: an
    // input is a place to *type a new* secret, and prefilling it with the mask
    // would either overwrite the stored secret with its own preview on save, or
    // train the user to think a masked value is the real one. The preview is
    // rendered beside the input instead.
    secrets: {},
    secretPresence: snapshot.secrets ?? {},
    secretPreviews: snapshot.secretPreviews ?? {},
    settingsStatePath: config.settingsStatePath,
    live: snapshot.live === true
  };
}
function stripEmpty(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj))
    if (v !== void 0 && v !== null)
      out[k] = v;
  return out;
}
function buildConfigSave(form) {
  const config = { channels: form.channels };
  const defaults = stripEmpty(form.channelDefaults ?? {});
  if (Object.keys(defaults).length > 0)
    config.channelDefaults = defaults;
  for (const [ch, cfg] of Object.entries(form.channelConfigs ?? {})) {
    const clean = stripEmpty(cfg ?? {});
    if (Object.keys(clean).length > 0)
      config[ch] = clean;
  }
  for (const field of GENERAL_FIELDS) {
    const value = form.general?.[field.key];
    if (value === void 0 || value === null)
      continue;
    if (Array.isArray(value) && value.length === 0)
      continue;
    config[field.key] = value;
  }
  if (form.settingsStatePath)
    config.settingsStatePath = form.settingsStatePath;
  return config;
}
function buildCredentialSaves(form) {
  const out = [];
  for (const [ch, values] of Object.entries(form.secrets ?? {})) {
    if (values && Object.keys(values).length > 0)
      out.push({ channel: ch, values });
  }
  return out;
}

// lib/settings/secret-disclosure.js
var SECRET_DISCLOSURE = Object.freeze({
  appId: "full",
  clientId: "full",
  appSecret: "mask",
  clientSecret: "mask",
  botToken: "mask",
  secret: "mask",
  webhookUrl: "url"
});
function disclosureOf(configKey) {
  return SECRET_DISCLOSURE[configKey] ?? "mask";
}
function isMaskedSecret(configKey) {
  return disclosureOf(configKey) !== "full";
}

// client/locale.mjs
var LOCALES = {
  zh: {
    title: "dsh-connect",
    channels: "\u6E20\u9053",
    defaults: "\u516C\u5171\u9ED8\u8BA4",
    defaultsHint: "\u672A\u5355\u72EC\u914D\u7F6E\u7684\u6E20\u9053\u6CBF\u7528\u8FD9\u91CC\u7684\u53D6\u503C\uFF1B\u7559\u7A7A\u8868\u793A\u6CBF\u7528\u5404\u6E20\u9053\u81EA\u8EAB\u7684\u9ED8\u8BA4\u503C\u3002",
    save: "\u4FDD\u5B58",
    saved: "\u5DF2\u4FDD\u5B58",
    error: "\u4FDD\u5B58\u5931\u8D25",
    loading: "\u52A0\u8F7D\u4E2D\u2026",
    statePath: "\u8BBE\u7F6E\u6587\u4EF6",
    statePathHint: "\u5BBF\u4E3B\u6CA1\u6709\u63D0\u4F9B\u8BBE\u7F6E\u547D\u540D\u7A7A\u95F4\u65F6\uFF0C\u914D\u7F6E\u56DE\u9000\u5B58\u653E\u5728\u8FD9\u4E2A JSON \u6587\u4EF6\u91CC\u3002",
    livePlane: "\u914D\u7F6E\u5199\u5165 cordis.patch.yml\uFF0C\u4FDD\u5B58\u540E\u7ACB\u5373\u751F\u6548\u3002",
    filePlane: "\u914D\u7F6E\u5B58\u653E\u5728\u672C\u5730\u8BBE\u7F6E\u6587\u4EF6\uFF0C\u91CD\u542F dsh \u540E\u751F\u6548\u3002",
    reachable: "\u5DF2\u914D\u7F6E\u51ED\u636E",
    unreachable: "\u672A\u914D\u7F6E\u51ED\u636E",
    configured: "\u5DF2\u914D\u7F6E\uFF0C\u91CD\u65B0\u586B\u5199\u53EF\u8986\u76D6",
    current: "\u5F53\u524D\u503C\uFF1A",
    notConfigured: "\u672A\u914D\u7F6E",
    previewNote: "\u4E3A\u4FBF\u4E8E\u786E\u8BA4\uFF0C\u6B64\u5904\u53EA\u663E\u793A\u8131\u654F\u540E\u7684\u90E8\u5206\u5B57\u7B26\uFF1B\u8F93\u5165\u6846\u7559\u7A7A\u8868\u793A\u4E0D\u4FEE\u6539\u3002",
    secrets: "\u51ED\u636E\u4E0E\u5BC6\u94A5",
    expand: "\u5C55\u5F00",
    collapse: "\u6536\u8D77",
    advanced: "\u9AD8\u7EA7\u9009\u9879",
    tabsAria: "\u6E20\u9053\u5207\u6362",
    navAria: "\u8BBE\u7F6E\u5206\u533A",
    "view.general": "\u901A\u7528\u8BBE\u7F6E",
    "view.channels": "\u673A\u5668\u4EBA\u6E20\u9053",
    credentialUnknown: "\u51ED\u636E\u72B6\u6001\u672A\u77E5",
    credentialUnknownHint: "\u65E0\u6CD5\u8BFB\u53D6\u5DF2\u5B58\u50A8\u7684\u51ED\u636E\uFF0C\u8BF7\u786E\u8BA4\u51ED\u636E\u5E93\u53EF\u8BBF\u95EE\u540E\u91CD\u8BD5\u3002",
    channelFailed: "\u6E20\u9053\u542F\u52A8\u5931\u8D25\uFF1A",
    "onboard.create": "\u4E00\u952E\u521B\u5EFA\u5E76\u914D\u7F6E\u98DE\u4E66\u673A\u5668\u4EBA",
    "onboard.create.hint": "\u81EA\u52A8\u521B\u5EFA\u4E00\u4E2A\u98DE\u4E66\u81EA\u5EFA\u5E94\u7528\u3001\u58F0\u660E\u6240\u9700\u6743\u9650\uFF0C\u628A\u51ED\u636E\u5B58\u5230\u672C\u5730\u5E76\u542F\u7528\u8FD9\u4E2A\u6E20\u9053\u3002\u70B9\u5B8C\u5728\u6D4F\u89C8\u5668\u91CC\u786E\u8BA4\u4E00\u6B21\u5373\u53EF\u3002",
    "onboard.starting": "\u6B63\u5728\u7533\u8BF7\u2026",
    "onboard.waiting": "\u7B49\u5F85\u5728\u98DE\u4E66\u4E2D\u786E\u8BA4\u2026",
    "onboard.link": "\u8BF7\u5728\u6D4F\u89C8\u5668\u6253\u5F00\u4E0B\u9762\u7684\u94FE\u63A5\u5B8C\u6210\u786E\u8BA4\uFF08\u9875\u9762\u91CC\u6709\u4E8C\u7EF4\u7801\uFF09\uFF1A",
    "onboard.linkExpiry": "\u94FE\u63A5\u6709\u6548\u671F\u7EA6 {minutes} \u5206\u949F\uFF0C\u4EC5\u80FD\u4F7F\u7528\u4E00\u6B21\u3002",
    "onboard.cancel": "\u53D6\u6D88",
    "onboard.manual.telegram": "Telegram \u6CA1\u6709\u521B\u5EFA\u673A\u5668\u4EBA\u7684\u63A5\u53E3\uFF1A\u8BF7\u5728 Telegram \u91CC\u627E @BotFather \u7533\u8BF7\u4E00\u4E2A\u673A\u5668\u4EBA\uFF0C\u518D\u628A\u62FF\u5230\u7684 Bot Token \u586B\u5230\u4E0B\u9762\u3002",
    "onboard.manual.dingtalk": "\u9489\u9489\u673A\u5668\u4EBA\u9700\u8981\u5728\u9489\u9489\u5F00\u653E\u5E73\u53F0\u624B\u52A8\u521B\u5EFA\uFF0C\u518D\u628A\u62FF\u5230\u7684\u51ED\u636E\u586B\u5230\u4E0B\u9762\u3002",
    "onboard.created": "\u5DF2\u521B\u5EFA\u5E94\u7528",
    "onboard.credentialsStored": "\u51ED\u636E\u5DF2\u5199\u5165\u51ED\u636E\u5E93",
    "onboard.credentialsNotStored": "\u51ED\u636E\u6CA1\u6709\u5199\u5165\u51ED\u636E\u5E93",
    "onboard.legacyMirrorFailed": "\u65E7\u7248\u7684\u51ED\u636E\u6587\u4EF6\u4E5F\u6CA1\u6709\u5199\u5165",
    "onboard.enableRequested": "\u5DF2\u5728\u914D\u7F6E\u91CC\u542F\u7528\u98DE\u4E66\u6E20\u9053",
    "onboard.enableFailed": "\u6CA1\u80FD\u628A\u98DE\u4E66\u6E20\u9053\u5199\u8FDB\u914D\u7F6E",
    "onboard.notApplied": "\u51ED\u636E\u5DF2\u4FDD\u5B58\uFF0C\u4F46\u8FD0\u884C\u4E2D\u7684\u6E20\u9053\u6CA1\u80FD\u91CD\u65B0\u52A0\u8F7D\uFF0C\u8BF7\u91CD\u542F dsh \u540E\u786E\u8BA4\u3002",
    "onboard.applyPending": "\u6D41\u7A0B\u6CA1\u6709\u8D70\u5B8C\uFF0C\u8FD0\u884C\u4E2D\u7684\u6E20\u9053\u5C1A\u672A\u91CD\u65B0\u52A0\u8F7D\uFF0C\u8BF7\u91CD\u542F dsh \u540E\u786E\u8BA4\u3002",
    "onboard.needsManual": "\u4E8B\u4EF6\u8BA2\u9605\u65B9\u5F0F\u8FD8\u9700\u8981\u5230\u98DE\u4E66\u5F00\u653E\u5E73\u53F0\u624B\u52A8\u786E\u8BA4\u3002",
    "onboard.cancelled": "\u5DF2\u53D6\u6D88\u521B\u5EFA",
    "onboard.expired": "\u786E\u8BA4\u94FE\u63A5\u5DF2\u8FC7\u671F\uFF0C\u8BF7\u91CD\u65B0\u70B9\u51FB\u521B\u5EFA\u3002",
    "onboard.createFailed": "\u521B\u5EFA\u5931\u8D25",
    "onboard.subscription.applied": "\u4E8B\u4EF6\u8BA2\u9605\u5DF2\u8BBE\u4E3A\u957F\u8FDE\u63A5",
    "onboard.subscription.failed": "\u4E8B\u4EF6\u8BA2\u9605\u8BBE\u7F6E\u5931\u8D25",
    "onboard.subscription.skipped": "\u6CA1\u6709\u53EF\u7528\u51ED\u636E\uFF0C\u672A\u8BBE\u7F6E\u4E8B\u4EF6\u8BA2\u9605",
    "onboard.subscription.notAttempted": "\u672A\u80FD\u8D70\u5230\u8BBE\u7F6E\u4E8B\u4EF6\u8BA2\u9605\u8FD9\u4E00\u6B65",
    "w.credentialsStoredNotApplied": "\u51ED\u636E\u5DF2\u4FDD\u5B58\uFF0C\u4F46\u8FD0\u884C\u4E2D\u7684\u6E20\u9053\u6CA1\u80FD\u91CD\u65B0\u52A0\u8F7D\uFF0C\u8BF7\u91CD\u542F dsh \u540E\u786E\u8BA4\u3002",
    "status.loading": "\u52A0\u8F7D\u4E2D\u2026",
    "status.idle": "\u5C31\u7EEA",
    "status.saving": "\u4FDD\u5B58\u4E2D\u2026",
    "status.saved": "\u5DF2\u4FDD\u5B58",
    "status.error": "\u4FDD\u5B58\u5931\u8D25",
    "channel.feishu": "\u98DE\u4E66 / Lark",
    "channel.feishu.hint": "\u5728\u98DE\u4E66\u5F00\u653E\u5E73\u53F0\u521B\u5EFA\u81EA\u5EFA\u5E94\u7528\uFF0C\u7528\u957F\u8FDE\u63A5\u63A5\u6536\u6D88\u606F\u3002",
    "channel.telegram": "Telegram",
    "channel.telegram.hint": "\u901A\u8FC7 Telegram Bot API \u957F\u8F6E\u8BE2\u63A5\u6536\u6D88\u606F\uFF0C\u673A\u5668\u4EBA\u5411 @BotFather \u7533\u8BF7\u3002",
    "channel.dingtalk": "\u9489\u9489",
    "channel.dingtalk.hint": "\u652F\u6301 Webhook \u63A8\u9001\u4E0E Stream \u53CC\u5411\u4E24\u79CD\u6A21\u5F0F\uFF0C\u586B\u5176\u4E2D\u4E00\u7EC4\u5373\u53EF\u3002",
    "channel.web": "\u7F51\u9875",
    "channel.web.hint": "\u76F4\u63A5\u5728 DSH \u7F51\u9875\u754C\u9762\u91CC\u5BF9\u8BDD\uFF0C\u4E0D\u9700\u8981\u4EFB\u4F55\u51ED\u636E\u3002",
    "f.transport": "\u63A5\u5165\u65B9\u5F0F",
    "f.transport.hint": "\u957F\u8FDE\u63A5\u65E0\u9700\u516C\u7F51\u5730\u5740\uFF0C\u63A8\u8350\uFF1B\u56DE\u8C03\u5730\u5740\u9700\u8981 DSH \u6240\u5728\u673A\u5668\u53EF\u4ECE\u516C\u7F51\u8BBF\u95EE\u3002",
    "f.requireMention": "\u4EC5\u54CD\u5E94 @ \u63D0\u53CA",
    "f.requireMention.hint": "\u5F00\u542F\u540E\u7FA4\u804A\u4E2D\u53EA\u6709 @ \u673A\u5668\u4EBA\u624D\u5904\u7406\uFF1B\u5355\u804A\u4E0D\u53D7\u5F71\u54CD\u3002",
    "f.dmMode": "\u5355\u804A\u7B56\u7565",
    "f.dmMode.hint": "\u63A7\u5236\u54EA\u4E9B\u4EBA\u53EF\u4EE5\u76F4\u63A5\u79C1\u804A\u673A\u5668\u4EBA\u3002",
    "f.language": "\u56DE\u590D\u8BED\u8A00",
    "f.language.hint": "\u673A\u5668\u4EBA\u56DE\u590D\u7528\u6237\u65F6\u4F7F\u7528\u7684\u8BED\u8A00\u3002",
    "f.webhookPort": "\u56DE\u8C03\u7AEF\u53E3",
    "f.webhookPort.hint": "\u4EC5\u300C\u56DE\u8C03\u5730\u5740\u300D\u63A5\u5165\u65B9\u5F0F\u4F7F\u7528\uFF0C\u9ED8\u8BA4 3000\u3002",
    "f.webhookPath": "\u56DE\u8C03\u8DEF\u5F84",
    "f.webhookPath.hint": "\u4EC5\u300C\u56DE\u8C03\u5730\u5740\u300D\u63A5\u5165\u65B9\u5F0F\u4F7F\u7528\uFF0C\u4F8B\u5982 /feishu/events\u3002",
    "f.pollingTimeoutSeconds": "\u8F6E\u8BE2\u8D85\u65F6\uFF08\u79D2\uFF09",
    "f.pollingTimeoutSeconds.hint": "\u5355\u6B21\u957F\u8F6E\u8BE2\u7B49\u5F85\u79D2\u6570\uFF0C\u9ED8\u8BA4 30\u3002",
    "f.baseUrl": "\u63A5\u53E3\u5730\u5740",
    "f.baseUrl.hint": "Telegram Bot API \u5730\u5740\uFF0C\u53EA\u6709\u5728\u81EA\u5EFA\u53CD\u5411\u4EE3\u7406\u65F6\u624D\u9700\u8981\u4FEE\u6539\u3002",
    "f.defaultAt": "\u9ED8\u8BA4 @ \u6210\u5458",
    "f.defaultAt.hint": "\u7FA4\u6D88\u606F\u9ED8\u8BA4 @ \u7684\u6210\u5458\uFF0C\u591A\u4E2A\u7528\u9017\u53F7\u5206\u9694\u3002",
    "f.pollIntervalMs": "\u8F6E\u8BE2\u95F4\u9694\uFF08\u6BEB\u79D2\uFF09",
    "f.pollIntervalMs.hint": "\u7F51\u9875\u6E20\u9053\u68C0\u67E5\u65B0\u6D88\u606F\u7684\u95F4\u9694\uFF0C\u9ED8\u8BA4 1000\u3002",
    // General settings. These resolve once when the plugin starts and there is
    // no hot reload, so every hint says so — a control that silently does
    // nothing until a restart is worse than one that says it will.
    "g.group.locale": "\u8BED\u8A00\u4E0E\u63D0\u9192",
    "g.group.workspace": "\u5DE5\u4F5C\u76EE\u5F55",
    "g.group.access": "\u8BBF\u95EE\u63A7\u5236",
    "g.group.agent": "\u667A\u80FD\u4F53",
    "g.language": "\u8BED\u8A00",
    "g.language.hint": "\u673A\u5668\u4EBA\u56DE\u590D\u7528\u6237\u4F7F\u7528\u7684\u8BED\u8A00\uFF0C\u5BF9\u6240\u6709\u6E20\u9053\u751F\u6548\uFF08\u6E20\u9053\u5361\u7247\u91CC\u7684\u300C\u56DE\u590D\u8BED\u8A00\u300D\u53EF\u5355\u72EC\u8986\u76D6\uFF09\u3002\u4FEE\u6539\u540E\u9700\u91CD\u542F dsh \u624D\u751F\u6548\u3002",
    "g.notifyLevel": "\u901A\u77E5\u7EA7\u522B",
    "g.notifyLevel.hint": "\u63A7\u5236\u673A\u5668\u4EBA\u628A\u591A\u5C11\u8FC7\u7A0B\u4FE1\u606F\u53D1\u5230\u804A\u5929\u91CC\u3002\u4FEE\u6539\u540E\u9700\u91CD\u542F dsh \u624D\u751F\u6548\u3002",
    "g.progressTimeoutMs": "\u8FDB\u5EA6\u63D0\u9192\u8D85\u65F6\uFF08\u6BEB\u79D2\uFF09",
    "g.progressTimeoutMs.hint": "\u4EFB\u52A1\u8D85\u8FC7\u8FD9\u4E2A\u65F6\u957F\u6CA1\u6709\u8F93\u51FA\u65F6\uFF0C\u7ED9\u7528\u6237\u53D1\u4E00\u6761\u8FDB\u5EA6\u63D0\u9192\u3002\u4FEE\u6539\u540E\u9700\u91CD\u542F dsh \u624D\u751F\u6548\u3002",
    "g.workDir": "\u9ED8\u8BA4\u5DE5\u4F5C\u76EE\u5F55",
    "g.workDir.hint": "\u673A\u5668\u4EBA\u65B0\u5EFA\u4F1A\u8BDD\u65F6\u4F7F\u7528\u7684\u76EE\u5F55\u3002\u4FEE\u6539\u540E\u9700\u91CD\u542F dsh \u624D\u751F\u6548\u3002",
    "g.workspaces": "\u989D\u5916\u5DE5\u4F5C\u533A",
    "g.workspaces.hint": "\u6BCF\u884C\u4E00\u4E2A\u76EE\u5F55\u3002\u8FD9\u91CC\u7684\u5185\u5BB9\u4F1A\u4E0E dsh.shared.config.json \u91CC\u7684 additionalWorkspaces \u5408\u5E76\uFF0C\u800C\u4E0D\u662F\u66FF\u6362\u5B83\u3002\u4FEE\u6539\u540E\u9700\u91CD\u542F dsh \u624D\u751F\u6548\u3002",
    "g.allowUsers": "\u5141\u8BB8\u7684\u7528\u6237",
    "g.allowUsers.hint": "\u6BCF\u884C\u4E00\u4E2A\u7528\u6237\u6807\u8BC6\uFF1B\u7559\u7A7A\u8868\u793A\u4E0D\u9650\u5236\u3002\u4FEE\u6539\u540E\u9700\u91CD\u542F dsh \u624D\u751F\u6548\u3002",
    "g.allowChats": "\u5141\u8BB8\u7684\u4F1A\u8BDD",
    "g.allowChats.hint": "\u6BCF\u884C\u4E00\u4E2A\u4F1A\u8BDD ID\uFF1B\u7559\u7A7A\u8868\u793A\u4E0D\u9650\u5236\u3002\u4FEE\u6539\u540E\u9700\u91CD\u542F dsh \u624D\u751F\u6548\u3002",
    "g.agentPreset": "\u667A\u80FD\u4F53\u9884\u8BBE",
    "g.agentPreset.hint": "\u65B0\u5EFA\u4F1A\u8BDD\u9ED8\u8BA4\u4F7F\u7528\u7684\u9884\u8BBE\u540D\u79F0\uFF1B\u7559\u7A7A\u8868\u793A\u6CBF\u7528 DSH \u7684\u9ED8\u8BA4\u503C\u3002\u4FEE\u6539\u540E\u9700\u91CD\u542F dsh \u624D\u751F\u6548\u3002",
    "g.autoMirror": "\u81EA\u52A8\u955C\u50CF\u4F1A\u8BDD",
    "g.autoMirror.hint": "\u628A\u673A\u5668\u4EBA\u53D1\u8D77\u7684\u4F1A\u8BDD\u4E5F\u663E\u793A\u5728 DSH \u7F51\u9875\u754C\u9762\u91CC\u3002\u4FEE\u6539\u540E\u9700\u91CD\u542F dsh \u624D\u751F\u6548\u3002",
    "g.streamHeartbeatMs": "\u6D41\u5F0F\u5FC3\u8DF3\uFF08\u6BEB\u79D2\uFF09",
    "g.streamHeartbeatMs.hint": "\u6D41\u5F0F\u56DE\u590D\u671F\u95F4\u5411\u804A\u5929\u53D1\u9001\u5FC3\u8DF3\u7684\u95F4\u9694\uFF0C\u907F\u514D\u957F\u4EFB\u52A1\u770B\u8D77\u6765\u50CF\u5361\u4F4F\u3002\u4FEE\u6539\u540E\u9700\u91CD\u542F dsh \u624D\u751F\u6548\u3002",
    "g.sharedOverride": "\u5F53\u524D\u53D6\u503C\u6765\u81EA dsh.shared.config.json\uFF0C\u6B64\u5904\u7684\u4FEE\u6539\u4E0D\u4F1A\u751F\u6548\u3002",
    "g.model": "\u9ED8\u8BA4\u6A21\u578B",
    "g.model.note": "\u6B64\u503C\u7531 DSH \u7BA1\u7406\uFF0C\u8BF7\u5728 DSH \u91CC\u5207\u6362\u3002",
    "s.feishu.appId": "App ID",
    "s.feishu.appId.hint": "\u5F00\u653E\u5E73\u53F0\u300C\u51ED\u8BC1\u4E0E\u57FA\u7840\u4FE1\u606F\u300D\u4E2D\u7684 App ID\uFF0C\u975E\u673A\u5BC6\uFF0C\u5B8C\u6574\u663E\u793A\u3002",
    "s.feishu.appSecret": "App Secret",
    "s.feishu.appSecret.hint": "\u4E0E App ID \u914D\u5BF9\u7684\u5E94\u7528\u5BC6\u94A5\uFF0C\u5C5E\u4E8E\u673A\u5BC6\uFF0C\u4EC5\u663E\u793A\u9996\u5C3E\u5404 4 \u4F4D\u3002",
    "s.telegram.botToken": "Bot Token",
    "s.telegram.botToken.hint": "@BotFather \u751F\u6210\u7684\u673A\u5668\u4EBA\u4EE4\u724C\uFF0C\u5F62\u5982 123456:ABC\u2026\uFF0C\u5C5E\u4E8E\u673A\u5BC6\u3002",
    "s.dingtalk.webhookUrl": "Webhook \u5730\u5740",
    "s.dingtalk.webhookUrl.hint": "\u7FA4\u673A\u5668\u4EBA\u7684\u5B8C\u6574 Webhook \u5730\u5740\uFF1B\u9884\u89C8\u4FDD\u7559\u57DF\u540D\u4E0E\u8DEF\u5F84\uFF0C\u53EA\u906E\u853D access_token\u3002",
    "s.dingtalk.secret": "\u52A0\u7B7E\u5BC6\u94A5",
    "s.dingtalk.secret.hint": "\u7FA4\u673A\u5668\u4EBA\u5F00\u542F\u300C\u52A0\u7B7E\u300D\u5B89\u5168\u8BBE\u7F6E\u540E\u624D\u6709\uFF0C\u5C5E\u4E8E\u673A\u5BC6\u3002",
    "s.dingtalk.clientId": "Client ID",
    "s.dingtalk.clientId.hint": "Stream \u6A21\u5F0F\u5E94\u7528\u7684 AppKey\uFF0C\u975E\u673A\u5BC6\uFF0C\u5B8C\u6574\u663E\u793A\u3002",
    "s.dingtalk.clientSecret": "Client Secret",
    "s.dingtalk.clientSecret.hint": "Stream \u6A21\u5F0F\u5E94\u7528\u7684 AppSecret\uFF0C\u5C5E\u4E8E\u673A\u5BC6\uFF0C\u4EC5\u663E\u793A\u9996\u5C3E\u5404 4 \u4F4D\u3002",
    "o.default": "\uFF08\u6CBF\u7528\u9ED8\u8BA4\uFF09",
    "o.websocket": "\u957F\u8FDE\u63A5\uFF08\u63A8\u8350\uFF09",
    "o.webhook": "\u56DE\u8C03\u5730\u5740",
    "o.open": "\u6240\u6709\u4EBA\u90FD\u53EF\u4EE5",
    "o.allowlist": "\u4EC5\u540D\u5355\u5185\u7684\u4EBA",
    "o.pair": "\u9700\u8981\u5148\u914D\u5BF9",
    "o.disabled": "\u5173\u95ED\u5355\u804A",
    "o.zh": "\u4E2D\u6587",
    "o.en": "\u82F1\u6587",
    "o.full": "\u5168\u90E8\u8FC7\u7A0B",
    "o.important": "\u5173\u952E\u8282\u70B9",
    "o.result": "\u4EC5\u6700\u7EC8\u7ED3\u679C"
  },
  en: {
    title: "dsh-connect",
    channels: "Channels",
    defaults: "Defaults",
    defaultsHint: "Channels without their own value fall back to these; leave a field empty to use each channel\u2019s built-in default.",
    save: "Save",
    saved: "Saved",
    error: "Save failed",
    loading: "Loading\u2026",
    statePath: "Settings file",
    statePathHint: "Where the config falls back to when the host has no settings namespace live.",
    livePlane: "Written to cordis.patch.yml \u2014 a save takes effect immediately.",
    filePlane: "Stored in a local settings file \u2014 a save applies after dsh restarts.",
    reachable: "Credentials set",
    unreachable: "Credentials missing",
    configured: "Configured \u2014 type to replace",
    current: "Current value: ",
    notConfigured: "Not configured",
    previewNote: "Shown masked, so you can confirm the stored value without exposing it. Leave the input empty to keep it.",
    secrets: "Credentials & secrets",
    expand: "Expand",
    collapse: "Collapse",
    advanced: "Advanced",
    tabsAria: "Channel switcher",
    navAria: "Settings sections",
    "view.general": "General",
    "view.channels": "Bot channels",
    credentialUnknown: "Credential state unknown",
    credentialUnknownHint: "The stored credentials could not be read \u2014 check that the credential store is reachable, then try again.",
    channelFailed: "Channel failed to start:",
    "onboard.create": "Create and configure a Feishu bot in one click",
    "onboard.create.hint": "Creates a Feishu custom app, declares the permissions it needs, stores the credentials locally, and enables this channel. You confirm once in the browser and it is done.",
    "onboard.starting": "Requesting\u2026",
    "onboard.waiting": "Waiting for you to confirm in Feishu\u2026",
    "onboard.link": "Open this link in a browser to confirm (the page shows a QR code):",
    "onboard.linkExpiry": "The link is valid for about {minutes} minutes and works only once.",
    "onboard.cancel": "Cancel",
    "onboard.manual.telegram": "Telegram has no bot-creation API: ask @BotFather inside Telegram for a bot, then paste the Bot Token into the field below.",
    "onboard.manual.dingtalk": "A DingTalk bot has to be created by hand on the DingTalk open platform; paste the credentials you get into the fields below.",
    "onboard.created": "App created",
    "onboard.credentialsStored": "Credentials written to the credential store",
    "onboard.credentialsNotStored": "Credentials were not written to the credential store",
    "onboard.legacyMirrorFailed": "The legacy credential file was not written either",
    "onboard.enableRequested": "Feishu enabled in the config",
    "onboard.enableFailed": "Feishu could not be written into the config",
    "onboard.notApplied": "The credential was saved, but the running channels did not reload it \u2014 restart dsh to be sure.",
    "onboard.applyPending": "The flow did not finish, so the running channels have not reloaded \u2014 restart dsh to be sure.",
    "onboard.needsManual": "The event subscription mode still needs confirming by hand on the Feishu open platform.",
    "onboard.cancelled": "Creation cancelled",
    "onboard.expired": "The confirmation link expired \u2014 click create again.",
    "onboard.createFailed": "Creation failed",
    "onboard.subscription.applied": "Event subscription set to long connection",
    "onboard.subscription.failed": "Setting the event subscription failed",
    "onboard.subscription.skipped": "No usable credentials, so the event subscription was not set",
    "onboard.subscription.notAttempted": "The flow never reached the event subscription step",
    "w.credentialsStoredNotApplied": "The credential was saved, but the running channels did not reload it \u2014 restart dsh to be sure.",
    "status.loading": "Loading\u2026",
    "status.idle": "Ready",
    "status.saving": "Saving\u2026",
    "status.saved": "Saved",
    "status.error": "Save failed",
    "channel.feishu": "Feishu / Lark",
    "channel.feishu.hint": "Create a custom app on the Feishu open platform and receive messages over a long connection.",
    "channel.telegram": "Telegram",
    "channel.telegram.hint": "Receive messages by long-polling the Telegram Bot API; get a bot from @BotFather.",
    "channel.dingtalk": "DingTalk",
    "channel.dingtalk.hint": "Supports both webhook push and stream mode \u2014 fill in either set.",
    "channel.web": "Web",
    "channel.web.hint": "Chat straight from the DSH web UI; needs no credentials at all.",
    "f.transport": "Transport",
    "f.transport.hint": "A long connection needs no public address and is recommended; a callback URL requires this machine to be reachable from the internet.",
    "f.requireMention": "Only when @-mentioned",
    "f.requireMention.hint": "In group chats, handle a message only if the bot was mentioned. Direct messages are unaffected.",
    "f.dmMode": "Direct messages",
    "f.dmMode.hint": "Who is allowed to message the bot directly.",
    "f.language": "Reply language",
    "f.language.hint": "The language the bot replies to users in.",
    "f.webhookPort": "Callback port",
    "f.webhookPort.hint": "Used only by the callback-URL transport; defaults to 3000.",
    "f.webhookPath": "Callback path",
    "f.webhookPath.hint": "Used only by the callback-URL transport, e.g. /feishu/events.",
    "f.pollingTimeoutSeconds": "Poll timeout (s)",
    "f.pollingTimeoutSeconds.hint": "How long one long poll waits; defaults to 30.",
    "f.baseUrl": "API base URL",
    "f.baseUrl.hint": "The Telegram Bot API endpoint \u2014 only change it if you run your own proxy.",
    "f.defaultAt": "Default @-list",
    "f.defaultAt.hint": "Members to @ by default on group messages, comma-separated.",
    "f.pollIntervalMs": "Poll interval (ms)",
    "f.pollIntervalMs.hint": "How often the web channel checks for new messages; defaults to 1000.",
    // General settings. These resolve once when the plugin starts and there is
    // no hot reload, so every hint says so — a control that silently does
    // nothing until a restart is worse than one that says it will.
    "g.group.locale": "Language & notices",
    "g.group.workspace": "Working directories",
    "g.group.access": "Access control",
    "g.group.agent": "Agent",
    "g.language": "Language",
    "g.language.hint": "The language the bot replies to users in, for every channel (a channel card\u2019s \u201CReply language\u201D overrides it). A change takes effect after dsh restarts.",
    "g.notifyLevel": "Notify level",
    "g.notifyLevel.hint": "How much of the working process the bot posts into the chat. A change takes effect after dsh restarts.",
    "g.progressTimeoutMs": "Progress timeout (ms)",
    "g.progressTimeoutMs.hint": "How long a task may go without output before the user gets a progress notice. A change takes effect after dsh restarts.",
    "g.workDir": "Default working directory",
    "g.workDir.hint": "The directory the bot uses for new sessions. A change takes effect after dsh restarts.",
    "g.workspaces": "Additional workspaces",
    "g.workspaces.hint": "One directory per line. These are merged with additionalWorkspaces from dsh.shared.config.json rather than replacing it. A change takes effect after dsh restarts.",
    "g.allowUsers": "Allowed users",
    "g.allowUsers.hint": "One user id per line; leave empty to allow everyone. A change takes effect after dsh restarts.",
    "g.allowChats": "Allowed chats",
    "g.allowChats.hint": "One chat id per line; leave empty to allow every chat. A change takes effect after dsh restarts.",
    "g.agentPreset": "Agent preset",
    "g.agentPreset.hint": "The preset new sessions use by default; leave empty for the DSH default. A change takes effect after dsh restarts.",
    "g.autoMirror": "Mirror sessions",
    "g.autoMirror.hint": "Also show bot-created sessions in the DSH web UI. A change takes effect after dsh restarts.",
    "g.streamHeartbeatMs": "Stream heartbeat (ms)",
    "g.streamHeartbeatMs.hint": "How often a heartbeat is posted into the chat while a reply streams, so a long task does not look stuck. A change takes effect after dsh restarts.",
    "g.sharedOverride": "The current value comes from dsh.shared.config.json \u2014 editing it here has no effect.",
    "g.model": "Default model",
    "g.model.note": "DSH owns this value \u2014 switch it inside DSH.",
    "s.feishu.appId": "App ID",
    "s.feishu.appId.hint": "The App ID from the open platform\u2019s credentials page. Not a secret \u2014 shown in full.",
    "s.feishu.appSecret": "App Secret",
    "s.feishu.appSecret.hint": "The app secret paired with the App ID. Confidential \u2014 only the first and last 4 characters are shown.",
    "s.telegram.botToken": "Bot Token",
    "s.telegram.botToken.hint": "The bot token from @BotFather, like 123456:ABC\u2026 \u2014 confidential.",
    "s.dingtalk.webhookUrl": "Webhook URL",
    "s.dingtalk.webhookUrl.hint": "The group robot\u2019s full webhook URL; the preview keeps the host and path and masks only the access_token.",
    "s.dingtalk.secret": "Signing secret",
    "s.dingtalk.secret.hint": "Only present once the group robot has the \u201Csign\u201D security setting enabled \u2014 confidential.",
    "s.dingtalk.clientId": "Client ID",
    "s.dingtalk.clientId.hint": "The AppKey of the stream-mode app. Not a secret \u2014 shown in full.",
    "s.dingtalk.clientSecret": "Client Secret",
    "s.dingtalk.clientSecret.hint": "The AppSecret of the stream-mode app. Confidential \u2014 only the first and last 4 characters are shown.",
    "o.default": "(use default)",
    "o.websocket": "Long connection (recommended)",
    "o.webhook": "Callback URL",
    "o.open": "Anyone",
    "o.allowlist": "Allowlisted users only",
    "o.pair": "Pairing required",
    "o.disabled": "Direct messages off",
    "o.zh": "Chinese",
    "o.en": "English",
    "o.full": "Everything",
    "o.important": "Key milestones",
    "o.result": "Final result only"
  }
};
var LOCALE_KEYS = Object.keys(LOCALES.zh);
function hasLocale(key) {
  return Object.prototype.hasOwnProperty.call(LOCALES.zh, key) && Object.prototype.hasOwnProperty.call(LOCALES.en, key);
}
function tr(t, key, fallback) {
  return hasLocale(key) ? t(key) : fallback;
}
function optionalText(t, key) {
  return hasLocale(key) ? t(key) : void 0;
}

// client/panel-state.mjs
var PANE_VIEWS = ["general", "channels"];
var DEFAULT_VIEW = "channels";
var ADVANCED_KEYS = {
  feishu: ["webhookPort", "webhookPath"],
  telegram: ["pollingTimeoutSeconds", "baseUrl"],
  dingtalk: ["defaultAt"],
  web: ["pollIntervalMs"]
};
function isAdvanced(channel, key) {
  return (ADVANCED_KEYS[channel] ?? []).includes(key);
}
function initialOpenChannels(enabled, all) {
  const open = (enabled ?? []).filter((ch) => all.includes(ch));
  return new Set(open.length > 0 ? open : all.slice(0, 1));
}
function toggleInSet(set, key) {
  const next = new Set(set);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}
function snapshotIssues(snap, warnings) {
  const issues = [];
  for (const channel of snap?.credentialErrors ?? []) {
    issues.push({ kind: "credentialUnknown", channel, key: `credentialUnknown:${channel}` });
  }
  for (const code of warnings ?? snap?.warnings ?? []) {
    issues.push({ kind: "warning", code, key: `warning:${code}` });
  }
  for (const [channel, reason] of Object.entries(snap?.channelErrors ?? {})) {
    issues.push({ kind: "channelFailed", channel, reason, key: `channelFailed:${channel}` });
  }
  return issues;
}
function onboardingIssues(outcome) {
  if (!outcome) return [];
  const issues = [];
  const push = (code, extra) => issues.push({
    kind: "onboarding",
    code,
    key: `onboarding:${code}`,
    ...extra?.reason === void 0 ? {} : { reason: extra.reason },
    ...extra?.appId === void 0 ? {} : { appId: extra.appId }
  });
  if (!outcome.created) {
    const code = outcome.reason === "abort" ? "cancelled" : outcome.reason === "expired_token" ? "expired" : "createFailed";
    push(code, { reason: outcome.reason });
    return issues;
  }
  push("created", { appId: outcome.appId });
  push(outcome.credentialsStored ? "credentialsStored" : "credentialsNotStored");
  if (!outcome.credentialsStored && !outcome.legacyMirrorWritten) push("legacyMirrorFailed");
  push(outcome.enableRequested ? "enableRequested" : "enableFailed");
  const subscription = outcome.subscription ?? {};
  const subscriptionCode = subscription.status === "applied" ? "applied" : subscription.status === "failed" ? "failed" : subscription.status === "not-attempted" ? "notAttempted" : "skipped";
  push(`subscription.${subscriptionCode}`, { reason: subscription.reason });
  if (subscription.needsManualAction === true) push("needsManual");
  if (outcome.applied === "no") push("notApplied");
  else if (outcome.applied !== "yes") push("applyPending");
  return issues;
}

// client/settings-client.mjs
var name = "dsh-connect-settings";
var inject = ["slots", "connection", "locale"];
var NS = "dsh-connect";
var locale = LOCALES;
var h = React.createElement;
var ALL_CHANNELS = Object.keys(CHANNEL_SECRET_FIELDS);
var STYLE = `
.dsh-connect-settings,.dsh-connect-settings *,.dsh-connect-settings *::before,.dsh-connect-settings *::after{box-sizing:border-box}
.dsh-connect-settings{--ds-bg:var(--dsw-alias-bg-layer-3,#ffffff);--ds-bg-sub:var(--dsw-alias-bg-layer-1,#f6f7f9);--ds-text:var(--dsw-alias-label-primary,#1f2329);--ds-muted:var(--dsw-alias-label-tertiary,#646a73);--ds-border:var(--dsw-alias-border-l2,#e2e4e8);--ds-border-2:var(--dsw-alias-border-l3,#c8cbd0);--ds-accent:var(--dsw-alias-state-business-primary,#3b82f6);--ds-hover:var(--dsw-alias-interactive-bg-hover,#2631480f);--ds-warn:var(--dsw-alias-state-error-primary,#b45309);--ds-nav-h:39px;display:flex;flex-direction:column;gap:12px;max-width:760px;color:var(--ds-text);font:13px/1.6 -apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
.dsh-connect-settings .ds-card{display:flex;flex-direction:column;gap:10px;border:1px solid var(--ds-border);border-radius:10px;background:var(--ds-bg);padding:12px 14px}
.dsh-connect-settings .ds-card-title{margin:0;font-size:13px;font-weight:600}
.dsh-connect-settings .ds-note{margin:0;font-size:11px;line-height:1.5;color:var(--ds-muted)}
/* The primary navigation, and the reason the channel tab strip below pins to
   var(--ds-nav-h) rather than 0. Both strips are sticky, and a control the user
   asked to keep on screen must not slide *under* another one \u2014 with both at
   top:0 the channel tabs became invisible the moment the pane scrolled, which is
   the exact complaint the sticky strip was added to fix. Two levels, two
   offsets, one declared height. */
.dsh-connect-settings .ds-nav{position:sticky;top:0;z-index:3;display:flex;flex-wrap:wrap;gap:2px;padding:0 0 6px;background:var(--ds-bg);border-bottom:1px solid var(--ds-border)}
.dsh-connect-settings .ds-nav-item{height:32px;padding:0 12px;border:0;border-bottom:2px solid transparent;background:transparent;color:var(--ds-muted);font:inherit;font-size:13px;font-weight:500;cursor:pointer}
.dsh-connect-settings .ds-nav-item:hover{color:var(--ds-text)}
/* aria-current, not role="tab": these are links between two views, and the
   document has no tablist to belong to. */
.dsh-connect-settings .ds-nav-item[aria-current=page]{color:var(--ds-accent);border-bottom-color:var(--ds-accent)}
.dsh-connect-settings .ds-tabs{position:sticky;top:var(--ds-nav-h);z-index:2;display:flex;flex-wrap:wrap;gap:6px;padding:6px 0;background:var(--ds-bg);border-bottom:1px solid var(--ds-border)}
.dsh-connect-settings .ds-tab{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 10px;border:1px solid var(--ds-border);border-radius:14px;background:transparent;color:var(--ds-text);font:inherit;font-size:12px;cursor:pointer}
.dsh-connect-settings .ds-tab:hover{background:var(--ds-hover)}
.dsh-connect-settings .ds-tab[aria-expanded=true]{border-color:var(--ds-accent);color:var(--ds-accent)}
.dsh-connect-settings .ds-dot{width:6px;height:6px;border-radius:50%;background:var(--ds-border-2);flex:none}
.dsh-connect-settings .ds-dot[data-on="1"]{background:var(--ds-accent)}
.dsh-connect-settings .ds-channel{border:1px solid var(--ds-border);border-radius:8px;background:var(--ds-bg-sub)}
.dsh-connect-settings .ds-channel-head{display:flex;align-items:center;gap:8px;padding:5px 10px}
.dsh-connect-settings .ds-enable{display:flex;align-items:center;flex:none}
.dsh-connect-settings .ds-channel-toggle{flex:1;min-width:0;display:flex;align-items:center;gap:8px;padding:5px 6px;border:0;border-radius:6px;background:transparent;color:inherit;font:inherit;font-size:12px;font-weight:600;text-align:left;cursor:pointer}
.dsh-connect-settings .ds-channel-toggle:hover{background:var(--ds-hover);color:var(--ds-accent)}
.dsh-connect-settings .ds-channel-name{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-connect-settings .ds-channel-body{display:flex;flex-direction:column;gap:8px;padding:0 10px 10px}
.dsh-connect-settings .ds-chevron{width:7px;height:7px;margin:-3px 4px 0 auto;border-right:1.5px solid currentColor;border-bottom:1.5px solid currentColor;transform:rotate(45deg);transition:transform .15s ease;flex:none}
.dsh-connect-settings [aria-expanded=true]>.ds-chevron,.dsh-connect-settings [aria-expanded=true] .ds-chevron{transform:rotate(-135deg);margin-top:2px}
.dsh-connect-settings .ds-badge{flex:none;font-size:11px;font-weight:500;padding:1px 8px;border-radius:99px;background:var(--ds-bg);color:var(--ds-muted);border:1px solid var(--ds-border-2)}
/* One field per row, deliberately. This was an auto-fill track of 200px
   minimums, which at the pane's real width (708px inside the 760px cap) laid
   out *three* columns of label-above-control fields \u2014 shorter, but each one
   narrow enough that a hint wrapped to four lines and the eye had no single
   path down the form. The 0 minimum rather than a bare 1fr is so a long
   unbroken value can't push the track wider than its container (same reasoning
   as the box-sizing reset). Three call sites share this rule: the channel
   body, the advanced fold, and the defaults card. */
.dsh-connect-settings .ds-fields{display:grid;grid-template-columns:minmax(0,1fr);gap:12px}
.dsh-connect-settings .ds-field{display:flex;flex-direction:column;gap:4px;min-width:0}
.dsh-connect-settings .ds-control{display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--ds-muted)}
.dsh-connect-settings .ds-control.ds-check-field{flex-direction:row;align-items:center;gap:6px}
.dsh-connect-settings .ds-hint{margin:0;font-size:11px;line-height:1.5;color:var(--ds-muted)}
.dsh-connect-settings .ds-preview{margin:0;font-size:11px;line-height:1.5;color:var(--ds-muted);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;word-break:break-all}
.dsh-connect-settings .ds-preview b{font-weight:500;font-family:inherit;opacity:.75}
.dsh-connect-settings .ds-check{flex:none;width:16px;height:16px;accent-color:var(--ds-accent)}
.dsh-connect-settings .ds-input{height:30px;width:100%;min-width:0;padding:0 9px;border:1px solid var(--ds-border-2);border-radius:6px;background:var(--ds-bg);color:var(--ds-text);font:inherit}
.dsh-connect-settings select.ds-input{cursor:pointer}
/* A list field (workspaces/allowUsers/allowChats) is a textarea, one entry per
   line. .ds-input fixes a 30px height that a textarea cannot use, so this rule
   overrides both the height and the vertical padding. */
.dsh-connect-settings .ds-list{min-height:60px;height:auto;padding:6px 9px;line-height:1.5;resize:vertical}
/* The read-only model row \u2014 text, never a control. It is a value this pane
   deliberately cannot write (see renderModelRow), so it must not look
   editable. */
.dsh-connect-settings .ds-readonly{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:var(--ds-text);word-break:break-all}
.dsh-connect-settings .ds-input:focus{outline:none;border-color:var(--ds-accent);box-shadow:0 0 0 2px rgba(59,130,246,.25);box-shadow:0 0 0 2px color-mix(in srgb,var(--ds-accent) 25%,transparent)}
.dsh-connect-settings .ds-adv{display:flex;flex-direction:column;gap:8px}
.dsh-connect-settings .ds-advanced-toggle{align-self:flex-start;display:inline-flex;align-items:center;gap:6px;padding:3px 10px;border:1px dashed var(--ds-border-2);border-radius:99px;background:transparent;color:var(--ds-muted);font:inherit;font-size:11px;cursor:pointer}
.dsh-connect-settings .ds-advanced-toggle:hover{background:var(--ds-hover);color:var(--ds-text)}
.dsh-connect-settings .ds-footer{position:sticky;bottom:0;z-index:1;display:flex;flex-wrap:wrap;align-items:center;gap:12px;padding:10px 14px;border:1px solid var(--ds-border);border-radius:10px;background:var(--ds-bg)}
.dsh-connect-settings .ds-issues{flex-basis:100%;display:flex;flex-direction:column;gap:4px;margin:0;padding:0;list-style:none}
.dsh-connect-settings .ds-issue{display:flex;flex-wrap:wrap;align-items:baseline;gap:6px;font-size:11px;line-height:1.5;color:var(--ds-warn,#b45309)}
.dsh-connect-settings .ds-issue-reason{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;word-break:break-all;color:var(--ds-muted)}
.dsh-connect-settings .ds-badge.ds-badge-warn{border-color:var(--ds-warn,#b45309);color:var(--ds-warn,#b45309)}
.dsh-connect-settings .ds-btn{height:32px;padding:0 18px;border:0;border-radius:6px;background:var(--dsw-alias-button-primary-fill,var(--ds-accent));color:var(--dsw-alias-label-primary-foreground,#ffffff);font:inherit;font-weight:500;cursor:pointer}
.dsh-connect-settings .ds-btn:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover,var(--ds-accent))}
.dsh-connect-settings .ds-btn:disabled{opacity:.55;cursor:default}
/* The one-click creation block, inside the channel card's body. A dashed box
   rather than a solid one: it is a one-off action, not another settings group.
   The link gets word-break:break-all for the same reason .ds-preview does \u2014 a
   Feishu authorization URL is long, unbreakable, and would otherwise widen the
   card and reintroduce the horizontal overflow this pane already fixed once. */
.dsh-connect-settings .ds-onboard{display:flex;flex-direction:column;gap:8px;padding:10px;border:1px dashed var(--ds-border-2);border-radius:8px}
.dsh-connect-settings .ds-onboard-row{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.dsh-connect-settings .ds-onboard-btn{align-self:flex-start}
.dsh-connect-settings .ds-onboard a{color:var(--ds-accent);word-break:break-all}
.dsh-connect-settings .ds-status{font-size:12px;color:var(--ds-muted)}
`;
function injectStyles() {
  if (typeof document === "undefined") return;
  if (document.getElementById("dsh-connect-settings-style")) return;
  const el = document.createElement("style");
  el.id = "dsh-connect-settings-style";
  el.textContent = STYLE;
  document.head.appendChild(el);
}
function renderConfigField(field, value, onChange, t, options = {}) {
  const ns = options.ns ?? "f";
  const label = tr(t, `${ns}.${field.key}`, field.label ?? field.key);
  const hint = optionalText(t, `${ns}.${field.key}.hint`);
  let control;
  if (field.kind === "boolean") {
    control = h(
      "label",
      { className: "ds-control ds-check-field" },
      h("input", { className: "ds-check", type: "checkbox", checked: !!value, onChange: (e) => onChange(e.target.checked) }),
      " " + label
    );
  } else if (field.kind === "select") {
    control = h(
      "label",
      { className: "ds-control" },
      label + " ",
      h(
        "select",
        { className: "ds-input", value: value ?? "", onChange: (e) => onChange(e.target.value) },
        h("option", { value: "" }, tr(t, "o.default", label)),
        ...(field.options ?? []).map((opt) => h("option", { key: opt, value: opt }, tr(t, `o.${opt}`, opt)))
      )
    );
  } else if (field.kind === "number") {
    control = h(
      "label",
      { className: "ds-control" },
      label + " ",
      h("input", { className: "ds-input", type: "number", value: value ?? "", onChange: (e) => onChange(e.target.value) })
    );
  } else if (field.kind === "list") {
    control = h(
      "label",
      { className: "ds-control" },
      label + " ",
      h("textarea", { className: "ds-input ds-list", value: Array.isArray(value) ? value.join("\n") : "", onChange: (e) => onChange(e.target.value) })
    );
  } else {
    control = h(
      "label",
      { className: "ds-control" },
      label + " ",
      h("input", { className: "ds-input", type: "text", value: value ?? "", onChange: (e) => onChange(e.target.value) })
    );
  }
  return h(
    "div",
    { className: "ds-field", key: `cfg-${field.key}` },
    options.note ? h("p", { className: "ds-note" }, options.note) : null,
    control,
    hint ? h("p", { className: "ds-hint" }, hint) : null
  );
}
function renderSecretField(ch, field, form, onChange, t) {
  const preview = form.secretPreviews?.[ch]?.[field] ?? "";
  const hint = optionalText(t, `s.${ch}.${field}.hint`);
  return h(
    "div",
    { className: "ds-field", key: `sec-${ch}-${field}` },
    h(
      "label",
      { className: "ds-control" },
      tr(t, `s.${ch}.${field}`, field),
      h("input", {
        className: "ds-input",
        // Confidential keys stay masked while typing; identifiers (appId,
        // clientId) don't, so a typo is visible before it is ever saved.
        type: isMaskedSecret(field) ? "password" : "text",
        autoComplete: "off",
        placeholder: preview ? t("configured") : t("notConfigured"),
        value: form.secrets?.[ch]?.[field] ?? "",
        onChange: (e) => onChange(e.target.value)
      })
    ),
    h(
      "p",
      { className: "ds-preview" },
      h("b", null, t("current")),
      preview === "" ? t("notConfigured") : preview
    ),
    hint ? h("p", { className: "ds-hint" }, hint) : null
  );
}
function renderChannel(ch, ctx) {
  const { form, creds, unknownCreds, t, open, advOverride, setChannels, setField, setChannelConfig, toggleOpen, toggleAdvanced, onboarding, onOnboard, onOnboardCancel } = ctx;
  const name2 = tr(t, `channel.${ch}`, ch);
  const channelHint = optionalText(t, `channel.${ch}.hint`);
  const isOpen = open.has(ch);
  const badCreds = unknownCreds.has(ch);
  const advOpen = advOverride?.has(ch) ?? false;
  const configFields = CHANNEL_CONFIG_FIELDS[ch] ?? [];
  const common = configFields.filter((f) => !isAdvanced(ch, f.key));
  const advanced = configFields.filter((f) => isAdvanced(ch, f.key));
  const configField = (field) => renderConfigField(
    field,
    form.channelConfigs?.[ch]?.[field.key],
    (raw) => setChannelConfig(ch, field.key, raw),
    t
  );
  return h(
    "div",
    { className: "ds-channel", key: ch, id: `ds-ch-${ch}` },
    // The checkbox sits beside the header button, not inside it: a button may not
    // contain another interactive element, and browsers disagree about what to do
    // when one does.
    h(
      "div",
      { className: "ds-channel-head" },
      h(
        "label",
        { className: "ds-enable" },
        h("input", {
          className: "ds-check",
          type: "checkbox",
          "aria-label": name2,
          checked: form.channels.includes(ch),
          onChange: (e) => setChannels(ch, e.target.checked)
        })
      ),
      h(
        "button",
        {
          type: "button",
          className: "ds-channel-toggle",
          "aria-expanded": isOpen,
          // Only while the body exists: pointing at an id that is not in the
          // document is worse than not pointing at all.
          "aria-controls": isOpen ? `ds-ch-${ch}-body` : void 0,
          "aria-label": `${name2} \u2014 ${isOpen ? t("collapse") : t("expand")}`,
          onClick: () => toggleOpen(ch)
        },
        h("span", { className: "ds-channel-name" }, name2),
        h(
          "span",
          { className: badCreds ? "ds-badge ds-badge-warn" : "ds-badge" },
          badCreds ? t("credentialUnknown") : creds[ch] ? t("reachable") : t("unreachable")
        ),
        // Drawn in CSS, never a text node: the bundle test reads rendered text as
        // user-visible copy, and a `▾` here would be collected as a stray string.
        h("span", { className: "ds-chevron" })
      )
    ),
    // Collapsed means *not rendered*, not `display:none`. The inputs are
    // controlled from the parent's `form.secrets`, so folding a card cannot lose
    // an unsaved secret — keeping it mounted would buy nothing.
    isOpen ? h(
      "div",
      { className: "ds-channel-body", id: `ds-ch-${ch}-body` },
      channelHint ? h("p", { className: "ds-note" }, channelHint) : null,
      // First in the body, *above* the credential fields, because of the
      // complaint that started this: a user works through every field by hand
      // and only then discovers the button that would have filled them all in.
      // DOM order is visual order — moving this below the fields again undoes
      // the fix. (For telegram and dingtalk the same reasoning holds in
      // reverse: their text says "paste what you got below", so the text has to
      // come before the fields it points at.)
      renderOnboarding(ch, { t, onboarding, onOnboard, onOnboardCancel }),
      h(
        "div",
        { className: "ds-fields" },
        ...CHANNEL_SECRET_FIELDS[ch].map((field) => renderSecretField(ch, field, form, (value) => setField(ch, field, value), t)),
        ...common.map(configField)
      ),
      advanced.length === 0 ? null : h(
        "div",
        { className: "ds-adv" },
        h(
          "button",
          {
            type: "button",
            className: "ds-advanced-toggle",
            "aria-expanded": advOpen,
            "aria-controls": advOpen ? `ds-ch-${ch}-adv` : void 0,
            onClick: () => toggleAdvanced(ch)
          },
          h("span", null, t("advanced")),
          h("span", { className: "ds-chevron" })
        ),
        advOpen ? h("div", { className: "ds-fields", id: `ds-ch-${ch}-adv` }, ...advanced.map(configField)) : null
      )
    ) : null
  );
}
var MANUAL_CREATE_URL = {
  telegram: "https://t.me/BotFather",
  dingtalk: "https://open-dev.dingtalk.com/"
};
var ONBOARD_POLL_MS = 1500;
var ONBOARD_POLL_LIMIT_MS = 16 * 60 * 1e3;
var sleep = (ms) => new Promise((resolve) => {
  setTimeout(resolve, ms);
});
function renderOnboarding(ch, ctx) {
  const { t, onboarding, onOnboard, onOnboardCancel } = ctx;
  const manual = MANUAL_CREATE_URL[ch];
  if (manual) {
    return h(
      "div",
      { className: "ds-onboard" },
      h("p", { className: "ds-hint" }, tr(t, `onboard.manual.${ch}`, manual)),
      h("a", { href: manual, target: "_blank", rel: "noreferrer noopener" }, manual)
    );
  }
  if (ch !== "feishu") return null;
  const busy = onboarding?.busy === true;
  const link = onboarding?.link;
  const pending = busy || onboarding?.phase === "waiting";
  const label = busy && !link ? t("onboard.starting") : pending ? t("onboard.waiting") : t("onboard.create");
  const minutes = Math.max(1, Math.round((link?.expiresInSeconds ?? 0) / 60));
  return h(
    "div",
    { className: "ds-onboard" },
    h("p", { className: "ds-hint" }, t("onboard.create.hint")),
    h(
      "div",
      { className: "ds-onboard-row" },
      h("button", {
        type: "button",
        // Deliberately not a bare `ds-btn`: the bundle test finds the save button
        // as the first element whose className is exactly that, and a second one
        // would make which button it finds depend on render order.
        className: "ds-btn ds-onboard-btn",
        disabled: pending,
        onClick: onOnboard
      }, label),
      // A real cancel, not a UI gesture: the SDK's `registerApp` takes a signal,
      // so this stops the polling and genuinely invalidates the link.
      pending ? h("button", { type: "button", className: "ds-advanced-toggle", onClick: onOnboardCancel }, t("onboard.cancel")) : null
    ),
    link ? h(
      "p",
      { className: "ds-hint ds-onboard-link" },
      h("span", null, t("onboard.link")),
      " ",
      h("a", { href: link.url, target: "_blank", rel: "noreferrer noopener" }, link.url),
      " ",
      h("span", null, tr(t, "onboard.linkExpiry", "").replace("{minutes}", String(minutes)))
    ) : null
  );
}
function renderIssue(issue, t) {
  const channel = issue.channel === void 0 ? null : h("span", null, tr(t, `channel.${issue.channel}`, issue.channel));
  if (issue.kind === "credentialUnknown") {
    return h(
      "li",
      { className: "ds-issue", key: issue.key },
      channel,
      h("span", null, t("credentialUnknownHint"))
    );
  }
  if (issue.kind === "channelFailed") {
    return h(
      "li",
      { className: "ds-issue", key: issue.key },
      channel,
      h("span", null, t("channelFailed")),
      // The adapter's own message, verbatim. It is the only part that names the
      // credential or option that is actually wrong, so mapping it to a code the
      // locale would then have to guess at backwards would lose the answer.
      h("code", { className: "ds-issue-reason" }, issue.reason)
    );
  }
  if (issue.kind === "onboarding") {
    return h(
      "li",
      { className: "ds-issue", key: issue.key },
      h("span", null, tr(t, `onboard.${issue.code}`, issue.code)),
      issue.appId === void 0 ? null : h("code", { className: "ds-issue-reason" }, issue.appId),
      issue.reason === void 0 ? null : h("code", { className: "ds-issue-reason" }, issue.reason)
    );
  }
  return h(
    "li",
    { className: "ds-issue", key: issue.key },
    h("span", null, tr(t, `w.${issue.code}`, issue.code))
  );
}
var MODEL_GROUP = "g.group.agent";
function renderModelRow(t, agentModel) {
  return h(
    "div",
    { className: "ds-field", key: "cfg-agentModel" },
    h("label", { className: "ds-control" }, tr(t, "g.model", "Default model")),
    // Plain text, never an input: it must not look like something to type into.
    h("p", { className: "ds-readonly" }, `${agentModel.provider} / ${agentModel.model}`),
    h("p", { className: "ds-note" }, tr(t, "g.model.note", ""))
  );
}
function renderGeneralCard(group, ctx) {
  const { form, t, setGeneral } = ctx;
  const overridden = new Set(form.sharedOverrideKeys ?? []);
  return h(
    "section",
    { className: "ds-card", key: group.title },
    h("h4", { className: "ds-card-title" }, tr(t, group.title, group.title)),
    h(
      "div",
      { className: "ds-fields" },
      ...group.fields.map((field) => renderConfigField(
        field,
        form.general?.[field.key],
        (raw) => setGeneral(field.key, raw),
        t,
        {
          ns: "g",
          // Shown only where the shared config really does override the profile
          // value. A blanket caveat would be false on every row it does not
          // apply to, and a warning that is usually wrong is one the user learns
          // to scroll past. `workspaces` is absent from this list on purpose:
          // the shared config *merges* there instead of overriding, so an edit
          // genuinely does take effect — its hint says as much instead.
          note: overridden.has(field.key) ? tr(t, "g.sharedOverride", "") : void 0
        }
      )),
      // Only on the agent card, and only when the host could read a selection at
      // all: an empty read-only row would say "there is no model", which is a
      // different and false statement from "the pane could not read one".
      group.title === MODEL_GROUP && form.agentModel ? renderModelRow(t, form.agentModel) : null
    )
  );
}
function renderGeneralView(ctx) {
  return GENERAL_FIELD_GROUPS.map((group) => renderGeneralCard(group, ctx));
}
function ConnectSettingsTab({ rpcCall, t }) {
  const [form, setForm] = React.useState(null);
  const [status, setStatus] = React.useState("loading");
  const [creds, setCreds] = React.useState({});
  const [openOverride, setOpenOverride] = React.useState(null);
  const [advOverride, setAdvOverride] = React.useState(null);
  const [notices, setNotices] = React.useState([]);
  const [onboarding, setOnboarding] = React.useState(null);
  const [viewOverride, setViewOverride] = React.useState(null);
  const rpc = (endpoint, payload) => rpcCall(endpoint, payload);
  React.useEffect(() => {
    let alive = true;
    loadSettings(rpc).then((snap) => {
      if (!alive) return;
      setForm(snapshotToForm(snap));
      setCreds(snap.credentials ?? {});
      setNotices(snapshotIssues(snap));
      setStatus("idle");
    }).catch(() => alive && setStatus("error"));
    return () => {
      alive = false;
    };
  }, [rpcCall]);
  const onSave = async () => {
    if (!form) return;
    setStatus("saving");
    try {
      let snap = await saveSettings(rpc, buildConfigSave(form));
      const warnings = new Set(snap.warnings ?? []);
      for (const c of buildCredentialSaves(form)) {
        snap = await saveCredentials(rpc, c.channel, c.values);
        for (const code of snap.warnings ?? []) warnings.add(code);
      }
      setForm(snapshotToForm(snap));
      setCreds(snap.credentials ?? {});
      setNotices(snapshotIssues(snap, [...warnings]));
      setStatus("saved");
    } catch {
      setStatus("error");
    }
  };
  const onOnboard = async () => {
    setOnboarding({ busy: true });
    try {
      setOnboarding(await callRpc(rpc, "onboarding.start", { channel: "feishu" }));
      const startedAt = Date.now();
      for (; ; ) {
        const now = await callRpc(rpc, "onboarding.status", {});
        setOnboarding(now);
        if (now?.phase !== "waiting") break;
        if (Date.now() - startedAt > ONBOARD_POLL_LIMIT_MS) break;
        await sleep(ONBOARD_POLL_MS);
      }
    } catch (error) {
      setOnboarding({ phase: "failed", outcome: { created: false, reason: error?.message ?? String(error) } });
    } finally {
      try {
        const snap = await loadSettings(rpc);
        setForm(snapshotToForm(snap));
        setCreds(snap.credentials ?? {});
        setNotices(snapshotIssues(snap));
      } catch {
      }
    }
  };
  const onOnboardCancel = async () => {
    try {
      setOnboarding(await callRpc(rpc, "onboarding.cancel", {}));
    } catch {
    }
  };
  const setChannels = (ch, on) => {
    setForm((f) => ({ ...f, channels: on ? [...f.channels, ch] : f.channels.filter((x) => x !== ch) }));
    setOpenOverride(on && !open.has(ch) ? new Set(open).add(ch) : new Set(open));
  };
  const setField = (ch, field, value) => setForm((f) => ({ ...f, secrets: { ...f.secrets, [ch]: { ...f.secrets[ch] ?? {}, [field]: value } } }));
  const setChannelConfig = (ch, key, raw) => setForm((f) => {
    const descriptor = (CHANNEL_CONFIG_FIELDS[ch] ?? []).find((x) => x.key === key);
    const value = coerceConfigValue(descriptor?.kind ?? "text", raw);
    const cfg = { ...f.channelConfigs[ch] ?? {} };
    if (value === void 0) delete cfg[key];
    else cfg[key] = value;
    return { ...f, channelConfigs: { ...f.channelConfigs, [ch]: cfg } };
  });
  const setDefault = (key, raw) => setForm((f) => {
    const descriptor = CHANNEL_DEFAULT_FIELDS.find((x) => x.key === key);
    const value = coerceConfigValue(descriptor?.kind ?? "text", raw);
    const defaults = { ...f.channelDefaults ?? {} };
    if (value === void 0) delete defaults[key];
    else defaults[key] = value;
    return { ...f, channelDefaults: defaults };
  });
  const setGeneral = (key, raw) => setForm((f) => {
    const descriptor = GENERAL_FIELDS.find((x) => x.key === key);
    const value = coerceConfigValue(descriptor?.kind ?? "text", raw);
    const general = { ...f.general ?? {} };
    if (value === void 0) delete general[key];
    else general[key] = value;
    return { ...f, general };
  });
  if (!form) return h("div", { className: "dsh-connect-settings" }, t("loading"));
  const open = openOverride ?? initialOpenChannels(form.channels, ALL_CHANNELS);
  const unknownCreds = new Set(
    notices.filter((n) => n.kind === "credentialUnknown").map((n) => n.channel)
  );
  const issues = [...notices, ...onboardingIssues(onboarding?.outcome)];
  const view = viewOverride ?? DEFAULT_VIEW;
  const toggleOpen = (ch) => setOpenOverride(toggleInSet(open, ch));
  const toggleAdvanced = (ch) => setAdvOverride(toggleInSet(advOverride ?? /* @__PURE__ */ new Set(), ch));
  const focusChannel = (ch) => {
    if (!open.has(ch)) setOpenOverride(new Set(open).add(ch));
    if (typeof document === "undefined" || !document.getElementById) return;
    document.getElementById(`ds-ch-${ch}`)?.scrollIntoView?.({ block: "nearest" });
  };
  return h(
    "div",
    { className: "dsh-connect-settings" },
    // The primary navigation: 通用设置 → 机器人渠道, in `PANE_VIEWS` order.
    //
    // `aria-current=page`, never `role="tab"`: these are links between two
    // views and there is no tablist in the document for a tab to belong to.
    // (The channel strip below is a different thing — it *is* a tab strip,
    // which is why it keeps `ds-tab` and this must not borrow that class.)
    //
    // A direct child of the root, like the two strips below and for the same
    // sticky reason. It is also the reason `.ds-tabs` pins to `var(--ds-nav-h)`
    // rather than 0: both strips are sticky, and a control the user asked to
    // keep on screen must not slide underneath another one.
    h(
      "nav",
      { className: "ds-nav", "aria-label": t("navAria") },
      ...PANE_VIEWS.map((name2) => h("button", {
        key: `view-${name2}`,
        type: "button",
        className: "ds-nav-item",
        "aria-current": view === name2 ? "page" : void 0,
        onClick: () => setViewOverride(name2)
      }, tr(t, `view.${name2}`, name2)))
    ),
    // The two views are mutually exclusive: the hidden one is *not rendered*,
    // not hidden in CSS. Both are tall, and mounting both would put every
    // control of both in the DOM at once for no benefit.
    view === "general" ? renderGeneralView({ form, t, setGeneral }) : [
      // A tab strip, but not `role=tablist`: several channels can be open at
      // once, so there is no single "selected" tab to report. These are
      // buttons that open and jump to a channel, and `aria-expanded` says so.
      //
      // A direct child of the root, and not inside the channels card where it
      // used to live: `position:sticky` pins to the nearest scrollport only
      // while the element's containing block is the scrolled box. Nested in a
      // card it could never leave that card, so the strip scrolled away with
      // the content — the same reason the footer below sits here.
      h(
        "nav",
        { className: "ds-tabs", "aria-label": t("tabsAria") },
        ...ALL_CHANNELS.map((ch) => h(
          "button",
          {
            key: `tab-${ch}`,
            type: "button",
            className: "ds-tab",
            "aria-expanded": open.has(ch),
            "aria-controls": open.has(ch) ? `ds-ch-${ch}-body` : void 0,
            onClick: () => focusChannel(ch)
          },
          h("span", { className: "ds-dot", "data-on": form.channels.includes(ch) ? "1" : "0" }),
          tr(t, `channel.${ch}`, ch)
        ))
      ),
      h(
        "section",
        { className: "ds-card" },
        h("h4", { className: "ds-card-title" }, t("channels")),
        // Explains the masking before the user meets a truncated value and
        // wonders whether their stored secret is corrupt.
        h("p", { className: "ds-note" }, t("previewNote")),
        ...ALL_CHANNELS.map((ch) => renderChannel(ch, {
          form,
          creds,
          unknownCreds,
          t,
          open,
          advOverride,
          setChannels,
          setField,
          setChannelConfig,
          toggleOpen,
          toggleAdvanced,
          onboarding,
          onOnboard,
          onOnboardCancel
        }))
      ),
      h(
        "section",
        { className: "ds-card" },
        h("h4", { className: "ds-card-title" }, t("defaults")),
        h("p", { className: "ds-note" }, t("defaultsHint")),
        h(
          "div",
          { className: "ds-fields" },
          ...CHANNEL_DEFAULT_FIELDS.map((field) => renderConfigField(field, form.channelDefaults?.[field.key], (raw) => setDefault(field.key, raw), t)),
          // Only meaningful on the fallback plane: it names the file the pane
          // persists to. With the namespace live that path is not consulted
          // (and is not part of the section), so showing an editable field for
          // it would silently swallow edits.
          form.live ? null : h(
            "div",
            { className: "ds-field" },
            h(
              "label",
              { className: "ds-control" },
              t("statePath"),
              h("input", { className: "ds-input", value: form.settingsStatePath ?? "", onChange: (e) => setForm((f) => ({ ...f, settingsStatePath: e.target.value })) })
            ),
            h("p", { className: "ds-hint" }, t("statePathHint"))
          )
        ),
        h("div", { className: "ds-status" }, form.live ? t("livePlane") : t("filePlane"))
      )
    ],
    // Last child of the root, not of a card: `position:sticky` pins to the
    // nearest scrollport only while its containing block is the scrolled box.
    // Nested in the defaults card it could never move outside that card, so it
    // pinned to nothing and Save scrolled away with the channel list.
    //
    // Shared by both views, deliberately: 通用设置 has to be saveable too, and
    // it is the same save — one payload, one button, whichever view is open.
    h(
      "div",
      { className: "ds-footer" },
      // In the save bar rather than beside the channel it concerns: these are
      // answers to *this* save, and the bar is the one part of the pane that is
      // always on screen. A channel card can be folded, or scrolled past, and
      // 「已保存」 next to nothing else is the whole complaint.
      issues.length === 0 ? null : h("ul", { className: "ds-issues" }, ...issues.map((issue) => renderIssue(issue, t))),
      h("button", { className: "ds-btn", type: "button", onClick: onSave, disabled: status === "saving" }, t("save")),
      // Rendering `status` directly leaks the raw state ids (`idle`, `saving`)
      // into the UI; every state has a locale entry instead.
      h("span", { className: "ds-status" }, tr(t, `status.${status}`, status))
    )
  );
}
function apply(ctx) {
  injectStyles();
  ctx.effect(() => ctx.locale.register(NS, locale), "dsh-connect: locale");
  const t = ctx.locale.bind(NS);
  const rpcCall = (endpoint, payload, signal) => ctx.connection.rpc.call(SETTINGS_RPC_CHANNEL, endpoint, payload, signal);
  ctx.effect(() => ctx.slots.inject("settings.section", () => ctx.slots.register({
    name: "settings.section",
    id: "dsh-connect",
    order: 20,
    label: () => t("title"),
    locale: NS,
    inject: () => ({ rpcCall, t })
  }, ConnectSettingsTab)), "dsh-connect: settings.section");
}
    return module.exports;
  }
});
//# sourceMappingURL=client.js.map
