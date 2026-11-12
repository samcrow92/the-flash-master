import { useState } from "react";
import type { JazzWorkItem } from "@shared/types";
import { api, useStore } from "../store";

export function JazzView() {
  const st = useStore();
  const cfg = st.settings?.jazz;
  const [q, setQ] = useState(cfg?.defaultQuery ?? "");
  const [items, setItems] = useState<JazzWorkItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [sel, setSel] = useState<JazzWorkItem | null>(null);
  const [role, setRole] = useState("jazz-analyst");
  const [project, setProject] = useState(st.currentProjectId ?? st.projects[0]?.id ?? "");

  if (!cfg?.enabled || !cfg.serverUrl) {
    return (
      <div className="page">
        <header className="page-header"><h2>📌 Jazz work items</h2></header>
        <div className="empty">
          IBM Jazz (EWM/RTC) is not configured.
          <div><button className="primary" onClick={() => st.setView({ kind: "settings", tab: "integrations" })}>Configure Jazz</button></div>
        </div>
      </div>
    );
  }

  const search = async () => {
    setBusy(true);
    try { setItems(await api().jazzQuery(q)); } catch (e: any) { st.toast("error", String(e?.message ?? e)); } finally { setBusy(false); }
  };
  const analyse = async (w: JazzWorkItem) => {
    const brief = `Analyse Jazz work item ${w.id} (${w.type}, ${w.state}): "${w.title}".\nUse jazz_get for full details. Relate it to the code in this project, list affected files, risks and a proposed approach. Do not update the work item unless asked.`;
    const a = await api().startAgent({ projectId: project || null, role, brief });
    for (const p of st.projects) await st.refreshChats(p.id);
    if (a.chatId) await st.openChat(a.chatId);
  };
  const toTask = async (w: JazzWorkItem) => {
    await api().createTask({ title: `${w.id}: ${w.title}`, description: w.description.slice(0, 2000), jazzId: w.id, projectId: project || null });
    st.toast("info", `Task created for ${w.id}`);
  };

  return (
    <div className="page">
      <header className="page-header">
        <h2>📌 Jazz work items</h2>
        <div className="row gap">
          <select value={project} onChange={(e) => setProject(e.target.value)} title="Project used for analysis and tasks">
            <option value="">No project</option>{st.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <select value={role} onChange={(e) => setRole(e.target.value)} title="Agent used for analysis">
            {st.roles.map((r) => <option key={r.name} value={r.name}>{r.icon} {r.title}</option>)}
          </select>
        </div>
      </header>
      <div className="row gap">
        <input className="grow" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Enter" && search()}
          placeholder="IDs (123, 456) · filter (state/group='open' and owner/userId='me') · or words" />
        <button className="primary" onClick={search} disabled={busy || !q.trim()}>{busy ? "Searching…" : "Search"}</button>
      </div>
      <div className="jazz-layout">
        <div className="jazz-list">
          {items.length === 0 && <div className="muted">No results yet.</div>}
          {items.map((w) => (
            <button key={w.id} className={`jazz-item ${sel?.id === w.id ? "sel" : ""}`} onClick={() => setSel(w)}>
              <div className="row between"><strong>{w.id}</strong><span className="chip">{w.type}</span></div>
              <div>{w.title}</div>
              <div className="muted small">{w.state} · {w.owner ?? "unassigned"}</div>
            </button>
          ))}
        </div>
        {sel && (
          <div className="panel jazz-detail">
            <h3>{sel.id} — {sel.title}</h3>
            <div className="muted small">{sel.type} · {sel.state} · {sel.owner ?? "unassigned"}</div>
            <p className="pre">{sel.description || "(no description)"}</p>
            <div className="row gap">
              <button className="primary" onClick={() => analyse(sel)}>🔎 Analyse with agent</button>
              <button onClick={() => toTask(sel)}>＋ Create task</button>
              {sel.url && <a href={sel.url} target="_blank" rel="noreferrer">Open in Jazz ↗</a>}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
