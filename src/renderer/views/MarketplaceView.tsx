import { useEffect, useMemo, useState } from "react";
import { CircleAlert, CircleArrowUp, CircleCheck, Puzzle as PuzzleIcon, RefreshCw, Settings, Upload } from "../components/icons";
import type { InstalledPlugin, MarketplaceListing, PluginEntry, PluginKind, Submission } from "@shared/types";
import { api, useStore } from "../store";
import { SubmitDialog, SubmissionsList, type SubmitPrefill } from "../components/MarketplaceSubmit";

type State = Awaited<ReturnType<ReturnType<typeof api>["marketplaceList"]>>;
export const KIND_LABEL: Record<PluginKind, string> = { agent: "Agents", workflow: "Workflows", skill: "Skills", script: "Scripts", mcp: "Tools (MCP)", instructions: "Instructions", exam: "EXAM setup" };
/** The kind filters shown as chips above the catalogue. */
const KIND_FILTERS: PluginKind[] = ["agent", "workflow", "skill", "script", "mcp", "instructions"];
const SERVER_ID = "flash-server";

export function MarketplaceView() {
  const st = useStore();
  const [data, setData] = useState<State | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [tab, setTab] = useState<string>("all"); // source id | "all" | "installed" | "submissions"
  const [q, setQ] = useState("");
  const [kind, setKind] = useState<PluginKind | "">("");
  const [sel, setSel] = useState<{ sourceId: string; entry: PluginEntry } | null>(null);
  const [submit, setSubmit] = useState<SubmitPrefill | null>(null);
  const [subs, setSubs] = useState<Submission[] | null>(null);
  const [subsError, setSubsError] = useState("");
  const sources = st.settings?.marketplace.sources ?? [];
  const serverOn = !!data?.listings.some((l) => l.sourceId === SERVER_ID);

  const loadSubs = async () => {
    try { setSubs(await api().marketplaceSubmissions()); setSubsError(""); } catch (e: any) { setSubsError(String(e?.message ?? e)); }
  };
  const load = async (refresh: boolean) => {
    setBusy("refresh");
    try {
      const d = await api().marketplaceList(refresh);
      setData(d);
      if (d.listings.some((l) => l.sourceId === SERVER_ID) && (refresh || subs === null)) void loadSubs();
    } catch (e: any) { st.toast("error", String(e?.message ?? e)); } finally { setBusy(null); }
  };
  useEffect(() => { void load(false); }, []); // load once on open
  useEffect(() => window.flash.onEvent((e) => { if (e.type === "plugins.changed") void api().marketplaceList(false).then(setData); }), []);

  const installed = useMemo(() => new Map((data?.installed ?? []).map((p) => [p.id, p])), [data]);
  const updates = useMemo(() => new Map((data?.updates ?? []).map((u) => [u.id, u])), [data]);
  const rows = useMemo(() => {
    const out: { listing: MarketplaceListing; entry: PluginEntry }[] = [];
    for (const l of data?.listings ?? []) {
      if (tab !== "all" && tab !== "installed" && l.sourceId !== tab) continue;
      for (const e of l.plugins) {
        if (tab === "installed" && !installed.has(e.id)) continue;
        if (kind && !e.kinds.includes(kind)) continue;
        if (q && !`${e.name} ${e.description} ${e.team} ${e.tags.join(" ")}`.toLowerCase().includes(q.toLowerCase())) continue;
        out.push({ listing: l, entry: e });
      }
    }
    return out;
  }, [data, tab, q, kind, installed]);
  const orphanInstalled = tab === "installed" ? (data?.installed ?? []).filter((p) => !rows.some((r) => r.entry.id === p.id)) : [];

  const act = async (label: string, fn: () => Promise<unknown>, ok: string) => {
    setBusy(label);
    try { await fn(); st.toast("info", ok); setData(await api().marketplaceList(false)); }
    catch (e: any) { st.toast("error", String(e?.message ?? e).split("\n").slice(0, 3).join(" ")); }
    finally { setBusy(null); }
  };

  if (!sources.length && data && !data.listings.length) {
    return (
      <div className="page">
        <header className="page-header"><h2><PuzzleIcon size={20} className="h-icon" /> Marketplace</h2></header>
        <div className="empty">
          <div>No marketplace configured yet. Each department can host its own catalogue of agents, workflows and instructions on a local server, or connect to a Flash server.</div>
          <div className="row gap">
            <button className="primary" onClick={() => st.setView({ kind: "settings", tab: "marketplace" })}>Add a marketplace</button>
            <button onClick={() => st.setView({ kind: "settings", tab: "server" })}>Connect a Flash server</button>
          </div>
        </div>
      </div>
    );
  }
  const pendingReview = (subs ?? []).filter((x) => x.status === "changes_requested").length;

  return (
    <div className="page">
      <header className="page-header">
        <h2><PuzzleIcon size={20} className="h-icon" /> Marketplace</h2>
        <div className="row gap">
          {(data?.updates.length ?? 0) > 0 && (
            <button className="primary" disabled={!!busy} onClick={() => act("update-all", () => api().marketplaceUpdateAll(), "Plugins updated")}><CircleArrowUp size={15} /> Update all ({data!.updates.length})</button>
          )}
          {serverOn && <button onClick={() => setSubmit({})}><Upload size={14} /> Submit</button>}
          <button disabled={!!busy} onClick={() => load(true)}><RefreshCw size={14} className={busy === "refresh" ? "spin" : ""} /> {busy === "refresh" ? "Refreshing…" : "Refresh"}</button>
          <button onClick={() => st.setView({ kind: "settings", tab: "marketplace" })}><Settings size={14} /> Marketplaces</button>
        </div>
      </header>

      <div className="row gap wrap">
        <div className="seg">
          <button className={tab === "all" ? "on" : ""} onClick={() => setTab("all")}>All</button>
          {(data?.listings ?? []).map((l) => {
            const s = sources.find((x) => x.id === l.sourceId);
            return <button key={l.sourceId} className={tab === l.sourceId ? "on" : ""} onClick={() => setTab(l.sourceId)} title={l.error ?? l.url}>
              {s?.department ? `${s.department} · ` : ""}{l.sourceName}{l.error ? <CircleAlert size={12} className="warn-text" /> : ` (${l.plugins.length})`}</button>;
          })}
          <button className={tab === "installed" ? "on" : ""} onClick={() => setTab("installed")}>Installed ({data?.installed.length ?? 0})</button>
          {serverOn && <button className={tab === "submissions" ? "on" : ""} onClick={() => { setTab("submissions"); void loadSubs(); }}>
            My submissions{subs ? ` (${subs.length})` : ""}{pendingReview > 0 && <span className="warn-badge" title="Changes requested">{pendingReview}</span>}</button>}
        </div>
        {tab !== "submissions" && <input className="grow" placeholder="Search plugins, teams, tags…" value={q} onChange={(e) => setQ(e.target.value)} />}
      </div>
      {tab !== "submissions" && (
        <div className="row gap-s wrap mp-kinds">
          <button className={`kind-chip ${kind === "" ? "on" : ""}`} onClick={() => setKind("")}>All</button>
          {KIND_FILTERS.map((k) => <button key={k} className={`kind-chip k-${k} ${kind === k ? "on" : ""}`} onClick={() => setKind(kind === k ? "" : k)}>{KIND_LABEL[k]}</button>)}
        </div>
      )}

      {tab !== "submissions" && data?.listings.filter((l) => l.error && (tab === "all" || tab === l.sourceId)).map((l) => (
        <div key={l.sourceId} className="warn-note row gap-s"><CircleAlert size={14} /> {l.sourceName} ({l.url}) is unreachable: {l.error}</div>
      ))}

      {tab === "submissions" && <SubmissionsList subs={subs} error={subsError} onReload={loadSubs} onResubmit={(x) => setSubmit({ meta: { id: x.pluginId, name: x.name, version: x.version }, notes: `Resubmission of #${x.id}: ` })} />}
      {submit && <SubmitDialog prefill={submit} onClose={() => setSubmit(null)} onDone={() => { setSubmit(null); setTab("submissions"); void loadSubs(); }} />}

      {tab !== "submissions" && <div className="mp-layout">
        <div className="mp-grid">
          {rows.length === 0 && orphanInstalled.length === 0 && <div className="muted">No plugins match.</div>}
          {rows.map(({ listing, entry }) => {
            const inst = installed.get(entry.id);
            const up = updates.get(entry.id);
            return (
              <div key={`${listing.sourceId}:${entry.id}`} className={`mp-card ${sel?.entry.id === entry.id ? "sel" : ""}`} onClick={() => setSel({ sourceId: listing.sourceId, entry })}>
                <div className="row between"><strong>{entry.name}</strong><span className="muted small">v{entry.version}</span></div>
                <div className="muted small">{entry.team || "—"} · {listing.department || listing.sourceName}</div>
                <div className="mp-desc">{entry.description}</div>
                <div className="row gap-s wrap">{entry.kinds.map((k) => <span key={k} className={`chip kind k-${k}`}>{KIND_LABEL[k] ?? k}</span>)}{entry.tags.slice(0, 4).map((t) => <span key={t} className="chip muted">#{t}</span>)}</div>
                <div className="row gap-s mp-actions" onClick={(e) => e.stopPropagation()}>
                  {!inst && <button className="primary" disabled={!!busy} onClick={() => act(entry.id, () => api().marketplaceInstall(listing.sourceId, entry.id), `Installed ${entry.name}`)}>{busy === entry.id ? "Installing…" : "Install"}</button>}
                  {inst && up && <button className="primary" disabled={!!busy} onClick={() => act(entry.id, () => api().marketplaceInstall(listing.sourceId, entry.id), `Updated ${entry.name} to ${up.to}`)}><CircleArrowUp size={14} /> Update to {up.to}</button>}
                  {inst && !up && <span className="pill green"><CircleCheck size={12} /> Installed {inst.version}</span>}
                  {inst && <button className="ghost danger" disabled={!!busy} onClick={() => confirm(`Uninstall ${entry.name}? Its agents, workflows and instructions are removed.`) && act(entry.id, () => api().marketplaceUninstall(entry.id), `Uninstalled ${entry.name}`)}>Uninstall</button>}
                </div>
              </div>
            );
          })}
          {orphanInstalled.map((p) => <InstalledCard key={p.id} p={p} busy={!!busy} onUninstall={() => act(p.id, () => api().marketplaceUninstall(p.id), `Uninstalled ${p.name}`)} />)}
        </div>
        {sel && <PluginDetail sel={sel} installed={installed.get(sel.entry.id)} listing={data?.listings.find((l) => l.sourceId === sel.sourceId)} />}
      </div>}
    </div>
  );
}

function InstalledCard({ p, busy, onUninstall }: { p: InstalledPlugin; busy: boolean; onUninstall: () => void }) {
  return (
    <div className="mp-card">
      <div className="row between"><strong>{p.name}</strong><span className="muted small">v{p.version}</span></div>
      <div className="muted small">{p.team} · from {p.sourceName} (not listed right now)</div>
      <div className="row gap-s mp-actions"><span className="pill green"><CircleCheck size={12} /> Installed</span><button className="ghost danger" disabled={busy} onClick={onUninstall}>Uninstall</button></div>
    </div>
  );
}

function PluginDetail({ sel, installed, listing }: { sel: { sourceId: string; entry: PluginEntry }; installed?: InstalledPlugin; listing?: MarketplaceListing }) {
  const st = useStore();
  const e = sel.entry;
  return (
    <div className="panel mp-detail">
      <h3>{e.name}</h3>
      <div className="muted small">v{e.version} · {e.team || "unknown team"} · {listing?.department ? `${listing.department} — ` : ""}{listing?.sourceName}{e.updated ? ` · updated ${e.updated}` : ""}{e.author ? ` · by ${e.author}` : ""}</div>
      <p>{e.description}</p>
      <div className="small">Contains: {e.kinds.map((k) => KIND_LABEL[k] ?? k).join(" · ") || "—"}</div>
      <div className="small muted">Integrity: {e.sha256 ? <code>sha256 {e.sha256.slice(0, 12)}…</code> : "no checksum published"}</div>
      {installed && (
        <div className="mp-installed">
          <h4>Installed</h4>
          {installed.agents.length > 0 && <div className="small">Agents: {installed.agents.map((a) => <code key={a}>@{a}</code>)}</div>}
          {installed.workflows.length > 0 && <div className="small">Workflows: {installed.workflows.map((w) => <code key={w}>/{w}</code>)}</div>}
          {installed.skills.length > 0 && <div className="small">Skills: {installed.skills.map((w) => <code key={w}>/{w}</code>)}</div>}
          {installed.scripts.length > 0 && <div className="small">Scripts (agents are told where they are): {installed.scripts.map((w) => <code key={w}>{w}</code>)}</div>}
          {installed.mcpServers.length > 0 && <div className="small">MCP servers: {installed.mcpServers.join(", ")} {!st.settings?.marketplace.allowMcpServers && <span className="muted">(disabled by policy — enable in Settings → MCP)</span>}</div>}
          {(installed.hasInstructions || installed.scripts.length > 0) && (
            <label className="row gap-s small"><input type="checkbox" checked={installed.instructionsEnabled}
              onChange={(ev) => void api().pluginInstructions(installed.id, ev.target.checked)} /> Add this plugin's instructions to every agent's team rules</label>
          )}
        </div>
      )}
    </div>
  );
}
