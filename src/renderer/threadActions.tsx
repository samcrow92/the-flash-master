import type { Chat, Message } from "@shared/types";
import { api, useStore } from "./store";
import { previewText } from "./threadList";
import { Archive, ArchiveRestore, Trash2 } from "./components/icons";
import type { MenuItem } from "./components/ContextMenu";

/** Archive / delete for threads and messages, shared by the Threads tab of the side sheet and the message actions. */

const failed = (e: any) => useStore.getState().toast("warn", String(e?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ""));
const quote = (m: Message) => previewText(m.content, 40) || "this message";

/** Fold a thread up in the Threads tab. */
function collapse(rootId: string): void {
  useStore.getState().closeThread(rootId);
}

export async function archiveThread(root: Message, archived: boolean): Promise<void> {
  try {
    if (archived) collapse(root.id);
    await api().archiveThread(root.id, archived);
    useStore.getState().toast("info", archived ? "Thread archived — find it under Archived in the Threads panel" : "Thread restored");
  } catch (e) { failed(e); }
}

export async function deleteThread(root: Message): Promise<void> {
  const n = Math.max(root.replyCount, 0);
  if (!confirm(`Delete the thread on “${quote(root)}” and its ${n} ${n === 1 ? "reply" : "replies"}? The message itself stays. This cannot be undone.`)) return;
  try {
    await api().deleteThread(root.id);
    collapse(root.id);
    useStore.getState().toast("info", "Thread deleted");
  } catch (e) { failed(e); }
}

export async function deleteMessage(m: Message): Promise<void> {
  const thread = !m.parentId && m.replyCount > 0 ? ` and its thread (${m.replyCount} ${m.replyCount === 1 ? "reply" : "replies"})` : "";
  if (!confirm(`Delete “${quote(m)}”${thread}? This cannot be undone.`)) return;
  try {
    await api().deleteMessage(m.id);
    if (!m.parentId) collapse(m.id);
  } catch (e) { failed(e); }
}

export async function clearChat(chat: Chat): Promise<void> {
  if (!confirm(`Delete every message in “${chat.title}”, threads included? Agents start fresh. This cannot be undone.`)) return;
  try {
    await api().clearChat(chat.id);
    useStore.getState().toast("info", "Chat cleared");
  } catch (e) { failed(e); }
}

/** Archive / restore / delete for one thread (row menu in the panel, header menu on inline threads). */
export function threadMenu(root: Message): MenuItem[] {
  return [
    root.threadArchived
      ? { label: "Restore thread", icon: <ArchiveRestore size={15} />, onClick: () => void archiveThread(root, false) }
      : { label: "Archive thread", icon: <Archive size={15} />, onClick: () => void archiveThread(root, true) },
    { label: "Delete thread…", icon: <Trash2 size={15} />, danger: true, disabled: root.replyCount <= 0, onClick: () => void deleteThread(root) },
  ];
}

