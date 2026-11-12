import { useState } from "react";
import { api, useStore } from "../store";

export function Sidebar() {
  const st = useStore();
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const running = Object.values(st.agents).filter((a) => a.status === "running" || a.status === "paused").length;
  const view = st.view;
  const isChat = (id: string) => view.kind === "chat" && view.chatId === id;

  const addProject = async () => {
    const path = await api().pickFolder();
    if (!path) return;
    const p = await api().createProject(path);
    await st.refreshProjects();
    await st.refreshChats(p.id);
    setOpen((o) => ({ ...o, [p.id]: true }));
    const first = useStore.getState().chats[p.id]?.[0];
    if (first) await st.openChat(first.id);
  };

  const newChat = async (projectId: string, role = "flashmaster") => {
    const r = st.roles.find((x) => x.name === role);
    const c = await api().createChat({ projectId, agentRole: role, title: role === "flashmaster" ? "New chat" : `${r?.icon ?? ""} ${r?.title ?? role}` });
    st.upsertChat(c);
    setOpen((o) => ({ ...o, [projectId]: true }));
    await st.openChat(c.id);
  };

  const startSpecialist = async (role: string) => {
    const pid = st.currentProjectId ?? st.projects[0]?.id;
    if (!pid) { st.toast("warn", "Add a project folder first — specialists work inside a project."); return; }
    await newChat(pid, role);
  };

  return (
    <aside className="sidebar">
      <div className="brand"><span className="bolt">⚡</span> TheFlashMaster</div>

      <nav className="nav">
        <button className={isChat(st.masterChatId ?? "") ? "active" : ""} onClick={() => st.masterChatId && st.openChat(st.masterChatId)}>
          ⚡ Master chat
        </button>
        <button className={view.kind === "agents" ? "active" : ""} onClick={() => st.setView({ kind: "agents" })}>
          🛰️ Agents {running > 0 && <span className="badge">{running}</span>}
        </button>
        <button className={view.kind === "dashboard" ? "active" : ""} onClick={() => st.setView({ kind: "dashboard" })}>📊 Dashboard</button>
        <button className={view.kind === "tasks" ? "active" : ""} onClick={() => st.setView({ kind: "tasks" })}>
          🗂️ Tasks <span className="muted small">{Object.values(st.tasks).filter((t) => t.status !== "done").length || ""}</span>
        </button>
        <button className={view.kind === "jazz" ? "active" : ""} onClick={() => st.setView({ kind: "jazz" })}>📌 Jazz work items</button>
      </nav>

      <div className="section-title">
        Projects <button className="icon-btn" title="Add project folder" onClick={addProject}>＋</button>
      </div>
      <div className="projects">
        {st.projects.length === 0 && <div className="empty-hint">Add a local folder to start.</div>}
        {st.projects.map((p) => (
          <div key={p.id} className="project">
            <div className={`project-row ${st.currentProjectId === p.id ? "current" : ""}`}>
              <button className="project-name" title={p.path} onClick={() => setOpen((o) => ({ ...o, [p.id]: !o[p.id] }))}>
                {open[p.id] ? "▾" : "▸"} {p.name}
              </button>
              <button className="icon-btn" title="New chat" onClick={() => newChat(p.id)}>＋</button>
            </div>
            {open[p.id] && (st.chats[p.id] ?? []).map((c) => (
              <button key={c.id} className={`chat-link ${isChat(c.id) ? "active" : ""}`} onClick={() => st.openChat(c.id)}>
                <span className="chat-title">{c.title}</span>
                {Object.values(st.agents).some((a) => a.chatId === c.id && a.status === "running") && <span className="pulse" />}
              </button>
            ))}
          </div>
        ))}
      </div>

      <div className="section-title">Specialists</div>
      <div className="palette">
        {st.roles.filter((r) => r.name !== "flashmaster").map((r) => (
          <button key={r.name} className="palette-item" title={`${r.description}\n\nClick: new chat with ${r.title} in the current project.\nTip: type @${r.name} in any chat.`}
            onClick={() => startSpecialist(r.name)}>
            <span className="palette-icon">{r.icon}</span><span>{r.title}</span>
          </button>
        ))}
      </div>

      <div className="sidebar-footer">
        <button className={view.kind === "settings" ? "active" : ""} onClick={() => st.setView({ kind: "settings" })}>⚙️ Settings</button>
      </div>
    </aside>
  );
}
