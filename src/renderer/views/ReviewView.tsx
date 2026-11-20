import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { InboxPanel } from "../components/InboxPanel";
import { ChecksStatus, mergeWithChecks } from "../components/ChecksStatus";
import type { AgentWorkChanges } from "@shared/api";
import type { ReviewComment } from "@shared/review";
import type { AgentRun } from "@shared/types";
import { DiffStat, DiffView, type DiffSide } from "../components/DiffView";
import {
  ChevronDown, ChevronRight, FileCode, FilePlus2, FileX2, GitBranch, GitMerge, MessageCircle, MessageSquarePlus, Pencil, RoleIcon, RotateCcw, Send, Trash2, X,
} from "../components/icons";
import { api, ago, roleOf, useStore } from "../store";

/** Agents with their own copy of the project (worktree + branch) that can be reviewed, newest first. */
export function reviewableAgents(agents: Record<string, AgentRun>): AgentRun[] {
  return Object.values(agents).filter((a) => a.branch && a.worktree).sort((a, b) => b.startedAt - a.startedAt);
}

type Diff = { oldText: string; newText: string; binary: boolean; tooLarge: boolean };
const key = (path: string, side: DiffSide, line: number) => `${path}|${side}|${line}`;

/** Unsent comments per agent, kept while the app runs so switching pages doesn't lose them. */
const drafts = new Map<string, { comments: Record<string, ReviewComment>; note: string }>();

export function ReviewView({ agentId }: { agentId?: string }) {
  const st = useStore();
  const list = reviewableAgents(st.agents);
  const selected = list.find((a) => a.id === agentId) ?? list[0] ?? null;
  return (
    <div className="page review-page">
      <header className="page-header">
        <h2><GitBranch size={20} className="h-icon" /> Review changes</h2>
        <span className="muted small">Each code-writing specialist works on its own branch. Read its changes, comment on lines, then merge or discard.</span>
      </header>
      <InboxPanel />
      {!list.length ? (
        <div className="review-empty muted">
          <GitBranch size={28} />
          <p>No changes to review yet. When a code-writing specialist (Software Expert, Test Engineer…) works in a git project, it gets its own branch and its changes show up here.</p>
        </div>
      ) : (
        <div className="review-body">
          <nav className="review-agents" aria-label="Agents with changes">
            {list.map((a) => (
              <button key={a.id} className={`review-agent ${a.id === selected?.id ? "on" : ""}`} onClick={() => st.setView({ kind: "review", agentId: a.id })}>
                <span className={`avatar small ${a.status === "running" ? "avatar-working" : ""}`}><RoleIcon role={a.role} size={22} /></span>
                <span className="review-agent-main">
                  <strong>{roleOf(a.role)?.title ?? a.role}</strong>
                  <code className="small">{a.branch}</code>
                  <span className="muted small">{st.projects.find((p) => p.id === a.projectId)?.name ?? ""} · <span className={`st-${a.status}`}>{a.status}</span> · {ago(a.startedAt)}</span>
                </span>
              </button>
            ))}
          </nav>
          {selected && <AgentReview key={selected.id} agent={selected} />}
        </div>
      )}
    </div>
  );
}

