import { useEffect, useRef, useState, type ReactNode } from "react";
import { Settings as SettingsIcon } from "../components/icons";
import type { DriveMode, HarnessId, HarnessStatus } from "@shared/types";
import { DRIVE_MODES, HARNESS_IDS } from "@shared/types";
import type { Settings } from "@shared/settings";
import { api, useStore } from "../store";
import { MCP_CATALOG, catalogState, type CatalogServer } from "@shared/mcp-catalog";
import { UserAvatar, toAvatarDataUrl } from "../components/UserAvatar";
import { Camera, ImagePlus, Loader2, Trash2 } from "../components/icons";
import { AgentImportDialog, reportImports } from "../components/AgentImport";
import { ModelInput } from "../components/ModelInput";
import { configUri, isGcWebLink } from "@shared/rm-config";

const TABS = [
  ["general", "General"], ["harnesses", "Harnesses"], ["modes", "Modes & chat"], ["agents", "Agents"], ["tokens", "Token efficiency"], ["usage", "Usage"], ["permissions", "Permissions"],
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
      <header className="page-header"><h2><SettingsIcon size={20} className="h-icon" /> Settings</h2>{st.locked.length > 0 && <span className="pill">🔒 Some settings are managed by your organisation</span>}</header>
      <div className="settings-layout">
        <nav className="tabs">{TABS.map(([k, l]) => <button key={k} className={tab === k ? "active" : ""} onClick={() => setTab(k)}>{l}</button>)}</nav>
        <div className="tab-body">
          {tab === "general" && <General {...f} />}
          {tab === "harnesses" && <Harnesses {...f} />}
          {tab === "modes" && <Modes {...f} />}
          {tab === "agents" && <Agents {...f} />}
          {tab === "tokens" && <Tokens {...f} />}
          {tab === "usage" && <UsageSettings {...f} />}
          {tab === "permissions" && <Permissions {...f} />}
          {tab === "mcp" && <Mcp {...f} />}
          {tab === "marketplace" && <MarketplaceSettings {...f} />}
          {tab === "integrations" && <Integrations {...f} />}
          {tab === "network" && <Network {...f} />}
          {tab === "data" && <Data {...f} />}
          {tab === "advanced" && <Advanced {...f} />}
          {tab === "about" && <About f={f} />}
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

const HUES = [210, 260, 320, 0, 25, 45, 140, 175];

function ProfileEditor({ f }: { f: F }) {
  const st = useStore();
  const p = f.s.profile;
  const fileRef = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);
  const [busy, setBusy] = useState(false);
  const locked = f.locked("profile");
  const setPicture = async (file: Blob | null | undefined) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) { st.toast("warn", "Please choose an image (PNG, JPG, WebP, GIF…)"); return; }
    setBusy(true);
    try { await f.set("profile.avatar", await toAvatarDataUrl(file)); } catch (e: any) { st.toast("error", String(e?.message ?? e)); } finally { setBusy(false); }
  };
  return (
    <div className="profile-editor panel" onPaste={(e) => void setPicture([...e.clipboardData.files].find((x) => x.type.startsWith("image/")))}>
      <button className={`profile-pic ${drag ? "drag" : ""}`} disabled={locked} title="Click to choose a picture, or drop / paste one here"
        onClick={() => fileRef.current?.click()}
        onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); setDrag(true); }} onDragLeave={() => setDrag(false)}
        onDrop={(e) => { e.preventDefault(); e.stopPropagation(); setDrag(false); void setPicture(e.dataTransfer.files[0]); }}>
        <UserAvatar size={84} key={p.avatar.slice(-24) + p.hue + p.name} className="pop-in" />
        <span className="profile-pic-overlay">{busy ? <Loader2 size={20} className="spin" /> : <Camera size={20} />}</span>
      </button>
      <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => { void setPicture(e.target.files?.[0]); e.target.value = ""; }} />
      <div className="profile-fields">
        <label className="field"><span>Display name</span>
          <input key={p.name} defaultValue={p.name} placeholder="Your name (shown instead of “You”)" disabled={locked}
            onBlur={(e) => e.target.value.trim() !== p.name && f.set("profile.name", e.target.value.trim())} /></label>
        <div className="row gap wrap">
          <button disabled={locked || busy} onClick={() => fileRef.current?.click()}><ImagePlus size={15} /> {p.avatar ? "Change picture" : "Upload picture"}</button>
          {p.avatar && <button className="ghost danger" disabled={locked} onClick={() => f.set("profile.avatar", "")}><Trash2 size={15} /> Remove picture</button>}
        </div>
        {!p.avatar && <div className="row gap-s wrap">
          <span className="muted small">Colour</span>
          {HUES.map((h) => <button key={h} className={`hue-dot ${p.hue === h ? "on" : ""}`} style={{ "--hue": h } as React.CSSProperties} disabled={locked}
            title="Colour of your initials" onClick={() => f.set("profile.hue", h)} />)}
        </div>}
        <div className="muted small">Square crop, stored only on this PC. Tip: drop or paste an image onto the picture.</div>
      </div>
    </div>
  );
}

