import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { snapshotToForm, CHANNEL_SECRET_FIELDS, CHANNEL_CONFIG_FIELDS, CHANNEL_DEFAULT_FIELDS, GENERAL_FIELD_GROUPS, GENERAL_FIELDS } from "../lib/settings/settings-model.js";
import { CHANNEL_CONNECTION_STATES } from "../lib/settings/channel-status.js";
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
    // How many slots the last draw consumed. Reading a slot the seed does not
    // supply yields `undefined` rather than an error — and a state added *in the
    // middle* would silently hand the form to `status` and still render something
    // — so the count is the only way to notice from here.
    hooksUsed: () => hook,
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
    /** How many hook slots the last `draw()` consumed — see `reactStub`. */
    hooksUsed: () => stub.hooksUsed(),
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
    snapshotToForm(opts.snapshot ?? SNAPSHOT), "idle", { ...SNAPSHOT.credentials },
    opts.open ?? ALL_OPEN,
    opts.advanced ?? ALL_OPEN,
    // The issue list, which the load effect fills from the snapshot. Empty by
    // default: the fixture is a healthy one, and the branch that renders nothing
    // is what the "clean snapshot" test is about.
    opts.notices ?? [],
    // The one-click run's own state, appended *after* `notices` so the six slots
    // above keep their meanings. `null` is what the component starts with, so
    // every render that does not opt in renders an idle Feishu card.
    opts.onboarding ?? null,
    // Which of the two views is showing, as an override. Also appended, for the
    // same reason: `null` means "the user has not chosen", which is what every
    // render that does not opt in gets — and what the default-view test needs.
    opts.view ?? null,
  ], opts.rpc);
  const { tree, text, elements: els } = pane.draw();
  return { tree, text, elements: els, localeTable: pane.localeTable, slot: pane.slot, pane };
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
  //
  // Both views, because they share the locale table but not a single key: the
  // `g.*` and `view.*` namespaces are only reachable from 通用设置 and the
  // navigation, so checking the default view alone would leave every key this
  // batch added uncovered.
  for (const lang of ["zh", "en"]) {
    for (const view of ["channels", "general"]) {
      const { text } = render(lang, { view });
      for (const value of text) {
        assert.ok(
          !/^(f|g|s|o|status|channel|view)\./.test(value),
          `${lang} pane (${view} view) rendered the raw key ${JSON.stringify(value)}`,
        );
      }
    }
  }
});

// --- the two-level navigation ----------------------------------------------
//
// 通用设置 was added to a pane that had a single view, and the two halves of that
// are asserted separately on purpose: the *order* of the navigation (通用设置
// first, as asked) and the *landing* view (机器人渠道, so the one-click button is
// zero clicks away) are deliberately different, and each half has to survive a
// well-meaning "fix" that makes them match.

/** The primary navigation strip. */
function navOf(view) {
  const nav = view.elements.find((el) => el.props.className === "ds-nav");
  assert.ok(nav, "the pane has no primary navigation");
  return nav;
}

/** Click a navigation button by the view it selects, then redraw. */
function switchTo(pane, name) {
  const item = pane.draw().elements
    .filter((el) => el.props.className === "ds-nav-item")
    .find((el) => visibleText(el).join("") === pane.localeTable.zh[`view.${name}`]);
  assert.ok(item, `no navigation button for ${name}`);
  item.props.onClick();
  return pane.draw();
}

test("the pane opens on the channel view, while the navigation still reads 通用设置 first", () => {
  const view = render("zh");
  const L = view.localeTable.zh;

  const nav = navOf(view);
  assert.equal(nav.type, "nav");
  assert.equal(nav.props["aria-label"], L.navAria);

  const items = view.elements.filter((el) => el.props.className === "ds-nav-item");
  assert.deepEqual(items.map((el) => visibleText(el).join("")), [L["view.general"], L["view.channels"]]);
  for (const item of items) {
    assert.equal(item.type, "button");
    // `role="tab"` would claim a tablist that is not in the document — the
    // *channel* strip is the tab strip, and the two must not be confusable.
    assert.equal(item.props.role, undefined, "the navigation claimed tab semantics");
  }
  assert.deepEqual(items.map((el) => el.props["aria-current"]), [undefined, "page"]);

  // The landing view, asserted rather than inferred from the aria state above:
  // these render no seed for the view slot, so this is the component's own
  // default and not something the harness chose.
  assert.equal(view.elements.some((el) => el.props.className === "ds-tabs"), true, "the pane did not open on the channel view");
});

