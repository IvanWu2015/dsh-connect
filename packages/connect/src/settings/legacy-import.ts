/**
 * One-shot migration of the pre-0.2 pane settings into the `connect` profile entry.
 *
 * Before 0.2 this plugin's pane settings lived in `$DSH_HOME/settings.yaml`
 * under a `dsh-connect:` section, keyed by plugin *name*. The 0.2 host does not
 * know that section and will not import it: `SettingsForms.importLegacyDocument()`
 * renames the document to `settings.yaml.imported` and then calls
 * `update(section, values)` for every top-level section, where the only renamed
 * keys are the base-bundle ones (`ui-onboarding` → `ui-settings-general`, …).
 * `dsh-connect` reaches `update("dsh-connect", …)` — an entry that does not
 * exist — and is dropped with a warning. The user's channels keep working (their
 * config is in the profile patch) but every pane-only choice silently reverts to
 * its default the first time the pane is opened. This module recovers it.
 *
 * Three properties make the migration safe to run unattended:
 *
 * - **It merges, it does not replace.** `SettingsForms.replace()` resets every
 *   live field to its *inherited* layer and then applies the supplied ones, so a
 *   section carrying only the legacy keys would clear every pane field the
 *   legacy document happens not to mention — `channels` included, which is how a
 *   migration ends up disabling every adapter. The section handed to
 *   `replace()` is therefore always complete: what is in force now, with the
 *   legacy values layered on top.
 * - **It is one-shot.** A marker beside the pane's state file records that the
 *   import ran, including the benign "there was nothing to import" case, so the
 *   legacy document is never re-applied over later user edits. Nothing is marked
 *   unless the outcome is final: a document that is missing is marked, a document
 *   that is *there but unreadable* is not (see `LegacySkipReason`).
 * - **It never blocks or breaks the load.** A missing parser, an unparseable
 *   document or a refused write degrades to one warning line and leaves both
 *   files untouched for a retry after the cause is fixed.
 *
 * Secrets cannot travel through it: the legacy section is projected by
 * `sectionOf()`, which keeps declared non-secret keys only, and a parse failure
 * is reported without quoting the document (a YAML error message contains the
 * offending source lines, and the section it would quote holds an `appSecret`).
 * Anything else in that file stays where it is.
 * @module dsh-connect/settings/legacy-import
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { LEGACY_CONNECT_SECTION, mergeSections, sectionOf, type ConnectSection } from "./namespace.js";

/** The logger surface this module uses; both members are optional. */
export interface LegacyImportLogger {
  warn?(...args: unknown[]): void;
  info?(...args: unknown[]): void;
}

/**
 * Why nothing was imported. Absent when the import succeeded.
 *
 * `unreadable` is kept apart from `no-document` because only one of the two is
 * final. An absent document is marked done and never looked for again; a
 * document that is *there* and could not be read is the one case where the
 * user's settings may be sitting in a file we failed to open, so it must stay
 * unmarked and be reported. Collapsing them — which this did until 0.9.2 — meant
 * a single `EACCES` (or a `settings.yaml` that is accidentally a directory)
 * ended the migration silently, with no marker to explain it and no warning.
 */
export type LegacySkipReason =
  | "already-imported"
  | "no-document"
  | "no-section"
  | "not-live"
  | "unparseable"
  | "unreadable"
  | "parser-missing"
  | "write-failed";

export interface LegacyImportResult {
  /** True only when a section was written into the profile entry. */
  imported: boolean;
  /** The document the section came from, when one was found. */
  source?: string;
  /** The complete section that was written — the in-force values with the legacy ones layered on. */
  section?: ConnectSection;
  /** Why nothing was imported; a benign value means the marker was still written. */
  skipped?: LegacySkipReason;
}

export interface LegacyImportOptions {
  /** Harness home holding the legacy document; `$DSH_HOME`, then `~/.dsh`. */
  home?: string;
  /**
   * Writes a complete section onto the plugin's profile entry — the
   * `LiveConnectSection.write` the settings pane itself saves through, so a
   * migrated value reconciles the running adapters exactly like a pane save.
   * Absent when the seam is not live (no settings service, or no resolvable
   * entry id), in which case nothing is marked and the import waits for a host
   * that can take it.
   */
  write?: ((section: ConnectSection) => Promise<void>) | undefined;
  /** The section in force now, used as the base so the write cannot clear anything. */
  current: ConnectSection;
  /** Path of this plugin's pre-0.2 JSON state file; the last-resort source. */
  statePath?: string | undefined;
  /** Where to record that the import ran; defaults to `${statePath}.legacy-imported`. */
  markerPath?: string | undefined;
  logger?: LegacyImportLogger | undefined;
}

