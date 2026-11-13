import { useState } from "react";
import { Pin, Plus, RoleIcon, SquareKanban as SquareKanbanIcon } from "../components/icons";
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
          <button className="primary" onClick={create}><Plus size={15} /> New task</button>
        </div>
      </header>
      <div className="kanban">
        {TASK_STATUSES.map((s) => (
          <div key={s} className="column"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => { const id = e.dataTransfer.getData("task"); const t = st.tasks[id]; if (t && t.status !== s) void move(t, s); }}>
            <div className="column-head">{LABEL[s]} <span className="muted">{tasks.filter((t) => t.status === s).length}</span></div>
            {tasks.filter((t) => t.status === s).sort((a, b) => a.priority - b.priority || b.updatedAt - a.updatedAt).map((t) => (
              <div key={t.id} className="task-card" draggable onDragStart={(e) => e.dataTransfer.setData("task", t.id)} onClick={() => setEditing(t)}>
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
        ))}
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
