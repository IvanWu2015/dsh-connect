/**
 * Host-side single-flight registry for the settings pane's one-click Feishu
 * bot creation.
 *
 * The pane cannot drive `registerApp` directly, for three reasons:
 *
 * 1. The flow prints a link and then *waits for a human* for up to ~10 minutes.
 *    A single RPC call cannot span both moments — the link must reach the pane
 *    within a second of the click, the result minutes later.
 * 2. A long call is guaranteed to be aborted: the settings HTTP handler aborts
 *    on `res.on("close")`, and the device-authorization link is single-use and
 *    single-person, so propagating that abort burns the user's only chance.
 * 3. Creation is only one of five steps (create → mirror → store → subscribe →
 *    enable + apply); the other four need host-side services the pane has no
 *    access to, and must not be re-implemented client-side.
 *
 * So `start()` kicks the flow off, answers immediately, and the pane polls
 * `status()` until a terminal phase. Everything the flow does lives here.
 *
 * @module dsh-connect/settings/feishu-onboarding
 */
import type { Language } from "../i18n.js";
import type { FeishuCredentials } from "../channels/feishu/onboard.js";
import { feishuMessages } from "../channels/feishu/i18n.js";
import { CHANNEL_SECRET_KEYS } from "./credential-store.js";

/** Lifecycle of one one-click attempt. */
export type OnboardingPhase = "idle" | "waiting" | "done" | "cancelled" | "failed";

/**
 * Outcome of the event-subscription step. Reported, never assumed: Feishu's own
 * API doc says the config PATCH may not accept an app created through the bot
 * assistant flow, and that a `200` only means the *request* was accepted —
 * most config changes need a release + review before they reach the wire.
 */
export interface SubscriptionStep {
  attempted: boolean;
  status: "not-attempted" | "applied" | "failed" | "skipped";
  /** The API's own `code`/`msg`, passed through verbatim when it failed. */
  reason?: string;
  /** The user still has to do this by hand in the developer console. */
  needsManualAction: boolean;
}

/** Everything the pane needs to report — each field a separate true fact. */
export interface OnboardingOutcome {
  /** The app really was created in the tenant. */
  created: boolean;
  /** Never carries the app secret. */
  appId?: string;
  /** `credentialStore.save()` resolved: the secret is in the DSH credential store. */
  credentialsStored: boolean;
  /** The legacy plaintext JSON mirror was written. */
  legacyMirrorWritten: boolean;
  /** Whether the running adapter actually picked up the new credentials. */
  applied: "pending" | "yes" | "no";
  subscription: SubscriptionStep;
  /** The enable + config write was requested of the settings service. */
  enableRequested: boolean;
  /** Flow-level reason: the SDK error code, or the thrown message. */
  reason?: string;
}

/** The device-authorization link, as handed to the pane. */
export interface OnboardingLink {
  url: string;
  expiresInSeconds: number;
  expiresAt: number;
}

/** What `start`/`status`/`cancel` return. */
export interface OnboardingStatus {
  phase: OnboardingPhase;
  channel: "feishu";
  link?: OnboardingLink;
  outcome?: OnboardingOutcome;
}

/** The onboarding flow seam — the real one, or a test double. */
export type OnboardFlow = typeof import("../channels/feishu/onboard.js").onboardFeishu;

/**
 * Everything the registry touches, injected. All of it is a host-side service
 * or a pure function, which is what makes the whole flow unit-testable without
 * a network round trip or a ten-minute wait.
 */
