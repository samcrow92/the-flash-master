import { useEffect, useMemo, useState } from "react";
import { ClipboardList as ClipboardListIcon, ListTree } from "../components/icons";
import { RequirementsView } from "./RequirementsView";
import type { JazzComment, JazzSearch, JazzWorkItem } from "@shared/types";
import { api, useStore } from "../store";

const TYPES = ["", "Defect", "Task", "Story", "Epic", "Enhancement", "Impediment", "Retrospective"];
const TYPE_ICON: Record<string, string> = { defect: "🐞", task: "☑️", story: "📖", epic: "🏔️", enhancement: "✨", impediment: "⛔" };
const icon = (t: string) => TYPE_ICON[t.toLowerCase()] ?? "📄";
type SortKey = "id" | "modified" | "priority" | "state";
const PRIO: Record<string, number> = { high: 0, medium: 1, low: 2, unassigned: 3 };

export function JazzView() {
  const [tab, setTab] = useState<"items" | "rm">(() => { try { return (localStorage.getItem("jazzTab") as "items" | "rm") || "items"; } catch { return "items"; } });
  const pick = (t: "items" | "rm") => { setTab(t); try { localStorage.setItem("jazzTab", t); } catch { /* ignore */ } };
  const tabs = (
    <div className="seg jazz-tabs">
      <button className={tab === "items" ? "on" : ""} onClick={() => pick("items")}><ClipboardListIcon size={14} /> Work items</button>
      <button className={tab === "rm" ? "on" : ""} onClick={() => pick("rm")}><ListTree size={14} /> Requirements</button>
    </div>
  );
  return tab === "items" ? <JazzWorkItems tabs={tabs} /> : <RequirementsView tabs={tabs} />;
}

