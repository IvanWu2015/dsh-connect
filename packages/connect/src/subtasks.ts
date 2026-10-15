/**
 * Subtask progress in the chat.
 *
 * When an agent decomposes a task into subtasks (`todo/write`), the chat used to learn
 * nothing until the user asked with `/task`. For a long run that is the wrong default:
 * the plan is the single most useful thing to see early, and a plan whose entries never
 * change on screen stops being trusted. This renders the list once and then keeps it
 * current in place.
 *
 * The rendering is kept pure so the rules that are easy to get wrong — the cap, which
 * entries survive it, and whether a re-render is worth an API call at all — can be tested
 * without a channel.
 */
import type { TodoItem } from "@deepseek-ai/dsh-tool-todo";

/**
 * The most entries shown. A decomposed task can legitimately produce dozens, and a
 * forty-line card is not a summary — it is a wall the user scrolls past. Ten is what
 * fits on a phone screen with room for the counts.
 */
export const MAX_SUBTASKS = 10;

/** Only a real decomposition is worth a list. A single todo is just the task. */
export const MIN_SUBTASKS = 2;

/** One entry's mark, in the order the user reads them. */
function markOf(status: TodoItem["status"]): string {
  if (status === "completed") return "✅";
  if (status === "in_progress") return "🔄";
  return "⬜";
}

export interface SubtaskRender {
  /** Stable identity of this exact rendered state, for change detection. */
  key: string;
  /** The card/text body. */
  body: string;
  total: number;
  completed: number;
}

/**
 * Render the list, or `undefined` when it is not a decomposition worth posting.
 *
 * The cap keeps the *first* entries and the in-progress one, rather than merely the first
 * ten: with a long list the items being worked on are exactly the ones the user wants, and
 * they are usually not at the top once some are done. Anything dropped is acknowledged
 * with a count, so a truncated list never silently misrepresents the work.
 */
export function renderSubtasks(todos: readonly TodoItem[]): SubtaskRender | undefined {
  if (todos.length < MIN_SUBTASKS) return undefined;
  const completed = todos.filter((t) => t.status === "completed").length;
  const total = todos.length;

  const head = todos.slice(0, MAX_SUBTASKS);
  // If the cap cut anything, prefer to keep the active entry visible: swap the last shown
  // entry for the first in-progress one that did not make the cut.
  let shown = head;
  if (total > MAX_SUBTASKS) {
    const active = todos.find((t, i) => i >= MAX_SUBTASKS && t.status === "in_progress");
    if (active !== undefined) shown = [...todos.slice(0, MAX_SUBTASKS - 1), active];
  }
  const hidden = total - shown.length;

  const lines = shown.map((t) => `${markOf(t.status)} ${t.content}`);
  if (hidden > 0) lines.push(`… 另有 ${hidden} 项`);

  const body = `📋 子任务（${completed}/${total} 已完成）\n${lines.join("\n")}`;
  const key = todos.map((t) => `${t.status}:${t.content}`).join("|");
  return { key, body, total, completed };
}