export interface FeishuOnboardingDeps {
  /**
   * The flow itself. Same seam as `FeishuRegisterOptions.onboard`
   * (`../channels/feishu/index.ts`), so one fake serves both call sites.
   */
  onboard: OnboardFlow;
  /**
   * The DSH credential store — the only durable home for the secret. Optional:
   * without it, the legacy mirror and the in-memory instance still come up, and
   * `credentialsStored` says `false` rather than pretending.
   */
  credentialStore?: { save(channel: "feishu", values: Record<string, string>): Promise<void> };
  /** Writes the legacy plaintext mirror; returns whether it succeeded. */
  legacySave: (credentials: FeishuCredentials) => boolean;
  /**
   * PATCH the app's event subscription to long-connection mode. Best effort —
   * see {@link SubscriptionStep}; a rejection is reported, not retried.
   *
   * Takes the secret because the PATCH authenticates *as the app*, and this
   * registry is the only place that ever holds it in memory.
   */
  applySubscription?: (credentials: FeishuCredentials) => Promise<{ status: "applied" | "failed"; reason?: string }>;
  /**
   * Write the *complete* `dsh-connect` section with `feishu` in `channels` and
   * `feishu.transport === "websocket"`, through the same path a pane save takes
   * (a partial write here would be a deletion — see the 0.9.2 rule). Rejecting
   * means the channel was not enabled.
   */
  requestEnable: () => Promise<void>;
  /**
   * Re-apply the running channels so the just-stored credentials take effect
   * now rather than at the next restart. Rejecting means `applied: "no"`.
   *
   * The reason for such a failure is deliberately *not* copied into the
   * outcome: the pane polls `settings.status` for the same snapshot, whose
   * `channelErrors` map already carries the adapter's own message, and a second
   * copy here could disagree with it.
   */
  reconcile: () => Promise<void>;
  language?: Language;
  logger?: { warn?: (...args: unknown[]) => void };
  /** Injectable for the expiry test, which otherwise waits 10 minutes. */
  now?: () => number;
  /** Injectable so a test can fire (or count) the expiry timer at will. */
  setTimer?: (callback: () => void, ms: number) => { cancel(): void };
}

/**
 * Compose the config write that enables Feishu, from the section in force now.
 *
 * The *complete* declared section goes back, never a fragment: this feeds the
 * same `save` a pane save uses, and a partial write there is a deletion (the
 * 0.9.2 rule) — it would drop every other channel the user had enabled and every
 * other `feishu` field. `transport` is pinned to `"websocket"` because that is
 * what the app the flow just created speaks; the webhook transport would need a
 * public URL and a verification token nobody configured.
 *
 * Pure and exported on purpose. The alternative was an inline closure inside
 * `apply`, whose only route to a test is a live `registerApp` against Feishu —
 * so the completeness rule would have had no test at all.
 */
export function enableFeishuConfig(section: Record<string, unknown>, allChannels: readonly string[]): Record<string, unknown> {
  const enabled = Array.isArray(section.channels) ? [...(section.channels as string[])] : [...allChannels];
  if (!enabled.includes("feishu")) enabled.push("feishu");
  const rawFeishu = section.feishu;
  const feishu = rawFeishu !== null && typeof rawFeishu === "object" && !Array.isArray(rawFeishu)
    ? { ...(rawFeishu as Record<string, unknown>) }
    : {};
  feishu.transport = "websocket";
  return { ...section, channels: enabled, feishu };
}

/** The pane-facing surface. */
export interface FeishuOnboardingRegistry {
  start(channel: string): Promise<OnboardingStatus>;
  status(): Promise<OnboardingStatus>;
  cancel(): Promise<OnboardingStatus>;
}

/** Default wall clock. */
function realNow(): number {
  return Date.now();
}

/** Default timer, matching the injected `{cancel}` shape. */
function realTimer(callback: () => void, ms: number): { cancel(): void } {
  const handle = setTimeout(callback, ms);
  return { cancel: () => clearTimeout(handle) };
}

/** A thrown value as a short string, for `reason`. */
function reasonOf(error: unknown): string {
  if (error instanceof Error && error.message !== "") return error.message;
  return String(error);
}

/**
 * Build the registry. One instance per plugin, so the single-flight state is
 * per-process — exactly the scope the device-authorization link has.
 */
