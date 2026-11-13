import { useCallback, useEffect, useState } from "react";
import { Compass as CompassIcon } from "../components/icons";
import type { AgentEvent, AgentFlow, AgentRun, PlanStep } from "@shared/types";
import { ago, api, fmtTokens, roleOf, useStore } from "../store";

/**
 * Live flow chart of where an agent is in its task:
 * Request → plan steps (✓ done / ● current / ○ pending) → delegations (branches to specialists) → outcome.
 * Shown as a side panel in chats (🧭 Progress) and as a full page from the Agents overview.
 */
export function FlowChart({ agentId, onSelect, compact }: { agentId: string; onSelect?: (id: string) => void; compact?: boolean }) {
  const [flow, setFlow] = useState<AgentFlow | null>(null);
  const live = useStore((s) => s.agents[agentId]);
  const load = useCallback(() => api().getAgentFlow(agentId).then(setFlow).catch(() => setFlow(null)), [agentId]);

  useEffect(() => {
    void load();
    let t: ReturnType<typeof setTimeout> | null = null;
    const off = window.flash.onEvent((e) => {
      const kids = flow?.children.map((c) => c.id) ?? [];
      if ((e.type === "flow.updated" && (e.agentId === agentId || kids.includes(e.agentId))) || (e.type === "agent.updated" && kids.includes(e.agent.id))) {
        if (!t) t = setTimeout(() => { t = null; void load(); }, 150);
      }
    });
    return () => { off(); if (t) clearTimeout(t); };
  }, [agentId, load, flow?.children.length]); // re-subscribe when delegated children appear

  if (!flow) return <div className="muted">Loading…</div>;
  const agent: AgentRun = live ? { ...flow.agent, ...live } : flow.agent;
  const plan: PlanStep[] = agent.plan ?? [];
  const firstTurn = flow.events.find((e) => e.kind === "turn");
  const delegations = flow.events.filter((e) => e.kind === "delegate");
  const approvals = flow.events.filter((e) => e.kind === "approval");
  const pendingApproval = approvals.length > 0 && approvals[approvals.length - 1]!.status === "waiting";
  const last = [...flow.events].reverse().find((e) => e.kind === "result" || e.kind === "error");
  const done = plan.filter((p) => p.status === "completed").length;
  const outcome = outcomeOf(agent, last);
  const role = roleOf(agent.role);

  return (
    <div className={`flow ${compact ? "compact" : ""}`}>
      <div className="flow-head">
        <div className="row gap-s"><span className="flow-icon">{role?.icon ?? "🤖"}</span><strong>{role?.title ?? agent.role}</strong>
          <span className={`status st-${agent.status}`}>{agent.status}</span></div>
        <div className="muted small">{agent.harness} · {fmtTokens(agent.tokensIn + agent.tokensOut)} tokens · started {ago(agent.startedAt)} ago</div>
        {plan.length > 0 && <div className="progress"><div style={{ width: `${(done / plan.length) * 100}%` }} /><span>{done}/{plan.length} steps</span></div>}
        {flow.parent && <button className="link" onClick={() => onSelect?.(flow.parent!.id)}>↖ delegated by {roleOf(flow.parent.role)?.title ?? flow.parent.role}</button>}
      </div>

      <div className="flow-chart">
        <Node kind="start" title="Request received" detail={firstTurn?.label ?? agent.brief} state="completed" />
        {plan.length === 0 ? (
          <Node kind="step" title={agent.status === "running" ? "Working" : agent.status === "paused" ? "Paused" : "Work"} detail={agent.lastActivity ?? undefined}
            state={agent.status === "running" ? "in_progress" : agent.status === "paused" ? "paused" : outcome.state === "completed" ? "completed" : "pending"} />
        ) : plan.map((p, i) => (
          <Node key={i} kind="step" title={`${i + 1}. ${p.title}`} state={agent.status === "paused" && p.status === "in_progress" ? "paused" : p.status}
            detail={p.status === "in_progress" && agent.status === "running" ? agent.lastActivity ?? undefined : undefined} />
        ))}
        {delegations.length > 0 && (
          <div className="flow-branch">
            <div className="branch-label">Delegated to specialists</div>
            <div className="branch-row">
              {delegations.map((d) => {
                const child = flow.children.find((c) => c.id === d.ref);
                const cs = useStore.getState().agents[d.ref ?? ""] ?? child;
                return (
                  <button key={d.id} className={`branch-node st-${cs?.status ?? "idle"}`} onClick={() => d.ref && onSelect?.(d.ref)} title="Open this specialist's flow">
                    <div>{roleOf(cs?.role)?.icon} <strong>{roleOf(cs?.role)?.title ?? cs?.role ?? "agent"}</strong></div>
                    <div className="small muted">{d.label.split(": ").slice(1).join(": ")}</div>
                    <div className="small">{cs?.status ?? "…"}{cs?.plan?.length ? ` · ${cs.plan.filter((p) => p.status === "completed").length}/${cs.plan.length}` : ""}</div>
                  </button>
                );
              })}
            </div>
          </div>
        )}
        {pendingApproval && <Node kind="gate" title="Waiting for your approval" detail={approvals[approvals.length - 1]!.label + " — react ✅ or ❌ in the chat"} state="in_progress" />}
        <Node kind="end" title={outcome.title} detail={outcome.detail} state={outcome.state} last />
      </div>

      {!compact || flow.events.length > 0 ? <Timeline events={flow.events} /> : null}
    </div>
  );
}

