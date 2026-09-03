/**
 * One-command release gate for dsh-connect. Builds the single package, runs the
 * entire test suite, and syntax-checks the client plugin — exits non-zero if
 * anything fails. Usage: node scripts/verify.mjs
 */
import { spawnSync } from "node:child_process";

const steps = [
  // dsh-connect build + all suites
  { name: "build dsh-connect", cmd: "node", args: ["node_modules/typescript/bin/tsc", "-p", "packages/connect/tsconfig.json"] },
  { name: "build dsh-connect client bundle", cmd: "node", args: ["packages/connect/scripts/build-client.mjs"] },
  { name: "dsh-connect tests", cmd: "node", args: ["packages/connect/test/run-all.mjs"] },
  { name: "client plugin syntax", cmd: "node", args: ["--check", "packages/connect/client/settings-client.mjs"] },
];

let failed = false;
for (const step of steps) {
  process.stdout.write(`\n==> ${step.name}\n`);
  const res = spawnSync(step.cmd, step.args, { stdio: "inherit" });
  process.stdout.write(`    [status=${res.status} signal=${res.signal} error=${res.error ? res.error.code : "none"}]\n`);
  if (res.status !== 0) {
    process.stdout.write(`FAIL: ${step.name}\n`);
    failed = true;
  }
}
process.stdout.write(`\n${failed ? "VERIFY FAILED" : "VERIFY OK (build + all tests green)"}\n`);
process.exit(failed ? 1 : 0);
