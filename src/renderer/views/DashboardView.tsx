import { useEffect, useState } from "react";
import type { UsageSummary } from "@shared/types";
import { api, fmtTokens, roleOf, useStore } from "../store";

export function DashboardView() {
  const st = useStore();
  const [days, setDays] = useState(7);
  const [u, setU] = useState<UsageSummary | null>(null);
  const agentCount = Object.keys(st.agents).length;

  useEffect(() => {
    let alive = true;
    const load = () => api().usageSummary(days).then((x) => alive && setU(x));
    void load();
    const t = setInterval(load, 5000);
    return () => { alive = false; clearInterval(t); };
  }, [days, agentCount]);

  const tasks = Object.values(st.tasks);
  const byStatus = (s: string) => tasks.filter((t) => t.status === s).length;
  const active = Object.values(st.agents).filter((a) => ["running", "paused"].includes(a.status));

  return (
    <div className="page">
      <header className="page-header">
        <h2>📊 Dashboard</h2>
        <div className="seg">
          {[1, 7, 30, 90].map((d) => <button key={d} className={days === d ? "on" : ""} onClick={() => setDays(d)}>{d === 1 ? "Today" : `${d}d`}</button>)}
        </div>
      </header>
      {!u ? <div className="empty">Loading…</div> : (
        <>
          <div className="cards">
            <Card label="Tokens in" value={fmtTokens(u.totals.tokensIn)} />
            <Card label="Tokens out" value={fmtTokens(u.totals.tokensOut)} />
            <Card label="Estimated share" value={`${Math.round(u.totals.estimatedShare * 100)}%`} hint="Share of usage estimated because the harness did not report it" />
            <Card label="Agents started" value={String(u.totals.agents)} />
            <Card label="Active now" value={String(active.length)} />
            <Card label="Open tasks" value={String(tasks.length - byStatus("done"))} hint={`${byStatus("in_progress")} in progress · ${byStatus("review")} in review · ${byStatus("blocked")} blocked`} />
          </div>
          {u.budget.dailyLimit > 0 && (
            <div className="budget">
              <div className="row between"><span>Daily token budget</span><span>{fmtTokens(u.budget.usedToday)} / {fmtTokens(u.budget.dailyLimit)}</span></div>
              <div className="meter"><div style={{ width: `${Math.min(100, (u.budget.usedToday / u.budget.dailyLimit) * 100)}%` }} className={u.budget.usedToday > u.budget.dailyLimit * 0.8 ? "hot" : ""} /></div>
            </div>
          )}
          <div className="grid2">
            <Bars title="Usage per day" rows={u.byDay} />
            <Bars title="By project" rows={u.byProject} />
            <Bars title="By agent role" rows={u.byRole.map((r) => ({ ...r, label: `${roleOf(r.key)?.icon ?? ""} ${roleOf(r.key)?.title ?? r.label}` }))} />
            <Bars title="By harness" rows={u.byHarness} />
          </div>
          <h3>Active agents</h3>
          {active.length === 0 ? <div className="muted">None right now.</div> : (
            <div className="active-list">
              {active.map((a) => (
                <button key={a.id} className="active-item" onClick={() => a.chatId && st.openChat(a.chatId)}>
                  <span>{roleOf(a.role)?.icon} {roleOf(a.role)?.title ?? a.role}</span>
                  <span className={`status st-${a.status}`}>{a.status}</span>
                  <span className="muted small activity">{a.lastActivity}</span>
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Card({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return <div className="card" title={hint}><div className="muted small">{label}</div><div className="card-value">{value}</div>{hint && <div className="muted small">{hint}</div>}</div>;
}

function Bars({ title, rows }: { title: string; rows: { key: string; label: string; tokens: number }[] }) {
  const max = Math.max(1, ...rows.map((r) => r.tokens));
  return (
    <div className="panel">
      <h4>{title}</h4>
      {rows.length === 0 ? <div className="muted small">No usage yet.</div> : rows.slice(0, 12).map((r) => (
        <div key={r.key} className="bar-row">
          <span className="bar-label" title={r.label}>{r.label}</span>
          <div className="bar"><div style={{ width: `${(r.tokens / max) * 100}%` }} /></div>
          <span className="bar-value">{fmtTokens(r.tokens)}</span>
        </div>
      ))}
    </div>
  );
}
