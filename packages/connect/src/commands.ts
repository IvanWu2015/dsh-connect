/**
 * Slash-command parsing for chat control. Commands run without waking the
 * agent, so they stay fast and side-effect-free for the model.
 * @module dsh-connect/commands
 */

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
    case "/help":
    case "/start":
      return { kind: "help" };
    default:
      return { kind: "message", text };
  }
}

export const HELP_TEXT = [
  "可用命令（本地执行，不消耗模型）：",
  "- `/menu` 打开主菜单（层级点选，可返回）",
  "- `/settings`（`/set`）打开设置：模型 / 推理强度 / 通知 / 配置总览",
  "- `/status` 查看会话状态、模型、工作目录、排队数",
  "- `/task` 查看当前任务清单（todo）",
  "- `/chat`（`/session`）列出对话，点选切换或新建",
  "- `/dir` 列出工作目录，点选切换（或 `/dir <绝对路径>` 手动指定）",
  "- `/new` 开启新对话",
  "- `/clear` 清空当前对话",
  "- `/stop` 停止当前任务",
  "- 其他文本将作为任务发送给 DSH Agent",
].join("\n");
