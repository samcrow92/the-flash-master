import { Fragment, createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { api, useStore } from "../store";
import {
  AlertTriangle, Archive, AtSign, BookOpen, Bot, CircleCheck, CircleAlert, ClipboardList, Compass, Download, ExternalLink, FolderPlus, Gauge,
  KeyRound, LifeBuoy, ListChecks, Package, Loader2, LogIn, MousePointerClick, Paperclip, Plane, Puzzle, Rocket, RotateCcw, Settings, Sparkles, SquareKanban, Wrench, Zap,
  CornerDownRight, Leaf, Users, Lightbulb, FileText, FlaskConical, ScanSearch, ShieldCheck, Bug, Swords,
  RoleIcon, User, ChevronRight, MessageCircle,
} from "../components/icons";
import { AGENT_DOCS, type AgentDoc } from "./agentDocs";

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
  { id: "agents", label: "Agents & when to use them", icon: Users },
  { id: "superpowers", label: "Superpowers workflow", icon: Sparkles },
  { id: "trouble", label: "Troubleshooting", icon: LifeBuoy },
] as const;
type PageId = (typeof PAGES)[number]["id"];
/** A top-level page, or one agent's page ("agent:reviewer"). */
type Page = PageId | `agent:${string}`;
const agentOf = (p: Page) => (p.startsWith("agent:") ? AGENT_DOCS.find((a) => `agent:${a.name}` === p) : undefined);

/** Lets pages link to each other without threading a callback through every component. */
const DocsNav = createContext<(p: Page) => void>(() => {});
const PageLink = ({ to, children }: { to: Page; children: ReactNode }) => {
  const go = useContext(DocsNav);
  return <button className="link" onClick={() => go(to)}>{children}</button>;
};

type Check = { found: boolean; path: string | null; version: string | null; signedIn: boolean; detail: string } | null;

export function DocsView({ initialPage }: { initialPage?: string }) {
  const [page, setPage] = useState<Page>(() => {
    const p = initialPage as Page | undefined;
    return p && (PAGES.some((x) => x.id === p) || agentOf(p)) ? p : "start";
  });
  const agent = agentOf(page);
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
            <Fragment key={p.id}>
              <button className={page === p.id ? "active" : ""} onClick={() => setPage(p.id)}><p.icon size={16} /> {p.label}</button>
              {p.id === "agents" && (page === "agents" || agent) && AGENT_DOCS.map((a) => (
                <button key={a.name} className={`sub ${agent?.name === a.name ? "active" : ""}`} onClick={() => setPage(`agent:${a.name}`)}>
                  <RoleIcon role={a.name} size={18} /> {a.title}
                </button>
              ))}
            </Fragment>
          ))}
          <StatusCard check={check} checking={checking} onCheck={run} onGo={setPage} />
        </nav>
        <DocsNav.Provider value={setPage}>
        <article className="docs-body" key={page}>
          {page === "start" && <Start check={check} go={setPage} />}
          {page === "install" && <Install check={check} onChanged={run} />}
          {page === "login" && <Login check={check} checking={checking} onCheck={run} />}
          {page === "use" && <Use />}
          {page === "agents" && <Agents />}
          {agent && <AgentPage doc={agent} />}
          {page === "superpowers" && <Superpowers />}
          {page === "trouble" && <Trouble />}
        </article>
        </DocsNav.Provider>
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
    <p>Not sure which specialist to ask? See <PageLink to="agents">Agents &amp; when to use them</PageLink>. For feature work that must be right the first time, turn on the <PageLink to="superpowers">Superpowers workflow</PageLink>.</p>
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
      <Item icon={<Sparkles size={18} />} title="Superpowers">On demand, a disciplined workflow: brainstorm → plan → test-driven implementation → review → verify. <PageLink to="superpowers">How it works</PageLink></Item>
      <Item icon={<Package size={18} />} title="Artifacts & diffs">The <b>Artifacts</b> button in a chat lists every file the agents changed (with a side-by-side or unified diff), the project’s uncommitted git changes, saved reports and code blocks. Download single files, patches or everything as one .patch.</Item>
      <Item icon={<Compass size={18} />} title="Progress">The Progress panel shows each agent’s plan, delegations and approvals as a flow chart.</Item>
      <Item icon={<Bot size={18} />} title="Agents overview">See every running agent, pause, resume or stop it. Click an agent card, or <b>Chat</b> on a row, to open its chat.</Item>
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

/* ───────────────────────── Agents ───────────────────────── */

