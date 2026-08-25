/**
 * Persistent chat-level scheduled reminders.
 *
 * `/remind 10分钟 提醒我喝水` stores a reminder in `stateDir/reminders.json`
 * (same pattern as the binding store) and a lightweight loop in the connect
 * service delivers it when it comes due — across process restarts, without
 * waking the agent or spending model tokens. This is separate from the DSH
 * agent's own in-session `schedule` tool (which requires the plugin mounted
 * in the profile and only lives while the session does).
 * @module dsh-connect/scheduler
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

/** One pending (or fired) reminder. */
export interface ScheduledReminder {
  id: string;
  /** Channel id the reminder is bound to ("feishu", "telegram", …). */
  channel: string;
  chatKey: string;
  chatType: "p2p" | "group";
  /** The message delivered when the reminder fires. */
  text: string;
  /** Epoch ms when the reminder should fire. */
  dueAt: number;
  createdAt: number;
  /** Sender key of the user who created it. */
  ownerKey: string;
  /** Set once delivered; kept so a crashed process doesn't re-fire old entries. */
  fired?: boolean;
}

/**
 * Parse a `/remind` time expression into an epoch ms.
 * Supported forms (relative or clock time):
 * - `10分钟` / `10m` / `10` → minutes from now
 * - `2小时` / `2h` → hours from now
 * - `14:30` → today at 14:30 (tomorrow if already past)
 * Returns `undefined` when the expression is not recognized.
 */
export function parseRemindTime(arg: string, now = Date.now()): number | undefined {
  const s = arg.trim().toLowerCase();
  if (s === "") return undefined;

  // Relative minutes: "10", "10m", "10分钟", "10 分"
  const minutes = s.match(/^(\d+)\s*(m|分钟|分)?$/);
  if (minutes !== null) {
    const value = Number(minutes[1]);
    if (!Number.isFinite(value) || value <= 0) return undefined;
    return now + value * 60_000;
  }

  // Relative hours: "2h", "2小时", "2 小时"
  const hours = s.match(/^(\d+)\s*(h|小时|时)$/);
  if (hours !== null) {
    const value = Number(hours[1]);
    if (!Number.isFinite(value) || value <= 0) return undefined;
    return now + value * 3_600_000;
  }

  // Clock time: "14:30" (or "9:05") — today, or tomorrow when already past.
  const clock = s.match(/^(\d{1,2}):(\d{2})$/);
  if (clock !== null) {
    const hour = Number(clock[1]);
    const minute = Number(clock[2]);
    if (hour > 23 || minute > 59) return undefined;
    const at = new Date(now);
    at.setHours(hour, minute, 0, 0);
    if (at.getTime() <= now) at.setDate(at.getDate() + 1);
    return at.getTime();
  }

  return undefined;
}

/** Human-readable display of a due time, in the user-facing language. */
export function formatRemindAt(dueAt: number, language: "zh" | "en" = "zh", now = Date.now()): string {
  const date = new Date(dueAt);
  const today = new Date(now);
  // Local-time components so the render is identical on every host timezone.
  const time = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  if (date.toDateString() === today.toDateString()) return time;
  const locale = language === "en" ? "en-US" : "zh-CN";
  const day = date.toLocaleDateString(locale, { month: "numeric", day: "numeric" });
  return `${day} ${time}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** JSON-file reminder store (best-effort persistence, live in-memory truth). */
export class ReminderStore {
  private readonly file: string;
  private reminders: ScheduledReminder[] = [];

  constructor(stateDir?: string) {
    const dir = stateDir ?? process.env.DSH_CONNECT_STATE_DIR ?? ".dsh-connect";
    this.file = resolve(dir, "reminders.json");
    this.load();
  }

  /** All reminders, nearest-due first. */
  list(): ScheduledReminder[] {
    return [...this.reminders].sort((a, b) => a.dueAt - b.dueAt);
  }

  /** Reminders bound to one chat, nearest-due first. */
  listFor(channel: string, chatKey: string): ScheduledReminder[] {
    return this.reminders
      .filter((r) => r.channel === channel && r.chatKey === chatKey)
      .sort((a, b) => a.dueAt - b.dueAt);
  }

  /** Reminders that have come due and were not yet fired. */
  due(now = Date.now()): ScheduledReminder[] {
    return this.reminders.filter((r) => r.fired !== true && r.dueAt <= now);
  }

  add(input: Omit<ScheduledReminder, "id" | "createdAt" | "fired">): ScheduledReminder {
    const reminder: ScheduledReminder = {
      ...input,
      id: randomUUID(),
      createdAt: Date.now(),
    };
    this.reminders.push(reminder);
    this.save();
    return reminder;
  }

  remove(id: string): boolean {
    const before = this.reminders.length;
    this.reminders = this.reminders.filter((r) => r.id !== id);
    if (this.reminders.length !== before) {
      this.save();
      return true;
    }
    return false;
  }

  markFired(id: string): void {
    const reminder = this.reminders.find((r) => r.id === id);
    if (reminder === undefined || reminder.fired === true) return;
    reminder.fired = true;
    this.save();
  }

  private load(): void {
    try {
      const raw = readFileSync(this.file, "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return;
      const out: ScheduledReminder[] = [];
      for (const item of parsed) {
        if (!isRecord(item)) continue;
        if (typeof item.channel !== "string" || typeof item.chatKey !== "string") continue;
        out.push({
          id: typeof item.id === "string" ? item.id : randomUUID(),
          channel: item.channel,
          chatKey: item.chatKey,
          chatType: item.chatType === "group" ? "group" : "p2p",
          text: typeof item.text === "string" ? item.text : "",
          dueAt: typeof item.dueAt === "number" ? item.dueAt : 0,
          createdAt: typeof item.createdAt === "number" ? item.createdAt : Date.now(),
          ownerKey: typeof item.ownerKey === "string" ? item.ownerKey : "",
          ...(item.fired === true ? { fired: true } : {}),
        });
      }
      this.reminders = out;
    } catch {
      // Missing or corrupt file: start empty.
    }
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify(this.reminders, null, 2), "utf8");
    } catch {
      // Persistence is best-effort; live reminders still fire in-memory.
    }
  }
}
