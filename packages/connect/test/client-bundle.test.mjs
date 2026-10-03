import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { snapshotToForm, CHANNEL_SECRET_FIELDS, CHANNEL_CONFIG_FIELDS, CHANNEL_DEFAULT_FIELDS } from "../lib/settings/settings-model.js";
import { isMaskedSecret } from "../lib/settings/secret-disclosure.js";
import { snapshotIssues } from "../client/panel-state.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const BUNDLE = path.join(here, "..", "client", "client.js");

/**
 * Load the built `client/client.js` the way the DSH web shell does — through
 * `window.__ModuleLoader__.load` — and hand back the registered factory.
 *
 * This is a *bundle* test, not a source test: it fails if `settings-client.mjs`
 * was edited without rebuilding, which is the mistake that ships a pane whose
 * source and artifact disagree.
 */
function loadBundle() {
  const source = fs.readFileSync(BUNDLE, "utf8");
  let registered;
  const window = { __ModuleLoader__: { load: (mod) => { registered = mod; } } };
  new Function("window", source)(window);
  assert.ok(registered, "client.js never called window.__ModuleLoader__.load");
  return registered;
}

/**
 * The host's `t()` semantics, reproduced: `lookup(ns, key, chain) ?? key`, where
 * `lookup` walks the **fallback chain**. That is why a key present in `en` but
 * missing from `zh` renders English into a Chinese pane with no error anywhere.
 */
function hostTranslate(table, lang) {
  const chain = lang === "zh" ? ["zh", "en"] : ["en", "zh"];
  return (key) => {
    for (const l of chain) {
      const value = table[l]?.[key];
      if (value !== undefined) return value;
    }
    return key;
  };
}

/** A minimal React stand-in: enough to render this one component in Node. */
function reactStub(queued) {
  let hook = 0;
  return {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    // The component reads a loaded form, a status and a credentials map, in that
    // order. A stub cannot run effects, so the values a real render would have
    // settled on are supplied up front instead.
    //
    // The setter writes back into `queued` rather than being a no-op, so a test
    // can fire an event handler, render again, and see what the pane did. Some
    // rules are about a *sequence* — what a click does to a fold that was
    // derived from the form until that moment — and a single render cannot show
    // them. Updating `queued` is the whole of React's job here: the hook order
    // is positional and re-running the component re-reads it.
    useState: () => {
      const index = hook++;
      const set = (value) => { queued[index] = typeof value === "function" ? value(queued[index]) : value; };
      return [queued[index], set];
    },
    useEffect: () => {},
    // Hook positions are per *render*: without this the second draw would start
    // at the next free slot and read `undefined` for the form.
    resetHooks: () => { hook = 0; },
  };
}

/** Collapse a render tree into the text a user would actually see. */
function visibleText(node, out = []) {
  if (node === null || node === undefined || node === false || node === true) return out;
  if (Array.isArray(node)) {
    for (const child of node) visibleText(child, out);
    return out;
  }
  if (typeof node === "string" || typeof node === "number") {
    const text = String(node).trim();
    if (text !== "") out.push(text);
    return out;
  }
  // A placeholder is visible text too, even though it lives in a prop.
  if (typeof node.props?.placeholder === "string") out.push(node.props.placeholder.trim());
  return visibleText(node.children, out);
}

/** Every rendered element, flattened. */
function elements(node, out = []) {
  if (Array.isArray(node)) {
    for (const child of node) elements(child, out);
    return out;
  }
  if (node === null || node === undefined || typeof node !== "object") return out;
  out.push(node);
  return elements(node.children, out);
}

const APP_ID = "cli_a1b2c3d4e5f6g7h8";
const APP_SECRET = "a1b2c3d4e5f6g7h8i9j0k1l2m3n4z9y8";
const WEBHOOK = "https://oapi.dingtalk.com/robot/send?access_token=0123456789abcdef0123456789abcdef";

