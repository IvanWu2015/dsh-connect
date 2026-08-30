/**
 * One-command release gate for dsh-connect. Runs every package build + test
 * suite and exits non-zero if anything fails. Usage: node scripts/verify.mjs
 */
import { spawnSync } from "node:child_process";

const steps = [
  // connecct-all build + all suites
  { name: "build connect-all", cmd: "node", args: ["node_modules/typescript/bin/tsc", "-p", "packages/connect-all/tsconfig.json"] },
  { name: "connect-all tests", cmd: "node", args: ["packages/connect-all/test/run-all.mjs"] },
  // core + feishu + smoke
  { name: "connect tests", cmd: "node", args: ["packages/connect/test/unit.test.mjs"] },
  { name: "connect smoke", cmd: "node", args: ["packages/connect/test/smoke.mjs"] },
  { name: "connect-feishu tests", cmd: "node", args: ["packages/connect-feishu/test/unit.test.mjs"] },
  { name: "client plugin syntax", cmd: "node", args: ["--check", "packages/connect-all/client/settings-client.mjs"] },
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
process.stdout.write(`\n${failed ? "VERIFY FAILED" : "VERIFY OK (all builds + tests green)"}\n`);
process.exit(failed ? 1 : 0);