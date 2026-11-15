import { useEffect, useRef, useState } from "react";
import { api, useStore } from "../store";
import { specialistRows } from "../specialists";
import { AgentImportDialog } from "./AgentImport";
import { Dots } from "./Dots";
import { ChevronDown, Pause, Plus, RoleIcon, Users } from "./icons";

/**
 * Specialists, as a floating glass pill on the right of the chat (moved out of the sidebar to give Projects room).
 * The pill always shows how many specialists are working or paused; clicking it opens the full list as an overlay.
 */
export function SpecialistsPill() {
  const st = useStore();
  const [open, setOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const { rows, working, paused } = specialistRows(st.roles, st.agents);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    addEventListener("mousedown", onDown);
    addEventListener("keydown", onKey);
    return () => { removeEventListener("mousedown", onDown); removeEventListener("keydown", onKey); };
  }, [open]);

  const start = async (role: string) => {
    // No project selected (master chat, "No project" chat): the new chat goes to "No project", never the first project.
    const pid = st.currentProjectId;
    const r = st.roles.find((x) => x.name === role);
    const c = await api().createChat({ projectId: pid, agentRole: role, title: r?.title ?? role });
    st.upsertChat(c);
    await st.openChat(c.id);
  };

  return (
    <div className={`spec-float ${open ? "open" : ""}`} ref={ref}>
      <button className={`spec-pill ${working ? "is-working" : paused ? "is-paused" : ""}`} aria-expanded={open}
        title={working ? `${working} specialist${working > 1 ? "s" : ""} working — click to see them` : "Specialists — start a chat with one"}
        onClick={() => setOpen((o) => !o)}>
        <Users size={15} />
        <span>Specialists</span>
        {working > 0 && <Dots size={4} count={Math.min(working, 5)} title={`${working} working`} />}
        {!working && paused > 0 && <span className="paused-tag" title={`${paused} paused`}><Pause size={11} /></span>}
        <ChevronDown size={13} className={`spec-chev ${open ? "open" : ""}`} />
      </button>
      {open && (
        <div className="spec-overlay" role="dialog" aria-label="Specialists">
          <div className="spec-head">
            <span>Specialists</span>
            <button className="icon-btn" title="Add your own agent (template / import)" onClick={() => setImporting(true)}><Plus size={15} /></button>
          </div>
          <div className="spec-list">
            {rows.map(({ role: r, working: w, paused: p, busyAgent, busyAgents }) => (
              <button key={r.name} className={`palette-item ${w ? "is-working" : p ? "is-paused" : ""}`}
                title={`${r.description}\n\n${w ? "Working now — click to watch its progress." : `Click: new chat with ${r.title} in the current project.`}\nTip: type @${r.name} in any chat.`}
                onClick={async () => {
                  setOpen(false);
                  // A working specialist opens its chat with the progress flow; an idle one starts a new chat.
                  if (busyAgent?.chatId) { await st.openChat(busyAgent.chatId); st.openFlow(busyAgent.chatId, busyAgent.id); } else await start(r.name);
                }}>
                <span className="palette-icon"><RoleIcon role={r.name} size={24} state={w ? "working" : p ? "paused" : undefined} /></span>
                <span className="palette-title">{r.title}</span>
                {w > 0 && <Dots size={5} count={w} title={busyAgents.map((a) => `${a.name ?? r.title}${a.lastActivity ? ` — ${a.lastActivity}` : ""}`).join("\n")} />}
                {!w && p > 0 && <span className="paused-tag" title={`${p} paused`}><Pause size={12} /></span>}
                {r.source === "user" && <span className="custom-tag">custom</span>}
              </button>
            ))}
          </div>
        </div>
      )}
      {importing && <AgentImportDialog onClose={() => setImporting(false)} />}
    </div>
  );
}