// A snapshot shaped like the host's `get` reply: a live section, two channels
// enabled, four of the nine secret keys actually stored.
const SNAPSHOT = {
  config: { channels: ["feishu", "dingtalk"], channelDefaults: { language: "zh" }, feishu: { transport: "websocket" } },
  enabled: ["feishu", "dingtalk"],
  credentials: { feishu: true, telegram: false, dingtalk: true, web: false },
  secrets: {
    feishu: { appId: true, appSecret: true },
    telegram: { botToken: false },
    dingtalk: { webhookUrl: true, secret: false, clientId: false, clientSecret: false },
    web: {},
  },
  secretPreviews: {
    feishu: { appId: APP_ID, appSecret: "a1b2…z9y8" },
    dingtalk: { webhookUrl: "https://oapi.dingtalk.com/robot/send?access_token=0123…cdef" },
  },
  live: true,
};

const ALL_OPEN = new Set(["feishu", "telegram", "dingtalk", "web"]);

/**
 * Render the pane in one language, using the bundle's own component.
 *
 * `opts.open` / `opts.advanced` stand in for the two accordion state slots. They
 * default to *everything open*, which is what keeps the assertions below about
 * the pane's contents exactly as they were before the cards could fold — those
 * tests are about what the pane renders, and folding is tested on its own.
 */
function mount(lang, queued, rpcResponder) {
  const registered = loadBundle();
  // One stub for the whole mount: its setters are the component's state, so a
  // fresh one per draw would throw away everything the previous draw did.
  const stub = reactStub(queued);
  const req = (id) => {
    assert.equal(id, "react", `the bundle required an unexpected external module: ${id}`);
    return stub;
  };
  const mod = registered.factory(req);

  // `apply` is how the shell installs the plugin; capture what it registers.
  let localeTable;
  let slot;
  const ctx = {
    effect: (fn) => fn(),
    locale: { register: (_ns, table) => { localeTable = table; }, bind: () => hostTranslate(localeTable, lang) },
    slots: { inject: (_name, fn) => fn(), register: (spec) => { slot = spec; } },
    // The host's signature is `call(channel, endpoint, payload, signal)` — the
    // channel is bound by the pane, so the first argument is not the endpoint.
    // `{ ok: true, value }` is the envelope it resolves to; a responder lets a save
    // test hand back a different snapshot per endpoint without a live host. It must
    // be async: `callRpc` awaits it, and a bare object makes `.then` a TypeError
    // that the pane's own `catch` swallows into a misleading 「保存失败」.
    connection: { rpc: { call: (_channel, endpoint, payload) => (rpcResponder ?? (async () => ({ ok: true, value: {} })))(endpoint, payload) } },
  };
  mod.apply(ctx);
  assert.ok(localeTable, "apply() never registered a locale table");

  return {
    queued,
    localeTable,
    slot,
    /** Render the component again from the current state values. */
    draw() {
      stub.resetHooks();
      const { rpcCall, t } = slot.inject();
      const tree = mod.ConnectSettingsTab({ rpcCall, t });
      return { tree, text: visibleText(tree), elements: elements(tree) };
    },
  };
}

function render(lang, opts = {}) {
  const pane = mount(lang, [
    snapshotToForm(SNAPSHOT), "idle", { ...SNAPSHOT.credentials },
    opts.open ?? ALL_OPEN,
    opts.advanced ?? ALL_OPEN,
    // The issue list, which the load effect fills from the snapshot. Empty by
    // default: the fixture is a healthy one, and the branch that renders nothing
    // is what the "clean snapshot" test is about.
    opts.notices ?? [],
  ], opts.rpc);
  const { tree, text, elements: els } = pane.draw();
  return { tree, text, elements: els, localeTable: pane.localeTable, slot: pane.slot };
}

test("the bundle registers as the dsh-connect settings section", () => {
  const { slot, localeTable, text } = render("zh");
  assert.equal(slot.name, "settings.section");
  assert.equal(slot.id, "dsh-connect");
  assert.equal(slot.order, 20);
  assert.equal(slot.locale, "dsh-connect");
  assert.deepEqual(Object.keys(localeTable).sort(), ["en", "zh"]);
  // Past the `if (!form)` loading branch — the pane itself rendered.
  assert.ok(text.includes(localeTable.zh.channels), "the pane did not render its channels card");
});

