/**
 * dsh-connect client settings plugin.
 *
 * Registers a "settings.section" in the DeepSeek Harness web UI, mirroring
 * xmanrui/dsh-im (plugin-src/client/index.js). The pane talks to the host over
 * the `/dsh-connect` channel via `ctx.connection.rpc.call`. All the data logic
 * (snapshot<->form mapping, save-payload building) lives in the tested
 * `settings-model.js` / `rpc-client.js` helpers; this component is a thin
 * renderer. Build the lib first (`pnpm --filter dsh-connect build`), then
 * bundle this in a `dsh web` shell (Vite).
 */
import * as React from 'react';

import { SETTINGS_RPC_CHANNEL } from '../lib/settings/settings-rpc.js';
import { loadSettings, saveSettings, saveCredentials } from '../lib/settings/rpc-client.js';
import { snapshotToForm, buildConfigSave, buildCredentialSaves, CHANNEL_SECRET_FIELDS, CHANNEL_CONFIG_FIELDS, CHANNEL_DEFAULT_FIELDS, coerceConfigValue } from '../lib/settings/settings-model.js';

export const name = 'dsh-connect-settings';
export const inject = ['slots', 'connection', 'locale'];
export const NS = 'dsh-connect';

export const locale = {
  zh: { title: '连接设置', channels: '渠道', save: '保存', saved: '已保存', error: '保存失败', loading: '加载中', defaults: '公共默认(channelDefaults)', statePath: '设置文件', secret: '密钥', config: '配置', reachable: '已连接凭据', unreachable: '未配置凭据' },
  en: { title: 'Connection Settings', channels: 'Channels', save: 'Save', saved: 'Saved', error: 'Save failed', loading: 'Loading', defaults: 'Defaults (channelDefaults)', statePath: 'Settings file', secret: 'Secret', config: 'Config', reachable: 'Credential set', unreachable: 'Credential missing' },
};

const h = React.createElement;

