import type { AgentRun, RoleDef } from "@shared/types";

export type SpecialistRow = { role: RoleDef; working: number; paused: number; busyAgent: AgentRun | undefined; busyAgents: AgentRun[] };

/** Specialists (every role but the coordinator) with live activity counts, plus the totals the chat's pill shows. Pure, so it is unit-tested. */
export function specialistRows(roles: RoleDef[], agents: Record<string, AgentRun>): { rows: SpecialistRow[]; working: number; paused: number } {
  const all = Object.values(agents);
  const rows = roles.filter((r) => r.name !== "flashmaster").map((role) => {
    const mine = all.filter((a) => a.role === role.name);
    // Several instances of one specialist can run at once (each its own name, session and task).
    const busyAgents = mine.filter((a) => a.status === "running");
    return {
      role,
      working: busyAgents.length,
      paused: mine.filter((a) => a.status === "paused").length,
      busyAgent: busyAgents[0],
      busyAgents,
    };
  });
  return { rows, working: rows.reduce((n, r) => n + r.working, 0), paused: rows.reduce((n, r) => n + r.paused, 0) };
}