/**
 * Resolve the Harness home with the same precedence as the host's own
 * `resolveDshHome()`: an explicit path (the host hands us `profileContext.home`,
 * which also covers a configured non-env home), then `$DSH_HOME` — whitespace
 * only counts as unset, so a blank override never resolves the home to the
 * filesystem root — then `~/.dsh`. A `~` in either of the first two is expanded.
 */
export function resolveHarnessHome(explicit?: string): string {
  const usable = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
  if (usable(explicit)) return expandHome(explicit);
  if (usable(process.env.DSH_HOME)) return expandHome(process.env.DSH_HOME);
  return join(homedir(), ".dsh");
}

/**
 * Trim, and expand a leading `~` the way a shell would.
 *
 * `DSH_HOME=~/.dsh` is a natural thing to write in a shell profile and a
 * perfectly literal string to Node: left alone, the migration reads a directory
 * named `~` under the process cwd, finds nothing there, and marks itself done —
 * silently, permanently, against a home that does not exist. Only the two `~`
 * forms are rewritten, so an absolute path is returned exactly as it was given
 * (which is also what keeps `profileContext.home` whole).
 */
function expandHome(value: string): string {
  const trimmed = value.trim();
  if (trimmed === "~") return homedir();
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) return join(homedir(), trimmed.slice(2));
  return trimmed;
}

/**
 * One document to try, and how to read the pane section out of it.
 *
 * The shape is carried alongside the path rather than guessed from the contents
 * because the two sources really do differ, and guessing wrong fails silently:
 * reading the state file as a document finds no `dsh-connect` key, and
 * `importLegacySection` then reports "nothing to import" for a user whose only
 * settings are sitting in that file.
 */
export interface LegacyCandidate {
  path: string;
  /**
   * `"document"` — a `settings.yaml`-style file, a map of *plugin sections*
   * keyed by plugin name, so the pane's values live under `dsh-connect`.
   * `"section"` — this plugin's own JSON state file, whose top level already
   * *is* the section (`settings-service`'s fallback store persists it flat).
   */
  shape: "document" | "section";
}

/**
 * The documents to try, in order.
 *
 * `settings.yaml` first: if the host has not run its own legacy import yet, the
 * section is still there. Then `settings.yaml.imported`, which is where the host
 * puts the document after renaming it — the read has to tolerate both because
 * the host's import waits for the loader to settle and may run before or after
 * ours. Finally the JSON state file this plugin used as its own fallback store:
 * its values are unreachable once the live peer exists (`settings-service`
 * prefers `live.read()` whenever it is present), so a user who only ever saved
 * through the fallback path would otherwise lose them silently. That file is
 * written flat — `persist()` stringifies the config itself, with no
 * `dsh-connect` wrapper — so it is read as a section, not as a document.
 */
export function legacyCandidates(options: Pick<LegacyImportOptions, "home" | "statePath">): LegacyCandidate[] {
  const home = resolveHarnessHome(options.home);
  const candidates: LegacyCandidate[] = [
    { path: join(home, "settings.yaml"), shape: "document" },
    { path: join(home, "settings.yaml.imported"), shape: "document" },
  ];
  if (typeof options.statePath === "string" && options.statePath.trim().length > 0) {
    candidates.push({ path: options.statePath, shape: "section" });
  }
  return candidates;
}

/** What a read attempt found: the text, nothing at all, or a failure. */
type ReadOutcome =
  | { kind: "text"; text: string }
  | { kind: "absent" }
  | { kind: "unreadable"; detail: string };

/**
 * Read a file, telling "not there" apart from "could not be read".
 *
 * Only `ENOENT` and `ENOTDIR` count as absence — `ENOTDIR` because pointing the
 * home at a regular file makes every child path under it yield that code, which
 * is an absence just as much as a missing directory is. Everything else
 * (permissions, a path that is a directory, an I/O error) is a failure the
 * caller must not mistake for an absence: see `LegacySkipReason`.
 */
function readFileOutcome(path: string): ReadOutcome {
  try {
    return { kind: "text", text: readFileSync(path, "utf8") };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") return { kind: "absent" };
    return { kind: "unreadable", detail: message(error) };
  }
}

