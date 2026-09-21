/**
 * `ChannelRuntime` is the half of channel orchestration that did not exist
 * while the channel list was fixed at load time: it stops what it started.
 *
 * The properties pinned here are the ones whose failure would be silent rather
 * than loud. A missed teardown leaves a live Feishu long connection behind, and
 * two live connections for the same app answer every event twice; a spurious
 * restart on an unrelated settings edit reconnects a healthy bot; an
 * un-serialised apply can start a channel between another apply's stop and
 * start.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { ChannelRuntime } from "../lib/settings/channel-runtime.js";

/** Runtime wired to fake channels that record their lifecycle as events. */
function makeRuntime(t, { channelNames = ["feishu", "telegram", "dingtalk", "web"], getSecrets, failing = {} } = {}) {
  const events = [];
  const warnings = [];
  const channels = {};
  for (const name of channelNames) {
    channels[name] = (_ctx, config) => {
      if (failing[name] !== undefined) throw new Error(failing[name]);
      events.push({ kind: "start", name, config });
    };
  }
  const runtime = new ChannelRuntime({
    ctx: { logger: { warn: (message) => warnings.push(message) } },
    channels,
    teardown: async (name) => {
      // Yield first: without serialisation the next apply's start would land
      // between a stop and its own start, which is what this guards against.
      await Promise.resolve();
      events.push({ kind: "stop", name });
    },
    ...(getSecrets === undefined ? {} : { getSecrets }),
  });
  t.after(() => runtime.dispose());
  return { runtime, events, warnings };
}

const starts = (events) => events.filter((e) => e.kind === "start").map((e) => e.name);
const stops = (events) => events.filter((e) => e.kind === "stop").map((e) => e.name);

test("starts exactly the channels in channels[]", async (t) => {
  const { runtime, events } = makeRuntime(t);
  await runtime.apply({ channels: ["feishu", "web"], feishu: { transport: "websocket" } });

  assert.deepEqual(starts(events), ["feishu", "web"]);
  assert.deepEqual(runtime.active(), ["feishu", "web"]);
  assert.deepEqual(stops(events), []);
});

test("an absent channels[] means every built-in channel", async (t) => {
  const { runtime, events } = makeRuntime(t);
  await runtime.apply({});

  assert.deepEqual(starts(events), ["feishu", "telegram", "dingtalk", "web"]);
});

test("channelDefaults are merged under each channel's own keys", async (t) => {
  const { runtime, events } = makeRuntime(t);
  await runtime.apply({ channels: ["feishu"], channelDefaults: { language: "en", notifyLevel: "full" }, feishu: { language: "zh" } });

  assert.deepEqual(events[0].config, { language: "zh", notifyLevel: "full" });
});

test("re-applying an identical config restarts nothing", async (t) => {
  const { runtime, events } = makeRuntime(t);
  await runtime.apply({ channels: ["feishu"], feishu: { transport: "websocket", webhookPort: 8080 } });
  await runtime.apply({ channels: ["feishu"], feishu: { transport: "websocket", webhookPort: 8080 } });

  assert.deepEqual(starts(events), ["feishu"]);
  assert.deepEqual(stops(events), []);
});

test("a cosmetic key reorder is not a config change", async (t) => {
  const { runtime, events } = makeRuntime(t);
  await runtime.apply({ channels: ["feishu"], feishu: { transport: "websocket", webhookPort: 8080 } });
  // Same values, written the other way round — the shape a user produces by
  // editing settings.yaml. Tearing down a live connection for this would be a
  // gratuitous reconnect on every save.
  await runtime.apply({ channels: ["feishu"], feishu: { webhookPort: 8080, transport: "websocket" } });

  assert.deepEqual(starts(events), ["feishu"]);
  assert.deepEqual(stops(events), []);
});

test("a changed value restarts the channel, stop first", async (t) => {
  const { runtime, events } = makeRuntime(t);
  await runtime.apply({ channels: ["feishu"], feishu: { transport: "websocket" } });
  await runtime.apply({ channels: ["feishu"], feishu: { transport: "webhook" } });

  assert.deepEqual(stops(events), ["feishu"]);
  assert.deepEqual(starts(events), ["feishu", "feishu"]);
  // Stop before start: the replacement must not open a connection while the
  // old one is still live (double delivery).
  assert.deepEqual(events.map((e) => e.kind), ["start", "stop", "start"]);
  assert.equal(events[2].config.transport, "webhook");
});

test("a channel dropped from channels[] is stopped and left stopped", async (t) => {
  const { runtime, events } = makeRuntime(t);
  await runtime.apply({ channels: ["feishu", "web"] });
  await runtime.apply({ channels: ["web"] });

  assert.deepEqual(stops(events), ["feishu"]);
  assert.deepEqual(runtime.active(), ["web"]);
});

