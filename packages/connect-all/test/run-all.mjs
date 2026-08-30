// In-process runner: imports every suite so `pnpm test` runs them all without
// spawning child processes (which the sandbox blocks).
await import("./unit.test.mjs");
await import("./apply.test.mjs");
await import("./settings-rpc.test.mjs");
await import("./settings-service.test.mjs");
await import("./rpc-client.test.mjs");
await import("./credential-store.test.mjs");
await import("./web-settings-integration.test.mjs");
await import("./web-settings-roundtrip.test.mjs");
await import("./settings-model.test.mjs");