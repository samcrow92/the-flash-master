/**
 * Task plans: the coordinator proposes a typed task graph (propose_plan), the user can edit it before it runs, and code
 * (not the model) decides the order: every task whose dependencies are done starts in the same wave, each gets its
 * dependencies' results in its brief, a failure skips what depends on it, and the coordinator gets one combined result.
 */
import type { PlanTask, PlanTaskStatus, TaskPlan } from "@shared/types";

export const MAX_PLAN_TASKS = 20;

export interface PlanTaskInput { id?: unknown; title?: unknown; role?: unknown; goal?: unknown; dependsOn?: unknown; mode?: unknown; attempts?: unknown }

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);

/** Normalise what a model or the editor sent; ids default to t1, t2, … and `dependsOn` accepts a list or a comma string. */
export function normaliseTasks(input: unknown): PlanTask[] {
  const list = Array.isArray(input) ? (input as PlanTaskInput[]) : [];
  return list.map((t, i) => {
    const deps = Array.isArray(t.dependsOn) ? t.dependsOn : typeof t.dependsOn === "string" ? t.dependsOn.split(/[,\s]+/) : [];
    const attempts = Number(t.attempts);
    return {
      id: slug(String(t.id ?? "")) || `t${i + 1}`,
      title: String(t.title ?? "").trim().slice(0, 120) || String(t.goal ?? "").trim().slice(0, 80) || `Task ${i + 1}`,
      role: String(t.role ?? "").trim(),
      goal: String(t.goal ?? "").trim().slice(0, 4000),
      dependsOn: [...new Set(deps.map((d) => slug(String(d))).filter(Boolean))],
      mode: typeof t.mode === "string" && ["eco", "comfort", "sport"].includes(t.mode) ? t.mode : null,
      attempts: Number.isFinite(attempts) && attempts > 1 ? Math.min(3, Math.floor(attempts)) : null,
      status: "pending" as PlanTaskStatus,
    };
  });
}

/** Problems that stop a plan from running: empty, too big, duplicate ids, unknown roles or dependencies, a cycle. */
export function validatePlan(tasks: PlanTask[], roles: string[]): string[] {
  const errs: string[] = [];
  if (!tasks.length) errs.push("the plan has no tasks");
  if (tasks.length > MAX_PLAN_TASKS) errs.push(`at most ${MAX_PLAN_TASKS} tasks (got ${tasks.length}): group small steps`);
  const ids = new Set<string>();
  for (const t of tasks) {
    if (ids.has(t.id)) errs.push(`duplicate task id "${t.id}"`);
    ids.add(t.id);
    if (!t.goal) errs.push(`task "${t.id}" has no goal`);
    if (!roles.includes(t.role)) errs.push(`task "${t.id}": unknown role "${t.role}" (one of: ${roles.join(", ")})`);
  }
  for (const t of tasks) for (const d of t.dependsOn) {
    if (d === t.id) errs.push(`task "${t.id}" depends on itself`);
    else if (!ids.has(d)) errs.push(`task "${t.id}" depends on unknown task "${d}"`);
  }
  if (!errs.length) {
    const cyc = findCycle(tasks);
    if (cyc) errs.push(`dependency cycle: ${cyc.join(" → ")}`);
  }
  return errs;
}

function findCycle(tasks: PlanTask[]): string[] | null {
  const by = new Map(tasks.map((t) => [t.id, t]));
  const state = new Map<string, 1 | 2>();
  const stack: string[] = [];
  const visit = (id: string): string[] | null => {
    if (state.get(id) === 2) return null;
    if (state.get(id) === 1) return [...stack.slice(stack.indexOf(id)), id];
    state.set(id, 1);
    stack.push(id);
    for (const d of by.get(id)?.dependsOn ?? []) { const c = visit(d); if (c) return c; }
    stack.pop();
    state.set(id, 2);
    return null;
  };
  for (const t of tasks) { const c = visit(t.id); if (c) return c; }
  return null;
}

