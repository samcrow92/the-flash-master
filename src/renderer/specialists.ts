import type { AgentRun, RoleDef } from "@shared/types";

export type SpecialistRow = { role: RoleDef; working: number; paused: number; busyAgent: AgentRun | undefined };

/** Specialists (every role but the coordinator) with live activity counts, plus the totals the chat's pill shows. Pure, so it is unit-tested. */
export function specialistRows(roles: RoleDef[], agents: Record<string, AgentRun>): { rows: SpecialistRow[]; working: number; paused: number } {
  const all = Object.values(agents);
  const rows = roles.filter((r) => r.name !== "flashmaster").map((role) => {
    const mine = all.filter((a) => a.role === role.name);
    return {
      role,
      working: mine.filter((a) => a.status === "running").length,
      paused: mine.filter((a) => a.status === "paused").length,
      busyAgent: mine.find((a) => a.status === "running"),
    };
  });
  return { rows, working: rows.reduce((n, r) => n + r.working, 0), paused: rows.reduce((n, r) => n + r.paused, 0) };
}
