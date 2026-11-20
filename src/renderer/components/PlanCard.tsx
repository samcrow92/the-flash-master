import { useEffect, useMemo, useState } from "react";
import type { Message, PlanTask, TaskPlan } from "@shared/types";
import { api, useStore } from "../store";
import { Ban, RoleIcon, CircleCheck, CircleDashed, CircleX, ListTree, Loader2, Play, Plus, SkipForward, Trash2 } from "./icons";

const cleanErr = (e: unknown) => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");

/** Tasks grouped into the waves the app runs them in (a wave's tasks don't depend on each other). */
function wavesOf(tasks: PlanTask[]): PlanTask[][] {
  const by = new Map(tasks.map((t) => [t.id, t]));
  const lv = new Map<string, number>();
  const level = (id: string, seen: Set<string>): number => {
    if (lv.has(id)) return lv.get(id)!;
    if (seen.has(id)) return 0;
    seen.add(id);
    const deps = (by.get(id)?.dependsOn ?? []).filter((d) => by.has(d));
    const v = deps.length ? Math.max(...deps.map((d) => level(d, seen))) + 1 : 0;
    lv.set(id, v);
    return v;
  };
  const out: PlanTask[][] = [];
  for (const t of tasks) (out[level(t.id, new Set())] ??= []).push(t);
  return out.filter(Boolean);
}

const STATUS_ICON = { pending: CircleDashed, running: Loader2, done: CircleCheck, failed: CircleX, skipped: SkipForward } as const;
const PLAN_LABEL: Record<TaskPlan["status"], string> = { draft: "Waiting for your OK", running: "Running", done: "Done", failed: "Finished with problems", cancelled: "Cancelled" };

/**
 * A task plan the coordinator proposed. While it is a draft you can change any task (role, brief, what it waits for),
 * remove or add tasks, then run it or decline it. Running, it shows each task's progress by wave.
 */
export function PlanCard({ m }: { m: Message }) {
  const roles = useStore((s) => s.roles);
  const [plan, setPlan] = useState<TaskPlan | null>(null);
  const [draft, setDraft] = useState<PlanTask[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void api().getPlan(m.planId!).then((p) => { if (alive) setPlan(p); });
    const off = window.flash.onEvent((e) => { if (e.type === "plan.updated" && e.plan.id === m.planId) setPlan(e.plan); });
    return () => { alive = false; off(); };
  }, [m.planId]);
  const tasks = draft ?? plan?.tasks ?? [];
  const waves = useMemo(() => wavesOf(tasks), [tasks]);
  if (!plan) return <div className="plan-card"><div className="muted small">Loading the plan…</div></div>;
  const editable = plan.status === "draft";
  const edit = (id: string, patch: Partial<PlanTask>) => setDraft(tasks.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  const remove = (id: string) => setDraft(tasks.filter((t) => t.id !== id).map((t) => ({ ...t, dependsOn: t.dependsOn.filter((d) => d !== id) })));
  const add = () => {
    let n = tasks.length + 1;
    while (tasks.some((t) => t.id === `t${n}`)) n++;
    setDraft([...tasks, { id: `t${n}`, title: "New task", role: roles[0]?.name ?? "", goal: "", dependsOn: [], status: "pending" }]);
    setOpen(`t${n}`);
  };
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try { await fn(); setDraft(null); } catch (e) { useStore.getState().toast("warn", cleanErr(e)); } finally { setBusy(false); }
  };
  const done = plan.tasks.filter((t) => t.status === "done").length;
  return (
    <div className={`plan-card st-${plan.status}`} role="group" aria-label={`Plan: ${plan.title}`}>
      <div className="plan-head">
        <span className="plan-flag"><ListTree size={13} /> Plan</span>
        <b className="plan-title">{plan.title}</b>
        <span className="plan-state">{PLAN_LABEL[plan.status]}{plan.status !== "draft" ? ` · ${done}/${plan.tasks.length}` : ` · ${tasks.length} tasks in ${waves.length} wave${waves.length === 1 ? "" : "s"}`}</span>
      </div>
      <div className="plan-waves">
        {waves.map((w, i) => (
          <div key={i} className="plan-wave">
            <div className="plan-wave-n">{i + 1}</div>
            <div className="plan-wave-tasks">
              {w.map((t) => {
                const I = STATUS_ICON[t.status];
                const isOpen = open === t.id;
                return (
                  <div key={t.id} className={`plan-task ts-${t.status} ${isOpen ? "open" : ""}`}>
                    <button type="button" className="plan-task-row" onClick={() => setOpen(isOpen ? null : t.id)} title={editable ? "Edit this task" : "Show details"}>
                      {editable ? <RoleIcon role={t.role} size={15} /> : <I size={14} className={t.status === "running" ? "spin" : ""} />}
                      <span className="plan-task-title">{t.title}</span>
                      <span className="muted small">{t.role}{t.dependsOn.length ? ` · after ${t.dependsOn.join(", ")}` : ""}{t.attempts ? ` · best of ${t.attempts}` : ""}</span>
                    </button>
                    {isOpen && editable && (
                      <div className="plan-edit">
                        <div className="row gap">
                          <input value={t.title} onChange={(e) => edit(t.id, { title: e.target.value })} aria-label="Title" />
                          <select value={t.role} onChange={(e) => edit(t.id, { role: e.target.value })} aria-label="Role">
                            {roles.map((r) => <option key={r.name} value={r.name}>{r.title}</option>)}
                          </select>
                          <button type="button" className="ghost danger" onClick={() => remove(t.id)} title="Remove this task"><Trash2 size={14} /></button>
                        </div>
                        <textarea rows={3} value={t.goal} onChange={(e) => edit(t.id, { goal: e.target.value })} placeholder="What to achieve, and when it's done" aria-label="Brief" />
                        {tasks.length > 1 && <div className="plan-deps small">
                          <span className="muted">Waits for:</span>
                          {tasks.filter((x) => x.id !== t.id).map((x) => (
                            <label key={x.id}><input type="checkbox" checked={t.dependsOn.includes(x.id)}
                              onChange={(e) => edit(t.id, { dependsOn: e.target.checked ? [...t.dependsOn, x.id] : t.dependsOn.filter((d) => d !== x.id) })} /> {x.title}</label>
                          ))}
                        </div>}
                      </div>
                    )}
                    {isOpen && !editable && <div className="plan-result small">{t.result ? t.result.slice(0, 1200) : t.status === "running" ? "Working…" : "Not started."}</div>}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
      {editable && (
        <div className="plan-actions">
          <button type="button" className="ghost small" onClick={add} disabled={busy}><Plus size={13} /> Add task</button>
          <span className="spacer" />
          <button type="button" className="ghost" disabled={busy} onClick={() => void act(() => api().cancelPlan(plan.id))}><Ban size={13} /> Decline</button>
          <button type="button" className="primary" disabled={busy || !tasks.length} onClick={() => void act(() => api().approvePlan(plan.id, draft ? { title: plan.title, tasks } : undefined))}>
            <Play size={13} /> {draft ? "Save and run" : "Run plan"}
          </button>
        </div>
      )}
    </div>
  );
}