function outcomeOf(a: AgentRun, last: AgentEvent | undefined): { title: string; detail?: string; state: string } {
  if (a.status === "running") return { title: "Result", detail: "pending", state: "pending" };
  if (a.status === "paused") return { title: "Paused", detail: "Resume to continue", state: "paused" };
  if (a.status === "stopped") return { title: "Stopped", state: "failed" };
  if (a.status === "error") return { title: "Error", detail: last?.label, state: "failed" };
  return { title: "Result delivered", detail: last?.kind === "result" ? last.label : a.resultSummary?.slice(0, 160) ?? undefined, state: last ? "completed" : "pending" };
}

function Node({ kind, title, detail, state, last }: { kind: string; title: string; detail?: string; state: string; last?: boolean }) {
  const icon = state === "completed" ? "✓" : state === "in_progress" ? "●" : state === "failed" ? "✕" : state === "paused" ? "⏸" : "○";
  return (
    <div className={`flow-node n-${kind} s-${state}`}>
      <div className="node-box">
        <span className="node-icon">{icon}</span>
        <div className="node-text"><div className="node-title">{title}</div>{detail && <div className="node-detail">{detail}</div>}</div>
      </div>
      {!last && <div className="node-arrow" />}
    </div>
  );
}

function Timeline({ events }: { events: AgentEvent[] }) {
  const shown = events.filter((e) => e.kind !== "plan").slice(-40).reverse();
  const icon: Record<string, string> = { turn: "💬", tool: "🔧", delegate: "↗", approval: "🔐", result: "✅", error: "⚠️", status: "•" };
  return (
    <div className="timeline">
      <h4>Activity</h4>
      {shown.length === 0 && <div className="muted small">No activity yet.</div>}
      {shown.map((e) => (
        <div key={e.id} className="tl-row">
          <span className="tl-icon">{icon[e.kind] ?? "•"}</span>
          <span className="tl-label" title={e.label}>{e.label}</span>
          {e.status && <span className="muted small">{e.status}</span>}
          <span className="muted small tl-time">{new Date(e.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>
        </div>
      ))}
    </div>
  );
}

/** Side panel inside a chat: pick one of the chat's agents (incl. delegated specialists) and follow its flow. */
export function FlowPanel({ chatId, agentId, onClose }: { chatId: string; agentId: string | null; onClose: () => void }) {
  const agents = Object.values(useStore((s) => s.agents)).filter((a) => a.chatId === chatId).sort((a, b) => b.startedAt - a.startedAt);
  const [sel, setSel] = useState<string | null>(agentId);
  useEffect(() => { if (agentId) setSel(agentId); }, [agentId]);
  const current = sel ?? agents.find((a) => a.status === "running")?.id ?? agents[0]?.id ?? null;
  return (
    <aside className="thread flow-panel">
      <header className="thread-header">
        <strong>🧭 Progress</strong>
        <div className="row gap-s">
          {agents.length > 0 && (
            <select value={current ?? ""} onChange={(e) => setSel(e.target.value)}>
              {agents.map((a) => <option key={a.id} value={a.id}>{roleOf(a.role)?.icon} {roleOf(a.role)?.title ?? a.role} · {a.status}</option>)}
            </select>
          )}
          {current && <button className="ghost" title="Open full page" onClick={() => useStore.getState().setView({ kind: "flow", agentId: current })}>⤢</button>}
          <button className="ghost" onClick={onClose}>✕</button>
        </div>
      </header>
      <div className="flow-scroll">
        {current ? <FlowChart agentId={current} onSelect={setSel} compact /> : <div className="empty">No agent has worked in this chat yet.</div>}
      </div>
    </aside>
  );
}

export function FlowPage({ agentId }: { agentId: string }) {
  const st = useStore();
  const [id, setId] = useState(agentId);
  const a = st.agents[id];
  return (
    <div className="page">
      <header className="page-header">
        <h2><CompassIcon size={20} className="h-icon" /> Agent progress</h2>
        <div className="row gap">
          {a?.chatId && <button onClick={() => st.openChat(a.chatId!)}>Open chat ↗</button>}
          <button onClick={() => st.setView({ kind: "agents" })}>← Agents</button>
        </div>
      </header>
      <FlowChart agentId={id} onSelect={setId} />
    </div>
  );
}
