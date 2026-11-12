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

export interface Chat {
  id: string;
  projectId: string | null; // null = master chat
  title: string;
  kind: "master" | "project";
  agentRole: string;
  harness: HarnessId | null; // null = role/default harness
  model: string | null;
  superpowers: boolean;
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
  reactions: string[];
  replyCount: number;
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
  protocol: "acp" | "headless" | "mock";
  detail: string | null;
}

export interface McpServerStatus {
  id: string;
  label: string;
  kind: "bundled-node" | "bundled-python" | "external";
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
  | { type: "notice"; level: "info" | "warn" | "error"; text: string };
