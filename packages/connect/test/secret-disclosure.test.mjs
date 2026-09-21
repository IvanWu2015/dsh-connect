import { test } from "node:test";
import assert from "node:assert/strict";

import { disclosureOf, isMaskedSecret, maskSecret, SECRET_DISCLOSURE } from "../lib/settings/secret-disclosure.js";

// Realistic lengths matter here: the short values used elsewhere in the suite
// (5 chars) fall into the all-bullets branch, which would make a "the middle is
// gone" assertion pass without the head/tail logic ever running.
const APP_ID = "cli_a1b2c3d4e5f6g7h8";
const APP_SECRET = "a1b2c3d4e5f6g7h8i9j0k1l2m3n4z9y8"; // 32 chars
const WEBHOOK = "https://oapi.dingtalk.com/robot/send?access_token=0123456789abcdef0123456789abcdef";

test("identifiers are disclosed in full, authenticators are not", () => {
  assert.equal(disclosureOf("appId"), "full");
  assert.equal(disclosureOf("clientId"), "full");
  assert.equal(disclosureOf("appSecret"), "mask");
  assert.equal(disclosureOf("clientSecret"), "mask");
  assert.equal(disclosureOf("botToken"), "mask");
  assert.equal(disclosureOf("secret"), "mask");
  assert.equal(disclosureOf("webhookUrl"), "url");
  // Unknown keys default to the conservative policy, not to disclosure.
  assert.equal(disclosureOf("somethingNew"), "mask");
  assert.equal(isMaskedSecret("appId"), false);
  assert.equal(isMaskedSecret("appSecret"), true);
  assert.equal(isMaskedSecret("whatIsThis"), true);
});

test("every key in the policy table is a plausible credential field name", () => {
  // A guard against the table growing a typo'd key that silently applies the
  // default: each entry must round-trip through `disclosureOf`.
  for (const [key, policy] of Object.entries(SECRET_DISCLOSURE)) {
    assert.equal(disclosureOf(key), policy, `${key} is not reachable through disclosureOf`);
  }
});

test("appId is shown whole so a typo is visible before it is saved", () => {
  assert.equal(maskSecret("appId", APP_ID), APP_ID);
  // A pasted value with surrounding whitespace previews as the stored value.
  assert.equal(maskSecret("appId", `  ${APP_ID}\n`), APP_ID);
});

test("a long secret keeps only its first and last four characters", () => {
  const masked = maskSecret("appSecret", APP_SECRET);
  assert.equal(masked, "a1b2…z9y8");
  assert.ok(!masked.includes(APP_SECRET));
  // The middle must not survive -- that is the part a shoulder-surfer wants.
  assert.ok(!masked.includes(APP_SECRET.slice(12, 20)));
  assert.equal(maskSecret("botToken", APP_SECRET), "a1b2…z9y8");
});

test("a short value collapses to a fixed-width mask instead of leaking itself", () => {
  // 4+4 of a 10-character value would print it in full.
  assert.equal(maskSecret("appSecret", "sec_9abcde"), "••••••");
  assert.equal(maskSecret("appSecret", "sec_9"), "••••••");
  // ...and the width doesn't betray the length either.
  assert.equal(maskSecret("appSecret", "x"), maskSecret("appSecret", "12345678901"));
});

test("an empty value has no preview at all", () => {
  assert.equal(maskSecret("appSecret", ""), "");
  assert.equal(maskSecret("appSecret", "   \n "), "");
  assert.equal(maskSecret("appId", ""), "");
});

test("a webhook keeps its host and path, and masks only the token", () => {
  const masked = maskSecret("webhookUrl", WEBHOOK);
  assert.equal(masked, "https://oapi.dingtalk.com/robot/send?access_token=0123…cdef");
  // Whole-URL masking would have produced "http…cdef", which tells the user
  // nothing about whether they pasted the right robot.
  assert.ok(masked.includes("oapi.dingtalk.com/robot/send"));
  assert.ok(!masked.includes("0123456789abcdef0123456789abcdef"));
  // The ellipsis stays literal rather than being percent-encoded by a
  // re-serialize through URLSearchParams.
  assert.ok(!masked.includes("%E2%80%A6"));
});

test("innocent query parameters are left alone", () => {
  const masked = maskSecret("webhookUrl", "https://example.com/hook?robot=42&access_token=0123456789abcdef0123456789abcdef&x=1");
  assert.ok(masked.includes("robot=42"));
  assert.ok(masked.includes("x=1"));
  assert.ok(masked.includes("access_token=0123…cdef"));
});

test("a percent-encoded token is decoded for measuring, then masked readably", () => {
  const masked = maskSecret("webhookUrl", "https://example.com/hook?access_token=a1b2c3d4e5f6g7h8%2Fz9y8");
  assert.ok(masked.includes("a1b2…z9y8"));
  assert.ok(!masked.includes("a1b2c3d4e5f6g7h8"));
});

test("an unparseable webhookUrl falls back to the plain mask", () => {
  // A bare token pasted into the URL field: masking "middle-out" is the honest
  // answer, and the result is still lossy.
  const masked = maskSecret("webhookUrl", "0123456789abcdef0123456789abcdef");
  assert.equal(masked, "0123…cdef");
  assert.equal(maskSecret("webhookUrl", "not a url"), "••••••");
});

test("an access_token with an empty value is left as-is rather than masked", () => {
  const value = "https://example.com/hook?access_token=&robot=1";
  assert.equal(maskSecret("webhookUrl", value), value);
});

test("maskSecret never returns a value it was asked to hide", () => {
  // The property that makes the preview safe to hand to a browser: for every
  // `mask`-policy key the output is strictly shorter than the input.
  for (const key of ["appSecret", "clientSecret", "botToken", "secret"]) {
    const masked = maskSecret(key, APP_SECRET);
    assert.notEqual(masked, APP_SECRET);
    assert.ok(masked.length < APP_SECRET.length);
  }
});