test("re-adding a dropped channel starts it again", async (t) => {
  const { runtime, events } = makeRuntime(t);
  await runtime.apply({ channels: ["web"] });
  await runtime.apply({ channels: ["web", "telegram"] });
  await runtime.apply({ channels: ["telegram"] });
  await runtime.apply({ channels: ["telegram", "web"] });

  assert.deepEqual(starts(events), ["web", "telegram", "web"]);
  assert.deepEqual(stops(events), ["web"]);
  assert.deepEqual(runtime.active(), ["telegram", "web"]);
});

test("a rotated secret restarts the channel that consumes it", async (t) => {
  let token = "first";
  const { runtime, events } = makeRuntime(t, {
    getSecrets: async (name) => (name === "telegram" ? { botToken: token } : {}),
  });
  await runtime.apply({ channels: ["telegram"] });
  await runtime.apply({ channels: ["telegram"] });
  token = "second";
  await runtime.apply({ channels: ["telegram"] });

  assert.deepEqual(stops(events), ["telegram"]);
  assert.equal(events[events.length - 1].config.botToken, "second");
});

test("an unknown channel name is warned about, not started", async (t) => {
  const { runtime, events, warnings } = makeRuntime(t);
  await runtime.apply({ channels: ["feishu", "irc"] });

  assert.deepEqual(starts(events), ["feishu"]);
  assert.match(warnings.join("\n"), /unknown channel "irc"/);
});

test("a channel that fails to start does not take the others down", async (t) => {
  const { runtime, events, warnings } = makeRuntime(t, { failing: { telegram: "no token" } });
  await runtime.apply({ channels: ["feishu", "telegram", "web"] });

  assert.deepEqual(starts(events), ["feishu", "web"]);
  // And it is not recorded as running, so the next apply retries it.
  assert.deepEqual(runtime.active(), ["feishu", "web"]);
  assert.match(warnings.join("\n"), /channel "telegram" failed to start: Error: no token/);
});

test("a teardown that throws still leaves the channel off the books", async (t) => {
  const events = [];
  const warnings = [];
  const runtime = new ChannelRuntime({
    ctx: { logger: { warn: (m) => warnings.push(m) } },
    channels: {
      feishu: (_ctx, config) => events.push({ kind: "start", config }),
    },
    teardown: async () => {
      throw new Error("socket already gone");
    },
  });
  t.after(() => runtime.dispose());

  await runtime.apply({ channels: ["feishu"], feishu: { transport: "websocket" } });
  await runtime.apply({ channels: ["feishu"], feishu: { transport: "webhook" } });

  assert.deepEqual(runtime.active(), ["feishu"]);
  assert.equal(events.length, 2);
  assert.match(warnings.join("\n"), /failed to stop \(reconfigured\)/);
});

test("overlapping applies are serialised", async (t) => {
  const { runtime, events } = makeRuntime(t);
  // No awaits between them: all three are in flight at once. Without the chain
  // the second apply could start a channel between the first one's stop and
  // start, leaving two live adapters for one channel.
  const one = runtime.apply({ channels: ["feishu"], feishu: { transport: "websocket" } });
  const two = runtime.apply({ channels: ["feishu"], feishu: { transport: "webhook" } });
  const three = runtime.apply({ channels: ["feishu"], feishu: { language: "en" } });
  await Promise.all([one, two, three]);

  assert.deepEqual(events.map((e) => `${e.kind}:${e.name}`), [
    "start:feishu",
    "stop:feishu",
    "start:feishu",
    "stop:feishu",
    "start:feishu",
  ]);
  assert.equal(events[4].config.language, "en");
  assert.deepEqual(runtime.active(), ["feishu"]);
});

test("apply never rejects, even when a channel throws", async (t) => {
  const { runtime } = makeRuntime(t, { failing: { feishu: "boom" } });
  await assert.doesNotReject(() => runtime.apply({ channels: ["feishu"] }));
});

test("dispose stops everything and further applies are inert", async (t) => {
  const { runtime, events } = makeRuntime(t);
  await runtime.apply({ channels: ["feishu", "web"] });
  await runtime.dispose();

  assert.deepEqual(stops(events), ["feishu", "web"]);
  assert.deepEqual(runtime.active(), []);

  await runtime.apply({ channels: ["feishu"] });
  assert.deepEqual(runtime.active(), []);
});

test("the effective config is a copy, so an adapter can't mutate the source", async (t) => {
  const { runtime, events } = makeRuntime(t);
  const section = { channels: ["feishu"], feishu: { transport: "websocket" } };
  Object.freeze(section.feishu); // a settings-resolved section is deep-frozen
  Object.freeze(section);
  await runtime.apply(section);

  events[0].config.transport = "webhook";
  assert.equal(section.feishu.transport, "websocket");
});
