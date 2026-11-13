import { useState } from "react";
import { ArrowUpRight, Bot as BotIcon, Compass, CornerDownRight, Pause, Play, RoleIcon, Square } from "../components/icons";
import { api, ago, fmtTokens, roleOf, useStore } from "../store";

export function AgentsView() {
  const st = useStore();
  const [filter, setFilter] = useState<"active" | "all">("active");
  const [project, setProject] = useState<string>("");
  const list = Object.values(st.agents)
    .filter((a) => filter === "all" || ["running", "paused", "idle", "interrupted"].includes(a.status))
    .filter((a) => !project || (project === "master" ? a.projectId === null : a.projectId === project))
    .sort((a, b) => b.startedAt - a.startedAt);
  const running = Object.values(st.agents).filter((a) => a.status === "running").length;
  const paused = Object.values(st.agents).filter((a) => a.status === "paused").length;
  const interrupted = Object.values(st.agents).filter((a) => a.status === "interrupted").length;
  const pname = (id: string | null) => (id ? st.projects.find((p) => p.id === id)?.name ?? "—" : "Master");

  return (
    <div className="page">
      <header className="page-header">
        <h2><BotIcon size={20} className="h-icon" /> Agents overview</h2>
        <div className="row gap">
          <span className="pill green">{running} running</span>
          <span className="pill amber">{paused} paused</span>
          {interrupted > 0 && (
            <button onClick={() => void api().resumeAllInterrupted()} title="Agents that were working when the app closed. Each starts a fresh session with its brief and checks what is already done.">
              <Play size={13} /> Resume {interrupted} interrupted
            </button>
          )}
          <select value={project} onChange={(e) => setProject(e.target.value)}>
            <option value="">All projects</option>
            <option value="master">Master chat</option>
            {st.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <div className="seg">
            <button className={filter === "active" ? "on" : ""} onClick={() => setFilter("active")}>Active</button>
            <button className={filter === "all" ? "on" : ""} onClick={() => setFilter("all")}>All</button>
          </div>
          <button className="danger" disabled={!running && !paused} onClick={() => {
            if (!st.settings?.general.confirmStop || confirm("Stop all agents?")) void api().stopAll();
          }}>■ Stop all</button>
        </div>
      </header>
      {list.length === 0 ? <div className="empty">No {filter === "active" ? "active " : ""}agents.</div> : (
        <table className="table">
          <thead><tr><th>Agent</th><th>Project</th><th>Harness</th><th>Status</th><th>Activity</th><th>Tokens</th><th>Age</th><th /></tr></thead>
          <tbody>
            {list.map((a) => (
              <tr key={a.id}>
                <td>
                  <div className="row gap-s"><span className={`avatar small ${a.status === "running" ? "avatar-working" : ""}`}><RoleIcon role={a.role} size={24} /></span> <strong>{roleOf(a.role)?.title ?? a.role}</strong></div>
                  {a.parentAgentId && <div className="muted small row gap-s"><CornerDownRight size={12} /> delegated by {roleOf(st.agents[a.parentAgentId]?.role)?.title ?? "agent"}</div>}
                </td>
                <td>{pname(a.projectId)}</td>
                <td>{a.harness}{a.harness === "duo" && <span className="warn-badge" title="GitLab Duo headless mode auto-approves its own tools">!</span>}</td>
                <td><span className={`status st-${a.status}`}>{a.status}</span></td>
                <td className="activity" title={a.lastActivity ?? ""}>
                  {a.plan.length > 0 && <div className="mini-progress"><div style={{ width: `${(a.plan.filter((p) => p.status === "completed").length / a.plan.length) * 100}%` }} /></div>}
                  {a.lastActivity ?? "—"}
                </td>
                <td title={a.estimated ? "estimated" : "reported"}>{fmtTokens(a.tokensIn + a.tokensOut)}{a.estimated ? "*" : ""}</td>
                <td>{ago(a.startedAt)}</td>
                <td className="actions">
                  {a.status === "running" && <button onClick={() => api().pauseAgent(a.id)} title="Pause" className="icon-only"><Pause size={14} /></button>}
                  {a.status === "paused" && <button onClick={() => api().resumeAgent(a.id)} title="Resume" className="icon-only"><Play size={14} /></button>}
                  {a.status === "interrupted" && <button onClick={() => void api().resumeInterrupted(a.id).catch((e) => st.toast("error", String(e?.message ?? e)))} title="Resume (the app closed while it was working)" className="icon-only"><Play size={14} /></button>}
                  {["running", "paused", "idle", "interrupted"].includes(a.status) && <button onClick={() => api().stopAgent(a.id)} title="Stop" className="icon-only"><Square size={13} /></button>}
                  <button onClick={() => st.setView({ kind: "flow", agentId: a.id })} title="Progress flow chart" className="icon-only"><Compass size={14} /></button>
                  {a.chatId && <button onClick={() => st.openChat(a.chatId!)} title="Open chat" className="icon-only"><ArrowUpRight size={14} /></button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="muted small">* estimated tokens (harness did not report usage). Pause interrupts the current turn at a safe point and queues new input; Resume continues. Interrupted agents were working when the app closed: Resume starts them again with their brief.</p>
    </div>
  );
}
