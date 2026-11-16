import { useState } from "react";
import { ArrowRight, BrushCleaning, MessageSquare, PencilLine, Pin, Play, Plus, RoleIcon, SquareKanban as SquareKanbanIcon, Trash2 } from "../components/icons";
import { openMenu, type MenuItem } from "../components/ContextMenu";
import type { Task, TaskStatus } from "@shared/types";
import { TASK_STATUSES } from "@shared/types";
import { api, ago, roleOf, useStore } from "../store";

const LABEL: Record<TaskStatus, string> = { todo: "To do", in_progress: "In progress", blocked: "Blocked", review: "Review", done: "Done" };
const PRIO = ["", "P1", "P2", "P3", "P4"];

export function TasksView() {
  const st = useStore();
  const [project, setProject] = useState<string>(st.currentProjectId ?? "");
  const [q, setQ] = useState("");
  const [editing, setEditing] = useState<Task | null>(null);
  const tasks = Object.values(st.tasks)
    .filter((t) => !project || (project === "none" ? t.projectId === null : t.projectId === project))
    .filter((t) => !q || `${t.title} ${t.description} ${t.jazzId ?? ""}`.toLowerCase().includes(q.toLowerCase()));

  const create = async () => {
    const t = await api().createTask({ title: "New task", projectId: project && project !== "none" ? project : null });
    setEditing(t);
  };
  const move = (t: Task, status: TaskStatus) => api().updateTask(t.id, { status });
  const failed = (e: any) => st.toast("warn", String(e?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ""));
  const remove = async (t: Task) => {
    try { await api().deleteTask(t.id); st.toast("info", `Deleted “${t.title}”`); } catch (e) { failed(e); }
  };
  const removeAll = async (s: TaskStatus, list: Task[]) => {
    if (!list.length || !confirm(`Delete all ${list.length} ${list.length === 1 ? "task" : "tasks"} in ${LABEL[s]}? This cannot be undone.`)) return;
    try { for (const t of list) await api().deleteTask(t.id); st.toast("info", `Deleted ${list.length} ${list.length === 1 ? "task" : "tasks"}`); } catch (e) { failed(e); }
  };
  const cleanUp = async () => {
    try {
      const n = await api().cleanupTasks();
      st.toast("info", n ? `Cleaned up ${n} ${n === 1 ? "task" : "tasks"}` : "Nothing to clean up: no finished, stopped or stale tasks past their delay (Settings → Agents)");
    } catch (e) { failed(e); }
  };
  const run = async (t: Task) => {
    try {
      const a = await api().runTask(t.id, t.assigneeRole ?? undefined);
      if (a.chatId) { for (const p of st.projects) await st.refreshChats(p.id); await st.openChat(a.chatId); }
    } catch (e) { failed(e); }
  };
  const taskMenu = (t: Task): MenuItem[] => {
    const agent = t.agentId ? st.agents[t.agentId] : undefined;
    return [
      { label: "Open…", icon: <PencilLine size={15} />, onClick: () => setEditing(t) },
      { label: "Run with agent", icon: <Play size={15} />, disabled: !t.assigneeRole, hint: t.assigneeRole ? undefined : "no assignee", onClick: () => void run(t) },
      ...(agent?.chatId ? [{ label: "Open agent chat", icon: <MessageSquare size={15} />, onClick: () => void st.openChat(agent.chatId!) }] : []),
      { label: "", separator: true },
      ...TASK_STATUSES.filter((s) => s !== t.status).map((s) => ({ label: `Move to ${LABEL[s]}`, icon: <ArrowRight size={15} />, onClick: () => void move(t, s) })),
      { label: "", separator: true },
      { label: "Delete", icon: <Trash2 size={15} />, danger: true, hint: "Del", onClick: () => void remove(t) },
    ];
  };
  const columnMenu = (s: TaskStatus, list: Task[]): MenuItem[] => [
    { label: `Delete all in ${LABEL[s]}…`, icon: <Trash2 size={15} />, danger: true, disabled: !list.length, onClick: () => void removeAll(s, list) },
    { label: "Clean up now", icon: <BrushCleaning size={15} />, onClick: () => void cleanUp() },
  ];

  return (
    <div className="page">
      <header className="page-header">
        <h2><SquareKanbanIcon size={20} className="h-icon" /> Tasks</h2>
        <div className="row gap">
          <input placeholder="Filter…" value={q} onChange={(e) => setQ(e.target.value)} />
          <select value={project} onChange={(e) => setProject(e.target.value)}>
            <option value="">All projects</option>
            <option value="none">No project</option>
            {st.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <button onClick={cleanUp} title="Delete finished, stopped and stale tasks now (delays in Settings → Agents). Review tasks and tasks with a working agent stay."><BrushCleaning size={15} /> Clean up</button>
          <button className="primary" onClick={create}><Plus size={15} /> New task</button>
        </div>
      </header>
      <div className="kanban">
        {TASK_STATUSES.map((s) => {
          const list = tasks.filter((t) => t.status === s).sort((a, b) => a.priority - b.priority || b.updatedAt - a.updatedAt);
          return (
          <div key={s} className="column"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => { const id = e.dataTransfer.getData("task"); const t = st.tasks[id]; if (t && t.status !== s) void move(t, s); }}>
            <div className="column-head" onContextMenu={(e) => openMenu(e, columnMenu(s, list))}>{LABEL[s]} <span className="muted">{list.length}</span></div>
            {list.map((t) => (
              <div key={t.id} className="task-card" tabIndex={0} draggable onDragStart={(e) => e.dataTransfer.setData("task", t.id)} onClick={() => setEditing(t)}
                onContextMenu={(e) => openMenu(e, taskMenu(t))}
                onKeyDown={(e) => {
                  if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); void remove(t); }
                  else if (e.key === "Enter") setEditing(t);
                  else if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) openMenu(e as any, taskMenu(t), true);
                }}>
                <div className="row between"><span className={`prio p${t.priority}`}>{PRIO[t.priority]}</span><span className="muted small">{ago(t.updatedAt)}</span></div>
                <div className="task-title">{t.title}</div>
                <div className="row gap-s wrap small">
                  {t.assigneeRole && <span className="chip row gap-s"><RoleIcon role={t.assigneeRole} size={14} /> {roleOf(t.assigneeRole)?.title ?? t.assigneeRole}</span>}
                  {t.jazzId && <span className="chip"><Pin size={11} /> {t.jazzId}</span>}
                  {t.agentId && st.agents[t.agentId] && <span className={`status st-${st.agents[t.agentId]!.status}`}>{st.agents[t.agentId]!.status}</span>}
                </div>
              </div>
            ))}
          </div>
          );
        })}
      </div>
      {editing && <TaskEditor task={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function TaskEditor({ task, onClose }: { task: Task; onClose: () => void }) {
  const st = useStore();
  const [t, setT] = useState<Task>(task);
  const save = async () => { await api().updateTask(t.id, t); onClose(); };
  const run = async () => {
    await api().updateTask(t.id, t);
    const a = await api().runTask(t.id, t.assigneeRole ?? undefined);
    onClose();
    if (a.chatId) {
      for (const p of st.projects) await st.refreshChats(p.id);
      await st.openChat(a.chatId);
    }
  };
  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>Task</h3>
        <label className="field"><span>Title</span><input value={t.title} onChange={(e) => setT({ ...t, title: e.target.value })} /></label>
        <label className="field"><span>Description</span><textarea rows={6} value={t.description} onChange={(e) => setT({ ...t, description: e.target.value })} /></label>
        <div className="grid3">
          <label className="field"><span>Status</span>
            <select value={t.status} onChange={(e) => setT({ ...t, status: e.target.value as TaskStatus })}>{TASK_STATUSES.map((s) => <option key={s} value={s}>{LABEL[s]}</option>)}</select>
          </label>
          <label className="field"><span>Priority</span>
            <select value={t.priority} onChange={(e) => setT({ ...t, priority: Number(e.target.value) })}>{[1, 2, 3, 4].map((p) => <option key={p} value={p}>{PRIO[p]}</option>)}</select>
          </label>
          <label className="field"><span>Assignee (agent)</span>
            <select value={t.assigneeRole ?? ""} onChange={(e) => setT({ ...t, assigneeRole: e.target.value || null })}>
              <option value="">—</option>{st.roles.map((r) => <option key={r.name} value={r.name}>{r.title}</option>)}
            </select>
          </label>
          <label className="field"><span>Project</span>
            <select value={t.projectId ?? ""} onChange={(e) => setT({ ...t, projectId: e.target.value || null })}>
              <option value="">—</option>{st.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
          <label className="field"><span>Jazz work item</span><input value={t.jazzId ?? ""} onChange={(e) => setT({ ...t, jazzId: e.target.value || null })} /></label>
        </div>
        <div className="row between">
          <button className="danger ghost" onClick={async () => { await api().deleteTask(t.id); onClose(); }}>Delete</button>
          <div className="row gap">
            <button onClick={onClose}>Cancel</button>
            <button onClick={run} title="Start the assigned agent with this task as its brief">▶ Run with agent</button>
            <button className="primary" onClick={save}>Save</button>
          </div>
        </div>
      </div>
    </div>
  );
}
