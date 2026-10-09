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
import { snapshotToForm, buildConfigSave, buildCredentialSaves, CHANNEL_SECRET_FIELDS, CHANNEL_CONFIG_FIELDS, CHANNEL_DEFAULT_FIELDS, GENERAL_FIELD_GROUPS, GENERAL_FIELDS, coerceConfigValue } from '../lib/settings/settings-model.js';
// Shared with the host, so the pane and the masking it displays can never
// disagree about which keys are confidential.
import { isMaskedSecret } from '../lib/settings/secret-disclosure.js';
import { LOCALES, tr, optionalText } from './locale.mjs';
import { initialOpenChannels, toggleInSet, isAdvanced, snapshotIssues, onboardingIssues, PANE_VIEWS, DEFAULT_VIEW } from './panel-state.mjs';

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
.dsh-connect-settings{--ds-bg:var(--dsw-alias-bg-layer-3,#ffffff);--ds-bg-sub:var(--dsw-alias-bg-layer-1,#f6f7f9);--ds-text:var(--dsw-alias-label-primary,#1f2329);--ds-muted:var(--dsw-alias-label-tertiary,#646a73);--ds-border:var(--dsw-alias-border-l2,#e2e4e8);--ds-border-2:var(--dsw-alias-border-l3,#c8cbd0);--ds-accent:var(--dsw-alias-state-business-primary,#3b82f6);--ds-hover:var(--dsw-alias-interactive-bg-hover,#2631480f);--ds-warn:var(--dsw-alias-state-error-primary,#b45309);--ds-ok:var(--dsw-alias-state-success-primary,#0f7b3f);--ds-nav-h:39px;display:flex;flex-direction:column;gap:12px;max-width:760px;color:var(--ds-text);font:13px/1.6 -apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
.dsh-connect-settings .ds-card{display:flex;flex-direction:column;gap:10px;border:1px solid var(--ds-border);border-radius:10px;background:var(--ds-bg);padding:12px 14px}
.dsh-connect-settings .ds-card-title{margin:0;font-size:13px;font-weight:600}
.dsh-connect-settings .ds-note{margin:0;font-size:11px;line-height:1.5;color:var(--ds-muted)}
/* The primary navigation, and the reason the channel tab strip below pins to
   var(--ds-nav-h) rather than 0. Both strips are sticky, and a control the user
   asked to keep on screen must not slide *under* another one — with both at
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
/* A list field (workspaces/allowUsers/allowChats) is a textarea, one entry per
   line. .ds-input fixes a 30px height that a textarea cannot use, so this rule
   overrides both the height and the vertical padding. */
.dsh-connect-settings .ds-list{min-height:60px;height:auto;padding:6px 9px;line-height:1.5;resize:vertical}
/* The read-only model row — text, never a control. It is a value this pane
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
.dsh-connect-settings .ds-badge.ds-badge-ok{border-color:var(--ds-ok,#0f7b3f);color:var(--ds-ok,#0f7b3f)}
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
// Label and hint are looked up by *config key* (`f.<key>`, or `g.<key>` in the
// general view), so a field added without its text shows a legible fallback
// (`field.label`) instead of a raw identifier — and the locale-coverage test
// fails, which is the real guard. The namespace is a parameter rather than a
// second function because every branch below (control shape, hint, `o.<value>`
// options) is identical between the two views; only the wording differs.
//
// `options.note` renders a paragraph *above* the control, which is where a
// provenance note has to be: reading the caveat after typing into the field is
// reading it too late.
function renderConfigField(field, value, onChange, t, options = {}) {
  const ns = options.ns ?? 'f';
  const label = tr(t, `${ns}.${field.key}`, field.label ?? field.key);
  const hint = optionalText(t, `${ns}.${field.key}.hint`);
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
  } else if (field.kind === 'list') {
    // A `list` field is a `string[]` edited as lines of text. `Array.isArray` is
    // not defensive padding: the value arrives from a snapshot the host built,
    // and a malformed one must render an empty box rather than the string
    // "undefined" glued into a textarea.
    control = h('label', { className: 'ds-control' }, label + ' ',
      h('textarea', { className: 'ds-input ds-list', value: Array.isArray(value) ? value.join('\n') : '', onChange: (e) => onChange(e.target.value) }));
  } else {
    control = h('label', { className: 'ds-control' }, label + ' ',
      h('input', { className: 'ds-input', type: 'text', value: value ?? '', onChange: (e) => onChange(e.target.value) }));
  }
  return h('div', { className: 'ds-field', key: `cfg-${field.key}` },
    options.note ? h('p', { className: 'ds-note' }, options.note) : null,
    control,
    hint ? h('p', { className: 'ds-hint' }, hint) : null);
}

// Render one secret field.
//
// The stored value is shown **once**, and where it goes depends on whether the
// host will hand the real value back:
//
// - An **identifier** (`appId`, `clientId` — `disclosure === 'full'`) comes back
//   verbatim, so it is seeded straight into the input. That is the value the user
//   needs to compare against the vendor console, and a blank box plus a separate
//   "current value" line made them read the same thing in two places.
// - A **confidential key** (`appSecret`, `botToken` — `disclosure === 'mask'`)
//   comes back already masked by the host, and is NEVER seeded into the input: a
//   save would write the mask back as the credential and silently destroy it.
//   Its input stays empty and the masked value rides in the placeholder, so the
//   user still sees something to confirm against — just not in an editable box
//   that would corrupt it if they pressed save.
//
// Either way the separate `当前值` preview line is gone: it duplicated what is now
// in the field itself.
function renderSecretField(ch, field, form, onChange, t) {
  const preview = form.secretPreviews?.[ch]?.[field] ?? '';
  const masked = isMaskedSecret(field);
  const hint = optionalText(t, `s.${ch}.${field}.hint`);
  // Seeding is what makes the value visible in the box; it is allowed only where
  // the host returned the real value rather than a mask.
  const seeded = masked ? '' : preview;
  return h('div', { className: 'ds-field', key: `sec-${ch}-${field}` },
    h('label', { className: 'ds-control' },
      tr(t, `s.${ch}.${field}`, field),
      h('input', {
        className: 'ds-input',
        // Confidential keys stay masked while typing; identifiers (appId,
        // clientId) don't, so a typo is visible before it is ever saved.
        type: masked ? 'password' : 'text',
        autoComplete: 'off',
        // For an identifier this is redundant while a value exists (the box
        // already shows it) and only useful when unset; for a key it is the sole
        // way the masked value is displayed.
        placeholder: preview ? (masked ? preview : t('configured')) : t('notConfigured'),
        value: form.secrets?.[ch]?.[field] ?? seeded,
        onChange: (e) => onChange(e.target.value),
      })),
    // Written for every secret field, because the box now holds a value the user
    // can overwrite — "setting this replaces what is stored" has to be said where
    // the typing happens, not only in a hint about the vendor console. It is also
    // the only place the masked value is named for a confidential key, whose box
    // is deliberately left empty.
    h('p', { className: 'ds-hint' }, masked && preview ? `${t('replaceHint')} ${t('currentMasked')}${preview}` : t('replaceHint')),
    hint ? h('p', { className: 'ds-hint' }, hint) : null);
}

// One channel card: an enable checkbox, a header that folds the card, and — when
// open — its credentials and settings.
//
// A plain function rather than a child component, deliberately: the bundle test
// supplies hook values *positionally*, so every `useState` in the tree has to
// live in `ConnectSettingsTab` in a fixed order. Nothing in here may call a hook.
/**
 * The access badge's class: which states get a colour, and which do not.
 *
 * Only the two ends are coloured. `connected`/`running` earn the success border
 * so a working channel reads as working at a glance — that glance is the entire
 * reason this badge exists — and `failed` keeps the warn border the credentials
 * badge already uses for a bad state. The middle states stay default-coloured
 * on purpose: 「连接中」/「重连中」 are the SDK retrying on its own and are not yet
 * a problem to draw attention to, and 「未启用」/「未运行」 are the user's own
 * doing. Painting those red would make an ordinary disabled channel look broken.
 */
function connectionBadgeClass(state) {
  if (state === 'failed') return 'ds-badge ds-badge-warn';
  if (state === 'connected' || state === 'running') return 'ds-badge ds-badge-ok';
  return 'ds-badge';
}

/**
 * The badge's text for one status, resolving the one state that carries data.
 *
 * `reconnecting` has two keys: the bare word, and `cs.reconnecting.n` with a
 * `{n}` placeholder substituted here. The substitution lives at the call site
 * rather than in the locale because `t()` is a plain key lookup with no
 * formatting, and it is deliberately not done by string-splicing a translated
 * sentence — an English 「Reconnecting (attempt 3)」 and a Chinese 「重连中（第 3 次）」
 * put the number in different places, which is exactly what a placeholder is
 * for. The locale test asserts `{n}` survives in both languages, so a
 * translation that drops it fails the suite instead of silently rendering a
 * sentence with no count in it.
 */
function connectionStatusLabel(status, t) {
  const state = status.state;
  const attempts = status.attempts ?? 0;
  if (state === 'reconnecting' && attempts > 0) {
    return tr(t, 'cs.reconnecting.n', t('cs.reconnecting')).replace('{n}', String(attempts));
  }
  // An unrecognised state falls back to the host's own token rather than to a
  // friendly word: the client is served by the host it is talking to, so this
  // can only be a version skew, and naming the state we do not know is the
  // honest report. Claiming 「运行中」 here would invent a state of health.
  return tr(t, `cs.${state}`, state);
}

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
  // The access state, when the host reports one. Absent means *the host cannot
  // say* — not "unknown channel" — so no badge is drawn at all. A 「状态未知」
  // placeholder here would be a claim, and the wrong one: it would read as
  // something wrong with this channel rather than with the host that has no
  // probe. The credentials badge beside it already covers "we cannot tell" for
  // the store, in the one place that is true.
  const connStatus = form.channelStatus?.[ch];
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
        // The second badge, and a second badge rather than a rewrite of the
        // first because the two answer different questions: the one above is
        // about the store, this one is about the wire. A channel with perfect
        // credentials and a socket that keeps dropping is 「已配置凭据」+
        // 「重连中」, and one badge would have to call that working. Neither may
        // absorb the other — a 「未配置凭据」 channel that is nonetheless running
        // (secrets injected at boot from elsewhere) is just as real.
        connStatus === undefined ? null : h('span', { className: connectionBadgeClass(connStatus.state) },
          connectionStatusLabel(connStatus, t)),
        // Drawn in CSS, never a text node: the bundle test reads rendered text as
        // user-visible copy, and a `▾` here would be collected as a stray string.
        h('span', { className: 'ds-chevron' }))),
    // Collapsed means *not rendered*, not `display:none`. The inputs are
    // controlled from the parent's `form.secrets`, so folding a card cannot lose
    // an unsaved secret — keeping it mounted would buy nothing.
    isOpen ? h('div', { className: 'ds-channel-body', id: `ds-ch-${ch}-body` },
      channelHint ? h('p', { className: 'ds-note' }, channelHint) : null,
      // First in the body, *above* the credential fields, because of the
      // complaint that started this: a user works through every field by hand
      // and only then discovers the button that would have filled them all in.
      // DOM order is visual order — moving this below the fields again undoes
      // the fix. (For telegram and dingtalk the same reasoning holds in
      // reverse: their text says "paste what you got below", so the text has to
      // come before the fields it points at.)
      renderOnboarding(ch, { t, onboarding, onOnboard, onOnboardCancel }),
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

// How often the channel cards re-read their access state while the pane is open.
// Five seconds is the user's own number, chosen against the two ends that
// matter: a reconnect cycle on Feishu's websocket is a handful of seconds, so a
// slower tick would show 「已连接」 for most of an outage, and a faster one would
// poll a socket state that cannot change materially faster than this.
const CHANNEL_STATUS_POLL_MS = 5000;

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
  // A save whose write did not land. One line per half, because the two halves
  // are independent documents and the pane attempts both: seeing only 「保存失败」
  // is what left a user unable to tell a secret that was never stored from one
  // that was stored and refused by Feishu. The reason is the host's code (an
  // `RpcError.code`), rendered verbatim for the same reason `channelFailed`
  // renders its adapter message — it is the only part that distinguishes a
  // refused write from a dropped connection.
  if (issue.kind === 'saveFailed') {
    return h('li', { className: 'ds-issue', key: issue.key },
      channel,
      h('span', null, t(issue.code === 'settingsSaveFailed' ? 'saveFailedSettings' : 'saveFailedCredentials')),
      issue.reason ? h('code', { className: 'ds-issue-reason' }, issue.reason) : null);
  }
  // A host warning. `w.<code>`: a code shipped without its locale entry prints
  // the code — searchable, and visibly untranslated — rather than `undefined`.
  return h('li', { className: 'ds-issue', key: issue.key },
    h('span', null, tr(t, `w.${issue.code}`, issue.code)));
}

