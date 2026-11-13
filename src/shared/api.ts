import type {
  AgentFlow, Attachment, HarnessModels, InstalledPlugin, MarketplaceListing, AgentImportResult, AgentRun, AppEvent, Artifact, Chat, ChatArtifacts, UpdateState, FileChange, HarnessId, HarnessStatus, JazzWorkItem, JazzComment, RmProject, RmModule, RmModuleData, RmHit, CopilotUsage, JazzSearch, McpServerStatus, Message,
  Project, RoleDef, SkillDef, Task, TaskStatus, UsageSummary,
} from "./types";
import type { DeepPartial, Settings } from "./settings";

/**
 * The complete renderer → main contract. Every method maps 1:1 to an IPC channel
 * named after the key (see preload). Keep it flat and serialisable.
 */
export interface FlashApi {
  // projects & chats
  listProjects(): Promise<Project[]>;
  pickFolder(): Promise<string | null>;
  createProject(path: string, name?: string): Promise<Project>;
  removeProject(id: string): Promise<void>;
  listChats(projectId: string | null): Promise<Chat[]>;
  getMasterChat(): Promise<Chat>;
  createChat(input: { projectId: string | null; title?: string; agentRole?: string }): Promise<Chat>;
  updateChat(id: string, patch: Partial<Pick<Chat, "title" | "agentRole" | "harness" | "model" | "superpowers" | "mode" | "autopilot" | "archived" | "pinned">>): Promise<Chat>;
  /** Fresh start for the agents of a chat: closes their sessions; earlier messages stay visible but are no longer sent. */
  resetContext(chatId: string): Promise<Message>;
  exportChat(chatId: string): Promise<string>; // Markdown transcript
  renameProject(id: string, name: string): Promise<void>;
  openProjectFolder(id: string): Promise<void>;
  deleteChat(id: string): Promise<void>;

  // messages
  listMessages(chatId: string, parentId: string | null): Promise<Message[]>;
  sendMessage(input: { chatId: string; content: string; parentId?: string | null; attachments?: Attachment[]; whileBusy?: "queue" | "steer" }): Promise<Message>;
  saveAttachment(input: { chatId: string; name: string; mime: string; dataBase64: string }): Promise<Attachment>;
  pickAttachments(chatId: string): Promise<Attachment[]>;
  openAttachment(path: string): Promise<void>;
  /** Pop a thread out into its own window (it stays live like the main one). */
  openThreadWindow(chatId: string, rootId: string): Promise<void>;
  toggleReaction(messageId: string, emoji: string): Promise<string[]>;

  // agents
  listAgents(filter?: { projectId?: string | null; activeOnly?: boolean }): Promise<AgentRun[]>;
  startAgent(input: { projectId: string | null; role: string; brief: string }): Promise<AgentRun>;
  pauseAgent(id: string): Promise<void>;
  resumeAgent(id: string): Promise<void>;
  stopAgent(id: string): Promise<void>;
  stopAll(): Promise<void>;
  getAgentFlow(agentId: string): Promise<AgentFlow>;
  listRoles(): Promise<RoleDef[]>;
  listSkills(): Promise<SkillDef[]>;
  openRolesFolder(): Promise<void>;
  agentTemplate(): Promise<string>;
  saveAgentTemplate(): Promise<string | null>;
  validateAgent(text: string): Promise<AgentImportResult>;
  importAgentText(text: string, fileName?: string): Promise<AgentImportResult>;
  importAgentFiles(): Promise<AgentImportResult[]>;
  removeAgent(name: string): Promise<void>;
  exportAgent(name: string): Promise<string | null>;

  // tasks
  listTasks(filter?: { projectId?: string | null; status?: TaskStatus }): Promise<Task[]>;
  createTask(input: Partial<Task> & { title: string }): Promise<Task>;
  updateTask(id: string, patch: Partial<Task>): Promise<Task>;
  deleteTask(id: string): Promise<void>;
  runTask(id: string, role?: string): Promise<AgentRun>;

