/**
 * `composeChannelStatus` — the pure half of the pane's 「接入状态」 badge.
 *
 * Every branch here is a statement the pane will make to the user about whether
 * their bot is reachable, so the precedence between them is the subject of this
 * file: what does a channel that is enabled *and* failed *and* not active
 * report? (Failed — a start that threw is a better explanation than "nothing is
 * running", and those are the two candidates.)
 *
 * The probe is deliberately the last question asked, and is never asked at all
 * for a channel whose state is already settled by the runtime's own evidence.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CHANNEL_CONNECTION_STATES,
  composeChannelStatus,
  isChannelConnectionState,
} from "../lib/settings/channel-status.js";

/** Compose with only the named inputs set, so each case reads as its own delta. */
function compose(over = {}) {
  return composeChannelStatus({
    channels: ["feishu", "telegram", "dingtalk", "web"],
    enabled: [],
    active: [],
    failures: {},
    probe: () => undefined,
    ...over,
  });
}

test("a channel that is not enabled reports disabled", () => {
  const out = compose({ enabled: ["feishu"] });
  // feishu is on the list, so its row must *not* read disabled: 「未启用」 has to
  // stay distinguishable from 「启用了但没跑起来」, which is the point of the
  // pair. Asserting both rows disabled here would have quietly collapsed them.
  assert.deepEqual(out.feishu, { state: "stopped" });
  assert.deepEqual(out.telegram, { state: "disabled" });
});

test("every known channel gets a row, enabled or not", () => {
  // A missing row would be indistinguishable from "the host cannot report
  // status"; 「未启用」 is an answer, and only the key's presence carries it.
  const out = compose();
  assert.deepEqual(Object.keys(out).sort(), ["dingtalk", "feishu", "telegram", "web"]);
});

test("a start failure outranks both stopped and running", () => {
  const out = compose({
    enabled: ["feishu"],
    active: ["feishu"],
    failures: { feishu: "appId is not configured" },
  });
  assert.deepEqual(out.feishu, { state: "failed" });
});

test("enabled but not running reports stopped", () => {
  const out = compose({ enabled: ["telegram"] });
  assert.deepEqual(out.telegram, { state: "stopped" });
});

test("running with no probe reports running, never connected", () => {
  // The distinction the whole module exists for: "up" is what the runtime knows,
  // and claiming 「已连接」 from it would be an invention.
  const out = compose({ enabled: ["telegram"], active: ["telegram"] });
  assert.deepEqual(out.telegram, { state: "running" });
});

test("a transport probe's state passes through verbatim", () => {
  for (const state of ["idle", "connecting", "connected", "reconnecting"]) {
    const out = compose({
      enabled: ["feishu"],
      active: ["feishu"],
      probe: () => ({ state }),
    });
    assert.deepEqual(out.feishu, { state }, `${state} should survive composition`);
  }
});

test("reconnect attempts are carried only when there are some", () => {
  const withAttempts = compose({
    enabled: ["feishu"],
    active: ["feishu"],
    probe: () => ({ state: "reconnecting", attempts: 3 }),
  });
  assert.deepEqual(withAttempts.feishu, { state: "reconnecting", attempts: 3 });

  // Zero attempts is "nothing to mention", not "the 0th attempt" — the render
  // site would otherwise have to special-case a value that means nothing.
  const zero = compose({
    enabled: ["feishu"],
    active: ["feishu"],
    probe: () => ({ state: "connected", attempts: 0 }),
  });
  assert.deepEqual(zero.feishu, { state: "connected" });
  assert.ok(!("attempts" in zero.feishu));
});

test("the probe is not consulted for a channel the runtime already accounts for", () => {
  // Disabled, failed and stopped are settled without a transport: probing them
  // would reach into a channel that was never started (and, for a disabled one,
  // one that has no adapter at all).
  const asked = [];
  compose({
    enabled: ["feishu", "telegram"],
    active: ["telegram"],
    failures: { dingtalk: "boom" },
    probe: (id) => {
      asked.push(id);
      return undefined;
    },
  });
  assert.deepEqual(asked, ["telegram"]);
});

test("a channel the runtime holds but nobody enabled is still reported", () => {
  // The id union is the point: config says what *should* be on, the runtime says
  // what *is*, and a disagreement is exactly what the user needs to see.
  const out = compose({ active: ["web"], failures: { dingtalk: "boom" } });
  assert.deepEqual(out.web, { state: "disabled" });
  assert.deepEqual(out.dingtalk, { state: "disabled" });
});

test("an id from outside the pane's channel list is reported rather than dropped", () => {
  const out = compose({ channels: ["feishu"], enabled: ["feishu", "ghost"], active: ["ghost"] });
  assert.deepEqual(out.ghost, { state: "running" });
});

test("CHANNEL_CONNECTION_STATES is the closed set of states", () => {
  assert.equal(new Set(CHANNEL_CONNECTION_STATES).size, CHANNEL_CONNECTION_STATES.length);
  for (const state of CHANNEL_CONNECTION_STATES) assert.equal(isChannelConnectionState(state), true);
  assert.equal(isChannelConnectionState("connected "), false);
  assert.equal(isChannelConnectionState(undefined), false);
  assert.equal(isChannelConnectionState(7), false);
});
