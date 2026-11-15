import type { AgentRun, Chat } from "@shared/types";

/** Where "Chat with <agent>" should take you. Pure, so the choice is unit-tested. */
export type AgentChatTarget =
  | { kind: "open"; chatId: string; agentId: string | null } // agentId set → also show its progress flow
  | { kind: "new"; projectId: string | null }; // null → the "No project" section, never a guessed project

/** Key of a project's chat list in the store; chats without a project share NO_PROJECT. */
export const NO_PROJECT = "__none";
export const chatKey = (projectId: string | null): string => projectId ?? NO_PROJECT;

export function pickAgentChat(role: string, s: {
  agents: Record<string, AgentRun>;
  chats: Record<string, Chat[]>;
  projectIds: string[];
  currentProjectId: string | null;
  masterChatId: string | null;
}, opts: { dedicated?: boolean } = {}): AgentChatTarget {
  if (role === "flashmaster" && s.masterChatId) return { kind: "open", chatId: s.masterChatId, agentId: null };
  // 1. The agent is working right now: open the chat it works in, with its progress. For its own window (dedicated),
  // only when that chat is the agent's own direct chat: a specialist helping in another chat must not pop that chat out.
  const direct = new Set(opts.dedicated ? Object.values(s.chats).flat().filter((c) => c.agentRole === role).map((c) => c.id) : []);
  const busy = Object.values(s.agents)
    .filter((a) => a.role === role && a.chatId && (a.status === "running" || a.status === "paused") && (!opts.dedicated || direct.has(a.chatId)))
    .sort((a, b) => b.startedAt - a.startedAt)[0];
  if (busy) return { kind: "open", chatId: busy.chatId!, agentId: busy.id };
  // When no project is selected, the chat goes to "No project": never into the first project in the list.
  const pid = s.currentProjectId && s.projectIds.includes(s.currentProjectId) ? s.currentProjectId : null;
  // 2. Its latest direct chat in the current project (or among the chats without a project).
  const mine = (s.chats[chatKey(pid)] ?? []).filter((c) => c.agentRole === role && !c.archived).sort((a, b) => b.createdAt - a.createdAt)[0];
  if (mine) return { kind: "open", chatId: mine.id, agentId: null };
  // 3. Otherwise start one.
  return { kind: "new", projectId: pid };
}

/** Parses `#chat/<chatId>`: the main process opens a chat window (an agent's dedicated chat) on that hash. */
export function chatRoute(hash: string): { chatId: string } | null {
  const m = /^#chat\/([^/]+)$/.exec(hash);
  if (!m) return null;
  try { return { chatId: decodeURIComponent(m[1]!) }; } catch { return null; }
}