function Agents() {
  const roles = useStore((s) => s.roles);
  const custom = roles.filter((r) => r.source === "user" && !AGENT_DOCS.some((a) => a.name === r.name));
  const overridden = new Set(roles.filter((r) => r.source === "user").map((r) => r.name));
  return <>
    <h3>Agents &amp; when to use them</h3>
    <p>Every agent is a role with its own instructions and tools. In the master chat <b>TheFlashMaster</b> picks agents for you; you can also talk to one directly by typing <code>@name</code> or clicking it in the sidebar.</p>

    <h4>Quick picker</h4>
    <table className="docs-table">
      <thead><tr><th>You want to…</th><th>Ask</th></tr></thead>
      <tbody>
        <tr><td>Get a multi-step goal done, or you aren’t sure who to ask</td><td><PageLink to="agent:flashmaster"><code>TheFlashMaster</code></PageLink> (master chat)</td></tr>
        <tr><td>Make a vague request or work item testable; see what a change affects</td><td><PageLink to="agent:analyst"><code>@analyst</code></PageLink></td></tr>
        <tr><td>Decide on a design or module structure</td><td><PageLink to="agent:architect"><code>@architect</code></PageLink></td></tr>
        <tr><td>Stress-test a plan, design or result before committing to it</td><td><PageLink to="agent:challenger"><code>@challenger</code></PageLink></td></tr>
        <tr><td>Write, fix or refactor code</td><td><PageLink to="agent:software-expert"><code>@software-expert</code></PageLink></td></tr>
        <tr><td>Review a diff before committing</td><td><PageLink to="agent:reviewer"><code>@reviewer</code></PageLink></td></tr>
        <tr><td>Write or run unit / integration / CAPL tests</td><td><PageLink to="agent:tester"><code>@tester</code></PageLink></td></tr>
        <tr><td>Create or run HiL/SiL tests in EXAM</td><td><PageLink to="agent:exam-test-agent"><code>@exam-test-agent</code></PageLink></td></tr>
        <tr><td>Work with DBC, ARXML, CDD, DaVinci, CANoe or CAPL</td><td><PageLink to="agent:autosar-vector"><code>@autosar-vector</code></PageLink></td></tr>
        <tr><td>Debug on the target hardware</td><td><PageLink to="agent:winidea-debugger"><code>@winidea-debugger</code></PageLink></td></tr>
        <tr><td>Triage or update Jazz work items</td><td><PageLink to="agent:jazz-analyst"><code>@jazz-analyst</code></PageLink></td></tr>
        <tr><td>Find the root cause of a problem (NOW + Ishikawa)</td><td><PageLink to="agent:rca-analyst"><code>@rca-analyst</code></PageLink></td></tr>
        <tr><td>Build or update a PowerPoint deck</td><td><PageLink to="agent:presentation-expert"><code>@presentation-expert</code></PageLink></td></tr>
      </tbody>
    </table>

    <h4>Built-in agents</h4>
    <p className="muted small">Each agent has its own page with its purpose, what it can do, example flows and prompts to try.</p>
    <div className="agent-grid">
      {AGENT_DOCS.map((a) => (
        <PageCard key={a.name} doc={a} customised={overridden.has(a.name)} />
      ))}
    </div>

    <h4>How the agents work together</h4>
    <div className="agent-lanes">
      <div><b>Understand</b><span>Requirements Analyst, Jazz Work Item Analyst</span></div>
      <div><b>Decide</b><span>Software Architect, Challenger</span></div>
      <div><b>Build</b><span>Software Expert, AUTOSAR &amp; Vector Expert</span></div>
      <div><b>Prove</b><span>Code Reviewer, Test Engineer, EXAM Test Agent, winIDEA Debug Engineer</span></div>
      <div><b>Explain</b><span>NOW Analysis &amp; RCA, Presentation Expert</span></div>
    </div>
    <p className="small muted">TheFlashMaster moves work through these stages, and the <PageLink to="superpowers">Superpowers workflow</PageLink> makes the order strict.</p>

    {custom.length > 0 && <>
      <h4>Your custom agents</h4>
      <p className="muted small">Agents you imported, installed from the Marketplace, or that TheFlashMaster created for you.</p>
      <div className="use-grid">
        {custom.map((r) => (
          <UseItem key={r.name} icon={<RoleIcon role={r.name} emoji={r.icon} size={22} />} title={`${r.title} (@${r.name})`}>{r.description}</UseItem>
        ))}
      </div>
    </>}

    <h4>Tips</h4>
    <ul className="docs-list">
      <li><b>One expert or a team?</b> A direct <code>@mention</code> runs one agent. The master chat may run several, which costs more requests but covers more ground.</li>
      <li><b>Tools follow the agent.</b> Each agent only gets the tool servers listed on its page. Add or change tools in Settings → Agents.</li>
      <li><b>Short results.</b> Specialists return a compact summary to whoever delegated to them; long output goes into Artifacts.</li>
      <li><b>Make your own.</b> Import an agent file (<code>agents/_template.md</code>) from Settings → Agents, the ＋ next to Specialists, or by dropping the .md onto the window. Reusing a built-in name overrides it.</li>
      <li><b>Workflow skills per agent.</b> An agent file can list <code>skills:</code> (brainstorm, plan, execute, tdd, debug, review, verify) that load on its first turn. See <PageLink to="superpowers">Superpowers workflow</PageLink>.</li>
    </ul>
  </>;
}

