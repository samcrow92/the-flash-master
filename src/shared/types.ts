// Domain model shared by main process, preload and renderer.

export type HarnessId = "copilot" | "opencode" | "cursor" | "claude" | "pi" | "duo" | "mock";
export const HARNESS_IDS: HarnessId[] = ["copilot", "opencode", "cursor", "claude", "pi", "duo", "mock"];

/** interrupted = the app closed while the agent was working; it can be resumed. */
export type AgentStatus = "idle" | "running" | "paused" | "interrupted" | "stopped" | "error" | "done";
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
/** The ECO / COMFORT / SPORT dial for GitLab Duo (Settings → Harnesses → GitLab Duo), shown only when the chat runs on Duo. */
export type DuoMode = "eco" | "comfort" | "sport";
export const DUO_MODES: DuoMode[] = ["eco", "comfort", "sport"];

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
  duoMode?: DuoMode | null; // GitLab Duo ECO / COMFORT / SPORT (model + thinking for Duo agents), null = Duo's usual model
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
  /** Steering / queued messages: sent → delivered to the agent → seen (the model continued with it in context). */
  delivery?: "sent" | "queued" | "delivered" | "seen";
  marker?: "context-reset"; // divider rows (not sent to agents)
  /** Commands / tool calls the agent ran while writing this reply (expandable in the chat). */
  tools?: ToolRun[];
  reactions: string[];
  /** A "needs you" card: an agent (or the app) waits for the user's answer to go on. */
  ask?: AskCard;
  replyCount: number;
  /** Root messages only: its thread is archived (hidden from the Threads panel and inline; restorable). */
  threadArchived?: boolean;
}

/**
 * What a "needs you" card asks. question/blocked come from an agent (ask_user, or a result block with that status);
 * no_report/failed from the app when a specialist kept ending without a report; silent when the coordinator ended
 * its turn twice with nothing for the user. The answer resumes the flow: it goes to the agent that asked.
 */
export type AskKind = "question" | "blocked" | "no_report" | "failed" | "silent";
export interface AskCard {
  kind: AskKind;
  /** The agent the answer goes to (null: the chat's coordinator). */
  agentId: string | null;
  /** How the asking agent shows in the app, e.g. "🧪 Nova · Tester". */
  who: string;
  question: string;
  /** What is waiting on the answer and why. */
  why: string | null;
  /** Quick answers shown as buttons; the user can also type their own. */
  options: string[];
  /** Index of the option the agent recommends. */
  recommended?: number | null;
  answer?: { text: string; at: number } | null;
}

/** A message found by the chat search. `snippet` wraps each match in \u0002…\u0003 (drawn highlighted). */
export interface SearchHit {
  messageId: string;
  chatId: string;
  chatTitle: string;
  projectId: string | null;
  archived: boolean;
  parentId: string | null; // thread root when the match is a thread reply
  author: MessageAuthor;
  role: string | null;
  snippet: string;
  createdAt: number;
}

