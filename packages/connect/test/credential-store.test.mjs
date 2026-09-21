import { test } from "node:test";
import assert from "node:assert/strict";

import { createCredentialStore, CHANNEL_SECRET_KEYS, CREDENTIAL_REFS } from "../lib/settings/credential-store.js";

/** Build the ref-keyed payload `save` takes, from config-key values. */
function refValues(channel, values) {
  const map = CHANNEL_SECRET_KEYS[channel];
  const out = {};
  for (const [configKey, ref] of Object.entries(map)) {
    if (values[configKey] !== undefined) out[ref] = values[configKey];
  }
  return out;
}

// A minimal in-memory DSH credentials provider.
function fakeProvider() {
  const store = new Map();
  return {
    store,
    async resolve(ref) { return store.get(ref) ?? null; },
    async describe(ref) { return { configured: store.has(ref), source: store.has(ref) ? "mem" : "unset" }; },
    async set(ref, value) { store.set(ref, value); },
    async unset(ref) { store.delete(ref); },
  };
}

test("configured is false until the channel secrets exist", async () => {
  const creds = createCredentialStore(fakeProvider());
  assert.equal(await creds.configured("feishu"), false);
  assert.equal(await creds.configured("telegram"), false);
});

test("save then configured reflects presence; clear reverts it", async () => {
  const provider = fakeProvider();
  const creds = createCredentialStore(provider);
  const [idRef, secretRef] = CREDENTIAL_REFS.feishu;
  await creds.save("feishu", { [idRef]: "cli_1", [secretRef]: "sec_1" });
  assert.equal(await creds.configured("feishu"), true);
  await creds.clear("feishu");
  assert.equal(await creds.configured("feishu"), false);
  assert.equal(provider.store.size, 0);
});

test("save requires every ref of a channel to be configured", async () => {
  const creds = createCredentialStore(fakeProvider());
  const [idRef] = CREDENTIAL_REFS.feishu;
  await creds.save("feishu", { [idRef]: "cli_1" });
  assert.equal(await creds.configured("feishu"), false);
});

// Regression: `web` mirrors the DSH Web UI in-process and holds no secret, so a
// flat "no refs -> false" rule made its pane badge claim 未配置凭据 forever.
test("web needs no credentials -> configured true, save/clear no-op", async () => {
  const provider = fakeProvider();
  const creds = createCredentialStore(provider);
  assert.equal(await creds.configured("web"), true);
  assert.deepEqual(CREDENTIAL_REFS.web, []);
  await creds.save("web", {});
  await creds.clear("web");
  assert.equal(provider.store.size, 0);
});

// DingTalk exposes two mutually exclusive transports. Requiring ALL refs would
// mark a working webhook-only (or stream-only) channel as unconfigured.
test("dingtalk is satisfied by the webhook group alone", async () => {
  const provider = fakeProvider();
  const creds = createCredentialStore(provider);
  await creds.save("dingtalk", refValues("dingtalk", { webhookUrl: "https://x/hook", secret: "sign" }));
  assert.equal(await creds.configured("dingtalk"), true);
});

test("dingtalk is satisfied by the stream group alone", async () => {
  const provider = fakeProvider();
  const creds = createCredentialStore(provider);
  await creds.save("dingtalk", refValues("dingtalk", { clientId: "id", clientSecret: "sec" }));
  assert.equal(await creds.configured("dingtalk"), true);
});

test("dingtalk stays unconfigured when neither group is complete", async () => {
  const provider = fakeProvider();
  const creds = createCredentialStore(provider);
  await creds.save("dingtalk", refValues("dingtalk", { webhookUrl: "https://x/hook", clientId: "id" }));
  assert.equal(await creds.configured("dingtalk"), false);
});

// Regression: the write set used to come from the flat ref list, which only
// carried DingTalk's webhook refs — the two stream refs were dropped while the
// RPC still answered `ok: true`, so the pane said "saved" and nothing persisted.
test("dingtalk save persists all four secret keys, and clear removes them all", async () => {
  const provider = fakeProvider();
  const creds = createCredentialStore(provider);
  await creds.save("dingtalk", refValues("dingtalk", {
    webhookUrl: "https://x/hook",
    secret: "sign",
    clientId: "id",
    clientSecret: "sec",
  }));
  assert.equal(provider.store.size, 4);
  assert.deepEqual(await creds.get("dingtalk"), {
    webhookUrl: "https://x/hook",
    secret: "sign",
    clientId: "id",
    clientSecret: "sec",
  });
  await creds.clear("dingtalk");
  assert.equal(provider.store.size, 0);
});

test("createCredentialStore requires a provider with all methods", () => {
  assert.throws(() => createCredentialStore({}), /credential provider/);
  assert.throws(() => createCredentialStore({ resolve() {}, set() {}, unset() {} }), /describe/);
});

// Regression: `@deepseek-ai/dsh-credentials` declares
// `resolve(ref): Promise<ResolvedCredential | undefined>` where ResolvedCredential
// is `{ value, source }` — NOT a bare string. Reading it as a string made `get()`
// discard every value, so the pane never prefilled appId and `injectSecrets`
// never merged store-backed secrets into a channel config.
test("get unwraps the host's {value, source} resolution shape", async () => {
  const store = new Map([
    ["DSH_CONNECT_FEISHU_APP_ID", "cli_9"],
    ["DSH_CONNECT_FEISHU_APP_SECRET", "sec_9"],
  ]);
  const creds = createCredentialStore({
    async resolve(ref) {
      const value = store.get(ref);
      return value === undefined ? undefined : { value, source: "file" };
    },
    async describe(ref) { return { configured: store.has(ref) }; },
    async set(ref, value) { store.set(ref, value); },
    async unset(ref) { store.delete(ref); },
  });
  assert.deepEqual(await creds.get("feishu"), { appId: "cli_9", appSecret: "sec_9" });
});

test("get still accepts a provider that resolves to a bare string, and drops empties", async () => {
  const creds = createCredentialStore({
    async resolve(ref) { return ref.endsWith("APP_ID") ? "cli_9" : ""; },
    async describe() { return { configured: true }; },
    async set() {},
    async unset() {},
  });
  // An empty resolved value is "unconfigured", never prefilled.
  assert.deepEqual(await creds.get("feishu"), { appId: "cli_9" });
});

test("get returns stored secrets keyed by config key", async () => {
  const provider = fakeProvider();
  const creds = createCredentialStore(provider);
  const [idRef, secretRef] = CREDENTIAL_REFS.feishu;
  await creds.save("feishu", { [idRef]: "cli_1", [secretRef]: "sec_1" });
  const secrets = await creds.get("feishu");
  assert.deepEqual(secrets, { appId: "cli_1", appSecret: "sec_1" });
});

test("get returns only configured keys and empty for web", async () => {
  const creds = createCredentialStore(fakeProvider());
  const [idRef] = CREDENTIAL_REFS.feishu;
  await creds.save("feishu", { [idRef]: "cli_1" });
  const secrets = await creds.get("feishu");
  assert.deepEqual(secrets, { appId: "cli_1" });
  assert.deepEqual(await creds.get("web"), {});
});