function PageCard({ doc: a, customised }: { doc: AgentDoc; customised: boolean }) {
  const go = useContext(DocsNav);
  return (
    <button className="agent-card" onClick={() => go(`agent:${a.name}`)}>
      <RoleIcon role={a.name} size={30} />
      <div>
        <b>{a.title}</b>{customised && <span className="pill">customised</span>}
        <code>@{a.name}</code>
        <span className="muted small">{a.summary}</span>
      </div>
      <ChevronRight size={16} className="agent-card-go" />
    </button>
  );
}

function Actor({ actor }: { actor: string }) {
  if (actor === "you") return <span className="flow-actor"><span className="flow-dot you"><User size={13} /></span> You</span>;
  if (actor.startsWith("tool:")) return <span className="flow-actor"><span className="flow-dot tool"><Wrench size={12} /></span> <code>{actor.slice(5)}</code></span>;
  const d = AGENT_DOCS.find((a) => a.name === actor);
  return <span className="flow-actor"><RoleIcon role={actor} size={22} /> {d?.title ?? actor}</span>;
}

function AgentPage({ doc: a }: { doc: AgentDoc }) {
  const roles = useStore((s) => s.roles);
  const role = roles.find((r) => r.name === a.name);
  const chatWithAgent = useStore((s) => s.chatWithAgent);
  const i = AGENT_DOCS.indexOf(a);
  const prev = AGENT_DOCS[i - 1], next = AGENT_DOCS[i + 1];
  return <>
    <p className="small"><PageLink to="agents">Agents</PageLink> <span className="muted">/ {a.title}</span></p>
    <header className="agent-hero">
      <RoleIcon role={a.name} size={46} />
      <div>
        <h3>{a.title}</h3>
        <div className="row gap wrap"><code>@{a.name}</code>{role?.source === "user" && <span className="pill amber">customised in your setup</span>}</div>
      </div>
      {role && <button className="primary agent-hero-chat" onClick={() => chatWithAgent(a.name)}><MessageCircle size={15} /> Chat with {a.title}</button>}
    </header>

    <h4>Purpose</h4>
    <p>{a.purpose}</p>

    <div className="agent-doc-cols">
      <div className="agent-doc"><h5><Wrench size={14} /> What it can do</h5><ul>{a.can.map((c) => <li key={c}>{c}</li>)}</ul></div>
      <div className="agent-doc"><h5><Lightbulb size={14} /> Use it when</h5><ul>{a.when.map((c) => <li key={c}>{c}</li>)}</ul></div>
    </div>
    {a.instead && <Note>{a.instead}</Note>}

    <h4>What you get back</h4>
    <p>{a.output}</p>

    {a.flows.map((f) => (
      <section key={f.title} className="agent-flow">
        <h4><Compass size={16} /> Example flow: {f.title}</h4>
        <ol className="flow">
          {f.steps.map((st, k) => (
            <li key={k} className={st.actor === "you" ? "you" : st.actor.startsWith("tool:") ? "tool" : ""}>
              <Actor actor={st.actor} />
              <div>{st.text}</div>
            </li>
          ))}
        </ol>
      </section>
    ))}

    <h4>Prompts to try</h4>
    <div className="prompt-list">
      {a.prompts.map((p) => <div key={p} className="prompt"><AtSign size={14} /> <span>{a.name === "flashmaster" ? "" : `@${a.name} `}{p}</span></div>)}
    </div>

    {a.tips && a.tips.length > 0 && <>
      <h4>Tips</h4>
      <ul className="docs-list">{a.tips.map((t, k) => <li key={k}>{t}</li>)}</ul>
    </>}

    <h4>Tools</h4>
    <div className="agent-doc-tools">{(role?.tools ?? a.tools).map((t) => <span key={t} className="pill">{t}</span>)}</div>
    <p className="muted small">The tool servers this agent may use{role?.source === "user" ? " in your setup" : ""}. The agent’s full instructions are in <code>agents/{a.name}.md</code>; override them by importing an agent with the same name.</p>

    <div className="agent-pager">
      {prev ? <PageLink to={`agent:${prev.name}`}>← {prev.title}</PageLink> : <span />}
      {next ? <PageLink to={`agent:${next.name}`}>{next.title} →</PageLink> : <span />}
    </div>
  </>;
}

