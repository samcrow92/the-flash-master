import { fixPath } from "./shell-path";
import { app, BrowserWindow, dialog, ipcMain, nativeImage, safeStorage, session, shell, Notification } from "electron";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import type { FlashApi } from "@shared/api";
import type { AppEvent, RoleDef, SkillDef, WindowState } from "@shared/types";
import { Db } from "./db";
import { SettingsStore } from "./settings-store";
import { HarnessRegistry } from "./harness/registry";
import { DuoAdapter } from "./harness/duo";
import { Orchestrator } from "./orchestrator";
import { Bridge } from "./bridge";
import { buildTools } from "./tools";
import { MemoryStore } from "./memory";
import { KnowledgeBase, ensureFlashmasterIgnore } from "./knowledge";
import { CodeGraph, GRAPHIFY_MIN_PYTHON, GRAPHIFY_PACKAGE } from "./graphify";
import { noProjectFolder } from "./worktree";
import { McpBootstrap, selfTestServer } from "./mcp";
import { JazzClient, type FetchLike } from "./jazz";
import { LiveLedger, copilotHome, parseSessionUsage, scanSessionLogs, summarizeLocal, toUsage } from "./copilot-ledger";
import { fetchQuota, findCopilotToken, type Exec, type Quota } from "./copilot-quota";
import { Requirements, parseRmLink } from "./requirements";
import { resolveLink } from "./links";
import { EtmClient } from "./etm";
import { ScmClient, type CliRunner } from "./scm";
import { findScmCli, scmCliRunner } from "./scm-cli";
import { SecretStore } from "./secrets";
import { Updater, parseFeed } from "./updater";
import { currentProxyEnv, setProxyEnv } from "./win-env";
import { parseProxy, fallbacks, isProxySetupError, describe, explainProxyError, type ProxyCfg, type ParsedProxy } from "./proxy";
import type { CopilotUsage } from "@shared/types";
import { loadRoles, loadSkills, parseRole, roleMarkdown, slugRole, validateRole, type AgentSpec } from "./roles";
import type { AgentImportResult, Attachment, HarnessId, HarnessModels } from "@shared/types";
import { randomUUID } from "node:crypto";
import { HARNESS_IDS } from "@shared/types";
import { DEFAULT_SETTINGS } from "@shared/settings";
import { networkEnv } from "./orchestrator";
import { prepareInstructions } from "./harness/instructions";
import { makeLogger } from "./log";
import { guardWebContents } from "./crash-guard";
import { Marketplace, normaliseUrl, validatePackage, type MarketplaceSource } from "./marketplace";
import { FlashServerClient, SubmissionWatcher, serverBase } from "./flash-server";
import { buildPackage, draftFor, guessKind } from "./plugin-builder";
import type { Submission, SubmitResult } from "@shared/types";
import { runSmoke } from "./smoke";
import { iconCandidates, windowsAppDetails } from "./app-icon";
import { Terminals } from "./terminal";
import { runTaskCleanup } from "./task-cleanup";

const here = dirname(fileURLToPath(import.meta.url));
app.setName("TheFlashMaster");
if (!app.requestSingleInstanceLock()) app.quit();

// FLASH_DATA_DIR overrides the data folder (isolated test runs, or keeping data next to a portable exe).
// Finder/Dock launches on macOS start with a minimal PATH: take the login shell's, so agent CLIs are found.
fixPath();
if (process.env.FLASH_DATA_DIR) app.setPath("userData", process.env.FLASH_DATA_DIR);
const dataDir = app.getPath("userData");
mkdirSync(dataDir, { recursive: true });
const resources = app.isPackaged ? process.resourcesPath : app.getAppPath();
/**
 * The lightning-bolt app icon for every window. The .ico carries all sizes (16–256 px, small frames as BMP). It is loaded
 * once as an image, falling back to the PNG when the .ico can't be read, so a bad path or file shows in the log (and fails
 * the smoke test) instead of silently leaving the taskbar without an icon. On Windows the taskbar button also needs the
 * app ID and the per-window relaunch icon (windowsAppDetails explains why), set on every window as it is created.
 */
const appIcon = (() => {
  const files = iconCandidates({ platform: process.platform, dirs: [app.isPackaged ? process.resourcesPath : undefined, app.getAppPath(), join(here, "..", ".."), process.cwd()] });
  for (const file of files.filter((f) => existsSync(f))) {
    const img = nativeImage.createFromPath(file);
    if (!img.isEmpty()) return Object.assign(img, { file });
  }
  return Object.assign(nativeImage.createEmpty(), { file: "" });
})();
const winDetails = process.platform === "win32"
  ? windowsAppDetails({ packaged: app.isPackaged, execPath: process.execPath, appPath: app.getAppPath(), iconFile: appIcon.file.endsWith(".ico") ? appIcon.file : "", portableExe: process.env.PORTABLE_EXECUTABLE_FILE })
  : null;
if (winDetails) {
  app.setAppUserModelId(winDetails.appId);
  app.on("browser-window-created", (_e, w) => w.setAppDetails(winDetails));
}
const userRolesDir = join(dataDir, "agents");
mkdirSync(userRolesDir, { recursive: true });
const userSkillsDir = join(dataDir, "skills"); // workflows installed from marketplaces
mkdirSync(userSkillsDir, { recursive: true });
const policyFile = process.platform === "win32" ? join(process.env.PROGRAMDATA ?? "C:\\ProgramData", "TheFlashMaster", "policy.json") : join(dataDir, "policy.json");

const settings = new SettingsStore(join(dataDir, "settings.json"), policyFile);
const log = makeLogger(join(dataDir, "logs"), () => settings.get().advanced.logLevel);
log("info", `starting TheFlashMaster ${app.getVersion()}`);
if (appIcon.isEmpty()) log("error", "app icon not found or unreadable: windows and the taskbar fall back to the default icon");
else log("info", `app icon: ${appIcon.file} (${appIcon.getSize().width} px)${winDetails ? `, taskbar id ${winDetails.appId}` : ""}`);
const db = new Db(join(dataDir, "flashmaster.db"));
log("info", `message search index: ${db.searchIndex}`);
db.defaultAutopilot = settings.get().general.autopilotDefault !== false;
settings.onChange((st) => { db.defaultAutopilot = st.general.autopilotDefault !== false; });
const interruptedAtStart = db.interruptOrphans();
db.applyRetention(settings.get().data.retentionDays);
const memory = new MemoryStore(db);
memory.shortTermDays = () => settings.get().memory.shortTermDays;
log("info", `memory search index: ${memory.index}`);
// Project knowledge base: project memories synced with <project>/.flashmaster/knowledge (git) both ways.
const knowledge = new KnowledgeBase(db, memory, undefined, Date.now, () => emit({ type: "memory.changed" }));
const syncAllKnowledge = () => {
  if (!settings.get().memory.enabled || !settings.get().memory.knowledgeSync) return;
  for (const p of db.listProjects()) {
    if (!existsSync(p.path)) continue;
    try { knowledge.sync(p.id); } catch (e) { log("warn", `knowledge sync ${p.name}: ${String(e)}`); }
  }
};
const sweepMemory = () => { try { if (memory.sweep()) emit({ type: "memory.changed" }); } catch (e) { log("warn", `memory sweep: ${String(e)}`); } };

let roles: RoleDef[] = [];
let skills: SkillDef[] = [];
/** Agents created by an agent with keep: false — live until the app restarts. */
const tempRoles = new Map<string, RoleDef>();
const reloadRoles = () => {
  roles = loadRoles(join(resources, "agents"), userRolesDir);
  for (const r of tempRoles.values()) if (!roles.some((x) => x.name === r.name)) roles.push(r);
  const builtinSkills = [...loadSkills(join(resources, "skills", "superpowers")), ...loadSkills(join(resources, "skills", "pstack"))];
  const userSkills = loadSkills(userSkillsDir);
  skills = [...builtinSkills.filter((b) => !userSkills.some((u) => u.command === b.command)), ...userSkills];
};
reloadRoles();
/** create_agent / AGENT blocks: never replace a built-in role or one the user wrote; agents may update their own creations. */
function createRole(spec: AgentSpec, createdBy: string, keep: boolean): RoleDef {
  const md = roleMarkdown(spec, createdBy);
  const role = parseRole(md, slugRole(spec.name), "user");
  const existing = roles.find((r) => r.name === role.name);
  const file = join(userRolesDir, `${role.name}.md`);
  const ownedByAgent = existsSync(file) && /^createdBy:/m.test(readFileSync(file, "utf8"));
  if (existing && !tempRoles.has(role.name) && !ownedByAgent)
    throw new Error(`"${role.name}" is an existing ${existing.source === "builtin" ? "built-in" : "user"} agent; delegate to it, or create the new one under another name`);
  const known = new Set(["flashmaster-core", ...mcp.list().map((m) => m.id), ...settings.get().mcp.external.map((e) => e.id)]);
  role.tools = role.tools.filter((t) => known.has(t));
  if (keep) { writeFileSync(file, md); tempRoles.delete(role.name); } else tempRoles.set(role.name, role);
  reloadRoles();
  emit({ type: "roles.changed", roles });
  log("info", `agent ${role.name} created by ${createdBy} (${keep ? "saved" : "temporary"})`);
  return roles.find((r) => r.name === role.name) ?? role;
}

let win: BrowserWindow | null = null;
/** Integrated terminals live in the main window only, so their output goes there and nowhere else. */
const terminals = new Terminals((e) => { if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send("flash:event", e); });
/** Threads and chats popped out into their own windows (keys `thread:<root id>`, `chat:<chat id>`); they get every app event like the main window. */
const popouts = new Map<string, BrowserWindow>();
const emit = (e: AppEvent) => {
  for (const w of [win, ...popouts.values()]) if (w && !w.isDestroyed() && !w.webContents.isDestroyed()) w.webContents.send("flash:event", e);
  if (e.type === "notice" && e.level !== "info" && settings.get().general.notifications && !win?.isFocused() && Notification.isSupported()) {
    new Notification({ title: "TheFlashMaster", body: e.text }).show();
  }
};