function General(f: F) {
  return <>
    <h4>Your profile</h4>
    <ProfileEditor f={f} />
    <h4>App</h4>
    <Row label="Theme"><Choice f={f} path="general.theme" options={[["dark", "Dark"], ["light", "Light"], ["system", "System"]]} /></Row>
    <Row label="Default harness" hint="Used when a chat or role does not pick one; falls back to the first available."><Choice f={f} path="general.defaultHarness" options={harnessOptions} /></Row>
    <Row label="Autopilot for new chats" hint="Agents and specialists work on their own: tool calls are approved automatically and they don't stop to ask for feedback. Blocked commands and read-only mode still apply. Toggle per chat next to the chat box."><Bool f={f} path="general.autopilotDefault" /></Row>
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
    <Row label="Agent tools" hint="Text mode: agents delegate, create agents and use TheFlashMaster's tools (tasks, artifacts, Jazz, DOORS Next) by writing DELEGATE / AGENT / TOOL lines that the app carries out. It works everywhere, also where company policy blocks MCP. Automatic: those tools are offered as MCP tools, with text mode as the fallback when they don't load.">
      <Choice f={f} path="agents.toolMode" options={[["text", "Text mode (default)"], ["auto", "MCP tools, text fallback"]]} /></Row>
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

const MODE_TEXT: Record<DriveMode, string> = {
  local: "🏠 LOCAL — your on-prem / local model (e.g. an Ollama or company-hosted model configured in OpenCode or Pi)",
  eco: "🍃 ECO — cheapest capable model",
  comfort: "🛋️ COMFORT — balanced quality and cost",
  sport: "🏁 SPORT — most capable model",
};

function Modes(f: F) {
  return <>
    <p className="muted">The four buttons under the chat bar switch a chat's model profile in one click. Each mode sets the harness (blank = the chat's
      harness), the model and the thinking level. Model ids are the ones your harness uses — the field suggests what it reports.</p>
    {DRIVE_MODES.map((m) => {
      const p = f.s.modes[m];
      const harness = (p.harness || f.s.general.defaultHarness) as HarnessId;
      return <div key={m} className="panel">
        <h4>{MODE_TEXT[m]}</h4>
        <div className="grid3">
          <label className="field"><span>Harness</span>
            <select value={p.harness} disabled={f.locked(`modes.${m}`)} onChange={(e) => f.set(`modes.${m}.harness`, e.target.value)}>
              <option value="">chat harness / default</option>{HARNESS_IDS.map((h) => <option key={h} value={h}>{h}</option>)}
            </select>
          </label>
          <label className="field"><span>Model</span>
            <ModelInput harness={harness} value={p.model} disabled={f.locked(`modes.${m}`)} placeholder={m === "local" ? "e.g. ollama/qwen3-coder" : "model id"} onChange={(v) => f.set(`modes.${m}.model`, v)} />
          </label>
          <label className="field"><span>Thinking</span>
            <select value={p.thinking} disabled={f.locked(`modes.${m}`)} onChange={(e) => f.set(`modes.${m}.thinking`, e.target.value)}>
              {["", "minimal", "low", "medium", "high", "xhigh"].map((t) => <option key={t} value={t}>{t || "harness default"}</option>)}
            </select>
          </label>
        </div>
      </div>;
    })}
    <p className="muted small">Thinking is applied through Pi's <code>--thinking</code> flag and through the ACP "thought level" option for Copilot/OpenCode when they offer it.
      Switching mode restarts the chat's idle agent sessions with the new model on the next message.</p>
    <h4>Chat</h4>
    <Row label="While an agent is working, Enter…" hint="Steer delivers your message into the running turn (natively in Pi; other harnesses are interrupted and redirected). Queue sends it when the turn finishes. You can switch per message in the chat bar.">
      <Choice f={f} path="chat.defaultSendWhileBusy" options={[["steer", "Steers the agent"], ["queue", "Queues the message"]]} />
    </Row>
    <Row label="Max attachment size (MB)"><Num f={f} path="chat.maxAttachmentMB" min={1} /></Row>
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
      <Choice f={f} path="permissions.approval" options={[["ask", "Ask for every action"], ["auto-read", "Auto-approve reads, ask for changes"], ["auto-all", "Auto-approve everything (default)"]]} />
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
    <Row label="npm registry" hint="Your company's npm mirror (Artifactory/Nexus), if any. Blank = your .npmrc / npmjs.org."><Text f={f} path="mcp.npmRegistry" placeholder="https://registry.npmjs.org" /></Row>
    <h4>Recommended servers</h4>
    <p className="muted small">Installed once into the app data folder and attached only to the agents listed — every server adds its tool definitions to an agent's context, so keep the lists short. npm servers need Node.js/npm only for the download; Python servers use the app's private Python environment.</p>
    {MCP_CATALOG.map((c) => <CatalogCard key={c.id} f={f} c={c} />)}
    <McpSelfTest />
    <div className="row between"><h4>Servers</h4><button disabled={busy} onClick={async () => { setBusy(true); try { await api().mcpReinstall(); } finally { setBusy(false); } }}>{busy ? "Installing…" : "↻ Reinstall / check"}</button></div>
    <table className="table"><thead><tr><th>Server</th><th>Kind</th><th>State</th><th>Enabled</th></tr></thead><tbody>
      {st.mcp.filter((m) => m.kind !== "catalog").map((m) => <tr key={m.id}>
        <td><strong>{m.id}</strong><div className="muted small">{m.label}</div>{m.detail && <div className="muted small">{m.detail}</div>}</td>
        <td>{m.kind}</td><td><span className={`status st-${m.state === "ready" ? "done" : m.state === "error" ? "error" : "paused"}`}>{m.state}</span></td>
        <td>{m.id !== "flashmaster-core" && <input type="checkbox" checked={!f.s.mcp.disabled.includes(m.id)}
          onChange={(e) => f.set("mcp.disabled", e.target.checked ? f.s.mcp.disabled.filter((x) => x !== m.id) : [...f.s.mcp.disabled, m.id])} />}</td>
      </tr>)}
    </tbody></table>
    <div className="row between"><h4>Your MCP servers</h4><button onClick={() => setExt([...ext, { id: `custom-${ext.length + 1}`, label: "", command: "", args: "", env: "", roles: "" }])}>＋ Add</button></div>
    <p className="muted small">Attach a server to agents with <b>roles</b> (comma-separated role names, or <code>*</code> for all), or add its id to a role's <code>tools:</code> list.</p>
    {ext.map((e, i) => <div key={i} className="panel grid3">
      {(["id", "label", "command", "args", "env", "roles"] as const).map((k) => <label key={k} className="field"><span>{k}{k === "env" ? " (KEY=VALUE;…)" : k === "roles" ? " (e.g. reviewer, tester or *)" : ""}</span>
        <input defaultValue={e[k] ?? ""} onBlur={(ev) => setExt(ext.map((x, j) => (j === i ? { ...x, [k]: ev.target.value } : x)))} /></label>)}
      <button className="danger ghost" onClick={() => setExt(ext.filter((_, j) => j !== i))}>Remove</button>
    </div>)}
  </>;
}