function JazzWorkItems({ tabs }: { tabs: React.ReactNode }) {
  const st = useStore();
  const cfg = st.settings?.jazz;
  const configuredAreas = useMemo(() => (cfg?.projectAreas?.length ? cfg.projectAreas : cfg?.projectArea ? [cfg.projectArea] : []), [cfg]);

  const [text, setText] = useState(cfg?.defaultQuery ?? "");
  const [areas, setAreas] = useState<string[]>([]); // empty = all configured
  const [serverAreas, setServerAreas] = useState<string[]>([]);
  const [state, setState] = useState<"open" | "closed" | "all">("open");
  const [type, setType] = useState("");
  const [owner, setOwner] = useState<"" | "me" | "unassigned">("");
  const [raw, setRaw] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const [sort, setSort] = useState<SortKey>("modified");

  const [items, setItems] = useState<JazzWorkItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searched, setSearched] = useState(false);

  const [selId, setSelId] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ item: JazzWorkItem; comments: JazzComment[] } | null>(null);
  const [detailBusy, setDetailBusy] = useState(false);

  const enabled = !!cfg?.enabled && !!cfg.serverUrl;

  const search = async (over: Partial<JazzSearch> = {}) => {
    setBusy(true); setError(null);
    try {
      const q: JazzSearch = { text, projectAreas: areas, state, type, owner, raw: advanced ? raw : "", max: 200, ...over };
      setItems(await api().jazzSearch(q));
      setSearched(true);
    } catch (e: any) { setError(String(e?.message ?? e)); } finally { setBusy(false); }
  };
  // Project areas visible on the server, so any area can be picked here even if it is not in Settings.
  useEffect(() => { if (enabled) api().jazzProjectAreas().then(setServerAreas).catch(() => setServerAreas([])); }, [enabled]);
  // First load: show my open items (or the default query) so the page is useful immediately.
  useEffect(() => { if (enabled) void search(cfg?.defaultQuery ? {} : { owner: "me" }).then(() => !cfg?.defaultQuery && setOwner("me")); }, [enabled]);

  const open = async (id: string) => {
    setSelId(id); setDetailBusy(true);
    try { setDetail(await api().jazzDetail(id)); } catch (e: any) { st.toast("error", String(e?.message ?? e)); setDetail(null); } finally { setDetailBusy(false); }
  };
  const onUpdated = (w: JazzWorkItem) => {
    setItems((list) => list.map((x) => (x.id === w.id ? { ...x, ...w } : x)));
    void open(w.id);
  };

  const sorted = useMemo(() => {
    const l = [...items];
    if (sort === "id") l.sort((a, b) => Number(b.id) - Number(a.id));
    if (sort === "modified") l.sort((a, b) => (b.modified ?? "").localeCompare(a.modified ?? ""));
    if (sort === "priority") l.sort((a, b) => (PRIO[(a.priority ?? "unassigned").toLowerCase()] ?? 3) - (PRIO[(b.priority ?? "unassigned").toLowerCase()] ?? 3));
    if (sort === "state") l.sort((a, b) => a.state.localeCompare(b.state));
    return l;
  }, [items, sort]);

  if (!enabled) {
    return (
      <div className="page">
        <header className="page-header"><h2><ClipboardListIcon size={20} className="h-icon" /> IBM Jazz</h2>{tabs}</header>
        <div className="empty">
          IBM Jazz (EWM/RTC) is not configured.
          <div><button className="primary" onClick={() => st.setView({ kind: "settings", tab: "integrations" })}>Configure Jazz</button></div>
        </div>
      </div>
    );
  }

  const toggleArea = (a: string) => setAreas((cur) => (cur.includes(a) ? cur.filter((x) => x !== a) : [...cur, a]));

  return (
    <div className="page jazz-page">
      <header className="page-header">
        <h2><ClipboardListIcon size={20} className="h-icon" /> IBM Jazz</h2>
        {tabs}
        <span className="grow" />
        <button className="ghost" onClick={() => st.setView({ kind: "settings", tab: "integrations" })} title="Jazz settings">⚙</button>
      </header>

      <div className="jazz-filters panel">
        <div className="row gap">
          <input className="grow" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && search()}
            placeholder="Search words in summary/description, or IDs: 123, 456" autoFocus />
          <button className="primary" onClick={() => search()} disabled={busy}>{busy ? "Searching…" : "Search"}</button>
        </div>
        <div className="row gap wrap">
          <div className="seg">
            {(["open", "closed", "all"] as const).map((s) => <button key={s} className={state === s ? "on" : ""} onClick={() => setState(s)}>{s}</button>)}
          </div>
          <div className="seg">
            {([["", "anyone"], ["me", "mine"], ["unassigned", "unassigned"]] as const).map(([v, l]) => <button key={v} className={owner === v ? "on" : ""} onClick={() => setOwner(v)}>{l}</button>)}
          </div>
          <select value={type} onChange={(e) => setType(e.target.value)} title="Type">
            {TYPES.map((t) => <option key={t} value={t}>{t ? `${icon(t)} ${t}` : "All types"}</option>)}
          </select>
          <button className={`ghost small ${advanced ? "on" : ""}`} onClick={() => setAdvanced(!advanced)} title="Reportable-API filter">ƒ filter</button>
        </div>
        <div className="row gap wrap">
          <span className="muted small">Project area:</span>
          {areas.length === 0 && <span className="chip on" title={configuredAreas.length ? configuredAreas.join(", ") : "every area you can see"}>
            {configuredAreas.length ? `all configured (${configuredAreas.length})` : "all areas"}</span>}
          {areas.map((a) => <span key={a} className="chip on">{a} <button className="link" title="Remove" onClick={() => toggleArea(a)}>✕</button></span>)}
          <select value="" onChange={(e) => { if (e.target.value) { toggleArea(e.target.value); } }} title="Pick a project area for searching and new actions">
            <option value="">＋ pick area…</option>
            {configuredAreas.length > 0 && <optgroup label="Configured">{configuredAreas.filter((a) => !areas.includes(a)).map((a) => <option key={a} value={a}>{a}</option>)}</optgroup>}
            {serverAreas.length > 0 && <optgroup label="On the server">{serverAreas.filter((a) => !areas.includes(a) && !configuredAreas.includes(a)).map((a) => <option key={a} value={a}>{a}</option>)}</optgroup>}
          </select>
          {areas.length > 0 && <button className="link small" onClick={() => setAreas([])}>reset</button>}
        </div>
        {advanced && (
          <input value={raw} onChange={(e) => setRaw(e.target.value)} onKeyDown={(e) => e.key === "Enter" && search()}
            placeholder="priority/name='High' and category/name='Comms'" />
        )}
      </div>

      {error && <div className="warn-note row gap between"><span>{error}</span>
        {(cfg?.authType === "browser" || /sign-in|single sign-on|Bearer/i.test(error)) && <button className="primary" onClick={async () => {
          if (cfg?.authType !== "browser") await api().updateSettings({ jazz: { authType: "browser" } }).then((x) => st.setSettings(x));
          const r = await api().jazzSignIn();
          if (r.ok) { st.toast("info", r.detail); void search(); } else st.toast("error", r.detail);
        }}>Sign in to Jazz</button>}
      </div>}

      <div className="jazz-layout">
        <div className="jazz-list">
          <div className="row between muted small">
            <span>{searched ? `${items.length} item${items.length === 1 ? "" : "s"}` : ""}</span>
            <label>Sort <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
              <option value="modified">recently changed</option><option value="id">newest id</option><option value="priority">priority</option><option value="state">state</option>
            </select></label>
          </div>
          {searched && items.length === 0 && !busy && <div className="muted">No work items match.</div>}
          {sorted.map((w) => (
            <button key={w.id} className={`jazz-item ${selId === w.id ? "sel" : ""}`} onClick={() => open(w.id)}>
              <div className="row between"><span><span title={w.type}>{icon(w.type)}</span> <strong>{w.id}</strong></span>
                <span className="row gap-s">{w.priority && w.priority !== "Unassigned" && <span className={`chip prio-${w.priority.toLowerCase()}`}>{w.priority}</span>}<span className="chip">{w.state}</span></span></div>
              <div className="jazz-title">{w.title}</div>
              <div className="muted small">{w.owner ?? "unassigned"}{w.projectArea && configuredAreas.length !== 1 ? ` · ${w.projectArea}` : ""}{w.modified ? ` · ${w.modified.slice(0, 10)}` : ""}</div>
            </button>
          ))}
        </div>
        {selId ? (
          <JazzDetail key={selId} id={selId} areas={areas} data={detail?.item.id === selId ? detail : null} busy={detailBusy} onUpdated={onUpdated} onReload={() => open(selId)} />
        ) : (
          <div className="panel muted jazz-detail">Select a work item to see details, comments and actions.</div>
        )}
      </div>
    </div>
  );
}