const harnesses = new HarnessRegistry([new DuoAdapter(() => settings.get().duo)]);
const bridge = new Bridge();
const mainDir = join(app.getAppPath(), "out", "main").replace("app.asar", "app.asar.unpacked");
const mcp = new McpBootstrap({
  nodeEntry: (id) => join(mainDir, `mcp-${id}.mjs`),
  nodeExec: process.execPath,
  nodeEnv: { ELECTRON_RUN_AS_NODE: "1" },
  pythonSrc: join(resources, "mcp-servers"),
  dataDir,
}, () => settings.get(), (servers) => emit({ type: "mcp.status", servers }));
// Code graph (graphify) for the knowledge base: installed into its own venv on the first "Scan code", run on demand.
const codeGraph = new CodeGraph({
  db, knowledge, python: () => mcp.toolPython("graphify"),
  install: (onPhase, onOutput) => mcp.installPipTool("graphify", GRAPHIFY_PACKAGE, GRAPHIFY_MIN_PYTHON, (ph) => onPhase(ph.replace(GRAPHIFY_PACKAGE, "graphify")), onOutput),
  onStatus: (status) => emit({ type: "codegraph.changed", status }),
});

const orch = new Orchestrator({
  db, harnesses, log, settings: () => settings.get(), roles: () => roles, skills: () => skills, emit, memory, knowledge,
  mcpServersFor: (role, agentId) => mcp.specsFor(role, agentId), homeDir: homedir(), dataDir,
  noProjectDir: () => noProjectFolder(settings.get().agents.noProjectFolder ?? "", process.platform, homedir()),
  extraRules: () => marketplace.instructions(),
  harnessEnv: (h) => harnessEnv(h),
  roleEnv: (role) => mcp.roleEnv(role),
  toolsLoaded: (agentId) => bridge.toolsListed.has(agentId),
  createRole,
  // Text-mode tools for agents without MCP (Pi, or MCP blocked): the same handlers the MCP forwarder reaches.
  listTools: (set) => bridge.list(set),
  callTool: (name, args, agentId, set) => bridge.call(name, args, agentId, set),
  attachmentRoots: () => attachmentRoots(),
  onCopilotUsage: (r) => recordCopilotUsage(r),
  onModels: (h, models) => {
    const m = { harness: h, models, fetchedAt: Date.now(), error: null, loading: false };
    modelCache.set(h, m);
    emit({ type: "models.updated", models: m });
    saveModels();
  },
});
// Agents that were working when the app last closed: tell their chats they can be resumed.
orch.announceInterrupted(interruptedAtStart);
// Stuck-agent watchdog: warns (once per silence) about working agents that have sent nothing for a while.
setInterval(() => { orch.checkStuck(); orch.checkToolTimeouts(); }, 30_000).unref();
// Closes delegated specialists that finished and stayed idle (Settings → Agents); work waiting for review is kept.
setInterval(() => { void orch.closeIdle(); }, 60_000).unref();
// Deletes finished, stopped and stale tasks (Settings → Agents → Tasks); Review tasks and tasks with a working agent stay.
const cleanTasks = () => runTaskCleanup(db, settings.get().tasks, (taskId) => emit({ type: "task.deleted", taskId }));
setInterval(() => { try { cleanTasks(); } catch (e) { log("warn", `task cleanup: ${String(e)}`); } }, 60_000).unref();
// Expired short-term memories, and memories of deleted chats / projects.
sweepMemory();
setInterval(sweepMemory, 3_600_000).unref();
// Knowledge bases follow the repo: teammates' changes come in after a pull, agents' updates go out to the folder.
syncAllKnowledge();
{
  let last = 0;
  setInterval(() => {
    const every = Math.max(1, settings.get().memory.knowledgeSyncMinutes || 2) * 60_000;
    if (Date.now() - last < every) return;
    last = Date.now();
    syncAllKnowledge();
  }, 30_000).unref();
}

// ---------------- git helpers (read-only, for the diff viewer) ----------------
const chatProject = (chatId: string): string | null => {
  const c = db.getChat(chatId);
  return c?.projectId ? db.getProject(c.projectId)?.path ?? null : null;
};
const git = async (cwd: string, args: string[]): Promise<{ code: number | null; out: string }> => {
  const { execFile } = await import("node:child_process");
  return new Promise((resolve) => {
    execFile("git", ["-c", "core.quotepath=off", ...args], { cwd, maxBuffer: 32 * 1024 * 1024, windowsHide: true, encoding: "utf8" },
      (err, stdout, stderr) => resolve({ code: err ? ((err as any).code ?? 1) : 0, out: err ? `${stdout}${stderr}` : stdout }));
  });
};

// ---------------- Copilot token (optional sign-in without /login), encrypted with safeStorage ----------------
const secrets = new SecretStore(safeStorage as any);
const copilotSecret = join(dataDir, "copilot.secret");
const readCopilotToken = (): string => secrets.get(copilotSecret);
const harnessEnv = (h: HarnessId): Record<string, string> => {
  if (h !== "copilot") return {};
  const t = readCopilotToken();
  return t ? { GH_TOKEN: t } : {};
};

// ---------------- EXAM setup: fill the install folder, install the RESTapi plugin, report what's missing ----------------
async function runExamSetup(install: boolean, auto = false): Promise<import("@shared/api").ExamSetupResult> {
  const r = await mcp.examSetup(install);
  if (r.home && !settings.get().exam.installPath) settings.update({ exam: { installPath: r.home } });
  const installed = r.actions.filter((a) => !a.startsWith("found") && !a.includes("failed"));
  const failed = r.actions.filter((a) => a.includes("failed"));
  if (r.error) log(auto ? "info" : "warn", `EXAM setup: ${r.error}`);
  else log("info", `EXAM setup: ${[...r.actions, ...r.checks.map((c) => `${c.name}=${c.state}`)].join("; ")}`);
  // At start-up only speak when something changed or broke, and only for users who have EXAM.
  if (auto && r.home) {
    if (installed.length) emit({ type: "notice", level: "info", text: `EXAM: ${installed.join("; ")}` });
    if (failed.length) emit({ type: "notice", level: "warn", text: `EXAM: ${failed.join("; ")} — see Settings → Integrations → EXAM` });
  }
  return r;
}

// ---------------- Jazz (password encrypted with the OS keychain via safeStorage) ----------------
const secretFile = join(dataDir, "jazz.secret");
const readJazzPassword = (): string => secrets.get(secretFile);
let jazzClient: JazzClient | null = null;
let jazzKey = "";
// Dedicated persistent session for Jazz: keeps the LTPA/JSESSIONID cookies across redirects and restarts,
// uses Chromium's network stack (Windows certificate store, proxy from applyProxy()).
const jazzSession = () => session.fromPartition("persist:jazz");
const jazzFetchRaw = withProxyFallback(() => jazzSession(), (url, init) => jazzSession().fetch(url, { ...init, credentials: "include", redirect: "follow" } as any) as any);
const netFetch: FetchLike = (url, init) => jazzFetchRaw(url, init) as any;
const jazzAreas = (j: { projectAreas?: string[]; projectArea?: string }) =>
  j.projectAreas?.length ? j.projectAreas : j.projectArea ? [j.projectArea] : [];
const jazzHost = (u: string) => { try { return new URL(u).hostname; } catch { return ""; } };
/** Windows integrated sign-in: Chromium only sends Kerberos/NTLM credentials to allow-listed servers. */
const allowWindowsAuth = (serverUrl: string) => {
  const host = jazzHost(serverUrl);
  if (!host) return;
  try { (jazzSession() as any).allowNTLMCredentialsForDomains?.(`${host},*.${host.split(".").slice(1).join(".")}`); } catch { /* older Electron */ }
};
{
  // Before app ready the command-line switches still apply (covers Negotiate delegation too).
  const j = settings.get().jazz;
  const host = jazzHost(j.serverUrl);
  if (j.authType === "windows" && host) {
    app.commandLine.appendSwitch("auth-server-allowlist", host);
    app.commandLine.appendSwitch("auth-negotiate-delegate-allowlist", host);
  }
}
const jazz = (): JazzClient | null => {
  const j = settings.get().jazz;
  if (!j.enabled || !j.serverUrl) return null;
  const areas = jazzAreas(j);
  const key = JSON.stringify([j.serverUrl, areas, j.authType, j.username, j.hasPassword]);
  if (!jazzClient || key !== jazzKey) {
    if (j.authType === "windows" && app.isReady()) allowWindowsAuth(j.serverUrl);
    jazzClient = new JazzClient({ serverUrl: j.serverUrl, projectAreas: areas, authType: j.authType, username: j.username, password: readJazzPassword() }, netFetch);
    jazzKey = key;
  }
  return jazzClient;
};
/**
 * Browser sign-in for servers behind the Jazz Authorization Server / OIDC / SAML: the user logs in in a normal
 * window (MFA, company SSO pages), the cookies land in the persist:jazz session, and the API reuses them.
 */