function AgentReview({ agent }: { agent: AgentRun }) {
  const st = useStore();
  const [changes, setChanges] = useState<AgentWorkChanges | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [diffs, setDiffs] = useState<Record<string, Diff | "loading">>({});
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [wrap, setWrap] = useState(false);
  const draft = drafts.get(agent.id) ?? { comments: {}, note: "" };
  const [comments, setComments] = useState<Record<string, ReviewComment>>(draft.comments);
  const [note, setNote] = useState(draft.note);
  const [editing, setEditing] = useState<{ k: string; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const loaded = useRef(false);

  useEffect(() => { drafts.set(agent.id, { comments, note }); }, [agent.id, comments, note]);

  const refresh = useCallback(async () => {
    try {
      const c = await api().agentWorkChanges(agent.id);
      setChanges(c);
      setError(null);
      setDiffs({});
      if (!loaded.current) { loaded.current = true; setOpen(Object.fromEntries(c.files.slice(0, 12).map((f) => [f.path, true]))); }
    } catch (e: any) { setError(String(e?.message ?? e)); }
  }, [agent.id]);
  // Reload when the agent starts or finishes a turn (it may have changed or committed files).
  useEffect(() => { void refresh(); }, [refresh, agent.status]);

  useEffect(() => {
    for (const f of changes?.files ?? []) {
      if (!open[f.path] || diffs[f.path]) continue;
      setDiffs((d) => ({ ...d, [f.path]: "loading" }));
      void api().agentWorkFileDiff(agent.id, f.path)
        .then((r) => setDiffs((d) => ({ ...d, [f.path]: r })))
        .catch((e) => setDiffs((d) => ({ ...d, [f.path]: { oldText: "", newText: String(e?.message ?? e), binary: false, tooLarge: false } })));
    }
  }, [changes, open, diffs, agent.id]);

  const count = Object.keys(comments).length;
  const totals = useMemo(() => (changes?.files ?? []).reduce((t, f) => ({ added: t.added + f.added, removed: t.removed + f.removed }), { added: 0, removed: 0 }), [changes]);
  const title = roleOf(agent.role)?.title ?? agent.role;
  const working = agent.status === "running" || !!changes?.busy;

  const run = async (fn: () => Promise<void>) => { setBusy(true); try { await fn(); } catch (e: any) { st.toast("error", String(e?.message ?? e)); } finally { setBusy(false); } };
  const report = (r: { ok: boolean; message: string }) => st.toast(r.ok ? "info" : "warn", r.message);

  const sendFixes = () => run(async () => {
    await api().requestAgentFixes(agent.id, Object.values(comments), note);
    setComments({}); setNote(""); setEditing(null);
    st.toast("info", `Sent ${count ? `${count} comment${count === 1 ? "" : "s"}` : "your note"} to ${title}. It fixes them on ${agent.branch}.`);
  });
  const merge = () => run(async () => {
    if (count && !confirm(`You have ${count} unsent comment(s). Merge anyway?`)) return;
    const r = await mergeWithChecks(agent.id, agent.branch ?? "this branch");
    report(r);
    await refresh();
  });
  const discard = () => run(async () => {
    const w = await api().agentWorkState(agent.id);
    const lose = [w.unmerged ? `${w.unmerged} unmerged commit(s)` : "", w.dirty.length ? `${w.dirty.length} uncommitted change(s)` : ""].filter(Boolean).join(" and ");
    if (lose && !confirm(`Discard ${agent.branch}? It has ${lose}; they will be lost.`)) return;
    report(await api().discardAgentWork(agent.id, !!lose));
  });

  const startComment = (path: string, side: DiffSide, line: number) => {
    const k = key(path, side, line);
    setEditing({ k, text: comments[k]?.text ?? "" });
  };
  const saveComment = (path: string, side: DiffSide, line: number, code: string) => {
    if (!editing) return;
    const k = key(path, side, line);
    setComments((c) => {
      const next = { ...c };
      if (editing.text.trim()) next[k] = { path, side, line, code, text: editing.text.trim() }; else delete next[k];
      return next;
    });
    setEditing(null);
  };

  if (error) return <section className="review-main"><div className="review-empty muted"><p>{error}</p><button onClick={() => void refresh()}><RotateCcw size={13} /> Try again</button></div></section>;
  if (!changes) return <section className="review-main"><div className="review-empty muted">Loading changes…</div></section>;

  return (
    <section className="review-main">
      <div className="review-bar">
        <div className="review-bar-info">
          <strong className="row gap-s"><RoleIcon role={agent.role} size={18} /> {title}</strong>
          <code className="small">{changes.branch}</code>
          <span className="muted small">{changes.files.length} file{changes.files.length === 1 ? "" : "s"}</span>
          <DiffStat added={totals.added} removed={totals.removed} />
          {changes.unmerged > 0 && <span className="pill green" title="Commits on the branch your project doesn't have yet">{changes.unmerged} commit{changes.unmerged === 1 ? "" : "s"} to merge</span>}
          {changes.dirty.length > 0 && <span className="pill amber" title="Changes the agent hasn't committed yet. Merge brings in commits only.">{changes.dirty.length} uncommitted</span>}
          {working && <span className="pill">working…</span>}
        </div>
        <div className="row gap-s">
          <button className="ghost icon-only" title="Refresh" onClick={() => void refresh()}><RotateCcw size={14} /></button>
          <button className="ghost small" title="Wrap long lines" onClick={() => setWrap((w) => !w)}>{wrap ? "No wrap" : "Wrap"}</button>
          <button className="ghost small" title="Open the chat the agent works in" onClick={() => agent.chatId && st.openChat(agent.chatId)} disabled={!agent.chatId}><MessageCircle size={14} /> Chat</button>
          <button disabled={busy || (!count && !note.trim())} onClick={() => void sendFixes()} title="Send your comments to the agent; it fixes them in its own copy">
            <Send size={13} /> Ask to fix{count ? ` (${count})` : ""}
          </button>
          <ChecksStatus agentId={agent.id} />
          <button className="primary" disabled={busy || working} onClick={() => void merge()} title={working ? "Wait until the agent finishes" : `Merge ${changes.branch} into your current branch`}><GitMerge size={14} /> Merge</button>
          <button className="danger" disabled={busy || working} onClick={() => void discard()} title={working ? "Wait until the agent finishes" : "Remove the agent's copy and its branch"}><Trash2 size={13} /> Discard</button>
        </div>
      </div>

      <div className="review-note">
        <textarea rows={count || note ? 2 : 1} placeholder="General note for the agent (optional). Click a line number in a diff to comment on that line." value={note}
          onChange={(e) => setNote(e.target.value)} />
      </div>

      {!changes.files.length && <div className="review-empty muted">No changes on this branch yet{working ? ": the agent is still working" : ""}.</div>}
      <div className="review-files">
        {changes.files.map((f) => {
          const d = diffs[f.path];
          const isOpen = !!open[f.path];
          const n = Object.values(comments).filter((c) => c.path === f.path).length;
          return (
            <div key={f.path} className="review-file">
              <button className="review-file-head" onClick={() => setOpen((o) => ({ ...o, [f.path]: !isOpen }))} aria-expanded={isOpen}>
                {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                {f.status === "added" ? <FilePlus2 size={15} className="ic new" /> : f.status === "deleted" ? <FileX2 size={15} className="ic del" /> : <FileCode size={15} className="ic mod" />}
                <span className="review-path">{f.path}</span>
                {!f.committed && <span className="chip" title="Not committed by the agent yet">uncommitted</span>}
                {n > 0 && <span className="chip review-count"><MessageSquarePlus size={11} /> {n}</span>}
                <span className={`chip st-${f.status}`}>{f.status}</span>
                {f.binary ? <span className="muted small">binary</span> : <DiffStat added={f.added} removed={f.removed} />}
              </button>
              {isOpen && (
                <div className="review-diff">
                  {d === undefined || d === "loading" ? <div className="muted small review-loading">Loading…</div>
                    : d.binary ? <div className="muted small review-loading">Binary file: not shown.</div>
                    : d.tooLarge ? <div className="muted small review-loading">File too large to show here.</div>
                    : <DiffView oldText={d.oldText} newText={d.newText} mode="unified" wrap={wrap}
                        onLine={(side, line) => startComment(f.path, side, line)}
                        after={(side, line) => {
                          const k = key(f.path, side, line);
                          const c = comments[k];
                          if (editing?.k === k) {
                            const code = (side === "old" ? d.oldText : d.newText).split("\n")[line - 1] ?? "";
                            return (
                              <div className="review-comment editing">
                                <textarea autoFocus rows={3} placeholder={`What should ${title} change here?`} value={editing.text}
                                  onChange={(e) => setEditing({ k, text: e.target.value })}
                                  onKeyDown={(e) => {
                                    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); saveComment(f.path, side, line, code); }
                                    if (e.key === "Escape") setEditing(null);
                                  }} />
                                <div className="row gap-s">
                                  <button className="primary small" onClick={() => saveComment(f.path, side, line, code)}>{c ? "Update" : "Add comment"}</button>
                                  <button className="ghost small" onClick={() => setEditing(null)}>Cancel</button>
                                  <span className="muted small">Ctrl/⌘+Enter to save</span>
                                </div>
                              </div>
                            );
                          }
                          if (!c) return null;
                          return (
                            <div className="review-comment">
                              <MessageSquarePlus size={13} className="muted" />
                              <span className="review-comment-text">{c.text}</span>
                              <button className="ghost icon-only" title="Edit" onClick={() => startComment(f.path, side, line)}><Pencil size={12} /></button>
                              <button className="ghost icon-only" title="Remove" onClick={() => setComments((all) => { const next = { ...all }; delete next[k]; return next; })}><X size={12} /></button>
                            </div>
                          );
                        }} />}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
