/**
 * dsh-connect-all client settings plugin.
 *
 * Registers a "settings.section" in the DeepSeek Harness web UI, mirroring
 * xmanrui/dsh-im (plugin-src/client/index.js). The pane talks to the host over
 * the `/dsh-connect` channel via `ctx.connection.rpc.call`. All the data logic
 * (snapshot<->form mapping, save-payload building) lives in the tested
 * `settings-model.js` / `rpc-client.js` helpers; this component is a thin
 * renderer. Build the lib first (`pnpm --filter dsh-connect-all build`), then
 * bundle this in a `dsh web` shell (Vite).
 */
import * as React from 'react';

import { SETTINGS_RPC_CHANNEL } from '../lib/settings-rpc.js';
import { loadSettings, saveSettings, saveCredentials } from '../lib/rpc-client.js';
import { snapshotToForm, buildConfigSave, buildCredentialSaves, CHANNEL_SECRET_FIELDS } from '../lib/settings-model.js';

export const name = 'dsh-connect-all-settings';
export const inject = ['slots', 'connection', 'locale'];
export const NS = 'dsh-connect-all';

export const locale = {
  zh: { title: '连接设置', channels: '渠道', save: '保存', saved: '已保存', error: '保存失败', loading: '加载中', defaults: '公共默认(channelDefaults)', statePath: '设置文件', secret: '密钥', reachable: '已连接凭据', unreachable: '未配置凭据' },
  en: { title: 'Connection Settings', channels: 'Channels', save: 'Save', saved: 'Saved', error: 'Save failed', loading: 'Loading', defaults: 'Defaults (channelDefaults)', statePath: 'Settings file', secret: 'Secret', reachable: 'Credential set', unreachable: 'Credential missing' },
};

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

  if (!form) return React.createElement('div', null, t('loading'));
  return React.createElement('div', null,
    React.createElement('h3', null, t('title')),
    // Channels
    ...CHANNEL_SECRET_FIELDS && Object.keys(CHANNEL_SECRET_FIELDS).map((ch) => React.createElement('label', { key: ch },
      React.createElement('input', { type: 'checkbox', checked: form.channels.includes(ch), onChange: (e) => setChannels(ch, e.target.checked) }), ch,
      React.createElement('span', null, creds[ch] ? t('reachable') : t('unreachable')),
      ...CHANNEL_SECRET_FIELDS[ch].map((field) => React.createElement('input', { key: field, placeholder: field, type: 'password', value: form.secrets?.[ch]?.[field] ?? '', onChange: (e) => setField(ch, field, e.target.value) })),
    )),
    React.createElement('label', null, t('statePath')),
    React.createElement('input', { value: form.settingsStatePath ?? '', onChange: (e) => setForm((f) => ({ ...f, settingsStatePath: e.target.value })) }),
    React.createElement('button', { onClick: onSave, disabled: status === 'saving' }, t('save')),
    React.createElement('span', null, status === 'saved' ? t('saved') : status === 'error' ? t('error') : status),
  );
}

export function apply(ctx) {
  ctx.effect(() => ctx.locale.register(NS, locale), 'dsh-connect-all: locale');
  const t = ctx.locale.bind(NS);
  const rpcCall = (endpoint, payload, signal) => ctx.connection.rpc.call(SETTINGS_RPC_CHANNEL, endpoint, payload, signal);
  ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: 'dsh-connect-all', order: 20, label: () => t('title'), locale: NS, inject: () => ({ rpcCall, t }),
  }, ConnectSettingsTab)), 'dsh-connect-all: settings.section');
}
