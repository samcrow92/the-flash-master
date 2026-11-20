import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { AgentChecks } from "@shared/types";
import { api, useStore } from "../store";
import { CircleCheck, CircleX, FlaskConical, Loader2 } from "./icons";

/** The project's checks for one agent's worktree, kept fresh from checks.updated events. */
export function useAgentChecks(agentId: string) {
  const [checks, setChecks] = useState<AgentChecks | null>(null);
  const load = useCallback(() => api().agentChecks(agentId).then(setChecks).catch(() => setChecks(null)), [agentId]);
  useEffect(() => {
    void load();
    const off = window.flash.onEvent((e) => { if (e.type === "checks.updated" && e.agentId === agentId) void load(); });
    return off;
  }, [agentId, load]);
  return { checks, reload: load };
}

/**
 * Merge with the checks gate: when the app refuses because checks failed, offer "Merge anyway" (the user's override).
 * Returns the final result for the caller's toast.
 */
export async function mergeWithChecks(agentId: string, branch: string): Promise<{ ok: boolean; message: string }> {
  const r = await api().mergeAgentWork(agentId);
  if (r.ok || !/check/i.test(r.message)) return r;
  if (!confirm(`${r.message}\n\nMerge ${branch} anyway, without passing checks?`)) return r;
  return api().mergeAgentWork(agentId, true);
}

/** A compact chip: checks passed / failed / running / not run yet, with a Run checks button and the failing output on click. */
export function ChecksStatus({ agentId, compact }: { agentId: string; compact?: boolean }) {
  const st = useStore();
  const { checks } = useAgentChecks(agentId);
  const [open, setOpen] = useState<{ top: number; left: number } | null>(null);
  const [starting, setStarting] = useState(false);
  if (!checks || (!checks.configured.length && !checks.error)) {
    return compact ? null : <span className="checks-chip none" title="No checks set up: add .flashmaster/checks.json to the project, or default commands in Settings → Checks">No checks</span>;
  }
  const run = async () => {
    setStarting(true);
    try {
      const r = await api().runAgentChecks(agentId);
      if (r) st.toast(r.ok ? "info" : "warn", r.ok ? "Checks passed" : `Checks failed: ${r.results.filter((x) => !x.ok).map((x) => x.name).join(", ")}`);
    } catch (e: any) { st.toast("error", String(e?.message ?? e)); } finally { setStarting(false); }
  };
  const last = checks.last;
  const failed = last?.results.filter((r) => !r.ok) ?? [];
  const state = checks.error ? "error" : checks.running || starting ? "running" : !last ? "idle" : !last.ok ? "failed" : checks.current ? "passed" : "stale";
  const label = state === "error" ? "Checks set up wrongly" : state === "running" ? "Running checks…" : state === "idle" ? "Checks not run"
    : state === "failed" ? `${failed.length}/${last!.results.length} checks failed` : state === "passed" ? `${last!.results.length}/${last!.results.length} checks passed` : "Checks out of date";
  const title = checks.error ?? [
    `Checks (${checks.source === "project" ? ".flashmaster/checks.json" : "Settings → Checks"}):`,
    ...checks.configured.map((c) => `• ${c.name}: ${c.command}`),
    last ? `Last run ${new Date(last.at).toLocaleString()}${last.head ? ` on ${last.head.slice(0, 8)}` : ""}${last.dirty ? " (with uncommitted changes)" : ""}` : "",
    checks.requireForMerge ? "Merge waits for a green run of the current commit." : "",
  ].filter(Boolean).join("\n");
  const Icon = state === "running" ? Loader2 : state === "passed" ? CircleCheck : state === "failed" || state === "error" ? CircleX : FlaskConical;
  return (
    <span className="checks-status">
      <button className={`checks-chip ${state}`} title={compact && state === "idle" ? `${title}\nOpen Review to run them.` : title} onClick={(e) => {
        // Fixed to the viewport, so a card with overflow hidden never clips it.
        const r = e.currentTarget.getBoundingClientRect();
        const w = Math.min(560, window.innerWidth * 0.8);
        setOpen((o) => (o ? null : { top: r.bottom + 6, left: Math.max(12, Math.min(r.left, window.innerWidth - w - 12)) }));
      }} disabled={state === "idle" || state === "running"}>
        <Icon size={12} className={state === "running" ? "spin" : ""} />{label}
      </button>
      {!compact && state !== "running" && <button className="ghost small" onClick={() => void run()} title="Run the project's checks in this agent's worktree now">Run checks</button>}
      {open && last && createPortal(
        <>
          <div className="checks-pop-backdrop" onClick={() => setOpen(null)} />
          <div className="checks-pop" style={{ top: open.top, left: open.left }} onClick={(e) => e.stopPropagation()}>
            {last.results.map((r) => (
              <details key={r.name} open={!r.ok}>
                <summary className={r.ok ? "ok" : "bad"}>{r.ok ? "✓" : "✗"} {r.name} <code>{r.command}</code> <span className="muted">{(r.durationMs / 1000).toFixed(1)} s{r.timedOut ? " · timed out" : r.ok ? "" : ` · exit ${r.code}`}</span></summary>
                {r.output && <pre>{r.output}</pre>}
              </details>
            ))}
          </div>
        </>, document.body)}
    </span>
  );
}
