import { useCallback, useEffect, useMemo, useState } from "react";
import type { Span, TraceSummary } from "@shared/types";
import { ChartGantt, Download, RefreshCw } from "../components/icons";
import { api, fmtTokens, useStore } from "../store";

type Row = { span: Span; depth: number };

const KIND_LABEL: Record<Span["kind"], string> = { request: "Request", turn: "Turn", tool: "Tool", delegate: "Delegation", checks: "Checks", eval: "Eval" };
const dur = (ms: number) => (ms < 1000 ? `${ms} ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`);
const tokensOf = (s: Span) => Number(s.attrs["gen_ai.usage.input_tokens"] ?? 0) + Number(s.attrs["gen_ai.usage.output_tokens"] ?? 0);

/**
 * Timeline: one row per request; open one to see everything the coordinator and its specialists did for it as a
 * waterfall (turns, tool calls, delegations, checks), with durations and tokens. Export gives OTLP/JSON.
 */
export function TimelineView({ traceId: initial }: { traceId?: string }) {
  const st = useStore();
  const [traces, setTraces] = useState<TraceSummary[]>([]);
  const [sel, setSel] = useState<string | null>(initial ?? null);
  const [rows, setRows] = useState<Row[]>([]);
  const [hover, setHover] = useState<Span | null>(null);
  const loadList = useCallback(() => api().listTraces(null).then((t) => { setTraces(t); setSel((s) => s ?? t[0]?.traceId ?? null); }).catch(() => {}), []);
  const loadTrace = useCallback(() => { if (sel) void api().getTrace(sel).then(setRows).catch(() => setRows([])); }, [sel]);

  useEffect(() => { void loadList(); }, [loadList]);
  useEffect(() => { loadTrace(); }, [loadTrace]);
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | null = null;
    const off = window.flash.onEvent((e) => {
      if (e.type !== "trace.updated") return;
      if (!t) t = setTimeout(() => { t = null; void loadList(); if (e.traceId === sel) loadTrace(); }, 400);
    });
    return () => { off(); if (t) clearTimeout(t); };
  }, [sel, loadList, loadTrace]);

  const range = useMemo(() => {
    if (!rows.length) return { start: 0, span: 1 };
    const start = Math.min(...rows.map((r) => r.span.start));
    const end = Math.max(...rows.map((r) => r.span.end ?? Date.now()));
    return { start, span: Math.max(1, end - start) };
  }, [rows]);

  const exportIt = async () => {
    if (!sel) return;
    const json = await api().exportTrace(sel);
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([json], { type: "application/json" }));
    a.download = `flash-trace-${sel.slice(0, 8)}.otlp.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    st.toast("info", "Trace exported as OTLP/JSON: open it in Jaeger, Grafana Tempo or Phoenix.");
  };

  const cur = traces.find((t) => t.traceId === sel);
  return (
    <div className="page timeline-page">
      <header className="page-header">
        <h2><ChartGantt size={20} className="h-icon" /> Timeline</h2>
        <div className="row gap">
          <button className="ghost" onClick={() => { void loadList(); loadTrace(); }} title="Refresh"><RefreshCw size={14} /></button>
          <button disabled={!sel} onClick={() => void exportIt()} title="Download this trace as OTLP/JSON for any OpenTelemetry viewer"><Download size={14} /> Export</button>
        </div>
      </header>
      <p className="muted small">Every request you send, with what the coordinator and each specialist did for it: turns, tool calls, delegations and checks, how long each took and the tokens it used. Stored only on this computer.</p>
      <div className="timeline">
        <aside className="trace-list">
          {!traces.length && <div className="empty small">No traces yet. Send a request to a coordinator.</div>}
          {traces.map((t) => (
            <button key={t.traceId} className={`trace-item ${t.traceId === sel ? "on" : ""}`} onClick={() => setSel(t.traceId)}>
              <div className="trace-name">{t.running && <span className="dot running" />}{t.name || "(request)"}</div>
              <div className="muted small">{new Date(t.start).toLocaleString()} · {dur(t.end - t.start)} · {fmtTokens(t.tokens)} tokens · {t.agents} agent{t.agents === 1 ? "" : "s"}{t.errors ? ` · ${t.errors} error${t.errors === 1 ? "" : "s"}` : ""}</div>
            </button>
          ))}
        </aside>
        <section className="waterfall">
          {cur && <div className="wf-summary small">
            <b>{dur(cur.end - cur.start)}</b> · {fmtTokens(cur.tokens)} tokens · {cur.spans} spans · {cur.agents} agent{cur.agents === 1 ? "" : "s"}
          </div>}
          {rows.map(({ span: s, depth }) => {
            const left = ((s.start - range.start) / range.span) * 100;
            const width = Math.max(0.4, (((s.end ?? Date.now()) - s.start) / range.span) * 100);
            const t = tokensOf(s);
            return (
              <div key={s.id} className={`wf-row kind-${s.kind} st-${s.status}`} onMouseEnter={() => setHover(s)} onMouseLeave={() => setHover((h) => (h?.id === s.id ? null : h))}>
                <div className="wf-label" style={{ paddingLeft: 6 + depth * 14 }} title={s.name}>
                  <span className="wf-kind">{KIND_LABEL[s.kind]}</span> {s.name}
                </div>
                <div className="wf-track">
                  <div className="wf-bar" style={{ left: `${left}%`, width: `${width}%` }} />
                </div>
                <div className="wf-meta small muted">{s.end === null ? "running" : dur(s.end - s.start)}{t ? ` · ${fmtTokens(t)}` : ""}</div>
              </div>
            );
          })}
          {hover && <div className="wf-detail small">
            <b>{hover.name}</b> <span className="muted">({hover.status})</span>
            <div className="wf-attrs">{Object.entries(hover.attrs).map(([k, v]) => <div key={k}><code>{k}</code> {String(v)}</div>)}</div>
          </div>}
        </section>
      </div>
    </div>
  );
}