test("clicking 通用设置 renders every general field, and the channel strip goes with the other view", () => {
  const pane = mount("zh", [
    snapshotToForm(SNAPSHOT), "idle", { ...SNAPSHOT.credentials }, ALL_OPEN, ALL_OPEN, [], null, null,
  ]);
  const L = pane.localeTable.zh;
  assert.equal(
    pane.draw().elements.filter((el) => el.props.className === "ds-tab").length, 4,
    "the fixture changed: the channel strip is not four tabs",
  );

  const view = switchTo(pane, "general");

  const cards = view.elements.filter((el) => el.props.className === "ds-card");
  assert.equal(cards.length, GENERAL_FIELD_GROUPS.length, "one card per general group");
  assert.deepEqual(
    cards.map((card) => visibleText(byClass(card, "ds-card-title")).join("")),
    GENERAL_FIELD_GROUPS.map((g) => L[g.title]),
    "a group title rendered its raw locale key instead of the translated one",
  );
  for (const field of GENERAL_FIELDS) {
    assert.ok(view.text.includes(L[`g.${field.key}`]), `missing the label for g.${field.key}`);
    assert.ok(view.text.includes(L[`g.${field.key}.hint`]), `missing the hint for g.${field.key}`);
    for (const option of field.options ?? []) {
      assert.ok(view.text.includes(L[`o.${option}`]), `missing the option label for o.${option}`);
    }
  }

  // The two views are mutually exclusive: the channel strip is *not rendered*
  // behind the general view, and the navigation did not borrow its class to make
  // the count look unchanged. Switching back restores it, so the assertion is
  // about the view and not about a strip that quietly stopped rendering at all.
  assert.equal(view.elements.filter((el) => el.props.className === "ds-tab").length, 0, "the channel strip rendered under the general view");
  assert.equal(switchTo(pane, "channels").elements.filter((el) => el.props.className === "ds-tab").length, 4);
});

test("a general list field is a textarea, so one entry per line is what it looks like", () => {
  // The three `list` keys are `string[]`. A single-line `input` would make a
  // pasted `a, b` look like one absurd path and hide the rest of a long list.
  const view = render("zh", {
    view: "general",
    snapshot: { ...SNAPSHOT, config: { ...SNAPSHOT.config, workspaces: ["packages", "docs"] } },
  });
  const areas = view.elements.filter((el) => el.type === "textarea");
  const keys = GENERAL_FIELDS.filter((f) => f.kind === "list").map((f) => f.key);
  assert.equal(areas.length, keys.length, "one textarea per list field");
  // Seeded, one entry per line, and not as a JSON string: the pane's own text
  // round-trip has to survive a save-load cycle unchanged.
  assert.ok(
    areas.some((el) => el.props.value === "packages\ndocs"),
    `the seeded workspaces list is not rendered line-per-entry: ${JSON.stringify(areas.map((el) => el.props.value))}`,
  );
});

test("the DSH-owned model is a read-only row, and only when the host resolved one", () => {
  const withModel = render("zh", {
    view: "general",
    snapshot: { ...SNAPSHOT, agentModel: { provider: "deepseek", model: "v4" } },
  });
  const L = withModel.localeTable.zh;
  const row = withModel.elements.find((el) => el.props.className === "ds-readonly");
  assert.ok(row, "the host reported a model but the pane rendered no row for it");
  assert.equal(visibleText(row).join(""), "deepseek / v4");
  assert.ok(withModel.text.includes(L["g.model"]), "the row does not say what it is");
  assert.ok(withModel.text.includes(L["g.model.note"]), "the row does not say where to change it");

  // Read-only structurally, not by styling: `saveSelection()` does exist and
  // does write, so an input that merely *looks* disabled would be one tsc-free
  // edit away from repointing the user's other conversations. Nothing to type
  // into is the guarantee.
  assert.equal(
    elements(row.children).some((el) => ["input", "select", "textarea"].includes(el.type)), false,
    "the model row grew a control",
  );
  for (const el of withModel.elements) {
    if (el.type !== "input" && el.type !== "textarea") continue;
    assert.ok(!String(el.props.value ?? "").includes("deepseek"), "the model was placed in an editable control");
  }

  // And with nothing resolved there is no row at all — an empty read-only row
  // would say "you have no model", which is a different and false claim from
  // "this pane could not read one".
  const withoutModel = render("zh", { view: "general" });
  assert.equal(withoutModel.elements.some((el) => el.props.className === "ds-readonly"), false, "an empty model row was rendered");
  assert.ok(!withoutModel.text.includes(withoutModel.localeTable.zh["g.model.note"]), "the model note was rendered with no model to annotate");
});