// Which general group the read-only model row sits in. Named rather than
// implied by position: the row lives in the last card today, and reordering
// `GENERAL_FIELD_GROUPS` must not silently drop it into an unrelated group.
const MODEL_GROUP = 'g.group.agent';

// The DSH-owned default model, as a row this pane can show but not edit.
//
// **Deliberately read-only, and not for lack of a write path.** The host does
// expose `saveSelection()` and it does write — `/model` and `/reasoning` in chat
// go through it — so wiring this to an input would be a two-line change. It is
// not wired on purpose: that selection belongs to DSH and is shared with every
// other session in the profile, so a settings card that quietly repoints the
// user's other conversations is not a settings card. Read it, and send the user
// to DSH to change it. Do not "finish" this by adding a write path.
function renderModelRow(t, agentModel) {
  return h('div', { className: 'ds-field', key: 'cfg-agentModel' },
    h('label', { className: 'ds-control' }, tr(t, 'g.model', 'Default model')),
    // Plain text, never an input: it must not look like something to type into.
    h('p', { className: 'ds-readonly' }, `${agentModel.provider} / ${agentModel.model}`),
    h('p', { className: 'ds-note' }, tr(t, 'g.model.note', '')));
}

// One card of the general view: a group title and its fields.
//
// `renderConfigField` is reused with `ns: 'g'` rather than reimplemented — the
// controls, the `o.<value>` option labels and the hint lookup are identical in
// both views, and a second copy would be a second thing to keep in step.
function renderGeneralCard(group, ctx) {
  const { form, t, setGeneral } = ctx;
  const overridden = new Set(form.sharedOverrideKeys ?? []);
  return h('section', { className: 'ds-card', key: group.title },
    h('h4', { className: 'ds-card-title' }, tr(t, group.title, group.title)),
    h('div', { className: 'ds-fields' },
      ...group.fields.map((field) => renderConfigField(
        field,
        form.general?.[field.key],
        (raw) => setGeneral(field.key, raw),
        t,
        {
          ns: 'g',
          // Shown only where the shared config really does override the profile
          // value. A blanket caveat would be false on every row it does not
          // apply to, and a warning that is usually wrong is one the user learns
          // to scroll past. `workspaces` is absent from this list on purpose:
          // the shared config *merges* there instead of overriding, so an edit
          // genuinely does take effect — its hint says as much instead.
          note: overridden.has(field.key) ? tr(t, 'g.sharedOverride', '') : undefined,
        })),
      // Only on the agent card, and only when the host could read a selection at
      // all: an empty read-only row would say "there is no model", which is a
      // different and false statement from "the pane could not read one".
      group.title === MODEL_GROUP && form.agentModel ? renderModelRow(t, form.agentModel) : null));
}

