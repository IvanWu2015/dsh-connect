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

export class BindingStore {
  private readonly map = new Map<string, ChatBinding>();
  private readonly file: string;

  constructor(stateDir?: string) {
    const dir = stateDir ?? process.env.DSH_CONNECT_STATE_DIR ?? ".dsh-connect";
    this.file = resolve(dir, "bindings.json");
    this.load();
  }

  get(channel: string, chatKey: string): ChatBinding | undefined {
    return this.map.get(keyOf(channel, chatKey));
  }

  put(binding: ChatBinding): void {
    this.map.set(keyOf(binding.channel, binding.chatKey), binding);
    this.save();
  }

  delete(channel: string, chatKey: string): void {
    this.map.delete(keyOf(channel, chatKey));
    this.save();
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
