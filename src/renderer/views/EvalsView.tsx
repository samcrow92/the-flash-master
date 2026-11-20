import { useCallback, useEffect, useMemo, useState } from "react";
import type { EvalCaseResult, EvalProgress, EvalSuite } from "@shared/types";
import { ChartGantt, CircleCheck, CircleX, FlaskConical, Play, Square, TriangleAlert } from "../components/icons";
import { api, fmtTokens, useStore } from "../store";

const EXAMPLE = `{ "name": "Golden tasks", "targets": ["", "pi/qwen-local/qwen3-coder"],
  "cases": [{ "id": "debounce-test", "prompt": "Add a unit test for the brake light debounce",
              "expect": { "status": "done", "checks": true, "files": ["tests/test_brake.c"] } }] }`;
const label = (t: string) => t.trim() || "default";
const secs = (ms: number) => (ms < 60_000 ? `${Math.round(ms / 1000)} s` : `${(ms / 60_000).toFixed(1)} min`);

/**
 * Evals: golden tasks from the project's .flashmaster/evals, replayed on each harness / model. The latest batch is shown
 * per case and target with its score, tokens and time; a case that passed in the previous batch and fails now (or
 * costs much more) is flagged as a regression.
 */
export function EvalsView() {
  const st = useStore();
  const projects = st.projects;
  const [projectId, setProjectId] = useState<string>(projects[0]?.id ?? "");
  const [suites, setSuites] = useState<EvalSuite[]>([]);
  const [results, setResults] = useState<EvalCaseResult[]>([]);
  const [progress, setProgress] = useState<EvalProgress | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const load = useCallback(async () => {
    if (!projectId) return;
    const [s, r, p] = await Promise.all([api().listEvalSuites(projectId), api().evalResults(projectId), api().evalState()]);
    setSuites(s); setResults(r); setProgress(p);
  }, [projectId]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => window.flash.onEvent((e) => {
    if (e.type !== "evals.updated") return;
    setProgress(e.progress);
    if (!e.progress.running || e.progress.done) void api().evalResults(projectId).then(setResults);
  }), [projectId]);
  useEffect(() => { if (!projectId && projects[0]) setProjectId(projects[0].id); }, [projects, projectId]);

  const latestBatch = results[0]?.batch ?? null;
  const latest = useMemo(() => results.filter((r) => r.batch === latestBatch), [results, latestBatch]);
  const targets = useMemo(() => [...new Set([...suites.flatMap((s) => s.targets), ...latest.map((r) => r.target)])], [suites, latest]);
  const byTarget = targets.map((t) => {
    const rs = latest.filter((r) => r.target === t);
    return { t, n: rs.length, passed: rs.filter((r) => r.passed).length, tokens: rs.reduce((a, r) => a + r.tokens, 0) };
  });
  const cell = (suite: string, caseId: string, target: string) => latest.find((r) => r.suite === suite && r.caseId === caseId && r.target === target);
  const history = (suite: string, caseId: string, target: string) => results.filter((r) => r.suite === suite && r.caseId === caseId && r.target === target).slice(0, 10).reverse();
  const run = async (o?: { suite?: string; caseId?: string }) => {
    try { setProgress(await api().runEvals(projectId, o)); } catch (e: any) { st.toast("error", String(e?.message ?? e)); }
  };
  const total = suites.reduce((n, s) => n + s.cases.length * s.targets.length, 0);

  return (
    <div className="page evals-page">
      <header className="page-header">
        <h2><FlaskConical size={20} className="h-icon" /> Evals</h2>
        <div className="row gap">
          <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>{projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
          {progress?.running
            ? <button className="ghost danger" onClick={() => void api().cancelEvals()}><Square size={13} /> Stop after this case</button>
            : <button className="primary" disabled={!total} onClick={() => void run()}><Play size={13} /> Run all ({total})</button>}
        </div>
      </header>
      <p className="muted small">Golden tasks from <code>.flashmaster/evals/*.json</code>, each run as a fresh request in a throwaway copy of the project on every target (harness/model). The app scores the result status, the project's checks, files, text, tokens and time, and flags regressions against the previous batch. Settings → Data can run them nightly.</p>
      {progress?.running && <div className="eval-progress"><div className="bar" style={{ width: `${(progress.done / Math.max(1, progress.total)) * 100}%` }} /><span className="small">Running {progress.done + 1}/{progress.total}: {progress.current}</span></div>}
      {!suites.length && <div className="empty">No suites in this project. Add <code>.flashmaster/evals/golden.json</code>, for example:
        <pre className="small">{EXAMPLE}</pre>The full format is in <code>docs/traces-and-evals.md</code>.</div>}
      {byTarget.length > 0 && latestBatch && (
        <div className="cards">
          {byTarget.map((x) => <div key={x.t} className="card"><div className="muted small">{label(x.t)}</div><div className="big">{x.n ? `${Math.round((x.passed / x.n) * 100)}%` : "—"}</div><div className="muted small">{x.passed}/{x.n} passed · {fmtTokens(x.tokens)} tokens</div></div>)}
        </div>
      )}
      {suites.map((s) => (
        <section key={s.file} className="eval-suite">
          <h3>{s.name} <span className="muted small">{s.file}</span> {s.error && <span className="warn-text small">{s.error}</span>}
            {!progress?.running && s.cases.length > 0 && <button className="ghost small" onClick={() => void run({ suite: s.file })}><Play size={12} /> Run suite</button>}</h3>
          <table className="eval-table">
            <thead><tr><th>Case</th>{s.targets.map((t) => <th key={t}>{label(t)}</th>)}</tr></thead>
            <tbody>
              {s.cases.map((c) => (
                <tr key={c.id}>
                  <td><div>{c.title}</div><div className="muted small">{c.id}</div></td>
                  {s.targets.map((t) => {
                    const r = cell(s.file, c.id, t);
                    const h = history(s.file, c.id, t);
                    const k = `${s.file}|${c.id}|${t}`;
                    return (
                      <td key={t} className={`eval-cell ${r ? (r.passed ? "pass" : "fail") : ""} ${r?.regression ? "regressed" : ""}`}>
                        {r ? <button className="link" onClick={() => setOpen(open === k ? null : k)} title={r.regression ? `Regression: ${r.regression}` : "Show the assertions"}>
                          {r.passed ? <CircleCheck size={13} /> : <CircleX size={13} />} {Math.round(r.score * 100)}% · {fmtTokens(r.tokens)} · {secs(r.ms)}
                          {r.regression && <TriangleAlert size={13} className="warn-text" />}
                        </button> : <span className="muted small">not run</span>}
                        {h.length > 1 && <div className="eval-spark" title="Last batches, oldest first">{h.map((x) => <i key={x.id} className={x.passed ? "p" : "f"} />)}</div>}
                        {open === k && r && (
                          <div className="eval-detail small">
                            {r.regression && <div className="warn-text">Regression: {r.regression}</div>}
                            {r.assertions.map((a) => <div key={a.name} className={a.ok ? "ok" : "bad"}>{a.ok ? "✓" : "✗"} {a.name} {a.detail && <span className="muted">({a.detail})</span>}</div>)}
                            {r.traceId && <button className="link" onClick={() => st.setView({ kind: "timeline", traceId: r.traceId! })}><ChartGantt size={12} /> Open in Timeline</button>}
                          </div>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}
    </div>
  );
}