test("every rendered string comes from the locale, in the selected language", () => {
  for (const [lang, other] of [["zh", "en"], ["en", "zh"]]) {
    const { text, localeTable } = render(lang);
    // Only the strings that actually differ: product names would otherwise flag
    // themselves in whichever language they are not "wrong" for.
    const foreign = new Set(
      Object.keys(localeTable[other])
        .filter((key) => localeTable[other][key] !== localeTable[lang][key])
        .map((key) => localeTable[other][key]),
    );
    for (const value of text) {
      if (foreign.has(value)) assert.fail(`the ${lang} pane rendered the ${other} string ${JSON.stringify(value)}`);
    }
  }
});

test("no raw locale key leaks into the render", () => {
  // `t()` returns the key itself on a miss, which would print `f.dmMode` or
  // `status.idle` straight into the pane.
  for (const lang of ["zh", "en"]) {
    const { text } = render(lang);
    for (const value of text) {
      assert.ok(!/^(f|s|o|status|channel)\./.test(value), `${lang} pane rendered the raw key ${JSON.stringify(value)}`);
    }
  }
});

test("every config field renders a translated label and an explanation", () => {
  const { text, localeTable } = render("zh");
  const fields = [...Object.values(CHANNEL_CONFIG_FIELDS).flat(), ...CHANNEL_DEFAULT_FIELDS];
  for (const field of fields) {
    assert.ok(text.includes(localeTable.zh[`f.${field.key}`]), `missing the label for f.${field.key}`);
    assert.ok(text.includes(localeTable.zh[`f.${field.key}.hint`]), `missing the hint for f.${field.key}`);
  }
});

test("every select option renders its translated label, never the raw value", () => {
  const { text, localeTable } = render("zh");
  const fields = [...Object.values(CHANNEL_CONFIG_FIELDS).flat(), ...CHANNEL_DEFAULT_FIELDS];
  for (const field of fields) {
    for (const option of field.options ?? []) {
      const label = localeTable.zh[`o.${option}`];
      assert.ok(text.includes(label), `missing the option label for o.${option}`);
      if (label !== option) assert.ok(!text.includes(option), `rendered the raw option value ${option}`);
    }
  }
});

test("each secret field shows its hint and, when stored, its masked preview", () => {
  const { text, localeTable } = render("zh");
  for (const [ch, fields] of Object.entries(CHANNEL_SECRET_FIELDS)) {
    for (const field of fields) {
      assert.ok(text.includes(localeTable.zh[`s.${ch}.${field}`]), `missing the label for s.${ch}.${field}`);
      assert.ok(text.includes(localeTable.zh[`s.${ch}.${field}.hint`]), `missing the hint for s.${ch}.${field}.hint`);
    }
  }
  // The whole point of the change: the user can see what they filled in.
  assert.ok(text.includes(APP_ID), "the stored appId is not shown");
  assert.ok(text.includes("a1b2…z9y8"), "the stored appSecret is not previewed");
  assert.ok(text.includes("https://oapi.dingtalk.com/robot/send?access_token=0123…cdef"), "the webhook keeps its host, path and parameter name");
  // A key with nothing stored says so rather than staying silent.
  assert.ok(text.includes(localeTable.zh.notConfigured));
});

