// In-process runner: imports every suite so `pnpm test` runs them all without
// spawning child processes (which the sandbox blocks). Suites registered with
// `node:test` run after the import phase; `smoke.mjs` runs its top-level
// assertions during its import.
await import("./unit.test.mjs");
await import("./feishu.test.mjs");
await import("./telegram.test.mjs");
await import("./dingtalk.test.mjs");
await import("./web.test.mjs");
await import("./settings-rpc.test.mjs");
await import("./settings-service.test.mjs");
await import("./rpc-client.test.mjs");
await import("./credential-store.test.mjs");
await import("./channels.test.mjs");
await import("./web-settings-integration.test.mjs");
await import("./web-settings-roundtrip.test.mjs");
await import("./settings-model.test.mjs");
await import("./apply.test.mjs");
await import("./smoke.mjs");

// Some suites (smoke) construct ConnectService instances whose reminder loops /
// event subscriptions are unref'd but the cordis host keeps a handle — force a
// clean exit so `verify.mjs` doesn't hang waiting on the event loop.
process.exit(0);
