import { app, BrowserWindow, dialog, ipcMain, nativeImage, safeStorage, session, shell, Notification } from "electron";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { extname } from "node:path";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import type { FlashApi } from "@shared/api";
import type { AppEvent, RoleDef, SkillDef } from "@shared/types";
import { Db } from "./db";
import { SettingsStore } from "./settings-store";
import { HarnessRegistry } from "./harness/registry";
import { Orchestrator } from "./orchestrator";
import { Bridge } from "./bridge";
import { buildTools } from "./tools";
import { McpBootstrap, selfTestServer } from "./mcp";
import { JazzClient, type FetchLike } from "./jazz";
import { parseCopilotUsage } from "./copilot-usage";
import { Requirements, parseRmLink } from "./requirements";
import { SecretStore } from "./secrets";
import { Updater, parseFeed } from "./updater";
import { parseProxy, fallbacks, isProxySetupError, describe, explainProxyError, type ProxyCfg, type ParsedProxy } from "./proxy";
import type { AcpAdapter } from "./harness/acp";
import type { CopilotUsage } from "@shared/types";
import { loadRoles, loadSkills, parseRole, roleMarkdown, slugRole, validateRole, type AgentSpec } from "./roles";
import type { AgentImportResult, Attachment, HarnessId, HarnessModels } from "@shared/types";
import { randomUUID } from "node:crypto";
import { HARNESS_IDS } from "@shared/types";
import { networkEnv } from "./orchestrator";
import { prepareInstructions } from "./harness/instructions";
import { makeLogger } from "./log";
import { Marketplace, normaliseUrl } from "./marketplace";
import { runSmoke } from "./smoke";

const here = dirname(fileURLToPath(import.meta.url));
app.setName("TheFlashMaster");
if (!app.requestSingleInstanceLock()) app.quit();

// FLASH_DATA_DIR overrides the data folder (isolated test runs, or keeping data next to a portable exe).
if (process.env.FLASH_DATA_DIR) app.setPath("userData", process.env.FLASH_DATA_DIR);
const dataDir = app.getPath("userData");
mkdirSync(dataDir, { recursive: true });
const resources = app.isPackaged ? process.resourcesPath : app.getAppPath();
const userRolesDir = join(dataDir, "agents");
mkdirSync(userRolesDir, { recursive: true });
const userSkillsDir = join(dataDir, "skills"); // workflows installed from marketplaces
mkdirSync(userSkillsDir, { recursive: true });
const policyFile = process.platform === "win32" ? join(process.env.PROGRAMDATA ?? "C:\\ProgramData", "TheFlashMaster", "policy.json") : join(dataDir, "policy.json");

const settings = new SettingsStore(join(dataDir, "settings.json"), policyFile);
const log = makeLogger(join(dataDir, "logs"), () => settings.get().advanced.logLevel);
log("info", `starting TheFlashMaster ${app.getVersion()}`);
const db = new Db(join(dataDir, "flashmaster.db"));
db.defaultAutopilot = settings.get().general.autopilotDefault !== false;
settings.onChange((st) => { db.defaultAutopilot = st.general.autopilotDefault !== false; });
db.reapOrphans();
db.applyRetention(settings.get().data.retentionDays);