test("an identifier is a plain input, a confidential key is a password input", () => {
  const { elements: els, localeTable } = render("zh");
  // `autoComplete: "off"` is what marks a credential input, as opposed to the
  // plain-text config fields (webhookPath, baseUrl, defaultAt) that share the
  // same `ds-input` class.
  const inputs = els.filter((el) => el.type === "input" && el.props.autoComplete === "off");
  const allKeys = Object.values(CHANNEL_SECRET_FIELDS).flat();
  const masked = allKeys.filter(isMaskedSecret);
  const plain = allKeys.filter((key) => !isMaskedSecret(key));

  // Derived from the shared disclosure table, so the pane and the host's
  // masking cannot drift apart.
  assert.equal(inputs.filter((el) => el.props.type === "password").length, masked.length);
  assert.equal(inputs.filter((el) => el.props.type === "text").length, plain.length);
  assert.ok(plain.includes("appId") && plain.includes("clientId"), "clientId/appId are identifiers and must be visible while typing");
  assert.ok(masked.includes("appSecret") && masked.includes("botToken"));

  for (const el of inputs) {
    // The preview sits beside the input, never inside it: an empty input means
    // "leave the stored value alone".
    assert.equal(el.props.value, "");
    assert.ok(
      [localeTable.zh.configured, localeTable.zh.notConfigured].includes(el.props.placeholder),
      `unexpected placeholder ${JSON.stringify(el.props.placeholder)}`,
    );
  }
});

test("no secret value, masked or not, is ever placed in an input", () => {
  // The structural half of "a mask can never be written back as a credential".
  const { elements: els } = render("zh");
  for (const el of els) {
    if (el.type !== "input") continue;
    const value = String(el.props.value ?? "");
    assert.ok(!value.includes("…"), `an input was seeded with a masked value: ${value}`);
    assert.ok(!value.includes(APP_ID) && !value.includes(APP_SECRET.slice(0, 8)), `an input was seeded with a stored secret: ${value}`);
    assert.ok(value === "", `input has a value: ${value}`);
  }
});

/** The element rendered with this exact id, wherever it sits in the tree. */
function byId(els, id) {
  const found = els.find((el) => el.props.id === id);
  assert.ok(found, `nothing in the tree has id ${id}`);
  return found;
}

/** The first descendant of `node` carrying this className. */
function byClass(node, className) {
  return elements(node.children).find((el) => el.props.className === className);
}

/** True when `el` carries `className` among its classes. */
function hasClass(el, className) {
  return String(el?.props?.className ?? "").split(" ").includes(className);
}

/** A channel card's credential badge: what it says, and whether it is flagged. */
function badgeOf(view, ch) {
  const card = byId(view.elements, `ds-ch-${ch}`);
  const badge = elements(card.children).find((el) => hasClass(el, "ds-badge"));
  assert.ok(badge, `${ch} has no credential badge`);
  return { text: visibleText(badge).join(""), warn: hasClass(badge, "ds-badge-warn") };
}

/** Every line of the save bar's problem list. */
function issueLines(view) {
  const list = view.elements.find((el) => hasClass(el, "ds-issues"));
  return list ? elements(list.children).filter((el) => hasClass(el, "ds-issue")) : [];
}

test("a collapsed channel renders no fields at all, not just hidden ones", () => {
  // The whole point of the fold: with only Feishu open the others must be gone
  // from the tree, because "still rendered but invisible" would leave the pane
  // as tall as it was. Asserted on the *unique* fields of each channel — the
  // shared ones (`f.requireMention`, `f.language`) are legitimately present via
  // Feishu, and the tab strip legitimately renders every channel's name.
  const { text, localeTable: L } = render("zh", { open: new Set(["feishu"]) });
  const collapsed = [
    ["telegram", ["f.pollingTimeoutSeconds", "f.baseUrl", "s.telegram.botToken", "channel.telegram.hint"]],
    ["dingtalk", ["f.defaultAt", "s.dingtalk.webhookUrl", "s.dingtalk.clientSecret", "channel.dingtalk.hint"]],
    ["web", ["f.pollIntervalMs", "channel.web.hint"]],
  ];
  for (const [ch, keys] of collapsed) {
    for (const key of keys) {
      assert.ok(!text.includes(L.zh[key]), `${ch} is collapsed but still rendered ${key}`);
    }
  }
  // Feishu is open — including its advanced fold, which this render leaves open.
  for (const key of ["f.transport", "f.dmMode", "f.webhookPort", "s.feishu.appId", "channel.feishu.hint"]) {
    assert.ok(text.includes(L.zh[key]), `feishu is open but did not render ${key}`);
  }
});

