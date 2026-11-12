import type {
  AgentRun, AppEvent, Artifact, Chat, HarnessId, HarnessStatus, JazzWorkItem, McpServerStatus, Message,
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
  updateChat(id: string, patch: Partial<Pick<Chat, "title" | "agentRole" | "harness" | "model" | "superpowers">>): Promise<Chat>;
  deleteChat(id: string): Promise<void>;

  // messages
  listMessages(chatId: string, parentId: string | null): Promise<Message[]>;
  sendMessage(input: { chatId: string; content: string; parentId?: string | null }): Promise<Message>;
  toggleReaction(messageId: string, emoji: string): Promise<string[]>;

  // agents
  listAgents(filter?: { projectId?: string | null; activeOnly?: boolean }): Promise<AgentRun[]>;
  startAgent(input: { projectId: string | null; role: string; brief: string }): Promise<AgentRun>;
  pauseAgent(id: string): Promise<void>;
  resumeAgent(id: string): Promise<void>;
  stopAgent(id: string): Promise<void>;
  stopAll(): Promise<void>;
  listRoles(): Promise<RoleDef[]>;
  listSkills(): Promise<SkillDef[]>;
  openRolesFolder(): Promise<void>;

  // tasks
  listTasks(filter?: { projectId?: string | null; status?: TaskStatus }): Promise<Task[]>;
  createTask(input: Partial<Task> & { title: string }): Promise<Task>;
  updateTask(id: string, patch: Partial<Task>): Promise<Task>;
  deleteTask(id: string): Promise<void>;
  runTask(id: string, role?: string): Promise<AgentRun>;

  // artifacts / usage
  getArtifact(id: string): Promise<Artifact | null>;
  usageSummary(days: number): Promise<UsageSummary>;

  // harnesses / mcp
  detectHarnesses(): Promise<HarnessStatus[]>;
  mcpStatus(): Promise<McpServerStatus[]>;
  mcpReinstall(): Promise<McpServerStatus[]>;

  // jazz
  jazzQuery(query: string): Promise<JazzWorkItem[]>;
  jazzGet(id: string): Promise<JazzWorkItem>;
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
  "updateChat", "deleteChat", "listMessages", "sendMessage", "toggleReaction", "listAgents", "startAgent",
  "pauseAgent", "resumeAgent", "stopAgent", "stopAll", "listRoles", "listSkills", "openRolesFolder", "listTasks",
  "createTask", "updateTask", "deleteTask", "runTask", "getArtifact", "usageSummary", "detectHarnesses",
  "mcpStatus", "mcpReinstall", "jazzQuery", "jazzGet", "jazzSetPassword", "jazzTest", "getSettings",
  "updateSettings", "resetSettings", "exportData", "appInfo",
];

export interface FlashBridge {
  api: FlashApi;
  onEvent(cb: (e: AppEvent) => void): () => void;
}

export type { HarnessId };