/** The waves the plan runs in (tasks of one wave are independent of each other). Assumes a valid plan. */
export function waves(tasks: PlanTask[]): string[][] {
  const level = new Map<string, number>();
  const by = new Map(tasks.map((t) => [t.id, t]));
  const lv = (id: string, seen = new Set<string>()): number => {
    if (level.has(id)) return level.get(id)!;
    if (seen.has(id)) return 0;
    seen.add(id);
    const deps = by.get(id)?.dependsOn ?? [];
    const v = deps.length ? Math.max(...deps.map((d) => lv(d, seen))) + 1 : 0;
    level.set(id, v);
    return v;
  };
  const out: string[][] = [];
  for (const t of tasks) (out[lv(t.id)] ??= []).push(t.id);
  return out.filter(Boolean);
}

/** Pending tasks whose dependencies are all done: the next ones to start. */
export function readyTasks(plan: Pick<TaskPlan, "tasks">): PlanTask[] {
  const st = new Map(plan.tasks.map((t) => [t.id, t.status]));
  return plan.tasks.filter((t) => t.status === "pending" && t.dependsOn.every((d) => st.get(d) === "done"));
}

/** Pending tasks that can never start (a dependency failed or was skipped) become skipped. Returns the ids it skipped. */
export function skipBlocked(plan: Pick<TaskPlan, "tasks">): string[] {
  const skipped: string[] = [];
  for (let changed = true; changed;) {
    changed = false;
    const st = new Map(plan.tasks.map((t) => [t.id, t.status]));
    for (const t of plan.tasks) {
      if (t.status !== "pending" || !t.dependsOn.some((d) => st.get(d) === "failed" || st.get(d) === "skipped")) continue;
      t.status = "skipped";
      t.result = `skipped: ${t.dependsOn.filter((d) => st.get(d) === "failed" || st.get(d) === "skipped").join(", ")} did not finish`;
      skipped.push(t.id);
      changed = true;
    }
  }
  return skipped;
}

/** Whether a specialist's result counts as done (anything else fails the task and skips its dependants). */
export function resultOk(result: string): boolean {
  if (/^(error:|failed|stopped)/i.test(result.trim())) return false;
  const st = /(?:^|\n)\s*status:\s*(\w+)/i.exec(result)?.[1]?.toLowerCase();
  return !st || st === "done";
}

/** The dependencies' results, given to a task as context. */
export function dependencyContext(plan: Pick<TaskPlan, "tasks">, task: PlanTask, maxChars = 1500): string {
  const by = new Map(plan.tasks.map((t) => [t.id, t]));
  const parts = task.dependsOn.map((d) => by.get(d)).filter((t): t is PlanTask => !!t)
    .map((t) => `### ${t.title} (${t.role}${t.agentId ? `, agentId ${t.agentId}` : ""})\n${(t.result ?? "").slice(0, maxChars)}`);
  return parts.length ? `This task is part of a plan. Results of the tasks it builds on:\n\n${parts.join("\n\n")}` : "";
}

/** The combined result the coordinator gets when the plan has finished. */
export function planReport(plan: TaskPlan, maxChars = 1200): string {
  const done = plan.tasks.filter((t) => t.status === "done").length;
  const head = `## Plan "${plan.title}" ${plan.status === "done" ? "finished" : plan.status === "cancelled" ? "was cancelled" : "finished with problems"}: ${done}/${plan.tasks.length} tasks done`;
  const body = plan.tasks.map((t) => `### ${t.id} · ${t.title} (${t.role}) — ${t.status}${t.agentId ? ` · agentId ${t.agentId}` : ""}\n${(t.result ?? "").slice(0, maxChars) || "(no result)"}`);
  return [head, ...body,
    "Continue: integrate these results. If the request is complete, answer the user; otherwise fix what failed (a follow-up with that task's agentId) or propose the next steps."].join("\n\n");
}

/** One line per task, for the tool result and the plan card's fallback text. */
export function planOutline(tasks: PlanTask[]): string {
  return waves(tasks).map((w, i) => `wave ${i + 1}: ${w.map((id) => { const t = tasks.find((x) => x.id === id)!; return `${id} (${t.role}) ${t.title}`; }).join(" · ")}`).join("\n");
}
