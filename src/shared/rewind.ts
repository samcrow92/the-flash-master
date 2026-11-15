import type { Message } from "./types";

/**
 * Edit & resend / retry: which user message runs again and which messages go. Shared by the main process (which
 * enforces it) and the chat (which shows the Edit / Retry buttons only where they apply).
 *
 * `scope` is the conversation the message belongs to, in server order: the chat's main messages when it has no parent,
 * else its thread (root first, then the replies). A thread root always belongs to the main chat.
 */
export type RewindPlan =
  | { ok: true; user: Message; remove: Message[] }
  | { ok: false; reason: string };

const turnMsg = (m: Message) => !m.marker && (m.author === "user" || m.author === "agent");

/** Edit: only the user's last message in its chat or thread, once its replies have finished. */
export function planEdit(scope: Message[], id: string): RewindPlan {
  const i = scope.findIndex((m) => m.id === id);
  const m = scope[i];
  if (!m || m.author !== "user" || m.marker) return { ok: false, reason: "Only your own messages can be edited." };
  const after = scope.slice(i + 1);
  if (after.some((x) => x.author === "user" && turnMsg(x))) return { ok: false, reason: "Only your last message can be edited." };
  if (after.some((x) => x.status === "streaming")) return { ok: false, reason: "Wait for the reply to finish, or stop it first." };
  // A main-chat message with its own thread: the thread answered the old text, and editing would leave it orphaned.
  if (!m.parentId && m.replyCount > 0) return { ok: false, reason: "This message has a thread; reply there instead." };
  return { ok: true, user: m, remove: after };
}

/** Retry: the last agent reply of the last turn; the user message that prompted it is sent again. */
export function planRetry(scope: Message[], id: string): RewindPlan {
  const i = scope.findIndex((m) => m.id === id);
  const m = scope[i];
  if (!m || m.author !== "agent") return { ok: false, reason: "Only agent replies can be retried." };
  const after = scope.slice(i + 1);
  if (after.some((x) => turnMsg(x))) return { ok: false, reason: "Only the latest reply can be retried." };
  if (m.status === "streaming" || after.some((x) => x.status === "streaming")) return { ok: false, reason: "Wait for the reply to finish, or stop it first." };
  let u = -1;
  for (let k = i - 1; k >= 0; k--) {
    const x = scope[k]!;
    if (x.marker) break; // never reach back across a context reset
    if (x.author === "user") { u = k; break; }
  }
  if (u < 0) return { ok: false, reason: "There is no message of yours to send again." };
  return { ok: true, user: scope[u]!, remove: scope.slice(u + 1) };
}
