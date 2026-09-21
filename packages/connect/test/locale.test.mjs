import { test } from "node:test";
import assert from "node:assert/strict";

import { LOCALES, LOCALE_KEYS, hasLocale, tr, optionalText } from "../client/locale.mjs";
import { CHANNEL_SECRET_FIELDS, CHANNEL_CONFIG_FIELDS, CHANNEL_DEFAULT_FIELDS } from "../lib/settings/settings-model.js";

/**
 * The pane's language consistency is not a matter of care, it is a matter of
 * coverage.
 *
 * The host resolves `t(key)` as `lookup(ns, key, chain) ?? lookup("common", key,
 * chain) ?? key` and `lookup` walks the **fallback chain** — a key present in
 * `en` but missing from `zh` silently renders the English string. So a Chinese
 * UI with one untranslated key reads as half-English with no error anywhere,
 * which is exactly the "一会中文一会英文" the user reported. Asserting the two
 * languages cover the same key set mechanically is the only fix that stays
 * fixed.
 */

const CHROME_KEYS = [
  "title", "channels", "defaults", "defaultsHint", "save", "saved", "error", "loading",
  "statePath", "statePathHint", "livePlane", "filePlane", "reachable", "unreachable",
  "configured", "current", "notConfigured", "previewNote", "secrets",
  "expand", "collapse", "advanced", "tabsAria",
];

const LANGS = ["zh", "en"];

test("both languages exist and cover exactly the same keys", () => {
  assert.deepEqual(Object.keys(LOCALES).sort(), ["en", "zh"]);
  const zh = Object.keys(LOCALES.zh).sort();
  const en = Object.keys(LOCALES.en).sort();
  assert.deepEqual(zh, en, "a key present in one language only renders the other language's string, silently");
  assert.ok(zh.length > 40, `expected a substantial table, got ${zh.length} keys`);
});

test("every shipped string is a non-empty string", () => {
  // An empty value is worse than a missing one: `??` treats "" as present, so
  // the pane renders nothing at all where a label should be.
  for (const lang of LANGS) {
    for (const [key, value] of Object.entries(LOCALES[lang])) {
      assert.equal(typeof value, "string", `${lang}.${key} is not a string`);
      assert.notEqual(value.trim(), "", `${lang}.${key} is empty`);
    }
  }
});

test("the chrome keys the component renders are all present", () => {
  for (const key of CHROME_KEYS) {
    assert.ok(hasLocale(key), `missing locale for chrome key ${key}`);
  }
  for (const state of ["loading", "idle", "saving", "saved", "error"]) {
    assert.ok(hasLocale(`status.${state}`), `missing locale for status.${state}`);
  }
});

test("every channel has a card label and a hint", () => {
  // Derived from the model, not from a hand-kept list, so a new channel fails
  // here instead of shipping a bare identifier into the UI.
  for (const ch of Object.keys(CHANNEL_SECRET_FIELDS)) {
    assert.ok(hasLocale(`channel.${ch}`), `missing channel.${ch}`);
    assert.ok(hasLocale(`channel.${ch}.hint`), `missing channel.${ch}.hint`);
  }
});

test("every secret field has a label and an explanation", () => {
  for (const [ch, fields] of Object.entries(CHANNEL_SECRET_FIELDS)) {
    for (const field of fields) {
      assert.ok(hasLocale(`s.${ch}.${field}`), `missing s.${ch}.${field}`);
      assert.ok(hasLocale(`s.${ch}.${field}.hint`), `missing s.${ch}.${field}.hint`);
    }
  }
});

test("every config field has a label and an explanation", () => {
  const columns = [...Object.values(CHANNEL_CONFIG_FIELDS), CHANNEL_DEFAULT_FIELDS];
  for (const fields of columns) {
    for (const field of fields) {
      assert.ok(hasLocale(`f.${field.key}`), `missing f.${field.key}`);
      assert.ok(hasLocale(`f.${field.key}.hint`), `missing f.${field.key}.hint`);
    }
  }
});

test("every select option is translated, including the empty one", () => {
  // `(use default)` is what an unset select shows, so it needs a locale too.
  assert.ok(hasLocale("o.default"), "missing the empty-option label");
  const columns = [...Object.values(CHANNEL_CONFIG_FIELDS), CHANNEL_DEFAULT_FIELDS];
  for (const fields of columns) {
    for (const field of fields) {
      for (const option of field.options ?? []) {
        assert.ok(hasLocale(`o.${option}`), `missing o.${option} (from f.${field.key})`);
      }
    }
  }
});

test("tr falls back for an unshipped key instead of rendering the key itself", () => {
  // The host returns the *key* on a miss, which would print `f.dmMode` into the
  // UI; the wrapper is what keeps that a legible label.
  const hostT = (key) => LOCALES.zh[key] ?? key;
  assert.equal(tr(hostT, "channels", "fallback"), "渠道");
  assert.equal(tr(hostT, "f.nope", "Readable label"), "Readable label");
});

test("optionalText yields undefined for an absent key so the node is skipped", () => {
  const hostT = (key) => LOCALES.zh[key] ?? key;
  assert.equal(optionalText(hostT, "f.language.hint"), LOCALES.zh["f.language.hint"]);
  assert.equal(optionalText(hostT, "f.nope.hint"), undefined);
});

test("LOCALE_KEYS matches the shipped table", () => {
  assert.deepEqual([...LOCALE_KEYS].sort(), Object.keys(LOCALES.zh).sort());
});

test("the two languages actually differ, apart from language-neutral names", () => {
  // Catches the other half of the complaint: a string copied from `en` into
  // `zh` (or never translated at all) leaves English text sitting in the middle
  // of a Chinese page. Product names, the vendor's own field names and the
  // section title are legitimately identical in both.
  const LANGUAGE_NEUTRAL = new Set([
    "title",
    "channel.telegram",
    "s.feishu.appId",
    "s.feishu.appSecret",
    "s.telegram.botToken",
    "s.dingtalk.clientId",
    "s.dingtalk.clientSecret",
  ]);
  for (const key of LOCALE_KEYS) {
    if (LANGUAGE_NEUTRAL.has(key)) continue;
    assert.notEqual(LOCALES.zh[key], LOCALES.en[key], `${key} is identical in both languages — untranslated?`);
  }
  const HAN = /[一-鿿]/;
  for (const [key, value] of Object.entries(LOCALES.en)) {
    assert.ok(!HAN.test(value), `en.${key} contains Chinese: ${JSON.stringify(value)}`);
  }
});