// The 通用设置 view: one card per group, in `GENERAL_FIELD_GROUPS` order.
function renderGeneralView(ctx) {
  return GENERAL_FIELD_GROUPS.map((group) => renderGeneralCard(group, ctx));
}

/**
 * Why a save failed, in the one form this pane may display: a code.
 *
 * On the host path it is always a public code — `settings-rpc.ts` deliberately
 * replaces any unrecognised host error with `settings-failed` and drops the raw
 * message, precisely so a failure cannot carry plugin internals (or a submitted
 * payload) back into the UI. A transport failure never reached the host at all,
 * so its message names no value we sent. Either way it is short, searchable, and
 * the only thing that tells 「宿主拒绝了这次写入」 apart from 「连接断了」.
 */
function rpcReason(error) {
  const reason = error?.code ?? error?.message ?? String(error);
  return typeof reason === 'string' && reason.length > 0 ? reason : undefined;
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
  // The last slot again, appended after `onboarding` so `queued[0..6]` keep
  // their meanings for the bundle test, which supplies hook values positionally.
  // `null` means "the user has not chosen a view", and the view is then derived
  // from `DEFAULT_VIEW` on every render — the stub runs no effects, so a default
  // written into state from an effect would never be set at all (the same
  // reason `openOverride` starts null).
  const [viewOverride, setViewOverride] = React.useState(null);
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

    // Access state is the one thing on this page that changes with nobody
    // touching anything: a socket drops, the SDK retries, an adapter dies on a
    // reconcile. Without this the badge would be a reading taken whenever the
    // pane happened to open, which for the question the badge exists to answer
    // is the one answer certain to be stale by the time it matters.
    //
    // Only `channelStatus` is merged, and that is the whole discipline of this
    // loop. Every other field in the snapshot has an owner on this page
    // already — the inputs hold what the user is part-way through typing, and
    // `notices` holds the line the last save just raised — so a poll that
    // re-seeded the form would quietly delete unsaved edits every five seconds,
    // and one that re-seeded the notices would erase a 保存失败 the user is
    // reading. Status is the lone field with no editor, hence the only one that
    // is safe to overwrite.
    const timer = setInterval(() => {
      // A hidden tab is not being read; the poll would only cost the host an
      // adapter probe per channel per tick for nobody.
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      loadSettings(rpc).then((snap) => {
        if (!alive || snap.channelStatus === undefined) return;
        setForm((prev) => (prev === null ? prev : { ...prev, channelStatus: { ...snap.channelStatus } }));
      }).catch(() => {
        // A dropped poll is not something to report: the next tick is five
        // seconds away and the pane still shows the last state it saw.
      });
    }, CHANNEL_STATUS_POLL_MS);
    return () => { alive = false; clearInterval(timer); };
  }, [rpcCall]);

  const onSave = async () => {
    if (!form) return;
    setStatus('saving');
    // A save is two writes to two documents — the config section and the
    // credential store — and they are attempted independently, each reporting its
    // own outcome. One try/catch around the pair is how release 1.0.3 discarded
    // what the user had typed: `settings.save` threw, the catch jumped straight
    // to the error status, and the `credentials.save` loop below it never ran at
    // all. The pane then said only 「保存失败」, over a Feishu channel that stayed
    // 未设置, with nothing on screen to say whether the appId/appSecret had been
    // stored and rejected or never written in the first place.
    //
    // The last snapshot in the chain wins: it is the one that reflects every
    // write this save performed. Re-seeding the form from it also drops the
    // typed secret values (their inputs are write-only by design) and picks up
    // the new presence flags. That re-seed happens only when *both* halves
    // landed: a snapshot taken after a failed config write still holds the
    // host's old config, so seeding from it would replace everything the user
    // typed with the state they were trying to change — losing their input a
    // second time, now silently.
    //
    // `warnings` is the one report that has to be *accumulated* across the
    // chain rather than read off the last snapshot: the error lists describe
    // the state of the world and the host re-derives them on every call, but a
    // warning is about the single call that raised it — a credential save whose
    // reconcile failed would otherwise be erased by the next channel's save.
    const failures = [];
    let snap;
    try {
      snap = await saveSettings(rpc, buildConfigSave(form));
    } catch (error) {
      failures.push({ kind: 'saveFailed', code: 'settingsSaveFailed', reason: rpcReason(error), key: 'saveFailed:settings' });
    }
    const warnings = new Set(snap?.warnings ?? []);
    for (const c of buildCredentialSaves(form)) {
      try {
        snap = await saveCredentials(rpc, c.channel, c.values);
      } catch (error) {
        failures.push({ kind: 'saveFailed', code: 'credentialsSaveFailed', channel: c.channel, reason: rpcReason(error), key: `saveFailed:credentials:${c.channel}` });
        continue;
      }
      for (const code of snap.warnings ?? []) warnings.add(code);
    }
    if (snap !== undefined && failures.length === 0) setForm(snapshotToForm(snap));
    if (snap !== undefined) setCreds(snap.credentials ?? {});
    // A snapshot replaces the notices wholesale — it is the current state of the
    // world. When the very first write failed there is no snapshot at all, so
    // the previous list survives it; either way this attempt's own failures are
    // appended last, and the previous attempt's are dropped so that retrying
    // replaces a stale line rather than stacking a second copy of it.
    const carried = (snap === undefined ? notices : snapshotIssues(snap, [...warnings]))
      .filter((n) => n.kind !== 'saveFailed');
    // A credential write that landed when the config write did not still shows:
    // `creds` is refreshed from that snapshot, so the channel's own
    // 凭据状态 badge flips to stored while this line says the settings were not.
    // (Not the 接入状态 badge beside it — that one follows the transport probe
    // and this code must not touch it.)
    setNotices([...carried, ...failures]);
    setStatus(failures.length > 0 ? 'error' : 'saved');
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
  // Same shape as `setChannelConfig` against `GENERAL_FIELDS`. The descriptor
  // lookup is what makes an emptied box mean *deleted key* rather than a
  // stored empty string or a stored `[]`: `coerceConfigValue` answers
  // `undefined` for an empty input of every kind, and the key is dropped. For
  // the three `list` fields that is the whole point — clearing the box must
  // return the key to its inherited value, not pin it to an empty list.
  const setGeneral = (key, raw) => setForm((f) => {
    const descriptor = GENERAL_FIELDS.find((x) => x.key === key);
    const value = coerceConfigValue(descriptor?.kind ?? 'text', raw);
    const general = { ...(f.general ?? {}) };
    if (value === undefined) delete general[key]; else general[key] = value;
    return { ...f, general };
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
  // Which of the two views is showing — derived, exactly like `open` above and
  // for the same reason: a default can only be applied on the first render, and
  // the test stub runs no effects, so one written from an effect would never be
  // set at all.
  //
  // `DEFAULT_VIEW` is 机器人渠道 and *not* the first entry of `PANE_VIEWS`. That
  // is deliberate, not a slip — see the note on it in `panel-state.mjs`: the
  // navigation reads 通用设置 → 机器人渠道, but the pane opens on the channel view
  // so the one-click creation button is zero clicks away.
  const view = viewOverride ?? DEFAULT_VIEW;

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
    h('nav', { className: 'ds-nav', 'aria-label': t('navAria') },
      ...PANE_VIEWS.map((name) => h('button', {
        key: `view-${name}`,
        type: 'button',
        className: 'ds-nav-item',
        'aria-current': view === name ? 'page' : undefined,
        onClick: () => setViewOverride(name),
      }, tr(t, `view.${name}`, name)))),
    // The two views are mutually exclusive: the hidden one is *not rendered*,
    // not hidden in CSS. Both are tall, and mounting both would put every
    // control of both in the DOM at once for no benefit.
    view === 'general'
      ? renderGeneralView({ form, t, setGeneral })
      : [
        // A tab strip, but not `role=tablist`: several channels can be open at
        // once, so there is no single "selected" tab to report. These are
        // buttons that open and jump to a channel, and `aria-expanded` says so.
        //
        // A direct child of the root, and not inside the channels card where it
        // used to live: `position:sticky` pins to the nearest scrollport only
        // while the element's containing block is the scrolled box. Nested in a
        // card it could never leave that card, so the strip scrolled away with
        // the content — the same reason the footer below sits here.
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
          // Explains the masking before the user meets a truncated value and
          // wonders whether their stored secret is corrupt.
          h('p', { className: 'ds-note' }, t('previewNote')),
          // One card per built-in channel: enable + cred badge + secrets + config.
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
            // persists to. With the namespace live that path is not consulted
            // (and is not part of the section), so showing an editable field for
            // it would silently swallow edits.
            form.live ? null : h('div', { className: 'ds-field' },
              h('label', { className: 'ds-control' }, t('statePath'),
                h('input', { className: 'ds-input', value: form.settingsStatePath ?? '', onChange: (e) => setForm((f) => ({ ...f, settingsStatePath: e.target.value })) })),
              h('p', { className: 'ds-hint' }, t('statePathHint'))),
          ),
          h('div', { className: 'ds-status' }, form.live ? t('livePlane') : t('filePlane')),
        ),
      ],
    // Last child of the root, not of a card: `position:sticky` pins to the
    // nearest scrollport only while its containing block is the scrolled box.
    // Nested in the defaults card it could never move outside that card, so it
    // pinned to nothing and Save scrolled away with the channel list.
    //
    // Shared by both views, deliberately: 通用设置 has to be saveable too, and
    // it is the same save — one payload, one button, whichever view is open.
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