test("the advanced fold hides only the rarely-touched fields", () => {
  const { text, localeTable: L } = render("zh", { advanced: new Set() });
  // Both halves matter: the fold could "work" by dropping the field entirely
  // rather than by hiding it one level down.
  assert.ok(text.includes(L.zh["f.transport"]), "f.transport is a common field and must stay visible");
  assert.ok(text.includes(L.zh["f.requireMention"]), "f.requireMention is a common field and must stay visible");
  assert.ok(!text.includes(L.zh["f.webhookPort"]), "f.webhookPort is advanced and the fold is closed");
  assert.ok(!text.includes(L.zh["f.pollingTimeoutSeconds"]), "f.pollingTimeoutSeconds is advanced and the fold is closed");
  assert.ok(!text.includes(L.zh["f.pollIntervalMs"]), "f.pollIntervalMs is advanced and the fold is closed");
  // Closing the fold must not hide the explanation of what is behind it.
  assert.ok(text.includes(L.zh.advanced), "the advanced fold needs a visible label");
});

test("the accordion is a div per channel, headed by a button, driven by one tab each", () => {
  const open = new Set(["feishu", "dingtalk"]);
  const { elements: els, localeTable: L } = render("zh", { open });

  for (const ch of Object.keys(CHANNEL_SECRET_FIELDS)) {
    const card = els.find((el) => el.props.className === "ds-channel" && el.props.id === `ds-ch-${ch}`);
    assert.ok(card, `no card for ${ch}`);
    // A `<fieldset>` carries the UA's `min-width:min-content`, which is half of
    // why the pane burst its container. It must not come back.
    assert.notEqual(card.type, "fieldset", `${ch} went back to a fieldset`);
    assert.equal(card.type, "div", `${ch}'s card is a ${card.type}`);

    const toggle = byClass(card, "ds-channel-toggle");
    assert.equal(toggle.type, "button", `${ch}'s header is not a button`);
    assert.equal(toggle.props["aria-expanded"], open.has(ch), `${ch}'s aria-expanded disagrees with its fold`);
    // The enable checkbox must be a sibling of the header button, never inside
    // it: a button may not contain another interactive element.
    assert.ok(!elements(toggle.children).some((el) => el.type === "input"), `${ch} nests an input inside its header button`);

    const body = elements(card.children).find((el) => el.props.id === `ds-ch-${ch}-body`);
    assert.equal(Boolean(body), open.has(ch), `${ch}'s body ${body ? "rendered while collapsed" : "is missing while open"}`);
    if (open.has(ch)) assert.equal(toggle.props["aria-controls"], `ds-ch-${ch}-body`);
  }

  const tabs = els.filter((el) => el.props.className === "ds-tab");
  assert.equal(tabs.length, Object.keys(CHANNEL_SECRET_FIELDS).length, "one tab per channel");
  for (const tab of tabs) {
    assert.equal(tab.type, "button");
    // A `role=tab` would have to name a selected tab, and there isn't one —
    // several channels can be open at once. `aria-expanded` says what is true.
    assert.equal(tab.props.role, undefined, "the tab strip claimed tab semantics it does not have");
    assert.ok(byClass(tab, "ds-dot"), "a tab is missing its enabled-state dot");
    const controls = tab.props["aria-controls"];
    if (controls !== undefined) byId(els, controls);
  }
  // The dot reports *enabled*, which is not the same as open: the fixture enables
  // feishu and dingtalk but this render opens them plus telegram and web. If the
  // dot were wired to the fold instead, these would all read "1".
  const channels = Object.keys(CHANNEL_SECRET_FIELDS);
  assert.deepEqual(
    tabs.map((tab) => byClass(tab, "ds-dot").props["data-on"]),
    channels.map((ch) => (SNAPSHOT.enabled.includes(ch) ? "1" : "0")),
  );

  const strip = els.find((el) => el.props.className === "ds-tabs");
  assert.equal(strip.type, "nav");
  assert.equal(strip.props["aria-label"], L.zh.tabsAria);
});