/**
 * A parse failure described without quoting the document.
 *
 * The `yaml` package's error message carries the offending source *lines*, and
 * the document being parsed is the one holding `appSecret` — so reporting it
 * verbatim would copy a credential into a boot warning. Its `code` and position
 * are everything a user needs to find the fault in a file they already have
 * open, so those are what is reported. Anything else keeps its first line only,
 * for the same reason.
 */
function parseFailureDetail(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const { code, linePos } = error as { code?: unknown; linePos?: { line: number; col: number }[] };
    if (typeof code === "string") {
      const at = linePos?.[0];
      return at === undefined ? code : `${code} at line ${at.line}, column ${at.col}`;
    }
  }
  return message(error).split("\n", 1)[0] ?? "";
}

/** Parse YAML/JSON text, or throw a message fit for the warning line. */
async function parseDocument(source: string): Promise<unknown> {
  let parser: { parse(source: string): unknown };
  try {
    parser = (await import("yaml")) as unknown as { parse(source: string): unknown };
  } catch (error) {
    throw new TaggedError("parser-missing", `the "yaml" package is unavailable (${message(error)})`);
  }
  try {
    return parser.parse(source);
  } catch (error) {
    throw new TaggedError("unparseable", parseFailureDetail(error));
  }
}

/** An error carrying the outcome it should produce. */
class TaggedError extends Error {
  readonly tag: LegacySkipReason;
  constructor(tag: LegacySkipReason, detail: string) {
    super(detail);
    this.tag = tag;
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Project an object that *is* a pane section onto the declared keys, or
 * `undefined` when nothing usable is left.
 *
 * `defaultChannels: false` because every caller here is reading a *source*, not
 * writing: an absent `channels` key must stay absent so the in-force value keeps
 * applying. The caller decides what to do about the omissions — which, given
 * `mergeSections`, means the current list survives.
 */
function projectSection(raw: unknown): ConnectSection | undefined {
  if (!isPlainObject(raw)) return undefined;
  const section = sectionOf(raw, { defaultChannels: false });
  return Object.keys(section).length > 0 ? section : undefined;
}

/**
 * Extract the pane section from a parsed `settings.yaml`-style document: the
 * `dsh-connect` mapping, projected onto declared keys, or `undefined` when the
 * document has no such section (or carries nothing usable under it).
 */
export function sectionFromDocument(document: unknown): ConnectSection | undefined {
  if (!isPlainObject(document)) return undefined;
  return projectSection(document[LEGACY_CONNECT_SECTION]);
}

/**
 * Extract the pane section from this plugin's own JSON state file, whose top
 * level is already the section. A `dsh-connect` wrapper is tolerated as well,
 * since pasting values across from the host document is a natural thing to have
 * done — but the flat form is the one the file is actually written in.
 */
export function sectionOfStateDocument(document: unknown): ConnectSection | undefined {
  if (!isPlainObject(document)) return undefined;
  const nested = document[LEGACY_CONNECT_SECTION];
  return projectSection(isPlainObject(nested) ? nested : document);
}

/**
 * Record that the import ran.
 *
 * Best effort — a read-only home must not fail the boot — but not silent: the
 * failure is not the harmless one it looks like. Without the marker the next
 * start re-runs the whole migration, and a re-run layers the legacy values back
 * over everything the user has changed in the pane since. The import it belongs
 * to did its job; saying so is the difference between a user who can look at
 * that warning and one whose settings revert on the next restart for no visible
 * reason.
 */
function markAndReport(marker: string, body: string, warn: (text: string) => void): void {
  try {
    mkdirSync(dirname(marker), { recursive: true });
    writeFileSync(marker, body, "utf8");
  } catch (error) {
    warn(
      `could not write the one-shot import marker at ${marker} (${message(error)}); ` +
        `the migration will run again on the next start and may re-apply the legacy settings over newer pane changes`,
    );
  }
}

/**
 * Import the pre-0.2 pane settings into the profile entry, once.
 *
 * Never rejects: every failure path is reported through the returned result and
 * (for the ones a user can act on) a single warning line.
 */
export async function importLegacySection(options: LegacyImportOptions): Promise<LegacyImportResult> {
  const { write, current, logger } = options;
  const warn = (text: string): void => logger?.warn?.(`connect: ${text}`);
  const marker = options.markerPath ?? (options.statePath ? `${options.statePath}.legacy-imported` : undefined);

  if (marker !== undefined) {
    const seen = readFileOutcome(marker);
    if (seen.kind === "unreadable") {
      // Treated as present rather than absent on purpose: re-running would layer
      // the legacy values back over whatever the user has changed since, which is
      // the one outcome the marker exists to prevent.
      warn(
        `the import marker at ${marker} could not be read (${seen.detail}); treating the one-shot migration as already done rather than re-applying the legacy settings over newer changes`,
      );
      return { imported: false, skipped: "already-imported" };
    }
    if (seen.kind === "text") return { imported: false, skipped: "already-imported" };
  }

  if (write === undefined) {
    // No store to write to. Nothing is marked, so a host that gains a settings
    // service later still gets the migration.
    return { imported: false, skipped: "not-live" };
  }

  const reads = legacyCandidates(options).map((candidate) => ({ candidate, read: readFileOutcome(candidate.path) }));

  const unreadable = reads.flatMap((entry) =>
    entry.read.kind === "unreadable" ? [{ path: entry.candidate.path, detail: entry.read.detail }] : [],
  );
  if (unreadable.length > 0) {
    // Deliberately not folded into `no-document`: this is the one branch where
    // the user's settings may be sitting in a file we failed to open, so nothing
    // is imported *and nothing is marked* — the next start tries again. Saying
    // which file and why is the whole point of splitting the outcome; the usual
    // causes are a permission, a path that is not what it looks like (a directory
    // named `settings.yaml`), or a `~` nobody expanded.
    for (const entry of unreadable) {
      warn(
        `could not read the legacy settings candidate at ${entry.path} (${entry.detail}); nothing was imported and nothing was marked, so the migration retries on the next start`,
      );
    }
    return { imported: false, skipped: "unreadable" };
  }

  if (reads.every((entry) => entry.read.kind === "absent")) {
    if (marker !== undefined) markAndReport(marker, `dsh-connect: no legacy settings document found\n`, warn);
    return { imported: false, skipped: "no-document" };
  }

  let source: string | undefined;
  let legacy: ConnectSection | undefined;
  for (const { candidate, read } of reads) {
    if (read.kind !== "text") continue;
    let document: unknown;
    try {
      document = await parseDocument(read.text);
    } catch (error) {
      // A malformed document stops the whole migration rather than falling
      // through to the next candidate. The next *document* is the same file the
      // host renamed, so it is a stale copy of the one that just failed, and the
      // state file holds the same user's older settings — importing either in
      // place of the section the user is looking at would be a silent
      // substitution, and the one they would least expect. Nothing is marked, so
      // fixing the file and restarting retries the whole thing.
      const tag = error instanceof TaggedError ? error.tag : "unparseable";
      warn(
        tag === "parser-missing"
          ? `the legacy settings at ${candidate.path} were not imported: ${message(error)}; reinstall dsh-connect to restore the migration`
          : `the legacy settings at ${candidate.path} could not be parsed (${message(error)}); the ${LEGACY_CONNECT_SECTION} section was left in place — fix it and restart to import it`,
      );
      return { imported: false, skipped: tag };
    }
    const found = candidate.shape === "section" ? sectionOfStateDocument(document) : sectionFromDocument(document);
    if (found !== undefined) {
      source = candidate.path;
      legacy = found;
      break;
    }
  }

  if (legacy === undefined || source === undefined) {
    if (marker !== undefined) {
      markAndReport(marker, `dsh-connect: no ${LEGACY_CONNECT_SECTION} section to import\n`, warn);
    }
    return { imported: false, skipped: "no-section" };
  }

  // Complete section: what is in force now, with the legacy values on top. See
  // the module doc — a partial section would reset every field it omits.
  const section = mergeSections(current, legacy);
  try {
    await write(section);
  } catch (error) {
    warn(
      `could not import the legacy ${LEGACY_CONNECT_SECTION} settings from ${source} into this plugin's profile entry (${message(error)}); ` +
        `the section was left in place — fix the cause and restart to import it`,
    );
    return { imported: false, source, skipped: "write-failed" };
  }

  if (marker !== undefined) {
    markAndReport(marker, `dsh-connect: imported the ${LEGACY_CONNECT_SECTION} section from ${source}\n`, warn);
  }
  logger?.info?.(`connect: imported the legacy ${LEGACY_CONNECT_SECTION} settings from ${source}`);
  return { imported: true, source, section };
}
