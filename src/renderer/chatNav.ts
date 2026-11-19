import { api, useStore } from "./store";
import { chatKey } from "./agentChat";
import { chatToOpen } from "./layout";

/** Start a chat with TheFlashMaster in a project (null = "No project") and open it. */
export async function newChatIn(projectId: string | null): Promise<void> {
  const st = useStore.getState();
  const c = await api().createChat({ projectId, agentRole: "flashmaster", title: "New chat" });
  st.upsertChat(c);
  await st.openChat(c.id);
}

/** A project row in the sidebar: reopen the chat you last had open there, else its newest one, else start one. */
export async function openProjectChat(projectId: string | null): Promise<void> {
  const st = useStore.getState();
  const key = chatKey(projectId);
  const c = chatToOpen(st.chats[key] ?? [], st.lastChatByProject[key]);
  if (c) await st.openChat(c.id);
  else await newChatIn(projectId);
}