/** One command or tool call shown under an agent reply: what ran, and what came back. */
export interface ToolRun {
  id: string;
  title: string;
  kind: string; // read | edit | execute | search | fetch | think | other …
  status: "pending" | "in_progress" | "completed" | "failed";
  input?: string; // the command line, or the arguments
  output?: string; // capped; truncated says so
  truncated?: boolean;
  startedAt: number;
  endedAt?: number;
  /** Where in the reply text the call started (characters), so the chat shows it between the paragraphs around it. */
  at?: number;
  /** Set when the call was stopped while it hung (by the user or the tool call timeout): why, shown on the row. */
  stopped?: string;
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
  /** Given name of this instance ("Nova"), so several copies of one specialist can be told apart; null for the coordinator. */
  name: string | null;
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
  /** Isolated git worktree this agent works in (code-writing specialists), and its branch. */
  worktree: string | null;
  branch: string | null;
  /** Copilot credits (or premium requests) this agent used, counted from Copilot's /usage after each turn. */
  credits: number;
  /** Folder the coordinator started this specialist in, instead of the project folder (null = the project folder). */
  folder?: string | null;
  /** Extra command-line arguments the coordinator started this specialist's agent CLI with (null = none). */
  launchArgs?: string | null;
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
  /** Changes code: when delegated in a git project, works in its own worktree and branch (Settings → Agents). */
  isolate?: boolean;
  /**
   * Deliverables the app checks after each finished turn (frontmatter `requires: [html-report, ishikawa]`); a turn that
   * misses one is sent back to the agent to complete. html-report = an .html report file (or HTML artifact);
   * ishikawa = that report contains an Ishikawa (fishbone) diagram.
   */
  requires?: string[];
  /**
   * Must run on a local model (frontmatter `local: true`, or instructions that demand local inference). The app then runs
   * it only on Pi or OpenCode with a local model (the coordinator's, the role's, or Settings → Modes → LOCAL), never on a
   * hosted harness such as GitLab Duo, and stops with a clear error when no local model is set up.
   */
  local?: boolean;
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
  kind: "bundled-node" | "bundled-python" | "catalog" | "external" | "vendor";
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

/** A file an agent created or changed (net change per turn; texts loaded on demand). */
export interface FileChange {
  id: string; chatId: string; agentId: string | null; role: string | null; path: string; createdAt: number;
  added: number; removed: number; isNew: boolean; deleted: boolean;
  oldText?: string; newText?: string;
}
export interface ChatArtifacts {
  changes: FileChange[];
  artifacts: (Omit<Artifact, "content"> & { role: string | null })[];
  project: string | null; // project folder, for git changes
}

/** IBM DOORS Next (Jazz Requirements Management) */
export interface RmProject { id: string; title: string }
export interface RmModule { uri: string; uuid: string; identifier: string; title: string; projectId: string; modified?: string;
  config?: string; component?: string } // configuration (stream) the module was found in, and its component title
export interface Requirement {
  id: string; // DOORS Next identifier (number shown in the UI)
  uri: string;
  title: string;
  text: string; // primary text as plain text
  type: string; // artifact type, e.g. "System Requirement", "Heading"
  heading: boolean;
  section: string; // e.g. "3.2.1" (module context)
  depth: number;
  attrs: Record<string, string>;
  links: { type: string; target: string; title?: string }[];
}
export interface RmModuleData { module: RmModule; fetchedAt: number; requirements: Requirement[]; config: string }
export interface RmHit { id: string; module: string; moduleTitle: string; section: string; type: string; text: string; score: number }

export interface UpdateState {
  status: "idle" | "disabled" | "checking" | "up-to-date" | "available" | "downloading" | "ready" | "error";
  current: string;
  latest?: string;
  notes?: string;
  progress?: number;
  size?: number;
  error?: string;
  needsSignIn?: boolean;
  checkedAt?: number;
  mode: "installer" | "portable" | "dev";
  feed: string;
  /** Where the last check found its manifest: the Flash server (Settings → Flash server) or the repository feed. */
  source?: "server" | "repository";
  /** Why the Flash server was not used (it failed and the repository feed answered instead). */
  serverError?: string;
}

/**
 * This month's Copilot usage. Available credits come from Copilot via its existing sign-in (or the user's setting);
 * the per-model breakdown from Copilot itself (/usage in the app's sessions + Copilot's session log).
 */
export interface CopilotBilling {
  /** What Copilot counts in: credits, or premium requests on older plans. */
  unit: "credits" | "requests";
  period: { year: number; month: number };
  /** Everything Copilot reported for this month. */
  used: number;
  /** Copilot sessions counted, and how many of them were the app's own (live /usage). */
  sessions: number;
  appSessions: number;
  /** Credits per month: from Copilot, else the user's setting; null when neither is known. */
  allowance: number | null;
  /** Same as allowance: the credits available this month in total. */
  availableTotal: number | null;
  /** Credits still available: Copilot's own count, else availableTotal − used. */
  available: number | null;
  availableFrom: "copilot" | "setting" | null;
  /** Usage computed from the available credits: availableTotal − available (`used` without a total). */
  usedOfAvailable: number;
  /** Used beyond the plan (pay as you go), as Copilot counts it. */
  overage: number;
  unlimited: boolean;
  plan: string | null;
  /** Where the sign-in used to ask Copilot came from, e.g. "Copilot's sign-in (system keychain)". */
  signIn: string | null;
  /** usedOfAvailable as % of availableTotal; null when the total is unknown. */
  percent: number | null;
  /** Largest consumer first; `share` is % of `used`. */
  models: { model: string; quantity: number; share: number }[];
}

export interface CopilotUsage {
  ok: boolean;
  /** "cli" = read from Copilot itself (/usage and its session log). */
  source?: "cli";
  billing?: CopilotBilling;
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
/** Agent memory scopes: global user memory, memory shared by a project's agents, short-term memory of one chat. */
export const MEMORY_SCOPES = ["user", "project", "session"] as const;
export type MemoryScope = (typeof MEMORY_SCOPES)[number];
export const MEMORY_KINDS = ["fact", "preference", "decision", "procedure", "episode"] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

export interface Memory {
  id: number;
  scope: MemoryScope;
  /** project scope: the project (null = the master chat's workspace); session scope: the chat's project. */
  projectId: string | null;
  /** session scope only: the chat it belongs to. */
  chatId: string | null;
  kind: MemoryKind;
  content: string;
  tags: string[];
  /** 1 (trivia) … 5 (critical). */
  importance: number;
  /** Always shown to agents, whatever they work on. */
  pinned: boolean;
  sourceAgentId: string | null;
  sourceRole: string | null;
  createdAt: number;
  updatedAt: number;
  lastAccessedAt: number;
  accessCount: number;
  /** Short-term memories expire unless promoted; null = long-term. */
  expiresAt: number | null;
  /** Project knowledge base entry: its slug (file `.flashmaster/knowledge/<slug>.md` in the project's repo); null = a plain memory. */
  kbSlug?: string | null;
}

/** Why an entry of the project knowledge base could not be synced between the repo folder and the app's database. */
export interface KnowledgeConflict {
  slug: string;
  /** both-changed: you and the repo (a teammate, a pull) changed it since the last sync; merge-markers: an unresolved git merge in the file; invalid: the file can't be read as an entry. */
  reason: "both-changed" | "merge-markers" | "invalid";
  detail?: string;
}

export interface KnowledgeSyncResult {
  projectId: string;
  at: number;
  /** Repo → app (teammates' changes, a pull). */
  imported: string[];
  /** App → repo (agents' or your edits). */
  exported: string[];
  deletedLocal: string[];
  deletedRepo: string[];
  conflicts: KnowledgeConflict[];
  entries: number;
}

export interface KnowledgeStatus {
  projectId: string;
  /** Absolute path of the knowledge folder in the project. */
  folder: string;
  entries: number;
  /** The commit the knowledge base was last built or updated from (manifest.json in the folder). */
  checkpoint: { commit: string; at: string | null } | null;
  head: string | null;
  /** Commits since the checkpoint (null: no checkpoint, not a git repo, or the checkpoint commit is not in this clone). */
  behind: number | null;
  /** Files changed since the checkpoint (outside .flashmaster), what an incremental update looks at. */
  changedFiles: string[];
  repo: boolean;
  /** Knowledge files not committed yet (git status). */
  uncommitted: number;
  conflicts: KnowledgeConflict[];
  lastSync: KnowledgeSyncResult | null;
}

/** The project's code graph, built on demand by graphify (https://github.com/Graphify-Labs/graphify) and summarised into the knowledge base. */
export interface CodeGraphStatus {
  projectId: string;
  /** graphify is installed in the app's own Python environment. */
  installed: boolean;
  /** What a scan running now is doing ("Installing graphify…", "Scanning the code…"); null when idle. */
  running: string | null;
  /** How far the running scan is, 0…1 (graphify's own file counts); null while the step can't be measured (installing). */
  progress: number | null;
  /** The last graph built for this project (local: `.flashmaster/graphify`, not committed). */
  graph: { nodes: number; edges: number; communities: number; commit: string | null; at: number; version: string | null } | null;
  /** The error of the last scan, if it failed. */
  error: string | null;
  /** Absolute path of graph.html (the interactive view), when there is one. */
  html: string | null;
}

export interface MemoryHit extends Memory {
  /** Final rank: relevance blended with recency and importance (0…~1). */
  score: number;
  /** Fused lexical + fuzzy relevance to the query (0…1). */
  relevance: number;
}

export type AppEvent =
  | { type: "message.created"; message: Message }
  | { type: "message.delta"; messageId: string; chatId: string; delta: string }
  | { type: "message.tools"; messageId: string; chatId: string; tools: ToolRun[] }
  | { type: "message.updated"; message: Message }
  /** Edit & resend / retry removed these messages (with the threads under them); parentId = their thread root. */
  | { type: "messages.removed"; chatId: string; removed: { id: string; parentId: string | null }[] }
  | { type: "reaction.changed"; messageId: string; chatId: string; reactions: string[] }
  | { type: "agent.updated"; agent: AgentRun }
  | { type: "task.updated"; task: Task }
  | { type: "task.deleted"; taskId: string }
  | { type: "mcp.status"; servers: McpServerStatus[] }
  | { type: "roles.changed"; roles: RoleDef[] }
  | { type: "flow.updated"; agentId: string }
  | { type: "models.updated"; models: HarnessModels }
  | { type: "copilotUsage.updated"; usage: CopilotUsage }
  | { type: "artifacts.changed"; chatId: string }
  | { type: "memory.changed" }
  | { type: "codegraph.changed"; status: CodeGraphStatus }
  | { type: "update.state"; state: UpdateState }
  | { type: "plugins.changed"; installed: InstalledPlugin[] }
  | { type: "window.state"; state: WindowState }
  | { type: "terminal.data"; id: string; data: string }
  | { type: "terminal.exit"; id: string; code: number }
  | { type: "notice"; level: "info" | "warn" | "error"; text: string };

/** The app window, for the custom (frameless) title bar. `material` is the native blur behind the window, if any. */
export interface WindowState {
  maximized: boolean;
  focused: boolean;
  fullscreen: boolean;
  platform: string;
  material: "acrylic" | "vibrancy" | "none";
}

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
export type PluginKind = "agent" | "workflow" | "skill" | "script" | "instructions" | "mcp" | "exam";

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
  author?: string;
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
  /** Skills, installed like workflows (command = header `command:` or the file name without .md). */
  skills?: { file: string; content: string }[];
  /** Helper scripts, written to <dataDir>/plugins/<id>/scripts/<file>; agents are told where they are. */
  scripts?: { file: string; content: string }[];
  tags?: string[];
  instructions?: string;
  mcpServers?: { id: string; label?: string; command: string; args?: string; env?: string }[];
  /** Team EXAM setup: fills empty Settings → EXAM fields and triggers the automatic setup. */
  exam?: ExamPreset;
}

/** EXAM settings a department can publish. A relative pluginPackage is resolved against the marketplace URL. */
export interface ExamPreset {
  pluginPackage?: string; targetEndpoint?: string; licenseHost?: string; licensePort?: number; restPort?: number;
  modelName?: string; modelConfigUuid?: string; systemConfig?: string; reportProject?: string; pythonPath?: string;
}
export const EXAM_PRESET_KEYS = ["pluginPackage", "targetEndpoint", "licenseHost", "licensePort", "restPort", "modelName",
  "modelConfigUuid", "systemConfig", "reportProject", "pythonPath"] as const;

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
  skills: string[]; // skill commands (from the package's skills array)
  scripts: string[]; // script file names under plugins/<id>/scripts
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

// ---------------- Flash server (flash-server/API.md) ----------------
export type SubmissionStatus = "pending" | "approved" | "rejected" | "changes_requested" | "withdrawn";
export interface Submission {
  id: number;
  pluginId: string;
  version: string;
  name: string;
  kinds: PluginKind[];
  status: SubmissionStatus;
  notes: string;
  feedback: string | null;
  author: string;
  createdAt: string;
  reviewedAt: string | null;
  reviewer: string | null;
}
export interface ServerTestResult {
  ok: boolean;
  detail: string;
  url: string;
  serverName?: string;
  serverVersion?: string;
  user?: { id: number; name: string; role: "user" | "admin" };
}
export type SubmitFileKind = "agent" | "workflow" | "skill" | "script" | "instructions";
export interface SubmitMeta { id: string; name: string; version: string; description: string; team: string; tags: string[] }
export type SubmitSource = { kind: "folder"; path: string } | { kind: "files"; files: { path: string; name: string; kind: SubmitFileKind }[] };
/** What the Submit dialog shows after picking a folder or files (fields prefilled from plugin.json / the files). */
export interface SubmitDraft { source: SubmitSource; meta: SubmitMeta; items: string[]; problems: string[] }
export interface SubmitResult { ok: boolean; errors: string[]; kinds: PluginKind[]; items: string[]; submission?: Submission }
