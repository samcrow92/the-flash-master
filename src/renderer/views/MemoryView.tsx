import { useEffect, useMemo, useState } from "react";
import { ArrowUpRight, BookOpen, Brain, FolderOpen, Pin, PinOff, Plus, RefreshCw, Search, Sparkles, Trash2 } from "../components/icons";
import { openMenu, type MenuItem } from "../components/ContextMenu";
import type { KnowledgeStatus, Memory, MemoryKind, MemoryScope } from "@shared/types";
import { MEMORY_KINDS } from "@shared/types";
import { api, ago, roleOf, useStore } from "../store";

export const SCOPE_TITLE: Record<MemoryScope, string> = { user: "About you", project: "Shared by agents", session: "Short-term" };
const SCOPE_HINT: Record<MemoryScope, string> = {
  user: "Global memory every agent sees, in every project: your preferences and conventions.",
  project: "Shared between the coordinator and all specialists of a project: decisions, facts, procedures.",
  session: "Notes of one chat. They expire unless promoted to a long-term scope.",
};
const SCOPES: MemoryScope[] = ["user", "project", "session"];

/** Memory page: view, search, edit, pin, promote and delete what agents remember. */
export function MemoryView() {
  const st = useStore();
  const rev = useStore((s) => s.memoryRev);
  const [scope, setScope] = useState<MemoryScope | "" | "kb">("");
  const [project, setProject] = useState<string>(st.currentProjectId ?? "");
  const [q, setQ] = useState("");
  const [items, setItems] = useState<Memory[]>([]);
  const [editing, setEditing] = useState<Partial<Memory> | null>(null);

  useEffect(() => {
    let live = true;
    const t = setTimeout(() => {
      const projectId = project === "" ? undefined : project === "none" ? null : project;
      void api().listMemories({ scope: scope === "kb" ? "project" : scope || undefined, projectId, query: q })
        .then((m) => (scope === "kb" ? m.filter((x) => x.kbSlug) : m)).then((m) => { if (live) setItems(m); }).catch(() => { if (live) setItems([]); });
    }, q ? 160 : 0);
    return () => { live = false; clearTimeout(t); };
  }, [scope, project, q, rev]);

  const counts = useMemo(() => SCOPES.reduce((o, s) => ({ ...o, [s]: items.filter((m) => m.scope === s).length }), {} as Record<MemoryScope, number>), [items]);
  const projectName = (id: string | null) => (id === null ? "Master chat" : st.projects.find((p) => p.id === id)?.name ?? "Removed project");
  const failed = (e: any) => st.toast("warn", String(e?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ""));
  const remove = async (m: Memory) => { try { await api().deleteMemory(m.id); } catch (e) { failed(e); } };
  const pin = async (m: Memory) => { try { await api().saveMemory({ id: m.id, content: m.content, pinned: !m.pinned }); } catch (e) { failed(e); } };
  const promote = async (m: Memory, to: "project" | "user") => {
    try { await api().promoteMemory(m.id, to); st.toast("info", `Kept for good: ${SCOPE_TITLE[to]}`); } catch (e) { failed(e); }
  };
  const menu = (m: Memory): MenuItem[] => [
    { label: "Edit…", icon: <Brain size={15} />, onClick: () => setEditing(m) },
    { label: m.pinned ? "Unpin" : "Pin (always shown to agents)", icon: m.pinned ? <PinOff size={15} /> : <Pin size={15} />, onClick: () => void pin(m) },
    ...(m.scope === "session" ? [{ label: "Keep for this project", icon: <ArrowUpRight size={15} />, onClick: () => void promote(m, "project") }] : []),
    ...(m.scope !== "user" && !m.kbSlug ? [{ label: "Keep for every project", icon: <ArrowUpRight size={15} />, onClick: () => void promote(m, "user") }] : []),
    { label: "", separator: true },
    { label: "Delete", icon: <Trash2 size={15} />, danger: true, hint: "Del", onClick: () => void remove(m) },
  ];

  return (
    <div className="page memory-page">
      <header className="page-header">
        <h2><Brain size={20} className="h-icon" /> Memory</h2>
        <div className="row gap">
          <label className="memory-search"><Search size={14} /><input placeholder="Search memories…" value={q} onChange={(e) => setQ(e.target.value)} /></label>
          <select value={project} onChange={(e) => setProject(e.target.value)}>
            <option value="">All projects</option>
            <option value="none">Master chat</option>
            {st.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <button className="primary" onClick={() => setEditing({ scope: "user", kind: "fact", importance: 3, content: "", tags: [], projectId: project && project !== "none" ? project : null })}>
            <Plus size={15} /> New memory
          </button>
        </div>
      </header>
      {project && project !== "none" && st.projects.some((p) => p.id === project) && <KnowledgePanel projectId={project} rev={rev} onError={failed} onShow={() => setScope("kb")} />}
      <div className="seg memory-scopes">
        <button className={scope === "" ? "on" : ""} onClick={() => setScope("")}>All</button>
        {SCOPES.map((s) => <button key={s} className={scope === s ? "on" : ""} title={SCOPE_HINT[s]} onClick={() => setScope(s)}>
          {SCOPE_TITLE[s]}{scope === "" && counts[s] ? <span className="muted"> {counts[s]}</span> : null}
        </button>)}
        <button className={scope === "kb" ? "on" : ""} title={KB_HINT} onClick={() => setScope("kb")}>Knowledge base</button>
      </div>
      {scope && <div className="muted small">{scope === "kb" ? KB_HINT : SCOPE_HINT[scope]}</div>}
      <div className="memory-list">
        {items.length === 0 && <div className="empty-hint">{q ? "No memory matches." : "Nothing remembered yet. Agents save memories with memory_save, or add one yourself."}</div>}
        {items.map((m) => (
          <div key={m.id} className={`memory-card scope-${m.scope}`} tabIndex={0} onClick={() => setEditing(m)} onContextMenu={(e) => openMenu(e, menu(m))}
            onKeyDown={(e) => {
              if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); void remove(m); }
              else if (e.key === "Enter") setEditing(m);
            }}>
            <div className={`memory-text${m.kbSlug ? " kb" : ""}`}>{m.pinned && <Pin size={12} className="memory-pin" />}{m.kbSlug ? <KbPreview content={m.content} /> : m.content}</div>
            <div className="memory-meta">
              {m.kbSlug ? <span className="pill kb-pill" title={`.flashmaster/knowledge/${m.kbSlug}.md`}><BookOpen size={11} /> {m.kbSlug}</span> : <span className="pill">{SCOPE_TITLE[m.scope]}</span>}
              {m.scope !== "user" && <span className="muted">{projectName(m.projectId)}</span>}
              {m.kind !== "fact" && <span className="muted">{m.kind}</span>}
              {m.tags.map((t) => <span key={t} className="memory-tag">#{t}</span>)}
              <span className="memory-dots" title={`Importance ${m.importance} of 5`}>{"●".repeat(m.importance)}<span className="off">{"●".repeat(5 - m.importance)}</span></span>
              <span className="grow" />
              {m.sourceRole && <span className="muted">by {roleOf(m.sourceRole)?.title ?? m.sourceRole}</span>}
              {m.expiresAt && <span className="muted" title={new Date(m.expiresAt).toLocaleString()}>expires {inDays(m.expiresAt)}</span>}
              <span className="muted">{ago(m.updatedAt)}</span>
              <span className="memory-actions" onClick={(e) => e.stopPropagation()}>
                {m.scope === "session" && <button className="icon-btn" title="Keep for this project" onClick={() => void promote(m, "project")}><ArrowUpRight size={14} /></button>}
                <button className="icon-btn" title={m.pinned ? "Unpin" : "Pin: always shown to agents"} onClick={() => void pin(m)}>{m.pinned ? <PinOff size={14} /> : <Pin size={14} />}</button>
                <button className="icon-btn" title="Delete" onClick={() => void remove(m)}><Trash2 size={14} /></button>
              </span>
            </div>
          </div>
        ))}
      </div>
      {editing && <MemoryEditor memory={editing} onClose={() => setEditing(null)} onError={failed} />}
    </div>
  );
}

const KB_HINT = "The project's knowledge base: documents agents write and the team reviews in git (.flashmaster/knowledge). Edits here go to the repo folder on the next sync.";
const clipText = (s: string, n: number) => (s.length > n ? `${s.slice(0, n).trimEnd()}…` : s);
const short = (c: string) => c.slice(0, 7);

/** A knowledge entry on a card: its "# Title" as a title, then the start of the text. */
function KbPreview({ content }: { content: string }) {
  const m = /^#\s+(.+)\n*/.exec(content);
  return <>{m && <div className="kb-card-title">{m[1]}</div>}{clipText(m ? content.slice(m[0].length) : content, 320)}</>;
}

/** Knowledge base strip of the Memory page: build / update it with Flash Master, sync it with the repo, settle conflicts. */
function KnowledgePanel({ projectId, rev, onError, onShow }: { projectId: string; rev: number; onError: (e: unknown) => void; onShow: () => void }) {
  const st = useStore();
  const [status, setStatus] = useState<KnowledgeStatus | null>(null);
  const [busy, setBusy] = useState<"" | "sync" | "build">("");
  const reload = () => api().knowledgeStatus(projectId).then(setStatus).catch(() => setStatus(null));
  useEffect(() => { void reload(); }, [projectId, rev]);
  const sync = async () => {
    setBusy("sync");
    try {
      const r = await api().syncKnowledge(projectId);
      const moved = r.imported.length + r.exported.length + r.deletedLocal.length + r.deletedRepo.length;
      st.toast(r.conflicts.length ? "warn" : "info", r.conflicts.length ? `${r.conflicts.length} knowledge entr${r.conflicts.length === 1 ? "y needs" : "ies need"} you` : moved ? `Knowledge base synced: ${moved} change${moved === 1 ? "" : "s"}` : "Knowledge base already in sync");
      await reload();
    } catch (e) { onError(e); } finally { setBusy(""); }
  };
  const build = async () => {
    setBusy("build");
    try {
      const chat = await api().buildKnowledge(projectId);
      st.upsertChat(chat);
      await st.openChat(chat.id);
    } catch (e) { onError(e); } finally { setBusy(""); }
  };
  const resolve = async (slug: string, keep: "repo" | "local") => {
    try { await api().resolveKnowledgeConflict(projectId, slug, keep); await reload(); } catch (e) { onError(e); }
  };
  const s = status;
  const fresh = !s?.entries;
  const state = !s ? "" : !s.repo ? "not a git repository" : !s.checkpoint ? "no checkpoint yet"
    : s.behind === null ? `checkpoint ${short(s.checkpoint.commit)} not in this clone` : s.behind === 0 ? `up to date with ${short(s.checkpoint.commit)}`
    : `${s.behind} commit${s.behind === 1 ? "" : "s"} since ${short(s.checkpoint.commit)}`;
  return (
    <div className="kb-panel">
      <div className="kb-main">
        <BookOpen size={18} className="kb-icon" />
        <div className="kb-text">
          <div className="kb-title">Knowledge base <button className="link-btn muted" title="Show the entries" onClick={onShow}>{s ? `${s.entries} entr${s.entries === 1 ? "y" : "ies"}` : "…"}</button></div>
          <div className="muted small">
            {state}{s?.uncommitted ? ` · ${s.uncommitted} file${s.uncommitted === 1 ? "" : "s"} to commit` : ""}{s?.lastSync ? ` · synced ${ago(s.lastSync.at)}` : ""}
          </div>
        </div>
        <span className="grow" />
        <button className="icon-btn" title={s ? `Open ${s.folder}` : "Open the folder"} onClick={() => void api().openKnowledgeFolder(projectId).catch(onError)}><FolderOpen size={15} /></button>
        <button title="Sync with .flashmaster/knowledge in the repo: take teammates' changes, write yours" disabled={!!busy} onClick={() => void sync()}>
          <RefreshCw size={14} className={busy === "sync" ? "spin" : ""} /> Sync
        </button>
        <button className="primary" disabled={!!busy} title={fresh ? "Flash Master reads the project and writes the knowledge base" : "Flash Master updates the entries the commits since the checkpoint affect"} onClick={() => void build()}>
          <Sparkles size={14} /> {fresh ? "Build" : "Update"}
        </button>
      </div>
      {!!s?.conflicts.length && <div className="kb-conflicts">
        {s.conflicts.map((c) => (
          <div key={c.slug} className="kb-conflict">
            <span className="kb-slug">{c.slug}</span><span className="muted small">{c.detail ?? c.reason}</span><span className="grow" />
            {c.reason !== "merge-markers" && c.reason !== "invalid" && <button className="ghost" onClick={() => void resolve(c.slug, "repo")}>Use repo version</button>}
            <button className="ghost" onClick={() => void resolve(c.slug, "local")}>Keep mine</button>
          </div>
        ))}
      </div>}
    </div>
  );
}

function inDays(t: number): string {
  const d = Math.ceil((t - Date.now()) / 86_400_000);
  return d <= 0 ? "today" : d === 1 ? "tomorrow" : `in ${d} days`;
}

function MemoryEditor({ memory, onClose, onError }: { memory: Partial<Memory>; onClose: () => void; onError: (e: unknown) => void }) {
  const st = useStore();
  const [m, setM] = useState<Partial<Memory>>(memory);
  const isNew = m.id == null;
  const save = async () => {
    if (!m.content?.trim()) return;
    try {
      await api().saveMemory({ id: m.id, content: m.content, scope: m.scope, projectId: m.projectId ?? null, kind: m.kind, tags: m.tags, importance: m.importance, pinned: m.pinned });
      onClose();
    } catch (e) { onError(e); }
  };
  // Short-term memories belong to a chat; from here a memory can only move up (session → project → user).
  const scopes: MemoryScope[] = isNew ? ["user", "project"] : memory.scope === "session" ? ["session", "project", "user"] : memory.scope === "project" ? ["project", "user"] : ["user"];
  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) void save(); if (e.key === "Escape") onClose(); }}>
        <h3>{isNew ? "New memory" : "Memory"}</h3>
        <label className="field"><span>What to remember</span>
          <textarea rows={m.kbSlug ? 16 : 4} autoFocus value={m.content ?? ""} placeholder="One self-contained fact, e.g. “Mari prefers minimal glass UI.”" onChange={(e) => setM({ ...m, content: e.target.value })} />
        </label>
        <div className="grid3">
          <label className="field"><span>Scope</span>
            <select value={m.scope} onChange={(e) => setM({ ...m, scope: e.target.value as MemoryScope })}>{scopes.map((s) => <option key={s} value={s}>{SCOPE_TITLE[s]}</option>)}</select>
          </label>
          {isNew && m.scope === "project" && <label className="field"><span>Project</span>
            <select value={m.projectId ?? ""} onChange={(e) => setM({ ...m, projectId: e.target.value || null })}>
              <option value="">Master chat</option>{st.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>}
          <label className="field"><span>Kind</span>
            <select value={m.kind} onChange={(e) => setM({ ...m, kind: e.target.value as MemoryKind })}>{MEMORY_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}</select>
          </label>
          <label className="field"><span>Importance</span>
            <select value={m.importance} onChange={(e) => setM({ ...m, importance: Number(e.target.value) })}>
              {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}{n === 1 ? " · trivia" : n === 5 ? " · critical" : ""}</option>)}
            </select>
          </label>
          <label className="field"><span>Tags</span>
            <input value={(m.tags ?? []).join(" ")} placeholder="ui windows" onChange={(e) => setM({ ...m, tags: e.target.value.split(/[\s,]+/).filter(Boolean) })} />
          </label>
        </div>
        <label className="row gap-s"><input type="checkbox" checked={!!m.pinned} onChange={(e) => setM({ ...m, pinned: e.target.checked })} /> Pin: always show to agents</label>
        <div className="row between">
          {isNew ? <span /> : <button className="danger ghost" onClick={async () => { try { await api().deleteMemory(m.id!); onClose(); } catch (e) { onError(e); } }}>Delete</button>}
          <div className="row gap">
            <button onClick={onClose}>Cancel</button>
            <button className="primary" disabled={!m.content?.trim()} onClick={save}>Save</button>
          </div>
        </div>
      </div>
    </div>
  );
}
