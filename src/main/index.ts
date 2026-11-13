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
import { McpBootstrap } from "./mcp";
import { JazzClient, type FetchLike } from "./jazz";
import { loadRoles, loadSkills, parseRole, validateRole } from "./roles";
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
db.reapOrphans();
db.applyRetention(settings.get().data.retentionDays);

let roles: RoleDef[] = [];
let skills: SkillDef[] = [];
const reloadRoles = () => {
  roles = loadRoles(join(resources, "agents"), userRolesDir);
  const builtinSkills = loadSkills(join(resources, "skills", "superpowers"));
  const userSkills = loadSkills(userSkillsDir);
  skills = [...builtinSkills.filter((b) => !userSkills.some((u) => u.command === b.command)), ...userSkills];
};
reloadRoles();

let win: BrowserWindow | null = null;
const emit = (e: AppEvent) => {
  win?.webContents.send("flash:event", e);
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
  attachmentRoots: () => attachmentRoots(),
  onModels: (h, models) => {
    const m = { harness: h, models, fetchedAt: Date.now(), error: null, loading: false };
    modelCache.set(h, m);
    emit({ type: "models.updated", models: m });
    saveModels();
  },
});

// ---------------- Jazz (password encrypted with the OS keychain via safeStorage) ----------------
const secretFile = join(dataDir, "jazz.secret");
const readJazzPassword = (): string => {
  try { return existsSync(secretFile) && safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(readFileSync(secretFile)) : ""; } catch { return ""; }
};
let jazzClient: JazzClient | null = null;
let jazzKey = "";
// Dedicated persistent session for Jazz: keeps the LTPA/JSESSIONID cookies across redirects and restarts,
// uses Chromium's network stack (Windows certificate store, proxy from applyProxy()).
const jazzSession = () => session.fromPartition("persist:jazz");
const netFetch: FetchLike = (url, init) => jazzSession().fetch(url, { ...init, credentials: "include", redirect: "follow" } as any) as any;
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
const needJazz = () => { const j = jazz(); if (!j) throw new Error("Jazz is not configured (Settings → Integrations → IBM Jazz)"); return j; };

bridge.register(buildTools({ db, orch, roles: () => roles, jazz, emitTask: (task) => emit({ type: "task.updated", task }) }));

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
  const p = adapter.listModels({ executable: st?.path ?? (s.harnesses[h]?.path || null), cwd: homedir(), env: networkEnv(s), extraArgs: s.harnesses[h]?.args ?? "" })
    .then((models) => set({ harness: h, models, fetchedAt: Date.now(), error: models.length ? null : "the harness did not report any models — type a model id", loading: false }))
    .catch((e) => set({ ...modelState(h), loading: false, error: String(e?.message ?? e) }))
    .finally(() => { inflight.delete(h); saveModels(); });
  inflight.set(h, p);
  return p;
}

// ---------------- marketplace ----------------
const marketplace = new Marketplace({
  dataDir, rolesDir: userRolesDir, skillsDir: userSkillsDir,
  fetch: (url, init) => session.defaultSession.fetch(url, { ...init, redirect: "follow" } as any) as any,
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
  usageSummary: async (days) => db.usageSummary(days, settings.get().tokens.dailyBudget),
  detectHarnesses: async () => harnesses.detectAll(settings.get()),
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
  jazzQuery: async (q) => needJazz().query(q),
  jazzGet: async (id) => needJazz().get(id),
  jazzSearch: async (q) => needJazz().search(q),
  jazzDetail: async (id) => needJazz().detail(id),
  jazzComment: async (id, text) => needJazz().comment(id, text),
  jazzUpdate: async (id, attributes, action) => needJazz().update(id, attributes, action),
  jazzProjectAreas: async () => needJazz().listProjectAreas(),
  jazzSetPassword: async (password) => {
    if (!safeStorage.isEncryptionAvailable()) throw new Error("OS encryption is not available on this machine");
    writeFileSync(secretFile, safeStorage.encryptString(password));
    settings.update({ jazz: { hasPassword: !!password } });
    jazzClient = null;
    await jazzSession().clearStorageData({ storages: ["cookies"] }); // new credentials → fresh login
  },
  jazzTest: async () => { const j = jazz(); return j ? j.test() : { ok: false, detail: "Enable Jazz and set the server URL first" }; },
  getSettings: async () => ({ settings: settings.get(), locked: settings.locked() }),
  updateSettings: async (patch) => settings.update(patch),
  resetSettings: async () => settings.reset(),
  exportData: async () => {
    const r = await dialog.showSaveDialog(win!, { defaultPath: `theflashmaster-export-${new Date().toISOString().slice(0, 10)}.json` });
    if (r.canceled || !r.filePath) return null;
    writeFileSync(r.filePath, JSON.stringify({ settings: settings.get(), data: db.exportAll() }, null, 2));
    return r.filePath;
  },
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
async function applyProxy(): Promise<void> {
  const n = settings.get().network;
  const fromEnv = envProxy();
  const proxy = n.proxy || fromEnv.proxy;
  // Marketplaces are internal servers (IP:port): never send them through the corporate proxy.
  const mpHosts = settings.get().marketplace.sources.map((x) => { try { return new URL(normaliseUrl(x.url)).hostname; } catch { return ""; } }).filter(Boolean);
  const bypass = [n.noProxy || fromEnv.noProxy, ...mpHosts, "<local>"].filter(Boolean).join(",");
  if (proxy) {
    const cfg = { proxyRules: proxy.replace(/^https?:\/\//, "").replace(/\/$/, ""), proxyBypassRules: bypass };
    await session.defaultSession.setProxy(cfg);
    await jazzSession().setProxy(cfg);
    log("info", `proxy: ${proxy.replace(/\/\/[^@/]*@/, "//***@")} (${n.proxy ? "settings" : "environment"})`);
  } else {
    await session.defaultSession.setProxy({ mode: "system" });
    await jazzSession().setProxy({ mode: "system" });
  }
}
settings.onChange(() => void applyProxy());

app.whenReady().then(async () => {
  await applyProxy();
  const port = await bridge.start();
  mcp.setBridge(`http://127.0.0.1:${port}`, bridge.token);
  createWindow();
  // Detect harnesses, then discover models of the available ones in the background (cache refreshed daily).
  void harnesses.detectAll(settings.get()).then((list) => {
    for (const h of list) if (h.available && h.id !== "mock" && Date.now() - (modelState(h.id).fetchedAt ?? 0) > 86400000) void refreshModels(h.id);
  });
  void mcp.ensure().then((servers) => emit({ type: "mcp.status", servers }));
  if (settings.get().marketplace.autoCheckUpdates) setTimeout(() => void checkPluginUpdates().catch((e) => log("warn", `marketplace check failed: ${String(e)}`)), 4000);
});

app.on("before-quit", () => { void orch.stopAll(); bridge.stop(); db.close(); });
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