function McpSelfTest() {
  const [res, setRes] = useState<{ name: string; ok: boolean; tools: number; detail: string }[] | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="panel selftest">
      <div className="row between">
        <div><strong>Test tool servers</strong><div className="muted small">Starts the servers exactly as Copilot/OpenCode would and lists their tools — use it when agents say their tools are missing.</div></div>
        <button className="primary" disabled={busy} onClick={async () => { setBusy(true); try { setRes(await api().mcpSelfTest()); } finally { setBusy(false); } }}>{busy ? "Testing…" : "Run test"}</button>
      </div>
      {res && <table className="kv"><tbody>{res.map((r) => (
        <tr key={r.name}><td>{r.ok ? "✅" : "❌"} <b>{r.name}</b></td><td className={r.ok ? "" : "warn-text"}>{r.ok ? `${r.tools} tools` : r.detail}</td></tr>
      ))}</tbody></table>}
    </div>
  );
}

function CatalogCard({ f, c }: { f: F; c: CatalogServer }) {
  const st = useStore();
  const state = catalogState(c, f.s.mcp.catalog);
  const status = st.mcp.find((m) => m.id === c.id);
  const [busy, setBusy] = useState(false);
  const locked = f.locked("mcp.catalog");
  const patch = (p: { enabled?: boolean; roles?: string; env?: string }) =>
    f.set("mcp.catalog", { ...f.s.mcp.catalog, [c.id]: { ...(f.s.mcp.catalog[c.id] ?? {}), ...p } });
  const install = async () => { setBusy(true); try { await api().mcpInstall(c.id); } finally { setBusy(false); } };
  const toggleRole = (r: string) => {
    const next = state.roles.includes(r) ? state.roles.filter((x) => x !== r) : [...state.roles.filter((x) => x !== "*"), r];
    void patch({ roles: next.join(",") });
  };
  const all = state.roles.includes("*");
  const envMap = Object.fromEntries(state.env.split(/\r?\n|;/).map((l) => [l.split("=")[0]!.trim(), l.slice(l.indexOf("=") + 1).trim()]).filter(([k]) => k));
  const setEnv = (key: string, value: string) => {
    const m = { ...envMap, [key]: value };
    void patch({ env: Object.entries(m).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join(";") });
  };
  const ready = status?.state === "ready";
  return (
    <div className={`panel catalog-card ${state.enabled ? "" : "off"}`}>
      <div className="row between">
        <div><strong>{c.label}</strong> <a className="small" href={c.homepage} target="_blank" rel="noreferrer">↗</a>
          <div className="muted small">{c.description}</div></div>
        <label className="switch"><input type="checkbox" checked={state.enabled} disabled={locked} onChange={async (e) => {
          await patch({ enabled: e.target.checked });
          if (e.target.checked && !ready) await install();
        }} /><span /></label>
      </div>
      {state.enabled && <>
        <div className="row gap wrap small">
          <span className={`status st-${ready ? "done" : status?.state === "error" ? "error" : "paused"}`}>{busy ? "installing" : status?.state ?? "missing"}</span>
          <span className="muted">{c.runtime === "npm" ? "npm" : "pip"}: {c.package}</span>
          {status?.detail && <span className="muted">{status.detail}</span>}
          <span className="grow" />
          <button className="ghost small" disabled={busy || locked} onClick={install}>{ready ? "↻ Update" : "Install"}</button>
        </div>
        <div className="row gap wrap small">
          <span className="muted">Agents:</span>
          <button className={`chip ${all ? "on" : "off"}`} disabled={locked} onClick={() => patch({ roles: all ? c.roles.join(",") : "*" })}>All agents</button>
          {!all && st.roles.map((r) => <button key={r.name} className={`chip ${state.roles.includes(r.name) ? "on" : "off"}`} disabled={locked} onClick={() => toggleRole(r.name)}>{r.icon} {r.title}</button>)}
        </div>
        {c.env?.map((e) => <div key={e.key} className="row gap small">
          <span className="muted">{e.label}</span>
          <input className="grow" type={e.secret ? "password" : "text"} defaultValue={envMap[e.key] ?? ""} placeholder={e.key} disabled={locked}
            onBlur={(ev) => ev.target.value !== (envMap[e.key] ?? "") && setEnv(e.key, ev.target.value.trim())} />
        </div>)}
      </>}
    </div>
  );
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

function UsageSettings(f: F) {
  const st = useStore();
  const u = st.copilotUsage;
  const p = u?.premium;
  const pct = p?.percent ?? null;
  return <>
    <h4>GitHub Copilot — premium requests</h4>
    <p className="muted">Read only from Copilot CLI’s own <code>/usage</code> command, in a short background session. By default the command is sent only when Copilot lists it as a built-in command, so checking never spends a premium request.</p>
    <div className="panel usage-detail">
      {!u && <div className="muted">Not fetched yet.</div>}
      {u && <>
        <div className="row between">
          <strong>{p?.unlimited ? "Unlimited" : p?.used !== null && p?.limit !== null ? `${p!.used} of ${p!.limit} used` : p?.used !== null ? `${p!.used} used` : "—"}</strong>
          <span className="muted small">{u.loading ? "refreshing…" : `updated ${new Date(u.fetchedAt).toLocaleString()}`}</span>
        </div>
        {pct !== null && <div className="usage-bar big"><div className={`usage-fill ${pct >= 90 ? "crit" : pct >= 75 ? "warn" : "ok"}`} style={{ width: `${Math.min(100, pct)}%` }} /></div>}
        <div className="row gap wrap small">
          {pct !== null && <span className="chip">{pct}% used</span>}
          {p?.limit !== null && p?.used !== null && p?.limit !== undefined && <span className="chip">{Math.max(0, p.limit - (p.used ?? 0))} left</span>}
          {u.resetAt && <span className="chip">resets {u.resetAt}</span>}
        </div>
        {u.error && <div className="warn-note">{u.error}</div>}
        {u.entries.length > 0 && <table className="kv">
          <tbody>{u.entries.map((e, i) => <tr key={i}><td className="muted">{e.label}</td><td>{e.value}</td></tr>)}</tbody>
        </table>}
        {u.raw && <details><summary>Raw /usage output</summary><pre className="pre small">{u.raw}</pre></details>}
      </>}
      <div><button className="primary" disabled={u?.loading} onClick={() => api().copilotUsage(true)}>{u?.loading ? "Refreshing…" : "↻ Refresh now"}</button></div>
    </div>
    <h4>Options</h4>
    <Row label="Show usage bar under the chat box"><Bool f={f} path="usage.copilotMeter" /></Row>
    <Row label="Refresh every (minutes)" hint="0 = only when you press refresh. Minimum 5."><Num f={f} path="usage.refreshMinutes" /></Row>
    <Row label="Only if Copilot lists /usage" hint="Turn off only if your Copilot CLI handles /usage locally but does not list it — otherwise the text may go to a model and use a premium request."><Bool f={f} path="usage.onlyIfAdvertised" /></Row>
    <p className="muted small">Token usage of TheFlashMaster’s own agents (all harnesses) is on the Dashboard.</p>
  </>;
}

function JazzAreas({ f }: { f: F }) {
  const st = useStore();
  const j = f.s.jazz;
  const areas = j.projectAreas?.length ? j.projectAreas : j.projectArea ? [j.projectArea] : [];
  const [add, setAdd] = useState("");
  const [known, setKnown] = useState<string[] | null>(null);
  const [loading, setLoading] = useState(false);
  const locked = f.locked("jazz.projectAreas");
  const save = async (next: string[]) => {
    await f.set("jazz.projectAreas", [...new Set(next.map((x) => x.trim()).filter(Boolean))]);
    if (j.projectArea) await f.set("jazz.projectArea", "");
  };
  const load = async () => {
    setLoading(true);
    try { setKnown(await api().jazzProjectAreas()); } catch (e: any) { st.toast("error", String(e?.message ?? e)); } finally { setLoading(false); }
  };
  return <div className="col gap-s">
    <div className="row gap wrap">
      {areas.length === 0 && <span className="muted small">All areas</span>}
      {areas.map((a) => <span key={a} className="chip">{a}{!locked && <button className="link" title="Remove" onClick={() => save(areas.filter((x) => x !== a))}> ✕</button>}</span>)}
    </div>
    {!locked && <div className="row gap">
      <input className="grow" value={add} placeholder="Project area name" list="jazz-known-areas" onChange={(e) => setAdd(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && add.trim()) { void save([...areas, add]); setAdd(""); } }} />
      <datalist id="jazz-known-areas">{(known ?? []).map((a) => <option key={a} value={a} />)}</datalist>
      <button disabled={!add.trim()} onClick={() => { void save([...areas, add]); setAdd(""); }}>Add</button>
      <button onClick={load} disabled={loading} title="Load the project areas you can see from the server">{loading ? "Loading…" : "↻ From server"}</button>
    </div>}
    {known && known.length > 0 && !locked && <div className="row gap wrap">
      {known.filter((a) => !areas.includes(a)).slice(0, 40).map((a) => <button key={a} className="chip" onClick={() => save([...areas, a])}>＋ {a}</button>)}
    </div>}
  </div>;
}

