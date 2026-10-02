/**
 * The pre-0.2 pane-settings migration, against real files.
 *
 * The migration is the one part of the settings work that runs unattended on
 * somebody else's machine, at boot, over documents it did not write — so the
 * failures it has to survive are the boring ones: a file that is not there, one
 * that is half-written, a home directory that is read-only, a profile entry the
 * host refuses. Each degrades to a warning and leaves both files where they are,
 * which is why the assertions below are mostly about what *did not* happen (no
 * marker, no write, no secret).
 *
 * Two of these are load bearing in a way the pane cannot show:
 *
 * 1. **A partial section is destructive.** `replace()` resets every field a
 *    section omits, so an import carrying only the legacy keys would clear the
 *    user's channel list — i.e. the migration would switch every adapter off.
 *    The write is therefore always `mergeSections(current, legacy)`.
 * 2. **The fallback state file is flat.** `settings-service`'s `persist()`
 *    stringifies the config itself, so the file has no `dsh-connect` wrapper.
 *    Reading it with the document reader finds no section and — worse than
 *    failing — marks the migration done, silently discarding the only copy a
 *    user who never had a live settings peer ever had.
 * 3. **The one-shot marker hangs off the profile entry**, not off the state file
 *    it used to (`legacyMarkerPath`). The state path is the user's to move
 *    (`stateDir`, `DSH_CONNECT_STATE_DIR`, `settingsStatePath`) and to delete;
 *    the entry is per-profile and stable, so it is the only anchor under which
 *    "already imported" stays true.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  LEGACY_IMPORT_MARKER,
  importLegacySection,
  legacyCandidates,
  legacyMarkerPath,
  resolveHarnessHome,
  sectionFromDocument,
  sectionOfStateDocument,
} from "../lib/settings/legacy-import.js";

// --- fixtures ------------------------------------------------------------

function tempDir() {
  return mkdtempSync(join(tmpdir(), "dsh-connect-legacy-"));
}

/**
 * A stand-in for `~/.dsh/profiles/<profile>/cordis.patch.yml` — the profile
 * entry the import writes to, which is also the anchor the one-shot marker is
 * named after. Its own directory, because that is what makes the anchor real:
 * the marker has to sit beside the entry and nowhere else.
 */
function tempEntry() {
  return join(tempDir(), "cordis.patch.yml");
}

/** Where the one-shot marker for that entry belongs. */
function markerFor(entry) {
  return join(dirname(entry), LEGACY_IMPORT_MARKER);
}

/** A `settings.yaml`-style document: sections keyed by plugin name. */
function documentWith(section) {
  return `dsh-connect:\n${section}ui-settings-general:\n  locale: en\n`;
}

const DOCUMENT_WITH_CHANNELS = documentWith(
  `  channels:\n    - feishu\n  feishu:\n    transport: websocket\n    appSecret: s3cret-value\n  channelDefaults:\n    language: zh\n`,
);

const DOCUMENT_WITHOUT_CHANNELS = documentWith(
  `  feishu:\n    transport: webhook\n    appSecret: s3cret-value\n`,
);

/** Collect the writes, the warnings and the info lines a run produced. */
function spy() {
  const writes = [];
  const warnings = [];
  const infos = [];
  return {
    writes,
    warnings,
    infos,
    write: async (section) => {
      writes.push(section);
    },
    logger: {
      warn: (message) => warnings.push(message),
      info: (message) => infos.push(message),
    },
  };
}

/** Read a file the test just wrote, asserting it is really there. */
function contents(path) {
  assert.ok(existsSync(path), `expected ${path} to exist`);
  return readFileSync(path, "utf8");
}