// Self-contained scoped stylesheet for the pane (injected once). The host's own
// settings panes use per-feature CSS modules we can't import into this separate
// bundle, so we ship our own consistent, theme-aware styles instead. Everything
// is scoped under `.dsh-connect-settings` so nothing leaks into the shell.
const STYLE = `
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
  if (typeof document === 'undefined') return;
  if (document.getElementById('dsh-connect-settings-style')) return;
  const el = document.createElement('style');
  el.id = 'dsh-connect-settings-style';
  el.textContent = STYLE;
  document.head.appendChild(el);
}

// A secret config key is masked as a password unless it's a non-confidential
// identifier (appId / clientId / webhookUrl) that's safe to show in plain text
// so an upgraded user can confirm it. Keys ending in Secret/Token stay masked.
function isMaskedSecret(field) {
  return /(secret|token|password)/i.test(field);
}

// Render a single config field control per its `kind` (text / number / boolean / select).
function renderConfigField(field, value, onChange) {
  const label = field.label ?? field.key;
  if (field.kind === 'boolean') {
    return h('label', { className: 'ds-field ds-check-field', key: `cfg-${field.key}` },
      h('input', { className: 'ds-check', type: 'checkbox', checked: !!value, onChange: (e) => onChange(e.target.checked) }),
      ' ' + label);
  }
  if (field.kind === 'select') {
    return h('label', { className: 'ds-field', key: `cfg-${field.key}` },
      label + ' ',
      h('select', { className: 'ds-input', value: value ?? '', onChange: (e) => onChange(e.target.value) },
        h('option', { value: '' }, '(default)'),
        ...(field.options ?? []).map((opt) => h('option', { key: opt, value: opt }, opt))));
  }
  if (field.kind === 'number') {
    return h('label', { className: 'ds-field', key: `cfg-${field.key}` },
      label + ' ',
      h('input', { className: 'ds-input', type: 'number', value: value ?? '', onChange: (e) => onChange(e.target.value) }));
  }
  return h('label', { className: 'ds-field', key: `cfg-${field.key}` },
    label + ' ',
    h('input', { className: 'ds-input', type: 'text', value: value ?? '', onChange: (e) => onChange(e.target.value) }));
}

// Thin React renderer over the tested settings-model helpers.
export function ConnectSettingsTab({ rpcCall, t }) {
  const [form, setForm] = React.useState(null);
  const [status, setStatus] = React.useState('loading');
  const [creds, setCreds] = React.useState({});
  const rpc = (endpoint, payload) => rpcCall(endpoint, payload);

  React.useEffect(() => {
    let alive = true;
    loadSettings(rpc).then((snap) => {
      if (!alive) return;
      setForm(snapshotToForm(snap));
      setCreds(snap.credentials ?? {});
      setStatus('idle');
    }).catch(() => alive && setStatus('error'));
    return () => { alive = false; };
  }, [rpcCall]);

  const onSave = async () => {
    if (!form) return;
    setStatus('saving');
    try {
      await saveSettings(rpc, buildConfigSave(form));
      for (const c of buildCredentialSaves(form)) await saveCredentials(rpc, c.channel, c.values);
      setStatus('saved');
    } catch { setStatus('error'); }
  };

  const setChannels = (ch, on) => setForm((f) => ({ ...f, channels: on ? [...f.channels, ch] : f.channels.filter((x) => x !== ch) }));
  const setField = (ch, field, value) => setForm((f) => ({ ...f, secrets: { ...f.secrets, [ch]: { ...(f.secrets[ch] ?? {}), [field]: value } } }));
  const setChannelConfig = (ch, key, raw) => setForm((f) => {
    const descriptor = (CHANNEL_CONFIG_FIELDS[ch] ?? []).find((x) => x.key === key);
    const value = coerceConfigValue(descriptor?.kind ?? 'text', raw);
    const cfg = { ...(f.channelConfigs[ch] ?? {}) };
    if (value === undefined) delete cfg[key]; else cfg[key] = value;
    return { ...f, channelConfigs: { ...f.channelConfigs, [ch]: cfg } };
  });
  const setDefault = (key, raw) => setForm((f) => {
    const descriptor = CHANNEL_DEFAULT_FIELDS.find((x) => x.key === key);
    const value = coerceConfigValue(descriptor?.kind ?? 'text', raw);
    const defaults = { ...(f.channelDefaults ?? {}) };
    if (value === undefined) delete defaults[key]; else defaults[key] = value;
    return { ...f, channelDefaults: defaults };
  });

  if (!form) return h('div', { className: 'dsh-connect-settings' }, t('loading'));
  return h('div', { className: 'dsh-connect-settings' },
    h('section', { className: 'ds-card' },
      h('h4', { className: 'ds-card-title' }, t('channels')),
      // One card per built-in channel: enable toggle + cred badge + secret + config fields.
      ...Object.keys(CHANNEL_SECRET_FIELDS).map((ch) => h('fieldset', { className: 'ds-channel', key: ch },
        h('legend', { className: 'ds-legend' },
          h('label', null,
            h('input', { className: 'ds-check', type: 'checkbox', checked: form.channels.includes(ch), onChange: (e) => setChannels(ch, e.target.checked) }),
            h('span', null, ch),
            h('span', { className: 'ds-badge' }, creds[ch] ? t('reachable') : t('unreachable'))),
        ),
        h('div', { className: 'ds-fields' },
          ...CHANNEL_SECRET_FIELDS[ch].map((field) => h('label', { className: 'ds-field', key: `sec-${field}` },
            field,
            h('input', { className: 'ds-input', type: isMaskedSecret(field) ? 'password' : 'text', autoComplete: 'off', placeholder: field, value: form.secrets?.[ch]?.[field] ?? '', onChange: (e) => setField(ch, field, e.target.value) }))),
          ...(CHANNEL_CONFIG_FIELDS[ch] ?? []).map((field) => renderConfigField(field, form.channelConfigs?.[ch]?.[field.key], (raw) => setChannelConfig(ch, field.key, raw))),
        ),
      )),
    ),
    h('section', { className: 'ds-card' },
      h('h4', { className: 'ds-card-title' }, t('defaults')),
      h('div', { className: 'ds-fields' },
        ...CHANNEL_DEFAULT_FIELDS.map((field) => renderConfigField(field, form.channelDefaults?.[field.key], (raw) => setDefault(field.key, raw))),
        h('label', { className: 'ds-field' }, t('statePath'),
          h('input', { className: 'ds-input', value: form.settingsStatePath ?? '', onChange: (e) => setForm((f) => ({ ...f, settingsStatePath: e.target.value })) })),
      ),
      h('div', { className: 'ds-actions' },
        h('button', { className: 'ds-btn', onClick: onSave, disabled: status === 'saving' }, t('save')),
        h('span', { className: 'ds-status' }, status === 'saved' ? t('saved') : status === 'error' ? t('error') : status),
      ),
    ),
  );
}

export function apply(ctx) {
  injectStyles();
  ctx.effect(() => ctx.locale.register(NS, locale), 'dsh-connect: locale');
  const t = ctx.locale.bind(NS);
  const rpcCall = (endpoint, payload, signal) => ctx.connection.rpc.call(SETTINGS_RPC_CHANNEL, endpoint, payload, signal);
  ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: 'dsh-connect', order: 20, label: () => t('title'), locale: NS, inject: () => ({ rpcCall, t }),
  }, ConnectSettingsTab)), 'dsh-connect: settings.section');
}
