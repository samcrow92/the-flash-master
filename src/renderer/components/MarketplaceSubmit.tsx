import { useState } from "react";
import { CircleAlert, CircleCheck, FolderInput, FileText, RefreshCw, Upload, X } from "./icons";
import type { Submission, SubmissionStatus, SubmitDraft, SubmitFileKind, SubmitMeta, SubmitResult } from "@shared/types";
import { api, useStore } from "../store";

export interface SubmitPrefill { meta?: Partial<SubmitMeta>; notes?: string }

const FILE_KINDS: [SubmitFileKind, string][] = [["agent", "Agent"], ["workflow", "Workflow"], ["skill", "Skill"], ["script", "Script"], ["instructions", "Instructions"]];
const emptyMeta: SubmitMeta = { id: "", name: "", version: "1.0.0", description: "", team: "", tags: [] };

/** Submit a plugin (folder in the plugins-src/<id>/ layout, or single files) to the Flash server for review. */
export function SubmitDialog({ prefill, onClose, onDone }: { prefill: SubmitPrefill; onClose: () => void; onDone: (s: Submission) => void }) {
  const st = useStore();
  const [draft, setDraft] = useState<SubmitDraft | null>(null);
  const [meta, setMeta] = useState<SubmitMeta>({ ...emptyMeta, ...prefill.meta });
  const [tags, setTags] = useState((prefill.meta?.tags ?? []).join(", "));
  const [notes, setNotes] = useState(prefill.notes ?? "");
  const [result, setResult] = useState<SubmitResult | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const pick = async (mode: "folder" | "files") => {
    setBusy("pick");
    try {
      const d = await api().marketplaceSubmitPick(mode);
      if (!d) return;
      setDraft(d);
      setResult(null);
      // A resubmission keeps its id/name; everything else comes from the folder / files.
      const keep = prefill.meta ?? {};
      setMeta({ ...d.meta, ...Object.fromEntries(Object.entries(keep).filter(([, v]) => v)) } as SubmitMeta);
      setTags(d.meta.tags.join(", "));
    } catch (e: any) { st.toast("error", String(e?.message ?? e)); } finally { setBusy(null); }
  };
  const setKind = (i: number, kind: SubmitFileKind) => {
    if (draft?.source.kind !== "files") return;
    setDraft({ ...draft, source: { kind: "files", files: draft.source.files.map((f, j) => (j === i ? { ...f, kind } : f)) } });
    setResult(null);
  };
  const send = async (dryRun: boolean) => {
    if (!draft) return;
    setBusy(dryRun ? "check" : "submit");
    try {
      const r = await api().marketplaceSubmit({ source: draft.source, meta: { ...meta, tags: tags.split(",").map((t) => t.trim()).filter(Boolean) }, notes, dryRun });
      setResult(r);
      if (r.ok && r.submission) { st.toast("info", `Submitted ${r.submission.name} ${r.submission.version} for review`); onDone(r.submission); }
    } catch (e: any) { setResult({ ok: false, errors: [String(e?.message ?? e)], kinds: [], items: [] }); } finally { setBusy(null); }
  };
  const field = (k: keyof Omit<SubmitMeta, "tags">, label: string, placeholder = "") => (
    <label className="field"><span>{label}</span><input value={meta[k]} placeholder={placeholder} onChange={(e) => { setMeta({ ...meta, [k]: e.target.value }); setResult(null); }} /></label>
  );

  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal submit-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="row between"><h3><Upload size={17} className="h-icon" /> Submit to the Flash server</h3><button className="ghost icon-btn" title="Close" onClick={onClose}><X size={16} /></button></div>
        <div className="muted small">A reviewer checks your plugin before it is published to everyone. Pick a plugin folder (<code>plugin.json</code>, <code>agents/</code>, <code>workflows/</code>, <code>skills/</code>, <code>scripts/</code>, <code>instructions.md</code>…) or single files.</div>
        <div className="row gap">
          <button disabled={!!busy} onClick={() => pick("folder")}><FolderInput size={14} /> Choose folder…</button>
          <button disabled={!!busy} onClick={() => pick("files")}><FileText size={14} /> Choose files…</button>
          {draft && <span className="muted small ellipsis">{draft.source.kind === "folder" ? draft.source.path : `${draft.source.files.length} file(s)`}</span>}
        </div>
        {draft?.source.kind === "files" && (
          <div className="submit-files">
            {draft.source.files.map((f, i) => (
              <div key={f.path} className="row gap-s"><code className="grow ellipsis">{f.name}</code>
                <select value={f.kind} onChange={(e) => setKind(i, e.target.value as SubmitFileKind)}>{FILE_KINDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
            ))}
          </div>
        )}
        {draft?.source.kind === "folder" && draft.items.length > 0 && <div className="row gap-s wrap">{draft.items.map((x) => <span key={x} className="chip">{x}</span>)}</div>}
        {draft && draft.problems.length > 0 && <div className="warn-note small">{draft.problems.map((p) => <div key={p}>{p}</div>)}</div>}
        <div className="grid3">
          {field("id", "Plugin id", "body-sw-test-pack")}
          {field("name", "Name")}
          {field("version", "Version", "1.0.0")}
        </div>
        <div className="grid3">
          {field("team", "Team")}
          <label className="field"><span>Tags (comma separated)</span><input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="hil, canoe" /></label>
        </div>
        {field("description", "Description")}
        <label className="field"><span>Notes for the reviewer</span><textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="What changed, how you tested it" /></label>
        {result && !result.ok && (
          <div className="submit-errors"><div className="row gap-s"><CircleAlert size={14} /> <strong>{result.errors.length === 1 ? "1 problem" : `${result.errors.length} problems`} — nothing was sent</strong></div>
            <ul>{result.errors.map((e) => <li key={e}>{e}</li>)}</ul></div>
        )}
        {result?.ok && !result.submission && <div className="submit-ok row gap-s small"><CircleCheck size={14} /> Looks good: {result.items.join(" · ")}</div>}
        <div className="row gap end">
          <button className="ghost" onClick={onClose}>Cancel</button>
          <button disabled={!draft || !!busy} onClick={() => send(true)}>{busy === "check" ? "Checking…" : "Check"}</button>
          <button className="primary" disabled={!draft || !!busy || !meta.id || !meta.version} onClick={() => send(false)}><Upload size={14} /> {busy === "submit" ? "Submitting…" : "Submit"}</button>
        </div>
      </div>
    </div>
  );
}

