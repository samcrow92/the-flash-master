import { useEffect, useState, type ReactNode } from "react";
import type { HarnessId, HarnessStatus } from "@shared/types";
import { HARNESS_IDS } from "@shared/types";
import type { Settings } from "@shared/settings";
import { api, useStore } from "../store";
import { AgentImportDialog, reportImports } from "../components/AgentImport";
import { ModelInput } from "../components/ModelInput";

const TABS = [
  ["general", "General"], ["harnesses", "Harnesses"], ["agents", "Agents"], ["tokens", "Token efficiency"], ["permissions", "Permissions"],
  ["mcp", "MCP servers"], ["marketplace", "Marketplace"], ["integrations", "Integrations"], ["network", "Network"], ["data", "Data"], ["advanced", "Advanced"], ["about", "About"],
] as const;

type Path = string;

function getAt(obj: any, path: Path): any {
  return path.split(".").reduce((o, k) => (o == null ? o : o[k]), obj);
}
function patchAt(path: Path, value: unknown): any {
  return path.split(".").reverse().reduce<any>((acc, k) => ({ [k]: acc }), value);
}

export function SettingsView({ initialTab }: { initialTab?: string }) {
  const st = useStore();
  const [tab, setTab] = useState<string>(initialTab ?? "general");
  const s = st.settings!;
  const locked = (p: string) => st.locked.some((l) => l === p || l.startsWith(p + ".") || p.startsWith(l + "."));
  const set = async (path: Path, value: unknown) => st.setSettings(await api().updateSettings(patchAt(path, value)));
  const f = { s, set, locked };

  return (
    <div className="page settings">
      <header className="page-header"><h2>⚙️ Settings</h2>{st.locked.length > 0 && <span className="pill">🔒 Some settings are managed by your organisation</span>}</header>
      <div className="settings-layout">
        <nav className="tabs">{TABS.map(([k, l]) => <button key={k} className={tab === k ? "active" : ""} onClick={() => setTab(k)}>{l}</button>)}</nav>
        <div className="tab-body">
          {tab === "general" && <General {...f} />}
          {tab === "harnesses" && <Harnesses {...f} />}
          {tab === "agents" && <Agents {...f} />}
          {tab === "tokens" && <Tokens {...f} />}
          {tab === "permissions" && <Permissions {...f} />}
          {tab === "mcp" && <Mcp {...f} />}
          {tab === "marketplace" && <MarketplaceSettings {...f} />}
          {tab === "integrations" && <Integrations {...f} />}
          {tab === "network" && <Network {...f} />}
          {tab === "data" && <Data {...f} />}
          {tab === "advanced" && <Advanced {...f} />}
          {tab === "about" && <About />}
        </div>
      </div>
    </div>
  );
}

