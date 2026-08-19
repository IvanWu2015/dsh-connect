import { test } from "node:test";
import assert from "node:assert/strict";

import { signDingtalk, verifyDingtalkSignature, DingtalkWebhook } from "../lib/index.js";

test("signDingtalk produces a stable HMAC-SHA256 base64 signature", () => {
  const a = signDingtalk("SEC123", 1700000000000);
  const b = signDingtalk("SEC123", 1700000000000);
  assert.equal(a, b);
  assert.ok(a.length > 20);
  assert.notEqual(a, signDingtalk("SEC456", 1700000000000));
  assert.notEqual(a, signDingtalk("SEC123", 1700000000001));
});

test("verifyDingtalkSignature accepts a matching signature and rejects others", () => {
  const secret = "SECabc";
  const ts = "1700000000000";
  const good = signDingtalk(secret, Number(ts));
  assert.equal(verifyDingtalkSignature(secret, ts, good), true);
  assert.equal(verifyDingtalkSignature(secret, ts, "tampered"), false);
  assert.equal(verifyDingtalkSignature("SECother", ts, good), false);
});

test("DingtalkWebhook requires an https:// webhookUrl", () => {
  assert.throws(() => new DingtalkWebhook({ webhookUrl: "http://oapi.dingtalk.com/robot/send?access_token=x" }));
  assert.throws(() => new DingtalkWebhook({ webhookUrl: "not-a-url" }));
  assert.doesNotThrow(() => new DingtalkWebhook({ webhookUrl: "https://oapi.dingtalk.com/robot/send?access_token=x" }));
});

test("DingtalkWebhook.send builds a signed URL and posts markdown JSON", async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
    return { ok: true, status: 200, json: async () => ({ errcode: 0, errmsg: "ok" }) };
  };

  try {
    const webhook = new DingtalkWebhook({
      webhookUrl: "https://oapi.dingtalk.com/robot/send?access_token=abc",
      secret: "SECs",
    });
    const result = await webhook.sendMarkdown("标题", "**正文**", { mobiles: ["13800000000"], all: false });
    assert.deepEqual(result, { errcode: 0, errmsg: "ok" });
    assert.equal(calls.length, 1);
    const call = calls[0];
    assert.ok(call.url.startsWith("https://oapi.dingtalk.com/robot/send?access_token=abc&timestamp="));
    assert.ok(call.url.includes("&sign="));
    const body = call.body;
    assert.equal(body.msgtype, "markdown");
    assert.equal(body.markdown.title, "标题");
    assert.equal(body.markdown.text, "**正文**");
    assert.deepEqual(body.at.atMobiles, ["13800000000"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("DingtalkWebhook.sendText posts a text body without at when omitted", async () => {
  const originalFetch = globalThis.fetch;
  let captured;
  globalThis.fetch = async (_input, init) => {
    captured = JSON.parse(String(init?.body));
    return { ok: true, status: 200, json: async () => ({ errcode: 0, errmsg: "ok" }) };
  };
  try {
    const webhook = new DingtalkWebhook({ webhookUrl: "https://oapi.dingtalk.com/robot/send?access_token=abc" });
    await webhook.sendText("hello");
    assert.equal(captured.msgtype, "text");
    assert.equal(captured.text.content, "hello");
    assert.equal(captured.at, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("DingtalkWebhook surfaces DingTalk business errors", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ errcode: 310000, errmsg: "keywords not in content" }),
  });
  try {
    const webhook = new DingtalkWebhook({ webhookUrl: "https://oapi.dingtalk.com/robot/send?access_token=abc" });
    await assert.rejects(() => webhook.sendText("boom"), /310000/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