/* ───────────────────────── Superpowers ───────────────────────── */

const SP_PHASES: { n: number; cmd: string; title: string; icon: ReactNode; who: string; body: ReactNode }[] = [
  {
    n: 1, cmd: "brainstorm", title: "Brainstorm: agree on what to build", icon: <Lightbulb size={16} />, who: "TheFlashMaster with you; Analyst or Architect for research",
    body: <>The agent reads the relevant code first, then asks one question at a time, only when the answer changes what gets built. It offers 2–3 genuinely different approaches with trade-offs, recommends one, and writes a short design: intent, goals and non-goals, the chosen approach, open points. <b>No code, scaffolding or installs until you approve the design.</b></>,
  },
  {
    n: 2, cmd: "plan", title: "Plan: small, verifiable tasks", icon: <FileText size={16} />, who: "TheFlashMaster or Architect; reviewed by the Challenger",
    body: <>The approved design becomes a plan any engineer could follow: tasks of 2–10 minutes in dependency order, each with the files to touch, the test to write first and the exact command that proves it works. Independent tasks are marked so they can run in parallel. Nothing beyond the design (YAGNI). The <b>Challenger</b> reviews the plan and its must-fix items are resolved before execution. The plan is saved as an artifact or in <code>docs/plans/</code>.</>,
  },
  {
    n: 3, cmd: "execute", title: "Execute: task by task, delegated", icon: <Zap size={16} />, who: "TheFlashMaster delegates to the Software Expert, Tester and others",
    body: <>Tasks run in order; independent ones are delegated in parallel with a precise brief (task text, files, acceptance). After each task its verification command runs and non-trivial changes go to the Reviewer. The task board is updated as work moves. If a task’s assumptions turn out wrong, the agent stops and reports instead of improvising scope.</>,
  },
  {
    n: 4, cmd: "tdd", title: "Test-driven development inside each task", icon: <FlaskConical size={16} />, who: "Software Expert and Tester",
    body: <><b>Red:</b> write one small test for the next behaviour and watch it fail for the right reason. <b>Green:</b> write the minimum code to pass. <b>Refactor:</b> clean up with all tests green. No production code without a failing test that demands it. For embedded targets the logic is tested on the host and the hardware layers are kept thin.</>,
  },
  {
    n: 5, cmd: "review", title: "Review against the plan", icon: <ScanSearch size={16} />, who: "Code Reviewer (and Challenger for the overall result)",
    body: <>Each completed task is checked against the plan: does it do what was asked, no more and no less; are there correctness, error-handling, security or concurrency issues; do the tests test behaviour? Findings come as blockers, majors and minors with file:line and a fix. Blockers are fixed before moving on. When an agent receives a review, it verifies each point and pushes back with evidence when a suggestion is wrong.</>,
  },
  {
    n: 6, cmd: "verify", title: "Verify: evidence before claims", icon: <ShieldCheck size={16} />, who: "Whoever claims the work is done",
    body: <>Before saying anything is done, fixed or passing, the agent runs the real build, test and lint commands, reads the output and reports the exact commands and results (counts, exit codes). Anything that could not be verified is said plainly.</>,
  },
];

