/**
 * Menu rendering types and pure label/data helpers.
 *
 * The menu concern is split out from the per-chat driver so that the mapping
 * from a menu id / end-reason / goal phase to a localized label, and the
 * workspace listing, can be tested and reused without the driver's runtime
 * state. Everything here is a pure function of its arguments (no `this`).
 * @module dsh-connect/menus
 */
import type { Messages } from "./i18n.js";
import type { InboundMessage, OutboundTarget, TurnReason } from "./types.js";

export type MenuId =
  | "root"
  | "workspace"
  | "chat"
  | "settings"
  | "model"
  | "reasoning"
  | "notify"
  | "language"
  | "progress";

export interface MenuItem {
  id: string;
  label: string;
  /** Leaf action: after it runs, the menu returns to the root menu on the same card. */
  leaf?: boolean;
  /**
   * `messageId` is the menu card id: pass it to `openMenu` to navigate in place,
   * or close the card. A returned string is sent to the chat as the action's
   * result feedback before the menu returns, so every button press answers
   * visibly instead of leaving the user to guess whether it worked.
   */
  onSelect: (target: OutboundTarget, msg: InboundMessage, messageId: string) => Promise<string | void>;
}

/** Localized menu title for a menu id. */
export function menuTitle(menuId: MenuId, t: Messages): string {
  switch (menuId) {
    case "root":
      return t.menuRoot;
    case "workspace":
      return t.menuWorkspace;
    case "chat":
      return t.menuChat;
    case "settings":
      return t.menuSettings;
    case "model":
      return t.menuModel;
    case "reasoning":
      return t.menuReasoning;
    case "notify":
      return t.menuNotify;
    case "language":
      return t.menuSettingsLanguage;
    case "progress":
      return t.progressMenuTitle;
  }
}

/** Named root-menu sections: workspace / chat (1 col), task / system (2 col). */
export function rootMenuSections(t: Messages): readonly { title: string; ids: readonly string[]; columnsPerRow?: number }[] {
  return [
    { title: t.rootSectionWorkspace, ids: ["workspace"], columnsPerRow: 1 },
    { title: t.rootSectionChat, ids: ["chat", "history"], columnsPerRow: 1 },
    { title: t.rootSectionTask, ids: ["task", "goals", "schedule"], columnsPerRow: 2 },
    { title: t.rootSectionSystem, ids: ["status", "plugins", "compact", "settings"], columnsPerRow: 2 },
  ];
}

/** Localized label for a turn end reason. */
export function reasonLabel(reason: TurnReason, t: Messages): string {
  switch (reason) {
    case "completed":
      return t.reasonCompleted;
    case "aborted":
      return t.reasonAborted;
    case "blocked":
      return t.reasonBlocked;
    case "error":
      return t.reasonError;
    case "max-tokens":
      return t.reasonMaxTokens;
    case "interrupted":
      return t.reasonInterrupted;
    default:
      return t.reasonUnknown;
  }
}

/** Localized label for a goal phase. */
export function goalPhaseLabel(phase: string, t: Messages): string {
  switch (phase) {
    case "active":
      return t.goalPhaseActive;
    case "paused":
      return t.goalPhasePaused;
    case "blocked":
      return t.goalPhaseBlocked;
    case "complete":
      return t.goalPhaseComplete;
    default:
      return phase;
  }
}

export interface WorkspaceInfo {
  path: string;
  title: string;
}

/** Dedupe (case-insensitive, trailing-slash-normalized) the workspace candidates. */
export function listWorkspaces(opts: {
  registry?: { list?: () => readonly { path: string; title: string }[] } | undefined;
  workDir: string;
  currentDirLabel: string;
  workspaces: readonly string[];
}): WorkspaceInfo[] {
  const out: WorkspaceInfo[] = [];
  const seen = new Set<string>();
  const add = (path: string, title: string) => {
    if (path === "") return;
    const key = path.replace(/[\\/]+$/, "").toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ path, title: title || path });
  };
  add(opts.workDir, opts.currentDirLabel);
  for (const w of opts.registry?.list?.() ?? []) add(w.path, w.title);
  for (const p of opts.workspaces) add(p, p);
  return out;
}
