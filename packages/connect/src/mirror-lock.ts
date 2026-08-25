/**
 * Pure lock-state machine for the Feishu ↔ Web mirror mutual exclusion.
 *
 * A mirrored chat has two writers: the Feishu runner (chat side) and the Web
 * GUI (which reads/writes the shared DSH session directly). The `lockOwner`
 * field on a binding records which channel currently owns write access so the
 * two sides do not drive the same session concurrently. This module contains
 * every transition as a pure function over a `LockState`-shaped object — no
 * I/O, no adapter calls — so the state machine is unit-testable in isolation.
 * @module dsh-connect/mirror-lock
 */

/** Default lock timeout (5 minutes) when a binding has no explicit timeout. */
export const DEFAULT_LOCK_TIMEOUT_MS = 5 * 60 * 1000;

/** One message parked in `queuedMessages` while the session lock is held. */
export interface QueuedMessage {
  text: string;
  senderKey: string;
  timestamp: number;
  replyRef?: string;
  images?: readonly string[];
  files?: readonly string[];
  /** Channel the message originated on; used when replaying after lock release. */
  channel?: string;
}

/** The lock-related slice of a `ChatBinding` (structural; keeps this module decoupled). */
export interface LockState {
  lockOwner?: "feishu" | "web";
  lockAcquiredAt?: number;
  lockTimeoutMs?: number;
  queuedMessages?: QueuedMessage[];
}

/** True when a lock exists and its acquisition timestamp is older than its timeout. */
export function isLockTimedOut(state: LockState, now = Date.now()): boolean {
  if (state.lockOwner === undefined || state.lockAcquiredAt === undefined) return false;
  const timeoutMs = state.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  return now - state.lockAcquiredAt > timeoutMs;
}

/**
 * Whether `channel` may write to the session. A timed-out lock counts as
 * free (the caller normally releases it and notifies the user).
 */
export function canWrite(state: LockState, channel: "feishu" | "web", now = Date.now()): boolean {
  if (state.lockOwner === undefined) return true;
  if (isLockTimedOut(state, now)) return true;
  return state.lockOwner === channel;
}

/**
 * Acquire (or renew) the lock for `channel`. Returns the next state when the
 * lock is free, timed out, or already owned by `channel`; `undefined` when a
 * different channel currently holds a live lock. Generic over the full state
 * object so callers keep their complete binding type.
 */
export function acquire<S extends LockState>(state: S, channel: "feishu" | "web", now = Date.now()): S | undefined {
  if (state.lockOwner !== undefined && !isLockTimedOut(state, now) && state.lockOwner !== channel) {
    return undefined;
  }
  return {
    ...state,
    lockOwner: channel,
    lockAcquiredAt: now,
    lockTimeoutMs: state.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS,
  };
}

/**
 * Release the lock, preserving every other field (including the parked queue —
 * the caller drains `queuedMessages` before or after releasing).
 */
export function release<S extends LockState>(state: S): S {
  return { ...state, lockOwner: undefined, lockAcquiredAt: undefined };
}
