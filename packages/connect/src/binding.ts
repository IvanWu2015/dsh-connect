/**
 * Durable chatKey → session routing, kept separately from DSH's own session
 * persistence. DSH persists each session transcript; this file persists which
 * sessions belong to which chat and which one is active, so a restarted process
 * can list and resume the right agents.
 * @module dsh-connect/binding
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

/** One historical conversation for a chat. */
export interface ChatSessionRecord {
  sessionId: string;
  /** Short human label (usually the first prompt). */
  title: string;
  createdAt: number;
  lastActiveAt: number;
  workDir: string;
}

export interface ChatBinding {
  channel: string;
  chatKey: string;
  chatType: "p2p" | "group";
  /** The active session id for this chat. */
  sessionId: string;
  ownerKey: string;
  createdAt: number;
  lastActiveAt: number;
  /** Per-chat UI language override (`zh` / `en`); falls back to the plugin config. */
  language?: "zh" | "en";
  /** Per-chat notification level for streaming replies; falls back to the plugin config. */
  notifyLevel?: "full" | "important" | "result";
  /** Per-chat proactive progress-notice interval ms (0 disables); falls back to the plugin config. */
  progressTimeoutMs?: number;
  /** Web mirror session id (shared with DSH Web for viewing). */
  webMirrorSessionId?: string;
  /** Session lock status: which channel currently owns write access. */
  lockOwner?: "feishu" | "web";
  /** Timestamp when the lock was acquired (for timeout detection). */
  lockAcquiredAt?: number;
  /** Lock timeout in milliseconds (default 5 minutes). */
  lockTimeoutMs?: number;
  /** Queued messages waiting for lock release (Web → Feishu bridge). */
  queuedMessages?: Array<{ 
    text: string; 
    senderKey: string; 
    timestamp: number;
    replyRef?: string;
    images?: readonly string[];
    files?: readonly string[];
  }>;
  /** Every conversation ever opened in this chat, oldest last. */
  sessions: ChatSessionRecord[];
}

function keyOf(channel: string, chatKey: string): string {
  return `${channel}\u0000${chatKey}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeSessions(value: unknown): ChatSessionRecord[] {
  if (!Array.isArray(value)) return [];
  const out: ChatSessionRecord[] = [];
  for (const item of value) {
    if (!isRecord(item) || typeof item.sessionId !== "string") continue;
    out.push({
      sessionId: item.sessionId,
      title: typeof item.title === "string" ? item.title : item.sessionId,
      createdAt: typeof item.createdAt === "number" ? item.createdAt : Date.now(),
      lastActiveAt: typeof item.lastActiveAt === "number" ? item.lastActiveAt : Date.now(),
      workDir: typeof item.workDir === "string" ? item.workDir : "",
    });
  }
  return out;
}

/** Callback type for binding change events. */
export type BindingChangeCallback = (binding: ChatBinding, changeType: "add" | "update" | "delete") => void;

export class BindingStore {
  private readonly map = new Map<string, ChatBinding>();
  private readonly file: string;
  private readonly changeListeners = new Set<BindingChangeCallback>();

  constructor(stateDir?: string) {
    const dir = stateDir ?? process.env.DSH_CONNECT_STATE_DIR ?? ".dsh-connect";
    this.file = resolve(dir, "bindings.json");
    this.load();
  }

  /**
   * Register a listener for binding changes.
   * @param callback - Function called when any binding is added, updated, or deleted
   * @returns Unsubscribe function
   */
  onChange(callback: BindingChangeCallback): () => void {
    this.changeListeners.add(callback);
    return () => {
      this.changeListeners.delete(callback);
    };
  }

  /**
   * Emit a change event to all registered listeners.
   */
  private emitChange(binding: ChatBinding, changeType: "add" | "update" | "delete"): void {
    for (const listener of this.changeListeners) {
      try {
        listener(binding, changeType);
      } catch {
        // Listener errors should not break the store
      }
    }
  }

  /**
   * Iterate over all bindings in the store.
   * @returns Iterator of all ChatBinding entries
   */
  entries(): IterableIterator<ChatBinding> {
    return this.map.values();
  }

  /**
   * Get all bindings as an array.
   */
  list(): ChatBinding[] {
    return [...this.map.values()];
  }

  /**
   * Find bindings by webMirrorSessionId.
   * @param sessionId - The session ID to search for
   * @returns Array of bindings that have this sessionId as their webMirrorSessionId
   */
  findByWebMirror(sessionId: string): ChatBinding[] {
    const results: ChatBinding[] = [];
    for (const binding of this.map.values()) {
      if (binding.webMirrorSessionId === sessionId) {
        results.push(binding);
      }
    }
    return results;
  }

  get(channel: string, chatKey: string): ChatBinding | undefined {
    return this.map.get(keyOf(channel, chatKey));
  }

  put(binding: ChatBinding): void {
    const key = keyOf(binding.channel, binding.chatKey);
    const existed = this.map.has(key);
    this.map.set(key, binding);
    this.save();
    this.emitChange(binding, existed ? "update" : "add");
  }

  delete(channel: string, chatKey: string): void {
    const key = keyOf(channel, chatKey);
    const binding = this.map.get(key);
    if (binding !== undefined) {
      this.map.delete(key);
      this.save();
      this.emitChange(binding, "delete");
    }
  }

  private load(): void {
    try {
      const raw = readFileSync(this.file, "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return;
      for (const item of parsed) {
        if (!isRecord(item)) continue;
        const b = item;
        if (typeof b.channel !== "string" || typeof b.chatKey !== "string" || typeof b.sessionId !== "string") continue;
        this.map.set(keyOf(b.channel, b.chatKey), {
          channel: b.channel,
          chatKey: b.chatKey,
          chatType: b.chatType === "group" ? "group" : "p2p",
          sessionId: b.sessionId,
          ownerKey: typeof b.ownerKey === "string" ? b.ownerKey : "",
          createdAt: typeof b.createdAt === "number" ? b.createdAt : Date.now(),
          lastActiveAt: typeof b.lastActiveAt === "number" ? b.lastActiveAt : Date.now(),
          ...(b.language === "zh" || b.language === "en" ? { language: b.language } : {}),
          ...(b.notifyLevel === "full" || b.notifyLevel === "important" || b.notifyLevel === "result" ? { notifyLevel: b.notifyLevel } : {}),
          ...(typeof b.progressTimeoutMs === "number" && b.progressTimeoutMs >= 0 ? { progressTimeoutMs: b.progressTimeoutMs } : {}),
          ...(typeof b.webMirrorSessionId === "string" ? { webMirrorSessionId: b.webMirrorSessionId } : {}),
          ...(b.lockOwner === "feishu" || b.lockOwner === "web" ? { lockOwner: b.lockOwner } : {}),
          ...(typeof b.lockAcquiredAt === "number" ? { lockAcquiredAt: b.lockAcquiredAt } : {}),
          ...(typeof b.lockTimeoutMs === "number" ? { lockTimeoutMs: b.lockTimeoutMs } : {}),
          ...(Array.isArray(b.queuedMessages) ? { queuedMessages: b.queuedMessages.filter((m): m is { text: string; senderKey: string; timestamp: number } => 
            typeof m === "object" && m !== null && typeof (m as any).text === "string" && typeof (m as any).senderKey === "string"
          ) } : {}),
          sessions: normalizeSessions(b.sessions),
        });
      }
    } catch {
      // Missing or corrupt file: start empty.
    }
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify([...this.map.values()], null, 2), "utf8");
    } catch {
      // Persistence is best-effort; live bindings still work in-memory.
    }
  }
}
