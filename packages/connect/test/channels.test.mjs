import { test } from "node:test";
import assert from "node:assert/strict";

import { extractConfigSecrets, withoutDotPath } from "../lib/settings/channels.js";
import { CHANNEL_SECRET_KEYS } from "../lib/settings/credential-store.js";

test("extractConfigSecrets reads flat secret keys (feishu/telegram)", () => {
  const out = extractConfigSecrets(
    { appId: "cli_1", appSecret: "sec_1", transport: "websocket" },
    "feishu",
    CHANNEL_SECRET_KEYS.feishu,
  );
  assert.deepEqual(out, { appId: "cli_1", appSecret: "sec_1" });
});

test("extractConfigSecrets reads nested secret keys (dingtalk stream)", () => {
  const out = extractConfigSecrets(
    { webhookUrl: "https://x", secret: "s", stream: { clientId: "cid", clientSecret: "cs" } },
    "dingtalk",
    CHANNEL_SECRET_KEYS.dingtalk,
  );
  assert.deepEqual(out, {
    webhookUrl: "https://x",
    secret: "s",
    clientId: "cid",
    clientSecret: "cs",
  });
});

test("extractConfigSecrets returns only non-empty string values", () => {
  const out = extractConfigSecrets(
    { appId: "", appSecret: "sec_1", webhookUrl: 123 },
    "feishu",
    CHANNEL_SECRET_KEYS.feishu,
  );
  assert.deepEqual(out, { appSecret: "sec_1" });
});

test("extractConfigSecrets handles undefined/missing config and nested path", () => {
  assert.deepEqual(extractConfigSecrets(undefined, "feishu", CHANNEL_SECRET_KEYS.feishu), {});
  assert.deepEqual(extractConfigSecrets({}, "feishu", CHANNEL_SECRET_KEYS.feishu), {});
  // dingtalk without a stream sub-object -> clientId/clientSecret absent
  const out = extractConfigSecrets({ webhookUrl: "https://x" }, "dingtalk", CHANNEL_SECRET_KEYS.dingtalk);
  assert.deepEqual(out, { webhookUrl: "https://x" });
});

test("extractConfigSecrets is non-mutating", () => {
  const config = { appId: "cli_1", appSecret: "sec_1" };
  const before = JSON.stringify(config);
  extractConfigSecrets(config, "feishu", CHANNEL_SECRET_KEYS.feishu);
  assert.equal(JSON.stringify(config), before);
});

test("withoutDotPath drops a flat key and a nested one", () => {
  assert.deepEqual(withoutDotPath({ appId: "a", appSecret: "b" }, "appSecret"), { appId: "a" });
  assert.deepEqual(
    withoutDotPath({ language: "zh", stream: { clientId: "c", clientSecret: "d", url: "u" } }, "stream.clientSecret"),
    { language: "zh", stream: { clientId: "c", url: "u" } },
  );
});

// The whole reason this helper exists rather than reusing `writeDotPath` with an
// `undefined`: the caller (`withoutSecrets`) starts from a *shallow* copy of the
// live config, so a mutating delete would reach through that copy into the
// running config and strip the credential the adapter is still holding. Without
// this assertion the aliasing bug is invisible — the filtered copy looks right.
test("withoutDotPath never reaches into the object it was handed", () => {
  const stream = { clientId: "c", clientSecret: "d" };
  const config = { language: "zh", stream };
  const filtered = withoutDotPath(config, "stream.clientSecret");
  assert.deepEqual(filtered, { language: "zh", stream: { clientId: "c" } });
  assert.deepEqual(config, { language: "zh", stream: { clientId: "c", clientSecret: "d" } });
  assert.notEqual(filtered.stream, stream);
});

test("withoutDotPath leaves a missing path, a scalar branch and a wrong path alone", () => {
  // Absent: a copy, unchanged — callers may hold on to the result either way.
  assert.deepEqual(withoutDotPath({ appId: "a" }, "appSecret"), { appId: "a" });
  assert.deepEqual(withoutDotPath({ appId: "a" }, "stream.clientId"), { appId: "a" });
  // A scalar where the branch was expected: replacing it to make room would
  // destroy a value the user set by hand (same stance as `writeDotPath`).
  assert.deepEqual(withoutDotPath({ stream: "oops" }, "stream.clientId"), { stream: "oops" });
});
