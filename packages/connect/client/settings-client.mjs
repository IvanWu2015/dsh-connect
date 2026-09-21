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
 *
 * The pane is an accordion, not a flat list. Four channels with every field
 * visible is ~2000px of content in a ~690px scroller, so the channel cards
 * collapse, rarely-touched fields hide behind a second-level "advanced" fold,
 * and a tab strip at the top jumps to (and opens) a channel. The rules for
 * which cards start open live in `panel-state.mjs` — pure, and testable without
 * a DOM, which matters because the bundle test's React stub can only supply a
 * component's hook values, never observe what it initializes them to.
 */
import * as React from 'react';

import { SETTINGS_RPC_CHANNEL } from '../lib/settings/settings-rpc.js';
import { loadSettings, saveSettings, saveCredentials } from '../lib/settings/rpc-client.js';
import { snapshotToForm, buildConfigSave, buildCredentialSaves, CHANNEL_SECRET_FIELDS, CHANNEL_CONFIG_FIELDS, CHANNEL_DEFAULT_FIELDS, coerceConfigValue } from '../lib/settings/settings-model.js';
// Shared with the host, so the pane and the masking it displays can never
// disagree about which keys are confidential.
import { isMaskedSecret } from '../lib/settings/secret-disclosure.js';
import { LOCALES, tr, optionalText } from './locale.mjs';
import { initialOpenChannels, toggleInSet, isAdvanced } from './panel-state.mjs';

export const name = 'dsh-connect-settings';
export const inject = ['slots', 'connection', 'locale'];
export const NS = 'dsh-connect';

export const locale = LOCALES;

const h = React.createElement;

/** The channels the pane knows about, in the order the cards are rendered. */
const ALL_CHANNELS = Object.keys(CHANNEL_SECRET_FIELDS);

