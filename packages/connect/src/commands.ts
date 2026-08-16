/**
 * Slash-command parsing for chat control. Commands run without waking the
 * agent, so they stay fast and side-effect-free for the model.
 * @module dsh-connect/commands
 */
import type { Messages } from "./i18n.js";

export type Command =
  | { readonly kind: "new" }
  | { readonly kind: "clear" }
  | { readonly kind: "stop" }
  | { readonly kind: "status" }
  | { readonly kind: "task" }
  | { readonly kind: "dir"; readonly path?: string }
  | { readonly kind: "chat" }
  | { readonly kind: "menu" }
  | { readonly kind: "settings" }
  | { readonly kind: "plugins" }
  | { readonly kind: "workspace"; readonly path?: string }
  | { readonly kind: "compact" }
  | { readonly kind: "history"; readonly limit?: number }
  | { readonly kind: "goals" }
  | { readonly kind: "schedule" }
  | { readonly kind: "model" }
  | { readonly kind: "workspaces" }
  | { readonly kind: "help" }
  | { readonly kind: "message"; readonly text: string };

export function parseCommand(raw: string): Command {
  const text = raw.trim();
  const space = text.indexOf(" ");
  const head = space === -1 ? text : text.slice(0, space);
  const arg = space === -1 ? undefined : text.slice(space + 1).trim();

  switch (head) {
    case "/new":
    case "/reset":
      return { kind: "new" };
    case "/clear":
      return { kind: "clear" };
    case "/stop":
    case "/cancel":
      return { kind: "stop" };
    case "/status":
      return { kind: "status" };
    case "/task":
    case "/tasks":
    case "/todo":
      return { kind: "task" };
    case "/dir":
    case "/cd":
    case "/pwd":
      return arg === undefined || arg === "" ? { kind: "dir" } : { kind: "dir", path: arg };
    case "/chat":
    case "/session":
    case "/sessions":
    case "/conversations":
      return { kind: "chat" };
    case "/menu":
    case "/m":
      return { kind: "menu" };
    case "/settings":
    case "/set":
      return { kind: "settings" };
    case "/plugins":
    case "/plugin":
      return { kind: "plugins" };
    case "/workspace":
    case "/ws":
      return arg === undefined || arg === "" ? { kind: "workspace" } : { kind: "workspace", path: arg };
    case "/compact":
      return { kind: "compact" };
    case "/history":
    case "/hist":
      return arg !== undefined && /^\d+$/.test(arg) ? { kind: "history", limit: Number(arg) } : { kind: "history" };
    case "/goals":
    case "/goal":
      return { kind: "goals" };
    case "/schedule":
    case "/reminders":
      return { kind: "schedule" };
    case "/model":
      return { kind: "model" };
    case "/workspaces":
    case "/wslist":
      return { kind: "workspaces" };
    case "/help":
    case "/start":
      return { kind: "help" };
    default:
      return { kind: "message", text };
  }
}

export function helpText(t: Messages): string {
  return [
    t.helpHeader,
    "- `/menu` " + t.helpMenu,
    "- `/settings`（`/set`）" + t.helpSettings,
    "- `/status` " + t.helpStatus,
    "- `/task` " + t.helpTask,
    "- `/chat`（`/session`）" + t.helpChat,
    "- `/dir` " + t.helpDir,
    "- `/workspace <absolute path>` " + t.helpWorkspace,
    "- `/plugins` " + t.helpPlugins,
    "- `/compact` " + t.helpCompact,
    "- `/history [count]` " + t.helpHistory,
    "- `/goals` " + t.helpGoals,
    "- `/schedule` " + t.helpSchedule,
    "- `/model` " + t.helpModel,
    "- `/workspaces` " + t.helpWorkspaces,
    "- `/new` " + t.helpNew,
    "- `/clear` " + t.helpClear,
    "- `/stop` " + t.helpStop,
    "- " + t.helpOther,
  ].join("\n");
}
