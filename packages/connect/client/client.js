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

// packages/connect/client/settings-client.mjs
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

// packages/connect/lib/settings/settings-rpc.js
var SETTINGS_RPC_CHANNEL = "/dsh-connect";
var SETTINGS_ENDPOINTS = Object.freeze(["settings.get", "settings.save", "credentials.save", "settings.status"]);

// packages/connect/lib/settings/rpc-client.js
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

// packages/connect/lib/settings/credential-store.js
var CREDENTIAL_REFS = Object.freeze({
  feishu: ["DSH_CONNECT_FEISHU_APP_ID", "DSH_CONNECT_FEISHU_APP_SECRET"],
  telegram: ["DSH_CONNECT_TELEGRAM_BOT_TOKEN"],
  dingtalk: ["DSH_CONNECT_DINGTALK_WEBHOOK_URL", "DSH_CONNECT_DINGTALK_SECRET"],
  web: []
});
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

// packages/connect/lib/settings/settings-model.js
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
  { key: "language", kind: "select", options: ["zh", "en"], label: "language" },
  { key: "notifyLevel", kind: "select", options: ["full", "important", "result"], label: "notifyLevel" }
];
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
    default:
      return String(raw);
  }
}
function snapshotToForm(snapshot) {
  const config = snapshot.config ?? {};
  const channels = snapshot.enabled ?? [];
  const channelConfigs = {};
  for (const ch of channels)
    channelConfigs[ch] = config[ch] ?? {};
  return {
    channels,
    channelDefaults: config.channelDefaults ?? {},
    channelConfigs,
    // Echo store-backed secret values (e.g. an upgraded user's appId) so the pane
    // prefills them. Absent keys stay blank — the pane only learns a value if it
    // actually exists in the credential store, never from the state file.
    secrets: snapshot.secrets ?? {},
    settingsStatePath: config.settingsStatePath
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

// packages/connect/client/settings-client.mjs
var name = "dsh-connect-settings";
var inject = ["slots", "connection", "locale"];
var NS = "dsh-connect";
var locale = {
  zh: { title: "\u8FDE\u63A5\u8BBE\u7F6E", channels: "\u6E20\u9053", save: "\u4FDD\u5B58", saved: "\u5DF2\u4FDD\u5B58", error: "\u4FDD\u5B58\u5931\u8D25", loading: "\u52A0\u8F7D\u4E2D", defaults: "\u516C\u5171\u9ED8\u8BA4(channelDefaults)", statePath: "\u8BBE\u7F6E\u6587\u4EF6", secret: "\u5BC6\u94A5", config: "\u914D\u7F6E", reachable: "\u5DF2\u8FDE\u63A5\u51ED\u636E", unreachable: "\u672A\u914D\u7F6E\u51ED\u636E" },
  en: { title: "Connection Settings", channels: "Channels", save: "Save", saved: "Saved", error: "Save failed", loading: "Loading", defaults: "Defaults (channelDefaults)", statePath: "Settings file", secret: "Secret", config: "Config", reachable: "Credential set", unreachable: "Credential missing" }
};
var h = React.createElement;
var STYLE = `
.dsh-connect-settings{--ds-bg:#ffffff;--ds-bg-sub:#f6f7f9;--ds-text:#1f2329;--ds-muted:#646a73;--ds-border:#e2e4e8;--ds-border-2:#c8cbd0;--ds-accent:#3b82f6;--ds-accent-fg:#ffffff;--ds-focus:rgba(59,130,246,.22);display:flex;flex-direction:column;gap:14px;min-width:280px;max-width:760px;color:var(--ds-text);font:13px/1.6 -apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;padding:4px 2px}
@media(prefers-color-scheme:dark){.dsh-connect-settings{--ds-bg:#1a1b1e;--ds-bg-sub:#232428;--ds-text:#e8eaed;--ds-muted:#9aa0a6;--ds-border:#3b3d42;--ds-border-2:#5c5f66;--ds-accent:#5b9dff;--ds-accent-fg:#0f1115;--ds-focus:rgba(91,157,255,.25)}}
.dsh-connect-settings .ds-card{border:1px solid var(--ds-border);border-radius:10px;background:var(--ds-bg);padding:12px 14px;display:flex;flex-direction:column;gap:10px}
.dsh-connect-settings .ds-card-title{margin:0;font-size:13px;font-weight:600}
.dsh-connect-settings .ds-channel{border:1px dashed var(--ds-border-2);border-radius:8px;padding:8px 12px;margin:0;background:var(--ds-bg-sub)}
.dsh-connect-settings .ds-legend{padding:0 6px}
.dsh-connect-settings .ds-legend label{display:flex;align-items:center;gap:6px;font-size:12px;font-weight:600}
.dsh-connect-settings .ds-badge{margin-left:4px;font-size:11px;font-weight:500;padding:1px 8px;border-radius:99px;background:var(--ds-bg);color:var(--ds-muted);border:1px solid var(--ds-border-2)}
.dsh-connect-settings .ds-fields{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:10px 14px;margin-top:8px}
.dsh-connect-settings .ds-field{display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--ds-muted)}
.dsh-connect-settings .ds-field.ds-check-field{flex-direction:row;align-items:center;gap:6px}
.dsh-connect-settings .ds-check{width:16px;height:16px;accent-color:var(--ds-accent)}
.dsh-connect-settings .ds-input{height:30px;width:100%;padding:0 9px;border:1px solid var(--ds-border-2);border-radius:6px;background:var(--ds-bg);color:var(--ds-text);font:inherit}
.dsh-connect-settings select.ds-input{cursor:pointer}
.dsh-connect-settings .ds-input:focus{outline:none;border-color:var(--ds-accent);box-shadow:0 0 0 2px var(--ds-focus)}
.dsh-connect-settings .ds-actions{display:flex;align-items:center;gap:12px;margin-top:2px}
.dsh-connect-settings .ds-btn{height:32px;padding:0 18px;border:none;border-radius:6px;background:var(--ds-accent);color:var(--ds-accent-fg);font:inherit;font-weight:500;cursor:pointer}
.dsh-connect-settings .ds-btn:disabled{opacity:.55;cursor:default}
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
function isMaskedSecret(field) {
  return /(secret|token|password)/i.test(field);
}
function renderConfigField(field, value, onChange) {
  const label = field.label ?? field.key;
  if (field.kind === "boolean") {
    return h(
      "label",
      { className: "ds-field ds-check-field", key: `cfg-${field.key}` },
      h("input", { className: "ds-check", type: "checkbox", checked: !!value, onChange: (e) => onChange(e.target.checked) }),
      " " + label
    );
  }
  if (field.kind === "select") {
    return h(
      "label",
      { className: "ds-field", key: `cfg-${field.key}` },
      label + " ",
      h(
        "select",
        { className: "ds-input", value: value ?? "", onChange: (e) => onChange(e.target.value) },
        h("option", { value: "" }, "(default)"),
        ...(field.options ?? []).map((opt) => h("option", { key: opt, value: opt }, opt))
      )
    );
  }
  if (field.kind === "number") {
    return h(
      "label",
      { className: "ds-field", key: `cfg-${field.key}` },
      label + " ",
      h("input", { className: "ds-input", type: "number", value: value ?? "", onChange: (e) => onChange(e.target.value) })
    );
  }
  return h(
    "label",
    { className: "ds-field", key: `cfg-${field.key}` },
    label + " ",
    h("input", { className: "ds-input", type: "text", value: value ?? "", onChange: (e) => onChange(e.target.value) })
  );
}
function ConnectSettingsTab({ rpcCall, t }) {
  const [form, setForm] = React.useState(null);
  const [status, setStatus] = React.useState("loading");
  const [creds, setCreds] = React.useState({});
  const rpc = (endpoint, payload) => rpcCall(endpoint, payload);
  React.useEffect(() => {
    let alive = true;
    loadSettings(rpc).then((snap) => {
      if (!alive) return;
      setForm(snapshotToForm(snap));
      setCreds(snap.credentials ?? {});
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
      await saveSettings(rpc, buildConfigSave(form));
      for (const c of buildCredentialSaves(form)) await saveCredentials(rpc, c.channel, c.values);
      setStatus("saved");
    } catch {
      setStatus("error");
    }
  };
  const setChannels = (ch, on) => setForm((f) => ({ ...f, channels: on ? [...f.channels, ch] : f.channels.filter((x) => x !== ch) }));
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
  if (!form) return h("div", { className: "dsh-connect-settings" }, t("loading"));
  return h(
    "div",
    { className: "dsh-connect-settings" },
    h(
      "section",
      { className: "ds-card" },
      h("h4", { className: "ds-card-title" }, t("channels")),
      ...Object.keys(CHANNEL_SECRET_FIELDS).map((ch) => h(
        "fieldset",
        { className: "ds-channel", key: ch },
        h(
          "legend",
          { className: "ds-legend" },
          h(
            "label",
            null,
            h("input", { className: "ds-check", type: "checkbox", checked: form.channels.includes(ch), onChange: (e) => setChannels(ch, e.target.checked) }),
            h("span", null, ch),
            h("span", { className: "ds-badge" }, creds[ch] ? t("reachable") : t("unreachable"))
          )
        ),
        h(
          "div",
          { className: "ds-fields" },
          ...CHANNEL_SECRET_FIELDS[ch].map((field) => h(
            "label",
            { className: "ds-field", key: `sec-${field}` },
            field,
            h("input", { className: "ds-input", type: isMaskedSecret(field) ? "password" : "text", autoComplete: "off", placeholder: field, value: form.secrets?.[ch]?.[field] ?? "", onChange: (e) => setField(ch, field, e.target.value) })
          )),
          ...(CHANNEL_CONFIG_FIELDS[ch] ?? []).map((field) => renderConfigField(field, form.channelConfigs?.[ch]?.[field.key], (raw) => setChannelConfig(ch, field.key, raw)))
        )
      ))
    ),
    h(
      "section",
      { className: "ds-card" },
      h("h4", { className: "ds-card-title" }, t("defaults")),
      h(
        "div",
        { className: "ds-fields" },
        ...CHANNEL_DEFAULT_FIELDS.map((field) => renderConfigField(field, form.channelDefaults?.[field.key], (raw) => setDefault(field.key, raw))),
        h(
          "label",
          { className: "ds-field" },
          t("statePath"),
          h("input", { className: "ds-input", value: form.settingsStatePath ?? "", onChange: (e) => setForm((f) => ({ ...f, settingsStatePath: e.target.value })) })
        )
      ),
      h(
        "div",
        { className: "ds-actions" },
        h("button", { className: "ds-btn", onClick: onSave, disabled: status === "saving" }, t("save")),
        h("span", { className: "ds-status" }, status === "saved" ? t("saved") : status === "error" ? t("error") : status)
      )
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