let signInWin: BrowserWindow | null = null;
async function jazzIdentity(serverUrl: string): Promise<string | null> {
  try {
    const r = await jazzFetchRaw(`${serverUrl.replace(/\/+$/, "")}/authenticated/identity`, { headers: { Accept: "application/json" } });
    if (!r.ok || r.headers.get("x-com-ibm-team-repository-web-auth-msg") === "authrequired") return null;
    const body = await r.text();
    try { return JSON.parse(body)?.userId ?? null; } catch { return null; }
  } catch { return null; }
}
function jazzSignIn(): Promise<{ ok: boolean; detail: string }> {
  const j = settings.get().jazz;
  if (!j.serverUrl) return Promise.resolve({ ok: false, detail: "Set the Jazz server URL first" });
  const base = j.serverUrl.replace(/\/+$/, "");
  signInWin?.close();
  return new Promise((resolve) => {
    let done = false;
    const w = new BrowserWindow({
      width: 980, height: 760, parent: win ?? undefined, title: "Sign in to IBM Jazz", autoHideMenuBar: true, backgroundColor: "#ffffff", icon: appIcon,
      webPreferences: { session: jazzSession(), contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    signInWin = w;
    const finish = (r: { ok: boolean; detail: string }) => {
      if (done) return;
      done = true;
      clearInterval(timer);
      clearTimeout(limit);
      if (!w.isDestroyed()) w.close();
      signInWin = null;
      jazzClient = null; rmClient = null; etmClient = null; scmClient = null;
      resolve(r);
    };
    const check = async () => { const user = await jazzIdentity(base); if (user) finish({ ok: true, detail: `Signed in as ${user}` }); };
    const timer = setInterval(() => void check(), 2000);
    const limit = setTimeout(() => finish({ ok: false, detail: "Sign-in timed out" }), 10 * 60000);
    w.webContents.on("did-navigate", () => void check());
    w.on("closed", () => finish({ ok: false, detail: "Sign-in window closed" }));
    void w.loadURL(`${base}/web`);
  });
}
// ---------------- DOORS Next requirements (same Jazz session/sign-in, /rm context root) ----------------
const rmUrl = () => {
  const j = settings.get().jazz;
  // Any DOORS Next link works: only the context root is used (e.g. https://alm.company.com/rm1).
  return parseRmLink(j.rm.serverUrl).base || j.serverUrl.replace(/[#?].*$/, "").replace(/\/(ccm|jts|qm)(\w*)\/?$/i, "/rm$2").replace(/\/+$/, "");
};
let rmClient: JazzClient | null = null;
let rmKey = "";
const rmApi = (): JazzClient | null => {
  const j = settings.get().jazz;
  if (!j.enabled || !j.rm.enabled || !rmUrl()) return null;
  const key = JSON.stringify([rmUrl(), j.authType, j.username, j.hasPassword]);
  if (!rmClient || key !== rmKey) {
    rmClient = new JazzClient({ serverUrl: rmUrl(), projectAreas: [], authType: j.authType, username: j.username, password: readJazzPassword() }, netFetch);
    rmKey = key;
  }
  return rmClient;
};
const requirements = new Requirements(rmApi, join(dataDir, "rm-cache"), () => settings.get().jazz.rm.config,
  () => settings.get().jazz.rm.component || parseRmLink(settings.get().jazz.rm.serverUrl).componentUri, () => rmUrl());
// ---------------- ETM test management (/qm) and EWM source control (read-only, /ccm), same Jazz session ----------------
const qmUrl = () => {
  const j = settings.get().jazz;
  const raw = j.qm.serverUrl.trim() || j.serverUrl.replace(/[#?].*$/, "").replace(/\/web(\/.*)?$/i, "").replace(/\/(ccm|jts|rm)(\w*)\/?$/i, "/qm$2");
  return raw.replace(/[#?].*$/, "").replace(/\/web(\/.*)?$/i, "").replace(/\/+$/, "");
};
let etmClient: EtmClient | null = null;
let etmKey = "";
const etm = (): EtmClient | null => {
  const j = settings.get().jazz;
  if (!j.enabled || !j.qm.enabled || !qmUrl()) return null;
  const key = JSON.stringify([qmUrl(), j.authType, j.username, j.hasPassword]);
  if (!etmClient || key !== etmKey) {
    const http = new JazzClient({ serverUrl: qmUrl(), projectAreas: [], authType: j.authType, username: j.username, password: readJazzPassword() }, netFetch);
    etmClient = new EtmClient(http, () => ({ projectArea: settings.get().jazz.qm.projectArea, config: settings.get().jazz.qm.config }));
    etmKey = key;
  }
  return etmClient;
};
let scmClient: ScmClient | null = null;
let scmHttp: JazzClient | null = null;
/** EWM SCM command line for folder listings; signs in with the Jazz user/password when those are set. */
const scmCli = (): { run: CliRunner; repo: string } | null => {
  const j = settings.get().jazz;
  const exe = findScmCli(j.scm.cliPath);
  if (!exe) return null;
  const creds = (j.authType === "basic" || j.authType === "form") && j.username && j.hasPassword ? { user: j.username, password: readJazzPassword() } : null;
  return { run: scmCliRunner(exe, creds), repo: j.serverUrl.replace(/[#?].*$/, "").replace(/\/web(\/.*)?$/i, "").replace(/\/+$/, "") };
};
const scm = (): ScmClient | null => {
  const j = settings.get().jazz;
  if (!j.scm.enabled) return null;
  const http = jazz();
  if (!http) return null;
  if (!scmClient || scmHttp !== http) { scmClient = new ScmClient(http, scmCli); scmHttp = http; }
  return scmClient;
};
/** Jazz hosts (work items, test management, requirements) whose certificate may be accepted when trustServerCert is on. */
const jazzHosts = () => {
  const j = settings.get().jazz;
  return new Set([j.serverUrl, qmUrl(), rmUrl()].map(jazzHost).filter(Boolean));
};
const needJazz = () => { const j = jazz(); if (!j) throw new Error("Jazz is not configured (Settings → Integrations → IBM Jazz)"); return j; };

bridge.register(buildTools({ db, orch, roles: () => roles, jazz, requirements, etm, scm, rmProjects: () => settings.get().jazz.rm.projects, jazzAreas: () => jazzAreas(settings.get().jazz),
  onArtifact: (agentId) => { const a = db.getAgent(agentId); if (a?.chatId) emit({ type: "artifacts.changed", chatId: a.chatId }); }, emitTask: (task) => emit({ type: "task.updated", task }),
  deleteTask: (taskId) => emit({ type: "task.deleted", taskId }),
  memory, memoryEnabled: () => settings.get().memory.enabled, onMemory: () => emit({ type: "memory.changed" }), knowledge, codeGraph,
  readOnly: () => settings.get().permissions.readOnly }));

// ---------------- chat attachments ----------------
// Stored inside the project (<project>/.flashmaster/attachments, git-ignored) so agents can read them with their own tools;
// chats without a project use the app data folder, which is added to the agents' readable roots.
const appAttachDir = join(dataDir, "attachments");
mkdirSync(appAttachDir, { recursive: true });
const MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
  ".bmp": "image/bmp", ".svg": "image/svg+xml", ".pdf": "application/pdf", ".txt": "text/plain", ".md": "text/markdown", ".json": "application/json",
  ".csv": "text/csv", ".xml": "application/xml", ".arxml": "application/xml", ".dbc": "text/plain", ".c": "text/x-c", ".h": "text/x-c", ".log": "text/plain" };
function attachDir(chatId: string): string {
  const chat = db.getChat(chatId);
  const project = chat?.projectId ? db.getProject(chat.projectId) : null;
  if (!project) return appAttachDir;
  const dir = join(project.path, ".flashmaster", "attachments");
  mkdirSync(dir, { recursive: true });
  ensureFlashmasterIgnore(project.path);
  return dir;
}
function storeAttachment(chatId: string, name: string, mime: string, write: (target: string) => void): Attachment {
  const safe = name.replace(/[^\w.\- ()]/g, "_").slice(-120) || "file";
  const id = randomUUID().slice(0, 8);
  const target = join(attachDir(chatId), `${id}-${safe}`);
  write(target);
  const size = statSync(target).size;
  const max = settings.get().chat.maxAttachmentMB * 1024 * 1024;
  if (size > max) { unlinkSync(target); throw new Error(`${name} is larger than ${settings.get().chat.maxAttachmentMB} MB (Settings → Chat)`); }
  const type = mime || MIME[extname(name).toLowerCase()] || "application/octet-stream";
  const kind = type.startsWith("image/") ? "image" : "file";
  let thumb: string | undefined;
  if (kind === "image" && type !== "image/svg+xml") {
    try { const img = nativeImage.createFromPath(target); if (!img.isEmpty()) thumb = img.resize({ width: 240, quality: "good" }).toDataURL(); } catch { /* no preview */ }
  }
  return { id, name, mime: type, size, kind, path: target, thumb };
}
const attachmentRoots = () => [appAttachDir];

// ---------------- harness models (discovered from each harness, cached in models.json) ----------------
const modelsFile = join(dataDir, "models.json");
const modelCache = new Map<HarnessId, HarnessModels>();
try {
  for (const m of JSON.parse(readFileSync(modelsFile, "utf8")) as HarnessModels[]) modelCache.set(m.harness, { ...m, loading: false });
} catch { /* first run */ }
const modelState = (h: HarnessId): HarnessModels => modelCache.get(h) ?? { harness: h, models: [], fetchedAt: null, error: null, loading: false };
const saveModels = () => { try { writeFileSync(modelsFile, JSON.stringify([...modelCache.values()].map((m) => ({ ...m, loading: false })))); } catch { /* best effort */ } };
const inflight = new Map<HarnessId, Promise<HarnessModels>>();
function refreshModels(h: HarnessId): Promise<HarnessModels> {
  const running = inflight.get(h);
  if (running) return running;
  const adapter = harnesses.get(h);
  const st = harnesses.cached(h);
  const set = (m: HarnessModels) => { modelCache.set(h, m); emit({ type: "models.updated", models: m }); return m; };
  if (!adapter.listModels || (h !== "mock" && !st?.available)) {
    return Promise.resolve(set({ ...modelState(h), loading: false, error: st?.available === false ? "harness not found" : null }));
  }
  set({ ...modelState(h), loading: true, error: null });
  const s = settings.get();
  const p = adapter.listModels({ executable: st?.path ?? (s.harnesses[h]?.path || null), cwd: homedir(), env: { ...networkEnv(s), ...harnessEnv(h) }, extraArgs: s.harnesses[h]?.args ?? "" })
    .then((models) => set({ harness: h, models, fetchedAt: Date.now(), error: models.length ? null : "the harness did not report any models — type a model id", loading: false }))
    .catch((e) => set({ ...modelState(h), loading: false, error: String(e?.message ?? e) }))
    .finally(() => { inflight.delete(h); saveModels(); });
  inflight.set(h, p);
  return p;
}

// ---------------- Copilot usage meter (credits via Copilot's own sign-in; per model from /usage + its session log) ----------------
const usageFile = join(dataDir, "copilot-usage.json");
let copilotUsage: CopilotUsage | null = (() => { try { return JSON.parse(readFileSync(usageFile, "utf8")); } catch { return null; } })();
const setUsage = (u: CopilotUsage) => {
  copilotUsage = u;
  emit({ type: "copilotUsage.updated", usage: u });
  try { writeFileSync(usageFile, JSON.stringify({ ...u, loading: false })); } catch { /* best effort */ }
  return u;
};
const liveFile = join(dataDir, "copilot-usage-live.json");
const liveLedger = new LiveLedger(() => { try { return readFileSync(liveFile, "utf8"); } catch { return null; } }, (json) => writeFileSync(liveFile, json));
let usageAdvertised: { advertised: boolean; commands: string[] } | null = null;
let usageInflight: Promise<CopilotUsage | null> | null = null;
/** Silent /usage at the end of each Copilot turn (from the orchestrator). */
function recordCopilotUsage(r: { sessionId: string; text: string | null; commands: string[]; agentId: string }): void {
  usageAdvertised = { advertised: r.text !== null, commands: r.commands };
  const seg = r.text ? parseSessionUsage(r.text) : null;
  const used = seg && r.sessionId ? liveLedger.record(r.sessionId, seg) : 0;
  // Count the credits on the agent too, so each chat and agent shows what it used.
  if (used > 0) { const a = db.addAgentCredits(r.agentId, used); if (a) emit({ type: "agent.updated", agent: a }); }
  if (settings.get().usage.copilotMeter) void refreshCopilotUsage();
}
const quotaFetch = withProxyFallback(() => session.defaultSession, (url, init) => session.defaultSession.fetch(url, init as any) as any);
const runText: Exec = async (cmd, args) => {
  const { execFile } = await import("node:child_process");
  return new Promise((resolve, reject) => execFile(cmd, args, { timeout: 15000, windowsHide: true, encoding: "utf8" }, (err, out) => (err ? reject(err) : resolve(String(out)))));
};
/** Available credits from Copilot, using the sign-in Copilot already has. */
async function readCopilotQuota(dir: string): Promise<{ quota: Quota | null; from: string | null; error: string | null }> {
  const t = await findCopilotToken({ env: process.env, appToken: readCopilotToken(), copilotDir: dir, exec: runText, readText: (f) => readFile(f, "utf8") });
  if (!t) return { quota: null, from: null, error: "Couldn't find Copilot's sign-in on this computer. Sign in to Copilot (run copilot, then /login) to see your available credits." };
  try { return { quota: await fetchQuota(quotaFetch as any, t.token, process.env.FLASH_GITHUB_API), from: t.from, error: null }; }
  catch (e: any) { return { quota: null, from: t.from, error: String(e?.message ?? e) }; }
}
function refreshCopilotUsage(): Promise<CopilotUsage | null> {
  if (usageInflight) return usageInflight;
  const now = new Date();
  const period = { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1 };
  const dir = copilotHome(homedir());
  if (copilotUsage) setUsage({ ...copilotUsage, loading: true });
  usageInflight = Promise.all([scanSessionLogs(dir, Date.UTC(period.year, period.month - 1, 1)), readCopilotQuota(dir)])
    .then(([logs, q]) => setUsage(toUsage(
      summarizeLocal(logs, liveLedger.all(), period, { allowance: settings.get().usage.includedCredits, quota: q.quota, signIn: q.from }),
      { advertised: usageAdvertised?.advertised ?? null, commands: usageAdvertised?.commands, quotaError: q.error, resetAt: q.quota?.resetAt })))
    .catch((e) => setUsage({ ...(copilotUsage ?? toUsage(summarizeLocal(new Map(), [], period))), ok: false, loading: false, error: String(e?.message ?? e) }))
    .finally(() => { usageInflight = null; });
  return usageInflight;
}
let usageTimer: ReturnType<typeof setInterval> | null = null;
const scheduleUsage = () => {
  if (usageTimer) clearInterval(usageTimer);
  usageTimer = null;
  const u = settings.get().usage;
  if (!u.copilotMeter || u.refreshMinutes <= 0) return;
  usageTimer = setInterval(() => void refreshCopilotUsage(), Math.max(5, u.refreshMinutes) * 60000);
};

// ---------------- Flash server (flash-server/API.md) ----------------
const serverSecret = join(dataDir, "server.secret");
/** Built-in default: package.json → flashmaster.server.url (a setting or policy `server.url` overrides it). */
const repoServer = (() => { try { return JSON.parse(readFileSync(join(app.getAppPath(), "package.json"), "utf8"))?.flashmaster?.server ?? {}; } catch { return {}; } })();
const serverDefaultUrl = String(process.env.FLASH_SERVER_URL || repoServer.url || "").trim();
const serverConfig = () => ({ url: serverBase(settings.get().server.url || serverDefaultUrl), token: secrets.get(serverSecret) });
const flashServer = new FlashServerClient({
  fetch: (url, init) => withProxyFallback(() => session.defaultSession, (u, i) => session.defaultSession.fetch(u, { ...i, redirect: "follow" } as any) as any)(url, init) as any,
  config: serverConfig,
});
const submissionWatcher = new SubmissionWatcher(join(dataDir, "server", "submissions-seen.json"));
let serverName = "";
/** The server's display name (from /api/v1/health), refreshed now and then; "Flash server" until known. */
async function refreshServerName(): Promise<void> {
  if (!flashServer.configured()) return;
  try { serverName = String((await flashServer.health()).name ?? "").trim(); } catch { /* keep the last one */ }
}
/** My submissions; status changes since last seen become notices. Concurrent callers share one request (one notice each). */
let pollInFlight: Promise<Submission[]> | null = null;
function pollSubmissions(): Promise<Submission[]> {
  const cfg = serverConfig();
  if (!cfg.url || !cfg.token) return Promise.resolve([]);
  pollInFlight ??= flashServer.submissions().then((list) => {
    for (const n of submissionWatcher.update(list)) emit({ type: "notice", level: n.level, text: n.text });
    return list;
  }).finally(() => { pollInFlight = null; });
  return pollInFlight;
}

// ---------------- app updates (repository releases with latest.json) ----------------
const updatesSession = () => session.fromPartition("persist:updates");
const updateSecret = join(dataDir, "updates.secret");
/** Update source: setting/policy override, else the repository's package.json (flashmaster.updates.url). */
const repoUpdates = (() => { try { return JSON.parse(readFileSync(join(app.getAppPath(), "package.json"), "utf8"))?.flashmaster?.updates ?? {}; } catch { return {}; } })();
const updateFeed = () => {
  const u = settings.get().updates;
  return { url: (u.feedUrl || process.env.FLASH_UPDATE_URL || repoUpdates.url || "").trim(), channel: (u.channel || repoUpdates.channel || "stable") as "stable" | "beta", token: secrets.get(updateSecret),
    server: serverConfig() };
};
const updater = new Updater({
  fetch: withProxyFallback(() => updatesSession(), (url, init) => updatesSession().fetch(url, { ...init, redirect: "follow", credentials: "include" } as any) as any) as any,
  version: app.getVersion(),
  mode: !app.isPackaged ? "dev" : process.env.PORTABLE_EXECUTABLE_FILE ? "portable" : "installer",
  portablePath: process.env.PORTABLE_EXECUTABLE_FILE,
  dataDir, feed: updateFeed,
  emit: (state) => emit({ type: "update.state", state }),
  log: (m) => log("warn", m),
  spawnDetached: (cmd, args) => {
    void import("node:child_process").then(({ spawn }) => spawn(cmd, args, { detached: true, stdio: "ignore", windowsHide: false }).unref());
  },
  quit: () => setTimeout(() => app.quit(), 300),
});
/** Sign in to GitHub (Enterprise) in a window; cookies stay in the updates session. */
function updateSignIn(): Promise<{ ok: boolean; detail: string }> {
  const f = parseFeed(updateFeed().url);
  if (!f || f.kind !== "github") return Promise.resolve({ ok: false, detail: "The update source is not a GitHub repository" });
  return new Promise((resolve) => {
    const w = new BrowserWindow({ width: 1000, height: 780, parent: win ?? undefined, title: "Sign in to GitHub", autoHideMenuBar: true, icon: appIcon,
      webPreferences: { session: updatesSession(), contextIsolation: true, nodeIntegration: false, sandbox: true } });
    let done = false;
    const finish = async (ok: boolean, detail: string) => {
      if (done) return;
      done = true;
      if (!w.isDestroyed()) w.close();
      resolve({ ok, detail });
      if (ok) void updater.check();
    };
    w.webContents.on("did-navigate", (_e, url) => { if (url.startsWith(f.web) && !/\/login|\/session|saml|sso/i.test(url)) void finish(true, "Signed in"); });
    w.on("closed", () => void finish(true, "Window closed"));
    void w.loadURL(`${f.web}/releases`);
  });
}

// ---------------- marketplace ----------------
const marketplace = new Marketplace({
  dataDir, rolesDir: userRolesDir, skillsDir: userSkillsDir,
  fetch: withProxyFallback(() => session.defaultSession, (url, init) => session.defaultSession.fetch(url, { ...init, redirect: "follow" } as any) as any) as any,
  policy: () => ({ allowMcpServers: settings.get().marketplace.allowMcpServers }),
  knownTools: () => [...mcp.list().map((m) => m.id), ...settings.get().mcp.external.map((e) => e.id)],
  builtinRoles: () => loadRoles(join(resources, "agents"), join(dataDir, "__none__")).map((r) => r.name),
  applyExamPreset: (preset) => {
    // Department values fill what the user hasn't set; the user's own values win.
    const cur = settings.get().exam as unknown as Record<string, unknown>;
    const def = DEFAULT_SETTINGS.exam as unknown as Record<string, unknown>;
    const patch = Object.fromEntries(Object.entries(preset).filter(([k]) => cur[k] === "" || cur[k] === def[k]));
    if (Object.keys(patch).length) settings.update({ exam: patch });
    void runExamSetup(true, true);
  },
  addMcpServers: (servers, enabled) => {
    const s = settings.get().mcp;
    const ids = servers.map((x) => x.id);
    settings.update({ mcp: {
      external: [...s.external.filter((e) => !ids.includes(e.id)), ...servers],
      disabled: enabled ? s.disabled.filter((d) => !ids.includes(d)) : [...new Set([...s.disabled, ...ids])],
    } });
  },
  removeMcpServers: (ids) => {
    const s = settings.get().mcp;
    settings.update({ mcp: { external: s.external.filter((e) => !ids.includes(e.id)), disabled: s.disabled.filter((d) => !ids.includes(d)) } });
  },
});
/** Settings marketplaces plus the Flash server (automatic source "flash-server", requests carry its token). */
const mpSources = (): MarketplaceSource[] => {
  const cfg = serverConfig();
  const own = settings.get().marketplace.sources.filter((x) => x.id !== "flash-server");
  return cfg.url ? [...own, { id: "flash-server", name: serverName || "Flash server", url: `${cfg.url}/marketplace`, department: "", enabled: true, token: cfg.token }] : own;
};
const mpSource = (id: string) => {
  const src = mpSources().find((x) => x.id === id);
  if (!src) throw new Error("unknown marketplace");
  return src;
};
const afterPluginChange = () => {
  reloadRoles();
  emit({ type: "roles.changed", roles });
  emit({ type: "plugins.changed", installed: marketplace.installed() });
};
const mpState = () => ({
  listings: marketplace.cached(),
  installed: marketplace.installed(),
  updates: marketplace.updates().map((u) => ({ id: u.plugin.id, from: u.plugin.version, to: u.entry.version })),
});
async function checkPluginUpdates(): Promise<void> {
  const sources = mpSources();
  if (!sources.some((x) => x.enabled)) return;
  await refreshServerName();
  await marketplace.refresh(mpSources());
  const ups = marketplace.updates();
  if (ups.length) emit({ type: "notice", level: "info", text: `${ups.length} plugin update(s) available — see Marketplace` });
}

// ---------------- agent import ----------------
const knownTools = () => [...mcp.list().map((m) => m.id), ...settings.get().mcp.external.map((e) => e.id)];
const builtinNames = () => loadRoles(join(resources, "agents"), join(dataDir, "__none__")).map((r) => r.name);
function checkAgent(text: string, file: string): AgentImportResult {
  const v = validateRole(text, knownTools(), builtinNames(), skills.map((k) => k.command));
  return { file, ok: v.ok, name: v.role?.name ?? (parseRole(text, "", "user").name || null), errors: v.errors, warnings: v.warnings };
}
function importAgent(text: string, file: string): AgentImportResult {
  const res = checkAgent(text, file);
  if (!res.ok || !res.name) return res;
  writeFileSync(join(userRolesDir, `${res.name}.md`), text.trimStart().replace(/\r\n/g, "\n"));
  reloadRoles();
  emit({ type: "roles.changed", roles });
  log("info", `agent imported: ${res.name} (${file})`);
  return res;
}

// ---------------- IPC ----------------
const api: FlashApi = {
  listProjects: async () => db.listProjects(),
  pickFolder: async () => {
    const r = await dialog.showOpenDialog(win!, { properties: ["openDirectory"], title: "Select project folder" });
    return r.canceled ? null : (r.filePaths[0] ?? null);
  },
  createProject: async (path, name) => {
    const p = db.createProject(name || basename(path), path);
    if (!db.listChats(p.id).length) db.createChat({ projectId: p.id, title: "General", kind: "project", agentRole: "flashmaster" });
    return p;
  },
  removeProject: async (id) => db.removeProject(id),
  listChats: async (projectId) => db.listChats(projectId),
  getMasterChat: async () => db.getOrCreateMasterChat(),
  createChat: async (i) => db.createChat({ projectId: i.projectId, title: i.title || "New chat", kind: "project", agentRole: i.agentRole || "flashmaster" }),
  updateChat: async (id, patch) => {
    const c = db.updateChat(id, patch);
    // New mode/harness/model: idle agent sessions of this chat restart with it on the next message.
    if ("mode" in patch || "harness" in patch || "model" in patch) orch.resetChatSessions(id);
    return c;
  },
  deleteChat: async (id) => { await orch.stopChat(id); db.deleteChat(id); },
  prepareChat: async (chatId) => orch.prepareChat(chatId),
  resetContext: async (chatId) => orch.resetContext(chatId),
  exportChat: async (chatId) => {
    const c = db.getChat(chatId);
    const msgs = db.history(chatId, null).filter((m) => !m.marker);
    const who = (m: (typeof msgs)[number]) => (m.author === "user" ? "You" : m.author === "system" ? "System" : roles.find((r) => r.name === m.role)?.title ?? m.role ?? "Agent");
    return [`# ${c?.title ?? "Chat"}`, "", ...msgs.map((m) => `### ${who(m)} — ${new Date(m.createdAt).toLocaleString()}\n\n${m.content}\n`)].join("\n");
  },
  renameProject: async (id, name) => { if (name.trim()) db.renameProject(id, name.trim()); },
  openProjectFolder: async (id) => { const p = db.getProject(id); if (p) await shell.openPath(p.path); },
  listMessages: async (chatId, parentId) => orch.withLiveText(db.listMessages(chatId, parentId)),
  sendMessage: async (i) => orch.sendUserMessage(i.chatId, i.content, i.parentId ?? null, { attachments: i.attachments, whileBusy: i.whileBusy }),
  saveAttachment: async (i) => storeAttachment(i.chatId, i.name, i.mime, (t) => writeFileSync(t, Buffer.from(i.dataBase64, "base64"))),
  pickAttachments: async (chatId) => {
    const r = await dialog.showOpenDialog(win!, { title: "Attach files", properties: ["openFile", "multiSelections"] });
    if (r.canceled) return [];
    return r.filePaths.map((f) => storeAttachment(chatId, basename(f), MIME[extname(f).toLowerCase()] ?? "", (t) => copyFileSync(f, t)));
  },
  openAttachment: async (path) => {
    const ok = path.startsWith(appAttachDir) || db.listProjects().some((p) => path.startsWith(join(p.path, ".flashmaster", "attachments")));
    if (!ok || !existsSync(path)) throw new Error("attachment not found");
    await shell.openPath(path);
  },
  openLink: async (target, chatId) => {
    const c = chatId ? db.getChat(String(chatId)) : null;
    const project = c?.projectId ? db.getProject(c.projectId)?.path : null;
    const a = resolveLink(String(target ?? ""), { platform: process.platform, bases: project ? [project] : [], home: homedir(), exists: existsSync });
    if (a.kind === "refuse") return { ok: false, detail: `Can't open this link: ${a.reason}` };
    if (a.kind === "web") { await shell.openExternal(a.url); return { ok: true, detail: "Opened in your browser." }; }
    if (a.kind === "reveal") { shell.showItemInFolder(a.path); return { ok: true, detail: "Programs are not run from chat links; showing it in its folder." }; }
    const err = await shell.openPath(a.path);
    return err ? { ok: false, detail: err } : { ok: true, detail: "Opened." };
  },
  openThreadWindow: async (chatId, rootId) => openThreadWindow(chatId, rootId),
  openChatWindow: async (chatId) => openChatWindow(chatId),
  searchMessages: async (query, limit) => db.searchMessages(String(query ?? ""), Math.min(Math.max(Number(limit) || 50, 1), 200)),
  editMessage: async (i) => orch.editAndResend(i.messageId, i.content),
  retryMessage: async (i) => orch.retryReply(i.messageId, i.harness ? { harness: i.harness, model: i.model ?? null } : undefined),
  toggleReaction: async (messageId, emoji) => {
    const reactions = db.toggleReaction(messageId, emoji);
    const m = db.getMessage(messageId);
    if (m) emit({ type: "reaction.changed", messageId, chatId: m.chatId, reactions });
    orch.onReaction(messageId, emoji, reactions);
    return reactions;
  },
  archiveThread: async (rootId, archived) => orch.archiveThread(String(rootId), !!archived),
  deleteThread: async (rootId) => orch.deleteThread(String(rootId)),
  deleteMessage: async (messageId) => orch.deleteMessage(String(messageId)),
  answerAsk: async (messageId, answer) => orch.answerAsk(String(messageId), String(answer ?? "")),
  clearChat: async (chatId) => orch.clearChat(String(chatId)),
  listAgents: async (f) => db.listAgents(f ?? {}),
  startAgent: async (i) => orch.startAgent(i.projectId, i.role, i.brief),
  pauseAgent: async (id) => orch.pause(id),
  resumeAgent: async (id) => orch.resume(id),
  resumeInterrupted: async (id) => orch.resumeInterrupted(id),
  resumeAllInterrupted: async () => orch.resumeAllInterrupted(),
  agentWorkState: async (id) => orch.workState(id),
  mergeAgentWork: async (id) => orch.mergeWork(id),
  discardAgentWork: async (id, force) => orch.discardWork(id, !!force),
  agentWorkChanges: async (id) => orch.workChanges(id),
  agentWorkFileDiff: async (id, path) => orch.workFileDiff(id, String(path)),
  requestAgentFixes: async (id, comments, note) => orch.requestWorkFixes(id, Array.isArray(comments) ? comments : [], typeof note === "string" ? note : ""),
  stopAgent: async (id) => orch.stop(id),
  stopToolCall: async (messageId, toolId) => orch.stopToolCall(String(messageId), String(toolId)),
  stopAll: async () => orch.stopAll(),
  getAgentFlow: async (agentId) => {
    const agent = db.getAgent(agentId);
    if (!agent) throw new Error("agent not found");
    return { agent, parent: agent.parentAgentId ? db.getAgent(agent.parentAgentId) : null, children: db.childAgents(agentId), events: db.listEvents(agentId) };
  },
  listRoles: async () => { reloadRoles(); return roles; },
  listSkills: async () => skills,
  openRolesFolder: async () => { await shell.openPath(userRolesDir); },
  agentTemplate: async () => readFileSync(join(resources, "agents", "_template.md"), "utf8"),
  saveAgentTemplate: async () => {
    const r = await dialog.showSaveDialog(win!, { title: "Save agent template", defaultPath: "my-agent.md", filters: [{ name: "Agent (Markdown)", extensions: ["md"] }] });
    if (r.canceled || !r.filePath) return null;
    writeFileSync(r.filePath, readFileSync(join(resources, "agents", "_template.md"), "utf8"));
    return r.filePath;
  },
  validateAgent: async (text) => checkAgent(text, "pasted"),
  importAgentText: async (text, fileName) => importAgent(text, fileName ?? "pasted"),
  importAgentFiles: async () => {
    const r = await dialog.showOpenDialog(win!, { title: "Import agents", properties: ["openFile", "multiSelections"], filters: [{ name: "Agent (Markdown)", extensions: ["md"] }] });
    if (r.canceled) return [];
    return r.filePaths.map((f) => importAgent(readFileSync(f, "utf8"), basename(f)));
  },
  removeAgent: async (name) => {
    const file = join(userRolesDir, `${name}.md`);
    if (!/^[a-z][a-z0-9-]{1,40}$/.test(name) || !existsSync(file)) throw new Error("only imported/custom agents can be removed");
    unlinkSync(file);
    reloadRoles();
    emit({ type: "roles.changed", roles });
  },
  exportAgent: async (name) => {
    const role = roles.find((r) => r.name === name);
    if (!role) throw new Error("unknown agent");
    const src = role.source === "user" ? join(userRolesDir, `${name}.md`) : join(resources, "agents", `${name}.md`);
    const r = await dialog.showSaveDialog(win!, { title: "Export agent", defaultPath: `${name}.md`, filters: [{ name: "Agent (Markdown)", extensions: ["md"] }] });
    if (r.canceled || !r.filePath) return null;
    writeFileSync(r.filePath, readFileSync(src, "utf8"));
    return r.filePath;
  },
  listTasks: async (f) => db.listTasks(f ?? {}),
  createTask: async (i) => { const t = db.createTask(i); emit({ type: "task.updated", task: t }); return t; },
  updateTask: async (id, patch) => { const t = db.updateTask(id, patch); emit({ type: "task.updated", task: t }); return t; },
  deleteTask: async (id) => { db.deleteTask(id); emit({ type: "task.deleted", taskId: id }); },
  cleanupTasks: async () => cleanTasks().length,
  listMemories: async (f) => {
    const scopes = f?.scope ? [f.scope] : undefined;
    const q = String(f?.query ?? "").trim();
    return q ? memory.search(q, null, { scopes, projectId: f?.projectId, limit: 50, touch: false })
      : memory.list(null, { scopes, projectId: f?.projectId, limit: 1000 });
  },
  saveMemory: async (i) => {
    let m;
    if (i.id != null) {
      const cur = memory.require(i.id, null);
      m = memory.update(cur.id, { content: i.content, kind: i.kind, tags: i.tags, importance: i.importance, pinned: i.pinned });
      if (i.scope && i.scope !== cur.scope && i.scope !== "session") m = memory.promote(cur.id, i.scope, { projectId: cur.projectId, chatId: cur.chatId }).memory;
    } else {
      m = memory.save({ ...i, scope: i.scope === "session" ? undefined : i.scope }, { projectId: i.projectId ?? null, chatId: null }).memory;
    }
    emit({ type: "memory.changed" });
    return m;
  },
  knowledgeStatus: async (projectId) => knowledge.status(projectId),
  syncKnowledge: async (projectId) => knowledge.sync(projectId),
  resolveKnowledgeConflict: async (projectId, slug, keep) => knowledge.resolve(projectId, slug, keep),
  buildKnowledge: async (projectId, focus) => {
    if (!db.getProject(projectId)) throw new Error("project not found");
    // A dedicated chat, so the build shows its progress like any agent work without filling up the user's chats.
    const title = "📚 Knowledge base";
    const chat = db.listChats(projectId).find((c) => c.title === title && !c.archived)
      ?? db.createChat({ projectId, title, kind: "project", agentRole: "flashmaster" });
    await orch.sendUserMessage(chat.id, `/kb${focus?.trim() ? ` ${focus.trim()}` : ""}`, null, {});
    return db.getChat(chat.id)!;
  },
  codeGraphStatus: async (projectId) => codeGraph.status(projectId),
  scanCodeGraph: async (projectId) => {
    try { return await codeGraph.scan(projectId); } catch (e) { log("warn", `code graph scan: ${String(e)}`); throw e; } finally { emit({ type: "memory.changed" }); }
  },
  openCodeGraph: async (projectId) => {
    const html = codeGraph.status(projectId).html;
    if (!html) throw new Error("no code graph yet: press Scan code first");
    const err = await shell.openPath(html);
    if (err) throw new Error(err);
  },
  openKnowledgeFolder: async (projectId) => {
    const dir = knowledge.folder(projectId);
    mkdirSync(dir, { recursive: true });
    await shell.openPath(dir);
  },
  deleteMemory: async (id) => { memory.delete(Number(id)); emit({ type: "memory.changed" }); },
  promoteMemory: async (id, to) => {
    const cur = memory.require(id, null);
    const m = memory.promote(cur.id, to, { projectId: cur.projectId, chatId: cur.chatId }).memory;
    emit({ type: "memory.changed" });
    return m;
  },
  runTask: async (id, role) => {
    const t = db.getTask(id);
    if (!t) throw new Error("task not found");
    return orch.runTask(t, role);
  },
  getArtifact: async (id) => db.getArtifact(id),
  chatArtifacts: async (chatId) => {
    const c = db.getChat(chatId);
    const p = c?.projectId ? db.getProject(c.projectId) : null;
    return { changes: db.listFileChanges(chatId), artifacts: db.listChatArtifacts(chatId), project: p?.path ?? null };
  },
  getFileChange: async (id) => db.getFileChange(id),
  gitChanges: async (chatId) => {
    const root = chatProject(chatId);
    if (!root) return { ok: false, detail: "This chat has no project folder", files: [] };
    const r = await git(root, ["status", "--porcelain=v1", "--untracked-files=all"]);
    if (r.code !== 0) return { ok: false, detail: /not a git repository/i.test(r.out) ? "The project folder is not a git repository" : r.out.trim().slice(0, 300) || "git not available", files: [] };
    const files = r.out.split(/\r?\n/).filter((l) => l.length > 3).map((l) => {
      const st = l.slice(0, 2).trim() || "M";
      let path = l.slice(3);
      if (path.includes(" -> ")) path = path.split(" -> ").pop()!;
      return { path: path.replace(/^"|"$/g, ""), status: st === "??" ? "new" : st.includes("D") ? "deleted" : st.includes("A") ? "added" : st.includes("R") ? "renamed" : "modified" };
    });
    return { ok: true, files: files.slice(0, 500) };
  },
  gitFileDiff: async (chatId, path) => {
    const root = chatProject(chatId);
    if (!root) throw new Error("This chat has no project folder");
    const abs = join(root, path);
    if (!abs.startsWith(root)) throw new Error("path outside the project");
    const head = await git(root, ["show", `HEAD:${path.replace(/\\/g, "/")}`]);
    const newText = existsSync(abs) ? readFileSync(abs, "utf8") : "";
    return { oldText: head.code === 0 ? head.out : "", newText };
  },
  saveTextFile: async (defaultName, content) => {
    const r = await dialog.showSaveDialog(win!, { defaultPath: join(app.getPath("downloads"), basename(defaultName)) });
    if (r.canceled || !r.filePath) return null;
    writeFileSync(r.filePath, content, "utf8");
    return r.filePath;
  },
  usageSummary: async (days) => db.usageSummary(days, settings.get().tokens.dailyBudget),
  copilotUsage: async (refresh) => (refresh ? refreshCopilotUsage() : copilotUsage),
  detectHarnesses: async () => harnesses.detectAll(settings.get()),
  pickHarnessExecutable: async (h) => {
    const r = await dialog.showOpenDialog(win!, {
      title: `Choose the ${h} program`, properties: ["openFile"],
      filters: process.platform === "win32" ? [{ name: "Programs", extensions: ["exe", "cmd", "bat"] }] : [],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    settings.update({ harnesses: { [h]: { path: r.filePaths[0] } } } as any);
    const list = await harnesses.detectAll(settings.get());
    return list.find((x) => x.id === h) ?? null;
  },
  launchHarness: async (h) => {
    const st = (await harnesses.detectAll(settings.get())).find((x) => x.id === h);
    if (!st?.available || !st.path) return { ok: false, detail: "Not found yet — choose the program first." };
    if (process.platform === "win32") {
      const { spawn } = await import("node:child_process");
      // Own console window, started in the user's home folder (Copilot asks to trust the folder it starts in).
      const child = spawn("cmd.exe", ["/c", `start "Copilot CLI" /D "${homedir()}" "${st.path}"`], {
        detached: true, stdio: "ignore", windowsVerbatimArguments: true, env: { ...process.env, ...networkEnv(settings.get()) },
      });
      child.unref();
      return { ok: true, detail: "Copilot CLI opened in a new window." };
    }
    const err = await shell.openPath(st.path);
    return err ? { ok: false, detail: err } : { ok: true, detail: "Opened." };
  },
  checkHarness: async (h) => {
    const st = (await harnesses.detectAll(settings.get())).find((x) => x.id === h);
    if (!st?.available) return { found: false, path: null, version: null, signedIn: false, detail: st?.detail ?? "Not found" };
    const m = await refreshModels(h);
    const signedIn = m.models.length > 0 && !m.error;
    return { found: true, path: st.path, version: st.version, signedIn,
      detail: signedIn ? `Signed in — ${m.models.length} models available` : (m.error ?? "Not signed in") };
  },
  setCopilotToken: async (token) => {
    if (!token.trim()) { await secrets.set(copilotSecret, ""); return { tokenSet: false }; }
    await secrets.set(copilotSecret, token.trim());
    return { tokenSet: true };
  },
  copilotTokenSet: async () => existsSync(copilotSecret),
  marketplaceList: async (refresh) => {
    if (refresh || !marketplace.cached().length) {
      await refreshServerName();
      await marketplace.refresh(mpSources());
      if (refresh) void pollSubmissions().catch((e) => log("warn", `submissions: ${String(e?.message ?? e)}`));
    }
    return mpState();
  },
  marketplaceSubmitPick: async (mode) => {
    const smokePick = process.env.FLASH_SMOKE_SERVER ? process.env.FLASH_SMOKE_PICK : undefined; // screenshots: no native dialog
    let paths: string[];
    if (smokePick) paths = [smokePick];
    else {
      const r = mode === "folder"
        ? await dialog.showOpenDialog(win!, { title: "Plugin folder (plugin.json, agents/, workflows/, skills/, scripts/ …)", properties: ["openDirectory"] })
        : await dialog.showOpenDialog(win!, { title: "Agent, workflow or skill (.md) and scripts", properties: ["openFile", "multiSelections"],
          filters: [{ name: "Plugin files", extensions: ["md", "py", "ps1", "sh", "js", "mjs", "bat", "cmd", "txt", "json", "yml", "yaml"] }] });
      if (r.canceled || !r.filePaths.length) return null;
      paths = r.filePaths;
    }
    return draftFor(mode === "folder" ? { kind: "folder", path: paths[0]! } : { kind: "files", files: paths.map((p) => ({ path: p, name: basename(p), kind: guessKind(p) })) });
  },
  marketplaceSubmit: async ({ source, meta, notes, dryRun }) => {
    const { pkg, problems } = buildPackage(source, meta);
    const v = validatePackage(pkg, { knownTools: knownTools(), builtinRoles: builtinNames(), submit: true });
    const res: SubmitResult = { ok: false, errors: [...problems, ...v.errors], kinds: v.kinds, items: v.items };
    if (res.errors.length || dryRun) return { ...res, ok: !res.errors.length };
    if (!flashServer.configured()) return { ...res, errors: ["No Flash server configured (Settings → Flash server)"] };
    try {
      const submission = await flashServer.submit(pkg, notes);
      log("info", `submitted ${pkg.id}@${pkg.version} to the Flash server (#${submission.id})`);
      void pollSubmissions().catch(() => undefined);
      return { ...res, ok: true, submission };
    } catch (e: any) {
      return { ...res, errors: [String(e?.message ?? e)] };
    }
  },
  marketplaceSubmissions: async () => pollSubmissions(),
  marketplaceWithdraw: async (id) => { const s = await flashServer.withdraw(id); void pollSubmissions().catch(() => undefined); return s; },
  marketplaceInstall: async (sourceId, pluginId) => {
    const rec = await marketplace.install(mpSource(sourceId), pluginId);
    log("info", `plugin installed: ${rec.id}@${rec.version} from ${rec.sourceName}`);
    afterPluginChange();
    return rec;
  },
  marketplaceUninstall: async (pluginId) => { marketplace.uninstall(pluginId); afterPluginChange(); },
  marketplaceUpdateAll: async () => {
    const results: { id: string; ok: boolean; error?: string }[] = [];
    for (const u of marketplace.updates()) {
      try { await marketplace.install(mpSource(u.plugin.sourceId), u.plugin.id); results.push({ id: u.plugin.id, ok: true }); }
      catch (e: any) { results.push({ id: u.plugin.id, ok: false, error: String(e?.message ?? e) }); }
    }
    afterPluginChange();
    return results;
  },
  marketplaceTest: async (sourceId) => {
    const l = await marketplace.fetchIndex(mpSource(sourceId));
    return l.error ? { ok: false, detail: l.error } : { ok: true, detail: `${l.plugins.length} plugin(s) in "${l.sourceName}"` };
  },
  pluginInstructions: async (pluginId, enabled) => { marketplace.setInstructionsEnabled(pluginId, enabled); emit({ type: "plugins.changed", installed: marketplace.installed() }); },
  instructionSetup: async () => {
    const a = settings.get().agents;
    return HARNESS_IDS.map((h) => ({ harness: h, ...prepareInstructions(h, { mode: a.instructionMode, keepProject: a.keepProjectInstructions, dataDir }) }));
  },
  listModels: async (h, refresh) => (refresh || !modelState(h).fetchedAt ? refreshModels(h) : modelState(h)),
  allModels: async () => HARNESS_IDS.map(modelState),
  mcpStatus: async () => mcp.list(),
  mcpReinstall: async () => mcp.ensure(true),
  mcpInstall: async (id) => { await mcp.ensureCatalog(true, id); return mcp.list(); },
  mcpSelfTest: async () => {
    const role = roles.find((r) => r.name === "flashmaster") ?? roles[0]!;
    const specs = mcp.specsFor({ ...role, tools: [...new Set([...role.tools, "flashmaster-core", "jazz"])] }, `selftest-${Date.now()}`);
    return Promise.all(specs.map((sp) => selfTestServer(sp)));
  },
  jazzQuery: async (q) => needJazz().query(q),
  jazzGet: async (id) => needJazz().get(id),
  jazzSearch: async (q) => needJazz().search(q),
  jazzDetail: async (id) => needJazz().detail(id),
  jazzComment: async (id, text) => needJazz().comment(id, text),
  jazzUpdate: async (id, attributes, action) => needJazz().update(id, attributes, action),
  jazzProjectAreas: async () => needJazz().listProjectAreas(),
  jazzSetPassword: async (password) => {
    await secrets.set(secretFile, password);
    settings.update({ jazz: { hasPassword: !!password } });
    jazzClient = null; rmClient = null; etmClient = null; scmClient = null;
    await jazzSession().clearStorageData({ storages: ["cookies"] }); // new credentials → fresh login
  },
  jazzSignIn: async () => jazzSignIn(),
  rmTest: async () => requirements.test(),
  rmProjects: async () => requirements.projects(),
  rmModules: async (projectId, refresh) => requirements.modules(projectId, refresh),
  rmModule: async (ref, refresh, config) => requirements.module(ref, refresh, settings.get().jazz.rm.cacheHours, config),
  rmSearch: async (q, modules, top) => requirements.search(q, { modules, top: top ?? 25 }),
  rmDiagnostics: async () => [`server: ${rmUrl()}`, `auth: ${settings.get().jazz.authType}`, ...requirements.lastLog],
  qmTest: async () => { const e = etm(); return e ? e.test() : { ok: false, detail: "Enable Jazz and Test management, and set the server URL first" }; },
  qmProjects: async () => { const e = etm(); if (!e) throw new Error("Enable Jazz and Test management first"); return e.projects(true); },
  scmTest: async () => { const c = scm(); return c ? c.test() : { ok: false, detail: "Enable Jazz and Source control, and set the server URL first" }; },
  rmCached: async () => requirements.allCached().map((d) => ({ module: d.module, fetchedAt: d.fetchedAt, count: d.requirements.filter((r) => !r.heading).length })),
  jazzSignOut: async () => { await jazzSession().clearStorageData({ storages: ["cookies"] }); jazzClient = null; rmClient = null; etmClient = null; scmClient = null; },
  examSetup: async (install) => runExamSetup(install),
  jazzTest: async () => { const j = jazz(); return j ? j.test() : { ok: false, detail: "Enable Jazz and set the server URL first" }; },
  getSettings: async () => ({ settings: settings.get(), locked: settings.locked() }),
  updateSettings: async (patch) => { const r = settings.update(patch); if ((patch as any).usage) scheduleUsage(); return r; },
  resetSettings: async () => settings.reset(),
  exportData: async () => {
    const r = await dialog.showSaveDialog(win!, { defaultPath: `theflashmaster-export-${new Date().toISOString().slice(0, 10)}.json` });
    if (r.canceled || !r.filePath) return null;
    writeFileSync(r.filePath, JSON.stringify({ settings: settings.get(), data: db.exportAll() }, null, 2));
    return r.filePath;
  },
  updateState: async () => updater.state,
  updateCheck: async () => updater.check(),
  proxyTest: async (url: string) => proxyTest(url),
  proxyEnvState: async () => ({ supported: process.platform === "win32", ...currentProxyEnv() }),
  proxyEnvSet: async (input) => {
    const r = await setProxyEnv(input);
    log(r.ok ? "info" : "warn", `proxy env: ${r.ok ? "set" : "not set"} ${r.display}`.trim()); // display is redacted
    if (r.ok) await applyProxy();
    return r;
  },
  updateDownload: async () => updater.download(),
  updateInstall: async () => updater.install(),
  updateSignIn: async () => updateSignIn(),
  updateSetToken: async (token) => { await secrets.set(updateSecret, token.trim()); settings.update({ updates: { hasToken: !!token.trim() } }); void updater.check(); },
  serverTest: async () => { const r = await flashServer.test(); if (r.serverName) serverName = r.serverName; return r; },
  serverSetToken: async (token) => { await secrets.set(serverSecret, token.trim()); settings.update({ server: { hasToken: !!token.trim() } }); },
  appInfo: async () => ({ version: app.getVersion(), dataDir, platform: `${process.platform}-${process.arch}`, serverDefault: serverDefaultUrl }),
  windowState: async () => windowState(),
  windowControl: async (action) => {
    if (!win || win.isDestroyed()) return;
    if (action === "minimize") win.minimize();
    else if (action === "maximize") { if (win.isFullScreen()) win.setFullScreen(false); else if (win.isMaximized()) win.unmaximize(); else win.maximize(); }
    else if (action === "close") win.close();
  },
  terminalOpen: async (input) => terminals.open(input),
  terminalWrite: async (id, data) => terminals.write(id, data),
  terminalResize: async (id, cols, rows) => terminals.resize(id, cols, rows),
  terminalClose: async (id) => terminals.close(id),
};

for (const [name, fn] of Object.entries(api)) {
  ipcMain.handle(`flash:${name}`, async (_e, ...args: unknown[]) => (fn as (...a: unknown[]) => Promise<unknown>)(...args));
}

// ---------------- window & lifecycle ----------------
/**
 * Native blur behind the window ("liquid glass"): acrylic on Windows 11 22H2+ (build 22621), vibrancy on macOS.
 * Older Windows and Linux get an opaque window; the renderer then paints its own backdrop under the glass panels.
 */
function windowMaterial(): WindowState["material"] {
  if (!settings.get().general.windowGlass || process.env.FLASH_SMOKE_SHOT || process.env.FLASH_SMOKE_DEMO || process.env.FLASH_SMOKE_ASK || process.env.FLASH_SMOKE_GRAPH || process.env.FLASH_SMOKE_SERVER) return "none";
  if (process.platform === "darwin") return "vibrancy";
  if (process.platform === "win32") {
    const build = Number(process.getSystemVersion().split(".")[2] ?? 0);
    return build >= 22621 ? "acrylic" : "none";
  }
  return "none";
}
let material: WindowState["material"] = "none";
function windowState(): WindowState {
  const w = win && !win.isDestroyed() ? win : null;
  return { maximized: !!w?.isMaximized(), focused: !!w?.isFocused(), fullscreen: !!w?.isFullScreen(), platform: process.platform, material };
}

function createWindow(): void {
  material = windowMaterial();
  win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 1000, minHeight: 640, title: "TheFlashMaster", show: false,
    backgroundColor: material === "none" ? "#0f1115" : "#00000000",
    // Frameless: the app draws its own Windows-style caption buttons at the top right (TitleBar.tsx), with no bar behind them.
    // "hidden" keeps the native frame for resizing, Snap layouts, the shadow and rounded corners on Windows 11; macOS keeps its own traffic lights.
    titleBarStyle: "hidden",
    roundedCorners: true, // Windows 11 rounds frameless windows natively (DWM); older Windows can't.
    ...(process.platform === "darwin" ? { trafficLightPosition: { x: 18, y: 14 } } : {}),
    ...(material === "acrylic" ? { backgroundMaterial: "acrylic" as const } : {}),
    ...(material === "vibrancy" ? { vibrancy: "under-window" as const, visualEffectState: "followWindow" as const } : {}),
    autoHideMenuBar: true,
    icon: appIcon,
    webPreferences: { preload: join(here, "../preload/index.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  const pushState = () => emit({ type: "window.state", state: windowState() });
  win.on("maximize", pushState).on("unmaximize", pushState).on("restore", pushState).on("focus", pushState).on("blur", pushState)
    .on("enter-full-screen", pushState).on("leave-full-screen", pushState);
  win.once("ready-to-show", () => win?.show());
  const mainWin = win;
  guardWebContents(mainWin.webContents, "main window", log, (reason) => void rendererGaveUp(mainWin, reason));
  win.on("closed", () => { terminals.closeAll(); for (const w of popouts.values()) if (!w.isDestroyed()) w.close(); });
  // A reload starts a fresh renderer that knows none of the open shells: end them instead of leaving them orphaned.
  win.webContents.on("did-start-navigation", (d) => { if (d.isMainFrame && !d.isSameDocument) terminals.closeAll(); });
  // Smoke mode (CI / release check / docs screenshots) — only active when FLASH_SMOKE_* env vars are set.
  if (process.env.FLASH_SMOKE_SHOT || process.env.FLASH_SMOKE_DEMO || process.env.FLASH_SMOKE_ASK || process.env.FLASH_SMOKE_GRAPH || process.env.FLASH_SMOKE_SERVER) win.webContents.once("did-finish-load", () => void runSmoke(win!, log, appIcon, { orch, db }));
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) void shell.openExternal(url); return { action: "deny" }; });
  win.webContents.on("will-navigate", (e, url) => { if (!url.startsWith("file:") && !url.startsWith(process.env.ELECTRON_RENDERER_URL ?? "\0")) e.preventDefault(); });
  if (!settings.get().advanced.devTools) win.webContents.on("devtools-opened", () => { if (app.isPackaged) win?.webContents.closeDevTools(); });
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void win.loadFile(join(here, "../renderer/index.html"));
}

/** The renderer keeps crashing right after reloads: stop reloading and let the user choose. */
async function rendererGaveUp(w: BrowserWindow | null, reason: string): Promise<void> {
  if (!w || w.isDestroyed()) return;
  const { response } = await dialog.showMessageBox(w, {
    type: "error", buttons: ["Reload", "Quit"], defaultId: 0, cancelId: 1, title: "TheFlashMaster",
    message: "The window stopped working several times in a row.",
    detail: `Reason: ${reason}. Details are in ${join(dataDir, "logs", "main.log")}.`,
  });
  if (response === 0 && !w.isDestroyed()) w.webContents.reload();
  else if (response === 1) app.quit();
}

/** A thread in its own window: same renderer, started on `#thread/<chat>/<root>`, which shows only that thread. */
function openThreadWindow(chatId: string, rootId: string): void {
  openPopout(`thread:${rootId}`, `thread/${encodeURIComponent(chatId)}/${encodeURIComponent(rootId)}`,
    { width: 560, height: 820, minWidth: 380, minHeight: 420, title: "Thread — TheFlashMaster" });
}

/** A chat (an agent's dedicated chat, from the Specialists / Agents pills) in its own window, on `#chat/<chat>`. */
function openChatWindow(chatId: string): void {
  if (!db.getChat(chatId)) throw new Error("That chat no longer exists.");
  openPopout(`chat:${chatId}`, `chat/${encodeURIComponent(chatId)}`,
    { width: 900, height: 860, minWidth: 560, minHeight: 480, title: "Chat — TheFlashMaster" });
}

/** One window per key: a second open focuses (and restores) the window already showing it instead of duplicating it. */
function openPopout(key: string, hash: string, size: { width: number; height: number; minWidth: number; minHeight: number; title: string }): void {
  const open = popouts.get(key);
  if (open && !open.isDestroyed()) { if (open.isMinimized()) open.restore(); open.show(); open.focus(); return; }
  const w = new BrowserWindow({
    ...size, backgroundColor: "#0f1115", show: false, autoHideMenuBar: true, icon: appIcon,
    webPreferences: { preload: join(here, "../preload/index.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  popouts.set(key, w);
  guardWebContents(w.webContents, `${key.split(":")[0]} window`, log, (reason) => void rendererGaveUp(w, reason));
  w.on("closed", () => { if (popouts.get(key) === w) popouts.delete(key); });
  w.once("ready-to-show", () => w.show());
  w.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) void shell.openExternal(url); return { action: "deny" }; });
  w.webContents.on("will-navigate", (e, url) => { if (!url.startsWith("file:") && !url.startsWith(process.env.ELECTRON_RENDERER_URL ?? "\0")) e.preventDefault(); });
  if (process.env.ELECTRON_RENDERER_URL) void w.loadURL(`${process.env.ELECTRON_RENDERER_URL}#${hash}`);
  else void w.loadFile(join(here, "../renderer/index.html"), { hash });
}

// A crashed GPU process turns every window into a flat gray frame until Chromium restarts it: keep a record.
app.on("child-process-gone", (_e, d) => { if (d.reason !== "clean-exit") log("error", `${d.type} process gone: ${d.reason} (exit ${d.exitCode})${d.name ? ` ${d.name}` : ""}`); });
app.on("second-instance", () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });

/**
 * Proxy: Settings → Network wins; otherwise the standard https_proxy/http_proxy/no_proxy environment variables
 * (how most enterprise machines are configured); otherwise the Windows system proxy. Applied to Electron's network
 * stack (Jazz). Harness, MCP and pip processes inherit the environment and get the setting via networkEnv().
 */
function envProxy(): { proxy: string; noProxy: string } {
  const e = process.env;
  return { proxy: e.https_proxy || e.HTTPS_PROXY || e.http_proxy || e.HTTP_PROXY || "", noProxy: e.no_proxy || e.NO_PROXY || "" };
}
/** What applyProxy() configured, and what each session actually uses after a fallback. */
let proxyPrimary: ProxyCfg = { mode: "system" };
let proxyCreds: ParsedProxy["credentials"];
let proxySource = "system";
const proxyEffective = new WeakMap<Electron.Session, ProxyCfg>();
const proxiedSessions = () => [session.defaultSession, jazzSession(), updatesSession()];
async function applyProxy(): Promise<void> {
  const n = settings.get().network;
  const fromEnv = envProxy();
  const value = n.proxy || fromEnv.proxy;
  // Marketplaces are internal servers (IP:port): never send them through the corporate proxy.
  const mpHosts = mpSources().map((x) => { try { return new URL(normaliseUrl(x.url)).hostname; } catch { return ""; } }).filter(Boolean);
  const bypass = [n.noProxy || fromEnv.noProxy, ...mpHosts, "<local>"].filter(Boolean).join(",");
  const parsed = parseProxy(value, bypass);
  proxyPrimary = parsed?.config ?? { mode: "system" };
  if (proxyPrimary.mode === "system" || proxyPrimary.mode === "auto_detect") proxyPrimary = { ...proxyPrimary, proxyBypassRules: bypass };
  proxyCreds = parsed?.credentials;
  proxySource = parsed ? (n.proxy ? "settings" : "environment") : "system";
  for (const w of parsed?.warnings ?? []) log("warn", `proxy: ${w}`);
  for (const ses of proxiedSessions()) { await ses.setProxy(proxyPrimary); proxyEffective.set(ses, proxyPrimary); }
  log("info", `proxy: ${describe(proxyPrimary)} (${proxySource}${parsed ? `: ${parsed.display}` : ""})`);
}
/** Answer the proxy's sign-in challenge with credentials given in the proxy value (http://user:pass@host:port). */
app.on("login", (event, _wc, _details, authInfo, callback) => {
  if (authInfo.isProxy && proxyCreds) { event.preventDefault(); callback(proxyCreds.username, proxyCreds.password); }
});
/**
 * session.fetch with a proxy fallback: when Chromium rejects the proxy setup (ERR_NO_SUPPORTED_PROXIES and friends),
 * try the next mode (configured → system → direct) and keep the one that works for that session.
 */
function withProxyFallback(ses: () => Electron.Session, doFetch: (url: string, init?: any) => Promise<Response>) {
  return async (url: string, init?: any): Promise<Response> => {
    try { return await doFetch(url, init); }
    catch (e) {
      if (!isProxySetupError(e)) throw e;
      const s = ses();
      const current = proxyEffective.get(s) ?? proxyPrimary;
      const resolved = await s.resolveProxy(url).catch(() => "");
      log("warn", `proxy: ${String((e as Error)?.message ?? e)} for ${new URL(url).host} with ${describe(current)} (resolved "${resolved}")`);
      let lastErr: unknown = e;
      for (const next of fallbacks(current)) {
        await s.setProxy(next);
        try {
          const r = await doFetch(url, init);
          proxyEffective.set(s, next);
          log("warn", `proxy: falling back to ${describe(next)} — it works for ${new URL(url).host}`);
          return r;
        } catch (e2) { lastErr = e2; if (!isProxySetupError(e2)) { proxyEffective.set(s, next); throw e2; } }
      }
      await s.setProxy(current);
      throw new Error(explainProxyError(lastErr, resolved), { cause: e });
    }
  };
}
async function proxyTest(url: string): Promise<{ ok: boolean; detail: string; config: string; resolved: string; source: string }> {
  let target = (url || "").trim() || settings.get().jazz.serverUrl || "https://github.com";
  if (!/^https?:\/\//i.test(target)) target = `https://${target}`;
  const ses = jazzSession();
  const resolved = await ses.resolveProxy(target).catch((e) => `error: ${String(e)}`);
  try {
    const r = await jazzFetchRaw(target, { method: "GET" });
    return { ok: true, detail: `HTTP ${r.status} from ${new URL(target).host}`, config: describe(proxyEffective.get(ses) ?? proxyPrimary), resolved, source: proxySource };
  } catch (e) {
    return { ok: false, detail: String((e as Error)?.message ?? e), config: describe(proxyEffective.get(ses) ?? proxyPrimary), resolved, source: proxySource };
  }
}
settings.onChange(() => void applyProxy());

app.whenReady().then(async () => {
  // Self-signed / company-CA Jazz servers: accept their certificate only when the user turned it on, only for Jazz hosts.
  jazzSession().setCertificateVerifyProc((req, cb) => cb(settings.get().jazz.trustServerCert && jazzHosts().has(req.hostname) ? 0 : -3));
  await Promise.all([secrets.load(secretFile), secrets.load(copilotSecret), secrets.load(updateSecret), secrets.load(serverSecret)]);
  await applyProxy();
  const port = await bridge.start();
  mcp.setBridge(`http://127.0.0.1:${port}`, bridge.token);
  createWindow();
  if (settings.get().updates.autoCheck) updater.schedule(6, () => settings.get().updates.autoDownload);
  // Detect harnesses, then discover models of the available ones in the background (cache refreshed daily).
  void harnesses.detectAll(settings.get()).then((list) => {
    for (const h of list) if (h.available && h.id !== "mock" && Date.now() - (modelState(h.id).fetchedAt ?? 0) > 86400000) void refreshModels(h.id);
    const u = settings.get().usage;
    if (u.copilotMeter) void refreshCopilotUsage(); // local files only: cheap, so always fresh at start
    scheduleUsage();
  });
  void mcp.ensure().then((servers) => { emit({ type: "mcp.status", servers }); if (settings.get().exam.autoSetup) void runExamSetup(true, true); });
  if (settings.get().marketplace.autoCheckUpdates) setTimeout(() => void checkPluginUpdates().catch((e) => log("warn", `marketplace check failed: ${String(e)}`)), 4000);
  // Review status of my Flash server submissions: at start and every 15 minutes (status changes become notices).
  const pollQuietly = () => void pollSubmissions().catch((e) => log("warn", `submissions: ${String(e?.message ?? e)}`));
  setTimeout(pollQuietly, 8000);
  setInterval(pollQuietly, 15 * 60000);
});

app.on("before-quit", () => { terminals.closeAll(); void orch.stopAll(); bridge.stop(); db.close(); });
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
// macOS: clicking the Dock icon with no window open brings the main window back.
app.on("activate", () => { if (!app.isReady()) return; if (!win || win.isDestroyed()) createWindow(); else win.show(); });
