import type { Chat, Message } from "@shared/types";
import { api, useStore } from "./store";
import { previewText } from "./threadList";

/** Delete a message, or clear a chat (message actions and the chat menu). */

const failed = (e: any) => useStore.getState().toast("warn", String(e?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ""));
const quote = (m: Message) => previewText(m.content, 40) || "this message";

export async function deleteMessage(m: Message): Promise<void> {
  if (!confirm(`Delete “${quote(m)}”? This cannot be undone.`)) return;
  try { await api().deleteMessage(m.id); } catch (e) { failed(e); }
}

export async function clearChat(chat: Chat): Promise<void> {
  if (!confirm(`Delete every message in “${chat.title}”? Agents start fresh. This cannot be undone.`)) return;
  try {
    await api().clearChat(chat.id);
    useStore.getState().toast("info", "Chat cleared");
  } catch (e) { failed(e); }
}
