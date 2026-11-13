// Domain model shared by main process, preload and renderer.

export type HarnessId = "copilot" | "opencode" | "pi" | "duo" | "mock";
export const HARNESS_IDS: HarnessId[] = ["copilot", "opencode", "pi", "duo", "mock"];

export type AgentStatus = "idle" | "running" | "paused" | "stopped" | "error" | "done";
export type TaskStatus = "todo" | "in_progress" | "blocked" | "review" | "done";
export const TASK_STATUSES: TaskStatus[] = ["todo", "in_progress", "blocked", "review", "done"];
export type MessageAuthor = "user" | "agent" | "system";
export type MessageStatus = "streaming" | "done" | "error";

export interface Project {
  id: string;
  name: string;
  path: string;
  createdAt: number;
}

export type DriveMode = "local" | "eco" | "comfort" | "sport";
export const DRIVE_MODES: DriveMode[] = ["local", "eco", "comfort", "sport"];

export interface Attachment {
  id: string;
  name: string;
  mime: string;
  size: number;
  kind: "image" | "file";
  path: string; // absolute path on disk (inside the project's .flashmaster/attachments or the app data folder)
  thumb?: string; // small data: URL preview for images
}

export interface Chat {
  id: string;
  projectId: string | null; // null = master chat
  title: string;
  kind: "master" | "project";
  agentRole: string;
  harness: HarnessId | null; // null = role/default harness
  model: string | null;
  superpowers: boolean;
  mode: DriveMode | null; // LOCAL / ECO / COMFORT / SPORT model profile, null = chat harness/model
  autopilot: boolean; // auto-approve tool calls and tell agents not to stop for feedback
  archived: boolean;
  pinned: boolean;
  createdAt: number;
}

export interface Message {
  id: string;
  chatId: string;
  parentId: string | null; // thread root id when this is a reply
  author: MessageAuthor;
  agentId: string | null;
  role: string | null;
  content: string;
  status: MessageStatus;
  tokensIn: number;
  tokensOut: number;
  estimated: boolean;
  createdAt: number;
  seq: number; // server-assigned order: the UI always sorts by this
  attachments: Attachment[];
  steer: boolean; // sent as a steering message into a running turn
  marker?: "context-reset"; // divider rows (not sent to agents)
  reactions: string[];
  replyCount: number;
}

export type StepStatus = "pending" | "in_progress" | "completed" | "failed";
export interface PlanStep {
  title: string;
  status: StepStatus;
}

export interface AgentEvent {
  id: number;
  agentId: string;
  kind: "turn" | "tool" | "plan" | "delegate" | "approval" | "result" | "error" | "status";
  label: string;
  status: string | null;
  ref: string | null; // e.g. child agent id for delegate
  at: number;
}

export interface AgentFlow {
  agent: AgentRun;
  parent: AgentRun | null;
  children: AgentRun[];
  events: AgentEvent[];
}

export interface AgentRun {
  id: string;
  projectId: string | null;
  chatId: string | null;
  role: string;
  harness: HarnessId;
  model: string | null;
  status: AgentStatus;
  parentAgentId: string | null;
  brief: string;
  resultSummary: string | null;
  tokensIn: number;
  tokensOut: number;
  estimated: boolean;
  startedAt: number;
  endedAt: number | null;
  lastActivity: string | null;
  plan: PlanStep[];
}

