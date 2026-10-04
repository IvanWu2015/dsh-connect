import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The manifest, as bytes.
 *
 * This suite exists because of a release 1.0.2 nearly shipped: `bump-version.ps1`
 * round-tripped the manifest through `ConvertFrom-Json | ConvertTo-Json` and
 * wrote it back with `Set-Content -Encoding UTF8`, which on Windows PowerShell
 * 5.1 means "UTF-8 *with BOM*". DSH parses plugin manifests with a strict JSON
 * parser, so the package did not merely look untidy — the plugin was skipped
 * whole ("skipping profile bundle ... is not valid JSON") and every feature it
 * provides disappeared.
 *
 * Nothing else in this repo would have caught it. `mocha`-style fixtures do not
 * read this file, `require()` would have hidden it (Node's CJS JSON loader
 * strips the BOM), and the tarball still builds. The only observer that agrees
 * with DSH is `JSON.parse` on the raw text — which is what the first test does,
 * deliberately, rather than trusting a friendlier loader.
 *
 * So: bytes, not just "does the object look right".
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const PKG_DIR = path.resolve(here, "..");
const MANIFEST = path.join(PKG_DIR, "package.json");
const ROOT_MANIFEST = path.resolve(PKG_DIR, "..", "..", "package.json");
const BUMP_SCRIPT = path.resolve(PKG_DIR, "..", "..", "scripts", "bump-version.ps1");

/** Read as text, exactly as a strict parser would, BOM and all. */
const rawText = (file) => fs.readFileSync(file, "utf8");

test("the plugin manifest is strict JSON — no BOM, and a strict parser accepts it", () => {
  const bytes = fs.readFileSync(MANIFEST);
  // Read as utf8 first: that keeps a BOM in the string as U+FEFF, which is the
  // shape that breaks `JSON.parse`. A byte-level check on top gives the failure
  // a readable name instead of a column number.
  const text = rawText(MANIFEST);
  assert.notEqual(bytes[0], 0xef, "package.json starts with a UTF-8 BOM — DSH will skip the plugin bundle");
  assert.equal(bytes[0], 0x7b, `package.json does not start with '{' (first byte 0x${bytes[0].toString(16)})`);
  assert.equal(text.charCodeAt(0), 0x7b, "package.json begins with U+FEFF — DSH will skip the plugin bundle");

  let parsed;
  assert.doesNotThrow(() => { parsed = JSON.parse(text); }, "a strict JSON parser rejects the manifest, as DSH's does");
  assert.equal(parsed.name, "dsh-connect");
});

test("the workspace manifest parses strictly too", () => {
  const bytes = fs.readFileSync(ROOT_MANIFEST);
  assert.notEqual(bytes[0], 0xef, "the root package.json carries a BOM");
  const parsed = JSON.parse(rawText(ROOT_MANIFEST));
  assert.equal(parsed.private, true);
});

test("the version is a plain semver at the top level, and appears exactly once", () => {
  const text = rawText(MANIFEST);
  const parsed = JSON.parse(text);
  assert.match(parsed.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, "the version is not a semver");

  // The bump script anchors on `^"version"`. A second, indented copy nested
  // somewhere would not be rewritten by it — and would then disagree with this
  // one — so the assumption behind that regex is asserted here rather than
  // assumed. (One line only: a top-level key, in this file's 2-space style.)
  const lines = text.split("\n").filter((line) => /^\s*"version"\s*:/.test(line));
  assert.equal(lines.length, 1, `expected one "version" line, found ${lines.length}`);
  assert.equal(lines[0], `  "version": ${JSON.stringify(parsed.version)},`, "the version line is not in the anchored shape the bump script rewrites");
});

test("the bump script rewrites the manifest without a BOM and without a JSON round trip", () => {
  // A static check, on purpose. The defect was a two-line idiom inside a
  // PowerShell script that no runtime test on this machine can execute portably
  // (pwsh is not guaranteed present), and the idiom is the thing that must not
  // come back: `ConvertTo-Json` re-emits the whole document and `Set-Content
  // -Encoding UTF8` prepends the BOM on Windows PowerShell 5.1.
  const script = rawText(BUMP_SCRIPT);
  assert.ok(script.length > 0, "bump-version.ps1 is empty or missing");

  // Comments are stripped first: the script names both idioms in the comment
  // that explains why they are gone, and a check that cannot tell code from the
  // warning about the code would fail on its own documentation.
  const code = script
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");

  assert.ok(
    !/Set-Content[^\n]*-Encoding\s+UTF8/.test(code),
    "bump-version.ps1 writes with `Set-Content -Encoding UTF8`, which prepends a BOM on Windows PowerShell 5.1",
  );
  assert.ok(
    !/ConvertTo-Json/.test(code),
    "bump-version.ps1 serializes the manifest with ConvertTo-Json — that rewrites every byte of the file",
  );
  assert.ok(
    /\[System\.IO\.File\]::WriteAllText/.test(code),
    "bump-version.ps1 no longer writes through WriteAllText — check how it writes the manifest",
  );
  assert.ok(
    /UTF8Encoding\(\$false\)/.test(code),
    "bump-version.ps1 must construct UTF8Encoding($false) — the encoder without a BOM preamble",
  );
  // And the anchoring the version-line test above depends on.
  assert.ok(
    code.includes('(?m)^(\\s*"version"\\s*:\\s*")[^"]*(")'),
    "bump-version.ps1 no longer anchors on the top-level version line",
  );
});