  // artifacts / usage
  getArtifact(id: string): Promise<Artifact | null>;
  /** Files changed by agents in this chat, saved artifacts, and the project folder. */
  chatArtifacts(chatId: string): Promise<ChatArtifacts>;
  getFileChange(id: string): Promise<FileChange | null>;
  /** Uncommitted changes in the chat's project folder (git status), and one file's HEAD vs working copy. */
  gitChanges(chatId: string): Promise<{ ok: boolean; detail?: string; files: { path: string; status: string }[] }>;
  gitFileDiff(chatId: string, path: string): Promise<{ oldText: string; newText: string }>;
  /** Save text to a file the user picks (download). */
  saveTextFile(defaultName: string, content: string): Promise<string | null>;
  usageSummary(days: number): Promise<UsageSummary>;
  copilotUsage(refresh: boolean): Promise<CopilotUsage | null>;

  // harnesses / mcp
  detectHarnesses(): Promise<HarnessStatus[]>;
  /** Pick the harness executable (e.g. the downloaded copilot.exe) and re-detect. */
  pickHarnessExecutable(harness: HarnessId): Promise<HarnessStatus | null>;
  /** Open the harness CLI in its own window (e.g. to type /login in Copilot CLI). */
  launchHarness(harness: HarnessId): Promise<{ ok: boolean; detail: string }>;
  /** Found + signed in? Signed in = the harness answered with its model list. */
  checkHarness(harness: HarnessId): Promise<{ found: boolean; path: string | null; version: string | null; signedIn: boolean; detail: string }>;
  /** GitHub token for Copilot CLI (GH_TOKEN), stored encrypted; empty string removes it. */
  setCopilotToken(token: string): Promise<{ tokenSet: boolean }>;
  copilotTokenSet(): Promise<boolean>;
  marketplaceList(refresh?: boolean): Promise<{ listings: MarketplaceListing[]; installed: InstalledPlugin[]; updates: { id: string; from: string; to: string }[] }>;
  marketplaceInstall(sourceId: string, pluginId: string): Promise<InstalledPlugin>;
  marketplaceUninstall(pluginId: string): Promise<void>;
  marketplaceUpdateAll(): Promise<{ id: string; ok: boolean; error?: string }[]>;
  marketplaceTest(sourceId: string): Promise<{ ok: boolean; detail: string }>;
  pluginInstructions(pluginId: string, enabled: boolean): Promise<void>;
  listModels(harness: HarnessId, refresh?: boolean): Promise<HarnessModels>;
  instructionSetup(): Promise<{ harness: HarnessId; args: string[]; env: Record<string, string>; coverage: "full" | "partial" | "none"; note: string }[]>;
  allModels(): Promise<HarnessModels[]>;
  mcpStatus(): Promise<McpServerStatus[]>;
  mcpReinstall(): Promise<McpServerStatus[]>;
  /** Install (or reinstall) one recommended server now. */
  mcpInstall(id: string): Promise<McpServerStatus[]>;
  /** Start TheFlashMaster's tool servers like a harness does and list their tools. */
  mcpSelfTest(): Promise<{ name: string; ok: boolean; tools: number; detail: string }[]>;

  // jazz
  jazzQuery(query: string): Promise<JazzWorkItem[]>;
  jazzGet(id: string): Promise<JazzWorkItem>;
  jazzSearch(q: JazzSearch): Promise<JazzWorkItem[]>;
  jazzDetail(id: string): Promise<{ item: JazzWorkItem; comments: JazzComment[] }>;
  jazzComment(id: string, text: string): Promise<void>;
  jazzUpdate(id: string, attributes: Record<string, unknown>, action?: string): Promise<JazzWorkItem>;
  jazzProjectAreas(): Promise<string[]>;
  jazzSetPassword(password: string): Promise<void>;
  jazzTest(): Promise<{ ok: boolean; detail: string }>;
  /** Detect EXAM, install the RESTapi plugin when `install` (from Settings → EXAM → plugin package), run all checks. */
  examSetup(install: boolean): Promise<ExamSetupResult>;
  /** Opens a sign-in window (company SSO / Jazz Authorization Server); resolves when signed in or closed. */
  jazzSignIn(): Promise<{ ok: boolean; detail: string }>;
  jazzSignOut(): Promise<void>;
  // DOORS Next requirements
  rmTest(): Promise<{ ok: boolean; detail: string }>;
  rmProjects(): Promise<RmProject[]>;
  rmModules(projectId: string, refresh?: boolean): Promise<RmModule[]>;
  rmModule(moduleRef: string, refresh?: boolean, config?: string): Promise<RmModuleData>;
  rmSearch(query: string, modules?: string[], top?: number): Promise<RmHit[]>;
  /** Steps and server answers of the last module listing (for troubleshooting). */
  rmDiagnostics(): Promise<string[]>;
  rmCached(): Promise<{ module: RmModule; fetchedAt: number; count: number }[]>;