function JazzDetail({ id, areas, data, busy, onUpdated, onReload }: {
  id: string; areas: string[]; data: { item: JazzWorkItem; comments: JazzComment[] } | null; busy: boolean; onUpdated: (w: JazzWorkItem) => void; onReload: () => void;
}) {
  const st = useStore();
  const [role, setRole] = useState("jazz-analyst");
  const [project, setProject] = useState(st.currentProjectId ?? st.projects[0]?.id ?? "");
  const [comment, setComment] = useState("");
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState("");
  const [action, setAction] = useState("");
  const [saving, setSaving] = useState(false);

  if (!data) return <div className="panel jazz-detail muted">{busy ? `Loading ${id}…` : `Could not load ${id}.`}</div>;
  const w = data.item;
  const run = async (what: string, fn: () => Promise<unknown>) => {
    setSaving(true);
    try { await fn(); st.toast("info", what); } catch (e: any) { st.toast("error", String(e?.message ?? e)); } finally { setSaving(false); }
  };

  const analyse = async () => {
    const area = w.projectArea || areas[0];
    const brief = `Analyse Jazz work item ${w.id} (${w.type}, ${w.state}${area ? `, project area "${area}"` : ""}): "${w.title}".\n`
      + `When searching Jazz for related items, pass projectArea "${area ?? ""}" to jazz_query. Use jazz_get with comments: true for full details. Relate it to the code in this project, list affected files, risks and a proposed approach. Do not update the work item unless asked.`;
    const a = await api().startAgent({ projectId: project || null, role, brief });
    for (const p of st.projects) await st.refreshChats(p.id);
    if (a.chatId) await st.openChat(a.chatId);
  };
  const toTask = () => run(`Task created for ${w.id}`, () =>
    api().createTask({ title: `${w.id}: ${w.title}`, description: w.description.slice(0, 2000), jazzId: w.id, projectId: project || null }));
  const copy = (s: string, what: string) => { void navigator.clipboard.writeText(s); st.toast("info", `${what} copied`); };

  const fields: [string, string | undefined | null][] = [
    ["Type", w.type], ["State", w.state], ["Owner", w.owner ?? "unassigned"], ["Priority", w.priority], ["Severity", w.severity],
    ["Filed against", w.category], ["Planned for", w.plannedFor], ["Project area", w.projectArea], ["Creator", w.creator],
    ["Created", w.created?.slice(0, 16).replace("T", " ")], ["Modified", w.modified?.slice(0, 16).replace("T", " ")], ["Tags", w.tags],
  ];

  return (
    <div className="panel jazz-detail">
      <div className="row between">
        {editing ? (
          <div className="row gap grow">
            <input className="grow" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
            <button className="primary" disabled={saving || !title.trim()} onClick={() => run("Summary updated", async () => { onUpdated(await api().jazzUpdate(w.id, { "dcterms:title": title.trim() })); setEditing(false); })}>Save</button>
            <button onClick={() => setEditing(false)}>Cancel</button>
          </div>
        ) : (
          <h3 className="grow">{icon(w.type)} {w.id} — {w.title} <button className="link small" title="Edit summary" onClick={() => { setTitle(w.title); setEditing(true); }}>✎</button></h3>
        )}
        <button className="ghost small" onClick={onReload} title="Reload" disabled={busy}>↻</button>
      </div>

      <div className="jazz-fields">
        {fields.filter(([, v]) => v).map(([k, v]) => <div key={k}><span className="muted small">{k}</span><div>{v}</div></div>)}
      </div>

      <div className="row gap wrap">
        <select value={project} onChange={(e) => setProject(e.target.value)} title="Project used for analysis and tasks">
          <option value="">No project</option>{st.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <select value={role} onChange={(e) => setRole(e.target.value)} title="Agent used for analysis">
          {st.roles.map((r) => <option key={r.name} value={r.name}>{r.icon} {r.title}</option>)}
        </select>
        <button className="primary" onClick={analyse}>🔎 Analyse with agent</button>
        <button onClick={toTask} disabled={saving}>＋ Task</button>
        {w.url && <a href={w.url} target="_blank" rel="noreferrer">Open in Jazz ↗</a>}
        {w.url && <button className="ghost small" onClick={() => copy(w.url!, "Link")}>🔗 Copy link</button>}
      </div>

      <h4>Description</h4>
      <p className="pre jazz-desc">{w.description || "(no description)"}</p>

      <h4>Discussion ({data.comments.length})</h4>
      <div className="jazz-comments">
        {data.comments.length === 0 && <div className="muted small">No comments yet.</div>}
        {data.comments.map((c, i) => (
          <div key={i} className="jazz-comment">
            <div className="muted small"><strong>{c.author || "?"}</strong> · {c.date.slice(0, 16).replace("T", " ")}</div>
            <div className="pre">{c.text}</div>
          </div>
        ))}
      </div>
      <textarea rows={3} value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Add a comment…" />
      <div className="row gap wrap">
        <button className="primary" disabled={saving || !comment.trim()} onClick={() => run("Comment added", async () => { await api().jazzComment(w.id, comment.trim()); setComment(""); onReload(); })}>Comment</button>
        <span className="grow" />
        <input value={action} onChange={(e) => setAction(e.target.value)} placeholder="workflow action id (e.g. …action.resolve)" title="Changes the state through the work item's workflow" />
        <button disabled={saving || !action.trim()} onClick={() => run("State changed", async () => { onUpdated(await api().jazzUpdate(w.id, {}, action.trim())); setAction(""); })}>Run action</button>
      </div>
    </div>
  );
}