test("unchecking a channel does not fold its card shut under the cursor", () => {
  // No override yet, so the open set is *derived* from the enabled list on every
  // render — which is the state the user is in the first time they touch an
  // enable box, and the one where a naive untick takes the card away: Feishu
  // leaves `form.channels`, `initialOpenChannels` is recomputed without it, and
  // the card the user is looking at disappears.
  const pane = mount("zh", [snapshotToForm(SNAPSHOT), "idle", { ...SNAPSHOT.credentials }, null, new Set(), []]);
  const name = (ch) => pane.localeTable.zh[`channel.${ch}`];
  const box = (view, ch) => view.elements.find(
    (el) => el.type === "input" && el.props.type === "checkbox" && el.props["aria-label"] === name(ch),
  );
  const bodyOf = (view, ch) => view.elements.some((el) => el.props.id === `ds-ch-${ch}-body`);

  let view = pane.draw();
  // The fixture enables feishu and dingtalk, so the derived default opens both.
  assert.ok(bodyOf(view, "feishu") && bodyOf(view, "dingtalk"), "the enabled channels did not start open");

  box(view, "feishu").props.onChange({ target: { checked: false } });
  view = pane.draw();
  assert.ok(!pane.queued[0].channels.includes("feishu"), "the untick never reached the form");
  assert.ok(bodyOf(view, "feishu"), "unchecking feishu folded its card shut");
  assert.ok(bodyOf(view, "dingtalk"), "unchecking feishu folded an unrelated card");

  // The other direction: ticking a channel opens it, and the fold is frozen from
  // here on, so ticking it back off must not close it either.
  box(view, "telegram").props.onChange({ target: { checked: true } });
  view = pane.draw();
  assert.ok(bodyOf(view, "telegram"), "ticking a channel did not open it");
  box(view, "telegram").props.onChange({ target: { checked: false } });
  view = pane.draw();
  assert.ok(bodyOf(view, "telegram"), "unchecking telegram folded its card shut");
});

test("the save bar is the root's last child, so it can pin to the host's scroll region", () => {
  const { tree, elements: els } = render("zh");
  const footer = els.find((el) => el.props.className === "ds-footer");
  assert.ok(footer, "the pane has no save bar");
  // `position:sticky` pins to the nearest scrollport only while its containing
  // block is the scrolled box. Nested inside the defaults card the footer could
  // never leave that card, so it pinned to nothing and Save scrolled out of
  // reach with the channel list.
  assert.equal(tree.children[tree.children.length - 1], footer, "the save bar is not the root's last child");
  for (const card of els.filter((el) => el.props.className === "ds-card")) {
    assert.ok(!elements(card.children).includes(footer), "the save bar is nested inside a card again");
  }
});

