import { useEffect, useState } from "react";
import type { AgentImportResult } from "@shared/types";
import { api, useStore } from "../store";

/** Create / import a custom agent: edit the template (or paste one written by an LLM), validate live, import. */
export function AgentImportDialog({ onClose, initialText }: { onClose: () => void; initialText?: string }) {
  const toast = useStore((s) => s.toast);
  const [text, setText] = useState(initialText ?? "");
  const [check, setCheck] = useState<AgentImportResult | null>(null);

  useEffect(() => { if (!initialText) void api().agentTemplate().then(setText); }, [initialText]);
  useEffect(() => {
    if (!text) return;
    const t = setTimeout(() => void api().validateAgent(text).then(setCheck), 250);
    return () => clearTimeout(t);
  }, [text]);

  const doImport = async () => {
    const r = await api().importAgentText(text, "editor");
    setCheck(r);
    if (r.ok) { toast("info", `Agent "${r.name}" imported — it is now in the specialist list.`); onClose(); }
  };
  const fromFiles = async () => {
    const rs = await api().importAgentFiles();
    reportImports(rs, toast);
    if (rs.some((r) => r.ok)) onClose();
  };

  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <div className="row between">
          <h3>➕ Add your own agent</h3>
          <div className="row gap">
            <button onClick={async () => { const p = await api().saveAgentTemplate(); if (p) toast("info", `Template saved to ${p}`); }}>⬇ Save template…</button>
            <button onClick={fromFiles}>📂 Import .md files…</button>
          </div>
        </div>
        <p className="muted small">
          Edit the template below — or paste an agent file written by you or your LLM — then import it. You can also drag <code>.md</code> agent files onto the app window.
          Imported agents appear in the specialist list, can be <code>@mentioned</code>, and the coordinator can delegate to them.
        </p>
        <textarea className="agent-editor" spellCheck={false} value={text} onChange={(e) => setText(e.target.value)} />
        {check && (
          <div className="validation">
            {check.errors.map((e) => <div key={e} className="v-err">✖ {e}</div>)}
            {check.warnings.map((w) => <div key={w} className="v-warn">⚠ {w}</div>)}
            {check.ok && check.warnings.length === 0 && <div className="v-ok">✔ Valid agent "{check.name}"</div>}
          </div>
        )}
        <div className="row between">
          <button onClick={() => void api().agentTemplate().then(setText)}>Reset to template</button>
          <div className="row gap">
            <button onClick={onClose}>Cancel</button>
            <button className="primary" disabled={!check?.ok} onClick={doImport}>Import agent</button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function reportImports(rs: AgentImportResult[], toast: (l: "info" | "warn" | "error", t: string) => void): void {
  for (const r of rs) {
    if (r.ok) toast(r.warnings.length ? "warn" : "info", `Imported "${r.name}" from ${r.file}${r.warnings.length ? ` — ${r.warnings[0]}` : ""}`);
    else toast("error", `${r.file}: ${r.errors[0] ?? "invalid agent file"}`);
  }
}