interface F { s: Settings; set: (p: Path, v: unknown) => Promise<void>; locked: (p: string) => boolean }

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return <div className="setting"><div><div>{label}</div>{hint && <div className="muted small">{hint}</div>}</div><div className="setting-ctl">{children}</div></div>;
}
function Text({ f, path, placeholder, type = "text" }: { f: F; path: Path; placeholder?: string; type?: string }) {
  const v = getAt(f.s, path) ?? "";
  return <input type={type} key={`${path}:${v}`} defaultValue={v} placeholder={placeholder} disabled={f.locked(path)}
    onBlur={(e) => { if (e.target.value !== v) void f.set(path, e.target.value); }} />;
}
function Num({ f, path, min = 0, step = 1 }: { f: F; path: Path; min?: number; step?: number }) {
  const v = Number(getAt(f.s, path) ?? 0);
  return <input type="number" min={min} step={step} key={`${path}:${v}`} defaultValue={v} disabled={f.locked(path)}
    onBlur={(e) => { const n = Number(e.target.value); if (!Number.isNaN(n) && n !== v) void f.set(path, n); }} />;
}
function Bool({ f, path }: { f: F; path: Path }) {
  const v = !!getAt(f.s, path);
  return <label className="switch"><input type="checkbox" checked={v} disabled={f.locked(path)} onChange={(e) => f.set(path, e.target.checked)} /><span /></label>;
}
function Choice({ f, path, options }: { f: F; path: Path; options: [string, string][] }) {
  return <select value={String(getAt(f.s, path) ?? "")} disabled={f.locked(path)} onChange={(e) => f.set(path, e.target.value)}>
    {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>;
}
function Area({ f, path, rows = 4 }: { f: F; path: Path; rows?: number }) {
  const v = getAt(f.s, path) ?? "";
  return <textarea rows={rows} key={`${path}:${v}`} defaultValue={v} disabled={f.locked(path)} onBlur={(e) => e.target.value !== v && f.set(path, e.target.value)} />;
}

const harnessOptions: [string, string][] = HARNESS_IDS.map((h) => [h, h]);

function General(f: F) {
  return <>
    <Row label="Theme"><Choice f={f} path="general.theme" options={[["dark", "Dark"], ["light", "Light"], ["system", "System"]]} /></Row>
    <Row label="Default harness" hint="Used when a chat or role does not pick one; falls back to the first available."><Choice f={f} path="general.defaultHarness" options={harnessOptions} /></Row>
    <Row label="Desktop notifications" hint="Approval requests, budget warnings and errors when the window is in the background."><Bool f={f} path="general.notifications" /></Row>
    <Row label="Confirm before stopping all agents"><Bool f={f} path="general.confirmStop" /></Row>
    <Row label="Restore last chat on start"><Bool f={f} path="general.restoreLastChat" /></Row>
  </>;
}

function Harnesses(f: F) {
  const [status, setStatus] = useState<HarnessStatus[]>([]);
  const [busy, setBusy] = useState(false);
  const detect = async () => { setBusy(true); try { setStatus(await api().detectHarnesses()); } finally { setBusy(false); } };
  useEffect(() => { void detect(); }, []);
  return <>
    <p className="muted">TheFlashMaster uses the agent CLIs already installed and signed in on this machine. No credentials are stored by this app.</p>
    <button onClick={detect} disabled={busy}>{busy ? "Detecting…" : "↻ Detect again"}</button>
    {HARNESS_IDS.map((h: HarnessId) => {
      const st = status.find((x) => x.id === h);
      return <div key={h} className="panel">
        <div className="row between">
          <h4>{st?.label ?? h} <span className="muted small">({st?.protocol ?? ""})</span></h4>
          <span className={`pill ${st?.available ? "green" : "red"}`}>{st ? (st.available ? `found ${st.version ?? ""}` : "not found") : "…"}</span>
        </div>
        {st?.path && <div className="muted small">{st.path}</div>}
        {st?.detail && <div className="muted small">{st.detail}</div>}
        <Row label="Enabled"><Bool f={f} path={`harnesses.${h}.enabled`} /></Row>
        {h !== "mock" && <>
          <Row label="Executable path" hint="Leave blank to auto-detect on PATH."><Text f={f} path={`harnesses.${h}.path`} placeholder="auto" /></Row>
          <Row label="Extra arguments"><Text f={f} path={`harnesses.${h}.args`} placeholder={h === "copilot" ? "--allow-all-paths" : ""} /></Row>
          <Row label="Default model" hint="Suggestions come from the harness (↻ to refresh); any id it accepts can be typed.">
            <ModelInput harness={h} value={f.s.harnesses[h].defaultModel} disabled={f.locked(`harnesses.${h}.defaultModel`)} onChange={(v) => f.set(`harnesses.${h}.defaultModel`, v)} />
          </Row>
        </>}
        {h === "pi" && <div className="warn-note">Pi runs in its native RPC mode. Pi has no MCP support by design, so Pi agents cannot delegate, report progress steps or use the Vector/winIDEA/PowerPoint/Jazz tools — use Copilot or OpenCode for the coordinator and tool-heavy specialists. Read-only mode is enforced with Pi's read-only tool set.</div>}
        {h === "duo" && <div className="warn-note">GitLab Duo runs in headless mode (no ACP) and auto-approves its own tools. Use read-only prompts or a sandbox.</div>}
      </div>;
    })}
  </>;
}

function Agents(f: F) {
  const st = useStore();
  const [editor, setEditor] = useState(false);
  const overrides = f.s.agents.roleOverrides;
  const setOverride = (role: string, key: string, value: unknown) =>
    f.set(`agents.roleOverrides.${role}`, { ...(overrides[role] ?? {}), [key]: value || undefined });
  return <>
    <Row label="Max concurrent agent turns" hint="Further turns queue until a slot is free."><Num f={f} path="agents.maxConcurrent" min={1} /></Row>
    <Row label="Delegation depth" hint="How many levels of specialists may delegate further (1 = only the coordinator delegates)."><Num f={f} path="agents.delegationDepth" min={0} /></Row>
    <Row label="Create a task per delegation" hint="Shows delegated work on the task board."><Bool f={f} path="agents.autoTaskFromDelegation" /></Row>
    <InstructionSettings f={f} />
    <div className="row between">
      <h4>Agents</h4>
      <div className="row gap">
        <button className="primary" onClick={() => setEditor(true)}>➕ New agent from template</button>
        <button onClick={async () => reportImports(await api().importAgentFiles(), st.toast)}>📂 Import .md…</button>
        <button onClick={async () => { const p = await api().saveAgentTemplate(); if (p) st.toast("info", `Template saved to ${p}`); }}>⬇ Template</button>
        <button onClick={() => api().openRolesFolder()}>Open folder</button>
      </div>
    </div>
    <p className="muted small">Agents are Markdown files with a small header. Get the template, edit it yourself or ask your LLM to fill it in, then import it (or drag the file onto the window). Custom agents override built-ins with the same name.</p>
    {editor && <AgentImportDialog onClose={() => setEditor(false)} />}
    <table className="table">
      <thead><tr><th>Agent</th><th>Harness</th><th>Model</th><th>Max result tokens</th><th /></tr></thead>
      <tbody>{st.roles.map((r) => <tr key={r.name}>
        <td>{r.icon} {r.title} {r.source === "user" && <span className="custom-tag">custom</span>} <span className="muted small">@{r.name}</span><div className="muted small">{r.description}</div></td>
        <td><select value={overrides[r.name]?.harness ?? ""} onChange={(e) => setOverride(r.name, "harness", e.target.value)}>
          <option value="">{r.harness ? `role default (${r.harness})` : "chat default"}</option>{HARNESS_IDS.map((h) => <option key={h}>{h}</option>)}</select></td>
        <td><ModelInput harness={overrides[r.name]?.harness ?? r.harness ?? f.s.general.defaultHarness} value={overrides[r.name]?.model ?? ""}
          placeholder={r.model ?? undefined} onChange={(v) => setOverride(r.name, "model", v)} /></td>
        <td><input type="number" defaultValue={overrides[r.name]?.maxResultTokens ?? r.maxResultTokens} onBlur={(e) => setOverride(r.name, "maxResultTokens", Number(e.target.value))} /></td>
        <td className="actions">
          <button title="Export as .md" onClick={async () => { const p = await api().exportAgent(r.name); if (p) st.toast("info", `Exported to ${p}`); }}>⬇</button>
          {r.source === "user" && <button className="danger" title="Remove custom agent" onClick={async () => { if (confirm(`Remove agent "${r.title}"?`)) await api().removeAgent(r.name); }}>🗑</button>}
        </td>
      </tr>)}</tbody>
    </table>
  </>;
}

function InstructionSettings({ f }: { f: F }) {
  const [setup, setSetup] = useState<Awaited<ReturnType<ReturnType<typeof api>["instructionSetup"]>>>([]);
  const a = f.s.agents;
  useEffect(() => { void api().instructionSetup().then(setSetup); }, [a.instructionMode, a.keepProjectInstructions]);
  return <>
    <h4>Harness instructions</h4>
    <p className="muted small">Agent CLIs preload their own instructions (AGENTS.md, CLAUDE.md, custom rules, skills, extensions). In <b>clean</b> mode TheFlashMaster
      switches those off where the harness allows it, so agents follow only TheFlashMaster's agent definitions and your team rules. Logins and provider settings are not touched.</p>
    <Row label="Instruction mode">
      <Choice f={f} path="agents.instructionMode" options={[["clean", "Clean — TheFlashMaster instructions only"], ["harness", "Harness defaults — keep their own instructions"]]} />
    </Row>
    <Row label="Keep project AGENTS.md / instruction files" hint="In clean mode, still load the repository's own agent instructions (useful when a repo documents its build/test conventions).">
      <Bool f={f} path="agents.keepProjectInstructions" />
    </Row>
    <Row label="Team rules" hint="Sent to every agent as part of its stable instructions — your workflow, conventions and setup. Keep it short (it is part of every session).">
      <Area f={f} path="agents.houseRules" rows={6} />
    </Row>
    <table className="table">
      <thead><tr><th>Harness</th><th>Coverage</th><th>What is applied</th></tr></thead>
      <tbody>{setup.filter((x) => x.harness !== "mock").map((x) => <tr key={x.harness}>
        <td>{x.harness}</td>
        <td><span className={`status ${x.coverage === "full" ? "st-done" : x.coverage === "partial" ? "st-paused" : "st-stopped"}`}>{x.coverage === "none" ? "harness defaults" : x.coverage}</span></td>
        <td className="small">{x.note}{x.args.length > 0 && <div className="muted"><code>{x.args.join(" ")}</code></div>}{Object.keys(x.env).length > 0 && <div className="muted"><code>{Object.keys(x.env).join(", ")}</code></div>}</td>
      </tr>)}</tbody>
    </table>
    <p className="muted small">Changes apply to new agent sessions (stop running agents to restart them with the new setup).</p>
  </>;
}

function Tokens(f: F) {
  return <>
    <p className="muted">Token efficiency is built in: briefs instead of transcripts, capped structured results, clipped outputs stored as artifacts, rolling compaction, stable prompt prefixes, on-demand skills and budgets.</p>
    <h4>Budgets (0 = unlimited)</h4>
    <Row label="Daily budget (all agents)"><Num f={f} path="tokens.dailyBudget" step={10000} /></Row>
    <Row label="Daily budget per project"><Num f={f} path="tokens.projectBudget" step={10000} /></Row>
    <Row label="Budget per agent run"><Num f={f} path="tokens.agentBudget" step={10000} /></Row>
    <Row label="Warn at (%)"><Num f={f} path="tokens.warnAtPercent" min={1} /></Row>
    <Row label="When a budget is exceeded"><Choice f={f} path="tokens.onBudgetExceeded" options={[["pause", "Pause the agent"], ["stop", "Stop the agent"], ["warn", "Warn only"]]} /></Row>
    <h4>Context</h4>
    <Row label="Compact after (tokens)" hint="Older turns are summarised; long harness sessions are rolled over to a fresh session with the summary."><Num f={f} path="tokens.compactAfterTokens" step={1000} /></Row>
    <Row label="Recent turns kept verbatim"><Num f={f} path="tokens.keepRecentTurns" min={1} /></Row>
    <Row label="Clip tool output above (chars)" hint="Larger outputs become artifacts that agents fetch only when needed."><Num f={f} path="tokens.clipOutputChars" step={500} /></Row>
    <h4>Economy routing</h4>
    <Row label="Economy harness" hint="Optional cheaper harness/model for delegated specialist runs."><Choice f={f} path="tokens.economyHarness" options={[["", "none"], ...harnessOptions]} /></Row>
    <Row label="Economy model"><Text f={f} path="tokens.economyModel" /></Row>
    <Row label="Run delegated specialists on the economy harness/model"><Bool f={f} path="tokens.economyForDelegated" /></Row>
    <Row label="Show token counts on messages"><Bool f={f} path="tokens.showTokenCounts" /></Row>
  </>;
}

function Permissions(f: F) {
  return <>
    <Row label="Tool approval" hint="'Ask' posts an approval message in the chat: react ✅ to allow or ❌ to deny.">
      <Choice f={f} path="permissions.approval" options={[["ask", "Ask for every action"], ["auto-read", "Auto-approve reads, ask for changes"], ["auto-all", "Auto-approve everything"]]} />
    </Row>
    <Row label="Read-only mode" hint="Agents cannot edit, delete, move files or run commands."><Bool f={f} path="permissions.readOnly" /></Row>
    <Row label="Blocked commands" hint="One per line. Any tool call containing one of these is denied."><Area f={f} path="permissions.blockedCommands" /></Row>
  </>;
}

function Mcp(f: F) {
  const st = useStore();
  const [busy, setBusy] = useState(false);
  const ext = f.s.mcp.external;
  const setExt = (list: typeof ext) => f.set("mcp.external", list);
  return <>
    <p className="muted">Custom tools are MCP servers. They are installed automatically at startup if missing and attached per agent session, so your global harness configs stay untouched.</p>
    <Row label="Install/update automatically at startup"><Bool f={f} path="mcp.autoInstall" /></Row>
    <Row label="Python executable" hint="Needed for the Vector/AUTOSAR and winIDEA servers. Blank = auto-detect (py -3 / python)."><Text f={f} path="mcp.pythonPath" placeholder="auto" /></Row>
    <Row label="pip index URL" hint="Your company's PyPI mirror, if any."><Text f={f} path="mcp.pipIndexUrl" placeholder="https://pypi.org/simple" /></Row>
    <div className="row between"><h4>Servers</h4><button disabled={busy} onClick={async () => { setBusy(true); try { await api().mcpReinstall(); } finally { setBusy(false); } }}>{busy ? "Installing…" : "↻ Reinstall / check"}</button></div>
    <table className="table"><thead><tr><th>Server</th><th>Kind</th><th>State</th><th>Enabled</th></tr></thead><tbody>
      {st.mcp.map((m) => <tr key={m.id}>
        <td><strong>{m.id}</strong><div className="muted small">{m.label}</div>{m.detail && <div className="muted small">{m.detail}</div>}</td>
        <td>{m.kind}</td><td><span className={`status st-${m.state === "ready" ? "done" : m.state === "error" ? "error" : "paused"}`}>{m.state}</span></td>
        <td>{m.id !== "flashmaster-core" && <input type="checkbox" checked={!f.s.mcp.disabled.includes(m.id)}
          onChange={(e) => f.set("mcp.disabled", e.target.checked ? f.s.mcp.disabled.filter((x) => x !== m.id) : [...f.s.mcp.disabled, m.id])} />}</td>
      </tr>)}
    </tbody></table>
    <div className="row between"><h4>Your MCP servers</h4><button onClick={() => setExt([...ext, { id: `custom-${ext.length + 1}`, label: "", command: "", args: "", env: "" }])}>＋ Add</button></div>
    <p className="muted small">Add the server id to a role's <code>tools:</code> list (roles folder) to attach it to that role's sessions.</p>
    {ext.map((e, i) => <div key={i} className="panel grid3">
      {(["id", "label", "command", "args", "env"] as const).map((k) => <label key={k} className="field"><span>{k}{k === "env" ? " (KEY=VALUE;…)" : ""}</span>
        <input defaultValue={e[k]} onBlur={(ev) => setExt(ext.map((x, j) => (j === i ? { ...x, [k]: ev.target.value } : x)))} /></label>)}
      <button className="danger ghost" onClick={() => setExt(ext.filter((_, j) => j !== i))}>Remove</button>
    </div>)}
  </>;
}

function MarketplaceSettings(f: F) {
  const list = f.s.marketplace.sources;
  const lockedSources = f.locked("marketplace.sources");
  const [tests, setTests] = useState<Record<string, string>>({});
  const setList = (next: typeof list) => f.set("marketplace.sources", next);
  const patch = (id: string, p: Partial<(typeof list)[number]>) => setList(list.map((x) => (x.id === id ? { ...x, ...p } : x)));
  const add = () => {
    const id = `mp-${Date.now().toString(36)}`;
    void setList([...list, { id, name: "New marketplace", url: "http://192.168.0.10:8080", department: "", enabled: true }]);
  };
  return <>
    <p className="muted">A marketplace is a catalogue of plugins (custom agents, workflows, instructions, optionally tools) that a team or department hosts on a
      local server — any static web server at an IP works, e.g. <code>python -m http.server 8080</code> in the published folder. Add one per department.</p>
    <div className="row between"><h4>Marketplaces</h4><button className="primary" disabled={lockedSources} onClick={add}>＋ Add marketplace</button></div>
    {lockedSources && <div className="muted small">🔒 The marketplace list is managed by your organisation.</div>}
    {list.length === 0 && <div className="muted">None yet.</div>}
    {list.map((m) => (
      <div key={m.id} className="panel mp-source">
        <div className="grid3">
          <label className="field"><span>Name</span><input defaultValue={m.name} disabled={lockedSources} onBlur={(e) => e.target.value !== m.name && patch(m.id, { name: e.target.value })} /></label>
          <label className="field"><span>Department / team</span><input defaultValue={m.department} placeholder="e.g. Body Electronics" disabled={lockedSources} onBlur={(e) => e.target.value !== m.department && patch(m.id, { department: e.target.value })} /></label>
          <label className="field"><span>Server (IP:port or URL)</span><input defaultValue={m.url} placeholder="http://10.20.30.40:8080" disabled={lockedSources} onBlur={(e) => e.target.value !== m.url && patch(m.id, { url: e.target.value.trim() })} /></label>
        </div>
        <div className="row gap wrap">
          <label className="row gap-s small"><input type="checkbox" checked={m.enabled} disabled={lockedSources} onChange={(e) => patch(m.id, { enabled: e.target.checked })} /> Enabled</label>
          <button onClick={async () => { setTests({ ...tests, [m.id]: "Testing…" }); const r = await api().marketplaceTest(m.id); setTests({ ...tests, [m.id]: (r.ok ? "✅ " : "❌ ") + r.detail }); }}>Test</button>
          <span className="small">{tests[m.id]}</span>
          <button className="ghost danger" disabled={lockedSources} onClick={() => confirm(`Remove marketplace "${m.name}"? Installed plugins stay installed.`) && setList(list.filter((x) => x.id !== m.id))}>Remove</button>
        </div>
      </div>
    ))}
    <h4>Options</h4>
    <Row label="Check for plugin updates at startup" hint="You get a notice and an ‘Update all’ button in the Marketplace."><Bool f={f} path="marketplace.autoCheckUpdates" /></Row>
    <Row label="Allow plugins to add tool servers (MCP)" hint="Tool servers run programs on this PC. When off, they are added disabled — enable them in Settings → MCP if you trust them."><Bool f={f} path="marketplace.allowMcpServers" /></Row>
  </>;
}

function Integrations(f: F) {
  const st = useStore();
  const [pw, setPw] = useState("");
  const [test, setTest] = useState<string>("");
  return <>
    <h4>IBM Jazz (EWM / RTC)</h4>
    <Row label="Enabled"><Bool f={f} path="jazz.enabled" /></Row>
    <Row label="Server URL" hint="e.g. https://jazz.company.com/ccm"><Text f={f} path="jazz.serverUrl" /></Row>
    <Row label="Project area"><Text f={f} path="jazz.projectArea" /></Row>
    <Row label="Authentication"><Choice f={f} path="jazz.authType" options={[["form", "Form (default for EWM)"], ["basic", "Basic"]]} /></Row>
    <Row label="User"><Text f={f} path="jazz.username" /></Row>
    <Row label="Password" hint={f.s.jazz.hasPassword ? "Stored encrypted with the OS keychain (Windows DPAPI)." : "Not set."}>
      <div className="row gap"><input type="password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="••••••" />
        <button disabled={!pw} onClick={async () => { await api().jazzSetPassword(pw); setPw(""); st.setSettings((await api().getSettings()).settings); st.toast("info", "Password saved"); }}>Save</button></div>
    </Row>
    <Row label="Default query"><Text f={f} path="jazz.defaultQuery" placeholder="state/group='open' and owner/userId='me'" /></Row>
    <Row label="Connection"><div className="row gap"><button onClick={async () => { setTest("Testing…"); const r = await api().jazzTest(); setTest(r.ok ? "✅ " + r.detail : "❌ " + r.detail); }}>Test</button><span>{test}</span></div></Row>

    <h4>winIDEA (iSYSTEM / TASKING)</h4>
    <Row label="winIDEA install path" hint="Folder or winIDEA.exe; blank = most recently used instance."><Text f={f} path="winidea.installPath" /></Row>
    <Row label="Workspace (.xjrf)"><Text f={f} path="winidea.workspace" /></Row>
    <Row label="Python SDK path" hint="Folder containing isystem/connect.py if the SDK is not pip-installed."><Text f={f} path="winidea.sdkPath" /></Row>

    <h4>Vector toolchain</h4>
    <Row label="CANoe install path"><Text f={f} path="vector.canoePath" /></Row>
    <Row label="CANoe version"><Text f={f} path="vector.canoeVersion" placeholder="e.g. 17 SP3" /></Row>
    <Row label="DaVinci Configurator CLI" hint="Path to DVCfgCmd.exe (or equivalent)."><Text f={f} path="vector.davinciCliPath" /></Row>
    <Row label="CAPL include paths" hint="Separated by ;"><Text f={f} path="vector.caplIncludePaths" /></Row>
  </>;
}

function Network(f: F) {
  return <>
    <p className="muted">Leave the proxy empty to use your <code>https_proxy</code> / <code>http_proxy</code> / <code>no_proxy</code> environment variables (or, without them, the Windows system proxy). A value here overrides them for harnesses, MCP servers, pip and Jazz.</p>
    <Row label="HTTP(S) proxy" hint="Blank = environment variables / system proxy."><Text f={f} path="network.proxy" placeholder="from environment" /></Row>
    <Row label="No proxy" hint="Blank = no_proxy environment variable. localhost is always bypassed."><Text f={f} path="network.noProxy" placeholder="from environment" /></Row>
    <Row label="Custom CA bundle (PEM)" hint="For TLS-inspecting corporate proxies."><Text f={f} path="network.caBundlePath" /></Row>
    <Row label="Offline mode" hint="Skip anything that needs the network (MCP installs)."><Bool f={f} path="network.offline" /></Row>
  </>;
}

function Data(f: F) {
  const st = useStore();
  return <>
    <Row label="Retention (days)" hint="Usage records, artifacts and finished agent runs older than this are removed at start. 0 = keep forever."><Num f={f} path="data.retentionDays" /></Row>
    <Row label="Export all data"><button onClick={async () => { const p = await api().exportData(); if (p) st.toast("info", `Exported to ${p}`); }}>Export JSON…</button></Row>
    <Row label="Reset settings to defaults"><button className="danger" onClick={async () => { if (confirm("Reset all settings?")) st.setSettings(await api().resetSettings()); }}>Reset</button></Row>
  </>;
}

function Advanced(f: F) {
  return <>
    <Row label="Log level"><Choice f={f} path="advanced.logLevel" options={[["error", "error"], ["warn", "warn"], ["info", "info"], ["debug", "debug"]]} /></Row>
    <Row label="Allow developer tools"><Bool f={f} path="advanced.devTools" /></Row>
    <Row label="Show mock harness" hint="Offline demo harness — useful for trying the app without agent CLIs."><Bool f={f} path="advanced.showMockHarness" /></Row>
  </>;
}

function About() {
  const [info, setInfo] = useState<{ version: string; dataDir: string; platform: string } | null>(null);
  useEffect(() => { void api().appInfo().then(setInfo); }, []);
  return <div>
    <h3>⚡ TheFlashMaster {info?.version}</h3>
    <p className="muted">Desktop orchestrator for AI coding agents on locally authenticated harnesses (GitHub Copilot CLI, OpenCode, Pi, GitLab Duo).</p>
    <p className="small">Data folder: <code>{info?.dataDir}</code><br />Platform: {info?.platform}</p>
    <p className="small muted">Enterprise policy: place <code>%PROGRAMDATA%\TheFlashMaster\policy.json</code> with <code>{"{ \"settings\": {…}, \"lock\": [\"network\", …] }"}</code> to preset and lock settings.</p>
    <p className="small muted">MIT licensed. Superpowers workflow adapted from obra/superpowers (MIT).</p>
  </div>;
}