/** Same logic as the main process (requirements.ts parseRmLink): server root + scope from any DOORS Next link. */
function parseRmLinkUi(input: string): { base: string; componentUri: string; config: string } {
  try {
    const u = new URL(input);
    const p = new URLSearchParams([u.search.slice(1), u.hash.replace(/^#/, "")].filter(Boolean).join("&"));
    const root = u.pathname.split("/").filter(Boolean)[0] ?? "";
    const config = configUri(input) !== input.trim() ? configUri(input) : p.get("oslc_config.context") ?? p.get("vvc.configuration") ?? "";
    // A GCM page (…/gc/web/…) names a configuration, not the requirements server.
    return { base: isGcWebLink(input) ? "" : `${u.origin}${root ? `/${root}` : ""}`, componentUri: p.get("componentURI") ?? "", config };
  } catch { return { base: input.replace(/[#?].*$/, "").replace(/\/+$/, ""), componentUri: "", config: "" }; }
}

function RmSettings({ f }: { f: F }) {
  const st = useStore();
  const [test, setTest] = useState("");
  const [projects, setProjects] = useState<{ id: string; title: string }[] | null>(null);
  const rm = f.s.jazz.rm;
  const derived = f.s.jazz.serverUrl.replace(/[#?].*$/, "").replace(/\/(ccm|jts|qm)(\w*)\/?$/i, "/rm$2");
  return <>
    <h4>IBM DOORS Next — requirements</h4>
    <p className="muted small">Uses the same sign-in as Jazz work items above. Requirement modules are read with the DOORS Next Reportable REST API (read-only) and cached on this PC, so agents can search them quickly with <code>rm_search</code>.</p>
    <Row label="Enabled"><Bool f={f} path="jazz.rm.enabled" /></Row>
    {rm.enabled && <>
      <Row label="Requirements server or link" hint={`Paste the DOORS Next root or any link from the browser (a component or module link also sets the scope). Blank = ${derived || "…/rm"}`}>
        <input key={rm.serverUrl} defaultValue={rm.serverUrl} placeholder={derived || "https://alm.company.com/rm"} disabled={f.locked("jazz.rm")}
          onBlur={async (e) => {
            const v = e.target.value.trim();
            if (v === rm.serverUrl) return;
            const l = parseRmLinkUi(v);
            if (l.base || !l.config) await f.set("jazz.rm.serverUrl", l.base || v);
            if (l.componentUri) await f.set("jazz.rm.component", l.componentUri);
            if (l.config) await f.set("jazz.rm.config", l.config);
            if (!l.base && l.config) st.toast("info", "That is a configuration link: it was set as the configuration, the server stays unchanged.");
            else if (l.base && l.base !== v) st.toast("info", `DOORS Next link recognised: server ${l.base}${l.componentUri ? " + component" : ""}${l.config ? " + configuration" : ""}`);
          }} />
      </Row>
      {rm.component && <Row label="Component" hint="From the pasted link. Its project is used and, if no configuration is set, its default stream.">
        <div className="row gap"><code className="small grow ellipsis" title={rm.component}>{rm.component}</code><button className="ghost small" onClick={() => f.set("jazz.rm.component", "")}>Clear</button></div>
      </Row>}
      <Row label="Projects" hint="Limit to these requirements projects (blank = all you can see).">
        <div className="col gap-s">
          <div className="row gap wrap">
            {rm.projects.length === 0 && <span className="muted small">All projects</span>}
            {rm.projects.map((p) => <span key={p} className="chip">{p} <button className="link" onClick={() => f.set("jazz.rm.projects", rm.projects.filter((x) => x !== p))}>✕</button></span>)}
          </div>
          <div className="row gap wrap">
            <button onClick={async () => { try { setProjects(await api().rmProjects()); } catch (e: any) { st.toast("error", String(e?.message ?? e)); } }}>↻ Load from server</button>
            {projects?.filter((p) => !rm.projects.includes(p.title)).slice(0, 40).map((p) => <button key={p.id} className="chip" onClick={() => f.set("jazz.rm.projects", [...rm.projects, p.title])}>＋ {p.title}</button>)}
          </div>
        </div>
      </Row>
      <Row label="Configuration (optional)" hint="A global configuration (…/gc/configuration/…) reads all contributing components; a local stream or baseline reads one component. Blank = every component of the project with its default stream (discovered automatically). If a global configuration has nothing for a project, its component streams are used.">
        <input key={rm.config} defaultValue={rm.config} placeholder="https://alm.company.com/gc/configuration/… or …/rm/cm/stream/_… (or paste the configuration's web link)" disabled={f.locked("jazz.rm")}
          onBlur={async (e) => { const c = configUri(e.target.value); if (c !== rm.config) await f.set("jazz.rm.config", c); if (c !== e.target.value.trim()) { e.target.value = c; st.toast("info", `Configuration recognised: ${c}`); } }} /></Row>
      <Row label="Cache modules for (hours)" hint="Agents and searches use the cached copy; Refresh in the Requirements tab fetches again."><Num f={f} path="jazz.rm.cacheHours" /></Row>
      <Row label="Connection"><div className="row gap"><button onClick={async () => { setTest("Testing…"); const r = await api().rmTest(); setTest(r.ok ? "✅ " + r.detail : "❌ " + r.detail); }}>Test</button><span>{test}</span></div></Row>
    </>}
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
    <Row label="Project areas" hint="Searches cover all of these unless you narrow them in the Jazz page. Empty = every area you can see."><JazzAreas f={f} /></Row>
    <Row label="Authentication" hint={f.s.jazz.authType === "windows" ? "Uses your Windows login (Kerberos/NTLM) — no password. Restart TheFlashMaster after changing the server URL."
      : f.s.jazz.authType === "browser" ? "For company single sign-on / Jazz Authorization Server (HTTP 401 “Bearer”). You log in once in a sign-in window; the session is kept."
      : "If Test reports HTTP 401, the message says which method the server expects."}>
      <Choice f={f} path="jazz.authType" options={[["basic", "Basic (default)"], ["form", "Form"], ["windows", "Windows (integrated)"], ["browser", "Browser sign-in (SSO)"]]} /></Row>
    {f.s.jazz.authType === "browser" && <Row label="Sign-in"><div className="row gap">
      <button className="primary" onClick={async () => { setTest("Waiting for sign-in…"); const r = await api().jazzSignIn(); setTest(r.ok ? "✅ " + r.detail : "❌ " + r.detail); }}>Sign in to Jazz</button>
      <button className="ghost" onClick={async () => { await api().jazzSignOut(); setTest("Signed out"); }}>Sign out</button>
    </div></Row>}
    {(f.s.jazz.authType === "form" || f.s.jazz.authType === "basic") && <Row label="User"><Text f={f} path="jazz.username" /></Row>}
    {(f.s.jazz.authType === "form" || f.s.jazz.authType === "basic") && <Row label="Password" hint={f.s.jazz.hasPassword ? "Stored encrypted with the OS keychain (Windows DPAPI)." : "Not set."}>
      <div className="row gap"><input type="password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="••••••" />
        <button disabled={!pw} onClick={async () => { await api().jazzSetPassword(pw); setPw(""); st.setSettings((await api().getSettings()).settings); st.toast("info", "Password saved"); }}>Save</button></div>
    </Row>}
    <Row label="Default query"><Text f={f} path="jazz.defaultQuery" placeholder="words or ids shown when the Jazz page opens (optional)" /></Row>
    <Row label="Connection"><div className="row gap"><button onClick={async () => { setTest("Testing…"); const r = await api().jazzTest(); setTest(r.ok ? "✅ " + r.detail : "❌ " + r.detail); }}>Test</button><span>{test}</span></div></Row>
    <RmSettings f={f} />

    <h4>winIDEA (iSYSTEM / TASKING)</h4>
    <Row label="winIDEA install path" hint="Folder or winIDEA.exe; blank = most recently used instance."><Text f={f} path="winidea.installPath" /></Row>
    <Row label="Workspace (.xjrf)"><Text f={f} path="winidea.workspace" /></Row>
    <Row label="Python SDK path" hint="Folder containing isystem/connect.py if the SDK is not pip-installed."><Text f={f} path="winidea.sdkPath" /></Row>

    <h4>EXAM test automation (MicroNova)</h4>
    <p className="muted">Used by the EXAM Test Agent through the EXAM RESTapi plugin. Model fields are defaults the agent can override per request.</p>
    <Row label="Install folder" hint="Folder containing EXAM.exe. Only needed if the agent should start EXAM itself."><Text f={f} path="exam.installPath" /></Row>
    <Row label="RESTapi port" hint="Port of the EXAM RESTapi plugin (default 8085)."><Num f={f} path="exam.restPort" min={1} /></Row>
    <Row label="License server host"><Text f={f} path="exam.licenseHost" /></Row>
    <Row label="License server port"><Num f={f} path="exam.licensePort" min={0} /></Row>
    <Row label="Application server URL" hint="Target endpoint of the EXAM application server holding the models."><Text f={f} path="exam.targetEndpoint" /></Row>
    <Row label="Default model"><Text f={f} path="exam.modelName" /></Row>
    <Row label="Model configuration UUID" hint="EXAM 4.6+ with versioning; blank otherwise."><Text f={f} path="exam.modelConfigUuid" /></Row>
    <Row label="Default system configuration" hint="UUID, ID or full scoped name."><Text f={f} path="exam.systemConfig" /></Row>
    <Row label="Report project" hint="Blank = run without a report database."><Text f={f} path="exam.reportProject" /></Row>
    <Row label="Python for test execution" hint="Blank = EXAM's own setting."><Text f={f} path="exam.pythonPath" /></Row>
    <Row label="Workspace folder" hint="EXAM workspace for headless runs; blank = a temp folder."><Text f={f} path="exam.workspace" /></Row>
    <Row label="Extra Java options"><Text f={f} path="exam.javaOpts" placeholder="-Xmx4g" /></Row>

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
    <Row label="HTTP(S) proxy" hint="host:port, http://user:pass@host:port, socks5://host:port, or a PAC file URL. Blank = environment variables / system proxy."><Text f={f} path="network.proxy" placeholder="from environment" /></Row>
    <Row label="No proxy" hint="Blank = no_proxy environment variable. localhost is always bypassed."><Text f={f} path="network.noProxy" placeholder="from environment" /></Row>
    <Row label="Custom CA bundle (PEM)" hint="For TLS-inspecting corporate proxies."><Text f={f} path="network.caBundlePath" /></Row>
    <Row label="Offline mode" hint="Skip anything that needs the network (MCP installs)."><Bool f={f} path="network.offline" /></Row>
    <ProxyTest />
  </>;
}

function ProxyTest() {
  const [url, setUrl] = useState("");
  const [res, setRes] = useState<{ ok: boolean; detail: string; config: string; resolved: string; source: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async () => { setBusy(true); try { setRes(await api().proxyTest(url)); } finally { setBusy(false); } };
  return (
    <div className="panel selftest">
      <div className="row between">
        <div><strong>Test connection</strong><div className="muted small">Shows which proxy the app uses for an address and tries to reach it. Blank = your Jazz server. If the proxy setup is rejected (ERR_NO_SUPPORTED_PROXIES), the app falls back to the system proxy, then a direct connection.</div></div>
        <button className="primary" disabled={busy} onClick={run}>{busy ? "Testing…" : "Test"}</button>
      </div>
      <input value={url} placeholder="https://alm.company.com/ccm" onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void run(); }} />
      {res && <table className="kv"><tbody>
        <tr><td>{res.ok ? "✅" : "❌"} <b>Result</b></td><td className={res.ok ? "" : "warn-text"}>{res.detail}</td></tr>
        <tr><td><b>Proxy in use</b></td><td>{res.config} <span className="muted small">({res.source})</span></td></tr>
        <tr><td><b>Resolved for this address</b></td><td><code>{res.resolved || "—"}</code></td></tr>
      </tbody></table>}
    </div>
  );
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

function Updates({ f }: { f: F }) {
  const st = useStore();
  const u = st.update;
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>) => { setBusy(true); try { await fn(); } finally { setBusy(false); } };
  const statusText: Record<string, string> = {
    idle: "Not checked yet", disabled: "No update source configured", checking: "Checking…", "up-to-date": "You have the latest version",
    available: `Version ${u?.latest} is available`, downloading: `Downloading ${u?.latest}…`, ready: `Version ${u?.latest} is ready to install`, error: "Update check failed",
  };
  return <>
    <h4>Updates</h4>
    <div className="panel update-panel">
      <div className="row between">
        <div>
          <strong>{statusText[u?.status ?? "idle"]}</strong>
          <div className="muted small">Installed {u?.current ?? "?"} · {u?.mode === "portable" ? "portable exe" : u?.mode === "installer" ? "installed version" : "running from source (no install)"}
            {u?.checkedAt ? ` · checked ${new Date(u.checkedAt).toLocaleString()}` : ""}</div>
        </div>
        <div className="row gap">
          <button disabled={busy || u?.status === "checking" || u?.status === "downloading"} onClick={() => run(() => api().updateCheck())}>↻ Check now</button>
          {u?.status === "available" && <button className="primary" disabled={busy} onClick={() => run(() => api().updateDownload())}>Download</button>}
          {u?.status === "ready" && <button className="primary" onClick={() => api().updateInstall()}>Restart & install</button>}
        </div>
      </div>
      {u?.status === "downloading" && <div className="usage-bar big"><div className="usage-fill ok" style={{ width: `${u.progress ?? 5}%` }} /></div>}
      {u?.notes && (u.status === "available" || u.status === "ready") && <div className="small pre muted">{u.notes}</div>}
      {u?.error && <div className="warn-note small">{u.error}</div>}
      {u?.needsSignIn && <div className="row gap"><button className="primary" onClick={() => run(async () => { const r = await api().updateSignIn(); st.toast(r.ok ? "info" : "error", r.detail); })}>Sign in to GitHub</button>
        <span className="muted small">The repository is private or internal — sign in once (company SSO works), or set a token below.</span></div>}
      <div className="muted small">Source: <code>{u?.feed || "not set"}</code></div>
    </div>
    <Row label="Check automatically" hint="At start and every 6 hours."><Bool f={f} path="updates.autoCheck" /></Row>
    <Row label="Download in the background" hint="Installing always asks first."><Bool f={f} path="updates.autoDownload" /></Row>
    <Row label="Channel"><Choice f={f} path="updates.channel" options={[["stable", "Stable releases"], ["beta", "Include pre-releases"]]} /></Row>
    <Row label="Update source (override)" hint="Normally set in the repository (package.json → flashmaster.updates.url). A GitHub repository URL (github.com or GitHub Enterprise) or a web folder containing latest.json.">
      <Text f={f} path="updates.feedUrl" placeholder="https://github.company.com/team/the-flash-master" /></Row>
    <Row label="GitHub token (optional)" hint={f.s.updates.hasToken ? "A token is stored (encrypted). Paste a new one to replace it, or save empty to remove." : "Only for private repositories when sign-in is not possible: a read-only token (fine-grained: Contents read)."}>
      <div className="row gap"><input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder={f.s.updates.hasToken ? "••••••" : "ghp_… / github_pat_…"} />
        <button onClick={() => run(async () => { await api().updateSetToken(token); setToken(""); st.setSettings((await api().getSettings()).settings); })}>Save</button></div>
    </Row>
  </>;
}

function About({ f }: { f: F }) {
  const [info, setInfo] = useState<{ version: string; dataDir: string; platform: string } | null>(null);
  useEffect(() => { void api().appInfo().then(setInfo); }, []);
  return <div>
    <h3>⚡ TheFlashMaster {info?.version}</h3>
    <Updates f={f} />
    <p className="muted">Desktop orchestrator for AI coding agents on locally authenticated harnesses (GitHub Copilot CLI, OpenCode, Pi, GitLab Duo).</p>
    <p className="small">Data folder: <code>{info?.dataDir}</code><br />Platform: {info?.platform}</p>
    <p className="small muted">Enterprise policy: place <code>%PROGRAMDATA%\TheFlashMaster\policy.json</code> with <code>{"{ \"settings\": {…}, \"lock\": [\"network\", …] }"}</code> to preset and lock settings.</p>
    <p className="small muted">MIT licensed. Superpowers workflow adapted from obra/superpowers (MIT).</p>
  </div>;
}