test("the shared-config provenance note appears on the shadowed key and nowhere else", () => {
  // `dsh.shared.config.json` overrides `workDir`/`language`/`autoMirror`, so a
  // row that silently accepts an edit would be a control that does nothing. A
  // blanket caveat would be the opposite failure — false on every other row,
  // and therefore scrolled past.
  const clean = render("zh", { view: "general" });
  assert.ok(!clean.text.includes(clean.localeTable.zh["g.sharedOverride"]), "a clean install grew a shared-config note");

  const view = render("zh", {
    view: "general",
    snapshot: { ...SNAPSHOT, sharedOverrideKeys: ["language", "workDir"] },
  });
  const notes = view.elements.filter((el) => el.props.className === "ds-note");
  assert.equal(notes.length, 2, "one note per actually-shadowed key");
  for (const note of notes) assert.equal(visibleText(note).join(""), view.localeTable.zh["g.sharedOverride"]);
  // Annotated, not locked: a shared override is a fact about where the value
  // comes from, and the profile underneath is still the user's to edit.
  assert.equal(view.elements.filter((el) => el.props.disabled === true).length, 0);
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
  // plain-text config fields (webhookPath, baseUrl, stream.url) that share the
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

/**
 * A channel card's *access-state* badge — the second one in the header.
 *
 * Position matters here: the credentials badge answers "is there a secret in the
 * store" and this one answers "is the bot actually reachable", and a pane that
 * rendered only one of them would look identical to the eye. So this reads the
 * slot explicitly rather than searching by text, and asserts there is a second
 * badge at all.
 */
function connectionBadgeOf(view, ch) {
  const card = byId(view.elements, `ds-ch-${ch}`);
  const badges = elements(card.children).filter((el) => hasClass(el, "ds-badge"));
  assert.equal(badges.length, 2, `${ch} does not carry both a credential badge and an access-state badge`);
  const badge = badges[1];
  return {
    text: visibleText(badge).join(""),
    warn: hasClass(badge, "ds-badge-warn"),
    ok: hasClass(badge, "ds-badge-ok"),
  };
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
    ["dingtalk", ["f.stream.url", "s.dingtalk.webhookUrl", "s.dingtalk.clientSecret", "channel.dingtalk.hint"]],
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

test("the save bar is the root's last child in both views, so it can pin to the host's scroll region", () => {
  // Both views, because the bar is *shared*: 通用设置 saves through the same
  // button and the same payload, so a footer nested inside the channel branch
  // would leave the general view with no way to save at all.
  for (const view of ["channels", "general"]) {
    const { tree, elements: els } = render("zh", { view });
    const footer = els.find((el) => el.props.className === "ds-footer");
    assert.ok(footer, `the ${view} view has no save bar`);
    // `position:sticky` pins to the nearest scrollport only while its containing
    // block is the scrolled box. Nested inside the defaults card the footer could
    // never leave that card, so it pinned to nothing and Save scrolled out of
    // reach with the channel list.
    assert.equal(tree.children[tree.children.length - 1], footer, `the save bar is not the root's last child in the ${view} view`);
    for (const card of els.filter((el) => el.props.className === "ds-card")) {
      assert.ok(!elements(card.children).includes(footer), "the save bar is nested inside a card again");
    }
    // The navigation is the root's *first* child, which is what lets it pin at
    // `top:0`; the channel strip below then pins at `var(--ds-nav-h)`, so
    // neither can slide underneath the other.
    assert.equal(tree.children[0], els.find((el) => el.props.className === "ds-nav"), "the navigation is not the root's first child");
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

test("every access state the host can report renders as its own badge", () => {
  // Derived from the host's own list of states, so a state the composer learns to
  // emit cannot arrive here without wording — the loop would ask for a locale key
  // that does not exist and the assertion would name it.
  for (const state of CHANNEL_CONNECTION_STATES) {
    const view = render("zh", { snapshot: { ...SNAPSHOT, channelStatus: { feishu: { state } } } });
    const badge = connectionBadgeOf(view, "feishu");
    assert.ok(view.localeTable.zh[`cs.${state}`], `no wording for the host's ${state} state`);
    assert.equal(badge.text, view.localeTable.zh[`cs.${state}`], `the ${state} badge says something else`);
    // The colour rule, stated once: only a failure asks the user to act, and only
    // the two states that mean traffic is flowing may look healthy. Anything else
    // painted green is a lie the user cannot see through.
    assert.equal(badge.warn, state === "failed", `${state} was flagged as a problem`);
    assert.equal(badge.ok, state === "connected" || state === "running", `${state} was painted as healthy`);
  }
});

test("a reconnect reports how many times it has tried, not just that it is trying", () => {
  const L = render("zh").localeTable.zh;
  assert.ok(L["cs.reconnecting.n"].includes("{n}"), "the numbered wording lost its placeholder, so the count would vanish silently");

  const counted = render("zh", { snapshot: { ...SNAPSHOT, channelStatus: { feishu: { state: "reconnecting", attempts: 3 } } } });
  assert.equal(connectionBadgeOf(counted, "feishu").text, L["cs.reconnecting.n"].replace("{n}", "3"));

  // Zero attempts is what the host omits, and it must not come back as 「第 0 次」:
  // "reconnecting, 0 attempts" is a sentence that says the opposite of the truth.
  const bare = render("zh", { snapshot: { ...SNAPSHOT, channelStatus: { feishu: { state: "reconnecting", attempts: 0 } } } });
  assert.equal(connectionBadgeOf(bare, "feishu").text, L["cs.reconnecting"]);
});

test("a host that cannot report access state renders no second badge, not a guess", () => {
  // `SNAPSHOT` carries no `channelStatus`, which is exactly what a host whose
  // probe is not wired sends. A placeholder badge is indistinguishable from a
  // real one, so there must not be one at all.
  const view = render("zh");
  for (const ch of ["feishu", "telegram", "dingtalk", "web"]) {
    const card = byId(view.elements, `ds-ch-${ch}`);
    const badges = elements(card.children).filter((el) => hasClass(el, "ds-badge"));
    assert.equal(badges.length, 1, `${ch} grew an access-state badge out of a snapshot that carries none`);
  }

  // Independently of that: the two badges must not be the same report wearing two
  // hats. Turning the probe on changes the access badge and leaves the credential
  // badge byte-for-byte where it was, for every channel — including the ones with
  // no access state of their own.
  const wired = render("zh", { snapshot: { ...SNAPSHOT, channelStatus: { feishu: { state: "connected" } } } });
  for (const ch of ["feishu", "telegram", "dingtalk", "web"]) {
    assert.deepEqual(badgeOf(wired, ch), badgeOf(view, ch), `${ch}'s credential badge moved when the access state arrived`);
  }
  assert.equal(connectionBadgeOf(wired, "feishu").text, wired.localeTable.zh["cs.connected"]);
});

test("a snapshot with no access state yields a form with no access-state key", () => {
  // The form is compared key-for-key against `snapshotToForm(SNAPSHOT)` further
  // down, and an unconditional `channelStatus: undefined` would add a key there
  // and break a test about something else entirely.
  assert.equal("channelStatus" in snapshotToForm(SNAPSHOT), false, "the form grew a key the snapshot never carried");
  assert.deepEqual(
    snapshotToForm({ ...SNAPSHOT, channelStatus: { feishu: { state: "idle" } } }).channelStatus,
    { feishu: { state: "idle" } },
  );
});

test("the access badge costs no hook slot", () => {
  // The stub implements three hooks and the pane's slots are read by position. A
  // ninth `useState` for the status would shift every slot after it, and this
  // file's fixture would feed the wrong values into the wrong names without a
  // single type error.
  const { pane } = render("zh", { snapshot: { ...SNAPSHOT, channelStatus: { feishu: { state: "connected" } } } });
  assert.equal(pane.hooksUsed(), 8, "the pane reads a different number of hook slots than this file supplies");
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

// --- a save that only half lands -------------------------------------------
//
// The two writes behind the save button go to two documents — the config section
// and the credential store — and the defect these pin is what happens when they
// are treated as one. 1.0.3 shipped with the plugin unconfigurable at all:
// `settings.save` threw, the pane's single try/catch jumped to the error status,
// and the `credentials.save` loop below it never ran. The appId and appSecret a
// user had just typed were discarded without a word, the channel stayed 未设置,
// and 「保存失败」 — the one message the pane showed — cannot be told apart from
// a secret that was stored and then refused by Feishu.

/** The typed-secret input of one channel card, as the renderer builds it. */
function secretInputOf(view, ch) {
  return elements(byId(view.elements, `ds-ch-${ch}`).children)
    .find((el) => el.type === "input" && el.props.autoComplete === "off");
}

test("a failed settings write does not discard the credential the user typed", async () => {
  const calls = [];
  const rpc = async (endpoint) => {
    calls.push(endpoint);
    // The host refuses the config write outright, and accepts the credential.
    if (endpoint === "settings.save") return { ok: false, error: { code: "settings-failed", message: "settings-failed" } };
    if (endpoint === "credentials.save") {
      return { ok: true, value: { ...SNAPSHOT, credentials: { ...SNAPSHOT.credentials, telegram: true } } };
    }
    return { ok: true, value: SNAPSHOT };
  };

  const pane = mount("zh", [
    snapshotToForm(SNAPSHOT), "idle", { ...SNAPSHOT.credentials }, ALL_OPEN, ALL_OPEN, [],
  ], rpc);
  let view = pane.draw();

  // Telegram, because its stored-credential flag starts false — so the badge
  // below can only read 「已接入」 if the credential write really landed.
  secretInputOf(view, "telegram").props.onChange({ target: { value: "123456:ABC" } });
  view = pane.draw();

  const save = view.elements.find((el) => el.props.className === "ds-btn");
  await save.props.onClick();
  view = pane.draw();

  assert.deepEqual(calls, ["settings.save", "credentials.save"], "the failed settings write stopped the credential write");
  assert.equal(pane.queued[1], "error", "a save that lost one of its two writes reported success");
  assert.equal(pane.queued[2].telegram, true, "the credential was written but the pane still shows the channel as unconfigured");

  // What the user typed is still in the form. Re-seeding from the snapshot would
  // have replaced it with the host's unchanged config — losing their input a
  // second time, and this time silently.
  assert.equal(secretInputOf(view, "telegram").props.value, "123456:ABC", "the typed credential was dropped by the failed save");

  // One line, naming the half that failed, with the host's code on it: the code
  // is the only part that distinguishes a refused write from a dropped link.
  const lines = issueLines(view);
  assert.equal(lines.length, 1, `expected exactly one line, got ${JSON.stringify(lines.map((l) => visibleText(l).join("")))}`);
  const said = visibleText(lines[0]).join("");
  assert.ok(said.includes(pane.localeTable.zh.saveFailedSettings), `the failure line is not the settings one: ${said}`);
  assert.ok(said.includes("settings-failed"), `the host's code was dropped: ${said}`);
});

test("a failed credential write is named as itself, and keeps the typed value", async () => {
  const rpc = async (endpoint) => {
    if (endpoint === "credentials.save") return { ok: false, error: { code: "invalid-credentials", message: "invalid-credentials" } };
    return { ok: true, value: SNAPSHOT };
  };

  const pane = mount("zh", [
    snapshotToForm(SNAPSHOT), "idle", { ...SNAPSHOT.credentials }, ALL_OPEN, ALL_OPEN, [],
  ], rpc);
  let view = pane.draw();
  secretInputOf(view, "telegram").props.onChange({ target: { value: "123456:ABC" } });
  view = pane.draw();

  await view.elements.find((el) => el.props.className === "ds-btn").props.onClick();
  view = pane.draw();

  assert.equal(pane.queued[1], "error");
  assert.equal(pane.queued[2].telegram, false, "a credential that was never stored is now shown as stored");
  assert.equal(secretInputOf(view, "telegram").props.value, "123456:ABC", "the typed credential was cleared by the failed write");

  const lines = issueLines(view);
  assert.equal(lines.length, 1, `expected exactly one line, got ${JSON.stringify(lines.map((l) => visibleText(l).join("")))}`);
  const said = visibleText(lines[0]).join("");
  assert.ok(said.includes(pane.localeTable.zh.saveFailedCredentials), `the failure line is not the credential one: ${said}`);
  assert.ok(said.includes(pane.localeTable.zh["channel.telegram"]), `the line does not say which channel: ${said}`);
  assert.ok(said.includes("invalid-credentials"), `the host's code was dropped: ${said}`);
});

// --- the one-click Feishu run ----------------------------------------------
//
// Three things are being pinned here. The hook contract (`onboarding` is the
// *seventh* slot, and nothing may be inserted before it), the split between the
// one channel that can really be automated and the two that cannot, and the
// reporting rule the whole flow exists for: 已落盘 ≠ 已生效, as two lines.
//
// One thing is deliberately *not* here: no test starts a run whose polls keep
// answering `waiting`, because that loop is bounded by the link's own lifetime
// (16 minutes) and would hang the suite. The link-bearing renders below seed the
// seventh slot directly instead, which is the same tree with no clock in it.

/** The device-authorization URL, shaped like the one Feishu hands back. */
const LINK = "https://open.feishu.cn/page/launcher?user_code=ABCD-EFGH&from=dsh";

/** The card body, which is where the button belongs. */
function feishuBody(view) {
  return byId(view.elements, "ds-ch-feishu-body");
}

test("the creation block comes before the fields it fills in", () => {
  // The complaint that started this: a user works through every credential field
  // by hand and only then discovers the button that would have done all of it.
  // DOM order is visual order, so the index is the whole assertion.
  const view = render("zh");
  const body = elements(feishuBody(view).children);
  const button = body.findIndex((el) => hasClass(el, "ds-onboard-btn"));
  const fields = body.findIndex((el) => el.props.className === "ds-fields");
  assert.ok(button !== -1, "the Feishu card has no one-click button");
  assert.ok(fields !== -1, "the Feishu card has no credential fields");
  assert.ok(button < fields, "the one-click button is below the fields again");

  // The two manual channels, same reasoning in reverse: their text says "paste
  // what you got below", so the link has to come before the fields it points at.
  for (const ch of ["telegram", "dingtalk"]) {
    const kids = elements(byId(view.elements, `ds-ch-${ch}-body`).children);
    const link = kids.findIndex((el) => el.type === "a");
    const own = kids.findIndex((el) => el.props.className === "ds-fields");
    assert.ok(link !== -1 && own !== -1, `${ch}'s card lost its creation link or its fields`);
    assert.ok(link < own, `${ch}'s creation link is below the fields it points at`);
  }
});

test("the one-click state is the seventh hook, and the six before it are undisturbed", () => {
  const state = { busy: false, phase: "waiting", link: { url: LINK, expiresInSeconds: 600, expiresAt: 1 } };
  const pane = mount("zh", [
    snapshotToForm(SNAPSHOT), "idle", { ...SNAPSHOT.credentials }, ALL_OPEN, ALL_OPEN, [], state,
  ]);
  const view = pane.draw();

  // The stub feeds hook values in positionally, so a state inserted anywhere but
  // the end would hand the form to `status`, the status to `creds`, and so on —
  // silently, with the pane still rendering something. Counting the slots is the
  // only way to notice that from out here; a missing one just reads `undefined`.
  // Eight since the primary navigation landed: `viewOverride` is appended after
  // `onboarding`, so `queued[0..6]` keep their meanings and a seed written
  // before that change — which is every seed in this file — reads `undefined`
  // for the view and lands on the default one.
  assert.equal(pane.hooksUsed(), 8, "the component reads a different number of hook slots than this file supplies");
  assert.deepEqual(pane.queued[0], snapshotToForm(SNAPSHOT));
  assert.equal(pane.queued[1], "idle");
  assert.deepEqual(pane.queued[2], SNAPSHOT.credentials);
  assert.deepEqual(pane.queued[5], [], "the notices slot moved");
  assert.equal(pane.queued[6], state);
  // And the seventh is really the one in use, rather than a slot nobody reads.
  const button = elements(feishuBody(view).children).find((el) => hasClass(el, "ds-onboard-btn"));
  assert.equal(visibleText(button).join(""), pane.localeTable.zh["onboard.waiting"]);
});

test("the Feishu card carries one start button, and the save bar still finds its own", () => {
  const view = render("zh");
  const L = view.localeTable.zh;
  const body = feishuBody(view);

  const buttons = elements(body.children).filter((el) => hasClass(el, "ds-onboard-btn"));
  assert.equal(buttons.length, 1, "the Feishu body does not carry exactly one one-click button");
  assert.equal(buttons[0].type, "button");
  assert.equal(buttons[0].props.disabled, false, "an idle run must be startable");
  assert.equal(visibleText(buttons[0]).join(""), L["onboard.create"]);
  assert.ok(visibleText(body).join("").includes(L["onboard.create.hint"]), "the button has no explanation of what it will do");
  // The button carries two classes on purpose: the save-bar finder matches
  // `ds-btn` *exactly*, and two bare matches would make which button it finds
  // depend on render order.
  assert.equal(view.elements.filter((el) => el.props.className === "ds-btn").length, 1, "the save-bar finder is now ambiguous");
  // Nothing to cancel, and nothing to open, before the click. The advanced fold
  // is the body's only other button, and it must stay the only one: a cancel
  // button next to a run that is not running is a button that does nothing.
  assert.equal(elements(body.children).some((el) => el.type === "a"), false, "an idle card rendered a link");
  assert.deepEqual(
    elements(body.children)
      .filter((el) => el.type === "button" && !hasClass(el, "ds-onboard-btn"))
      .map((el) => el.props.className),
    ["ds-advanced-toggle"],
    "an idle card offered something other than the advanced fold",
  );
});

test("the two channels with no creation API get the official page instead of a button", () => {
  // Feishu is the only channel that can be automated: Telegram issues a bot
  // inside a conversation with @BotFather and DingTalk only inside its own
  // console. For those the honest thing is the entrance plus an instruction, so
  // a button that cannot work must never appear on their cards.
  const view = render("zh");
  for (const [ch, url] of [["telegram", "https://t.me/BotFather"], ["dingtalk", "https://open-dev.dingtalk.com/"]]) {
    const body = byId(view.elements, `ds-ch-${ch}-body`);
    assert.equal(elements(body.children).some((el) => hasClass(el, "ds-onboard-btn")), false, `${ch} grew a one-click button`);
    const link = elements(body.children).find((el) => el.type === "a" && el.props.href === url);
    assert.ok(link, `${ch} has no link to its official creation page`);
    assert.equal(link.props.rel, "noreferrer noopener", `${ch}'s outbound link leaks the opener/referrer`);
    const text = visibleText(body).join("");
    assert.ok(text.includes(url), `${ch}'s link target is not shown as text`);
    assert.ok(text.includes(view.localeTable.zh[`onboard.manual.${ch}`]), `${ch} has no instruction to paste what it returns`);
  }
});

test("a waiting run shows the link as plain text, and grows no QR node", () => {
  const view = render("zh", {
    onboarding: { busy: false, phase: "waiting", link: { url: LINK, expiresInSeconds: 600, expiresAt: 1 } },
  });
  const L = view.localeTable.zh;
  const body = feishuBody(view);
  const text = visibleText(body).join("");

  assert.ok(text.includes(LINK), "the device-authorization URL is not rendered");
  assert.ok(text.includes(L["onboard.link"]), "the URL is not introduced");
  // The placeholder is substituted, not printed: `{minutes}` on screen would be
  // the string the user is told to act on.
  assert.ok(text.includes(L["onboard.linkExpiry"].replace("{minutes}", "10")), `no expiry sentence for a 10-minute link`);
  const anchor = elements(body.children).find((el) => el.type === "a");
  assert.ok(anchor && anchor.props.href === LINK, "the URL is not a link");
  // The page it opens draws the QR itself. A second copy in the pane would be a
  // second thing to keep right — and the pane has no QR library — so this is the
  // reverse assertion that keeps one from growing here.
  for (const el of elements(body.children)) {
    assert.ok(!["img", "canvas", "svg", "video"].includes(el.type), `the link grew a <${el.type}> node`);
  }
  // Waiting is not a success: the button says so and cannot be pressed again,
  // and the way out is a real cancel (the SDK takes a signal).
  const button = elements(body.children).find((el) => hasClass(el, "ds-onboard-btn"));
  assert.equal(visibleText(button).join(""), L["onboard.waiting"]);
  assert.equal(button.props.disabled, true, "a run in flight is startable again");
  const cancel = elements(body.children).find((el) => el.type === "button" && visibleText(el).join("") === L["onboard.cancel"]);
  assert.ok(cancel, "a waiting run cannot be cancelled");
});

test("before the host answers, the button reports that it is starting", () => {
  // The gap between the click and the first status reply. `link` is absent, so
  // this is the one state where "starting" is the truthful word — and the state
  // must not be a re-enabled button, or a second click opens a second link.
  const view = render("zh", { onboarding: { busy: true } });
  const button = elements(feishuBody(view).children).find((el) => hasClass(el, "ds-onboard-btn"));
  assert.equal(visibleText(button).join(""), view.localeTable.zh["onboard.starting"]);
  assert.equal(button.props.disabled, true);
});

test("clicking start drives the host, and the outcome reaches the save bar", async () => {
  const calls = [];
  const outcome = {
    created: true,
    appId: "cli_created",
    credentialsStored: true,
    legacyMirrorWritten: true,
    // The half that matters: the secret is on disk, the running adapter never
    // picked it up.
    applied: "no",
    subscription: { attempted: true, status: "failed", reason: "99991672 access denied", needsManualAction: true },
    enableRequested: true,
  };
  const done = { phase: "done", channel: "feishu", outcome };
  const rpc = async (endpoint, payload) => {
    calls.push([endpoint, payload]);
    if (endpoint === "onboarding.start") return { ok: true, value: { phase: "waiting", channel: "feishu", link: { url: LINK, expiresInSeconds: 600, expiresAt: 1 } } };
    if (endpoint === "onboarding.status") return { ok: true, value: done };
    return { ok: true, value: SNAPSHOT };
  };

  const pane = mount("zh", [snapshotToForm(SNAPSHOT), "idle", { ...SNAPSHOT.credentials }, ALL_OPEN, ALL_OPEN, [], null], rpc);
  const button = elements(feishuBody(pane.draw()).children).find((el) => hasClass(el, "ds-onboard-btn"));
  await button.props.onClick();

  // The sequence, not just "something was called": the first poll already
  // answered with the terminal phase, so a loop that slept before its first
  // query would have added 1.5s and a second `onboarding.status`. The trailing
  // `settings.get` is the re-read that picks up `channelErrors` — the only place
  // the reason a stored credential did not come up is written down.
  assert.deepEqual(calls, [
    ["onboarding.start", { channel: "feishu" }],
    ["onboarding.status", {}],
    ["settings.get", {}],
  ]);
  assert.equal(pane.queued[6], done, "the terminal status did not land in the seventh slot");

  const view = pane.draw();
  const L = pane.localeTable.zh;
  const rendered = issueLines(view).map((line) => visibleText(line).join(""));
  const has = (needle) => rendered.some((text) => text.includes(needle));

  assert.equal(rendered.length, 6, `expected one line per true fact, got ${JSON.stringify(rendered)}`);
  assert.ok(has(L["onboard.created"]) && has("cli_created"), `no creation line: ${JSON.stringify(rendered)}`);
  // 已落盘 ≠ 已生效 — two lines, never collapsed into one 「已保存」.
  assert.ok(has(L["onboard.credentialsStored"]), "the stored half is missing");
  assert.ok(has(L["onboard.notApplied"]), "the not-in-effect half is missing");
  assert.ok(has(L["onboard.enableRequested"]), "the enable line is missing");
  // The API's own code, verbatim: it is the only part that names what to fix.
  assert.ok(has(L["onboard.subscription.failed"]) && has("99991672 access denied"), "the subscription failure is missing its reason");
  assert.ok(has(L["onboard.needsManual"]), "the work left to the user is not stated");

  // And still where it was: the save bar, which is still the root's last child.
  const footer = view.elements.find((el) => hasClass(el, "ds-footer"));
  const list = view.elements.find((el) => hasClass(el, "ds-issues"));
  assert.ok(elements(footer).includes(list), "the run's report is not in the save bar");
  assert.equal(view.tree.children[view.tree.children.length - 1], footer, "the save bar is no longer pinning to the scroll region");
});

test("cancel reaches the host, and a cancelled run stops offering the dead link", async () => {
  const calls = [];
  const cancelled = { phase: "cancelled", channel: "feishu", outcome: { created: false, reason: "abort" } };
  const rpc = async (endpoint, payload) => {
    calls.push([endpoint, payload]);
    if (endpoint === "onboarding.cancel") return { ok: true, value: cancelled };
    return { ok: true, value: SNAPSHOT };
  };

  const pane = mount("zh", [
    snapshotToForm(SNAPSHOT), "idle", { ...SNAPSHOT.credentials }, ALL_OPEN, ALL_OPEN, [],
    { busy: false, phase: "waiting", link: { url: LINK, expiresInSeconds: 600, expiresAt: 1 } },
  ], rpc);
  const body = feishuBody(pane.draw());
  const cancel = elements(body.children).find((el) => el.type === "button" && visibleText(el).join("") === pane.localeTable.zh["onboard.cancel"]);
  await cancel.props.onClick();

  assert.deepEqual(calls, [["onboarding.cancel", {}]], "cancel is not a single call to the host");
  assert.equal(pane.queued[6], cancelled);
  // The link is retired with the run: a terminal phase means it is spent, and the
  // pane renders it on presence alone — so a dead URL sitting next to 「已取消」
  // would invite a scan of a link Feishu has already invalidated.
  const after = feishuBody(pane.draw());
  assert.equal(visibleText(after).join("").includes(LINK), false, "a cancelled run still shows its link");
});

test("a cancelled run and a failed one read differently, reason and all", () => {
  const linesOf = (onboarding) => issueLines(render("zh", { onboarding })).map((line) => visibleText(line).join(""));
  const L = (render("zh").localeTable).zh;

  const cancelled = linesOf({ phase: "cancelled", outcome: { created: false, reason: "abort" } });
  const failed = linesOf({ phase: "failed", outcome: { created: false, reason: "invalid_app_name" } });

  assert.equal(cancelled.length, 1, `a cancelled run reports ${cancelled.length} lines`);
  assert.equal(failed.length, 1, `a failed run reports ${failed.length} lines`);
  assert.notEqual(cancelled[0], failed[0], "the user's cancel reads the same as a failure");
  assert.ok(cancelled[0].includes(L["onboard.cancelled"]));
  assert.ok(failed[0].includes(L["onboard.createFailed"]));
  // The reason is an SDK code or a thrown message, and it is the only part that
  // names what went wrong, so it is rendered verbatim rather than mapped.
  assert.ok(cancelled[0].includes("abort"), `the host's reason was dropped: ${cancelled[0]}`);
  assert.ok(failed[0].includes("invalid_app_name"), `the host's reason was dropped: ${failed[0]}`);
  // A run that died before creating anything must not claim it created one.
  assert.ok(!failed[0].includes(L["onboard.created"]), "a failed run claimed it created an app");
});