let roles: RoleDef[] = [];
let skills: SkillDef[] = [];
/** Agents created by an agent with keep: false — live until the app restarts. */
const tempRoles = new Map<string, RoleDef>();
const reloadRoles = () => {
  roles = loadRoles(join(resources, "agents"), userRolesDir);
  for (const r of tempRoles.values()) if (!roles.some((x) => x.name === r.name)) roles.push(r);
  const builtinSkills = loadSkills(join(resources, "skills", "superpowers"));
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
const emit = (e: AppEvent) => {
  if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send("flash:event", e);
  if (e.type === "notice" && e.level !== "info" && settings.get().general.notifications && !win?.isFocused() && Notification.isSupported()) {
    new Notification({ title: "TheFlashMaster", body: e.text }).show();
  }
};

const harnesses = new HarnessRegistry();
const bridge = new Bridge();
const mainDir = join(app.getAppPath(), "out", "main").replace("app.asar", "app.asar.unpacked");
const mcp = new McpBootstrap({
  nodeEntry: (id) => join(mainDir, `mcp-${id}.mjs`),
  nodeExec: process.execPath,
  nodeEnv: { ELECTRON_RUN_AS_NODE: "1" },
  pythonSrc: join(resources, "mcp-servers"),
  dataDir,
}, () => settings.get(), (servers) => emit({ type: "mcp.status", servers }));

const orch = new Orchestrator({
  db, harnesses, log, settings: () => settings.get(), roles: () => roles, skills: () => skills, emit,
  mcpServersFor: (role, agentId) => mcp.specsFor(role, agentId), homeDir: homedir(), dataDir,
  extraRules: () => marketplace.instructions(),
  harnessEnv: (h) => harnessEnv(h),
  toolsLoaded: (agentId) => bridge.toolsListed.has(agentId),
  createRole,
  // Text-mode tools for agents without MCP (Pi, or MCP blocked): the same handlers the MCP forwarder reaches.
  listTools: (set) => bridge.list(set),
  callTool: (name, args, agentId, set) => bridge.call(name, args, agentId, set),
  attachmentRoots: () => attachmentRoots(),
  onModels: (h, models) => {
    const m = { harness: h, models, fetchedAt: Date.now(), error: null, loading: false };
    modelCache.set(h, m);
    emit({ type: "models.updated", models: m });
    saveModels();
  },
});

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
      width: 980, height: 760, parent: win ?? undefined, title: "Sign in to IBM Jazz", autoHideMenuBar: true, backgroundColor: "#ffffff",
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
      jazzClient = null; rmClient = null;
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
const needJazz = () => { const j = jazz(); if (!j) throw new Error("Jazz is not configured (Settings → Integrations → IBM Jazz)"); return j; };

bridge.register(buildTools({ db, orch, roles: () => roles, jazz, requirements, rmProjects: () => settings.get().jazz.rm.projects,
  onArtifact: (agentId) => { const a = db.getAgent(agentId); if (a?.chatId) emit({ type: "artifacts.changed", chatId: a.chatId }); }, emitTask: (task) => emit({ type: "task.updated", task }) }));

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
  const ignore = join(project.path, ".flashmaster", ".gitignore");
  if (!existsSync(ignore)) writeFileSync(ignore, "*\n");
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

// ---------------- Copilot usage meter (data only from Copilot CLI's /usage) ----------------
const usageFile = join(dataDir, "copilot-usage.json");
let copilotUsage: CopilotUsage | null = (() => { try { return JSON.parse(readFileSync(usageFile, "utf8")); } catch { return null; } })();
let usageInflight: Promise<CopilotUsage | null> | null = null;
const setUsage = (u: CopilotUsage) => { copilotUsage = u; emit({ type: "copilotUsage.updated", usage: u }); return u; };
function refreshCopilotUsage(): Promise<CopilotUsage | null> {
  if (usageInflight) return usageInflight;
  const s = settings.get();
  usageInflight = (async () => {
    const st = harnesses.cached("copilot")?.available ? harnesses.cached("copilot") : (await harnesses.detectAll(s)).find((h) => h.id === "copilot");
    return st;
  })().then((st) => runUsage(s, st)).finally(() => { usageInflight = null; });
  return usageInflight;
}
function runUsage(s: ReturnType<typeof settings.get>, st: ReturnType<typeof harnesses.cached>): Promise<CopilotUsage | null> {
  if (!st?.available) {
    return Promise.resolve(setUsage({ ...(copilotUsage ?? parseCopilotUsage("", 0)), ok: false, loading: false, error: "Copilot CLI not found" }));
  }
  setUsage({ ...(copilotUsage ?? parseCopilotUsage("", 0)), loading: true, error: copilotUsage?.ok ? copilotUsage.error : null });
  const adapter = harnesses.get("copilot") as AcpAdapter;
  return adapter.runCommand({ executable: st.path ?? (s.harnesses.copilot.path || null), cwd: homedir(), env: { ...networkEnv(s), ...harnessEnv("copilot") }, extraArgs: s.harnesses.copilot.args ?? "" },
    "usage", s.usage.onlyIfAdvertised)
    .then((r) => {
      if (!r.advertised && s.usage.onlyIfAdvertised) {
        return setUsage({ ...parseCopilotUsage(""), ok: false, advertised: false,
          error: `This Copilot CLI does not offer /usage to apps (commands: ${r.commands.slice(0, 12).join(", ") || "none"}). Update Copilot CLI, or turn off “only if advertised” (may use a premium request).` });
      }
      return setUsage({ ...parseCopilotUsage(r.text), advertised: r.advertised });
    })
    .catch((e) => setUsage({ ...(copilotUsage ?? parseCopilotUsage("", 0)), ok: false, loading: false, error: String(e?.message ?? e) }))
    .finally(() => {
      try { writeFileSync(usageFile, JSON.stringify({ ...copilotUsage, loading: false })); } catch { /* best effort */ }
    });
}
let usageTimer: ReturnType<typeof setInterval> | null = null;
const scheduleUsage = () => {
  if (usageTimer) clearInterval(usageTimer);
  usageTimer = null;
  const u = settings.get().usage;
  if (!u.copilotMeter || u.refreshMinutes <= 0) return;
  usageTimer = setInterval(() => void refreshCopilotUsage(), Math.max(5, u.refreshMinutes) * 60000);
};

// ---------------- app updates (repository releases with latest.json) ----------------
const updatesSession = () => session.fromPartition("persist:updates");
const updateSecret = join(dataDir, "updates.secret");
/** Update source: setting/policy override, else the repository's package.json (flashmaster.updates.url). */
const repoUpdates = (() => { try { return JSON.parse(readFileSync(join(app.getAppPath(), "package.json"), "utf8"))?.flashmaster?.updates ?? {}; } catch { return {}; } })();
const updateFeed = () => {
  const u = settings.get().updates;
  return { url: (u.feedUrl || process.env.FLASH_UPDATE_URL || repoUpdates.url || "").trim(), channel: (u.channel || repoUpdates.channel || "stable") as "stable" | "beta", token: secrets.get(updateSecret) };
};
const updater = new Updater({
  fetch: withProxyFallback(() => updatesSession(), (url, init) => updatesSession().fetch(url, { ...init, redirect: "follow", credentials: "include" } as any) as any) as any,
  version: app.getVersion(),
  mode: !app.isPackaged ? "dev" : process.env.PORTABLE_EXECUTABLE_FILE ? "portable" : "installer",
  portablePath: process.env.PORTABLE_EXECUTABLE_FILE,
  dataDir, feed: updateFeed,
  emit: (state) => emit({ type: "update.state", state }),
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
    const w = new BrowserWindow({ width: 1000, height: 780, parent: win ?? undefined, title: "Sign in to GitHub", autoHideMenuBar: true,
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
const mpSources = () => settings.get().marketplace.sources;
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
  const m = settings.get().marketplace;
  if (!m.sources.some((x) => x.enabled)) return;
  await marketplace.refresh(m.sources);
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
  toggleReaction: async (messageId, emoji) => {
    const reactions = db.toggleReaction(messageId, emoji);
    const m = db.getMessage(messageId);
    if (m) emit({ type: "reaction.changed", messageId, chatId: m.chatId, reactions });
    orch.onReaction(messageId, emoji, reactions);
    return reactions;
  },
  listAgents: async (f) => db.listAgents(f ?? {}),
  startAgent: async (i) => orch.startAgent(i.projectId, i.role, i.brief),
  pauseAgent: async (id) => orch.pause(id),
  resumeAgent: async (id) => orch.resume(id),
  stopAgent: async (id) => orch.stop(id),
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
    if (refresh || !marketplace.cached().length) await marketplace.refresh(mpSources());
    return mpState();
  },
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
    jazzClient = null; rmClient = null;
    await jazzSession().clearStorageData({ storages: ["cookies"] }); // new credentials → fresh login
  },
  jazzSignIn: async () => jazzSignIn(),
  rmTest: async () => requirements.test(),
  rmProjects: async () => requirements.projects(),
  rmModules: async (projectId, refresh) => requirements.modules(projectId, refresh),
  rmModule: async (ref, refresh, config) => requirements.module(ref, refresh, settings.get().jazz.rm.cacheHours, config),
  rmSearch: async (q, modules, top) => requirements.search(q, { modules, top: top ?? 25 }),
  rmDiagnostics: async () => [`server: ${rmUrl()}`, `auth: ${settings.get().jazz.authType}`, ...requirements.lastLog],
  rmCached: async () => requirements.allCached().map((d) => ({ module: d.module, fetchedAt: d.fetchedAt, count: d.requirements.filter((r) => !r.heading).length })),
  jazzSignOut: async () => { await jazzSession().clearStorageData({ storages: ["cookies"] }); jazzClient = null; rmClient = null; },
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
  updateDownload: async () => updater.download(),
  updateInstall: async () => updater.install(),
  updateSignIn: async () => updateSignIn(),
  updateSetToken: async (token) => { await secrets.set(updateSecret, token.trim()); settings.update({ updates: { hasToken: !!token.trim() } }); void updater.check(); },
  appInfo: async () => ({ version: app.getVersion(), dataDir, platform: `${process.platform}-${process.arch}` }),
};

for (const [name, fn] of Object.entries(api)) {
  ipcMain.handle(`flash:${name}`, async (_e, ...args: unknown[]) => (fn as (...a: unknown[]) => Promise<unknown>)(...args));
}

// ---------------- window & lifecycle ----------------
function createWindow(): void {
  win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 1000, minHeight: 640, title: "TheFlashMaster", backgroundColor: "#0f1115", show: false,
    autoHideMenuBar: true,
    icon: join(resources, "build", "icon.png"),
    webPreferences: { preload: join(here, "../preload/index.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.once("ready-to-show", () => win?.show());
  // Smoke mode (CI / release check / docs screenshots) — only active when FLASH_SMOKE_* env vars are set.
  if (process.env.FLASH_SMOKE_SHOT || process.env.FLASH_SMOKE_DEMO) win.webContents.once("did-finish-load", () => void runSmoke(win!, log));
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) void shell.openExternal(url); return { action: "deny" }; });
  win.webContents.on("will-navigate", (e, url) => { if (!url.startsWith("file:") && !url.startsWith(process.env.ELECTRON_RENDERER_URL ?? "\0")) e.preventDefault(); });
  if (!settings.get().advanced.devTools) win.webContents.on("devtools-opened", () => { if (app.isPackaged) win?.webContents.closeDevTools(); });
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void win.loadFile(join(here, "../renderer/index.html"));
}

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
  const mpHosts = settings.get().marketplace.sources.map((x) => { try { return new URL(normaliseUrl(x.url)).hostname; } catch { return ""; } }).filter(Boolean);
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
  await Promise.all([secrets.load(secretFile), secrets.load(copilotSecret), secrets.load(updateSecret)]);
  await applyProxy();
  const port = await bridge.start();
  mcp.setBridge(`http://127.0.0.1:${port}`, bridge.token);
  createWindow();
  if (settings.get().updates.autoCheck) updater.schedule(6, () => settings.get().updates.autoDownload);
  // Detect harnesses, then discover models of the available ones in the background (cache refreshed daily).
  void harnesses.detectAll(settings.get()).then((list) => {
    for (const h of list) if (h.available && h.id !== "mock" && Date.now() - (modelState(h.id).fetchedAt ?? 0) > 86400000) void refreshModels(h.id);
    const u = settings.get().usage;
    if (u.copilotMeter && list.some((h) => h.id === "copilot" && h.available)
      && Date.now() - (copilotUsage?.fetchedAt ?? 0) > Math.max(5, u.refreshMinutes || 30) * 60000) void refreshCopilotUsage();
    scheduleUsage();
  });
  void mcp.ensure().then((servers) => emit({ type: "mcp.status", servers }));
  if (settings.get().marketplace.autoCheckUpdates) setTimeout(() => void checkPluginUpdates().catch((e) => log("warn", `marketplace check failed: ${String(e)}`)), 4000);
});

app.on("before-quit", () => { void orch.stopAll(); bridge.stop(); db.close(); });
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
