import { useEffect, useState, type ReactNode } from "react";
import { api, useStore } from "../store";
import {
  AlertTriangle, Archive, AtSign, BookOpen, Bot, CircleCheck, CircleAlert, ClipboardList, Compass, Download, ExternalLink, FolderPlus, Gauge,
  KeyRound, LifeBuoy, ListChecks, Package, Loader2, LogIn, MousePointerClick, Paperclip, Plane, Puzzle, Rocket, RotateCcw, Settings, Sparkles, SquareKanban, Wrench, Zap,
  CornerDownRight, Leaf,
} from "../components/icons";

const DL = {
  x64: "https://github.com/github/copilot-cli/releases/latest/download/copilot-win32-x64.zip",
  arm64: "https://github.com/github/copilot-cli/releases/latest/download/copilot-win32-arm64.zip",
  releases: "https://github.com/github/copilot-cli/releases",
  docsInstall: "https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/install-copilot-cli",
  docsUse: "https://docs.github.com/en/copilot/how-tos/copilot-cli",
  powershell: "https://github.com/PowerShell/PowerShell/releases/latest",
  pat: "https://github.com/settings/personal-access-tokens/new",
  plans: "https://github.com/features/copilot/plans",
};

const PAGES = [
  { id: "start", label: "Getting started", icon: Rocket },
  { id: "install", label: "Install Copilot CLI", icon: Download },
  { id: "login", label: "Sign in to Copilot", icon: LogIn },
  { id: "use", label: "Using TheFlashMaster", icon: BookOpen },
  { id: "trouble", label: "Troubleshooting", icon: LifeBuoy },
] as const;
type PageId = (typeof PAGES)[number]["id"];

type Check = { found: boolean; path: string | null; version: string | null; signedIn: boolean; detail: string } | null;

export function DocsView({ initialPage }: { initialPage?: string }) {
  const [page, setPage] = useState<PageId>((PAGES.find((p) => p.id === initialPage)?.id ?? "start") as PageId);
  const [check, setCheck] = useState<Check>(null);
  const [checking, setChecking] = useState(false);
  const run = async () => {
    setChecking(true);
    try { setCheck(await api().checkHarness("copilot")); } finally { setChecking(false); }
  };
  useEffect(() => { void run(); }, []);

  return (
    <div className="page docs">
      <header className="page-header"><h2><BookOpen size={20} className="h-icon" /> Documentation</h2></header>
      <div className="docs-layout">
        <nav className="docs-nav">
          {PAGES.map((p) => (
            <button key={p.id} className={page === p.id ? "active" : ""} onClick={() => setPage(p.id)}><p.icon size={16} /> {p.label}</button>
          ))}
          <StatusCard check={check} checking={checking} onCheck={run} onGo={setPage} />
        </nav>
        <article className="docs-body" key={page}>
          {page === "start" && <Start check={check} go={setPage} />}
          {page === "install" && <Install check={check} onChanged={run} />}
          {page === "login" && <Login check={check} checking={checking} onCheck={run} />}
          {page === "use" && <Use />}
          {page === "trouble" && <Trouble />}
        </article>
      </div>
    </div>
  );
}

function StatusCard({ check, checking, onCheck, onGo }: { check: Check; checking: boolean; onCheck: () => void; onGo: (p: PageId) => void }) {
  const projects = useStore((s) => s.projects.length);
  const Row = ({ ok, label, go }: { ok: boolean | null; label: string; go?: PageId }) => <StatusRow ok={ok} label={label} onClick={() => go && onGo(go)} />;
  return (
    <div className="docs-status">
      <div className="muted small">Your setup</div>
      <Row ok={checking && !check ? null : !!check?.found} label="Copilot CLI installed" go="install" />
      <Row ok={checking && !check ? null : !!check?.signedIn} label="Signed in to GitHub" go="login" />
      <Row ok={projects > 0} label="Project folder added" go="use" />
      <button className="ghost small" onClick={onCheck} disabled={checking}>{checking ? <Loader2 size={13} className="spin" /> : <RotateCcw size={13} />} Check again</button>
    </div>
  );
}

