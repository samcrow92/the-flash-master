import type { AgentRun, Chat } from "@shared/types";

/** Where "Chat with <agent>" should take you. Pure, so the choice is unit-tested. */
export type AgentChatTarget =
  | { kind: "open"; chatId: string; agentId: string | null } // agentId set → also show its progress flow
  | { kind: "new"; projectId: string }
  | { kind: "no-project" };

export function pickAgentChat(role: string, s: {
  agents: Record<string, AgentRun>;
  chats: Record<string, Chat[]>;
  projectIds: string[];
  currentProjectId: string | null;
  masterChatId: string | null;
}): AgentChatTarget {
  if (role === "flashmaster" && s.masterChatId) return { kind: "open", chatId: s.masterChatId, agentId: null };
  // 1. The agent is working right now: open the chat it works in, with its progress.
  const busy = Object.values(s.agents)
    .filter((a) => a.role === role && a.chatId && (a.status === "running" || a.status === "paused"))
    .sort((a, b) => b.startedAt - a.startedAt)[0];
  if (busy) return { kind: "open", chatId: busy.chatId!, agentId: busy.id };
  const pid = s.currentProjectId ?? s.projectIds[0] ?? null;
  if (!pid) return { kind: "no-project" };
  // 2. Its latest direct chat in the current project.
  const mine = (s.chats[pid] ?? []).filter((c) => c.agentRole === role && !c.archived).sort((a, b) => b.createdAt - a.createdAt)[0];
  if (mine) return { kind: "open", chatId: mine.id, agentId: null };
  // 3. Otherwise start one.
  return { kind: "new", projectId: pid };
}
