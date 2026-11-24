import { useCallback, useEffect, useMemo, useState } from "react";
import type { TraceMatrix, TraceStatus } from "@shared/types";
import { FileText, Loader2, RefreshCw, Send, Waypoints } from "../components/icons";
import { openHtml } from "../htmlPreview";
import { api, useStore } from "../store";

const LABEL: Record<TraceStatus, string> = { verified: "Verified", failed: "Failing", untested: "Tested, no result", uncovered: "No test" };
const ORDER: TraceStatus[] = ["verified", "failed", "untested", "uncovered"];
const cleanErr = (e: unknown) => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");

/**
 * Traceability: requirement → test → result for a project, from any tool: trace files and ReqIF exports in
 * .flashmaster/trace, cached DOORS Next modules, requirement tags in test code and JUnit XML results. Shows the gaps,
 * writes an evidence report with diagrams, and can hand the gaps to the coordinator.
 */
export function TraceabilityView() {
  const st = useStore();
  const [projectId, setProjectId] = useState(st.currentProjectId ?? st.projects[0]?.id ?? "");
  const [m, setM] = useState<TraceMatrix | null>(null);
  const [busy, setBusy] = useState<"" | "load" | "report" | "send">("");
  const [show, setShow] = useState<TraceStatus | "gaps" | "all">("gaps");
  const [q, setQ] = useState("");
  const load = useCallback(async () => {
    if (!projectId) return;
    setBusy("load");
    try { setM(await api().traceMatrix(projectId)); } catch (e) { st.toast("warn", cleanErr(e)); } finally { setBusy(""); }
  }, [projectId]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { if (!projectId && st.projects[0]) setProjectId(st.projects[0].id); }, [st.projects, projectId]);
  const rows = useMemo(() => (m?.rows ?? []).filter((r) => (show === "all" || (show === "gaps" ? r.status !== "verified" : r.status === show))
    && (!q || `${r.req.id} ${r.req.title}`.toLowerCase().includes(q.toLowerCase()))), [m, show, q]);
  const total = m?.rows.length ?? 0;

  const report = async () => {
    setBusy("report");
    try {
      const path = await api().traceReport(projectId);
      const r = await api().previewHtml(path, null);
      if (r.ok) openHtml({ url: r.url, name: r.name, path: r.path, chatId: null }); else st.toast("info", `Report written: ${path}`);
    } catch (e) { st.toast("warn", cleanErr(e)); } finally { setBusy(""); }
  };
  const closeGaps = async () => {
    if (!m) return;
    setBusy("send");
    try {
      const chats = await api().listChats(projectId);
      const chat = chats.find((c) => c.agentRole === "flashmaster") ?? await api().createChat({ projectId, title: "Traceability", agentRole: "flashmaster" });
      const gaps = m.rows.filter((r) => r.status !== "verified").slice(0, 40);
      await api().sendMessage({ chatId: chat.id, content: [`Close the verification gaps in this project (call trace_matrix for the current state):`,
        ...gaps.map((r) => `- ${r.req.id} (${LABEL[r.status].toLowerCase()}): ${r.req.title.slice(0, 120)}`),
        "", "Write the missing tests (tag each with the requirement id, e.g. `@req REQ-12`), fix what fails, and propose a plan first."].join("\n") });
      st.setView({ kind: "chat", chatId: chat.id });
    } catch (e) { st.toast("warn", cleanErr(e)); } finally { setBusy(""); }
  };

  return (
    <div className="page trace-page">
      <header className="page-header">
        <h2><Waypoints size={20} className="h-icon" /> Traceability</h2>
        <div className="row gap">
          <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>{st.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
          <button className="ghost" onClick={() => void load()} title="Read the sources again">{busy === "load" ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />}</button>
          <button disabled={!total || !!busy} onClick={() => void report()} title="Write an HTML evidence report with diagrams to the project's reports folder">
            {busy === "report" ? <Loader2 size={14} className="spin" /> : <FileText size={14} />} Evidence report</button>
          <button className="primary" disabled={!m || !(total - (m?.counts.verified ?? 0)) || !!busy} onClick={() => void closeGaps()}><Send size={13} /> Close the gaps</button>
        </div>
      </header>
      <p className="muted small">Requirement → test → result, from whatever your team uses: CSV, JSON or ReqIF exports in <code>.flashmaster/trace</code> (DOORS, Polarion, Jama, Codebeamer…), cached DOORS Next modules, requirement tags in test code (<code>@req REQ-12</code>, <code>Verifies: 4711</code>) and JUnit XML results.</p>
      {m && <div className="trace-sources small">{m.sources.map((s) => <span key={s.id} className={`trace-src ${s.items ? "on" : ""}`} title={s.detail ?? s.label}>{s.label}: {s.items}</span>)}</div>}
      {m && total > 0 && (
        <div className="cards">
          <div className="card"><div className="muted small">Verified</div><div className="big">{Math.round((m.counts.verified / total) * 100)}%</div><div className="muted small">{m.counts.verified}/{total} requirements</div></div>
          {ORDER.slice(1).map((s) => <button key={s} className={`card trace-card st-${s} ${show === s ? "on" : ""}`} onClick={() => setShow(show === s ? "gaps" : s)}>
            <div className="muted small">{LABEL[s]}</div><div className="big">{m.counts[s]}</div></button>)}
          <div className="card"><div className="muted small">Tests without a requirement</div><div className="big">{m.orphanTests.length}</div></div>
        </div>
      )}
      {m && !total && <div className="empty">No requirements found. Put a <code>requirements.csv</code> (id, title) or a ReqIF export in <code>.flashmaster/trace</code>, or load a DOORS Next module under IBM Jazz → Requirements.</div>}
      {total > 0 && (
        <>
          <div className="row gap trace-filter">
            <div className="seg">{(["gaps", "all"] as const).map((s) => <button key={s} className={show === s ? "on" : ""} onClick={() => setShow(s)}>{s === "gaps" ? "Gaps" : "All"}</button>)}</div>
            <input placeholder="Filter by id or title…" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <table className="trace-table">
            <thead><tr><th>Requirement</th><th>Tests</th><th>Status</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.req.id} className={`st-${r.status}`}>
                  <td><code>{r.req.id}</code> {r.req.title}<div className="muted small">{r.req.source}</div></td>
                  <td>{r.tests.length ? r.tests.map((t) => <div key={t.id} className="small"><code>{t.title}</code> <span className={`trace-out ${t.outcome ?? "none"}`}>{t.outcome ?? "no result"}</span> <span className="muted">{t.where}</span></div>) : <span className="muted small">no test</span>}</td>
                  <td><span className={`trace-status st-${r.status}`}>{LABEL[r.status]}</span></td>
                </tr>
              ))}
              {!rows.length && <tr><td colSpan={3} className="muted small">Nothing to show with this filter.</td></tr>}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