/** Run a body with `$DSH_HOME` set (or unset when `value` is `undefined`), then restore it. */
function withDshHome(value, body) {
  const before = process.env.DSH_HOME;
  if (value === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = value;
  try {
    return body();
  } finally {
    if (before === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = before;
  }
}

// --- resolveHarnessHome --------------------------------------------------

test("resolveHarnessHome prefers an explicit home over the environment", () =>
  withDshHome("/from/env", () => {
    // `profileContext.home` is the host's answer and also covers a home
    // configured outside the environment, so it must not be second-guessed.
    assert.equal(resolveHarnessHome("/from/profile"), "/from/profile");
  }));

test("resolveHarnessHome falls back to $DSH_HOME, then to ~/.dsh", () =>
  withDshHome("/from/env", () => {
    assert.equal(resolveHarnessHome(), "/from/env");
  }));

test("resolveHarnessHome treats a blank home as unset", () => {
  // A blank override must not resolve the home to the filesystem root, or to
  // the cwd: `join("", "settings.yaml")` is a relative path.
  withDshHome("   ", () => {
    assert.equal(resolveHarnessHome(), join(homedir(), ".dsh"));
    assert.equal(resolveHarnessHome(""), join(homedir(), ".dsh"));
    assert.equal(resolveHarnessHome("  \t "), join(homedir(), ".dsh"));
  });
  withDshHome(undefined, () => {
    assert.equal(resolveHarnessHome(), join(homedir(), ".dsh"));
  });
});

test("resolveHarnessHome expands a leading ~, which is a literal string to Node", () => {
  // `DSH_HOME=~/.dsh` is a natural thing to write in a shell profile and a
  // perfectly literal path to Node: left alone, the migration reads a directory
  // named `~` under the process cwd, finds nothing there, and marks itself done
  // — permanently, silently — against a home that does not exist.
  withDshHome("~/.dsh", () => assert.equal(resolveHarnessHome(), join(homedir(), ".dsh")));
  withDshHome("~", () => assert.equal(resolveHarnessHome(), homedir()));
  assert.equal(resolveHarnessHome("~/custom"), join(homedir(), "custom"));
  // Only the `~` forms are rewritten; everything else comes back as given, which
  // is what keeps the host's own `profileContext.home` whole.
  assert.equal(resolveHarnessHome("/from/profile"), "/from/profile");
});

// --- legacyCandidates ----------------------------------------------------

test("legacyCandidates reads the home documents first and the state file last", () => {
  const candidates = legacyCandidates({ home: "/home/dsh", statePath: "/state/settings.json" });
  assert.deepEqual(candidates, [
    { path: join("/home/dsh", "settings.yaml"), shape: "document" },
    { path: join("/home/dsh", "settings.yaml.imported"), shape: "document" },
    { path: "/state/settings.json", shape: "section" },
  ]);
});

test("legacyCandidates omits a state path that is absent or blank", () => {
  const home = legacyCandidates({ home: "/home/dsh" });
  assert.equal(home.length, 2);
  assert.deepEqual(home.map((candidate) => candidate.shape), ["document", "document"]);
  assert.equal(legacyCandidates({ home: "/home/dsh", statePath: "   " }).length, 2);
});

// --- the two readers -----------------------------------------------------

test("sectionFromDocument projects the dsh-connect section and drops everything else", () => {
  const section = sectionFromDocument({
    "dsh-connect": {
      channels: ["feishu"],
      feishu: { transport: "websocket", appSecret: "s3cret" },
      channelDefaults: { language: "zh" },
    },
    "ui-settings-general": { locale: "en" },
  });
  assert.deepEqual(section, {
    channels: ["feishu"],
    channelDefaults: { language: "zh" },
    feishu: { transport: "websocket" },
  });
  assert.ok(!JSON.stringify(section).includes("s3cret"));
});

test("sectionFromDocument leaves an absent channels key absent", () => {
  // This is a *source*, not a write: defaulting `channels` here would read as
  // "the legacy document chose every channel" and override the profile.
  assert.deepEqual(sectionFromDocument({ "dsh-connect": { feishu: { transport: "webhook" } } }), {
    feishu: { transport: "webhook" },
  });
  assert.equal(sectionFromDocument({}), undefined);
  assert.equal(sectionFromDocument(null), undefined);
  assert.equal(sectionFromDocument({ "dsh-connect": "nonsense" }), undefined);
  // A section with nothing declared projects to nothing, rather than to `{}`.
  assert.equal(sectionFromDocument({ "dsh-connect": { feishu: { appSecret: "s" } } }), undefined);
});

test("sectionOfStateDocument reads the file this plugin actually writes", () => {
  // The shape `settings-service.persist()` produces: the config itself, flat.
  const section = sectionOfStateDocument({
    channels: ["dingtalk"],
    channelDefaults: { language: "en" },
    feishu: { transport: "webhook", appSecret: "s3cret" },
    settingsStatePath: "/state/settings.json",
  });
  assert.deepEqual(section, {
    channels: ["dingtalk"],
    channelDefaults: { language: "en" },
    feishu: { transport: "webhook" },
  });
  assert.equal(sectionOfStateDocument({ appSecret: "only-a-secret" }), undefined);
});

test("sectionOfStateDocument tolerates a wrapped file", () => {
  // Nobody writes that shape, but copying a section across from the host
  // document is a natural thing to have done, and the flat form is still there
  // to fall back on.
  assert.deepEqual(sectionOfStateDocument({ "dsh-connect": { channels: ["web"] } }), { channels: ["web"] });
  assert.deepEqual(sectionOfStateDocument({ "dsh-connect": { channels: ["web"] }, channels: ["feishu"] }), {
    channels: ["web"],
  });
  assert.equal(sectionOfStateDocument({ "dsh-connect": {} }), undefined);
});

// --- importLegacySection -------------------------------------------------

test("importLegacySection merges the legacy section over the one in force", async () => {
  const home = tempDir();
  const entry = tempEntry();
  const state = join(tempDir(), "settings.json");
  writeFileSync(join(home, "settings.yaml"), DOCUMENT_WITH_CHANNELS, "utf8");
  const s = spy();

  const result = await importLegacySection({
    home,
    entryPath: entry,
    statePath: state,
    current: { channels: ["telegram"] },
    write: s.write,
    logger: s.logger,
  });

  assert.equal(result.imported, true);
  assert.equal(result.source, join(home, "settings.yaml"));
  assert.deepEqual(result.section, {
    channels: ["feishu"],
    channelDefaults: { language: "zh" },
    feishu: { transport: "websocket" },
  });
  assert.deepEqual(s.writes, [result.section]);

  // Beside the profile entry, not beside the state file (see `legacyMarkerPath`).
  const marker = contents(markerFor(entry));
  assert.match(marker, /imported the dsh-connect section from/);
  assert.ok(marker.includes(join(home, "settings.yaml")));
  assert.ok(!existsSync(`${state}.legacy-imported`));
  // The document is the user's, not ours: a successful import renames nothing.
  assert.ok(existsSync(join(home, "settings.yaml")));
  assert.equal(s.infos.length, 1);
  assert.match(s.infos[0], /^connect: imported the legacy dsh-connect settings from /);
  assert.deepEqual(s.warnings, []);
});

test("the migration cannot switch every adapter off", async () => {
  // The property the merge exists for: `replace()` resets what a section omits,
  // so an import carrying only per-channel keys must not clear `channels`.
  const home = tempDir();
  const state = join(tempDir(), "settings.json");
  writeFileSync(join(home, "settings.yaml"), DOCUMENT_WITHOUT_CHANNELS, "utf8");
  const s = spy();

  const result = await importLegacySection({
    home,
    statePath: state,
    current: { channels: ["telegram"], channelDefaults: { notifyLevel: "result" } },
    write: s.write,
    logger: s.logger,
  });

  assert.equal(result.imported, true);
  assert.deepEqual(result.section, {
    channels: ["telegram"],
    channelDefaults: { notifyLevel: "result" },
    feishu: { transport: "webhook" },
  });
});

test("secrets in the legacy document reach neither the write nor the marker", async () => {
  const home = tempDir();
  const entry = tempEntry();
  const state = join(tempDir(), "settings.json");
  writeFileSync(join(home, "settings.yaml"), DOCUMENT_WITH_CHANNELS, "utf8");
  const s = spy();

  await importLegacySection({ home, entryPath: entry, statePath: state, current: {}, write: s.write, logger: s.logger });

  // `sectionOf` is the only thing standing between the file and the profile
  // entry, and a profile entry is a document users paste into bug reports.
  assert.ok(!JSON.stringify(s.writes).includes("s3cret-value"));
  assert.ok(!contents(markerFor(entry)).includes("s3cret-value"));
});

test("the legacy import is one-shot", async () => {
  const home = tempDir();
  const entry = tempEntry();
  const state = join(tempDir(), "settings.json");
  writeFileSync(join(home, "settings.yaml"), DOCUMENT_WITH_CHANNELS, "utf8");
  const first = spy();
  await importLegacySection({
    home,
    entryPath: entry,
    statePath: state,
    current: {},
    write: first.write,
    logger: first.logger,
  });

  const second = spy();
  const result = await importLegacySection({
    home,
    entryPath: entry,
    statePath: state,
    current: {},
    write: second.write,
    logger: second.logger,
  });

  assert.deepEqual(result, { imported: false, skipped: "already-imported" });
  // Not merely reported as a no-op: a re-import would silently undo every edit
  // the user made since the first boot after the upgrade.
  assert.deepEqual(second.writes, []);
});

test("importLegacySection reads the flat state file when no home document survives", async () => {
  const home = tempDir();
  const entry = tempEntry();
  const stateDir = tempDir();
  const state = join(stateDir, "dsh-connect-settings.json");
  writeFileSync(
    state,
    JSON.stringify(
      { channels: ["dingtalk"], feishu: { transport: "webhook", appSecret: "state-secret" }, nonsense: 1 },
      null,
      2,
    ) + "\n",
    "utf8",
  );
  const s = spy();

  const result = await importLegacySection({
    home,
    entryPath: entry,
    statePath: state,
    current: { channels: ["feishu"] },
    write: s.write,
    logger: s.logger,
  });

  assert.equal(result.imported, true);
  assert.equal(result.source, state);
  assert.deepEqual(result.section, { channels: ["dingtalk"], feishu: { transport: "webhook" } });
  assert.ok(!JSON.stringify(s.writes).includes("state-secret"));
  assert.ok(existsSync(markerFor(entry)));
});

test("the .imported document is read when settings.yaml has no section", async () => {
  // The host's own import renames the document once the loader settles, and it
  // may well run before ours — so both filenames have to be tried.
  const home = tempDir();
  const state = join(tempDir(), "settings.json");
  const imported = join(home, "settings.yaml.imported");
  writeFileSync(join(home, "settings.yaml"), "ui-settings-general:\n  locale: en\n", "utf8");
  writeFileSync(imported, documentWith("  channels:\n    - web\n"), "utf8");
  const s = spy();

  const result = await importLegacySection({ home, statePath: state, current: {}, write: s.write, logger: s.logger });

  assert.equal(result.imported, true);
  assert.equal(result.source, imported);
  assert.deepEqual(result.section, { channels: ["web"] });
});

test("a legacy document with no section is marked, once", async () => {
  const home = tempDir();
  const entry = tempEntry();
  writeFileSync(join(home, "settings.yaml"), "ui-settings-general:\n  locale: en\n", "utf8");
  const s = spy();

  const result = await importLegacySection({ home, entryPath: entry, current: {}, write: s.write, logger: s.logger });

  assert.equal(result.imported, false);
  assert.equal(result.skipped, "no-section");
  assert.deepEqual(s.writes, []);
  assert.deepEqual(s.warnings, []);
  // Marked even though nothing happened: this is the outcome every already-
  // migrated user gets on every boot, and without the marker each boot would
  // re-read and re-parse the document for nothing.
  assert.match(contents(markerFor(entry)), /no dsh-connect section to import/);
});

test("no legacy document at all is marked too", async () => {
  const entry = tempEntry();
  const s = spy();

  const result = await importLegacySection({
    home: join(tempDir(), "absent"),
    entryPath: entry,
    current: {},
    write: s.write,
    logger: s.logger,
  });

  assert.equal(result.skipped, "no-document");
  assert.match(contents(markerFor(entry)), /no legacy settings document found/);
});

test("an unparseable document is left in place for a retry", async () => {
  // Not a substitute: the next candidate is not the file the user edited. The
  // document stays put (a rename would hide the typo), and no marker is written
  // so the next boot tries again once the YAML is fixed.
  const home = tempDir();
  const entry = tempEntry();
  const document = join(home, "settings.yaml");
  writeFileSync(document, "dsh-connect:\n  channels: [1\n", "utf8");
  const s = spy();

  const result = await importLegacySection({ home, entryPath: entry, current: {}, write: s.write, logger: s.logger });

  assert.equal(result.imported, false);
  assert.equal(result.skipped, "unparseable");
  assert.equal(s.warnings.length, 1);
  assert.ok(s.warnings[0].startsWith(`connect: the legacy settings at ${document} could not be parsed`));
  assert.ok(!existsSync(markerFor(entry)));
  assert.equal(contents(document), "dsh-connect:\n  channels: [1\n");
});

test("with no write path nothing is marked, so a later boot retries", async () => {
  // No settings service, or no resolvable profile entry id: the values are
  // still in the document, so the migration has to stay pending rather than
  // record itself as done.
  const home = tempDir();
  const entry = tempEntry();
  writeFileSync(join(home, "settings.yaml"), DOCUMENT_WITH_CHANNELS, "utf8");

  const result = await importLegacySection({ home, entryPath: entry, current: {} });

  assert.deepEqual(result, { imported: false, skipped: "not-live" });
  assert.ok(!existsSync(markerFor(entry)));
});

test("a refused write names the source and leaves the marker unwritten", async () => {
  const home = tempDir();
  const entry = tempEntry();
  const document = join(home, "settings.yaml");
  writeFileSync(document, DOCUMENT_WITH_CHANNELS, "utf8");
  const s = spy();

  const result = await importLegacySection({
    home,
    entryPath: entry,
    current: {},
    write: async () => {
      throw new Error("ValidationError: feishu.transport");
    },
    logger: s.logger,
  });

  assert.equal(result.imported, false);
  assert.equal(result.skipped, "write-failed");
  assert.equal(result.source, document);
  assert.equal(s.warnings.length, 1);
  assert.ok(s.warnings[0].includes("ValidationError: feishu.transport"));
  assert.ok(s.warnings[0].includes(document));
  // Retried next boot, when the cause is fixed — the section is still there.
  assert.ok(!existsSync(markerFor(entry)));
});

// --- where the one-shot marker lives -------------------------------------

test("legacyMarkerPath anchors on the profile entry", () => {
  const entry = join("/profiles", "web", "cordis.patch.yml");
  assert.equal(legacyMarkerPath({ entryPath: entry }), join("/profiles", "web", LEGACY_IMPORT_MARKER));
  // Namespaced and dotted: the profile directory holds every plugin's entry, so
  // a bare `${patchPath}.legacy-imported` would be a file the first plugin with
  // a migration of its own would write and every other one would find.
  assert.ok(LEGACY_IMPORT_MARKER.startsWith("."));
  assert.ok(LEGACY_IMPORT_MARKER.includes("dsh-connect"));

  // An explicit path wins over everything; then the entry; then the state file;
  // then there is nothing to anchor on.
  assert.equal(
    legacyMarkerPath({ markerPath: "/tmp/im.done", entryPath: entry, statePath: "/state/s.json" }),
    "/tmp/im.done",
  );
  assert.equal(
    legacyMarkerPath({ entryPath: entry, statePath: "/state/s.json" }),
    join("/profiles", "web", LEGACY_IMPORT_MARKER),
  );
  assert.equal(legacyMarkerPath({ statePath: "/state/s.json" }), "/state/s.json.legacy-imported");
  assert.equal(legacyMarkerPath({}), undefined);
  // Blank is as absent as missing — `join("", NAME)` would be a *relative* path.
  assert.equal(legacyMarkerPath({ entryPath: "   ", statePath: "" }), undefined);
  assert.equal(legacyMarkerPath({ markerPath: " ", statePath: "/state/s.json" }), "/state/s.json.legacy-imported");
});

test("the marker stays put when the user moves the state file", async () => {
  // The defect this pins: up to 0.9.1 the marker was `${statePath}.legacy-imported`.
  // The state path is the user's to move — `stateDir`, the `DSH_CONNECT_STATE_DIR`
  // override, `settingsStatePath` — and to delete, and either one made the next
  // boot believe no import had ever run. It then re-read `settings.yaml.imported`
  // (the host's rename leaves the `dsh-connect:` section in it) and laid the
  // legacy values back over everything changed in the pane since.
  const home = tempDir();
  const entry = tempEntry();
  writeFileSync(join(home, "settings.yaml"), DOCUMENT_WITH_CHANNELS, "utf8");
  const first = spy();
  await importLegacySection({
    home,
    entryPath: entry,
    statePath: join(tempDir(), "settings.json"),
    current: {},
    write: first.write,
    logger: first.logger,
  });
  assert.equal(first.writes.length, 1);

  // Same profile, new state directory: the user tidied up, or set `stateDir`.
  const second = spy();
  const result = await importLegacySection({
    home,
    entryPath: entry,
    statePath: join(tempDir(), "settings.json"),
    current: { channels: ["telegram"] },
    write: second.write,
    logger: second.logger,
  });

  assert.deepEqual(result, { imported: false, skipped: "already-imported" });
  assert.deepEqual(second.writes, []);
});

test("two profiles over one home each run their own migration", async () => {
  // Why the entry and not `$DSH_HOME`: the home is shared by every profile, so a
  // marker there would let the second profile skip an import it never ran — and
  // it would never run again, since the marker would be there for good.
  const home = tempDir();
  writeFileSync(join(home, "settings.yaml"), DOCUMENT_WITH_CHANNELS, "utf8");
  const web = tempEntry();
  const cli = tempEntry();
  const first = spy();
  const second = spy();

  await importLegacySection({ home, entryPath: web, current: {}, write: first.write, logger: first.logger });
  await importLegacySection({ home, entryPath: cli, current: {}, write: second.write, logger: second.logger });

  assert.equal(first.writes.length, 1);
  assert.equal(second.writes.length, 1);
  assert.ok(existsSync(markerFor(web)));
  assert.ok(existsSync(markerFor(cli)));
});

test("with no entry path the marker falls back beside the state file", async () => {
  // A caller with no `profileContext.patchPath` to offer. Worse than the entry
  // as an anchor, still far better than no marker at all.
  const home = tempDir();
  const state = join(tempDir(), "settings.json");
  writeFileSync(join(home, "settings.yaml"), DOCUMENT_WITH_CHANNELS, "utf8");
  const s = spy();

  await importLegacySection({ home, statePath: state, current: {}, write: s.write, logger: s.logger });
  assert.match(contents(`${state}.legacy-imported`), /imported the dsh-connect section from/);

  const again = spy();
  const result = await importLegacySection({
    home,
    statePath: state,
    current: {},
    write: again.write,
    logger: again.logger,
  });
  assert.equal(result.skipped, "already-imported");
  assert.deepEqual(again.writes, []);
});

test("an explicit marker path is honoured", async () => {
  const home = tempDir();
  const marker = join(tempDir(), "nested", "done.marker");
  writeFileSync(join(home, "settings.yaml"), DOCUMENT_WITH_CHANNELS, "utf8");
  const s = spy();

  await importLegacySection({ home, markerPath: marker, current: {}, write: s.write, logger: s.logger });
  assert.ok(existsSync(marker));

  const second = await importLegacySection({ home, markerPath: marker, current: {}, write: s.write, logger: s.logger });
  assert.equal(second.skipped, "already-imported");
});

test("a document that cannot be read is not the same as one that is not there", async () => {
  // The load path calls this fire-and-forget (`void importLegacySection(...)`),
  // so nothing here may reject — an unhandled rejection in somebody's boot log
  // is the whole failure mode this file is written to avoid. A directory where
  // the document should be is the portable way to arrange an unreadable path.
  const home = tempDir();
  const entry = tempEntry();
  const document = join(home, "settings.yaml");
  mkdirSync(document, { recursive: true });
  const s = spy();

  const result = await importLegacySection({
    home,
    entryPath: entry,
    current: {},
    write: async () => {
      throw new Error("must not be reached");
    },
    logger: s.logger,
  });

  assert.equal(result.imported, false);
  // Up to 0.9.1 this was `no-document`, which made the outcome final: the file
  // is *there*, we simply could not open it, and one EACCES would have ended the
  // migration for good. Only one of the two cases is final, so only one of them
  // may be recorded as done.
  assert.equal(result.skipped, "unreadable");
  assert.equal(s.writes.length, 0);
  assert.equal(s.warnings.length, 1);
  assert.ok(s.warnings[0].startsWith(`connect: could not read the legacy settings candidate at ${document}`));
  assert.ok(!existsSync(markerFor(entry)));
});

test("a marker that cannot be written is reported rather than swallowed", async () => {
  // Not fatal — the import itself succeeded — but it is not harmless either:
  // without the marker the next start re-runs the migration and layers the
  // legacy values back over whatever the user has changed since.
  const home = tempDir();
  const document = join(home, "settings.yaml");
  writeFileSync(document, DOCUMENT_WITH_CHANNELS, "utf8");
  const s = spy();

  const result = await importLegacySection({
    home,
    markerPath: join(document, "marker"), // a regular file, used as a directory
    current: {},
    write: s.write,
    logger: s.logger,
  });

  assert.equal(result.imported, true);
  assert.equal(s.warnings.length, 1);
  assert.ok(s.warnings[0].includes("could not write the one-shot import marker at"));
});
