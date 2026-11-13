import { useEffect, useMemo, useState } from "react";
import type { ChatArtifacts } from "@shared/types";
import { unifiedPatch } from "@shared/diff";
import { api, useStore } from "../store";
import { Markdown } from "../components/Markdown";
import { DiffStat, DiffView } from "../components/DiffView";
import { Code2, Columns2, Copy, Download, FileCode, FileDiff, FilePlus2, FileText, FileX2, GitBranch, Maximize2, Package, RotateCcw, Rows2, WrapText, X } from "../components/icons";

type Viewer =
  | { kind: "diff"; title: string; path: string; oldText: string; newText: string; sub?: string }
  | { kind: "text"; title: string; name: string; content: string; markdown?: boolean; sub?: string };

const EXT: Record<string, string> = { ts: "ts", tsx: "tsx", typescript: "ts", js: "js", javascript: "js", python: "py", py: "py", c: "c", cpp: "cpp", "c++": "cpp", h: "h",
  json: "json", yaml: "yaml", yml: "yml", xml: "xml", arxml: "arxml", capl: "can", can: "can", bash: "sh", sh: "sh", powershell: "ps1", ps1: "ps1", sql: "sql",
  markdown: "md", md: "md", html: "html", css: "css", java: "java", cs: "cs", csharp: "cs", rust: "rs", go: "go", dbc: "dbc", ini: "ini", toml: "toml", diff: "patch", patch: "patch" };
const ago = (t: number) => {
  const m = Math.round((Date.now() - t) / 60000);
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : new Date(t).toLocaleDateString();
};
const base = (p: string) => p.split(/[\\/]/).pop() ?? p;