// Self-contained scoped stylesheet for the pane (injected once). The host's own
// settings panes use per-feature CSS modules we can't import into this separate
// bundle, so we ship our own consistent, theme-aware styles instead. Everything
// is scoped under `.dsh-connect-settings` so nothing leaks into the shell.
//
// Two things here are load-bearing rather than cosmetic:
//
// 1. The `box-sizing` reset. Neither this bundle nor the host shell ships a
//    global one, so under the default `content-box` a `.ds-input` with
//    `width:100%` is ~20px (padding + border) *wider* than the grid column it
//    sits in, and paints over the neighbouring column's text. That overflow is
//    what "文字跟窗口重叠" actually was.
// 2. The host's theme tokens, with our old hex values as fallbacks. The host
//    puts `--dsw-alias-*` on `body` / `body[data-ds-dark-theme]`, so inheriting
//    them follows the user's in-app theme. A `prefers-color-scheme` block — what
//    used to be here — ignores that choice entirely and repaints the pane black
//    on a light shell for anyone whose OS is dark. Do not bring it back.
const STYLE = `
.dsh-connect-settings,.dsh-connect-settings *,.dsh-connect-settings *::before,.dsh-connect-settings *::after{box-sizing:border-box}
.dsh-connect-settings{--ds-bg:var(--dsw-alias-bg-layer-3,#ffffff);--ds-bg-sub:var(--dsw-alias-bg-layer-1,#f6f7f9);--ds-text:var(--dsw-alias-label-primary,#1f2329);--ds-muted:var(--dsw-alias-label-tertiary,#646a73);--ds-border:var(--dsw-alias-border-l2,#e2e4e8);--ds-border-2:var(--dsw-alias-border-l3,#c8cbd0);--ds-accent:var(--dsw-alias-state-business-primary,#3b82f6);--ds-hover:var(--dsw-alias-interactive-bg-hover,#2631480f);display:flex;flex-direction:column;gap:12px;max-width:760px;color:var(--ds-text);font:13px/1.6 -apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
.dsh-connect-settings .ds-card{display:flex;flex-direction:column;gap:10px;border:1px solid var(--ds-border);border-radius:10px;background:var(--ds-bg);padding:12px 14px}
.dsh-connect-settings .ds-card-title{margin:0;font-size:13px;font-weight:600}
.dsh-connect-settings .ds-note{margin:0;font-size:11px;line-height:1.5;color:var(--ds-muted)}
.dsh-connect-settings .ds-tabs{display:flex;flex-wrap:wrap;gap:6px}
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
.dsh-connect-settings .ds-fields{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:10px 14px}
.dsh-connect-settings .ds-field{display:flex;flex-direction:column;gap:4px;min-width:0}
.dsh-connect-settings .ds-control{display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--ds-muted)}
.dsh-connect-settings .ds-control.ds-check-field{flex-direction:row;align-items:center;gap:6px}
.dsh-connect-settings .ds-hint{margin:0;font-size:11px;line-height:1.5;color:var(--ds-muted)}
.dsh-connect-settings .ds-preview{margin:0;font-size:11px;line-height:1.5;color:var(--ds-muted);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;word-break:break-all}
.dsh-connect-settings .ds-preview b{font-weight:500;font-family:inherit;opacity:.75}
.dsh-connect-settings .ds-check{flex:none;width:16px;height:16px;accent-color:var(--ds-accent)}
.dsh-connect-settings .ds-input{height:30px;width:100%;min-width:0;padding:0 9px;border:1px solid var(--ds-border-2);border-radius:6px;background:var(--ds-bg);color:var(--ds-text);font:inherit}
.dsh-connect-settings select.ds-input{cursor:pointer}
.dsh-connect-settings .ds-input:focus{outline:none;border-color:var(--ds-accent);box-shadow:0 0 0 2px color-mix(in srgb,var(--ds-accent) 25%,transparent)}
.dsh-connect-settings .ds-adv{display:flex;flex-direction:column;gap:8px}
.dsh-connect-settings .ds-advanced-toggle{align-self:flex-start;display:inline-flex;align-items:center;gap:6px;padding:3px 10px;border:1px dashed var(--ds-border-2);border-radius:99px;background:transparent;color:var(--ds-muted);font:inherit;font-size:11px;cursor:pointer}
.dsh-connect-settings .ds-advanced-toggle:hover{background:var(--ds-hover);color:var(--ds-text)}
.dsh-connect-settings .ds-footer{position:sticky;bottom:0;z-index:1;display:flex;align-items:center;gap:12px;margin:0 -14px -12px;padding:10px 14px;border-top:1px solid var(--ds-border);border-radius:0 0 9px 9px;background:var(--ds-bg)}
.dsh-connect-settings .ds-btn{height:32px;padding:0 18px;border:0;border-radius:6px;background:var(--dsw-alias-button-primary-fill,var(--ds-accent));color:var(--dsw-alias-label-primary-foreground,#ffffff);font:inherit;font-weight:500;cursor:pointer}
.dsh-connect-settings .ds-btn:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover,var(--ds-accent))}
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

// Render one non-secret config field: its control, then its explanation.
//
// Label and hint are looked up by *config key* (`f.<key>`), so a field added
// without its text shows a legible fallback (`field.label`) instead of a raw
// identifier — and the locale-coverage test fails, which is the real guard.
function renderConfigField(field, value, onChange, t) {
  const label = tr(t, `f.${field.key}`, field.label ?? field.key);
  const hint = optionalText(t, `f.${field.key}.hint`);
  let control;
  if (field.kind === 'boolean') {
    control = h('label', { className: 'ds-control ds-check-field' },
      h('input', { className: 'ds-check', type: 'checkbox', checked: !!value, onChange: (e) => onChange(e.target.checked) }),
      ' ' + label);
  } else if (field.kind === 'select') {
    control = h('label', { className: 'ds-control' }, label + ' ',
      h('select', { className: 'ds-input', value: value ?? '', onChange: (e) => onChange(e.target.value) },
        h('option', { value: '' }, tr(t, 'o.default', label)),
        ...(field.options ?? []).map((opt) => h('option', { key: opt, value: opt }, tr(t, `o.${opt}`, opt)))));
  } else if (field.kind === 'number') {
    control = h('label', { className: 'ds-control' }, label + ' ',
      h('input', { className: 'ds-input', type: 'number', value: value ?? '', onChange: (e) => onChange(e.target.value) }));
  } else {
    control = h('label', { className: 'ds-control' }, label + ' ',
      h('input', { className: 'ds-input', type: 'text', value: value ?? '', onChange: (e) => onChange(e.target.value) }));
  }
  return h('div', { className: 'ds-field', key: `cfg-${field.key}` },
    control,
    hint ? h('p', { className: 'ds-hint' }, hint) : null);
}

// Render one secret field: a write-only input, plus a read-only preview of the
// stored value so the user can confirm what they configured.
//
// The preview is plain text, never the input's `value`. The host already masked
// it, and seeding an input with a mask would let a save write the mask *back* as
// the credential. Keeping the input blank also keeps "empty" meaning "leave the
// stored value alone", which is what a password field is expected to do.
function renderSecretField(ch, field, form, onChange, t) {
  const preview = form.secretPreviews?.[ch]?.[field] ?? '';
  const hint = optionalText(t, `s.${ch}.${field}.hint`);
  return h('div', { className: 'ds-field', key: `sec-${ch}-${field}` },
    h('label', { className: 'ds-control' },
      tr(t, `s.${ch}.${field}`, field),
      h('input', {
        className: 'ds-input',
        // Confidential keys stay masked while typing; identifiers (appId,
        // clientId) don't, so a typo is visible before it is ever saved.
        type: isMaskedSecret(field) ? 'password' : 'text',
        autoComplete: 'off',
        placeholder: preview ? t('configured') : t('notConfigured'),
        value: form.secrets?.[ch]?.[field] ?? '',
        onChange: (e) => onChange(e.target.value),
      })),
    h('p', { className: 'ds-preview' },
      h('b', null, t('current')),
      preview === '' ? t('notConfigured') : preview),
    hint ? h('p', { className: 'ds-hint' }, hint) : null);
}

// One channel card: an enable checkbox, a header that folds the card, and — when
// open — its credentials and settings.
//
// A plain function rather than a child component, deliberately: the bundle test
// supplies hook values *positionally*, so every `useState` in the tree has to
// live in `ConnectSettingsTab` in a fixed order. Nothing in here may call a hook.
function renderChannel(ch, ctx) {
  const { form, creds, t, open, advOverride, setChannels, setField, setChannelConfig, toggleOpen, toggleAdvanced } = ctx;
  const name = tr(t, `channel.${ch}`, ch);
  const channelHint = optionalText(t, `channel.${ch}.hint`);
  const isOpen = open.has(ch);
  const advOpen = advOverride?.has(ch) ?? false;
  const configFields = CHANNEL_CONFIG_FIELDS[ch] ?? [];
  // The split is what keeps a common case on one screen: two credentials and the
  // behavioural switches, with the set-once fields one disclosure deeper.
  const common = configFields.filter((f) => !isAdvanced(ch, f.key));
  const advanced = configFields.filter((f) => isAdvanced(ch, f.key));

  const configField = (field) => renderConfigField(
    field,
    form.channelConfigs?.[ch]?.[field.key],
    (raw) => setChannelConfig(ch, field.key, raw),
    t,
  );

  return h('div', { className: 'ds-channel', key: ch, id: `ds-ch-${ch}` },
    // The checkbox sits beside the header button, not inside it: a button may not
    // contain another interactive element, and browsers disagree about what to do
    // when one does.
    h('div', { className: 'ds-channel-head' },
      h('label', { className: 'ds-enable' },
        h('input', {
          className: 'ds-check',
          type: 'checkbox',
          'aria-label': name,
          checked: form.channels.includes(ch),
          onChange: (e) => setChannels(ch, e.target.checked),
        })),
      h('button', {
        type: 'button',
        className: 'ds-channel-toggle',
        'aria-expanded': isOpen,
        // Only while the body exists: pointing at an id that is not in the
        // document is worse than not pointing at all.
        'aria-controls': isOpen ? `ds-ch-${ch}-body` : undefined,
        'aria-label': `${name} — ${isOpen ? t('collapse') : t('expand')}`,
        onClick: () => toggleOpen(ch),
      },
        h('span', { className: 'ds-channel-name' }, name),
        h('span', { className: 'ds-badge' }, creds[ch] ? t('reachable') : t('unreachable')),
        // Drawn in CSS, never a text node: the bundle test reads rendered text as
        // user-visible copy, and a `▾` here would be collected as a stray string.
        h('span', { className: 'ds-chevron' }))),
    // Collapsed means *not rendered*, not `display:none`. The inputs are
    // controlled from the parent's `form.secrets`, so folding a card cannot lose
    // an unsaved secret — keeping it mounted would buy nothing.
    isOpen ? h('div', { className: 'ds-channel-body', id: `ds-ch-${ch}-body` },
      channelHint ? h('p', { className: 'ds-note' }, channelHint) : null,
      h('div', { className: 'ds-fields' },
        ...CHANNEL_SECRET_FIELDS[ch].map((field) => renderSecretField(ch, field, form, (value) => setField(ch, field, value), t)),
        ...common.map(configField)),
      advanced.length === 0 ? null : h('div', { className: 'ds-adv' },
        h('button', {
          type: 'button',
          className: 'ds-advanced-toggle',
          'aria-expanded': advOpen,
          'aria-controls': advOpen ? `ds-ch-${ch}-adv` : undefined,
          onClick: () => toggleAdvanced(ch),
        },
          h('span', null, t('advanced')),
          h('span', { className: 'ds-chevron' })),
        advOpen ? h('div', { className: 'ds-fields', id: `ds-ch-${ch}-adv` }, ...advanced.map(configField)) : null),
    ) : null);
}

// Thin React renderer over the tested settings-model helpers.
export function ConnectSettingsTab({ rpcCall, t }) {
  const [form, setForm] = React.useState(null);
  const [status, setStatus] = React.useState('loading');
  const [creds, setCreds] = React.useState({});
  const [openOverride, setOpenOverride] = React.useState(null);
  const [advOverride, setAdvOverride] = React.useState(null);
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
      // The last snapshot in the chain wins: it is the one that reflects every
      // write this save performed. Re-seeding the form from it also drops the
      // typed secret values (their inputs are write-only by design) and picks up
      // the new presence flags.
      let snap = await saveSettings(rpc, buildConfigSave(form));
      for (const c of buildCredentialSaves(form)) snap = await saveCredentials(rpc, c.channel, c.values);
      setForm(snapshotToForm(snap));
      setCreds(snap.credentials ?? {});
      setStatus('saved');
    } catch { setStatus('error'); }
  };

  const setChannels = (ch, on) => {
    setForm((f) => ({ ...f, channels: on ? [...f.channels, ch] : f.channels.filter((x) => x !== ch) }));
    // Enabling a channel opens it, and only ever opens: the user just said they
    // care about this one. Ticking it back off leaves the fold alone rather than
    // snapping shut under the cursor.
    if (on && !open.has(ch)) setOpenOverride(new Set(open).add(ch));
  };
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

  // Which cards are open is *derived*, not stored: the first render happens
  // before the host's snapshot arrives, and the test stub cannot run effects, so
  // an effect here would be the only place the default could ever be set — and
  // it would never run. The override records only what the user has since done,
  // on top of that default (`toggleInSet(open, …)` rather than a bare toggle),
  // so opening DingTalk does not silently drop the enabled Feishu the user was
  // already looking at.
  const open = openOverride ?? initialOpenChannels(form.channels, ALL_CHANNELS);

  const toggleOpen = (ch) => setOpenOverride(toggleInSet(open, ch));
  // Advanced folds default to closed for every channel, so an empty set is the
  // derived default here and no counterpart to `initialOpenChannels` is needed.
  const toggleAdvanced = (ch) => setAdvOverride(toggleInSet(advOverride ?? new Set(), ch));
  const focusChannel = (ch) => {
    // A tab expands and scrolls, but never collapses: "show me Telegram" must not
    // close the channel the user is halfway through editing.
    if (!open.has(ch)) setOpenOverride(new Set(open).add(ch));
    if (typeof document === 'undefined' || !document.getElementById) return;
    // The header is rendered whether or not the card is open, so this resolves
    // before React has re-rendered, and lands in the same place either way.
    document.getElementById(`ds-ch-${ch}`)?.scrollIntoView?.({ block: 'nearest' });
  };

  return h('div', { className: 'dsh-connect-settings' },
    h('section', { className: 'ds-card' },
      h('h4', { className: 'ds-card-title' }, t('channels')),
      // Explains the masking before the user meets a truncated value and wonders
      // whether their stored secret is corrupt.
      h('p', { className: 'ds-note' }, t('previewNote')),
      // A tab strip, but not `role=tablist`: several channels can be open at
      // once, so there is no single "selected" tab to report. These are buttons
      // that open and jump to a channel, and `aria-expanded` says so honestly.
      h('nav', { className: 'ds-tabs', 'aria-label': t('tabsAria') },
        ...ALL_CHANNELS.map((ch) => h('button', {
          key: `tab-${ch}`,
          type: 'button',
          className: 'ds-tab',
          'aria-expanded': open.has(ch),
          'aria-controls': open.has(ch) ? `ds-ch-${ch}-body` : undefined,
          onClick: () => focusChannel(ch),
        },
          h('span', { className: 'ds-dot', 'data-on': form.channels.includes(ch) ? '1' : '0' }),
          tr(t, `channel.${ch}`, ch)))),
      // One card per built-in channel: enable toggle + cred badge + secret + config fields.
      ...ALL_CHANNELS.map((ch) => renderChannel(ch, {
        form, creds, t, open, advOverride,
        setChannels, setField, setChannelConfig, toggleOpen, toggleAdvanced,
      }))),
    h('section', { className: 'ds-card' },
      h('h4', { className: 'ds-card-title' }, t('defaults')),
      h('p', { className: 'ds-note' }, t('defaultsHint')),
      h('div', { className: 'ds-fields' },
        ...CHANNEL_DEFAULT_FIELDS.map((field) => renderConfigField(field, form.channelDefaults?.[field.key], (raw) => setDefault(field.key, raw), t)),
        // Only meaningful on the fallback plane: it names the file the pane
        // persists to. With the namespace live that path is not consulted (and
        // is not part of the section), so showing an editable field for it would
        // silently swallow edits.
        form.live ? null : h('div', { className: 'ds-field' },
          h('label', { className: 'ds-control' }, t('statePath'),
            h('input', { className: 'ds-input', value: form.settingsStatePath ?? '', onChange: (e) => setForm((f) => ({ ...f, settingsStatePath: e.target.value })) })),
          h('p', { className: 'ds-hint' }, t('statePathHint'))),
      ),
      h('div', { className: 'ds-status' }, form.live ? t('livePlane') : t('filePlane')),
      // Sticky to the bottom of the host's scrolling region, so Save stays in
      // reach however far the channel list has been unfolded.
      h('div', { className: 'ds-footer' },
        h('button', { className: 'ds-btn', type: 'button', onClick: onSave, disabled: status === 'saving' }, t('save')),
        // Rendering `status` directly leaks the raw state ids (`idle`, `saving`)
        // into the UI; every state has a locale entry instead.
        h('span', { className: 'ds-status' }, tr(t, `status.${status}`, status)),
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