test("the fallback plane still names the file it writes, and only there", () => {
  // The single branch that renders `settingsStatePath`. On the live plane the
  // path is not consulted and is not part of the section, so an editable field
  // for it would silently swallow edits — which is why it is hidden, and is only
  // ever hideable if the fallback branch exists at all.
  const live = render("zh");
  assert.ok(!live.text.includes(live.localeTable.zh.statePath), "the live plane rendered the fallback file-path field");
  assert.ok(live.text.includes(live.localeTable.zh.livePlane), "the live plane did not say its saves are immediate");
  // 0.9.2 moved the live store to the plugin's entry in the profile patch, and
  // the pane kept saying `settings.yaml` for a release after that stopped being
  // true — it is the one string a user reads to answer "where did my save go?".
  for (const l of ["zh", "en"]) {
    assert.match(live.localeTable[l].livePlane, /cordis\.patch\.yml/, `the live plane (${l}) no longer names the file a save lands in`);
    assert.ok(!live.localeTable[l].livePlane.includes("settings.yaml"), `the live plane (${l}) still points at settings.yaml`);
  }

  const statePath = ".dsh-connect/dsh-connect-settings.json";
  const pane = mount("zh", [
    snapshotToForm({ ...SNAPSHOT, live: false, config: { ...SNAPSHOT.config, settingsStatePath: statePath } }),
    "idle", { ...SNAPSHOT.credentials }, ALL_OPEN, new Set(), [],
  ]);
  const view = pane.draw();
  const L = pane.localeTable.zh;
  assert.ok(view.text.includes(L.statePath), "the fallback plane did not name the file it writes");
  assert.ok(view.text.includes(L.statePathHint), "the fallback plane did not explain the field");
  assert.ok(view.text.includes(L.filePlane), "the fallback plane claimed its saves were immediate");
  // Seeded, never blank: blank is what a save would write, clearing the path.
  assert.ok(
    view.elements.some((el) => el.type === "input" && el.props.value === statePath),
    "the state-path field was not seeded with the loaded value",
  );
});

test("a channel whose store could not be read is unknown, not missing", () => {
  // The fixture's DingTalk line is the failure: the host sends `credentials.dingtalk
  // === false` (the pane needs something to render) *and* names the channel in
  // `credentialErrors`. Reading only the boolean prints 「未配置凭据」 over a bot
  // that is running fine, and sends the user to re-enter a secret that was never
  // the problem — so the two states must not collapse into one badge.
  const clean = render("zh");
  assert.equal(badgeOf(clean, "dingtalk").text, clean.localeTable.zh.reachable, "the fixture changed: dingtalk is meant to read as configured");

  const snap = {
    ...SNAPSHOT,
    credentials: { ...SNAPSHOT.credentials, dingtalk: false },
    credentialErrors: ["dingtalk"],
  };
  const view = render("zh", { notices: snapshotIssues(snap) });
  const L = view.localeTable.zh;

  const dingtalk = badgeOf(view, "dingtalk");
  assert.equal(dingtalk.text, L.credentialUnknown);
  assert.ok(dingtalk.warn, "the unknown badge is not flagged, so it reads as an ordinary state");
  assert.notEqual(dingtalk.text, L.unreachable, "an unreadable store was reported as an absent credential");

  // Per-channel: one unreadable entry must not grey out the rest, or a single
  // permissions problem turns into "all my configuration is gone".
  for (const ch of ["feishu", "telegram", "web"]) {
    const badge = badgeOf(view, ch);
    assert.equal(badge.warn, false, `${ch} was flagged for a failure that is not its own`);
    assert.equal(badge.text, badgeOf(clean, ch).text, `${ch}'s badge changed with an unrelated channel`);
  }
});

test("a call with nothing to report renders no problem list at all", () => {
  // The happy path has to stay quiet. An always-present empty `<ul>` is not just
  // noise: `ds-issues` takes a full row of the save bar, so a stray one pushes the
  // Save button around on every clean load.
  const view = render("zh");
  assert.equal(view.elements.some((el) => hasClass(el, "ds-issues")), false, "an empty problem list was rendered");
  assert.deepEqual(issueLines(view), []);
  // And its opposite, so the assertion above is about the reports and not about a
  // class name that never renders at all in this tree.
  assert.ok(issueLines(render("zh", { notices: snapshotIssues({ warnings: ["credentialsStoredNotApplied"] }) })).length === 1);
});

