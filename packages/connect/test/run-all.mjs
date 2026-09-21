/**
 * Test entry point.
 *
 * Two groups, both run as child processes:
 *
 * 1. `node:test` suites, one child per file. Isolation matters because several
 *    suites construct `ConnectService` instances whose reminder loops and cordis
 *    subscriptions outlive the test, and because `feishu.register` without
 *    credentials enters the interactive onboarding flow, which leaves timers
 *    pending. A child process per file keeps each suite self-contained.
 *
 * 2. `smoke.mjs`, as a plain script. It asserts at import time and never exits on
 *    its own (see below), so it cannot run under `--test` — the runner would wait
 *    forever for the child. Its signal is the "SMOKE OK" marker on stdout, or a
 *    non-zero exit when an assertion throws.
 *
 * Previously this file imported everything in-process and ended with an
 * unconditional `process.exit(0)`, defended by a comment about "force a clean
 * exit". That exit fired as soon as the last import finished its top-level work
 * — i.e. mid-run — so most suites never executed and *any* failure was reported
 * as success. The runner now propagates the real status.
 */
import { spawn, spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

const suites = [
  "unit.test.mjs",
  "feishu.test.mjs",
  "telegram.test.mjs",
  "dingtalk.test.mjs",
  "web.test.mjs",
  "settings-rpc.test.mjs",
  "settings-service.test.mjs",
  "rpc-client.test.mjs",
  "credential-store.test.mjs",
  "channels.test.mjs",
  "web-settings-integration.test.mjs",
  "web-settings-roundtrip.test.mjs",
  "settings-model.test.mjs",
  "apply.test.mjs",
  "agent-scope.test.mjs",
  "channel-runtime.test.mjs",
  "settings-namespace.test.mjs",
];

/** Marker `smoke.mjs` prints once every top-level assertion has passed. */
const SMOKE_OK = "SMOKE OK";

/**
 * Run `smoke.mjs` and resolve as soon as it reports success.
 *
 * `smoke.mjs` builds live `ConnectService` instances; their handles survive the
 * assertions, so the script prints its marker and then hangs instead of exiting.
 * We treat the marker as the pass signal and reap the child ourselves. A child
 * that exits before printing it is a failure.
 */
function runSmoke() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(here, "smoke.mjs")], { stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    let settled = false;
    let passed = false;

    const finish = (ok, note) => {
      if (settled) return;
      settled = true;
      if (!passed) {
        process.stdout.write(out);
        if (note !== undefined) console.error(note);
      }
      child.kill();
      resolve(ok);
    };

    child.stdout.on("data", (chunk) => {
      out += String(chunk);
      process.stdout.write(chunk);
      if (out.includes(SMOKE_OK)) {
        passed = true;
        finish(true);
      }
    });
    child.on("error", (error) => finish(false, `smoke.mjs failed to start: ${String(error)}`));
    child.on("exit", (code) => finish(code === 0 && passed, passed ? undefined : `smoke.mjs exited with code ${code} before printing ${JSON.stringify(SMOKE_OK)}`));
  });
}

const result = spawnSync(process.execPath, ["--test", ...suites.map((name) => join(here, name))], { stdio: "inherit" });
if (result.error) throw result.error;
const suitesOk = result.status === 0;

const smokeOk = await runSmoke();

process.exit(suitesOk && smokeOk ? 0 : 1);