function StatusRow({ ok, label, onClick }: { ok: boolean | null; label: string; onClick: () => void }) {
  return (
    <button className={`status-row ${ok ? "ok" : ok === false ? "todo" : ""}`} onClick={onClick}>
      {ok === null ? <Loader2 size={15} className="spin" /> : ok ? <CircleCheck size={15} /> : <CircleAlert size={15} />} {label}
    </button>
  );
}
function UseItem({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return <div className="use-item"><span className="use-icon">{icon}</span><div><b>{title}</b><div>{children}</div></div></div>;
}
function Faq({ q, children }: { q: string; children: ReactNode }) {
  return <details className="faq"><summary>{q}</summary><div>{children}</div></details>;
}

const Step = ({ n, title, children }: { n: number; title: string; children: ReactNode }) => (
  <section className="doc-step"><div className="step-n">{n}</div><div className="step-body"><h4>{title}</h4>{children}</div></section>
);
const Ext = ({ href, children, primary }: { href: string; children: ReactNode; primary?: boolean }) => (
  <a className={`doc-link ${primary ? "primary" : ""}`} href={href} target="_blank" rel="noreferrer">{children} <ExternalLink size={13} /></a>
);
const Note = ({ kind = "info", children }: { kind?: "info" | "warn"; children: ReactNode }) => (
  <div className={`doc-note ${kind}`}>{kind === "warn" ? <AlertTriangle size={16} /> : <Sparkles size={16} />}<div>{children}</div></div>
);

function Start({ check, go }: { check: Check; go: (p: PageId) => void }) {
  return <>
    <h3>Welcome to TheFlashMaster</h3>
    <p>TheFlashMaster is a desktop cockpit for AI coding agents. You chat with <b>TheFlashMaster</b>, a coordinator that splits work across specialist agents — software expert, reviewer, tester, AUTOSAR/Vector expert, winIDEA debugger and more — all running on <b>GitHub Copilot CLI</b> with your own Copilot subscription.</p>
    <div className="doc-cards">
      <button className="doc-card" onClick={() => go("install")}><Download size={22} /><b>1. Install Copilot CLI</b><span>Download the official program from GitHub and point TheFlashMaster to it.</span>{check?.found && <CircleCheck className="done" size={18} />}</button>
      <button className="doc-card" onClick={() => go("login")}><LogIn size={22} /><b>2. Sign in</b><span>Connect Copilot CLI to your GitHub account once.</span>{check?.signedIn && <CircleCheck className="done" size={18} />}</button>
      <button className="doc-card" onClick={() => go("use")}><Rocket size={22} /><b>3. Start working</b><span>Add a project folder, open a chat and describe the task.</span></button>
    </div>
    <Note>You need an active GitHub Copilot subscription. If you get Copilot through your company, the <b>Copilot CLI</b> policy must be enabled by your organization’s admins. <Ext href={DL.plans}>Copilot plans</Ext></Note>
  </>;
}

function Install({ check, onChanged }: { check: Check; onChanged: () => void }) {
  const st = useStore();
  const [picked, setPicked] = useState<string | null>(null);
  return <>
    <h3>Install GitHub Copilot CLI on Windows</h3>
    <p>Copilot CLI is a single program published by GitHub. Download it from the official GitHub release page — no installer, no admin rights and no command line needed.</p>
    <Step n={1} title="Download from GitHub">
      <p>Pick the file for your PC. Almost all company laptops are <b>x64</b>; choose ARM64 only for Snapdragon/ARM devices.</p>
      <div className="row gap wrap">
        <Ext href={DL.x64} primary><Download size={15} /> Windows x64 (.zip)</Ext>
        <Ext href={DL.arm64}><Download size={15} /> Windows ARM64 (.zip)</Ext>
        <Ext href={DL.releases}>All releases</Ext>
      </div>
      <p className="muted small">Links point to the latest release on github.com/github/copilot-cli. GitHub’s guide: <Ext href={DL.docsInstall}>Installing Copilot CLI</Ext></p>
    </Step>
    <Step n={2} title="Unzip it to a permanent folder">
      <p>Right-click the downloaded .zip → <b>Extract All…</b> and choose a folder that stays, for example <code>Documents\Tools\copilot</code>. Avoid leaving it in Downloads, which often gets cleaned up.</p>
    </Step>
    <Step n={3} title="Point TheFlashMaster to copilot.exe">
      <p>Click the button and select <code>copilot.exe</code> in the folder you just extracted.</p>
      <div className="row gap wrap">
        <button className="primary" onClick={async () => {
          const r = await api().pickHarnessExecutable("copilot");
          if (r) { setPicked(r.available ? `Found ${r.version ?? ""}`.trim() : r.detail ?? "Not usable"); onChanged(); }
        }}><MousePointerClick size={15} /> Choose copilot.exe…</button>
        <span className="small">{picked ?? (check?.found ? <span className="ok-text"><CircleCheck size={14} /> Found at {check.path}</span> : <span className="muted">Not found yet</span>)}</span>
      </div>
      <p className="muted small">If Copilot CLI is already installed by your IT department, TheFlashMaster finds it automatically. You can change the path any time in <button className="link" onClick={() => st.setView({ kind: "settings", tab: "harnesses" })}>Settings → Harnesses</button>.</p>
    </Step>
    <Note kind="warn">Copilot CLI on Windows needs <b>PowerShell 7</b> (version 6 or newer) for the commands it runs. Most managed PCs have it; if not, download the .msi from the official <Ext href={DL.powershell}>PowerShell releases on GitHub</Ext>.</Note>
    <h4>Updating</h4>
    <p>Download the newest .zip the same way and extract it over the old folder (close TheFlashMaster first).</p>
  </>;
}

function Login({ check, checking, onCheck }: { check: Check; checking: boolean; onCheck: () => void }) {
  const st = useStore();
  const [launch, setLaunch] = useState<string | null>(null);
  const [token, setToken] = useState("");
  const [tokenSet, setTokenSet] = useState(false);
  useEffect(() => { void api().copilotTokenSet().then(setTokenSet); }, []);
  return <>
    <h3>Sign in to Copilot</h3>
    <p>Copilot CLI signs in with your GitHub account once; the login is stored securely in Windows Credential Manager and reused by TheFlashMaster.</p>
    <h4 className="opt">Option A — sign in with your browser <span className="pill">recommended</span></h4>
    <Step n={1} title="Open Copilot CLI">
      <div className="row gap wrap">
        <button className="primary" disabled={!check?.found} onClick={async () => setLaunch((await api().launchHarness("copilot")).detail)}><Zap size={15} /> Open Copilot CLI</button>
        <span className="small muted">{launch ?? (!check?.found ? "Install Copilot CLI first." : "Opens Copilot in its own window.")}</span>
      </div>
      <p className="small">If it asks whether to trust the folder, choose <b>Yes</b>.</p>
    </Step>
    <Step n={2} title="Type /login and press Enter">
      <p>Inside the Copilot window type <code>/login</code>. Choose <b>GitHub.com</b> (or your company’s GitHub Enterprise host if told so).</p>
    </Step>
    <Step n={3} title="Confirm in the browser">
      <p>Copilot shows a one-time code and opens <b>github.com/login/device</b>. Enter the code, approve, and come back. When Copilot says you are signed in, close its window.</p>
    </Step>
    <Step n={4} title="Check">
      <div className="row gap wrap">
        <button onClick={onCheck} disabled={checking}>{checking ? <Loader2 size={15} className="spin" /> : <RotateCcw size={15} />} Check sign-in</button>
        {check && <span className={`small ${check.signedIn ? "ok-text" : "muted"}`}>{check.signedIn ? <CircleCheck size={14} /> : null} {check.detail}</span>}
      </div>
    </Step>
    <h4 className="opt">Option B — use a GitHub access token</h4>
    <p>Useful when the browser sign-in is blocked. Create a <b>fine-grained personal access token</b> on GitHub with the <b>Copilot Requests</b> permission, then paste it here. TheFlashMaster keeps it encrypted and gives it to Copilot CLI only.</p>
    <div className="row gap wrap">
      <Ext href={DL.pat}><KeyRound size={15} /> Create a token on GitHub</Ext>
      <input type="password" className="grow" value={token} onChange={(e) => setToken(e.target.value)} placeholder={tokenSet ? "A token is saved — paste a new one to replace it" : "github_pat_…"} />
      <button disabled={!token.trim()} onClick={async () => { const r = await api().setCopilotToken(token); setTokenSet(r.tokenSet); setToken(""); st.toast("info", "Token saved"); onCheck(); }}>Save</button>
      {tokenSet && <button className="ghost danger" onClick={async () => { await api().setCopilotToken(""); setTokenSet(false); onCheck(); }}>Remove</button>}
    </div>
  </>;
}

function Use() {
  const Item = UseItem;
  return <>
    <h3>Using TheFlashMaster</h3>
    <div className="use-grid">
      <Item icon={<FolderPlus size={18} />} title="Projects & chats">Add a local folder with the <b>folder +</b> button next to Projects. Each project has chats; agents work inside the project folder. <b>Right-click</b> a chat to rename, pin, reset context, copy as Markdown, archive or delete it (double-click or F2 renames too).</Item>
      <Item icon={<Zap size={18} />} title="Master chat">TheFlashMaster coordinates: describe the goal and it delegates to specialists, collects their short results and reports back.</Item>
      <Item icon={<AtSign size={18} />} title="Specialists">Type <code>@reviewer</code>, <code>@tester</code>, <code>@autosar-vector</code>… to route a message, or click a specialist in the sidebar to open a chat with it.</Item>
      <Item icon={<Leaf size={18} />} title="Drive modes">LOCAL / ECO / COMFORT / SPORT under the chat box switch the model profile for the chat. Configure them in Settings → Modes & chat.</Item>
      <Item icon={<Plane size={18} />} title="Autopilot">When on, tool calls are approved automatically and agents don’t stop to ask. Blocked commands and read-only mode still apply.</Item>
      <Item icon={<CornerDownRight size={18} />} title="Steer or queue">While an agent works, sending a message either steers it right away or queues it for afterwards.</Item>
      <Item icon={<RotateCcw size={18} />} title="Reset context">The ↺ button next to the chat box gives the agents a fresh start: earlier messages stay visible but are no longer sent. Saves tokens when the topic changes.</Item>
      <Item icon={<Paperclip size={18} />} title="Attachments">Attach, paste or drop images and files; agents can read them.</Item>
      <Item icon={<Sparkles size={18} />} title="Superpowers">On demand, a disciplined workflow: brainstorm → plan → test-driven implementation → review → verify.</Item>
      <Item icon={<Package size={18} />} title="Artifacts & diffs">The <b>Artifacts</b> button in a chat lists every file the agents changed (with a side-by-side or unified diff), the project’s uncommitted git changes, saved reports and code blocks. Download single files, patches or everything as one .patch.</Item>
      <Item icon={<Compass size={18} />} title="Progress">The Progress panel shows each agent’s plan, delegations and approvals as a flow chart.</Item>
      <Item icon={<Bot size={18} />} title="Agents overview">See every running agent, pause, resume or stop it.</Item>
      <Item icon={<SquareKanban size={18} />} title="Tasks">A simple board; “Run with agent” hands a task to its assigned specialist.</Item>
      <Item icon={<ClipboardList size={18} />} title="Jazz work items">Search, read and comment on IBM Jazz items and send them to an agent for analysis (Settings → Integrations).</Item>
      <Item icon={<ListChecks size={18} />} title="Requirements (DOORS Next)">IBM Jazz → Requirements: pick a project and module, read it by section, search it, select requirements and click <b>Analyse</b>. Agents search modules themselves with <code>rm_search</code> and read details with <code>rm_get</code>, so only relevant requirements enter their context.</Item>
      <Item icon={<Puzzle size={18} />} title="Marketplace">Install agents, workflows and team rules published by your department.</Item>
      <Item icon={<Gauge size={18} />} title="Usage">The bar under the chat box shows your Copilot premium requests; details in Settings → Usage.</Item>
      <Item icon={<Wrench size={18} />} title="Tools (MCP)">Context7, MarkItDown and other tools are installed automatically and given to the agents that need them (Settings → MCP).</Item>
      <Item icon={<Archive size={18} />} title="Archive">Archived chats are hidden; show them from the project’s right-click menu or the “Show archived” link.</Item>
      <Item icon={<Settings size={18} />} title="Settings">Everything is configurable; settings marked with a lock are managed by your organisation.</Item>
    </div>
    <p className="muted small">More about Copilot CLI itself: <Ext href={DL.docsUse}>GitHub Docs — Copilot CLI</Ext></p>
  </>;
}

function Trouble() {
  const Q = Faq;
  return <>
    <h3>Troubleshooting</h3>
    <Q q="“Copilot CLI not found”">Use <b>Install Copilot CLI → Choose copilot.exe…</b> and select the program in the folder you extracted. If the file was removed by a cleanup, download it again.</Q>
    <Q q="Agents answer with an authentication or 401 error">Copilot CLI is not signed in or the sign-in expired. Follow <b>Sign in to Copilot</b> again, or use a token (Option B).</Q>
    <Q q="“Copilot CLI is disabled by your organization”">Your company’s GitHub admins must enable the Copilot CLI policy for you. Contact your IT/GitHub administrator.</Q>
    <Q q="“delegate tool not available” / TheFlashMaster can’t start specialists">TheFlashMaster’s tools reach Copilot as MCP servers. If your organisation’s <b>MCP servers in Copilot</b> policy is off, Copilot blocks them all and the chat shows <i>“MCP servers blocked by policy”</i>. Ask your GitHub admin to enable that policy (organisation settings → Copilot → Policies). <b>Text mode</b> is the default and avoids this entirely: agents write <code>DELEGATE role: brief</code>, <code>AGENT … END</code> and <code>TOOL name {"…"}</code> lines and the app carries them out (Settings → Agents → Agent tools). With <i>MCP tools, text fallback</i>, run <b>Settings → MCP → Test tool servers</b> for other causes.</Q>
    <Q q="Nothing happens behind the company proxy">TheFlashMaster passes your <code>https_proxy</code> / <code>http_proxy</code> settings to Copilot CLI. You can also set a proxy in Settings → Network.</Q>
    <Q q="Commands fail on Windows">Copilot CLI needs PowerShell 7. Install it from the official PowerShell releases on GitHub (see Install page).</Q>
    <Q q="The usage bar doesn’t show">The bar uses Copilot CLI’s own <code>/usage</code>. Older versions don’t offer it to apps — update Copilot CLI. Details in Settings → Usage.</Q>
    <Q q="An agent got confused or the chat is very long">Click <b>Reset context</b> (↺ next to the chat box) to start the agents fresh, keeping the messages visible.</Q>
  </>;
}
