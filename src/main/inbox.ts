/**
 * The review inbox: everything across chats that waits on the user, in one list. Questions and blockers ("needs you"
 * cards), task plans to approve, specialists' branches to review and merge, and branches whose checks fail.
 */
import type { AgentRun, CheckRun, InboxItem, Message, TaskPlan } from "@shared/types";

export function buildInbox(i: { asks: Message[]; plans: TaskPlan[]; agents: AgentRun[]; checks: (agentId: string) => CheckRun | null;
  chatTitle: (chatId: string) => string | null }): InboxItem[] {
  const out: InboxItem[] = [];
  for (const m of i.asks) {
    out.push({ kind: "ask", id: `ask:${m.id}`, chatId: m.chatId, messageId: m.id, agentId: m.ask!.agentId, title: m.ask!.question.slice(0, 200),
      detail: [m.ask!.who, i.chatTitle(m.chatId)].filter(Boolean).join(" · "), at: m.createdAt });
  }
  for (const p of i.plans) {
    out.push({ kind: "plan", id: `plan:${p.id}`, chatId: p.chatId, messageId: p.messageId, agentId: p.agentId, title: `Plan: ${p.title}`,
      detail: [`${p.tasks.length} tasks`, i.chatTitle(p.chatId)].filter(Boolean).join(" · "), at: p.createdAt });
  }
  for (const a of i.agents) {
    if (!a.branch || !a.worktree || a.status === "running") continue;
    const c = i.checks(a.id);
    const who = [a.name, a.role].filter(Boolean).join(" · ");
    if (c && !c.ok) {
      const failed = c.results.filter((r) => !r.ok).map((r) => r.name);
      out.push({ kind: "checks", id: `checks:${a.id}`, chatId: a.chatId, messageId: null, agentId: a.id, title: `Checks fail on ${a.branch}`,
        detail: [failed.join(", "), who].filter(Boolean).join(" · "), at: c.at });
    } else {
      out.push({ kind: "merge", id: `merge:${a.id}`, chatId: a.chatId, messageId: null, agentId: a.id, title: `Review and merge ${a.branch}`,
        detail: [c?.ok ? "checks pass" : "no checks run", who].filter(Boolean).join(" · "), at: a.endedAt ?? a.startedAt });
    }
  }
  const rank: Record<InboxItem["kind"], number> = { ask: 0, plan: 1, checks: 2, merge: 3 };
  return out.sort((a, b) => rank[a.kind] - rank[b.kind] || b.at - a.at);
}
