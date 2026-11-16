import type { AgentRun, Task } from "@shared/types";

/** Task auto-cleanup (Settings → Agents → Tasks). */
export interface TaskCleanupSettings {
  /** Delete finished tasks this long after they finished: done, or their agent stopped / failed / ended (0 = never). */
  deleteFinishedAfterMinutes: number;
  /** Delete open tasks (to do, in progress, blocked) nobody touched for this many days (0 = never). */
  deleteStaleAfterDays: number;
}

const ACTIVE = new Set(["idle", "running", "paused", "interrupted"]);

/**
 * Which tasks the cleanup removes now. Tasks in Review are kept (work waiting for you), and so is any task whose agent
 * is still working or waiting for input.
 */
export function tasksToClean(tasks: Task[], agents: Map<string, AgentRun>, s: TaskCleanupSettings, now = Date.now()): string[] {
  const out: string[] = [];
  for (const t of tasks) {
    if (t.status === "review") continue;
    const a = t.agentId ? agents.get(t.agentId) : undefined;
    if (a && ACTIVE.has(a.status)) continue;
    const agentEnded = !!a && a.endedAt != null;
    if (t.status === "done" || agentEnded) {
      const since = Math.max(t.updatedAt, a?.endedAt ?? 0);
      if (s.deleteFinishedAfterMinutes > 0 && now - since >= s.deleteFinishedAfterMinutes * 60_000) out.push(t.id);
      continue;
    }
    if (s.deleteStaleAfterDays > 0 && now - t.updatedAt >= s.deleteStaleAfterDays * 86_400_000) out.push(t.id);
  }
  return out;
}

/** Delete what `tasksToClean` picks and tell the UI; returns the deleted ids. Runs every minute and from "Clean up now". */
export function runTaskCleanup(d: { listTasks(): Task[]; getAgent(id: string): AgentRun | null; deleteTask(id: string): void },
  s: TaskCleanupSettings, emit: (taskId: string) => void, now = Date.now()): string[] {
  const tasks = d.listTasks();
  const agents = new Map<string, AgentRun>();
  for (const t of tasks) if (t.agentId && !agents.has(t.agentId)) { const a = d.getAgent(t.agentId); if (a) agents.set(a.id, a); }
  const ids = tasksToClean(tasks, agents, s, now);
  for (const id of ids) { d.deleteTask(id); emit(id); }
  return ids;
}