export interface Task {
  id: string;
  projectId: string | null;
  title: string;
  description: string;
  status: TaskStatus;
  priority: number; // 1 high .. 4 low
  assigneeRole: string | null;
  agentId: string | null;
  parentId: string | null;
  jazzId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface Artifact {
  id: string;
  agentId: string | null;
  kind: string;
  title: string;
  content: string;
  bytes: number;
  createdAt: number;
}

export interface RoleDef {
  name: string;
  title: string;
  icon: string;
  description: string;
  harness?: HarnessId;
  model?: string;
  tools: string[]; // MCP server ids this role gets
  maxResultTokens: number;
  skills: string[];
  prompt: string;
  source: "builtin" | "user";
}

export interface SkillDef {
  name: string;
  command: string; // slash command, e.g. "brainstorm"
  description: string;
  body: string;
}

export interface HarnessStatus {
  id: HarnessId;
  label: string;
  available: boolean;
  version: string | null;
  path: string | null;
  protocol: "acp" | "rpc" | "headless" | "mock";
  detail: string | null;
}

export interface McpServerStatus {
  id: string;
  label: string;
  kind: "bundled-node" | "bundled-python" | "catalog" | "external";
  state: "ready" | "installing" | "missing" | "error" | "disabled";
  detail: string | null;
}

export interface UsageSummary {
  totals: { tokensIn: number; tokensOut: number; estimatedShare: number; agents: number; running: number };
  byProject: { key: string; label: string; tokens: number }[];
  byRole: { key: string; label: string; tokens: number }[];
  byHarness: { key: string; label: string; tokens: number }[];
  byDay: { key: string; label: string; tokens: number }[];
  budget: { dailyLimit: number; usedToday: number };
}

export interface JazzWorkItem {
  id: string;
  title: string;
  type: string;
  state: string;
  owner: string | null;
  description: string;
  url: string | null;
  projectArea?: string;
  priority?: string;
  severity?: string;
  category?: string; // "Filed against"
  plannedFor?: string;
  creator?: string;
  created?: string;
  modified?: string;
  tags?: string;
}

export interface CopilotUsage {
  ok: boolean;
  fetchedAt: number;
  error: string | null;
  /** Premium requests: used of limit (limit null when unknown or unlimited). */
  premium: { used: number | null; limit: number | null; percent: number | null; unlimited: boolean };
  resetAt: string | null;
  /** Every "label: value" line /usage printed, for the detailed view. */
  entries: { label: string; value: string }[];
  raw: string;
  loading?: boolean;
  /** false when Copilot did not list /usage over ACP and the meter refused to send it (would cost a request). */
  advertised?: boolean;
}

export interface JazzComment {
  author: string;
  date: string;
  text: string;
}

export interface JazzSearch {
  text?: string; // words in summary/description, or ids "123, 456"
  projectAreas?: string[]; // empty = all configured
  state?: "open" | "closed" | "all";
  type?: string; // e.g. Defect, Task, Story
  owner?: "me" | "unassigned" | "";
  raw?: string; // advanced: reportable-API filter, e.g. "priority/name='High'"
  max?: number;
}

// ---- Events pushed main → renderer ----
export type AppEvent =
  | { type: "message.created"; message: Message }
  | { type: "message.delta"; messageId: string; chatId: string; delta: string }
  | { type: "message.updated"; message: Message }
  | { type: "reaction.changed"; messageId: string; chatId: string; reactions: string[] }
  | { type: "agent.updated"; agent: AgentRun }
  | { type: "task.updated"; task: Task }
  | { type: "task.deleted"; taskId: string }
  | { type: "mcp.status"; servers: McpServerStatus[] }
  | { type: "roles.changed"; roles: RoleDef[] }
  | { type: "flow.updated"; agentId: string }
  | { type: "models.updated"; models: HarnessModels }
  | { type: "copilotUsage.updated"; usage: CopilotUsage }
  | { type: "plugins.changed"; installed: InstalledPlugin[] }
  | { type: "notice"; level: "info" | "warn" | "error"; text: string };

export interface AgentImportResult {
  file: string;
  ok: boolean;
  name: string | null;
  errors: string[];
  warnings: string[];
}

export interface ModelInfo {
  id: string;
  name: string;
  description?: string | null;
  current?: boolean; // the harness's own default / currently selected model
}

export interface HarnessModels {
  harness: HarnessId;
  models: ModelInfo[];
  fetchedAt: number | null;
  error: string | null;
  loading: boolean;
}

// ---------------- marketplace ----------------
export type PluginKind = "agent" | "workflow" | "instructions" | "mcp";

/** One entry of a marketplace's index.json. */
export interface PluginEntry {
  id: string;
  name: string;
  version: string;
  description: string;
  team: string;
  kinds: PluginKind[];
  tags: string[];
  package: string; // path relative to the marketplace URL
  sha256?: string;
  updated?: string;
}

/** A plugin package (the JSON file a PluginEntry points to). Content is inline so any static file server can host it. */
export interface PluginPackage {
  id: string;
  name: string;
  version: string;
  description?: string;
  team?: string;
  agents?: { file: string; content: string }[];
  workflows?: { file: string; content: string }[];
  instructions?: string;
  mcpServers?: { id: string; label?: string; command: string; args?: string; env?: string }[];
}

export interface InstalledPlugin {
  id: string;
  name: string;
  version: string;
  team: string;
  sourceId: string;
  sourceName: string;
  installedAt: number;
  agents: string[]; // role names
  workflows: string[]; // skill commands
  hasInstructions: boolean;
  instructionsEnabled: boolean;
  mcpServers: string[];
}

export interface MarketplaceListing {
  sourceId: string;
  sourceName: string;
  department: string;
  url: string;
  description: string;
  plugins: PluginEntry[];
  error: string | null;
  fetchedAt: number | null;
}
