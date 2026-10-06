/**
 * Completeness of the pane's config surface, checked against the schemas
 * themselves rather than against a hand-written list.
 *
 * The bug this file exists to prevent: a channel's `Config` declares a key, and
 * every table the pane saves from forgets it. `sectionOf` projects path by path,
 * a save is a whole-section replace, so a declared key in no table is silently
 * deleted from the profile the next time the user saves *anything* — including a
 * save about something else entirely. Nothing failed; the value was just gone.
 *
 * So the invariant is a partition: every leaf the schema declares belongs to
 * exactly one of
 *
 *   - an editable field  (`CHANNEL_CONFIG_FIELDS`),
 *   - a credential       (`CHANNEL_SECRET_KEYS`, resolved through
 *     `secretConfigPath` because DingTalk's stream secrets live at
 *     `stream.clientId`), or
 *   - a carried-through key (`CHANNEL_PRESERVED_KEYS`, which may be a whole
 *     sub-object: `defaultAt` covers all three of its own leaves).
 *
 * Add a `Config` key without a home and this goes red, naming the path. That is
 * the point — it must be *impossible* to add one silently, not merely unlikely.
 *
 * Everything here is driven by schemastery introspection (`schema.dict`,
 * `schema.meta.role`) over the built `lib/`, so it reads the same schema the host
 * validates with.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { CHANNELS, secretConfigPath } from "../lib/settings/channels.js";
import { CHANNEL_SECRET_KEYS } from "../lib/settings/credential-store.js";
import { CHANNEL_CONFIG_FIELDS, CHANNEL_PRESERVED_KEYS } from "../lib/settings/settings-model.js";
import { Config as feishuConfig } from "../lib/channels/feishu/index.js";
import { Config as telegramConfig } from "../lib/channels/telegram/index.js";
import { Config as dingtalkConfig } from "../lib/channels/dingtalk/index.js";
import { Config as webConfig } from "../lib/channels/web/index.js";

const SCHEMAS = {
  feishu: feishuConfig,
  telegram: telegramConfig,
  dingtalk: dingtalkConfig,
  web: webConfig,
};

/**
 * Whether a schema node has named children we can descend into.
 *
 * Note the `typeof … === "function"` arm: a schemastery `Schema` *is* a callable
 * (it is constructed from `Function`), so an object-only check rejects every
 * node and quietly turns this file into a set of assertions about nothing.
 */
function isBranch(node) {
  if (node === null || node === undefined) return false;
  if (typeof node !== "object" && typeof node !== "function") return false;
  return node.dict !== undefined && node.dict !== null;
}

/**
 * Every leaf path the schema declares, dotted. A branch is descended into; an
 * array or scalar is a leaf — `defaultAt.mobiles` is a leaf even though its
 * parent is an object, because nothing below it is a named key of the config.
 */
function leafPaths(schema, prefix = "", out = []) {
  if (!isBranch(schema)) {
    if (prefix.length > 0) out.push(prefix);
    return out;
  }
  for (const [key, child] of Object.entries(schema.dict)) {
    leafPaths(child, prefix.length === 0 ? key : `${prefix}.${key}`, out);
  }
  return out;
}

/** The node at a dotted path, or undefined when the path walks off the schema. */
function resolvePath(schema, path) {
  let node = schema;
  for (const segment of path.split(".")) {
    if (!isBranch(node)) return undefined;
    node = node.dict[segment];
    if (node === undefined) return undefined;
  }
  return node;
}

/** Whether `path` is a leaf covered by `root` (equal to it, or below it). */
function coveredBy(path, root) {
  return path === root || path.startsWith(`${root}.`);
}

/** The pane paths that claim to describe `channel`, tagged with their kind. */
function panePaths(channel) {
  const fields = (CHANNEL_CONFIG_FIELDS[channel] ?? []).map((f) => ({ path: f.key, kind: "field" }));
  const secrets = Object.keys(CHANNEL_SECRET_KEYS[channel] ?? {}).map((key) => ({
    path: secretConfigPath(channel, key),
    kind: "secret",
  }));
  const preserved = (CHANNEL_PRESERVED_KEYS[channel] ?? []).map((path) => ({ path, kind: "preserved" }));
  return [...fields, ...secrets, ...preserved];
}

test("every channel has an introspection-readable Config schema", () => {
  // A missing or non-object schema would make every check below vacuously pass,
  // which is the one failure mode a completeness test cannot afford. Fail loudly
  // instead of skipping.
  assert.deepEqual(
    Object.keys(SCHEMAS).sort(),
    [...CHANNELS].sort(),
    "the channel list and this file's schema map have drifted apart",
  );
  for (const [channel, schema] of Object.entries(SCHEMAS)) {
    assert.ok(isBranch(schema), `${channel}: Config must be a z.object so its keys can be enumerated`);
    assert.ok(leafPaths(schema).length > 0, `${channel}: Config declares no keys at all`);
  }
});

test("every declared Config key is a field, a credential, or carried through", () => {
  const problems = [];
  for (const channel of CHANNELS) {
    const claimed = panePaths(channel);
    for (const leaf of leafPaths(SCHEMAS[channel])) {
      const owners = claimed.filter((c) => coveredBy(leaf, c.path));
      if (owners.length === 0) {
        problems.push(`${channel}.${leaf}: declared in Config but in no pane table — a save would delete it`);
      } else if (owners.length > 1) {
        problems.push(
          `${channel}.${leaf}: claimed twice (${owners.map((o) => `${o.kind} ${o.path}`).join(", ")})`,
        );
      }
    }
  }
  assert.deepEqual(problems, []);
});

test("every pane path resolves in its channel's schema", () => {
  const problems = [];
  for (const channel of CHANNELS) {
    for (const { path, kind } of panePaths(channel)) {
      const node = resolvePath(SCHEMAS[channel], path);
      if (node === undefined) {
        problems.push(`${channel}.${path} (${kind}): not a path in the Config schema`);
        continue;
      }
      // An editable field that is really a secret would render as a plain text
      // input and then sit in the settings document in clear text.
      if (kind === "field" && node.meta?.role === "secret") {
        problems.push(`${channel}.${path}: editable field points at a role("secret") key`);
      }
    }
  }
  assert.deepEqual(problems, []);
});

test("the credential table and the schema's secret leaves agree, both ways", () => {
  const problems = [];
  for (const channel of CHANNELS) {
    const table = CHANNEL_SECRET_KEYS[channel] ?? {};
    const declaredSecrets = leafPaths(SCHEMAS[channel]).filter(
      (path) => resolvePath(SCHEMAS[channel], path)?.meta?.role === "secret",
    );

    for (const key of Object.keys(table)) {
      const path = secretConfigPath(channel, key);
      const node = resolvePath(SCHEMAS[channel], path);
      if (node === undefined) {
        problems.push(`${channel}.${key}: in the credential store but ${path} is not in the schema`);
      } else if (node.meta?.role !== "secret") {
        problems.push(`${channel}.${key}: stored as a credential but ${path} is not role("secret")`);
      }
    }

    const claimed = new Set(Object.keys(table).map((key) => secretConfigPath(channel, key)));
    for (const path of declaredSecrets) {
      if (!claimed.has(path)) {
        problems.push(`${channel}.${path}: role("secret") in the schema but in no credential table`);
      }
    }
  }
  assert.deepEqual(problems, []);
});
