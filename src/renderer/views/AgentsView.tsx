import { useState } from "react";
import { Bot as BotIcon, Compass, CornerDownRight, MessageCircle, Pause, Play, RoleIcon, Square } from "../components/icons";
import { api, ago, fmtTokens, roleOf, useStore } from "../store";

export function AgentsView() {
  const st = useStore();
  const [filter, setFilter] = useState<"active" | "all">("active");
  const [project, setProject] = useState<string>("");
  const list = Object.values(st.agents)
    .filter((a) => filter === "all" || ["running", "paused", "idle"].includes(a.status))
    .filter((a) => !project || (project === "master" ? a.projectId === null : a.projectId === project))
    .sort((a, b) => b.startedAt - a.startedAt);
  const running = Object.values(st.agents).filter((a) => a.status === "running").length;
  const paused = Object.values(st.agents).filter((a) => a.status === "paused").length;
  const pname = (id: string | null) => (id ? st.projects.find((p) => p.id === id)?.name ?? "—" : "Master");

  return (
    <div className="page">
      <header className="page-header">
        <h2><BotIcon size={20} className="h-icon" /> Agents overview</h2>
        <div className="row gap">
          <span className="pill green">{running} running</span>
          <span className="pill amber">{paused} paused</span>
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
      <div className="section-title agent-chat-label">Chat with an agent</div>
      <AgentChatStrip />
      {list.length === 0 ? <div className="empty">No {filter === "active" ? "active " : ""}agents.</div> : (
        <table className="table">
          <thead><tr><th>Agent</th><th>Project</th><th>Harness</th><th>Status</th><th>Activity</th><th>Tokens</th><th>Age</th><th /></tr></thead>
          <tbody>
            {list.map((a) => (
              <tr key={a.id} onDoubleClick={() => (a.chatId ? st.openChat(a.chatId) : st.chatWithAgent(a.role))}>
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
                  {["running", "paused", "idle"].includes(a.status) && <button onClick={() => api().stopAgent(a.id)} title="Stop" className="icon-only"><Square size={13} /></button>}
                  <button onClick={() => st.setView({ kind: "flow", agentId: a.id })} title="Progress flow chart" className="icon-only"><Compass size={14} /></button>
                  <button className="chat-btn" title={a.chatId ? "Open the chat this agent works in" : `Open a chat with ${roleOf(a.role)?.title ?? a.role}`}
                    onClick={() => (a.chatId ? st.openChat(a.chatId) : st.chatWithAgent(a.role))}><MessageCircle size={14} /> Chat</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="muted small">* estimated tokens (harness did not report usage). Pause interrupts the current turn at a safe point and queues new input; Resume continues.</p>
    </div>
  );
}

/** One glass card per agent: click to open its chat (where it works now, its latest chat, or a new one). */
export function AgentChatStrip() {
  const st = useStore();
  return (
    <div className="agent-chat-strip" aria-label="Chat with an agent">
      {st.roles.map((r) => {
        const working = Object.values(st.agents).some((a) => a.role === r.name && a.status === "running");
        return (
          <button key={r.name} className={`agent-chat-card ${working ? "is-working" : ""}`} onClick={() => st.chatWithAgent(r.name)}
            title={`${r.description}\n\n${working ? "Working now — opens its chat and progress." : `Opens your chat with ${r.title}.`}`}>
            <RoleIcon role={r.name} emoji={r.icon} size={26} className="icon-glyph" />
            <span className="agent-chat-title">{r.title}</span>
            <MessageCircle size={13} className="agent-chat-go" />
          </button>
        );
      })}
    </div>
  );
}
