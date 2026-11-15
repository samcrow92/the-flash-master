import { useState } from "react";
import { useKeptState } from "./virtual";
import type { ToolRun } from "@shared/types";
import { toolArgsPreview, toolCallsSummary, toolKindLabel } from "./toolCalls";
import { Brain, Check, ChevronRight, Copy, FileText, Globe, Loader2, Pencil, Search, SquareTerminal, Trash2, Wrench, X } from "./icons";

const KIND_ICON: Record<string, typeof Wrench> = {
  execute: SquareTerminal, read: FileText, edit: Pencil, delete: Trash2, move: Pencil, search: Search, fetch: Globe, think: Brain,
};
/** Show this many at once; more collapse behind "Show all". */
const VISIBLE = 4;

const duration = (r: ToolRun, now: number) => {
  const ms = (r.endedAt ?? now) - r.startedAt;
  return ms < 1000 ? "" : ms < 60000 ? `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)} s` : `${Math.floor(ms / 60000)} min ${Math.round((ms % 60000) / 1000)} s`;
};

/**
 * Commands / tool calls an agent ran for a reply, set apart from the prose as their own labelled section (tinted panel,
 * "Tool call" header, a verb badge and monospace arguments per call). Click a call to see the command and its output.
 */
export function ToolRuns({ tools }: { tools: ToolRun[] }) {
  const [all, setAll] = useKeptState(`tools-all:${tools[0]?.id ?? ""}`, false);
  const hidden = tools.length > VISIBLE && !all ? tools.length - VISIBLE : 0;
  const shown = hidden ? tools.slice(-VISIBLE) : tools;
  const { label, detail } = toolCallsSummary(tools);
  return (
    <section className="tool-runs" aria-label={label}>
      <div className="tool-runs-head">
        <Wrench size={12} /><span>{label}</span>
        {detail && <span className="tool-runs-detail">{detail}</span>}
      </div>
      {hidden > 0 && <button className="tool-runs-more link small" onClick={() => setAll(true)}>Show all {tools.length} commands ({hidden} earlier)</button>}
      {shown.map((r) => <ToolRunRow key={r.id} run={r} />)}
    </section>
  );
}

function ToolRunRow({ run }: { run: ToolRun }) {
  const [open, setOpen] = useKeptState(`tool-open:${run.id}`, false);
  const Icon = KIND_ICON[run.kind] ?? Wrench;
  const running = run.status === "pending" || run.status === "in_progress";
  const expandable = !!(run.input || run.output || running);
  const args = open ? "" : toolArgsPreview(run);
  return (
    <div className={`tool-run st-${run.status} ${open ? "open" : ""}`}>
      <button className="tool-run-head" onClick={() => expandable && setOpen((o) => !o)} aria-expanded={open} disabled={!expandable}
        title={expandable ? (open ? "Hide output" : "Show command and output") : run.title}>
        <ChevronRight size={13} className={`chev ${open ? "open" : ""} ${expandable ? "" : "invisible"}`} />
        <span className="tool-run-badge"><Icon size={12} className="tool-run-kind" />{toolKindLabel(run.kind)}</span>
        <span className="tool-run-title ellipsis">{run.title}{args && <span className="tool-run-args"> {args}</span>}</span>
        <span className="tool-run-meta muted small">{duration(run, Date.now())}</span>
        <span className="tool-run-status">
          {running ? <Loader2 size={13} className="spin" /> : run.status === "failed" ? <X size={13} /> : <Check size={13} />}
        </span>
      </button>
      {open && (
        <div className="tool-run-body">
          {run.input && <Block label={run.kind === "execute" ? "Command" : "Input"} text={run.input} />}
          <Block label="Output" text={run.output ?? (running ? "" : "")}
            empty={running ? "Waiting for output…" : "No output"} note={run.truncated ? "Long output: the middle part was left out." : undefined} />
        </div>
      )}
    </div>
  );
}

function Block({ label, text, empty, note }: { label: string; text: string; empty?: string; note?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="tool-run-block">
      <div className="tool-run-label">
        <span>{label}</span>
        {text && <button className="ghost tiny" onClick={() => { void navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1200); }}>
          {copied ? <Check size={12} /> : <Copy size={12} />} {copied ? "Copied" : "Copy"}</button>}
      </div>
      {text ? <pre className="tool-run-pre">{text}</pre> : <div className="muted small tool-run-empty">{empty}</div>}
      {note && <div className="muted small">{note}</div>}
    </div>
  );
}