export function createFeishuOnboarding(deps: FeishuOnboardingDeps): FeishuOnboardingRegistry {
  const now = deps.now ?? realNow;
  const setTimer = deps.setTimer ?? realTimer;
  const t = feishuMessages(deps.language ?? "zh");

  let phase: OnboardingPhase = "idle";
  let link: OnboardingLink | undefined;
  let outcome: OnboardingOutcome | undefined;
  /** Live, and still being mutated by a running flow — `finish` copies it out. */
  let live: OnboardingOutcome | undefined;
  /** Only ever used for an explicit `cancel()`; see the note in `run`. */
  let controller: AbortController | undefined;
  let expiry: { cancel(): void } | undefined;
  /** Never awaited by an RPC handler; only its side effects on the state above. */
  let flight: Promise<void> | undefined;

  const snapshot = (): OnboardingStatus => ({
    phase,
    channel: "feishu",
    ...(link === undefined ? {} : { link }),
    ...(outcome === undefined ? {} : { outcome }),
  });

  /** A flow that has latched a terminal phase must stop touching the state. */
  const stopped = (): boolean => phase !== "waiting";

  /**
   * Latch the first terminal phase and freeze a copy of the outcome.
   *
   * The latch is what makes cancel/expiry safe: the flow keeps running its
   * awaits afterwards, and every one of them re-checks {@link stopped} before
   * doing anything durable, so a cancelled flow can never write credentials.
   */
  function finish(next: Exclude<OnboardingPhase, "idle" | "waiting">, patch: Partial<OnboardingOutcome> = {}): void {
    if (phase !== "waiting" || live === undefined) return;
    phase = next;
    expiry?.cancel();
    expiry = undefined;
    controller = undefined;
    // A terminal phase means the link is spent — scanned, cancelled, or expired
    // — and the pane renders the link on its mere presence, not on the phase.
    // Leaving it in the snapshot would show a dead link inviting a scan right
    // beside the line saying the flow is over.
    link = undefined;
    const merged: OnboardingOutcome = { ...live };
    for (const [key, value] of Object.entries(patch)) {
      if (value !== undefined) (merged as unknown as Record<string, unknown>)[key] = value;
    }
    if (merged.reason === undefined) delete merged.reason;
    outcome = merged;
  }

  /** The five ordered steps; every one of them reports its own result. */
  async function run(state: OnboardingOutcome, signal: AbortSignal): Promise<void> {
    let credentials: FeishuCredentials | null = null;
    try {
      credentials = await deps.onboard(
        deps.logger,
        deps.language ?? "zh",
        {
          onQRCodeReady(info) {
            if (stopped()) return;
            const expiresAt = now() + info.expireIn * 1000;
            link = { url: info.url, expiresInSeconds: info.expireIn, expiresAt };
            expiry = setTimer(() => {
              deps.logger?.warn?.(t.onboardingFailed("expired_token"));
              finish("failed", { reason: "expired_token" });
              // The link is dead either way; stopping the poll loop is honest
              // housekeeping, not the thing that makes it expire.
              controller?.abort();
            }, Math.max(0, expiresAt - now()));
          },
          onError(code) {
            state.reason = code;
          },
          // 铁律：RPC 的 abort signal 绝不能接进 onboarding 流程。
          //
          // The settings HTTP handler aborts this request when the browser
          // navigates away or re-renders (`res.on("close")`), and the
          // device-authorization link is single-use and single-person. Wiring
          // that abort in would mean a page refresh silently burns the user's
          // only link. This signal is therefore wired to `cancel()` alone —
          // `AbortController` for the cancel button, nothing else. `start()`
          // returns before the flow ends and the RPC handler never awaits it,
          // so nothing downstream can revoke this.
          signal,
        },
      );
    } catch (error) {
      state.reason = reasonOf(error);
      deps.logger?.warn?.(t.onboardingFailed(state.reason));
    }
    if (stopped()) return;

    if (credentials === null) {
      finish("failed", { subscription: { attempted: false, status: "skipped", needsManualAction: true } });
      return;
    }
    state.created = true;
    state.appId = credentials.appId;

    // Step 2 — legacy mirror, same as the CLI path (`channels/feishu/index.ts`).
    state.legacyMirrorWritten = deps.legacySave(credentials);
    if (stopped()) return;

    // Step 3 — the credential store, keyed by credential *ref*: `save` looks
    // each value up by its ref, so a config-keyed map matches nothing, writes
    // nothing, and still reports success.
    if (deps.credentialStore !== undefined) {
      try {
        const refs = CHANNEL_SECRET_KEYS.feishu;
        await deps.credentialStore.save("feishu", {
          [refs.appId]: credentials.appId,
          [refs.appSecret]: credentials.appSecret,
        });
        state.credentialsStored = true;
      } catch (error) {
        deps.logger?.warn?.(`connect-feishu: could not persist credentials to the store: ${reasonOf(error)}`);
      }
    }
    if (stopped()) return;

    // Step 4 — event subscription. Best effort, and reported as such: see
    // `SubscriptionStep`. Never claims the long connection is live.
    if (deps.applySubscription === undefined) {
      state.subscription = { attempted: false, status: "not-attempted", needsManualAction: true };
    } else {
      try {
        const result = await deps.applySubscription(credentials);
        if (result.status === "applied") {
          state.subscription = { attempted: true, status: "applied", needsManualAction: false };
          deps.logger?.warn?.(t.onboardingSubscriptionApplied(credentials.appId));
        } else {
          state.subscription = {
            attempted: true,
            status: "failed",
            needsManualAction: true,
            ...(result.reason === undefined ? {} : { reason: result.reason }),
          };
          deps.logger?.warn?.(t.onboardingSubscriptionFailed(credentials.appId, result.reason ?? "unknown"));
        }
      } catch (error) {
        state.subscription = { attempted: true, status: "failed", reason: reasonOf(error), needsManualAction: true };
        deps.logger?.warn?.(t.onboardingSubscriptionFailed(credentials.appId, reasonOf(error)));
      }
    }
    if (stopped()) return;

    // Steps 5 + 6 — enable (a complete section write, then re-apply) so the
    // next boot connects without another scan. Both must land *before* the
    // reconcile the service performs, so one re-apply sees the credentials and
    // the enabled channel together.
    try {
      await deps.requestEnable();
      state.enableRequested = true;
      deps.logger?.warn?.(t.onboardingEnabled(credentials.appId));
    } catch (error) {
      deps.logger?.warn?.(`connect-feishu: could not enable the channel: ${reasonOf(error)}`);
    }
    if (stopped()) return;

    try {
      await deps.reconcile();
      state.applied = "yes";
    } catch (error) {
      state.applied = "no";
      deps.logger?.warn?.(`connect-feishu: the running channels did not reload: ${reasonOf(error)}`);
    }
    // The enable write itself failed, so "did the channel come up" was never
    // really asked — reporting `yes` off a reconcile that had nothing new to
    // apply is exactly the clean-success lie this outcome exists to prevent.
    if (!state.enableRequested) state.applied = "no";

    finish(state.credentialsStored || state.legacyMirrorWritten ? "done" : "failed");
  }

  return Object.freeze({
    async start(channel: string): Promise<OnboardingStatus> {
      if (channel !== "feishu") {
        const err = new Error("invalid-channel") as Error & { code: string };
        err.code = "invalid-channel";
        throw err;
      }
      // Single flight. A second flow would open a second link while the first
      // is still waiting to be scanned — the user can only scan one, and the
      // loser's app is left half-created in their tenant.
      if (phase === "waiting") return snapshot();

      phase = "waiting";
      link = undefined;
      outcome = undefined;
      controller = new AbortController();
      expiry = undefined;
      deps.logger?.warn?.(t.onboardingStarted);

      const state: OnboardingOutcome = {
        created: false,
        credentialsStored: false,
        legacyMirrorWritten: false,
        applied: "pending",
        subscription: { attempted: false, status: "not-attempted", needsManualAction: true },
        enableRequested: false,
      };
      live = state;
      const signal = controller.signal;

      // Fire and forget, with a terminal catch so a bug here can never surface
      // as an unhandled rejection (which would take the whole host process down
      // on Node ≥ 15) — and never as a rejected RPC response: the callback
      // returns as soon as the state is set up, so the link reaches the pane
      // immediately and the flow outlives the request that started it.
      flight = run(state, signal).catch((error) => {
        deps.logger?.warn?.(`connect-feishu: onboarding flow failed: ${reasonOf(error)}`);
        state.reason = reasonOf(error);
        finish("failed");
      });
      void flight;

      return snapshot();
    },

    async status(): Promise<OnboardingStatus> {
      return snapshot();
    },

    async cancel(): Promise<OnboardingStatus> {
      const active = controller;
      if (phase === "waiting") {
        deps.logger?.warn?.(t.onboardingCancelled);
        // Latch first, then abort: `finish` is what makes the rest of the flow
        // stop writing, so the order is not cosmetic.
        finish("cancelled", { reason: "abort" });
      }
      active?.abort();
      return snapshot();
    },
  });
}