  // settings
  getSettings(): Promise<{ settings: Settings; locked: string[] }>;
  updateSettings(patch: DeepPartial<Settings>): Promise<Settings>;
  resetSettings(): Promise<Settings>;
  exportData(): Promise<string | null>;
  // updates
  updateState(): Promise<UpdateState>;
  updateCheck(): Promise<UpdateState>;
  updateDownload(): Promise<UpdateState>;
  updateInstall(): Promise<void>;
  /** Sign in to the repository's GitHub (company SSO) in a window, for private/internal repositories. */
  updateSignIn(): Promise<{ ok: boolean; detail: string }>;
  updateSetToken(token: string): Promise<void>;
  /** Show which proxy the app uses for a URL and try to reach it (blank = the Jazz server). */
  proxyTest(url: string): Promise<{ ok: boolean; detail: string; config: string; resolved: string; source: string }>;
  appInfo(): Promise<{ version: string; dataDir: string; platform: string }>;
}

export interface ExamSetupResult {
  ok: boolean;
  home: string;
  actions: string[];
  checks: { name: string; state: "ok" | "warn" | "fail"; detail: string }[];
  error?: string;
}

export const API_METHODS: (keyof FlashApi)[] = [
  "listProjects", "pickFolder", "createProject", "removeProject", "listChats", "getMasterChat", "createChat",
  "updateChat", "resetContext", "exportChat", "renameProject", "openProjectFolder", "deleteChat", "listMessages", "sendMessage", "saveAttachment", "pickAttachments", "openAttachment", "openThreadWindow", "toggleReaction", "listAgents", "startAgent",
  "pauseAgent", "resumeAgent", "stopAgent", "stopAll", "getAgentFlow", "listRoles", "listSkills", "openRolesFolder", "agentTemplate", "saveAgentTemplate", "validateAgent", "importAgentText",
  "importAgentFiles", "removeAgent", "exportAgent", "listTasks",
  "createTask", "updateTask", "deleteTask", "runTask", "getArtifact", "chatArtifacts", "getFileChange", "gitChanges", "gitFileDiff", "saveTextFile", "usageSummary", "copilotUsage", "detectHarnesses", "pickHarnessExecutable", "launchHarness", "checkHarness", "setCopilotToken", "copilotTokenSet", "marketplaceList", "marketplaceInstall", "marketplaceUninstall", "marketplaceUpdateAll",
  "marketplaceTest", "pluginInstructions", "listModels", "instructionSetup", "allModels",
  "mcpStatus", "mcpReinstall", "mcpInstall", "mcpSelfTest", "jazzQuery", "jazzGet", "jazzSearch", "jazzDetail", "jazzComment", "jazzUpdate", "jazzProjectAreas", "jazzSetPassword", "jazzTest", "examSetup", "jazzSignIn", "jazzSignOut", "rmTest", "rmProjects", "rmModules", "rmModule", "rmSearch", "rmCached", "rmDiagnostics", "getSettings",
  "updateSettings", "resetSettings", "exportData", "updateState", "updateCheck", "updateDownload", "updateInstall", "updateSignIn", "updateSetToken", "proxyTest", "appInfo",
];

export interface FlashBridge {
  api: FlashApi;
  onEvent(cb: (e: AppEvent) => void): () => void;
}

export type { HarnessId };
