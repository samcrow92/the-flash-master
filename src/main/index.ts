import { app, BrowserWindow, dialog, ipcMain, net, safeStorage, session, shell, Notification } from "electron";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
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
import type { AgentImportResult } from "@shared/types";
import { makeLogger } from "./log";
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
  skills = loadSkills(join(resources, "skills", "superpowers"));
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
  mcpServersFor: (role, agentId) => mcp.specsFor(role, agentId), homeDir: homedir(),
});

// ---------------- Jazz (password encrypted with the OS keychain via safeStorage) ----------------
const secretFile = join(dataDir, "jazz.secret");
const readJazzPassword = (): string => {
  try { return existsSync(secretFile) && safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(readFileSync(secretFile)) : ""; } catch { return ""; }
};
let jazzClient: JazzClient | null = null;
let jazzKey = "";
const netFetch: FetchLike = (url, init) => net.fetch(url, init as any) as any;
const jazz = (): JazzClient | null => {
  const j = settings.get().jazz;
  if (!j.enabled || !j.serverUrl) return null;
  const key = JSON.stringify([j.serverUrl, j.projectArea, j.authType, j.username, j.hasPassword]);
  if (!jazzClient || key !== jazzKey) {
    jazzClient = new JazzClient({ serverUrl: j.serverUrl, projectArea: j.projectArea, authType: j.authType, username: j.username, password: readJazzPassword() }, netFetch);
    jazzKey = key;
  }
  return jazzClient;
};

bridge.register(buildTools({ db, orch, roles: () => roles, jazz, emitTask: (task) => emit({ type: "task.updated", task }) }));

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
  updateChat: async (id, patch) => db.updateChat(id, patch),
  deleteChat: async (id) => { await orch.stopChat(id); db.deleteChat(id); },
  listMessages: async (chatId, parentId) => db.listMessages(chatId, parentId),
  sendMessage: async (i) => orch.sendUserMessage(i.chatId, i.content, i.parentId ?? null),
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
  mcpStatus: async () => mcp.list(),
  mcpReinstall: async () => mcp.ensure(true),
  jazzQuery: async (q) => { const j = jazz(); if (!j) throw new Error("Jazz is not configured"); return j.query(q); },
  jazzGet: async (id) => { const j = jazz(); if (!j) throw new Error("Jazz is not configured"); return j.get(id); },
  jazzSetPassword: async (password) => {
    if (!safeStorage.isEncryptionAvailable()) throw new Error("OS encryption is not available on this machine");
    writeFileSync(secretFile, safeStorage.encryptString(password));
    settings.update({ jazz: { hasPassword: !!password } });
    jazzClient = null;
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
  const bypass = [n.noProxy || fromEnv.noProxy, "<local>"].filter(Boolean).join(",");
  if (proxy) {
    await session.defaultSession.setProxy({ proxyRules: proxy.replace(/^https?:\/\//, "").replace(/\/$/, ""), proxyBypassRules: bypass });
    log("info", `proxy: ${proxy.replace(/\/\/[^@/]*@/, "//***@")} (${n.proxy ? "settings" : "environment"})`);
  } else {
    await session.defaultSession.setProxy({ mode: "system" });
  }
}
settings.onChange(() => void applyProxy());

app.whenReady().then(async () => {
  await applyProxy();
  const port = await bridge.start();
  mcp.setBridge(`http://127.0.0.1:${port}`, bridge.token);
  createWindow();
  void harnesses.detectAll(settings.get());
  void mcp.ensure().then((servers) => emit({ type: "mcp.status", servers }));
});

app.on("before-quit", () => { void orch.stopAll(); bridge.stop(); db.close(); });
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