export const STATUS_LABEL: Record<SubmissionStatus, string> = {
  pending: "Pending review", approved: "Approved", changes_requested: "Changes requested", rejected: "Rejected", withdrawn: "Withdrawn",
};
const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "");

/** "My submissions": status, reviewer feedback, withdraw / resubmit. */
export function SubmissionsList({ subs, error, onReload, onResubmit }: { subs: Submission[] | null; error: string; onReload: () => Promise<void>; onResubmit: (s: Submission) => void }) {
  const st = useStore();
  const [busy, setBusy] = useState<number | null>(null);
  const withdraw = async (s: Submission) => {
    if (!confirm(`Withdraw ${s.name} ${s.version}? The reviewer will no longer see it.`)) return;
    setBusy(s.id);
    try { await api().marketplaceWithdraw(s.id); st.toast("info", `Withdrew ${s.name} ${s.version}`); await onReload(); }
    catch (e: any) { st.toast("error", String(e?.message ?? e)); } finally { setBusy(null); }
  };
  if (error) return <div className="warn-note row gap-s"><CircleAlert size={14} /> {error} <button className="ghost" onClick={() => void onReload()}><RefreshCw size={13} /> Retry</button></div>;
  if (!subs) return <div className="muted">Loading…</div>;
  if (!subs.length) return <div className="empty"><div>You haven't submitted anything yet. Use <strong>Submit</strong> to send an agent, workflow, skill or script for review.</div></div>;
  return (
    <div className="sub-list">
      {subs.map((s) => (
        <div key={s.id} className={`panel sub-card s-${s.status}`}>
          <div className="row between">
            <div className="row gap-s wrap"><strong>{s.name || s.pluginId}</strong><span className="muted small">v{s.version}</span>
              <span className={`pill sub-status s-${s.status}`}>{STATUS_LABEL[s.status] ?? s.status}</span>
              {s.kinds.map((k) => <span key={k} className={`chip kind k-${k}`}>{k}</span>)}</div>
            <div className="row gap-s">
              {s.status === "changes_requested" && <button className="primary" onClick={() => onResubmit(s)}><Upload size={13} /> Resubmit</button>}
              {(s.status === "pending" || s.status === "changes_requested") && <button className="ghost danger" disabled={busy === s.id} onClick={() => void withdraw(s)}>{busy === s.id ? "Withdrawing…" : "Withdraw"}</button>}
            </div>
          </div>
          <div className="muted small"><code>{s.pluginId}</code> · #{s.id} · submitted {fmt(s.createdAt)}{s.reviewedAt ? ` · reviewed ${fmt(s.reviewedAt)}${s.reviewer ? ` by ${s.reviewer}` : ""}` : ""}</div>
          {s.feedback && <div className={`sub-feedback s-${s.status}`}><div className="small sub-feedback-h">Reviewer feedback{s.reviewer ? ` — ${s.reviewer}` : ""}</div><div className="pre">{s.feedback}</div></div>}
          {s.notes && <div className="small muted pre">Your notes: {s.notes}</div>}
        </div>
      ))}
    </div>
  );
}
