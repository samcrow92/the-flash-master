import type {
  AgentFlow, Attachment, HarnessModels, InstalledPlugin, MarketplaceListing, AgentImportResult, AgentRun, AppEvent, Artifact, Chat, HarnessId, HarnessStatus, JazzWorkItem, JazzComment, CopilotUsage, JazzSearch, McpServerStatus, Message,
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
  updateChat(id: string, patch: Partial<Pick<Chat, "title" | "agentRole" | "harness" | "model" | "superpowers" | "mode" | "autopilot">>): Promise<Chat>;
  deleteChat(id: string): Promise<void>;

  // messages
  listMessages(chatId: string, parentId: string | null): Promise<Message[]>;
  sendMessage(input: { chatId: string; content: string; parentId?: string | null; attachments?: Attachment[]; whileBusy?: "queue" | "steer" }): Promise<Message>;
  saveAttachment(input: { chatId: string; name: string; mime: string; dataBase64: string }): Promise<Attachment>;
  pickAttachments(chatId: string): Promise<Attachment[]>;
  openAttachment(path: string): Promise<void>;
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
  usageSummary(days: number): Promise<UsageSummary>;
  copilotUsage(refresh: boolean): Promise<CopilotUsage | null>;

  // harnesses / mcp
  detectHarnesses(): Promise<HarnessStatus[]>;
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

  // settings
  getSettings(): Promise<{ settings: Settings; locked: string[] }>;
  updateSettings(patch: DeepPartial<Settings>): Promise<Settings>;
  resetSettings(): Promise<Settings>;
  exportData(): Promise<string | null>;
  appInfo(): Promise<{ version: string; dataDir: string; platform: string }>;
}

export const API_METHODS: (keyof FlashApi)[] = [
  "listProjects", "pickFolder", "createProject", "removeProject", "listChats", "getMasterChat", "createChat",
  "updateChat", "deleteChat", "listMessages", "sendMessage", "saveAttachment", "pickAttachments", "openAttachment", "toggleReaction", "listAgents", "startAgent",
  "pauseAgent", "resumeAgent", "stopAgent", "stopAll", "getAgentFlow", "listRoles", "listSkills", "openRolesFolder", "agentTemplate", "saveAgentTemplate", "validateAgent", "importAgentText",
  "importAgentFiles", "removeAgent", "exportAgent", "listTasks",
  "createTask", "updateTask", "deleteTask", "runTask", "getArtifact", "usageSummary", "copilotUsage", "detectHarnesses", "marketplaceList", "marketplaceInstall", "marketplaceUninstall", "marketplaceUpdateAll",
  "marketplaceTest", "pluginInstructions", "listModels", "instructionSetup", "allModels",
  "mcpStatus", "mcpReinstall", "jazzQuery", "jazzGet", "jazzSearch", "jazzDetail", "jazzComment", "jazzUpdate", "jazzProjectAreas", "jazzSetPassword", "jazzTest", "getSettings",
  "updateSettings", "resetSettings", "exportData", "appInfo",
];

export interface FlashBridge {
  api: FlashApi;
  onEvent(cb: (e: AppEvent) => void): () => void;
}

export type { HarnessId };
