import { test } from "node:test";
import assert from "node:assert/strict";

import { extractConfigSecrets } from "../lib/settings/channels.js";
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