function Superpowers() {
  const skills = useStore((s) => s.skills);
  const extra = skills.filter((k) => k.command !== "superpowers-index" && !SP_PHASES.some((p) => p.cmd === k.command) && k.command !== "debug");
  return <>
    <h3>Superpowers workflow</h3>
    <p>Superpowers is a disciplined way of working for feature work and bug fixes: <b>brainstorm → plan → execute with TDD → review → verify</b>. It trades a little speed up front for work that is right the first time: agreed intent, small tested steps, reviewed changes and proof that it works. It is adapted from the open-source <Ext href="https://github.com/obra/superpowers">obra/superpowers</Ext> workflow (MIT).</p>

    <div className="doc-cards">
      <div className="doc-card static"><Sparkles size={22} /><b>Turn it on for a chat</b><span>Click <b>Superpowers</b> under the chat box, or type <code>/superpowers</code>. Type it again to turn it off. It is off by default.</span></div>
      <div className="doc-card static"><Zap size={22} /><b>Or load one phase</b><span>Type <code>/brainstorm</code>, <code>/plan</code>, <code>/execute</code>, <code>/tdd</code>, <code>/debug</code>, <code>/review</code> or <code>/verify</code> before a message to apply just that skill to it.</span></div>
      <div className="doc-card static"><Bot size={22} /><b>Or give it to an agent</b><span>List skills in an agent file (<code>skills: [tdd, verify]</code>) and they load on that agent’s first turn.</span></div>
    </div>

    <Note>It costs little: with Superpowers on, only a short index of the workflow is sent to the agents when a session starts. The full guidance for a phase is loaded only when that phase’s command is used.</Note>

    <h4>The phases</h4>
    <p>With Superpowers on, the agents tell you which phase they are in. Each phase has a slash command that loads its full guidance.</p>
    {SP_PHASES.map((p) => (
      <Step key={p.cmd} n={p.n} title={p.title}>
        <p className="sp-meta"><span className="pill">{p.icon} /{p.cmd}</span> <span className="muted small">{p.who}</span></p>
        <p>{p.body}</p>
      </Step>
    ))}

    <h4 className="opt"><Bug size={16} /> Bugs: systematic debugging <span className="pill">/debug</span></h4>
    <p>For a defect, the workflow replaces guessing with evidence: reproduce reliably and capture the exact symptom; read the code path and list 2–3 ranked hypotheses; design the cheapest observation (log, assert, breakpoint, test) that tells them apart; confirm the root cause; then write a failing test for the bug, fix it, run the full relevant suite and explain why it happened. On hardware, the <b>winIDEA Debug Engineer</b> follows the same method on target.</p>

    <h4>Who does what</h4>
    <table className="docs-table">
      <thead><tr><th>Phase</th><th>Typical agents</th></tr></thead>
      <tbody>
        <tr><td>Brainstorm</td><td>TheFlashMaster (talks with you), Analyst for requirements and impact, Architect for options</td></tr>
        <tr><td>Plan</td><td>TheFlashMaster or Architect writes it; <b>Challenger</b> must approve it</td></tr>
        <tr><td>Execute + TDD</td><td>Software Expert, Tester, AUTOSAR &amp; Vector Expert, EXAM Test Agent, as the task needs</td></tr>
        <tr><td>Review</td><td>Code Reviewer per task; Challenger for the finished result</td></tr>
        <tr><td>Verify</td><td>The agent that did the work, showing real command output</td></tr>
      </tbody>
    </table>

    <h4>When to use it</h4>
    <div className="use-grid">
      <UseItem icon={<CircleCheck size={18} />} title="Turn it on for">New features, changes to interfaces or configuration, refactorings, anything safety-relevant or hard to undo, and bugs whose cause is unknown.</UseItem>
      <UseItem icon={<CircleAlert size={18} />} title="Leave it off for">Questions, quick lookups, one-line fixes, reviews of existing work, and documents or decks. The extra phases add requests without adding value there.</UseItem>
      <UseItem icon={<Swords size={18} />} title="Use single phases">Just want a second opinion? <code>/review</code>. About to say “done”? <code>/verify</code>. Unsure what to build? <code>/brainstorm</code>. They work with Superpowers on or off.</UseItem>
      <UseItem icon={<Plane size={18} />} title="With Autopilot">Autopilot approves tool calls automatically, but Superpowers still stops for your approval of the design. That decision is yours.</UseItem>
    </div>

    <h4>Example</h4>
    <ol className="docs-list">
      <li>You type <code>/superpowers</code>, then “Add a DID that reports the cold-start counter.”</li>
      <li>TheFlashMaster asks the Analyst and AUTOSAR &amp; Vector Expert for the impact (CDD, Dcm config, NvM), offers two approaches and asks you to pick one. You approve the short design.</li>
      <li>It writes a plan of six tasks; the Challenger flags a missing NvM write-cycle limit, and the plan is updated.</li>
      <li>The Software Expert implements each task test-first; the Reviewer checks each one.</li>
      <li>Before reporting back, the build and tests are run and their output is shown in the reply.</li>
    </ol>

    {extra.length > 0 && <>
      <h4>Other workflow skills</h4>
      <div className="use-grid">{extra.map((k) => <UseItem key={k.command} icon={<Sparkles size={18} />} title={`/${k.command}`}>{k.description}</UseItem>)}</div>
    </>}
    <p className="muted small">The skill texts live in <code>skills/superpowers/</code>. Type <code>/help</code> in any chat to list every command.</p>
  </>;
}
