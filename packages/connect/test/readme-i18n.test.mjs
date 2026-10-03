import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The two `README.i18n.yaml` manifests are the only machine-checkable record
 * that the bilingual README pair was in sync at the last edit. Their own header
 * names the procedure — `git hash-object README.md README.zh.md` — and nothing
 * verified the result.
 *
 * That is how `README.i18n.yaml` came to hold a **39-character** hash for
 * `README.md` for at least one release. It is not a hash of anything, so the
 * line had been quietly unverifiable: re-recording it by eye ("that looks like
 * the hash I saw") would keep the corruption, and a stale-but-well-formed hash
 * would claim consistency that no longer exists. Both failure modes are
 * invisible on inspection and obvious to a comparison, so the comparison is a
 * test rather than a habit.
 *
 * The command used here is deliberately the one in the header, filters and all:
 * the point is to check the recorded value against the documented procedure, so
 * if the procedure is wrong the test has to fail too.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");

const MANIFESTS = [
  { manifest: "README.i18n.yaml", readmes: ["README.md", "README.zh.md"] },
  { manifest: "packages/connect/README.i18n.yaml", readmes: ["packages/connect/README.md", "packages/connect/README.zh.md"] },
];

/** Parse `key: hash` lines, ignoring the `#` header. */
function recordedHashes(text) {
  const out = new Map();
  for (const line of text.split(/\r?\n/)) {
    const match = /^([A-Za-z0-9._-]+): ([^\s]+)$/.exec(line.trim());
    if (match) out.set(match[1], match[2]);
  }
  return out;
}

const gitAvailable = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: repoRoot, encoding: "utf8" }).stdout?.trim() === "true";

test("every README.i18n.yaml records a real git blob hash for each side", (t) => {
  // An exported tarball has no `.git` to hash against, and that is not a defect
  // in the docs — so this is a skip, not a pass. It is loud about which it was.
  if (!gitAvailable) return t.skip("not a git working tree: nothing to hash against");

  for (const { manifest, readmes } of MANIFESTS) {
    const recorded = recordedHashes(readFileSync(join(repoRoot, manifest), "utf8"));
    assert.deepEqual(
      [...recorded.keys()].sort(),
      readmes.map((file) => file.split("/").pop()).sort(),
      `${manifest} must record exactly one hash per side of the pair`,
    );

    for (const readme of readmes) {
      const key = readme.split("/").pop();
      const value = recorded.get(key);

      // A truncated hash is the failure that actually happened: it reads as a
      // hash, so only its length gives it away.
      assert.match(value, /^[0-9a-f]{40}$/, `${manifest} records a malformed ${key} hash: ${JSON.stringify(value)} (${value.length} chars, need 40)`);

      const actual = execFileSync("git", ["hash-object", readme], { cwd: repoRoot, encoding: "utf8" }).trim();
      assert.equal(
        value,
        actual,
        `${manifest} is stale for ${key}: it claims a consistent pair, but that side changed since the manifest was recorded. Re-record with the procedure in the file's own header.`,
      );
    }
  }
});