test("every report the host could not express as a failure reaches the save bar", () => {
  // The three kinds together are the whole point of the change: a save that
  // committed but did not take effect must be reported as *both* succeeded and
  // not-yet-in-effect, and each of these lived in a log line before.
  const reason = "Error: app id and app secret are both required";
  const view = render("zh", {
    notices: snapshotIssues({
      credentialErrors: ["dingtalk"],
      warnings: ["credentialsStoredNotApplied"],
      channelErrors: { feishu: reason },
    }),
  });
  const L = view.localeTable.zh;

  const lines = issueLines(view);
  assert.equal(lines.length, 3, "a report was dropped between the host and the pane");
  const rendered = lines.map((line) => visibleText(line).join(""));
  const has = (needle) => rendered.some((text) => text.includes(needle));

  // Which channel, then what happened to it — the pair is what makes a line
  // actionable. The unknown-store line deliberately does *not* say "not configured".
  assert.ok(has(L["channel.dingtalk"]) && has(L.credentialUnknownHint), `no unreadable-store line: ${JSON.stringify(rendered)}`);
  assert.ok(!has(L.unreachable), "the unreadable store was also reported as a missing credential");
  // A warning is about the call, so it names no channel and needs no reason.
  assert.ok(has(L["w.credentialsStoredNotApplied"]), `no warning line: ${JSON.stringify(rendered)}`);
  // A dead channel carries the adapter's own message verbatim: it is the only part
  // that says *which* credential or option is wrong, and a locale code would have
  // to guess that backwards.
  assert.ok(has(L["channel.feishu"]) && has(L.channelFailed) && has(reason), `no channel-failure line: ${JSON.stringify(rendered)}`);

  // In the save bar, not beside the channel it concerns: the bar is the one part of
  // the pane that is always on screen, and a channel card can be folded or scrolled
  // past — 「已保存」 next to nothing else is the complaint this answers.
  const footer = view.elements.find((el) => hasClass(el, "ds-footer"));
  const list = view.elements.find((el) => hasClass(el, "ds-issues"));
  assert.ok(elements(footer).includes(list), "the problem list is not in the save bar");
});

test("a warning raised by an earlier credential save survives a later one", async () => {
  // The error lists describe the state of the world and the host re-derives them
  // on every call, so the last snapshot is the truth for those. A warning is about
  // the single call that raised it, and the host does not repeat it — so reading
  // only the last snapshot silently erases the first channel's warning.
  let credentialSaves = 0;
  const rpc = async (endpoint) => {
    if (endpoint === "credentials.save") {
      credentialSaves += 1;
      // Only the *first* channel warns, so the final snapshot is clean and the
      // notice can only be there because the chain accumulated it.
      return { ok: true, value: credentialSaves === 1 ? { ...SNAPSHOT, warnings: ["credentialsStoredNotApplied"] } : SNAPSHOT };
    }
    return { ok: true, value: SNAPSHOT };
  };

  const pane = mount("zh", [
    snapshotToForm(SNAPSHOT), "idle", { ...SNAPSHOT.credentials }, ALL_OPEN, ALL_OPEN, [],
  ], rpc);
  let view = pane.draw();

  // `snapshotToForm` always yields `secrets: {}` (the stored values are never sent
  // back), and `buildCredentialSaves` skips empty ones — so a save of an untouched
  // form reaches no channel at all. Type into two channels' secrets first.
  const secretInput = (v, ch) => elements(byId(v.elements, `ds-ch-${ch}`).children)
    .find((el) => el.type === "input" && el.props.autoComplete === "off");
  secretInput(view, "feishu").props.onChange({ target: { value: "cli_typed" } });
  secretInput(view, "telegram").props.onChange({ target: { value: "123456:ABC" } });
  view = pane.draw();

  const save = view.elements.find((el) => el.props.className === "ds-btn");
  assert.ok(save, "the save bar has no button");
  await save.props.onClick();
  view = pane.draw();

  assert.equal(credentialSaves, 2, "the save did not reach both channels");
  assert.equal(pane.queued[1], "saved", "the save did not report success");
  // The durable half: the value was stored, so the status is 「已保存」 — and the
  // half that says it has not taken effect yet is the list below it.
  const lines = issueLines(view);
  assert.equal(lines.length, 1, `expected exactly the one warning, got ${JSON.stringify(lines.map((l) => visibleText(l).join("")))}`);
  assert.ok(visibleText(lines[0]).join("").includes(pane.localeTable.zh["w.credentialsStoredNotApplied"]));
});
