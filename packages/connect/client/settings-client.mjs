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
import { loadSettings, saveSettings, saveCredentials, callRpc } from '../lib/settings/rpc-client.js';
import { snapshotToForm, buildConfigSave, buildCredentialSaves, CHANNEL_SECRET_FIELDS, CHANNEL_CONFIG_FIELDS, CHANNEL_DEFAULT_FIELDS, coerceConfigValue } from '../lib/settings/settings-model.js';
// Shared with the host, so the pane and the masking it displays can never
// disagree about which keys are confidential.
import { isMaskedSecret } from '../lib/settings/secret-disclosure.js';
import { LOCALES, tr, optionalText } from './locale.mjs';
import { initialOpenChannels, toggleInSet, isAdvanced, snapshotIssues, onboardingIssues } from './panel-state.mjs';

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
//    sits in. That overflow is what "文字跟窗口重叠" actually was.
// 2. The host's theme tokens, with our old hex values as fallbacks. The host
//    puts `--dsw-alias-*` on `body` / `body[data-ds-dark-theme]`, so inheriting
//    them follows the user's in-app theme. A `prefers-color-scheme` block — what
//    used to be here — ignores that choice entirely and repaints the pane black
//    on a light shell for anyone whose OS is dark. Do not bring it back.
const STYLE = `
.dsh-connect-settings,.dsh-connect-settings *,.dsh-connect-settings *::before,.dsh-connect-settings *::after{box-sizing:border-box}
.dsh-connect-settings{--ds-bg:var(--dsw-alias-bg-layer-3,#ffffff);--ds-bg-sub:var(--dsw-alias-bg-layer-1,#f6f7f9);--ds-text:var(--dsw-alias-label-primary,#1f2329);--ds-muted:var(--dsw-alias-label-tertiary,#646a73);--ds-border:var(--dsw-alias-border-l2,#e2e4e8);--ds-border-2:var(--dsw-alias-border-l3,#c8cbd0);--ds-accent:var(--dsw-alias-state-business-primary,#3b82f6);--ds-hover:var(--dsw-alias-interactive-bg-hover,#2631480f);--ds-warn:var(--dsw-alias-state-error-primary,#b45309);display:flex;flex-direction:column;gap:12px;max-width:760px;color:var(--ds-text);font:13px/1.6 -apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
.dsh-connect-settings .ds-card{display:flex;flex-direction:column;gap:10px;border:1px solid var(--ds-border);border-radius:10px;background:var(--ds-bg);padding:12px 14px}
.dsh-connect-settings .ds-card-title{margin:0;font-size:13px;font-weight:600}
.dsh-connect-settings .ds-note{margin:0;font-size:11px;line-height:1.5;color:var(--ds-muted)}
.dsh-connect-settings .ds-tabs{position:sticky;top:0;z-index:2;display:flex;flex-wrap:wrap;gap:6px;padding:6px 0;background:var(--ds-bg);border-bottom:1px solid var(--ds-border)}
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
   out *three* columns of label-above-control fields — shorter, but each one
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
   The link gets word-break:break-all for the same reason .ds-preview does — a
   Feishu authorization URL is long, unbreakable, and would otherwise widen the
   card and reintroduce the horizontal overflow this pane already fixed once. */
.dsh-connect-settings .ds-onboard{display:flex;flex-direction:column;gap:8px;padding:10px;border:1px dashed var(--ds-border-2);border-radius:8px}
.dsh-connect-settings .ds-onboard-row{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.dsh-connect-settings .ds-onboard-btn{align-self:flex-start}
.dsh-connect-settings .ds-onboard a{color:var(--ds-accent);word-break:break-all}
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
  const { form, creds, unknownCreds, t, open, advOverride, setChannels, setField, setChannelConfig, toggleOpen, toggleAdvanced, onboarding, onOnboard, onOnboardCancel } = ctx;
  const name = tr(t, `channel.${ch}`, ch);
  const channelHint = optionalText(t, `channel.${ch}.hint`);
  const isOpen = open.has(ch);
  // Three-way, because "unknown" is a third state and not a shade of false: when
  // the credential store could not be *read*, the host sends `false` (the pane
  // needs something to render) *and* names the channel. Collapsing the two would
  // print 「未配置凭据」 and send the user to re-enter a secret that was never the
  // problem.
  const badCreds = unknownCreds.has(ch);
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
        h('span', { className: badCreds ? 'ds-badge ds-badge-warn' : 'ds-badge' },
          badCreds ? t('credentialUnknown') : creds[ch] ? t('reachable') : t('unreachable')),
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
      // Inside the card's body, after the credentials the flow would fill in:
      // the button belongs next to the fields it writes, and not behind the
      // advanced fold, since it is the one thing on this pane a first-time user
      // is looking for.
      renderOnboarding(ch, { t, onboarding, onOnboard, onOnboardCancel }),
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

// The official creation pages for the two channels that have no bot-creation
// API. Feishu is the one channel this pane can genuinely automate; Telegram only
// issues a bot inside a conversation with @BotFather, and DingTalk only inside
// its own console — so the honest thing to render for those two is the entrance
// plus a "paste what you get below" instruction, not a button that cannot work.
const MANUAL_CREATE_URL = {
  telegram: 'https://t.me/BotFather',
  dingtalk: 'https://open-dev.dingtalk.com/',
};

// How the pane watches a run it did not start. `start` answers as soon as the
// device-authorization link exists (usually under a second); the flow itself
// goes on living in the host process, so the pane polls until the phase is
// terminal. The ceiling is the link's own lifetime plus slack, so a run the user
// simply walks away from cannot leave a poll loop running forever.
const ONBOARD_POLL_MS = 1500;
const ONBOARD_POLL_LIMIT_MS = 16 * 60 * 1000;
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// The one-click creation block inside a channel card's body.
//
// Hook-free, like everything else under `renderChannel`: the bundle test feeds
// hook values positionally, so every `useState` in the tree lives in
// `ConnectSettingsTab`.
//
// No QR code is rendered here, and no QR library may be added. The link opens
// Feishu's own authorization page, which draws the QR itself — reimplementing
// that would be a second, worse copy of a page the user is about to look at
// anyway. The URL is plain selectable text for the same reason: it is the one
// part of this interaction that has to survive being copied by hand, since the
// page it points to may well be open on a different device.
function renderOnboarding(ch, ctx) {
  const { t, onboarding, onOnboard, onOnboardCancel } = ctx;
  const manual = MANUAL_CREATE_URL[ch];
  if (manual) {
    return h('div', { className: 'ds-onboard' },
      h('p', { className: 'ds-hint' }, tr(t, `onboard.manual.${ch}`, manual)),
      h('a', { href: manual, target: '_blank', rel: 'noreferrer noopener' }, manual));
  }
  if (ch !== 'feishu') return null;
  const busy = onboarding?.busy === true;
  const link = onboarding?.link;
  const pending = busy || onboarding?.phase === 'waiting';
  const label = busy && !link ? t('onboard.starting') : pending ? t('onboard.waiting') : t('onboard.create');
  const minutes = Math.max(1, Math.round((link?.expiresInSeconds ?? 0) / 60));
  return h('div', { className: 'ds-onboard' },
    h('p', { className: 'ds-hint' }, t('onboard.create.hint')),
    h('div', { className: 'ds-onboard-row' },
      h('button', {
        type: 'button',
        // Deliberately not a bare `ds-btn`: the bundle test finds the save button
        // as the first element whose className is exactly that, and a second one
        // would make which button it finds depend on render order.
        className: 'ds-btn ds-onboard-btn',
        disabled: pending,
        onClick: onOnboard,
      }, label),
      // A real cancel, not a UI gesture: the SDK's `registerApp` takes a signal,
      // so this stops the polling and genuinely invalidates the link.
      pending ? h('button', { type: 'button', className: 'ds-advanced-toggle', onClick: onOnboardCancel }, t('onboard.cancel')) : null),
    link ? h('p', { className: 'ds-hint ds-onboard-link' },
      h('span', null, t('onboard.link')),
      ' ',
      h('a', { href: link.url, target: '_blank', rel: 'noreferrer noopener' }, link.url),
      ' ',
      h('span', null, tr(t, 'onboard.linkExpiry', '').replace('{minutes}', String(minutes)))) : null);
}

// One line of the save bar's problem list — see `snapshotIssues` in
// `panel-state.mjs` for where these come from and why the two error lists are
// not merged.
function renderIssue(issue, t) {
  const channel = issue.channel === undefined
    ? null
    : h('span', null, tr(t, `channel.${issue.channel}`, issue.channel));
  if (issue.kind === 'credentialUnknown') {
    return h('li', { className: 'ds-issue', key: issue.key },
      channel,
      h('span', null, t('credentialUnknownHint')));
  }
  if (issue.kind === 'channelFailed') {
    return h('li', { className: 'ds-issue', key: issue.key },
      channel,
      h('span', null, t('channelFailed')),
      // The adapter's own message, verbatim. It is the only part that names the
      // credential or option that is actually wrong, so mapping it to a code the
      // locale would then have to guess at backwards would lose the answer.
      h('code', { className: 'ds-issue-reason' }, issue.reason));
  }
  // What the one-click flow actually did, one line per true fact — see
  // `onboardingIssues` in `panel-state.mjs`. The `appId` and the host's `reason`
  // are rendered verbatim: the reason in particular is the only part that names
  // what went wrong, and the pane has no way to map it to a code without
  // guessing backwards.
  if (issue.kind === 'onboarding') {
    return h('li', { className: 'ds-issue', key: issue.key },
      h('span', null, tr(t, `onboard.${issue.code}`, issue.code)),
      issue.appId === undefined ? null : h('code', { className: 'ds-issue-reason' }, issue.appId),
      issue.reason === undefined ? null : h('code', { className: 'ds-issue-reason' }, issue.reason));
  }
  // A host warning. `w.<code>`: a code shipped without its locale entry prints
  // the code — searchable, and visibly untranslated — rather than `undefined`.
  return h('li', { className: 'ds-issue', key: issue.key },
    h('span', null, tr(t, `w.${issue.code}`, issue.code)));
}

// Thin React renderer over the tested settings-model helpers.
export function ConnectSettingsTab({ rpcCall, t }) {
  const [form, setForm] = React.useState(null);
  const [status, setStatus] = React.useState('loading');
  const [creds, setCreds] = React.useState({});
  const [openOverride, setOpenOverride] = React.useState(null);
  const [advOverride, setAdvOverride] = React.useState(null);
  // Everything the last call had to report but could not express as a failure:
  // unreadable credential stores, channels the save left dead, and warnings. One
  // slot rather than three, because the pane renders them as one list — and
  // because the bundle test's stub supplies hook values positionally, so each
  // extra slot has to be threaded through every call site.
  const [notices, setNotices] = React.useState([]);
  // The last slot, appended after `notices` so `queued[0..5]` keep their
  // meanings for the bundle test, which supplies hook values positionally. The
  // one-click run's own state — the authorization link and the `waiting` phase —
  // has to survive the polls that follow it, so it cannot live in a local.
  const [onboarding, setOnboarding] = React.useState(null);
  const rpc = (endpoint, payload) => rpcCall(endpoint, payload);

  React.useEffect(() => {
    let alive = true;
    loadSettings(rpc).then((snap) => {
      if (!alive) return;
      setForm(snapshotToForm(snap));
      setCreds(snap.credentials ?? {});
      setNotices(snapshotIssues(snap));
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
      //
      // `warnings` is the one report that has to be *accumulated* across the
      // chain rather than read off the last snapshot: the error lists describe
      // the state of the world and the host re-derives them on every call, but a
      // warning is about the single call that raised it — a credential save whose
      // reconcile failed would otherwise be erased by the next channel's save.
      let snap = await saveSettings(rpc, buildConfigSave(form));
      const warnings = new Set(snap.warnings ?? []);
      for (const c of buildCredentialSaves(form)) {
        snap = await saveCredentials(rpc, c.channel, c.values);
        for (const code of snap.warnings ?? []) warnings.add(code);
      }
      setForm(snapshotToForm(snap));
      setCreds(snap.credentials ?? {});
      setNotices(snapshotIssues(snap, [...warnings]));
      setStatus('saved');
    } catch { setStatus('error'); }
  };

  // Start a one-click run, then watch it. The polling life is in this handler
  // rather than in a `useEffect` for two reasons: the test stub runs no effects,
  // and the run is bounded by a click — there is nothing to keep watching once
  // the flow is over or the user cancels.
  const onOnboard = async () => {
    setOnboarding({ busy: true });
    try {
      setOnboarding(await callRpc(rpc, 'onboarding.start', { channel: 'feishu' }));
      // Query first, then sleep: a run that finished before the pane ever polled
      // (or a host that answers without a phase at all) returns here without
      // waiting a tick.
      const startedAt = Date.now();
      for (;;) {
        const now = await callRpc(rpc, 'onboarding.status', {});
        setOnboarding(now);
        if (now?.phase !== 'waiting') break;
        if (Date.now() - startedAt > ONBOARD_POLL_LIMIT_MS) break;
        await sleep(ONBOARD_POLL_MS);
      }
    } catch (error) {
      setOnboarding({ phase: 'failed', outcome: { created: false, reason: error?.message ?? String(error) } });
    } finally {
      // Re-read rather than trust the outcome: the host deliberately keeps the
      // reconcile failure out of the outcome, so the reason a saved credential
      // did not come up exists only in the fresh snapshot's `channelErrors`.
      try {
        const snap = await loadSettings(rpc);
        setForm(snapshotToForm(snap));
        setCreds(snap.credentials ?? {});
        setNotices(snapshotIssues(snap));
      } catch { /* the outcome lines still say what happened */ }
    }
  };
  const onOnboardCancel = async () => {
    try { setOnboarding(await callRpc(rpc, 'onboarding.cancel', {})); } catch { /* the poll notices on its own */ }
  };

  const setChannels = (ch, on) => {
    setForm((f) => ({ ...f, channels: on ? [...f.channels, ch] : f.channels.filter((x) => x !== ch) }));
    // Enabling a channel opens it, and only ever opens: the user just said they
    // care about this one.
    //
    // Recording the fold *either way* is what keeps the card from vanishing
    // under the cursor. Until the user touches an enable box, the open set is
    // derived on every render from the enabled list — so unticking Feishu drops
    // it from `form.channels`, the derived default is recomputed without it, and
    // the card collapses exactly as the user is looking at it. Writing the
    // current fold into the override first freezes it, so an untick closes
    // nothing.
    setOpenOverride(on && !open.has(ch) ? new Set(open).add(ch) : new Set(open));
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
  // Just the channels whose credential state is unknown, for the badge above —
  // derived rather than stored so the badge and the list can never disagree.
  const unknownCreds = new Set(
    notices.filter((n) => n.kind === 'credentialUnknown').map((n) => n.channel),
  );
  // The one-click run's report is *derived* here rather than pushed into
  // `notices`: a later save replaces that list wholesale (the host re-derives
  // the state of the world on every call), which would erase the only record of
  // what the creation flow did. Its lines therefore sit alongside the snapshot's,
  // not inside them, and they persist until the user acts again.
  const issues = [...notices, ...onboardingIssues(onboarding?.outcome)];

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
    // A tab strip, but not `role=tablist`: several channels can be open at
    // once, so there is no single "selected" tab to report. These are buttons
    // that open and jump to a channel, and `aria-expanded` says so honestly.
    //
    // A direct child of the root, and not inside the channels card where it
    // used to live: `position:sticky` pins to the nearest scrollport only while
    // the element's containing block is the scrolled box. Nested in a card it
    // could never leave that card, so the strip scrolled away with the content
    // — the same reason the footer below sits here. `top:0` lines up with the
    // scroller's edge because the host's own scroller has no top padding.
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
    h('section', { className: 'ds-card' },
      h('h4', { className: 'ds-card-title' }, t('channels')),
      // Explains the masking before the user meets a truncated value and wonders
      // whether their stored secret is corrupt.
      h('p', { className: 'ds-note' }, t('previewNote')),
      // One card per built-in channel: enable toggle + cred badge + secret + config fields.
      ...ALL_CHANNELS.map((ch) => renderChannel(ch, {
        form, creds, unknownCreds, t, open, advOverride,
        setChannels, setField, setChannelConfig, toggleOpen, toggleAdvanced,
        onboarding, onOnboard, onOnboardCancel,
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
    ),
    // Last child of the root, not of a card: `position:sticky` pins to the
    // nearest scrollport only while its containing block is the scrolled box.
    // Nested in the defaults card it could never move outside that card, so it
    // pinned to nothing and Save scrolled away with the channel list.
    h('div', { className: 'ds-footer' },
      // In the save bar rather than beside the channel it concerns: these are
      // answers to *this* save, and the bar is the one part of the pane that is
      // always on screen. A channel card can be folded, or scrolled past, and
      // 「已保存」 next to nothing else is the whole complaint.
      issues.length === 0 ? null : h('ul', { className: 'ds-issues' }, ...issues.map((issue) => renderIssue(issue, t))),
      h('button', { className: 'ds-btn', type: 'button', onClick: onSave, disabled: status === 'saving' }, t('save')),
      // Rendering `status` directly leaks the raw state ids (`idle`, `saving`)
      // into the UI; every state has a locale entry instead.
      h('span', { className: 'ds-status' }, tr(t, `status.${status}`, status)),
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