/** Right-hand panel: everything agents produced in this chat — changed files (with diffs), git changes, saved artifacts, code snippets. */
export function ArtifactsPanel({ chatId, onClose }: { chatId: string; onClose: () => void }) {
  const st = useStore();
  const rev = useStore((s) => s.artifactsRev[chatId] ?? 0);
  const messages = st.messages[chatId] ?? [];
  const [tab, setTab] = useState<"changes" | "git" | "artifacts" | "snippets">("changes");
  const [data, setData] = useState<ChatArtifacts | null>(null);
  const [git, setGit] = useState<{ ok: boolean; detail?: string; files: { path: string; status: string }[] } | null>(null);
  const [viewer, setViewer] = useState<Viewer | null>(null);

  useEffect(() => { void api().chatArtifacts(chatId).then(setData); }, [chatId, rev]);
  useEffect(() => { if (tab === "git") void api().gitChanges(chatId).then(setGit); }, [tab, chatId, rev]);

  const snippets = useMemo(() => {
    const out: { name: string; lang: string; code: string; role: string | null; at: number }[] = [];
    for (const m of messages) {
      if (m.author !== "agent") continue;
      for (const b of m.content.matchAll(/```([\w+#.-]*)[^\n]*\n([\s\S]*?)```/g)) {
        const lang = (b[1] || "text").toLowerCase();
        if (["ishikawa", "mermaid", "result"].includes(lang)) continue;
        const code = b[2]!.replace(/\n$/, "");
        if (code.split("\n").length < 2 && code.length < 60) continue;
        const named = /^(?:\/\/|#|--|;|\/\*)\s*(?:file:\s*)?([\w./\\-]+\.\w{1,6})\b/.exec(code)?.[1];
        out.push({ name: named ? base(named) : `snippet-${out.length + 1}.${EXT[lang] ?? "txt"}`, lang, code, role: m.role, at: m.createdAt });
      }
    }
    return out.reverse();
  }, [messages]);

  const openChange = async (id: string) => {
    const c = await api().getFileChange(id);
    if (c) setViewer({ kind: "diff", title: c.path, path: c.path, oldText: c.oldText ?? "", newText: c.newText ?? "", sub: `${c.role ?? "agent"} · ${ago(c.createdAt)}` });
  };
  const openGit = async (path: string, status: string) => {
    const d = await api().gitFileDiff(chatId, path);
    setViewer({ kind: "diff", title: path, path, oldText: d.oldText, newText: d.newText, sub: `git · ${status} (HEAD → working copy)` });
  };
  const openArtifact = async (id: string) => {
    const a = await api().getArtifact(id);
    if (a) setViewer({ kind: "text", title: a.title, name: `${a.title.replace(/[^\w.-]+/g, "_").slice(0, 60) || a.id}.${/md|report|analysis/i.test(a.kind) ? "md" : "txt"}`, content: a.content, markdown: /md|report|analysis|summary/i.test(a.kind), sub: `${a.kind} · ${(a.bytes / 1024).toFixed(1)} KB` });
  };
  const allPatch = async () => {
    const parts: string[] = [];
    for (const c of [...(data?.changes ?? [])].reverse()) {
      const full = await api().getFileChange(c.id);
      if (full) parts.push(unifiedPatch(c.path.replace(/\\/g, "/"), full.oldText ?? "", full.newText ?? ""));
    }
    const p = await api().saveTextFile(`chat-changes-${new Date().toISOString().slice(0, 10)}.patch`, parts.join(""));
    if (p) st.toast("info", `Saved ${p}`);
  };

  const count = { changes: data?.changes.length ?? 0, artifacts: data?.artifacts.length ?? 0, snippets: snippets.length };
  return (
    <aside className="thread artifacts-panel">
      <header className="thread-header">
        <strong className="row gap-s"><Package size={16} /> Artifacts</strong>
        <button className="ghost icon-only" title="Close" onClick={onClose}><X size={16} /></button>
      </header>
      <div className="seg art-tabs">
        <button className={tab === "changes" ? "on" : ""} onClick={() => setTab("changes")}><FileDiff size={13} /> Changes {count.changes > 0 && <b>{count.changes}</b>}</button>
        <button className={tab === "git" ? "on" : ""} onClick={() => setTab("git")}><GitBranch size={13} /> Git</button>
        <button className={tab === "artifacts" ? "on" : ""} onClick={() => setTab("artifacts")}><FileText size={13} /> Saved {count.artifacts > 0 && <b>{count.artifacts}</b>}</button>
        <button className={tab === "snippets" ? "on" : ""} onClick={() => setTab("snippets")}><Code2 size={13} /> Code {count.snippets > 0 && <b>{count.snippets}</b>}</button>
      </div>
      <div className="art-list">
        {tab === "changes" && <>
          {count.changes === 0 && <div className="muted small art-empty">Files the agents create or edit in this chat appear here with a diff.</div>}
          {count.changes > 0 && <button className="ghost small art-all" onClick={allPatch}><Download size={13} /> Download all as .patch</button>}
          {data?.changes.map((c) => (
            <button key={c.id} className="art-item" onClick={() => openChange(c.id)}>
              {c.isNew ? <FilePlus2 size={16} className="ic new" /> : c.deleted ? <FileX2 size={16} className="ic del" /> : <FileCode size={16} className="ic mod" />}
              <span className="art-main"><span className="art-name">{base(c.path)}</span><span className="muted small art-path">{c.path}</span></span>
              <span className="art-meta"><DiffStat added={c.added} removed={c.removed} /><span className="muted small">{c.role ?? ""} · {ago(c.createdAt)}</span></span>
            </button>
          ))}
        </>}
        {tab === "git" && <>
          <div className="row between small muted art-all"><span>{data?.project ?? "No project folder"}</span><button className="ghost icon-only" title="Refresh" onClick={() => api().gitChanges(chatId).then(setGit)}><RotateCcw size={13} /></button></div>
          {git && !git.ok && <div className="muted small art-empty">{git.detail}</div>}
          {git?.ok && git.files.length === 0 && <div className="muted small art-empty">Working tree clean — no uncommitted changes.</div>}
          {git?.files.map((f) => (
            <button key={f.path} className="art-item" onClick={() => openGit(f.path, f.status)}>
              {f.status === "new" || f.status === "added" ? <FilePlus2 size={16} className="ic new" /> : f.status === "deleted" ? <FileX2 size={16} className="ic del" /> : <FileCode size={16} className="ic mod" />}
              <span className="art-main"><span className="art-name">{base(f.path)}</span><span className="muted small art-path">{f.path}</span></span>
              <span className={`chip st-${f.status}`}>{f.status}</span>
            </button>
          ))}
        </>}
        {tab === "artifacts" && <>
          {count.artifacts === 0 && <div className="muted small art-empty">Reports, logs and analyses that agents save (save_artifact) appear here.</div>}
          {data?.artifacts.map((a) => (
            <button key={a.id} className="art-item" onClick={() => openArtifact(a.id)}>
              <FileText size={16} className="ic" />
              <span className="art-main"><span className="art-name">{a.title}</span><span className="muted small">{a.kind} · {(a.bytes / 1024).toFixed(1)} KB</span></span>
              <span className="muted small">{a.role ?? ""} · {ago(a.createdAt)}</span>
            </button>
          ))}
        </>}
        {tab === "snippets" && <>
          {count.snippets === 0 && <div className="muted small art-empty">Code blocks from agent replies appear here, ready to download.</div>}
          {snippets.map((s, i) => (
            <div key={i} className="art-item snippet">
              <button className="art-open" onClick={() => setViewer({ kind: "text", title: s.name, name: s.name, content: s.code, sub: `${s.lang} · ${s.code.split("\n").length} lines` })}>
                <Code2 size={16} className="ic" />
                <span className="art-main"><span className="art-name">{s.name}</span><span className="muted small">{s.lang} · {s.code.split("\n").length} lines · {s.role ?? ""}</span></span>
              </button>
              <button className="ghost icon-only" title="Download" onClick={async () => { const p = await api().saveTextFile(s.name, s.code); if (p) st.toast("info", `Saved ${p}`); }}><Download size={14} /></button>
            </div>
          ))}
        </>}
      </div>
      {viewer && <ViewerModal v={viewer} onClose={() => setViewer(null)} />}
    </aside>
  );
}

function ViewerModal({ v, onClose }: { v: Viewer; onClose: () => void }) {
  const st = useStore();
  const [mode, setMode] = useState<"split" | "unified">(() => { try { return (localStorage.getItem("diffMode") as "split" | "unified") || "split"; } catch { return "split"; } });
  const [wrap, setWrap] = useState(false);
  const [full, setFull] = useState(false);
  const setM = (m: "split" | "unified") => { setMode(m); try { localStorage.setItem("diffMode", m); } catch { /* ignore */ } };
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  const save = async (name: string, content: string) => { const p = await api().saveTextFile(name, content); if (p) st.toast("info", `Saved ${p}`); };
  return (
    <div className="modal-back viewer-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="viewer">
        <div className="viewer-head">
          <div className="grow"><strong>{v.title}</strong>{v.sub && <div className="muted small">{v.sub}</div>}</div>
          {v.kind === "diff" && <>
            <div className="seg">
              <button className={mode === "split" ? "on" : ""} onClick={() => setM("split")} title="Side by side"><Columns2 size={14} /></button>
              <button className={mode === "unified" ? "on" : ""} onClick={() => setM("unified")} title="Unified"><Rows2 size={14} /></button>
            </div>
            <button className={`ghost icon-only ${wrap ? "on" : ""}`} title="Wrap long lines" onClick={() => setWrap(!wrap)}><WrapText size={15} /></button>
            <button className={`ghost icon-only ${full ? "on" : ""}`} title="Show the whole file" onClick={() => setFull(!full)}><Maximize2 size={15} /></button>
            <button className="ghost small" onClick={() => { void navigator.clipboard.writeText(v.newText); st.toast("info", "New version copied"); }}><Copy size={14} /> Copy</button>
            <button className="ghost small" onClick={() => save(`${base(v.path)}.patch`, unifiedPatch(v.path.replace(/\\/g, "/"), v.oldText, v.newText))}><FileDiff size={14} /> Patch</button>
            <button className="primary small" onClick={() => save(base(v.path), v.newText)}><Download size={14} /> Download file</button>
          </>}
          {v.kind === "text" && <>
            <button className="ghost small" onClick={() => { void navigator.clipboard.writeText(v.content); st.toast("info", "Copied"); }}><Copy size={14} /> Copy</button>
            <button className="primary small" onClick={() => save(v.name, v.content)}><Download size={14} /> Download</button>
          </>}
          <button className="ghost icon-only" onClick={onClose} title="Close (Esc)"><X size={18} /></button>
        </div>
        <div className="viewer-body">
          {v.kind === "diff" ? <DiffView oldText={v.oldText} newText={v.newText} mode={mode} wrap={wrap} full={full} />
            : v.markdown ? <div className="viewer-md"><Markdown text={v.content} /></div>
            : <pre className="viewer-code">{v.content}</pre>}
        </div>
      </div>
    </div>
  );
}
