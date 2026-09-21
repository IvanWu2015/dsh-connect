/**
 * Thread-scoped chat keys.
 *
 * A chat key is otherwise opaque to the core: every channel picks whatever
 * identifies one conversation (a Feishu `oc_…`, a Telegram chat id, a DingTalk
 * `cid…`). Feishu's `threadIsolation` widens it — a group message inside a
 * thread gets `chatId:thread=<rootId>` so each thread binds its own DSH session
 * and its own runner.
 *
 * The allowlists in the plugin config are written with plain chat ids, so the
 * core reduces a key to its base id before comparing (`baseChatId`). Keeping
 * the encoding here rather than in the Feishu adapter is deliberate: the core
 * gate and the adapter's pre-download gate must agree, and they only do so
 * while a single module owns the format.
 * @module dsh-connect/chat-key
 */

/** Suffix joining a base chat id to its thread id. */
const THREAD_SEP = ":thread=";

/**
 * Encode a chat key with an optional thread id. Outbound sends still target the
 * base chat id (replies land in the thread via `replyRef`).
 */
export function encodeChatKey(chatId: string, threadId?: string): string {
  return threadId === undefined || threadId === "" ? chatId : `${chatId}${THREAD_SEP}${threadId}`;
}

/** Decode a possibly thread-scoped chat key back to its base chat id. */
export function decodeChatKey(chatKey: string): { chatId: string; threadId?: string } {
  const sep = chatKey.indexOf(THREAD_SEP);
  if (sep === -1) return { chatId: chatKey };
  return { chatId: chatKey.slice(0, sep), threadId: chatKey.slice(sep + THREAD_SEP.length) };
}

/** Base chat id of a chat key, thread-scoped or not. */
export function baseChatId(chatKey: string): string {
  const sep = chatKey.indexOf(THREAD_SEP);
  return sep === -1 ? chatKey : chatKey.slice(0, sep);
}
