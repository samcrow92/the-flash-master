import { Fragment, useEffect, useMemo, useState, type ReactNode } from "react";
import type { Requirement, RmHit, RmModule, RmModuleData, RmProject } from "@shared/types";
import { api, useStore } from "../store";
import { ClipboardList, Copy, ExternalLink, ListTree, Loader2, RotateCcw, Search, Sparkles, SquareKanban, X } from "../components/icons";

const ago = (t: number) => {
  const m = Math.round((Date.now() - t) / 60000);
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
};

/** DOORS Next requirements: pick a project and module, read it in document order, search it, send selections to an agent. */
export function RequirementsView({ tabs }: { tabs: ReactNode }) {
  const st = useStore();
  const cfg = st.settings?.jazz;
  const enabled = !!cfg?.enabled && !!cfg.serverUrl && !!cfg.rm?.enabled;
  const [projects, setProjects] = useState<RmProject[]>([]);
  const [project, setProject] = useState<string>("");
  const [modules, setModules] = useState<RmModule[]>([]);
  const [cached, setCached] = useState<{ module: RmModule; fetchedAt: number; count: number }[]>([]);
  const [filter, setFilter] = useState("");
  const [data, setData] = useState<RmModuleData | null>(null);
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<RmHit[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [detail, setDetail] = useState<Requirement | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [diag, setDiag] = useState<string[] | null>(null);

  const guard = async <T,>(label: string, fn: () => Promise<T>): Promise<T | undefined> => {
    setLoading(label); setError(null);
    try { return await fn(); } catch (e: any) { setError(String(e?.message ?? e)); return undefined; } finally { setLoading(null); }
  };

  useEffect(() => {
    if (!enabled) return;
    void api().rmCached().then(setCached).catch(() => undefined);
    void guard("Loading projects…", async () => {
      const all = await api().rmProjects();
      const wanted = cfg!.rm.projects.length ? all.filter((p) => cfg!.rm.projects.includes(p.title)) : all;
      setProjects(wanted.length ? wanted : all);
      const first = (wanted.length ? wanted : all)[0]?.id ?? "";
      setProject((p) => p || first);
    });
  }, [enabled]);
  useEffect(() => {
    if (!project) return;
    void guard("Loading modules…", async () => {
      const m = await api().rmModules(project);
      setModules(m);
      setDiag(m.length ? null : await api().rmDiagnostics());
    });
  }, [project]);

  const openModule = async (ref: string, refresh = false, config?: string) => {
    const d = await guard(refresh ? "Refreshing module from DOORS Next…" : "Loading module…", () => api().rmModule(ref, refresh, config));
    if (d) {
      setData(d); setHits(null); setSelected(new Set()); setCollapsed(new Set());
      void api().rmCached().then(setCached);
    }
  };
  /** Open a module from the list (uses its own configuration). */
  const openModuleObj = (m: RmModule) => openModule(m.identifier || m.uuid, false, m.config);
  const search = async () => {
    if (!query.trim()) { setHits(null); return; }
    const r = await guard("Searching…", () => api().rmSearch(query, data ? [data.module.uri] : undefined, 40));
    if (r) setHits(r);
  };

  const reqById = useMemo(() => new Map((data?.requirements ?? []).map((r) => [r.id, r])), [data]);
  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  // Requirements hidden under collapsed headings
  const visible = useMemo(() => {
    const out: Requirement[] = [];
    let hideBelow: number | null = null;
    for (const r of data?.requirements ?? []) {
      if (hideBelow !== null && (!r.heading || r.depth > hideBelow)) continue;
      hideBelow = null;
      out.push(r);
      if (r.heading && collapsed.has(r.id)) hideBelow = r.depth || 1;
    }
    return out;
  }, [data, collapsed]);

  if (!enabled) {
    return (
      <div className="page">
        <header className="page-header"><h2><ClipboardList size={20} className="h-icon" /> IBM Jazz</h2>{tabs}</header>
        <div className="empty">
          <ListTree size={36} className="muted" />
          <div>Connect IBM DOORS Next (Jazz Requirements Management) to browse requirement modules and use them in analyses.</div>
          <div><button className="primary" onClick={() => st.setView({ kind: "settings", tab: "integrations" })}>Set up requirements</button></div>
        </div>
      </div>
    );
  }

  const mods = modules.filter((m) => !filter || `${m.identifier} ${m.title} ${m.component ?? ""}`.toLowerCase().includes(filter.toLowerCase()))
    .sort((a, b) => (a.component ?? "").localeCompare(b.component ?? "") || a.title.localeCompare(b.title));
  const isCached = (m: RmModule) => cached.find((c) => c.module.uri === m.uri);

  return (
    <div className="page jazz-page rm-page">
      <header className="page-header">
        <h2><ClipboardList size={20} className="h-icon" /> IBM Jazz</h2>
        {tabs}
        <span className="grow" />
        {loading && <span className="muted small row gap-s"><Loader2 size={14} className="spin" /> {loading}</span>}
      </header>
      {error && <div className="warn-note row gap between"><span>{error}</span>
        {/sign-in|Bearer|401/i.test(error) && <button className="primary" onClick={async () => { const r = await api().jazzSignIn(); st.toast(r.ok ? "info" : "error", r.detail); }}>Sign in to Jazz</button>}</div>}

      <div className="rm-layout">
        <aside className="rm-modules panel">
          <select value={project} onChange={(e) => setProject(e.target.value)} title="Requirements project">
            {projects.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
          </select>
          <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={`Filter ${modules.length} modules…`} />
          <div className="rm-module-list">
            {mods.map((m, i) => {
              const c = isCached(m);
              const group = m.component ?? "";
              const showGroup = group && (i === 0 || mods[i - 1]!.component !== group);
              return (
                <Fragment key={`${m.uri}|${m.config ?? ""}`}>
                {showGroup && <div className="rm-group" title={m.config}>{group}</div>}
                <button className={`rm-module ${data?.module.uri === m.uri && data?.module.config === m.config ? "sel" : ""}`} onClick={() => openModuleObj(m)} title={`${m.uri}${m.config ? `\nconfiguration: ${m.config}` : ""}`}>
                  <ListTree size={14} />
                  <span className="grow">{m.title}<span className="muted small"> {m.identifier}</span></span>
                  {c && <span className="chip" title={`Cached ${ago(c.fetchedAt)}`}>{c.count}</span>}
                </button>
                </Fragment>
              );
            })}
            {!mods.length && !loading && <div className="muted small">No modules.</div>}
            {!modules.length && diag && !loading && (
              <div className="rm-diag">
                <div className="small"><b>Nothing found — what was tried:</b></div>
                <pre>{diag.join("\n")}</pre>
                <div className="row gap wrap">
                  <button className="ghost small" onClick={() => { void navigator.clipboard.writeText(diag.join("\n")); st.toast("info", "Diagnostics copied"); }}><Copy size={13} /> Copy</button>
                  <button className="ghost small" onClick={() => void guard("Loading modules…", async () => { const m = await api().rmModules(project, true); setModules(m); setDiag(m.length ? null : await api().rmDiagnostics()); })}><RotateCcw size={13} /> Retry</button>
                  <button className="link small" onClick={() => st.setView({ kind: "settings", tab: "integrations" })}>Settings</button>
                </div>
                <div className="muted small">Tip: for projects with streams, paste a link to the component or a module (or set Configuration) in Settings.</div>
              </div>
            )}
          </div>
        </aside>

        <section className="rm-doc panel">
          {!data ? <div className="muted rm-hint">Open a module to read and search its requirements. Agents use the same data through <code>rm_search</code> / <code>rm_get</code>.</div> : <>
            <div className="row gap rm-toolbar">
              <div className="grow">
                <strong>{data.module.title}</strong> <span className="muted small">{data.module.component ? `${data.module.component} · ` : ""}#{data.module.identifier} · {data.requirements.filter((r) => !r.heading).length} requirements · fetched {ago(data.fetchedAt)}</span>
              </div>
              <button className="ghost small" onClick={() => openModule(data.module.identifier || data.module.uuid, true, data.module.config)} title="Fetch again from DOORS Next"><RotateCcw size={14} /> Refresh</button>
            </div>
            <div className="row gap">
              <div className="search-box grow"><Search size={15} /><input value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === "Enter" && search()}
                placeholder="Find relevant requirements: words or ids (ranked, like the agents' rm_search)" /></div>
              {hits && <button className="ghost small" onClick={() => { setHits(null); setQuery(""); }}><X size={14} /> Clear</button>}
            </div>
            <div className="rm-list">
              {hits ? (
                hits.length === 0 ? <div className="muted">No matches.</div> : hits.map((h) => {
                  const r = reqById.get(h.id);
                  return <ReqRow key={h.id} r={r ?? { id: h.id, uri: "", title: "", text: h.text, type: h.type, heading: false, section: h.section, depth: 2, attrs: {}, links: [] }}
                    score={h.score} checked={selected.has(h.id)} onCheck={() => toggle(h.id)} onOpen={() => r && setDetail(r)} />;
                })
              ) : visible.map((r) => r.heading ? (
                <button key={r.uri || r.id} className={`rm-heading d${Math.min(r.depth || 1, 4)}`} onClick={() => setCollapsed((c) => { const n = new Set(c); if (n.has(r.id)) n.delete(r.id); else n.add(r.id); return n; })}>
                  <span className={`chev ${collapsed.has(r.id) ? "" : "open"}`}>▸</span> <span className="muted">{r.section}</span> {r.title || r.text}
                </button>
              ) : <ReqRow key={r.uri || r.id} r={r} checked={selected.has(r.id)} onCheck={() => toggle(r.id)} onOpen={() => setDetail(r)} />)}
            </div>
          </>}
        </section>

        {detail && <ReqDetail r={detail} onClose={() => setDetail(null)} />}
      </div>

      {data && <ActionBar data={data} selected={[...selected]} clear={() => setSelected(new Set())} />}
    </div>
  );
}

function ReqRow({ r, checked, onCheck, onOpen, score }: { r: Requirement; checked: boolean; onCheck: () => void; onOpen: () => void; score?: number }) {
  return (
    <div className={`rm-req ${checked ? "checked" : ""}`} style={{ paddingLeft: 8 + Math.max(0, (r.depth || 2) - 2) * 14 }}>
      <input type="checkbox" checked={checked} onChange={onCheck} title="Select for analysis" />
      <button className="rm-req-body" onClick={onOpen}>
        <div className="row gap-s"><span className="chip id-chip">{r.id}</span>{r.section && <span className="muted small">{r.section}</span>}<span className="muted small">{r.type}</span>
          {score !== undefined && <span className="muted small rm-score" title="Relevance">{score}</span>}</div>
        <div className="rm-text">{r.text}</div>
      </button>
    </div>
  );
}

function ReqDetail({ r, onClose }: { r: Requirement; onClose: () => void }) {
  const st = useStore();
  return (
    <aside className="rm-detail panel">
      <div className="row between"><strong><span className="chip id-chip">{r.id}</span> {r.type}</strong><button className="ghost icon-only" onClick={onClose}><X size={16} /></button></div>
      {r.section && <div className="muted small">Section {r.section}</div>}
      <p className="pre">{r.text}</p>
      {Object.keys(r.attrs).length > 0 && <table className="kv"><tbody>{Object.entries(r.attrs).map(([k, v]) => <tr key={k}><td className="muted">{k}</td><td>{v}</td></tr>)}</tbody></table>}
      {r.links.length > 0 && <><h4>Links</h4><ul className="rm-links">{r.links.map((l, i) => <li key={i}><span className="muted">{l.type}</span> {l.title ?? l.target}</li>)}</ul></>}
      <div className="row gap wrap">
        {r.uri && <a href={r.uri} target="_blank" rel="noreferrer" className="doc-link">Open in DOORS Next <ExternalLink size={13} /></a>}
        <button className="ghost small" onClick={() => { void navigator.clipboard.writeText(`${r.id}: ${r.text}`); st.toast("info", "Copied"); }}><Copy size={14} /> Copy</button>
      </div>
    </aside>
  );
}

function ActionBar({ data, selected, clear }: { data: RmModuleData; selected: string[]; clear: () => void }) {
  const st = useStore();
  const [role, setRole] = useState("analyst");
  const [project, setProject] = useState(st.currentProjectId ?? st.projects[0]?.id ?? "");
  const [goal, setGoal] = useState("");
  const modRef = data.module.identifier || data.module.uuid;
  const analyse = async () => {
    const target = selected.length
      ? `requirements ${selected.join(", ")} of DOORS Next module "${data.module.title}" (module ${modRef}). Read them with rm_get (module ${modRef}); use rm_search to find related or conflicting requirements.`
      : `DOORS Next module "${data.module.title}" (module ${modRef}). Start with rm_outline, then use rm_search / rm_get for the parts that matter — do not read the whole module.`;
    const brief = `Analyse ${target}\n${goal.trim() ? `Goal: ${goal.trim()}\n` : ""}Relate the requirements to the code in this project where relevant: coverage, gaps, ambiguities, testability and risks. Cite requirement ids.`;
    const a = await api().startAgent({ projectId: project || null, role, brief });
    for (const p of st.projects) await st.refreshChats(p.id);
    if (a.chatId) await st.openChat(a.chatId);
  };
  const toTask = async () => {
    const reqs = data.requirements.filter((r) => selected.includes(r.id));
    await api().createTask({ title: `Requirements ${selected.slice(0, 5).join(", ")}${selected.length > 5 ? "…" : ""} — ${data.module.title}`,
      description: reqs.map((r) => `${r.id} (${r.section}): ${r.text}`).join("\n").slice(0, 4000), projectId: project || null });
    st.toast("info", "Task created");
  };
  return (
    <div className="rm-actions panel">
      <span className="small">{selected.length ? <b>{selected.length} selected</b> : <span className="muted">Whole module</span>}</span>
      {selected.length > 0 && <button className="link small" onClick={clear}>clear</button>}
      <input className="grow" value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="Goal (optional), e.g. check coverage by the CAPL tests, derive test cases…" />
      <select value={project} onChange={(e) => setProject(e.target.value)} title="Code project for the analysis">
        <option value="">No project</option>{st.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
      <select value={role} onChange={(e) => setRole(e.target.value)} title="Agent">
        {st.roles.map((r) => <option key={r.name} value={r.name}>{r.title}</option>)}
      </select>
      <button className="primary" onClick={analyse}><Sparkles size={15} /> Analyse</button>
      <button disabled={!selected.length} onClick={toTask}><SquareKanban size={15} /> Task</button>
      <button className="ghost" disabled={!selected.length} onClick={() => {
        const txt = data.requirements.filter((r) => selected.includes(r.id)).map((r) => `${r.id} ${r.section} — ${r.text}`).join("\n\n");
        void navigator.clipboard.writeText(txt); st.toast("info", "Copied");
      }}><Copy size={15} /></button>
    </div>
  );
}
