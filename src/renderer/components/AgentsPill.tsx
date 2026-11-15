import { useEffect, useRef, useState } from "react";
import { agentTitle, api, useStore } from "../store";
import { chatAgentRows } from "../specialists";
import { Dots } from "./Dots";
import { Activity, ChevronDown, Pause, Play, RoleIcon, Square } from "./icons";

/**
 * The chat's agents (running first), as a glass pill under the Specialists pill. Replaces the chip strip that used to
 * sit under the chat header and wrapped onto two lines. The pill always shows how many are running; clicking it opens the
 * list with each agent's status, plan progress and pause / resume / stop buttons.
 */
export function AgentsPill({ chatId }: { chatId: string }) {
  const st = useStore();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const { rows, running, paused } = chatAgentRows(st.agents, chatId);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    addEventListener("mousedown", onDown);
    addEventListener("keydown", onKey);
    return () => { removeEventListener("mousedown", onDown); removeEventListener("keydown", onKey); };
  }, [open]);

  if (rows.length === 0) return null;
  return (
    <div className={`spec-float agents-float ${open ? "open" : ""}`} ref={ref}>
      <button className={`spec-pill ${running ? "is-working" : paused ? "is-paused" : ""}`} aria-expanded={open}
        title={`${running} running · ${rows.length} in this chat — click to see them`}
        onClick={() => setOpen((o) => !o)}>
        <Activity size={15} />
        <span>Agents</span>
        {running > 0 ? <Dots size={4} count={running} title={`${running} running`} /> : <span className="agents-count">{rows.length}</span>}
        {!running && paused > 0 && <span className="paused-tag" title={`${paused} paused`}><Pause size={11} /></span>}
        <ChevronDown size={13} className={`spec-chev ${open ? "open" : ""}`} />
      </button>
      {open && (
        <div className="spec-overlay agents-overlay" role="dialog" aria-label="Agents in this chat">
          <div className="spec-head">
            <span>Agents in this chat</span>
            <span>{running} running</span>
          </div>
          <div className="spec-list">
            {rows.map((a) => (
              <span key={a.id} className={`agent-chip agent-row st-${a.status}`} title={`${a.lastActivity ?? ""}\nClick to see the progress flow`}>
                <button className="chip-main" onClick={() => { setOpen(false); st.openFlow(chatId, a.id); }}>
                  <RoleIcon role={a.role} size={16} state={a.status === "running" ? "working" : a.status === "paused" ? "paused" : undefined} />
                  <span className="chip-label">{agentTitle(a)}
                    <small>{a.harness} · {a.status}{a.plan.length > 0 && ` · ${a.plan.filter((p) => p.status === "completed").length}/${a.plan.length}`}</small></span>
                </button>
                {a.status === "running" && <button className="chip-act" onClick={() => api().pauseAgent(a.id)} title="Pause"><Pause size={12} /></button>}
                {a.status === "paused" && <button className="chip-act" onClick={() => api().resumeAgent(a.id)} title="Resume"><Play size={12} /></button>}
                {a.status === "interrupted" && <button className="chip-act" onClick={() => void api().resumeInterrupted(a.id).catch((e) => st.toast("error", String(e?.message ?? e)))} title="Resume (the app closed while it was working)"><Play size={12} /></button>}
                <button className="chip-act" onClick={() => api().stopAgent(a.id)} title="Stop"><Square size={10} fill="currentColor" /></button>
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
