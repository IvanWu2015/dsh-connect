import { test } from "node:test";
import assert from "node:assert/strict";

import { createCredentialStore, CREDENTIAL_REFS } from "../lib/settings/credential-store.js";

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

test("web has no credential refs -> always false, save/clear no-op", async () => {
  const provider = fakeProvider();
  const creds = createCredentialStore(provider);
  assert.equal(await creds.configured("web"), false);
  assert.deepEqual(CREDENTIAL_REFS.web, []);
  await creds.save("web", {});
  await creds.clear("web");
  assert.equal(provider.store.size, 0);
});

test("createCredentialStore requires a provider with all methods", () => {
  assert.throws(() => createCredentialStore({}), /credential provider/);
  assert.throws(() => createCredentialStore({ resolve() {}, set() {}, unset() {} }), /describe/);
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

