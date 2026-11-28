import type { AgentRun, Chat, Message } from "@shared/types";

/**
 * App layout rules kept pure so tests cover them without a DOM: which chat a project row opens, what the chat
 * switcher lists, and which tab the side sheet (Threads / Progress / Artifacts) shows.
 */

/** Chats of one project for the switcher in the chat's top bar: pinned first, then newest first; archived apart. */
export function switcherChats(chats: Chat[]): { active: Chat[]; archived: Chat[] } {
  const order = (a: Chat, b: Chat) => Number(b.pinned) - Number(a.pinned) || b.createdAt - a.createdAt;
  return { active: chats.filter((c) => !c.archived).sort(order), archived: chats.filter((c) => c.archived).sort((a, b) => b.createdAt - a.createdAt) };
}

/**
 * The chat a project row in the sidebar opens: the one you last had open in that project (if it still exists and isn't
 * archived), else its first pinned or newest chat. null = the project has no open chats (the caller starts one).
 */
export function chatToOpen(chats: Chat[], lastId?: string | null): Chat | null {
  const last = lastId ? chats.find((c) => c.id === lastId && !c.archived) : undefined;
  return last ?? switcherChats(chats).active[0] ?? null;
}

/**
 * A project's chats as the sidebar tree: its coordinator chat, then the threads it started grouped by feature (the
 * feature with the newest thread first; threads in the order they were started), then other chats (top-level chats and
 * threads without a feature, newest first). Archived chats are kept apart.
 */
export function projectTree(chats: Chat[]): { coordinator: Chat | null; features: { name: string; threads: Chat[] }[]; other: Chat[]; archived: Chat[] } {
  const active = chats.filter((c) => !c.archived);
  const coordinator = active.find((c) => c.coordinator) ?? null;
  const byFeature = new Map<string, Chat[]>();
  const other: Chat[] = [];
  for (const c of active) {
    if (c === coordinator) continue;
    const f = c.parentChatId && c.feature ? c.feature : null;
    if (f) byFeature.set(f, [...(byFeature.get(f) ?? []), c]); else other.push(c);
  }
  const newest = (l: Chat[]) => Math.max(...l.map((c) => c.createdAt));
  const features = [...byFeature].map(([name, threads]) => ({ name, threads: threads.sort((a, b) => a.createdAt - b.createdAt) }))
    .sort((a, b) => newest(b.threads) - newest(a.threads));
  return { coordinator, features, other: switcherChats(other).active, archived: switcherChats(chats).archived };
}

export type ThreadStatus = "working" | "needs_you" | "idle";

/** A thread's dot in the sidebar: an agent of that chat is working, one waits for the user ("needs you" card), or idle. */
export function threadStatus(chatId: string, agents: AgentRun[]): ThreadStatus {
  const mine = agents.filter((a) => a.chatId === chatId);
  if (mine.some((a) => a.status === "running")) return "working";
  if (mine.some((a) => a.lastActivity?.startsWith("❓ Needs you"))) return "needs_you";
  return "idle";
}

export type SheetTab = "threads" | "progress" | "artifacts";

/**
 * Which tab the floating side sheet shows for a chat, or null when it is closed. Progress and Artifacts are opened
 * explicitly per chat. Threads follows the remembered panel preference, but only opens on its own when the chat has
 * threads; you can still open it on an empty chat (shownEmptyFor).
 */
export function sheetTab(s: {
  chatId: string; flowChat: string | null; artifactsChat: string | null; threadsOpen: boolean; threadCount: number; shownEmptyFor: string | null;
}): SheetTab | null {
  if (s.flowChat === s.chatId) return "progress";
  if (s.artifactsChat === s.chatId) return "artifacts";
  if (s.threadsOpen && (s.threadCount > 0 || s.shownEmptyFor === s.chatId)) return "threads";
  return null;
}

/**
 * Who replied in a thread, for the faces on the "N replies" chip: one face per author (each agent role, you, and all
 * system notes as one), newest activity last, at most `max` shown with the rest counted. A face is `working` while that
 * author still has a reply streaming.
 */
export function threadFaces(replies: Message[], max = 3): { faces: { m: Message; working: boolean }[]; more: number } {
  const key = (m: Message) => (m.author === "agent" ? `agent:${m.role ?? ""}` : m.author);
  const seen = new Map<string, { m: Message; working: boolean }>();
  for (const m of replies) {
    const k = key(m);
    const prev = seen.get(k);
    seen.set(k, { m: prev?.m ?? m, working: (prev?.working ?? false) || m.status === "streaming" });
  }
  const all = [...seen.values()];
  return { faces: all.slice(0, max), more: Math.max(0, all.length - max) };
}
