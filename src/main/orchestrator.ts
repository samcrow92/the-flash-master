/**
 * Orchestrator — runs every agent turn in the app.
 *
 * Everything is a chat turn: a user message in a chat (or thread) goes to the chat's role, or to the role
 * named with @mention. Delegated specialists run as thread replies under the delegating message, so the
 * user sees them without the coordinator's context ever containing their transcript.
 */
import { mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { isAbsolute, join, relative, resolve as resolvePath } from "node:path";
import type { AgentChecks, AgentRun, AgentState, AppEvent, AskCard, Attachment, Chat, HarnessId, Message, RoleDef, SkillDef, Task, TaskPlan, ToolRun } from "@shared/types";
import { HARNESS_IDS } from "@shared/types";
import { cliProxyUrl } from "./proxy";
import { jazzToolsOn, type DuoModeProfile, type Settings } from "@shared/settings";
import { diffLines } from "@shared/diff";
import { paragraphBreak } from "@shared/replySegments";
import { agentLabel, pickInstanceName } from "@shared/instances";
import { planEdit, planRetry, type RewindPlan } from "@shared/rewind";
import { BUILTIN_COMMAND_NAMES } from "@shared/inline-commands";
import type { Db } from "./db";
import type { MemoryStore } from "./memory";
import { describeSync, type KnowledgeBase } from "./knowledge";
import type { HarnessRegistry } from "./harness/registry";
import type { HarnessSession, McpServerSpec, PermissionRequest } from "./harness/types";
import { canIsolate, createWorktree, defaultGit, projectWorktreeDir, mergeWorktree, removeWorktree, worktreeChanges, worktreeFileDiff, worktreeState, type Git, type WorkResult } from "./worktree";
import { buildFixRequest, type ReviewComment } from "@shared/review";
import { prepareInstructions } from "./harness/instructions";
import { checkReports, reportFixPrompt } from "./report-check";
import { checksFixPrompt, checksForParent, checksLine, loadChecks, runChecks, type CheckRun, type CheckRunner, type ChecksConfig } from "./checks";
import { HookRunnerHost, parseHooks } from "./hooks";
import { parseRules } from "./harness/rules";
import { newTraceId, type TraceStore } from "./traces";
import { attemptsReport, rankAttempts, routeByDifficulty, ROUTE_MODES, type Attempt, type RouteMode } from "./routing";
import { dependencyContext, normaliseTasks, planOutline, planReport, readyTasks, resultOk, skipBlocked, validatePlan } from "./plan";
import { mergeState, renderState, STATE_RULES } from "./agent-state";
import { duoGitlabHosts, gitlabRepoProblem } from "./harness/duo";
import { isLocalHarness, localRuntimeNote, needsLocalInference, pickLocalRuntime, type LocalPick } from "./locality";
import { loadAgentSkills, PROJECT_SKILL_DIRS, skillsIndex, slugRole, type AgentSpec } from "./roles";
import {
  budgetState, HTML_REPORT_RULES, buildBrief, buildTurnPrompt, estimateTokens, extractiveSummary, parseMention, parseSlash, planCompaction,
  parseResult, type ResultStatus, parseTextAgents, parseTextDelegations, parseTextToolCalls, stripTextToolCalls, resultForParent, textToolRules, type ToolInfo, TEXT_DELEGATION_RULES, type TextDelegation,
  unslopRules, isSilentReply, NEEDS_YOU_RULES, SPECIALIST_ASK_RULES, STATUS_LINE_RULES, DUO_REPORTING_RULES, DUO_SPECIALIST_RULES, DUO_ORCHESTRATOR_RULES, COORDINATOR_FEEDBACK_RULES,
} from "./context";

/** Outcome of closing one agent through the close_agent / close_idle_agents tools. */
export interface CloseResult {
  agentId: string;
  name: string;
  closed: boolean;
  /** Why it was kept. */
  reason?: string;
  /** What happened to its worktree, when it had one. */
  worktree?: string;
}

export interface OrchestratorDeps {
  /** Git runner for agent worktrees (tests inject a fake). */
  git?: Git;
  /** Runs check commands (tests inject a fake). */
  checkRunner?: CheckRunner;
  /** Local traces (Timeline page, OTLP export); unset = no tracing. */
  traces?: TraceStore;
  /** Runs the user's hooks (tests inject one with a fake runner); default: Settings → Permissions → Hooks. */
  hooks?: HookRunnerHost;
  /** Folder agents work in when their chat has no project (Settings → Agents; C:\\Data\\.wt by default on Windows). Unset: the home folder. */
  noProjectDir?: () => string;
  /** Extra environment per harness (e.g. GH_TOKEN for Copilot when signed in with a token). */
  harnessEnv?: (harness: HarnessId) => Record<string, string>;
  /** Extra environment per role (e.g. FLASH_EXAM_CLI for agents that call bundled tools from a shell). */
  roleEnv?: (role: RoleDef) => Record<string, string>;
  /** Save a role an agent defined at run time (create_agent / AGENT block). keep=false: until the app restarts. */
  createRole?: (spec: AgentSpec, createdBy: string, keep: boolean) => RoleDef;
  listTools?: (set: string) => ToolInfo[];
  callTool?: (name: string, args: unknown, agentId: string, set?: string) => Promise<unknown>;
  /** Did this agent's MCP server reach the app (tools/list)? */
  toolsLoaded?: (agentId: string) => boolean;
  onModels?: (harness: HarnessId, models: import("@shared/types").ModelInfo[]) => void;
  /** Copilot's silent /usage after each turn (text null when Copilot does not offer /usage to apps). */
  onCopilotUsage?: (r: { sessionId: string; text: string | null; commands: string[]; agentId: string }) => void;
  log?: (level: "error" | "warn" | "info" | "debug", msg: string) => void;
  db: Db;
  /** Agent memory: relevant memories are put in front of agents, and specialists' results become short-term memories. */
  memory?: MemoryStore;
  /** Project knowledge base (/kb builds or updates it, /kb-sync syncs it with the repo folder). */
  knowledge?: KnowledgeBase;
  harnesses: HarnessRegistry;
  settings: () => Settings;
  roles: () => RoleDef[];
  skills: () => SkillDef[];
  emit: (e: AppEvent) => void;
  /** MCP servers for a role's session (flashmaster-core is always included). */
  mcpServersFor: (role: RoleDef, agentId: string) => McpServerSpec[];
  homeDir: string;
  dataDir?: string;
  extraRules?: () => string; // e.g. instructions from installed marketplace plugins
  attachmentRoots?: () => string[]; // folders agents may read attachments from (outside the project)
}

interface Live {
  key: string;
  agentId: string;
  /** Given name of a delegated specialist instance ("Nova"); null for the coordinator and directly-opened chats. */
  name?: string | null;
  chatId: string;
  threadRoot: string | null;
  role: RoleDef;
  harness: HarnessId;
  model: string | null; // forced model (economy routing); null = chat/role/harness default
  /** Set for a local-only agent (role or delegation): which local model it was given, for its first-turn runtime note. */
  local?: { source: LocalPick["source"] } | null;
  session: HarnessSession | null;
  sessionTokens: number; // estimated tokens accumulated in the harness session (drives rollover compaction)
  busy: boolean;
  paused: boolean;
  /** fromAgent: a message from the delegating agent (message_agent): the turn it starts reports back to that agent. */
  queue: { input: string; attachments: Attachment[]; msgIds?: string[]; fromAgent?: string }[];
  /** Delivered steering/queued messages waiting to be seen: native = wait for the harness ack, else first model output. */
  awaiting: { id: string; native: boolean }[];
  /** Memory ids already shown to this harness session (reminders on later turns only add new ones). */
  memoryShown?: Set<number>;
  /** Steering by interrupt: next turn input. `toolStop` = the title of a hung tool call that was stopped (input says so as is). */
  redirect: { input: string; attachments: Attachment[]; msgIds: string[]; toolStop?: string; nudge?: boolean; fromAgent?: string } | null;
  turnChanges?: Map<string, { id: string; oldText: string | null }>; // files changed in the current turn
  warnedTools?: boolean;
  /** The coordinator's `delegate` tool didn't load: it delegates by writing DELEGATE lines, which the app carries out. */
  textDelegation?: boolean;
  lastReplyId?: string | null;
  lastText?: string;
  /** Commands / tool calls of the current reply, in order (shown expandable under it). */
  tools?: Map<string, import("@shared/types").ToolRun>;
  toolsTimer?: ReturnType<typeof setTimeout> | null;
  /** TheFlashMaster's tools weren't confirmed loaded (Pi, MCP blocked…): the agent may call them as TOOL lines. */
  textTools?: boolean;
  depth: number;
  /** Isolated git worktree the agent works in (null = the project folder); undefined = not decided yet. */
  worktree?: string | null;
  branch?: string | null;
  /** Folder the coordinator started this specialist in instead of the project folder (delegate `folder`). */
  folder?: string | null;
  /** Extra launch arguments the coordinator started this specialist's agent CLI with (delegate `args`). */
  launchArgs?: string | null;
  /** Last time the harness sent anything (text, tool update, plan…) during a turn; drives the stuck-agent watchdog. */
  lastOutputAt?: number;
  /** The watchdog already warned about this silence (cleared when output resumes). */
  stuckSince?: number | null;
  /** Last heartbeat from the harness (a headless CLI like Duo whose process is alive and working): busy, not stale. */
  heartbeatAt?: number;
  /** When the current turn started (agent_status). */
  turnStartedAt?: number;
  /** The quiet-but-alive minutes last shown in the agent's status line (so it changes once a minute, not every check). */
  quietShown?: number;
  /** Recent progress lines (Duo's log, STATUS lines), newest last, for agent_status. */
  recent?: string[];
  /**
   * The chat's coordinator runs on GitLab Duo (Settings → Harnesses → GitLab Duo, or Duo picked for the chat): the harness
   * it falls back to when the project isn't a GitLab repo, and whether Duo was picked for this chat (then it isn't replaced).
   */
  duoCoordinator?: { fallback: HarnessId; explicit: boolean } | null;
  /** Duo was started ahead of the first message (prepareChat): the session is open, but the first turn's brief isn't sent yet. */
  prestarted?: boolean;
  /** prepareChat is starting the session: a turn waits for it instead of starting a second one. */
  starting?: Promise<unknown> | null;
  /** The agent's last STATUS line (text protocol: `STATUS: <what I'm doing>`), with when it came. */
  statusNote?: { text: string; at: number } | null;
  /** Streamed text of the current turn not yet ended by a newline (STATUS lines are read per line). */
  lineBuf?: string;
  /** The end of the current turn's text, for agent_status. */
  tail?: string;
  /** Last time a progress line updated the status line (throttled). */
  activityShownAt?: number;
  /** Waiting for the user to answer a permission request: silence is expected. */
  awaitingApproval?: boolean;
  /** When the agent last finished a turn (drives closing idle specialists); null while it works. */
  idleSince?: number | null;
  /** closeIdle is checking this agent's worktree right now. */
  closing?: boolean;
  currentMessageId: string | null;
  waiters: ((result: string) => void)[];
  /** The agent that delegated to this specialist (null for the coordinator and directly-opened chats). */
  parentAgentId?: string | null;
  /** A delegated task is running: when it ends, its result goes back to the delegating agent (woken if it isn't waiting). */
  delegated?: boolean;
  /** The delegating agent fetched this result itself with get_result, so it needs no wake-up for it. */
  resultTaken?: boolean;
  /** Text-mode delegations of this coordinator still being awaited by the app (results go back in one message). */
  textWaiting?: number;
  lastResult: string | null;
  /** The delegated task (goal and brief), so a specialist that didn't deliver can be restarted on it. */
  task?: { goal: string; brief: string | null; taskId?: string } | null;
  /** When its current delegated task started (wall-clock limit, Settings → Agents → Time limit per task). */
  taskStartedAt?: number;
  /** When it was told to wrap up for hitting the time limit (it is stopped if still working after the grace period). */
  timeLimitedAt?: number;
  /** Coordinator: when the user's current request started and its own token count then (task budget across its tree). */
  requestStart?: { at: number; base: number };
  /** The task-budget warning was shown for the current request. */
  budgetWarned?: boolean;
  /** Working on a task of a plan: its result goes to the plan runner, not to its delegating agent as a report. */
  inPlan?: boolean;
  /** Tracing: the trace of the request it works for, and its open spans (request, delegated task, current turn, tool calls). */
  traceId?: string;
  requestSpan?: string;
  delegateSpan?: string;
  turnSpan?: string;
  toolSpans?: Map<string, string>;
  /** Recovery attempts for the current delegated task (reminder, restart…), capped by agents.recoveryAttempts. */
  recoveries?: number;
  /** The agent raised a "needs you" card in this turn (ask_user): it's waiting for the user, not silent. */
  askedThisTurn?: boolean;
  /** A delegated specialist's ask_user question this turn: it goes to its delegating agent with the result, not to the user. */
  pendingQuestion?: string | null;
  /** The coordinator was already reminded once to tell the user something; a second silent turn raises a card. */
  coordNudged?: boolean;
  /** The stall watchdog gave up on this turn (it's ended as failed, not as stopped by the user). */
  stallGiveUp?: string | null;
  stopped: boolean;
  /** Where streamed text goes for the *current* turn. Sessions outlive turns, so this is swapped per turn. */
  sink: ((delta: string) => void) | null;
  /** Text resumes after a tool call or a thought: start a new paragraph. */
  textBreak?: boolean;
  /** The reasoning block being streamed (a "think" run on the reply), until text or a tool call ends it. */
  thought?: { key: string; text: string } | null;
  thoughts?: number;
  /** The model took a steering message mid-turn: what it writes next goes in a new reply below that message. */
  splitPending?: boolean;
  /** Close the current reply and continue the turn in a new one (set per turn, like `sink`). */
  rollover?: (() => void) | null;
}

const MAX_CONCURRENT_FALLBACK = 4;
/** Times a turn that missed a required deliverable (HTML report, diagrams) is sent back before the app gives up and warns. */
const MAX_REPORT_FIXES = 2;
const TIME_LIMIT_GRACE_MS = 3 * 60_000;
const TIME_LIMIT_NUDGE = (mins: number) => `You have reached the ${mins}-minute time limit for this task. Stop starting new work now: commit what you have (if you changed code), `
  + "then finish with your result block: what is done, what is left, and the next step. Use status failed if the goal isn't met.";
/** Results of specialists that finish within this window wake their coordinator once, together. */
const REPORT_DEBOUNCE_MS = 1500;
/** lastActivity of a specialist the app closed for being idle (a follow-up with its agentId brings it back). */
const IDLE_CLOSED = "Closed after";
const MAX_TEXT_ROUNDS = 12;
/** Quick answers of the app's own cards. */
export const ASK_RESTART = "Restart it";
export const ASK_SKIP = "Continue without it";
export const ASK_RETRY = "Try again";
const DELIVER_NUDGE = "You ended your turn without delivering a result, so the agent that delegated to you has nothing to work with. "
  + "Deliver it now: what you did or found, ending with the result block. If you couldn't finish, say why with status blocked or failed; "
  + "if you need the user, use status needs_decision with a question and options.";
const RESTART_NOTE = (why: string) => `TheFlashMaster restarted you because the previous attempt at this task ${why}. `
  + "Do the task below and end with the result block. If something keeps failing, stop and report it (status blocked or failed) instead of retrying it.";
const SUMMARY_PROMPT = "Summarise the conversation below for an AI agent that continues it with no other memory of it. Keep: what the user wants, "
  + "decisions and their reasons, facts found (file names, values, error messages), what is done, what is still open. Bullet points, at most 300 words. "
  + "Reply with the summary only.";
const UNTANGLE_NOTE = (name: string, agentId: string) => `(${name} needs an answer before it can go on. Handle it yourself if you can: decide from the brief, `
  + `the project and memory, give it the missing context, or narrow the task, and send that as a follow-up (delegate with agentId ${agentId}, or in text mode DELEGATE <role> agent "${agentId}": …); or `
  + "give the work to another specialist. Ask the user (ask_user) only for missing access or credentials, a choice that changes what they asked for, or an irreversible step.)";
const STALL_NUDGE = (mins: number) => `You have sent nothing for ${mins} min. If something is hanging, stop it. Deliver your result now `
  + "with what you have (the result block); if you're blocked, say what blocks you with status blocked.";
const COORD_NUDGE = "Your turn ended without a reply to the user, so they don't know where things stand. Reply now: "
  + "a bold outcome line and a few bullets (what was done, what is still running, what you're waiting for). If you need the user, ask them "
  + "(ask_user, or a result with status needs_decision, a question and options).";
/** A heartbeat this recent means the agent's process is alive and working (headless CLIs beat every 15 s). */
const ALIVE_WINDOW_MS = 90_000;
const RECENT_LINES = 10;
/** `STATUS: …` lines an agent prints while it works: the text protocol for telling its delegating agent where it is. */
const STATUS_LINE_RE = /^\s*(?:[-*]\s+)?(?:\*\*)?STATUS(?:\*\*)?:(?:\*\*)?\s+(.{2,300})$/;
const AGENT_MESSAGE = (from: string, text: string) => `${from}, the agent that delegated to you, sends you this message:\n${text}\n\n`
  + "Take it into account and continue your task. If it asks for your status, start your reply with a line `STATUS: <where you are>`.";
const MAX_TOOLS_PER_REPLY = 200;
const MAX_TOOL_OUTPUT = 20000;

/** Keep the start and the end of a long output (errors are usually at the end). */
export function capOutput(text: string, max = MAX_TOOL_OUTPUT): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  const head = Math.floor(max * 0.3);
  return { text: `${text.slice(0, head)}\n… (${(text.length - max).toLocaleString("en")} characters omitted) …\n${text.slice(text.length - (max - head))}`, truncated: true };
}

/** The coordinator's reply says it has no `delegate` tool ("delegate tool didn't load", "isn't available"…). */
export function saysNoDelegate(text: string): boolean {
  return /\bdelegate`?\s*(?:tool)?[^.\n]{0,80}?\b(?:didn'?t load|did not load|not (?:be )?(?:available|exposed|loaded|present)|unavailable|isn'?t (?:available|exposed)|aren'?t (?:available|exposed)|missing)/i.test(text)
    || /\b(?:no|without(?: a| the)?|lack(?:s|ing)?(?: a| the)?)\s+`?delegate`?\s+tool/i.test(text);
}

/** Copilot CLI logs "N MCP servers were blocked by policy" when the organisation's MCP policy is off. */
function copilotMcpBlocked(homeDir: string): boolean {
  try {
    const dir = join(homeDir, ".copilot", "logs");
    const newest = readdirSync(dir).filter((f) => f.endsWith(".log")).map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs })).sort((a, b) => b.t - a.t).slice(0, 3);
    return newest.some(({ f }) => {
      const buf = readFileSync(join(dir, f), "utf8");
      return /MCP servers? (?:were |was )?blocked by policy|Non-default MCP servers will be blocked|is_mcp_enabled"?\s*:\s*false/i.test(buf.slice(-400000));
    });
  } catch { return false; }
}

const SAID_LABEL: Record<Exclude<ResultStatus, "done">, string> = { needs_decision: "Needs your decision", blocked: "Blocked", failed: "Reported a failure" };

export class Orchestrator {
  private live = new Map<string, Live>();
  private byAgent = new Map<string, Live>();
  private pendingPermissions = new Map<string, (allow: boolean) => void>();
  /** Full text of replies that are still streaming (the DB copy is only flushed every 500 ms). */
  private liveText = new Map<string, string>();
  private running = 0;
  /** Makes each delegation's live key unique: every delegate call is a new specialist instance. */
  private instanceSeq = 0;
  private slotWaiters: (() => void)[] = [];
  /** Delegations waiting for one of their coordinator's specialists to finish (maxParallelSpecialists), per coordinator. */
  private teamWaiters = new Map<string, (() => void)[]>();
  /** Team slots taken by delegations that passed the cap but whose specialist hasn't started its turn yet, per coordinator. */
  private teamReserved = new Map<string, number>();
  /** Finished background specialists whose results still have to reach their coordinator, per coordinator. */
  /** Plans being run (the same objects the runner mutates, so a cancel is seen at once). */
  private runningPlans = new Map<string, TaskPlan>();
  private reports = new Map<string, { live: Live; result: string; timer: ReturnType<typeof setTimeout> | null; items: { l: Live; result: string }[] }>();

  constructor(private d: OrchestratorDeps) {}

  // ------------------------------------------------------------------ public API

  /** Handle a user message. Returns the stored user message; the agent reply streams via events. */
  async sendUserMessage(chatId: string, content: string, parentId: string | null,
    o: { attachments?: Attachment[]; whileBusy?: "queue" | "steer" } = {}): Promise<Message> {
    const chat = this.mustChat(chatId);
    const threadRoot = parentId ? (this.d.db.getMessage(parentId)?.parentId ?? parentId) : null;
    const attachments = o.attachments ?? [];
    // Steering: a message sent while the chat's agent is working goes into the running turn.
    const busyLive = [...this.live.values()].find((l) => l.chatId === chatId && l.threadRoot === threadRoot && l.busy);
    const mentioned = parseMention(content, this.d.roles().map((r) => r.name)).role;
    const command = this.slash(content, chat).command;
    const steer = !!busyLive && (o.whileBusy ?? this.d.settings().chat.defaultSendWhileBusy) === "steer" && !command
      && (!mentioned || mentioned === busyLive.role.name);
    const queued = !!busyLive && !steer && !command && (!mentioned || mentioned === busyLive.role.name);
    const userMsg = this.d.db.addMessage({ chatId, parentId: threadRoot, author: "user", content, attachments, steer,
      delivery: steer ? "sent" : queued ? "queued" : undefined });
    this.d.emit({ type: "message.created", message: userMsg });
    if (steer && busyLive) { await this.steer(busyLive, content, attachments, userMsg.id); return userMsg; }
    await this.dispatch(chat, threadRoot, userMsg, content, attachments);
    return userMsg;
  }

  /**
   * A chat was opened or its harness changed. When its coordinator runs on GitLab Duo (project chats only), Duo starts
   * now in the project folder, so the chat is ready before the first message and a non-GitLab folder shows up at once.
   */
  async prepareChat(chatId: string): Promise<{ harness: HarnessId | null; folder: string | null; ready: boolean; error?: string }> {
    const none = { harness: null, folder: null, ready: false };
    const chat = this.d.db.getChat(chatId);
    const s = this.d.settings();
    if (!chat?.projectId || chat.archived || (!s.duo.coordinator && chat.harness !== "duo")) return none;
    const project = this.d.db.getProject(chat.projectId);
    const role = this.d.roles().find((r) => r.name === chat.agentRole);
    if (!project || !role) return none;
    const live = this.ensureLive(chat, null, role, 0);
    if (!live.duoCoordinator || live.harness !== "duo") return { ...none, harness: live.harness };
    if (live.busy || live.session?.alive) return { harness: live.harness, folder: project.path, ready: !!live.session?.alive };
    if (live.starting) { await live.starting.catch(() => undefined); return { harness: live.harness, folder: project.path, ready: !!live.session?.alive }; }
    const start = (async () => {
      await this.duoCoordinatorFallback(live, project.path, chat);
      if (live.harness !== "duo") return;
      live.session = await this.openSession(live, project.path, chat);
      live.prestarted = true;
      this.setStatus(live, "idle", `GitLab Duo ready in ${project.path}`);
    })();
    live.starting = start;
    try {
      await start;
      return { harness: live.harness, folder: project.path, ready: !!live.session?.alive };
    } catch (e) {
      const error = String((e as Error)?.message ?? e);
      this.setStatus(live, "error", error.slice(0, 200));
      this.system(chat.id, null, `⚠️ GitLab Duo didn't start in ${project.path}: ${error}`, "warn");
      return { harness: live.harness, folder: project.path, ready: false, error };
    } finally { live.starting = null; }
  }

  /**
   * Edit & resend: your last message in its chat or thread gets the new text, the replies after it are removed and
   * the agents of that conversation start a fresh session (theirs still holds the old exchange), then it runs again.
   */
  async editAndResend(messageId: string, content: string): Promise<Message> {
    if (!content.trim()) throw new Error("The message is empty.");
    const { chat, scope, plan } = this.rewindPlan(messageId, planEdit);
    this.rewind(chat, scope, plan.user, plan.remove);
    const edited = this.d.db.editMessage(plan.user.id, content);
    this.d.emit({ type: "message.updated", message: edited });
    await this.dispatch(chat, scope, edited, content, edited.attachments);
    return edited;
  }

  /** Retry: remove the latest reply (and the rest of its turn) and send the message behind it again, optionally elsewhere. */
  async retryReply(messageId: string, pick?: { harness: HarnessId; model: string | null }): Promise<void> {
    const { chat, scope, plan } = this.rewindPlan(messageId, planRetry);
    this.rewind(chat, scope, plan.user, plan.remove);
    await this.dispatch(chat, scope, plan.user, plan.user.content, plan.user.attachments, pick);
  }

  private rewindPlan(messageId: string, planner: typeof planEdit): { chat: Chat; scope: string | null; plan: Extract<RewindPlan, { ok: true }> } {
    const m = this.d.db.getMessage(messageId);
    if (!m) throw new Error("That message no longer exists.");
    const chat = this.mustChat(m.chatId);
    const scope = m.parentId;
    const plan = planner(this.d.db.history(chat.id, scope), messageId);
    if (!plan.ok) throw new Error(plan.reason);
    return { chat, scope, plan };
  }

  /** Remove `remove` (and threads under it) and close the conversation's idle agent sessions so the rerun starts clean. */
  private rewind(chat: Chat, scope: string | null, user: Message, remove: Message[]): void {
    const roots = new Set(remove.map((x) => x.id));
    const lives = [...this.live.values()].filter((l) => l.chatId === chat.id && (l.threadRoot === scope || (l.threadRoot && roots.has(l.threadRoot))));
    if (lives.some((l) => l.busy)) throw new Error("An agent is still working here — stop it first, then edit or retry.");
    for (const l of lives) {
      l.session?.close();
      this.live.delete(l.key);
      this.byAgent.delete(l.agentId);
      this.emitAgent(this.d.db.updateAgent(l.agentId, { status: "done", ended: true, sessionId: null, lastActivity: "Restarted for an edited or retried message" }));
    }
    for (const x of remove) this.liveText.delete(x.id);
    const removed = this.d.db.deleteMessages(remove.map((x) => x.id));
    if (removed.length) this.d.emit({ type: "messages.removed", chatId: chat.id, removed });
    // The rolling summary may already cover the removed turn: drop it back to the last context reset.
    const cs = this.d.db.getChatSummary(chat.id);
    if (cs.upto >= user.seq) this.d.db.setChatSummary(chat.id, "", this.d.db.lastResetBefore(chat.id, user.seq));
  }

  /** The message's /command: a leading one, or a known one (built-in or skill) anywhere in the text. */
  private slash(content: string, chat?: Chat) {
    return parseSlash(content, [...BUILTIN_COMMAND_NAMES, ...(chat ? this.skillsFor(chat) : this.d.skills()).map((k) => k.command)]);
  }

  /** The app's and the user's skills, plus the chat project's Agent Skills (.flashmaster/skills, .claude/skills, .agents/skills), which win on a name clash. */
  skillsFor(chat: Pick<Chat, "projectId">): SkillDef[] {
    const base = this.d.skills();
    const path = chat.projectId ? this.d.db.getProject(chat.projectId)?.path : null;
    if (!path) return base;
    const own = PROJECT_SKILL_DIRS.flatMap((d) => loadAgentSkills(join(path, d), "project"));
    return [...own.filter((k, i) => own.findIndex((x) => x.command === k.command) === i), ...base.filter((b) => !own.some((k) => k.command === b.command))];
  }

  /** use_skill: an Agent Skill's full instructions, with its folder and files so the agent can read the scripts and references it ships. */
  useSkill(agentId: string, name: string): { name: string; description: string; instructions: string; folder: string | null; files: string[] } {
    const a = this.d.db.getAgent(agentId);
    const chat = a?.chatId ? this.d.db.getChat(a.chatId) : null;
    const all = chat ? this.skillsFor(chat) : this.d.skills();
    const n = String(name ?? "").trim().toLowerCase();
    const k = all.find((x) => x.name.toLowerCase() === n || x.command === n || x.command === n.replace(/^\//, ""));
    if (!k) throw new Error(`unknown skill "${name}": one of ${all.filter((x) => x.dir).map((x) => x.name).join(", ") || "(none installed)"}`);
    if (a) this.flow(agentId, { kind: "status", label: `using skill ${k.name}`, status: "skill" });
    return { name: k.name, description: k.description, instructions: k.body.slice(0, 40_000), folder: k.dir ?? null, files: k.files ?? [] };
  }

  /** Run a stored user message: slash commands, @mentions, then the agent's turn. */
  private async dispatch(chat: Chat, threadRoot: string | null, userMsg: Message, content: string, attachments: Attachment[],
    pick?: { harness: HarnessId; model: string | null }): Promise<void> {
    const chatId = chat.id;
    const slash = this.slash(content, chat);
    if (slash.command === "superpowers") {
      const on = !chat.superpowers;
      this.d.db.updateChat(chatId, { superpowers: on });
      this.system(chatId, threadRoot, on
        ? "⚡ Superpowers workflow **enabled** for this chat. Agents will brainstorm → plan → implement with TDD → review → verify. Use `/superpowers` again to turn it off."
        : "Superpowers workflow **disabled** for this chat.");
      return;
    }
    if (slash.command === "stop") { await this.stopChat(chatId); return; }
    if (slash.command === "help") { this.system(chatId, threadRoot, this.helpText()); return; }
    if (slash.command === "kb-sync" || slash.command === "knowledge-sync") {
      if (!chat.projectId || !this.d.knowledge) { this.system(chatId, threadRoot, "The knowledge base belongs to a project: use `/kb-sync` in a project chat.", "warn"); return; }
      try { this.system(chatId, threadRoot, `📚 ${describeSync(this.d.knowledge.sync(chat.projectId))}`); } catch (e: any) { this.system(chatId, threadRoot, `⚠️ ${String(e?.message ?? e)}`, "error"); }
      return;
    }
    if (slash.command === "kb" || slash.command === "knowledge") {
      if (!chat.projectId || !this.d.knowledge || !this.memoryOn()) {
        this.system(chatId, threadRoot, !this.memoryOn() ? "Memory is turned off (Settings → Memory), and the knowledge base with it." : "The knowledge base belongs to a project: use `/kb` in a project chat.", "warn");
        return;
      }
      let brief: string;
      try { brief = await this.d.knowledge.prompt(chat.projectId, slash.text); } catch (e: any) { this.system(chatId, threadRoot, `⚠️ ${String(e?.message ?? e)}`, "error"); return; }
      const role = this.role(chat.agentRole);
      void this.turn({ chat, threadRoot, role, input: brief, attachments, skills: [], depth: 0, brief: null, msgIds: [userMsg.id], pick }).catch((e) =>
        this.system(chatId, threadRoot, `⚠️ ${String(e?.message ?? e)}`, "error"));
      return;
    }

    const roles = this.d.roles();
    const mention = parseMention(slash.command ? slash.text : content, roles.map((r) => r.name));
    const roleName = mention.role ?? (threadRoot ? this.threadRole(threadRoot) : null) ?? chat.agentRole;
    const role = this.role(roleName);
    const skills = this.activeSkills(chat, slash.command);
    const text = slash.command && skills.length ? slash.text || content : mention.text;
    void this.turn({ chat, threadRoot, role, input: text, attachments, skills, depth: 0, brief: null, msgIds: [userMsg.id], pick }).catch((e) =>
      this.system(chatId, threadRoot, `⚠️ ${String(e?.message ?? e)}`, "error"));
  }

  /** Start a specialist with a brief in a fresh chat (palette / "Analyse with agent" / tasks). */
  async startAgent(projectId: string | null, roleName: string, brief: string, taskId?: string): Promise<AgentRun> {
    const role = this.role(roleName);
    const chat = this.d.db.createChat({ projectId, title: `${role.icon} ${brief.slice(0, 48)}`, kind: "project", agentRole: role.name });
    const userMsg = this.d.db.addMessage({ chatId: chat.id, author: "user", content: brief });
    this.d.emit({ type: "message.created", message: userMsg });
    const live = this.ensureLive(chat, null, role, 0);
    if (taskId) this.d.db.updateTask(taskId, { agentId: live.agentId, status: "in_progress" });
    void this.turn({ chat, threadRoot: null, role, input: brief, skills: this.activeSkills(chat, null), depth: 0, brief: null, taskId })
      .catch((e) => this.system(chat.id, null, `⚠️ ${String(e?.message ?? e)}`, "error"));
    return this.d.db.getAgent(live.agentId)!;
  }

  /** Called by the flashmaster-core MCP `delegate` tool. */
  async delegate(parentAgentId: string, a: { role: string; goal: string; context?: string; files?: string[]; acceptance?: string;
    wait?: boolean; timeoutSec?: number; harness?: string; model?: string; provider?: string; args?: string; agentId?: string; folder?: string; local?: boolean;
    mode?: string; attempts?: number; onDone?: (result: string) => void }):
    Promise<{ agentId: string; name?: string | null; status: string; result?: string; harness?: string; model?: string | null }> {
    const parent = this.byAgent.get(parentAgentId);
    if (!parent) throw new Error("unknown parent agent");
    const s = this.d.settings();
    // Best of N: several independent attempts in their own worktrees; the app picks the winner (checks, then size).
    if ((a.attempts ?? 1) > 1 && !a.agentId) return this.delegateAttempts(parentAgentId, a);
    // A request's whole tree shares one token budget: past it, no new specialist starts.
    if (!a.agentId) this.checkTaskBudget(parent);
    if (parent.depth + 1 > s.agents.delegationDepth)
      throw new Error(parent.depth === 0
        ? "delegation is turned off (Settings → Agents → delegation depth is 0) — tell the user; don't do the work yourself"
        : `delegation depth limit (${s.agents.delegationDepth} levels, Settings → Agents) reached: you can't start a helper from here. `
          + "To get an earlier agent's report or result, call read_report (no delegation needed). Otherwise do it yourself, or end with status blocked and say what you need from the agent that delegated to you");
    const chat = this.mustChat(parent.chatId);
    const brief = buildBrief({ goal: a.goal, context: a.context, files: a.files, acceptance: a.acceptance, parentRole: parent.role.name,
      helperLevels: Math.max(0, s.agents.delegationDepth - (parent.depth + 1)) });
    // Specialist output appears as a thread under the coordinator's current reply.
    const threadRoot = parent.threadRoot ?? parent.currentMessageId ?? parent.lastReplyId ?? null;
    const want = a.harness && (HARNESS_IDS as string[]).includes(a.harness) ? (a.harness as HarnessId) : undefined;
    const projectPath = chat.projectId ? this.d.db.getProject(chat.projectId)?.path ?? null : null;
    const folder = a.folder?.trim() && !a.agentId ? this.resolveFolder(a.folder.trim(), projectPath) : null;
    let model = delegateModel(a.model, a.provider);
    const launchArgs = checkLaunchArgs(a.args);
    // Drive mode for this delegation: the coordinator's `mode`, or (Route by difficulty) the app's guess from the brief.
    // It picks the user's ECO / COMFORT / SPORT profile (Settings → Modes) unless a harness or model was named.
    let routedHarness: HarnessId | undefined;
    if (!a.agentId && !a.harness && !model && a.local !== true) {
      const asked = ROUTE_MODES.includes(a.mode as RouteMode) ? { mode: a.mode as RouteMode, reason: "asked by the coordinator" }
        : s.agents.autoRoute ? routeByDifficulty(`${a.goal}\n${a.context ?? ""}\n${a.acceptance ?? ""}`) : null;
      const prof = asked ? s.modes[asked.mode] : null;
      if (asked && prof && (prof.harness || prof.model)) {
        routedHarness = prof.harness || undefined;
        model = prof.model.trim() || null;
        this.flow(parentAgentId, { kind: "status", label: `routed ${a.role} to ${asked.mode.toUpperCase()}: ${asked.reason}`, status: "routed" });
      }
    }
    // Local-only: asked for (local: true), or the role demands it. A brief that demands local inference prefers a local
    // runtime when one is set up (soft: without one it runs as before, and a refusal comes back with a locality hint).
    const strictLocal = a.local === true || !!this.role(a.role).local;
    const softLocal = !strictLocal && needsLocalInference(`${a.goal}\n${a.context ?? ""}\n${a.acceptance ?? ""}`)
      && !("error" in pickLocalRuntime({ role: this.role(a.role), pick: model ? { harness: want, model } : undefined, localMode: s.modes.local,
        usable: (h) => this.d.harnesses.resolve(h, s) === h }));
    const local = !a.agentId && (strictLocal || softLocal);
    // GitLab Duo only works in GitLab repos: say so now, before an agent is created that could never start.
    // (A local-only agent never runs on Duo, so the check doesn't apply to it.)
    if (want === "duo" && !local && !a.agentId && this.d.harnesses.resolve("duo", s) === "duo") {
      const problem = await gitlabRepoProblem(folder ?? projectPath ?? this.noProjectDir() ?? this.d.homeDir, duoGitlabHosts(s.duo));
      if (problem) throw new Error(`${problem} Pass folder = a GitLab repository to run it there.`);
    }
    // Every delegation starts a new instance (own session, worktree and task), so two Coders never share one
    // conversation. Only an explicit agentId (an instance this agent started earlier) sends a follow-up to it.
    let live: Live;
    let reserved: string | null = null;
    let waiter: ((r: string) => void) | null = null;
    let done: Promise<string> | null;
    try {
      if (a.agentId) {
        let prev = this.byAgent.get(a.agentId);
        const known = this.d.db.getAgent(a.agentId);
        // A specialist closed for being idle comes back (fresh session, same name, thread and worktree) for a follow-up.
        if (!prev && known?.parentAgentId === parentAgentId && known.status === "done" && known.lastActivity?.startsWith(IDLE_CLOSED)) {
          prev = this.reviveLive(known, chat);
          this.emitAgent(this.d.db.updateAgent(known.id, { status: "idle", ended: false, lastActivity: "Back for a follow-up" }));
        }
        if (!prev || prev.stopped || known?.parentAgentId !== parentAgentId)
          throw new Error("unknown agentId: pass an id an earlier delegate returned to you, or leave it out to start a new specialist");
        if (prev.busy) throw new Error(`${agentLabel(prev, prev.role.title)} is still working on its current task: call get_result, or leave agentId out to start another instance`);
        live = prev;
        // A follow-up that asks for another model or launch arguments restarts the agent CLI with them (Pi and ACP agents resume the conversation).
        if ((model && model !== live.model) || (launchArgs && launchArgs !== live.launchArgs)) {
          if (model) { live.model = model; this.d.db.updateAgent(live.agentId, { model }); }
          if (launchArgs) { live.launchArgs = launchArgs; this.d.db.setAgentLaunchArgs(live.agentId, launchArgs); }
          live.session?.close();
          live.session = null;
        }
      } else {
        // Organised team, not a swarm: at most maxParallelSpecialists of this coordinator's specialists work at once.
        reserved = await this.waitForTeamSlot(parent, a.wait === false);
        // A model (or provider) from the coordinator applies to the harness it asked for, or to the role's harness when it named none.
        live = this.ensureLive(chat, threadRoot, this.role(a.role), parent.depth + 1, `${parentAgentId}>${a.role}#${++this.instanceSeq}`, parentAgentId, brief,
          want || routedHarness || model || local ? { harness: want ?? routedHarness, model, local } : undefined);
        if (folder) { live.folder = folder; this.d.db.setAgentFolder(live.agentId, folder); }
        if (launchArgs) { live.launchArgs = launchArgs; this.d.db.setAgentLaunchArgs(live.agentId, launchArgs); }
      }
      const role = live.role;
      if (want && live.harness !== want && !live.local)
        this.system(chat.id, threadRoot, `⚠️ ${want} is not available (not installed or disabled in Settings → Harnesses); ${role.title} runs on ${live.harness}.`, "warn");
      let taskId: string | undefined;
      if (s.agents.autoTaskFromDelegation) {
        const t = this.d.db.createTask({ projectId: chat.projectId, title: `${role.title}: ${a.goal.slice(0, 80)}`, description: brief,
          status: "in_progress", assigneeRole: role.name, agentId: live.agentId });
        taskId = t.id;
        this.d.emit({ type: "task.updated", task: t });
      }
      this.flow(parentAgentId, { kind: "delegate", label: `${agentLabel(live, role.title)}: ${a.goal.slice(0, 120)}`, ref: live.agentId });
      live.delegated = true;
      live.resultTaken = false;
      live.recoveries = 0;
      live.task = { goal: a.goal, brief, taskId };
      if (!a.agentId) this.d.db.setAgentState(live.agentId, mergeState(this.d.db.getAgentState(live.agentId), { goal: a.goal }));
      live.inPlan = !!a.onDone;
      if (a.onDone) live.waiters.push(a.onDone);
      if (this.d.traces) {
        live.traceId = parent.traceId ?? live.traceId ?? newTraceId();
        parent.traceId ??= live.traceId;
        live.delegateSpan = this.d.traces.start({ traceId: live.traceId, parentId: parent.turnSpan ?? parent.requestSpan ?? null, agentId: live.agentId, chatId: chat.id, kind: "delegate",
          name: `${agentLabel(live, role.title)}: ${a.goal.replace(/\s+/g, " ").slice(0, 100)}`, attrs: { "gen_ai.operation.name": "invoke_agent", "gen_ai.agent.name": agentLabel(live, role.title),
            "flash.role": role.name, "gen_ai.provider.name": live.harness, ...(live.model ? { "gen_ai.request.model": live.model } : {}), ...(live.branch ? { "flash.branch": live.branch } : {}) } });
      }
      live.taskStartedAt = Date.now();
      live.timeLimitedAt = undefined;
      done = a.wait === false ? null : new Promise<string>((resolve) => { waiter = resolve; live.waiters.push(resolve); });
      // Waiting delegations borrow the coordinator's slot; background ones (wait: false) queue for their own.
      const borrowSlot = a.wait !== false && parent.busy;
      void this.turn({ chat, threadRoot, role, input: a.goal, skills: [], depth: live.depth, brief, taskId, liveKey: live.key, borrowSlot })
        .catch((e) => this.finishDelegated(live, `error: ${String(e?.message ?? e)}`));
    } finally {
      // The specialist is busy now (turn() marks it synchronously), so it counts as working instead.
      if (reserved) this.unreserveTeamSlot(reserved);
    }
    const name = live.name ?? null;
    if (!done) return { agentId: live.agentId, name, status: "running", harness: live.harness, model: live.model,
      result: "Started in the background. Its result comes to you in a new message when it finishes: don't poll get_result." };
    const timeout = Math.min(Math.max(a.timeoutSec ?? 600, 10), 1800) * 1000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([done, new Promise<null>((r) => { timer = setTimeout(() => r(null), timeout); })]);
    clearTimeout(timer);
    if (result === null) {
      // Nobody is waiting any more: the result is sent to the coordinator as a new message when it arrives.
      live.waiters = live.waiters.filter((w) => w !== waiter);
      return { agentId: live.agentId, name, status: "running", result: "Still running. Its result comes to you in a new message when it finishes." };
    }
    return { agentId: live.agentId, name, status: this.d.db.getAgent(live.agentId)?.status ?? "done", result, harness: live.harness, model: live.model };
  }

  /**
   * Best of N (delegate with `attempts`): N independent instances of the role work on the same goal, each in its own
   * worktree. When all are done the app ranks them (green checks, a finished result, then the smallest change) and
   * returns the winner's result with a comparison. Nothing is discarded: the other branches stay for the user's review.
   */
  private async delegateAttempts(parentAgentId: string, a: Parameters<Orchestrator["delegate"]>[1]):
    Promise<{ agentId: string; name?: string | null; status: string; result?: string; harness?: string; model?: string | null }> {
    const s = this.d.settings();
    const n = Math.min(Math.max(2, Math.floor(a.attempts ?? 2)), Math.max(2, s.agents.maxAttempts || 3));
    const parent = this.byAgent.get(parentAgentId)!;
    this.checkTaskBudget(parent);
    this.flow(parentAgentId, { kind: "status", label: `best of ${n}: ${a.role} — ${a.goal.slice(0, 100)}`, status: "running" });
    const runs = await Promise.all(Array.from({ length: n }, (_, i) => this.delegate(parentAgentId, { ...a, attempts: 1, wait: true, timeoutSec: Math.max(a.timeoutSec ?? 1800, 600),
      context: `${a.context ?? ""}\n\nYou are attempt ${i + 1} of ${n} at this goal; other agents try it independently in their own copies and the best result is kept. Take the approach you think is best, and say what you'd verify next.`.trim() })
      .catch((e: unknown) => ({ agentId: "", name: null, status: "failed", result: `error: ${String((e as Error)?.message ?? e)}` }))));
    const attempts: Attempt[] = [];
    for (const r of runs) {
      if (!r.agentId) continue;
      const ag = this.d.db.getAgent(r.agentId);
      let checks = this.d.db.getCheckRun(r.agentId);
      let changed: number | null = null;
      if (ag?.worktree && ag.branch && !this.byAgent.get(r.agentId)?.busy) {
        try { changed = (await this.workChanges(r.agentId)).files.reduce((sum, f) => sum + f.added + f.removed, 0); } catch { /* unknown size */ }
        if (!checks) { try { checks = await this.runAgentChecks(r.agentId); } catch { /* no checks */ } }
      }
      attempts.push({ agentId: r.agentId, name: r.name ?? null, branch: ag?.branch ?? null, status: r.status, result: r.result ?? "", checks, changed });
    }
    if (!attempts.length) throw new Error(runs.map((r) => r.result).find(Boolean) ?? "no attempt could start");
    const ranked = rankAttempts(attempts);
    const best = ranked[0]!;
    const chat = this.mustChat(parent.chatId);
    this.system(chat.id, parent.threadRoot ?? parent.currentMessageId ?? parent.lastReplyId ?? null,
      `🏁 Best of ${ranked.length}: **${best.name ?? best.agentId}** wins (${best.checks ? (best.checks.ok ? "checks passed" : "checks failed") : "no checks"}, ${best.changed ?? "?"} lines). `
        + `${ranked.length > 1 ? `Kept for your review: ${ranked.slice(1).map((x) => x.name ?? x.agentId).join(", ")}.` : ""}`);
    this.flow(parentAgentId, { kind: "status", label: `best of ${ranked.length}: ${best.name ?? best.agentId} wins`, status: "done" });
    const winner = this.byAgent.get(best.agentId);
    return { agentId: best.agentId, name: best.name, status: best.status, result: attemptsReport(ranked), harness: winner?.harness, model: winner?.model ?? null };
  }

  // ---------- task plans ----------

  /**
   * The coordinator proposes a task graph. With Settings → Agents → Plans on "ask" the user sees it as a card, can edit
   * it and approves it; on "auto" it runs at once. Either way code runs it in waves and the coordinator gets one result.
   */
  proposePlan(agentId: string, a: { title?: string; tasks?: unknown }): { planId: string; status: string; note: string } {
    const l = this.byAgent.get(agentId);
    if (!l) throw new Error("unknown agent");
    if (l.depth > 0) throw new Error("only a coordinator proposes plans: delegate helpers directly, or say in your result what should happen next");
    const tasks = normaliseTasks(a.tasks);
    const errs = validatePlan(tasks, this.d.roles().map((r) => r.name));
    if (errs.length) throw new Error(`plan not valid: ${errs.join("; ")}`);
    const now = Date.now();
    const plan: TaskPlan = { id: randomUUID(), chatId: l.chatId, agentId, title: String(a.title ?? "").trim().slice(0, 120) || "Plan", status: "draft", tasks, messageId: null, createdAt: now, updatedAt: now };
    const auto = this.d.settings().agents.planApproval === "auto";
    const m = this.d.db.addMessage({ chatId: l.chatId, parentId: l.threadRoot, author: "system", agentId, role: l.role.name, planId: plan.id,
      content: `📋 **Plan** · ${plan.title}\n\n${planOutline(tasks)}` });
    plan.messageId = m.id;
    this.d.db.savePlan(plan);
    this.d.emit({ type: "message.created", message: m });
    this.d.emit({ type: "plan.updated", plan });
    this.flow(agentId, { kind: "plan", label: `plan: ${plan.title} (${tasks.length} tasks)`, status: auto ? "running" : "needs_you" });
    if (auto) {
      void this.runPlan(plan.id).catch((e) => this.system(l.chatId, l.threadRoot, `⚠️ Plan failed: ${String(e?.message ?? e)}`, "error"));
      return { planId: plan.id, status: "running", note: "The plan runs now; code starts each task when its dependencies are done. You get one message with every task's result when it finishes. End your turn with a short note." };
    }
    this.d.emit({ type: "notice", level: "info", text: `Plan to review: ${plan.title}` });
    return { planId: plan.id, status: "draft", note: "The user sees the plan as a card, can edit it, and approves it before it runs. End your turn now with a one-line note; when it has run you get one message with every task's result." };
  }

  listPlans(chatId: string): TaskPlan[] { return this.d.db.listPlans(chatId); }
  getPlan(planId: string): TaskPlan | null { return this.runningPlans.get(planId) ?? this.d.db.getPlan(planId); }

  /** The user edited a draft plan on its card. */
  updatePlan(planId: string, a: { title?: string; tasks?: unknown }): TaskPlan {
    const plan = this.d.db.getPlan(planId);
    if (!plan) throw new Error("unknown plan");
    if (plan.status !== "draft") throw new Error("This plan already ran; ask the coordinator for a new one.");
    const tasks = a.tasks === undefined ? plan.tasks : normaliseTasks(a.tasks);
    const errs = validatePlan(tasks, this.d.roles().map((r) => r.name));
    if (errs.length) throw new Error(errs.join("; "));
    const next = { ...plan, title: String(a.title ?? plan.title).trim().slice(0, 120) || plan.title, tasks, updatedAt: Date.now() };
    this.d.db.savePlan(next);
    this.d.emit({ type: "plan.updated", plan: next });
    return next;
  }

  /** The user approved a draft plan (optionally with a last edit): it starts. */
  async approvePlan(planId: string, a?: { title?: string; tasks?: unknown }): Promise<TaskPlan> {
    if (a) this.updatePlan(planId, a);
    const plan = this.d.db.getPlan(planId);
    if (!plan || plan.status !== "draft") throw new Error("This plan isn't waiting for approval.");
    void this.runPlan(planId).catch((e) => this.system(plan.chatId, null, `⚠️ Plan failed: ${String(e?.message ?? e)}`, "error"));
    return this.getPlan(planId)!;
  }

  /** Cancel: a draft never runs; a running plan starts no more tasks (running ones finish) and the coordinator is told. */
  cancelPlan(planId: string): TaskPlan {
    const plan = this.runningPlans.get(planId) ?? this.d.db.getPlan(planId);
    if (!plan) throw new Error("unknown plan");
    if (plan.status !== "draft" && plan.status !== "running") return plan;
    const wasDraft = plan.status === "draft";
    plan.status = "cancelled";
    for (const t of plan.tasks) if (t.status === "pending") { t.status = "skipped"; t.result = "skipped: the plan was cancelled"; }
    plan.updatedAt = Date.now();
    this.d.db.savePlan(plan);
    this.d.emit({ type: "plan.updated", plan });
    if (wasDraft) this.wakeWith(plan.agentId, `The user declined your plan "${plan.title}". Ask what they'd like instead, or go on another way.`, "plan declined");
    return plan;
  }

  private savePlanNow(plan: TaskPlan): void {
    plan.updatedAt = Date.now();
    this.d.db.savePlan(plan);
    this.d.emit({ type: "plan.updated", plan: { ...plan, tasks: plan.tasks.map((t) => ({ ...t })) } });
  }

  /** Run a plan in waves: every task whose dependencies are done starts (team slots still apply); a failure skips its dependants. */
  async runPlan(planId: string): Promise<TaskPlan> {
    const plan = this.d.db.getPlan(planId);
    if (!plan || plan.status !== "draft") throw new Error("This plan isn't waiting to run.");
    const coord = this.byAgent.get(plan.agentId);
    if (!coord || coord.stopped) {
      plan.status = "failed";
      this.savePlanNow(plan);
      throw new Error("the coordinator that proposed this plan is no longer running: send your request again");
    }
    plan.status = "running";
    this.runningPlans.set(plan.id, plan);
    this.savePlanNow(plan);
    const running = new Map<string, Promise<void>>();
    const start = (t: TaskPlan["tasks"][number]) => {
      t.status = "running";
      const multi = (t.attempts ?? 1) > 1;
      const p = new Promise<void>((resolve) => {
        const finish = (r: string) => {
          if (t.status !== "running") return resolve();
          t.result = r.slice(0, 6000);
          t.status = resultOk(r) ? "done" : "failed";
          this.savePlanNow(plan);
          resolve();
        };
        this.delegate(plan.agentId, { role: t.role, goal: t.goal, context: dependencyContext(plan, t), mode: t.mode ?? undefined, attempts: t.attempts ?? undefined,
          wait: multi, timeoutSec: 1800, onDone: multi ? () => undefined : finish })
          .then((r) => { t.agentId = r.agentId; this.savePlanNow(plan); if (multi) finish(r.result ?? ""); })
          .catch((e: unknown) => finish(`error: ${String((e as Error)?.message ?? e)}`));
      });
      running.set(t.id, p.then(() => { running.delete(t.id); }));
    };
    for (;;) {
      if (plan.status === "running") {
        skipBlocked(plan);
        for (const t of readyTasks(plan)) start(t);
      }
      if (!running.size) break;
      this.savePlanNow(plan);
      await Promise.race(running.values());
    }
    if (plan.status === "running") plan.status = plan.tasks.every((t) => t.status === "done") ? "done" : "failed";
    this.runningPlans.delete(plan.id);
    this.savePlanNow(plan);
    const done = plan.tasks.filter((t) => t.status === "done").length;
    this.flow(plan.agentId, { kind: "plan", label: `plan ${plan.status}: ${done}/${plan.tasks.length} tasks done`, status: plan.status });
    this.wakeWith(plan.agentId, planReport(plan), `woken: plan "${plan.title}" ${plan.status}`);
    return plan;
  }

  /** Give a coordinator a message as soon as it is free (results that arrive while it is busy wait for its turn to end). */
  private wakeWith(agentId: string, input: string, label: string): void {
    const p = this.byAgent.get(agentId);
    if (!p || p.stopped || !this.live.has(p.key)) return;
    if (p.busy || (p.textWaiting ?? 0) > 0) { setTimeout(() => this.wakeWith(agentId, input, label), REPORT_DEBOUNCE_MS); return; }
    const chat = this.d.db.getChat(p.chatId);
    if (!chat) return;
    this.flow(agentId, { kind: "status", label: label.slice(0, 160), status: "running" });
    void this.turn({ chat, threadRoot: p.threadRoot, role: p.role, input, skills: [], depth: p.depth, brief: null, liveKey: p.key, deliver: false, textRound: 0 })
      .catch((e) => this.system(chat.id, p.threadRoot, `⚠️ ${String(e?.message ?? e)}`, "error"));
  }

  // ---------- working state and summaries ----------

  /** update_state: the agent records what it has done, decided and will do next (merged; see agent-state.ts). */
  updateState(agentId: string, u: Record<string, unknown>): { ok: true; state: AgentState } {
    if (!this.byAgent.get(agentId) && !this.d.db.getAgent(agentId)) throw new Error("unknown agent");
    const st = mergeState(this.d.db.getAgentState(agentId), u ?? {});
    this.d.db.setAgentState(agentId, st);
    return { ok: true, state: st };
  }

  agentState(agentId: string): AgentState | null { return this.d.db.getAgentState(agentId); }

  /** A file the agent edited goes into its working state (relative to its folder). */
  private noteStateFile(live: Live, root: string | null, path: string): void {
    const base = this.agentWorkDir(live.agentId) ?? root;
    const rel = base && isAbsolute(path) ? relative(base, path).replace(/\\/g, "/") : path.replace(/\\/g, "/");
    if (!rel || rel.startsWith("..")) return;
    const st = this.d.db.getAgentState(live.agentId);
    if (st?.files.includes(rel)) return;
    this.d.db.setAgentState(live.agentId, mergeState(st, { files: [rel] }));
  }

  /** Summarise the older part of a chat with the cheap / local model of Settings → Token efficiency, replacing the extractive summary. */
  private async modelSummary(chatId: string, prev: string | null, msgs: Pick<Message, "author" | "role" | "content">[], upto: number): Promise<void> {
    const s = this.d.settings();
    const [h, ...rest] = s.tokens.summarizerModel.trim().split("/");
    const harness = (HARNESS_IDS as string[]).includes(h ?? "") ? (h as HarnessId) : null;
    if (!harness) return;
    const transcript = msgs.map((m) => `${m.author === "user" ? "User" : (m.role ?? "Agent")}: ${m.content.replace(/\s+/g, " ").slice(0, 1500)}`).join("\n");
    const prompt = [SUMMARY_PROMPT, prev ? `Earlier summary:\n${prev}` : "", `Conversation:\n${transcript.slice(-40_000)}`].filter(Boolean).join("\n\n");
    try {
      const text = (await this.oneShot(harness, rest.join("/") || null, prompt, 90_000)).trim();
      if (!text || this.d.db.getChatSummary(chatId).upto !== upto) return; // a newer summary already replaced it
      this.d.db.setChatSummary(chatId, text.slice(0, 4000), upto);
    } catch (e) {
      this.d.log?.("warn", `model summary failed (${s.tokens.summarizerModel}): ${String((e as Error)?.message ?? e)}; keeping the extractive one`);
    }
  }

  /** One prompt to a model with no tools (read-only, every tool call refused); returns its text. */
  private async oneShot(harness: HarnessId, model: string | null, prompt: string, timeoutMs: number): Promise<string> {
    const s = this.d.settings();
    const adapter = this.d.harnesses.get(this.d.harnesses.resolve(harness, s));
    const hs = s.harnesses[adapter.id];
    let text = "";
    const session = await adapter.start({ cwd: this.d.dataDir ?? this.d.homeDir, model, extraArgs: hs?.args ?? "", executable: this.d.harnesses.cached(adapter.id)?.path ?? (hs?.path || null),
      mcpServers: [], env: { ...networkEnv(s), ...(this.d.harnessEnv?.(adapter.id) ?? {}) }, resumeSessionId: null,
      policy: { approval: "ask", readOnly: true, blocked: [], projectRoot: null },
      onEvent: (e) => { if (e.type === "text") text += e.text; }, askPermission: async () => false });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([session.prompt(prompt), new Promise((_, rej) => { timer = setTimeout(() => rej(new Error("timed out")), timeoutMs); })]);
      return text;
    } finally {
      clearTimeout(timer);
      session.close();
    }
  }

  /** Tokens the current request of a coordinator's tree spent so far (coordinator since the request + every agent started since). */
  requestTokens(rootAgentId: string): { used: number; since: number } | null {
    const root = this.byAgent.get(rootAgentId);
    if (!root?.requestStart) return null;
    const { at, base } = root.requestStart;
    const me = this.d.db.getAgent(rootAgentId);
    let used = me ? Math.max(0, me.tokensIn + me.tokensOut - base) : 0;
    for (const ag of this.d.db.listAgents({})) {
      if (ag.id === rootAgentId || ag.chatId !== root.chatId || ag.startedAt < at) continue;
      if (this.teamRoot(ag.id) === rootAgentId) used += ag.tokensIn + ag.tokensOut;
    }
    return { used, since: at };
  }

  /** Refuse to start another specialist when the request's tree has spent its task budget (Settings → Token efficiency). */
  private checkTaskBudget(parent: Live): void {
    const limit = this.d.settings().tokens.taskBudget;
    if (!limit || limit <= 0) return;
    const rootId = this.teamRoot(parent.agentId);
    const r = this.requestTokens(rootId);
    if (!r) return;
    const root = this.byAgent.get(rootId);
    if (r.used < limit) {
      const pct = Math.round((r.used / limit) * 100);
      if (pct >= this.d.settings().tokens.warnAtPercent) this.flow(parent.agentId, { kind: "status", label: `task budget at ${pct}% (${r.used.toLocaleString()} / ${limit.toLocaleString()} tokens)`, status: "budget" });
      return;
    }
    const msg = `task budget reached: this request used ${r.used.toLocaleString()} of ${limit.toLocaleString()} tokens across the coordinator and its specialists`;
    this.flow(parent.agentId, { kind: "status", label: msg.slice(0, 160), status: "budget" });
    if (root && !root.budgetWarned) {
      root.budgetWarned = true;
      this.system(root.chatId, root.threadRoot ?? root.currentMessageId ?? null, `🛑 ${msg[0]!.toUpperCase()}${msg.slice(1)}. No new specialists start for it; running ones finish. Raise it in Settings → Token efficiency → Task budget.`, "warn");
    }
    throw new Error(`${msg}. Don't start more agents: finish with what you have, tell the user what is done and what is left, and that they can raise the task budget in Settings → Token efficiency`);
  }

  /**
   * Wall-clock limit per delegated task (Settings → Agents → Time limit per task), called every 30 s with the stuck
   * watchdog. Past the limit the specialist is interrupted and told to wrap up with what it has; still working 3 minutes
   * later, it is stopped and its delegating agent gets a "time limit" result. Returns the agents it acted on.
   */
  checkTimeLimits(now = Date.now()): string[] {
    const mins = this.d.settings().agents.maxTaskMinutes;
    if (!mins || mins <= 0) return [];
    const acted: string[] = [];
    for (const l of this.live.values()) {
      if (!l.busy || l.stopped || !l.delegated || !l.parentAgentId || !l.taskStartedAt || l.awaitingApproval) continue;
      if (now - l.taskStartedAt < mins * 60_000) continue;
      const who = `${l.role.icon} ${agentLabel(l, l.role.title)}`;
      if (!l.timeLimitedAt) {
        l.timeLimitedAt = now;
        l.redirect = { input: TIME_LIMIT_NUDGE(mins), attachments: [], msgIds: [], nudge: true };
        this.flow(l.agentId, { kind: "status", label: `time limit (${mins} min): told to wrap up`, status: "budget" });
        this.system(l.chatId, l.threadRoot, `⏱ **${who}** reached the ${mins}-minute limit per task, so TheFlashMaster asked it to wrap up with what it has.`);
        void l.session?.cancel();
        acted.push(l.agentId);
      } else if (now - l.timeLimitedAt > TIME_LIMIT_GRACE_MS) {
        this.flow(l.agentId, { kind: "status", label: `time limit: stopped`, status: "budget" });
        this.system(l.chatId, l.threadRoot, `⏹ **${who}** kept working past its time limit, so it was stopped. Its work so far is kept${l.branch ? ` on ${l.branch}` : ""}.`, "warn");
        this.finishDelegated(l, `failed: stopped at the ${mins}-minute time limit per task (Settings → Agents). Partial work is kept${l.branch ? ` on branch ${l.branch}` : ""}; follow up with agentId ${l.agentId} or split the task.`);
        void this.stop(l.agentId);
        acted.push(l.agentId);
      }
    }
    return acted;
  }

  /** Called by the coordinator's `create_agent` tool (and text-mode AGENT blocks): define a new agent, optionally run it. */
  async createAgent(parentAgentId: string, a: AgentSpec & { provider?: string; args?: string; keep?: boolean; goal?: string; context?: string; files?: string[]; acceptance?: string; wait?: boolean }):
    Promise<{ role: string; created: string; agentId?: string; status?: string; result?: string }> {
    const parent = this.byAgent.get(parentAgentId);
    if (!parent) throw new Error("unknown parent agent");
    if (!this.d.createRole) throw new Error("creating agents is not available here");
    if (!a.instructions?.trim()) throw new Error("instructions are required: the new agent's complete operating instructions");
    const name = slugRole(a.name || a.title || "");
    if (!name) throw new Error("name is required");
    const role = this.d.createRole({ ...a, name }, parent.role.name, a.keep !== false);
    this.flow(parentAgentId, { kind: "delegate", label: `created agent ${role.title}` });
    this.system(parent.chatId, parent.threadRoot ?? parent.currentMessageId ?? parent.lastReplyId ?? null,
      `🧩 ${parent.role.title} created the agent **${role.icon} ${role.title}** (\`${role.name}\`)${a.keep === false ? " for this session" : ", saved to your agents"}.`);
    const created = a.keep === false ? "temporary (until restart)" : "saved to the agents folder";
    if (!a.goal) return { role: role.name, created };
    const r = await this.delegate(parentAgentId, { role: role.name, goal: a.goal, context: a.context, files: a.files, acceptance: a.acceptance, wait: a.wait,
      harness: a.harness, model: a.model, provider: a.provider, args: a.args });
    return { role: role.name, created, agentId: r.agentId, status: r.status, result: r.result };
  }

  getResult(agentId: string): { status: string; result: string | null } {
    const a = this.d.db.getAgent(agentId);
    if (!a) throw new Error("unknown agent");
    const l = this.byAgent.get(agentId);
    if (l && !l.busy) l.resultTaken = true;
    return { status: a.status, result: l?.lastResult ?? a.resultSummary };
  }

  /**
   * The `read_report` tool: the full final reply (report) of another agent of the caller's project, not only the capped
   * result a delegation returns. Any agent may read any agent of its project (or of its chat, without a project), at any
   * depth, so a specialist that needs an earlier report reads it instead of delegating a helper to fetch it.
   */
  readReport(callerId: string, a: { agentId?: string; name?: string; offset?: number; limit?: number; index?: number }): {
    agentId: string; name: string | null; role: string; status: string; brief: string; report: string; chars: number; offset: number; more: boolean;
    olderReports: number } {
    const me = this.d.db.getAgent(callerId);
    if (!me) throw new Error("unknown agent");
    const pool = me.projectId ? this.d.db.listAgents({ projectId: me.projectId })
      : this.d.db.listAgents({ projectId: null }).filter((x) => x.chatId === me.chatId);
    const want = (a.name ?? "").trim().toLowerCase();
    const target = a.agentId ? pool.find((x) => x.id === a.agentId)
      : want ? pool.find((x) => x.id !== callerId && (x.name?.toLowerCase() === want || agentLabel(x, x.role).toLowerCase() === want))
        ?? pool.find((x) => x.id !== callerId && x.role.toLowerCase() === want) : undefined;
    if (!target) throw new Error(a.agentId || want
      ? "no such agent in this project: call list_agents with activeOnly: false to see every agent, finished ones too, with their ids"
      : "pass agentId (from list_agents or delegate) or the agent's name");
    const replies = this.d.db.agentReplies(target.id, 20);
    const idx = Math.max(0, Math.floor(a.index ?? 0));
    const full = replies[idx]?.content ?? (idx === 0 ? target.resultSummary ?? "" : "");
    const offset = Math.max(0, Math.floor(a.offset ?? 0));
    const limit = Math.min(40000, Math.max(500, Math.floor(a.limit ?? 12000)));
    const report = full ? full.slice(offset, offset + limit) : "(this agent has not reported anything yet)";
    return { agentId: target.id, name: target.name, role: target.role, status: target.status, brief: target.brief.slice(0, 600),
      report, chars: full.length, offset, more: offset + limit < full.length, olderReports: Math.max(0, replies.length - idx - 1) };
  }

  /**
   * The `agent_status` tool: where another agent of the project is right now, as the app sees it, without interrupting
   * it. Covers agents that say little while they work (GitLab Duo): whether its process is alive, its latest progress
   * lines and STATUS line, the step it is on and the end of what it has written so far.
   */
  agentStatus(callerId: string, agentId: string): Record<string, unknown> {
    const target = this.projectAgent(callerId, agentId);
    const l = this.byAgent.get(target.id);
    const now = Date.now();
    const ago = (t?: number | null) => (t ? `${Math.max(0, Math.round((now - t) / 1000))}s ago` : null);
    const plan = target.plan ?? [];
    const cur = plan.find((p) => p.status === "in_progress");
    const working = !!l?.busy;
    const out: Record<string, unknown> = { agentId: target.id, name: target.name, role: target.role, harness: target.harness, status: target.status,
      working, activity: target.lastActivity };
    if (working && l) {
      Object.assign(out, {
        workingFor: l.turnStartedAt ? `${Math.round((now - l.turnStartedAt) / 60_000)} min` : null,
        lastOutput: ago(l.lastOutputAt),
        processAlive: l.heartbeatAt ? this.alive(l, now) : null,
        ...(l.stuckSince ? { mayBeStuck: true } : {}),
        ...(l.awaitingApproval ? { waitingFor: "the user's approval" } : {}),
        runningTools: [...(l.tools?.values() ?? [])].filter((r) => r.status !== "completed" && r.status !== "failed").map((r) => r.title).slice(-5),
      });
    }
    if (l?.statusNote) out.statusLine = { text: l.statusNote.text, at: ago(l.statusNote.at) };
    if (plan.length) out.step = cur ? `${plan.filter((p) => p.status === "completed").length + 1}/${plan.length}: ${cur.title}` : `${plan.filter((p) => p.status === "completed").length}/${plan.length} steps done`;
    if (l?.recent?.length) out.recent = l.recent.slice(-6);
    if (working && l?.tail?.trim()) out.writingNow = l.tail.trim().slice(-600);
    if (l?.queue.length) out.queuedMessages = l.queue.length;
    if (!working) out.result = (l?.lastResult ?? target.resultSummary ?? "").slice(0, 600) || null;
    out.hint = working
      ? "It is working. Quiet is not stuck while processAlive is true. To steer it or ask it something, use message_agent; don't start another instance."
      : "It is not working. Send it a follow-up with message_agent (or delegate with its agentId).";
    return out;
  }

  /**
   * The `message_agent` tool: the delegating agent talks to a specialist it started, while it works or after. A working
   * agent gets the message in its running turn where the harness can (Pi), else when its turn ends, or at once with
   * interrupt (the turn is stopped and continues the same session with the message: GitLab Duo resumes its session).
   * An idle one starts a follow-up. Either way its next result comes back to the sender.
   */
  async messageAgent(callerId: string, a: { agentId?: string; message?: string; interrupt?: boolean; wait?: boolean; timeoutSec?: number }):
    Promise<Record<string, unknown>> {
    const text = String(a.message ?? "").trim();
    if (!text) throw new Error("message is empty");
    const target = this.projectAgent(callerId, String(a.agentId ?? ""));
    if (target.parentAgentId !== callerId)
      throw new Error("you can only message agents you started (delegate returned their agentId); use agent_status or read_report to look at others");
    const me = this.byAgent.get(callerId);
    const from = me ? agentLabel(me, me.role.title) : "The delegating agent";
    const l = this.byAgent.get(target.id);
    const who = l ? `${l.role.icon} ${agentLabel(l, l.role.title)}` : target.name ?? target.role;
    if (!l || !l.busy) {
      const r = await this.delegate(callerId, { role: target.role, goal: text, agentId: target.id, wait: a.wait ?? false, timeoutSec: a.timeoutSec });
      return { delivered: "started", ...r };
    }
    if (l.stopped) throw new Error(`${who} was stopped`);
    const chatNote = (how: string) => this.system(l.chatId, l.threadRoot, `✉️ **${from}** → **${who}** (${how}): ${text.replace(/\s+/g, " ").slice(0, 300)}`);
    const input = AGENT_MESSAGE(from, text);
    if (l.session?.steer && (await l.session.steer(input).catch(() => false))) {
      this.flow(l.agentId, { kind: "status", label: `message from ${from}: ${text.slice(0, 100)}`, status: "steer" });
      chatNote("delivered into its running turn");
      return { delivered: "steered", agentId: l.agentId, note: "It has the message in its running turn. Its result comes to you as usual." };
    }
    if (a.interrupt) {
      // Without the session (a Duo run that never printed its session id) the next turn starts fresh: give it the task again.
      const task = !l.session?.sessionId && l.task ? `Your task (you were interrupted before it was done):\n${l.task.brief ?? l.task.goal}\n\n` : "";
      l.redirect = l.redirect ? { ...l.redirect, input: `${l.redirect.input}\n\n${input}`, fromAgent: l.redirect.fromAgent ?? from }
        : { input: `${task}${input}`, attachments: [], msgIds: [], fromAgent: from };
      this.flow(l.agentId, { kind: "status", label: `interrupted by ${from}: ${text.slice(0, 100)}`, status: "steer" });
      this.setStatus(l, "running", `Interrupted by a message from ${from}…`);
      chatNote("interrupted it");
      await l.session?.cancel();
      return { delivered: "interrupted", agentId: l.agentId, note: "Its turn was stopped and continues now with your message (same session). Its result comes to you as usual." };
    }
    l.queue.push({ input, attachments: [], fromAgent: from });
    this.flow(l.agentId, { kind: "status", label: `message from ${from} queued: ${text.slice(0, 100)}`, status: "queued" });
    chatNote("queued until its current turn ends");
    return { delivered: "queued", agentId: l.agentId,
      note: "It gets the message when its current turn ends; that reply comes back to you. Pass interrupt: true to stop the turn and deliver it now." };
  }

  /** An agent of the caller's project (or of its chat, without a project). */
  private projectAgent(callerId: string, agentId: string): AgentRun {
    const me = this.d.db.getAgent(callerId);
    const a = agentId ? this.d.db.getAgent(agentId) : null;
    if (!me || !a || a.id === callerId || (me.projectId ? a.projectId !== me.projectId : a.chatId !== me.chatId))
      throw new Error("unknown agentId: use an id from delegate or list_agents (this project only)");
    return a;
  }

  /** A progress line from a headless CLI (Duo's log): output, kept for agent_status and shown in the status line now and then. */
  private noteActivity(l: Live, text: string): void {
    this.noteOutput(l);
    l.recent = [...(l.recent ?? []), text].slice(-RECENT_LINES);
    const now = Date.now();
    if (l.statusNote && now - l.statusNote.at < 60_000) return; // the agent's own STATUS line wins for a minute
    if (l.activityShownAt && now - l.activityShownAt < 2000) return;
    l.activityShownAt = now;
    this.setStatus(l, "running", `▸ ${text}`);
  }

  /** Read `STATUS: …` lines from streamed text: the agent says where it is, and the app shows and keeps it. */
  private readStatusLines(l: Live, delta: string): void {
    l.tail = ((l.tail ?? "") + delta).slice(-2000);
    const lines = ((l.lineBuf ?? "") + delta).split(/\r?\n/);
    l.lineBuf = (lines.pop() ?? "").slice(-1000);
    for (const line of lines) {
      const m = STATUS_LINE_RE.exec(line);
      if (!m?.[1]) continue;
      const note = m[1].replace(/\*\*$/, "").trim();
      l.statusNote = { text: note, at: Date.now() };
      l.recent = [...(l.recent ?? []), `STATUS: ${note}`].slice(-RECENT_LINES);
      this.setStatus(l, "running", `📣 ${note}`.slice(0, 300));
      this.flow(l.agentId, { kind: "status", label: `status: ${note.slice(0, 150)}`, status: /^blocked\b/i.test(note) ? "blocked" : "running" });
    }
  }

  pause(agentId: string): void {
    const l = this.byAgent.get(agentId);
    if (!l) return;
    l.paused = true;
    if (l.busy) void l.session?.cancel();
    this.setStatus(l, "paused", "Paused — new input is queued until resumed");
    this.flow(agentId, { kind: "status", label: "paused", status: "paused" });
  }

  resume(agentId: string): void {
    const l = this.byAgent.get(agentId);
    if (!l || !l.paused) return;
    l.paused = false;
    const queued = l.queue.splice(0);
    const chat = this.mustChat(l.chatId);
    const input = queued.length ? queued.map((q) => q.input).join("\n\n") : "Continue where you left off. Be concise.";
    this.setStatus(l, "idle", "Resumed");
    this.flow(agentId, { kind: "status", label: "resumed", status: "running" });
    void this.turn({ chat, threadRoot: l.threadRoot, role: l.role, input, attachments: queued.flatMap((q) => q.attachments), skills: [], depth: l.depth,
      brief: null, liveKey: l.key, msgIds: queued.flatMap((q) => q.msgIds ?? []), deliver: true });
  }

  async stop(agentId: string): Promise<void> {
    const l = this.byAgent.get(agentId);
    if (!l) {
      const a = this.d.db.getAgent(agentId);
      if (a && ["idle", "running", "paused", "interrupted"].includes(a.status)) this.emitAgent(this.d.db.updateAgent(agentId, { status: "stopped", ended: true }));
      return;
    }
    l.queue = [];
    l.paused = false;
    l.stopped = true;
    if (l.busy) await l.session?.cancel();
    l.session?.close();
    l.session = null;
    this.live.delete(l.key);
    this.byAgent.delete(agentId);
    l.delegated = false;
    this.finishWaiters(l, "stopped by user");
    // Delegations waiting for a free specialist of this coordinator give up; pending wake-ups are dropped.
    for (const w of this.teamWaiters.get(agentId) ?? []) w();
    this.teamWaiters.delete(agentId);
    const r = this.reports.get(agentId);
    if (r?.timer) clearTimeout(r.timer);
    this.reports.delete(agentId);
    if (l.parentAgentId) this.teamSlotFreed(l.parentAgentId);
    this.emitAgent(this.d.db.updateAgent(agentId, { status: "stopped", ended: true, lastActivity: "Stopped" }));
  }

  // ------------------------------------------------------------------ worktrees

  private get git(): Git { return this.d.git ?? defaultGit; }
  private ownHooks: HookRunnerHost | null = null;
  /** The user's hooks; the text is parsed on every use, so edits in Settings apply to the next tool call. */
  private get hooks(): HookRunnerHost {
    if (this.d.hooks) return this.d.hooks;
    return this.ownHooks ??= new HookRunnerHost(() => parseHooks(this.d.settings().permissions.hooks ?? "").hooks, undefined,
      (line) => this.d.log?.("warn", line));
  }

  /** Where agents without a project work (created on first use); null when the app gives none (tests) or it can't be created. */
  private noProjectDir(): string | null {
    const dir = this.d.noProjectDir?.();
    if (!dir) return null;
    try { mkdirSync(dir, { recursive: true }); return dir; } catch (e) {
      this.d.log?.("warn", `can't create the no-project folder ${dir}: ${String((e as Error)?.message ?? e)}`);
      return null;
    }
  }

  /** A delegated code-writing specialist in a git project gets its own worktree and branch; anyone else works in the project folder. */
  /** A delegate `folder`: absolute, ~/…, or relative to the project. It must exist. */
  private resolveFolder(folder: string, projectPath: string | null): string {
    const f = folder.replace(/^["']|["']$/g, "");
    const dir = /^~([\\/]|$)/.test(f) ? join(this.d.homeDir, f.slice(1)) : isAbsolute(f) ? f : resolvePath(projectPath ?? this.noProjectDir() ?? this.d.homeDir, f);
    let ok = false;
    try { ok = statSync(dir).isDirectory(); } catch { /* missing */ }
    if (!ok) throw new Error(`folder not found: ${dir}`);
    return dir;
  }

  private async prepareWorktree(l: Live, projectPath: string | null, chatId: string, threadRoot: string | null): Promise<void> {
    l.worktree = null;
    if (l.folder) return; // started in a folder of its own: it works right there
    if (!projectPath || l.depth === 0 || !l.role.isolate || !this.d.settings().agents.isolateWriters) return;
    if (!(await canIsolate(projectPath, this.git))) return;
    const short = l.agentId.slice(0, 8);
    const branch = `flash/${l.role.name}-${short}`;
    const dir = projectWorktreeDir(projectPath, short); // <project>/.wt/<id>, git-ignored by its own .gitignore
    const r = await createWorktree(projectPath, dir, branch, this.git);
    if (!r.ok) {
      this.system(chatId, threadRoot, `⚠️ Couldn't give ${agentLabel(l, l.role.title)} its own copy of the project (${r.message.split("\n")[0]}); it works in the project folder.`, "warn");
      return;
    }
    l.worktree = dir;
    l.branch = branch;
    this.emitAgent(this.d.db.setAgentWorktree(l.agentId, dir, branch));
    this.flow(l.agentId, { kind: "status", label: `working on branch ${branch}`, status: "isolated" });
    this.system(chatId, threadRoot, `🌿 **${l.role.icon} ${agentLabel(l, l.role.title)}** works in its own copy of the project on branch \`${branch}\`, `
      + "so parallel agents don't overwrite each other. Review, merge or discard it from the Review page when it's done.");
  }

  /** `read`: looking at the changes is fine while the agent works; merging and discarding are not. */
  private agentWork(agentId: string, read = false): { repo: string; dir: string; branch: string } {
    const a = this.d.db.getAgent(agentId);
    if (!a?.worktree || !a.branch) throw new Error("this agent has no separate copy of the project");
    const p = a.projectId ? this.d.db.getProject(a.projectId) : null;
    if (!p) throw new Error("the agent's project was removed");
    if (!read && this.byAgent.get(agentId)?.busy) throw new Error("the agent is still working; wait for it to finish or stop it first");
    return { repo: p.path, dir: a.worktree, branch: a.branch };
  }

  /** Review page: every file the agent changed in its copy (committed or not) since its branch started. */
  async workChanges(agentId: string) {
    const w = this.agentWork(agentId, true);
    const [ch, st] = await Promise.all([worktreeChanges(w.repo, w.dir, w.branch, this.git), worktreeState(w.repo, w.dir, w.branch, this.git)]);
    return { ...ch, ...st, branch: w.branch, dir: w.dir, busy: !!this.byAgent.get(agentId)?.busy };
  }

  async workFileDiff(agentId: string, path: string) {
    const w = this.agentWork(agentId, true);
    return worktreeFileDiff(w.repo, w.dir, w.branch, path, this.git);
  }

  /**
   * Send the user's review comments to the agent as a message in its chat; it fixes them in its own copy. An agent whose
   * session ended (finished, or the app restarted) is brought back with its brief and worktree. While it works the
   * request waits in its queue.
   */
  async requestWorkFixes(agentId: string, comments: ReviewComment[], note = ""): Promise<Message> {
    const w = this.agentWork(agentId, true);
    const content = buildFixRequest(w.branch, comments, note);
    const a = this.d.db.getAgent(agentId)!;
    const chat = a.chatId ? this.d.db.getChat(a.chatId) : null;
    if (!chat) throw new Error("the agent's chat was deleted");
    let l = this.byAgent.get(agentId);
    if (!l) {
      l = this.reviveLive(a, chat);
      this.emitAgent(this.d.db.updateAgent(agentId, { status: "idle", ended: false, lastActivity: "Fixing review comments" }));
    }
    const msg = this.d.db.addMessage({ chatId: chat.id, parentId: l.threadRoot, author: "user", content, delivery: l.busy || l.paused ? "queued" : undefined });
    this.d.emit({ type: "message.created", message: msg });
    this.flow(agentId, { kind: "status", label: `review: ${comments.length} comment(s) to fix`, status: "review" });
    const fresh = !l.session?.alive;
    void this.turn({ chat, threadRoot: l.threadRoot, role: l.role, input: content, skills: [], depth: l.depth, brief: fresh && a.parentAgentId ? a.brief : null,
      liveKey: l.key, msgIds: [msg.id] }).catch((e) => this.system(chat.id, l.threadRoot, `⚠️ ${String(e?.message ?? e)}`, "error"));
    return msg;
  }

  async workState(agentId: string) {
    const w = this.agentWork(agentId);
    return { ...(await worktreeState(w.repo, w.dir, w.branch, this.git)), branch: w.branch, dir: w.dir };
  }

  // ------------------------------------------------------------------ checks before merge

  private checksRunning = new Set<string>();

  /** The checks for an agent's project (.flashmaster/checks.json in the project, else Settings → Checks). */
  private checksConfig(repo: string | null): ChecksConfig {
    const s = this.d.settings();
    if (!s.checks?.enabled) return { checks: [], source: "none" };
    return loadChecks(repo, s.checks.commands ?? "");
  }

  /** The branch's current commit and whether the worktree has uncommitted changes. */
  private async worktreeHead(dir: string): Promise<{ head: string | null; dirty: boolean }> {
    const [h, st] = await Promise.all([this.git(dir, ["rev-parse", "HEAD"]), this.git(dir, ["status", "--porcelain"])]);
    return { head: h.code === 0 ? h.out.trim() || null : null, dirty: st.code === 0 && st.out.trim().length > 0 };
  }

  /** What the Merge button shows: configured checks, the last run and whether it covers the current commit. */
  async agentChecks(agentId: string): Promise<AgentChecks> {
    const w = this.agentWork(agentId, true);
    const cfg = this.checksConfig(w.repo);
    const last = this.d.db.getCheckRun(agentId);
    const now = last ? await this.worktreeHead(w.dir) : null;
    return { configured: cfg.checks.map((c) => ({ name: c.name, command: c.command })), source: cfg.source, ...(cfg.error ? { error: cfg.error } : {}), last,
      current: !!last && !!now && last.ok && !last.dirty && !now.dirty && last.head === now.head, running: this.checksRunning.has(agentId),
      requireForMerge: !!this.d.settings().checks?.requireForMerge };
  }

  /** Run the project's checks in an agent's worktree now (Run checks button, Merge, or when the agent finishes). Null = none set up. */
  async runAgentChecks(agentId: string, fromTurn = false): Promise<CheckRun | null> {
    const w = this.agentWork(agentId, fromTurn);
    const cfg = this.checksConfig(w.repo);
    if (cfg.error) throw new Error(cfg.error);
    if (!cfg.checks.length) return null;
    if (this.checksRunning.has(agentId)) throw new Error("the checks are already running for this agent");
    this.checksRunning.add(agentId);
    this.d.emit({ type: "checks.updated", agentId });
    try {
      const { head, dirty } = await this.worktreeHead(w.dir);
      const lc = this.byAgent.get(agentId);
      const span = lc?.traceId ? this.d.traces?.start({ traceId: lc.traceId, parentId: lc.delegateSpan ?? null, agentId, chatId: lc.chatId, kind: "checks",
        name: `checks: ${cfg.checks.map((c) => c.name).join(", ").slice(0, 100)}`, attrs: { "flash.checks.count": cfg.checks.length } }) : undefined;
      const run = await runChecks(w.dir, cfg.checks, { runner: this.d.checkRunner, defaultTimeoutMinutes: this.d.settings().checks?.timeoutMinutes || 15, head, dirty,
        env: networkEnv(this.d.settings()),
        onProgress: (c, i) => {
          this.flow(agentId, { kind: "status", label: `checks ${i + 1}/${cfg.checks.length}: ${c.name}`, status: "checking" });
          this.emitAgent(this.d.db.updateAgent(agentId, { lastActivity: `🧪 Checks ${i + 1}/${cfg.checks.length}: ${c.name}` }));
        } });
      this.d.db.saveCheckRun(agentId, run);
      this.d.traces?.end(span, { status: run.ok ? "ok" : "error", attrs: { "flash.checks.failed": run.results.filter((r) => !r.ok).length } });
      this.emitAgent(this.d.db.updateAgent(agentId, { lastActivity: checksLine(run) }));
      this.flow(agentId, { kind: "status", label: checksLine(run), status: run.ok ? "checks passed" : "checks failed" });
      if (this.hooks.has("checks_done")) {
        const a = this.d.db.getAgent(agentId);
        void this.hooks.fire({ event: "checks_done", agentId, agent: a?.name ?? a?.role, role: a?.role, cwd: w.dir, ok: run.ok, result: checksLine(run) }).catch(() => {});
      }
      return run;
    } finally {
      this.checksRunning.delete(agentId);
      this.d.emit({ type: "checks.updated", agentId });
    }
  }

  /** After a code-writing specialist's turn: run the checks when its branch holds new work. Null = nothing to check. */
  private async autoChecks(live: Live): Promise<CheckRun | null> {
    const s = this.d.settings();
    if (!s.checks?.enabled || !s.checks.autoRun || !live.worktree || !live.branch) return null;
    const a = this.d.db.getAgent(live.agentId);
    if (!a?.worktree) return null;
    try {
      const w = this.agentWork(live.agentId, true);
      if (!this.checksConfig(w.repo).checks.length) return null;
      const st = await worktreeState(w.repo, w.dir, w.branch, this.git);
      if (!st.unmerged && !st.dirty.length) return null;
      this.setStatus(live, "running", "🧪 Running the project's checks");
      const run = await this.runAgentChecks(live.agentId, true);
      if (run) this.emitAgent(this.d.db.updateAgent(live.agentId, { status: "idle" }));
      return run;
    } catch (e) {
      this.flow(live.agentId, { kind: "error", label: `checks: ${String((e as Error)?.message ?? e).slice(0, 150)}` });
      return null;
    }
  }

  /**
   * Merge an agent's branch into the project's current branch (user action). With checks set up and "Merge only when
   * checks pass" on, the branch's current commit must have a green run; a missing or stale run is started first.
   * `force` = the user chose "Merge anyway".
   */
  async mergeWork(agentId: string, force = false): Promise<WorkResult> {
    const w = this.agentWork(agentId);
    if (!force && this.d.settings().checks?.requireForMerge) {
      const st = await this.agentChecks(agentId);
      if (st.error) return { ok: false, message: `Checks are set up wrongly: ${st.error}. Fix it, or merge anyway.` };
      if (st.configured.length && !st.current) {
        const run = await this.runAgentChecks(agentId);
        if (run && !run.ok) {
          const msg = `Not merged: ${checksLine(run)}. Send it back to the agent, or merge anyway.`;
          this.flow(agentId, { kind: "status", label: msg.slice(0, 160), status: "merge refused" });
          return { ok: false, message: msg };
        }
      }
    }
    const r = await mergeWorktree(w.repo, w.dir, w.branch, this.git);
    this.flow(agentId, { kind: "status", label: r.message.slice(0, 160), status: r.ok ? "merged" : "merge refused" });
    return r;
  }

  /** Remove an agent's worktree and branch. Refuses while it holds unmerged or uncommitted work, unless `force` (user confirmed). */
  async discardWork(agentId: string, force = false): Promise<WorkResult> {
    const w = this.agentWork(agentId);
    const r = await removeWorktree(w.repo, w.dir, w.branch, force, this.git);
    if (r.ok) {
      const l = this.byAgent.get(agentId);
      if (l) { l.session?.close(); l.session = null; l.worktree = undefined; l.branch = null; }
      this.emitAgent(this.d.db.setAgentWorktree(agentId, null, null));
    }
    this.flow(agentId, { kind: "status", label: r.message.slice(0, 160), status: r.ok ? "copy removed" : "kept" });
    return r;
  }

  /**
   * Stuck-agent watchdog, called every 30 s by the app. A working agent that has sent nothing for
   * `agents.stuckAfterMinutes` gets one warning in its chat, its progress flow and a notice; it keeps running, and
   * the warning clears as soon as output resumes. Agents waiting for an approval or for a busy specialist are not stuck.
   */
  checkStuck(now = Date.now()): string[] {
    const mins = this.d.settings().agents.stuckAfterMinutes;
    if (!mins || mins <= 0) return [];
    const flagged: string[] = [];
    for (const l of this.live.values()) {
      if (!l.busy || l.paused || l.stopped || l.awaitingApproval || l.stuckSince || !l.currentMessageId || !l.lastOutputAt) continue;
      if (now - l.lastOutputAt < mins * 60_000) continue;
      // Its process says it is alive and working (GitLab Duo thinks for minutes without a word): busy, not stuck.
      if (this.alive(l, now)) { this.showQuietAlive(l, now); continue; }
      const waitingOnSpecialist = [...this.live.values()].some((c) => c.busy && c.key.startsWith(`${l.agentId}>`));
      if (waitingOnSpecialist) continue;
      l.stuckSince = now;
      const quiet = Math.round((now - l.lastOutputAt) / 60_000);
      this.setStatus(l, "running", `⏳ No output for ${quiet} min: may be stuck`);
      this.flow(l.agentId, { kind: "status", label: `no output for ${quiet} min`, status: "stuck" });
      this.system(l.chatId, l.threadRoot, `⏳ **${l.role.icon} ${agentLabel(l, l.role.title)}** has sent nothing for ${quiet} min. `
        + "It is still running: keep waiting, send a message to steer it, or stop it.", "warn");
      flagged.push(l.agentId);
    }
    // A delegated specialist still silent a whole period after the warning is recovered: told to deliver what it has
    // (its turn is cancelled and continues with that), and past the recovery cap stopped and reported as failed.
    for (const l of this.live.values()) {
      if (!l.busy || !l.stuckSince || l.paused || l.stopped || l.awaitingApproval || !l.delegated || l.depth === 0 || !l.currentMessageId) continue;
      if (now - l.stuckSince < mins * 60_000 || l.redirect || this.alive(l, now)) continue;
      // A long build or test run is a running tool call, not silence: the tool call timeout handles those.
      if ([...(l.tools?.values() ?? [])].some((r) => r.status !== "completed" && r.status !== "failed")) continue;
      if ([...this.live.values()].some((c) => c.busy && c.parentAgentId === l.agentId)) continue;
      this.recoverStall(l, now);
      flagged.push(l.agentId);
    }
    return flagged;
  }

  /** The harness reported recently that the agent's process is alive and working. */
  private alive(l: Live, now = Date.now()): boolean {
    return !!l.heartbeatAt && now - l.heartbeatAt < ALIVE_WINDOW_MS && (!l.turnStartedAt || l.heartbeatAt >= l.turnStartedAt);
  }

  private showQuietAlive(l: Live, now: number): void {
    const quiet = Math.round((now - (l.lastOutputAt ?? now)) / 60_000);
    if (l.quietShown === quiet) return;
    l.quietShown = quiet;
    const said = l.statusNote ? `: last status "${l.statusNote.text.slice(0, 100)}"` : "";
    this.setStatus(l, "running", `⚙️ Working, quiet for ${quiet} min (process alive)${said}`);
  }

  private recoverStall(l: Live, now: number): void {
    const quiet = Math.round((now - (l.lastOutputAt ?? now)) / 60_000);
    const cap = Math.max(0, this.d.settings().agents.recoveryAttempts ?? 2);
    const n = (l.recoveries ?? 0) + 1;
    const who = `${l.role.icon} ${agentLabel(l, l.role.title)}`;
    l.stuckSince = now;
    if (n > cap) {
      l.stallGiveUp = `it sent nothing for ${quiet} min`;
      this.flow(l.agentId, { kind: "status", label: `silent for ${quiet} min: stopping it`, status: "stuck" });
    } else {
      l.recoveries = n;
      l.redirect = { input: STALL_NUDGE(quiet), attachments: [], msgIds: [], nudge: true };
      this.flow(l.agentId, { kind: "status", label: `silent for ${quiet} min: told to deliver (${n}/${cap})`, status: "retry" });
      this.system(l.chatId, l.threadRoot, `↻ **${who}** sent nothing for ${quiet} min, so TheFlashMaster interrupted it and asked it to deliver what it has (recovery ${n} of ${cap}).`);
    }
    const session = l.session;
    const messageId = l.currentMessageId;
    void session?.cancel();
    // An agent that ignores the cancel is restarted; its turn resumes the session (or fails, and is recovered like a crash).
    const t = setTimeout(() => {
      if (l.busy && !l.stopped && l.session === session && session?.alive && l.currentMessageId === messageId) session.close();
    }, this.toolStopGraceMs);
    (t as { unref?: () => void }).unref?.();
  }

  /**
   * Stop one hung tool call of a running reply. ACP has no per-call cancel, so the turn is cancelled (the agent ends the
   * call and keeps its session) and the next turn starts at once, telling the agent the call was stopped so it carries on
   * without it. An agent that ignores the cancel for `toolStopGraceMs` is restarted and resumed, like after a crash.
   */
  async stopToolCall(messageId: string, toolId: string, reason: "user" | "timeout" = "user", now = Date.now()): Promise<void> {
    const l = [...this.live.values()].find((x) => x.busy && x.currentMessageId === messageId);
    if (!l) throw new Error("That reply has finished; there is nothing left to stop.");
    const entry = [...(l.tools?.entries() ?? [])].find(([, r]) => r.id === toolId);
    if (!entry) throw new Error("That tool call is not part of the running reply.");
    const [key, run] = entry;
    if (run.status === "completed" || run.status === "failed") return;
    const mins = Math.max(1, Math.round((now - run.startedAt) / 60_000));
    const why = reason === "timeout" ? `Stopped after ${mins} min (tool call timeout)` : "Stopped by you";
    l.tools!.set(key, { ...run, status: "failed", stopped: why, endedAt: now });
    this.flushTools(l, messageId, l.chatId);
    const what = `"${run.title}"${run.input ? ` (${run.input.trim().slice(0, 300)})` : ""}`;
    const input = (reason === "timeout"
      ? `Your tool call ${what} ran for ${mins} min without finishing, so TheFlashMaster stopped it (tool call timeout).`
      : `The user stopped your tool call ${what}: it hung, waiting without finishing.`)
      + " Don't run it again the same way, it would hang again. Continue the task without it, or use a way that can't block"
      + " (a timeout, running it in the background, no interactive prompts), and say briefly what you did instead.";
    l.redirect = l.redirect && !l.redirect.toolStop
      ? { input: `${input}\n\nThe user also says:\n${l.redirect.input}`, attachments: l.redirect.attachments, msgIds: l.redirect.msgIds, toolStop: run.title }
      : { input: l.redirect ? `${l.redirect.input}\n\n${input}` : input, attachments: l.redirect?.attachments ?? [], msgIds: l.redirect?.msgIds ?? [], toolStop: run.title };
    this.flow(l.agentId, { kind: "tool", label: `${why.toLowerCase()}: ${run.title}`.slice(0, 160), status: "stopped" });
    this.setStatus(l, "running", `⏹ Stopped ${run.title} — continuing without it…`);
    const session = l.session;
    await session?.cancel();
    // Some agents keep waiting on a hung tool even after a cancel: restart the CLI; the turn resumes its session.
    const t = setTimeout(() => {
      if (!l.busy || l.stopped || l.session !== session || !session?.alive || l.currentMessageId !== messageId || !l.redirect?.toolStop) return;
      this.d.log?.("warn", `${l.role.name} ignored the cancel of a hung tool call; restarting its harness`);
      this.flow(l.agentId, { kind: "status", label: "agent kept waiting — restarting it", status: "retry" });
      session.close();
    }, this.toolStopGraceMs);
    (t as { unref?: () => void }).unref?.();
  }

  /** How long an agent may keep waiting on a stopped tool call before its CLI is restarted. */
  toolStopGraceMs = 15_000;

  /**
   * Tool call timeout, called every 30 s by the app: a single tool call running longer than `agents.toolTimeoutMinutes`
   * is stopped as if the user pressed ■ on it. Calls waiting for an approval or for a busy specialist are left alone.
   */
  checkToolTimeouts(now = Date.now()): string[] {
    const mins = this.d.settings().agents.toolTimeoutMinutes;
    if (!mins || mins <= 0) return [];
    const stopped: string[] = [];
    for (const l of this.live.values()) {
      if (!l.busy || l.paused || l.stopped || l.awaitingApproval || l.redirect?.toolStop || !l.currentMessageId || !l.tools?.size) continue;
      if ([...this.live.values()].some((c) => c.busy && c.key.startsWith(`${l.agentId}>`))) continue;
      const run = [...l.tools.values()].find((r) => (r.status === "pending" || r.status === "in_progress") && r.kind !== "think" && now - r.startedAt >= mins * 60_000);
      if (!run) continue;
      stopped.push(run.id);
      void this.stopToolCall(l.currentMessageId, run.id, "timeout", now).catch(() => undefined);
    }
    return stopped;
  }

  /**
   * Idle-specialist cleanup, called every minute by the app. A delegated specialist that finished and has been idle for
   * `agents.closeIdleAfterMinutes` is closed: its CLI process ends and it leaves the agent chips (it stays in the Agents
   * page history). Never closed: the coordinator or any agent the user opened directly, a working, paused or queued agent,
   * one whose own specialists still run, and one whose worktree holds uncommitted changes or unmerged commits (it waits
   * for review). A clean, merged worktree is removed with it.
   */
  async closeIdle(now = Date.now()): Promise<string[]> {
    const mins = this.d.settings().agents.closeIdleAfterMinutes;
    if (!mins || mins <= 0) return [];
    const closed: string[] = [];
    for (const l of [...this.live.values()]) {
      if (l.busy || l.paused || l.stopped || l.closing || l.awaitingApproval || l.queue.length || l.redirect || !l.idleSince) continue;
      if (now - l.idleSince < mins * 60_000) continue;
      const a = this.d.db.getAgent(l.agentId);
      if (!a?.parentAgentId) continue; // coordinator / directly-opened chats stay
      if ([...this.live.values()].some((c) => c !== l && c.key.startsWith(`${l.agentId}>`) && (c.busy || c.paused || c.queue.length))) continue;
      l.closing = true;
      try {
        const w = l.worktree && l.branch ? { dir: l.worktree, branch: l.branch } : a.worktree && a.branch ? { dir: a.worktree, branch: a.branch } : null;
        const repo = a.projectId ? this.d.db.getProject(a.projectId)?.path ?? null : null;
        if (w && repo) {
          const st = await worktreeState(repo, w.dir, w.branch, this.git);
          if (st.dirty.length || st.unmerged) continue; // work waiting for review: keep the agent
          const r = await removeWorktree(repo, w.dir, w.branch, false, this.git);
          if (!r.ok) continue;
          this.d.db.setAgentWorktree(l.agentId, null, null);
        }
        // Re-check: a message may have reached it while git ran.
        if (l.busy || l.queue.length || l.stopped || this.byAgent.get(l.agentId) !== l) continue;
        const idle = Math.round((now - l.idleSince) / 60_000);
        l.session?.close();
        l.session = null;
        this.live.delete(l.key);
        this.byAgent.delete(l.agentId);
        this.flow(l.agentId, { kind: "status", label: `closed after ${idle} min idle`, status: "closed" });
        this.emitAgent(this.d.db.updateAgent(l.agentId, { status: "done", ended: true, lastActivity: `${IDLE_CLOSED} ${idle} min idle` }));
        closed.push(l.agentId);
      } catch (e: any) {
        this.d.log?.("warn", `closing idle agent ${l.agentId} failed: ${String(e?.message ?? e)}`);
      } finally {
        l.closing = false;
      }
    }
    return closed;
  }

  /**
   * Close one agent on behalf of another (the `close_agent` tool, used by Flash Master to clean up). Only specialists of
   * the caller's project, never the caller itself, one of its parents, or a chat's own agent. Without `force`, an agent
   * that is working, paused, queued, waiting for approval or has working specialists stays, and so does one whose
   * worktree holds uncommitted changes or unmerged commits. With `force`, a working agent is stopped; a worktree with
   * work in it is always kept (only a clean, merged one is removed), so closing never throws work away.
   */
  async closeAgent(callerId: string, agentId: string, opts: { force?: boolean } = {}): Promise<CloseResult> {
    const a = this.d.db.getAgent(agentId);
    const caller = this.d.db.getAgent(callerId);
    if (!a || !caller || a.projectId !== caller.projectId) throw new Error("unknown agentId: use an id from list_agents (this project only)");
    const label = agentLabel(a, this.d.roles().find((r) => r.name === a.role)?.title ?? a.role);
    const keep = (reason: string): CloseResult => ({ agentId, name: label, closed: false, reason });
    if (agentId === callerId) return keep("that is you");
    for (let p = caller.parentAgentId, n = 0; p && n < 20; p = this.d.db.getAgent(p)?.parentAgentId ?? null, n++)
      if (p === agentId) return keep("it is one of your parent agents");
    if (!a.parentAgentId) return keep("it is a chat's own agent; the user closes it");
    // A specialist may only close the specialists it started (directly or below them); a chat's agent any in the project.
    if (caller.parentAgentId) {
      let p: string | null = a.parentAgentId;
      for (let n = 0; p && p !== callerId && n < 20; n++) p = this.d.db.getAgent(p)?.parentAgentId ?? null;
      if (p !== callerId) return keep("you did not start it");
    }
    const l = this.byAgent.get(agentId);
    const active = ["idle", "running", "paused", "interrupted"].includes(a.status) && a.endedAt == null;
    if (!l && !active) return keep(`already ${a.status}`);
    if (l?.closing) return keep("it is being closed already");
    const force = !!opts.force;
    if (!force && l) {
      if (l.busy) return keep("it is working (pass force: true only if the user asked to stop it)");
      if (l.paused) return keep("it is paused");
      if (l.awaitingApproval) return keep("it is waiting for the user's approval");
      if (l.queue.length || l.redirect) return keep("it has messages queued");
      if ([...this.live.values()].some((c) => c !== l && c.key.startsWith(`${agentId}>`) && (c.busy || c.paused || c.queue.length)))
        return keep("its own specialists are still working");
    }
    if (!force && !l && a.status === "running") return keep("it is working");
    if (l) l.closing = true;
    try {
      let worktree: CloseResult["worktree"];
      const w = l?.worktree && l.branch ? { dir: l.worktree, branch: l.branch } : a.worktree && a.branch ? { dir: a.worktree, branch: a.branch } : null;
      const repo = a.projectId ? this.d.db.getProject(a.projectId)?.path ?? null : null;
      if (w && repo) {
        const st = await worktreeState(repo, w.dir, w.branch, this.git);
        if (st.dirty.length || st.unmerged) {
          const what = [st.unmerged ? `${st.unmerged} unmerged commit(s)` : "", st.dirty.length ? `${st.dirty.length} uncommitted change(s)` : ""].filter(Boolean).join(" and ");
          if (!force) return keep(`its worktree (branch ${w.branch}) holds ${what} waiting for review; merge or discard it first`);
          worktree = `kept: branch ${w.branch} holds ${what}`;
        } else {
          const r = await removeWorktree(repo, w.dir, w.branch, false, this.git);
          if (r.ok) { this.d.db.setAgentWorktree(agentId, null, null); worktree = "removed (clean)"; } else worktree = `kept: ${r.message}`;
        }
      }
      // Re-check: a message may have reached it while git ran.
      if (l && !force && (l.busy || l.queue.length || l.stopped || this.byAgent.get(agentId) !== l)) return keep("it got new work meanwhile");
      const by = this.byAgent.get(callerId);
      const why = `Closed by ${by ? agentLabel(by, by.role.title) : caller.role}`;
      if (l) {
        l.queue = [];
        l.stopped = true;
        if (l.busy) await l.session?.cancel();
        l.session?.close();
        l.session = null;
        this.live.delete(l.key);
        this.byAgent.delete(agentId);
        this.finishWaiters(l, `closed by ${caller.role}`);
        this.flow(agentId, { kind: "status", label: why.toLowerCase(), status: "closed" });
      }
      this.emitAgent(this.d.db.updateAgent(agentId, { status: "done", ended: true, lastActivity: why }));
      return { agentId, name: label, closed: true, ...(worktree ? { worktree } : {}) };
    } finally {
      if (l) l.closing = false;
    }
  }

  /** Close every specialist of the caller's project that can be closed safely now (the `close_idle_agents` tool). */
  async closeIdleAgents(callerId: string): Promise<{ closed: CloseResult[]; kept: CloseResult[] }> {
    const projectId = this.agentProject(callerId);
    const ids = new Set(this.d.db.listAgents({ projectId, activeOnly: true }).filter((x) => x.parentAgentId).map((x) => x.id));
    for (const l of this.live.values()) if (this.d.db.getAgent(l.agentId)?.projectId === projectId && l.agentId !== callerId) ids.add(l.agentId);
    const closed: CloseResult[] = [], kept: CloseResult[] = [];
    for (const id of ids) {
      if (id === callerId) continue;
      const r = await this.closeAgent(callerId, id).catch((e): CloseResult => ({ agentId: id, name: id, closed: false, reason: String(e?.message ?? e) }));
      (r.closed ? closed : kept).push(r);
    }
    // A chat's own agents and the caller's parents are not candidates; leave them out of the report.
    return { closed, kept: kept.filter((k) => !/chat's own agent|parent agents|that is you/.test(k.reason ?? "")) };
  }

  private noteOutput(l: Live): void {
    l.lastOutputAt = Date.now();
    l.quietShown = undefined;
    if (!l.stuckSince) return;
    const quiet = Math.round((l.lastOutputAt - l.stuckSince) / 60_000);
    l.stuckSince = null;
    this.flow(l.agentId, { kind: "status", label: "output resumed", status: "running" });
    this.setStatus(l, "running", quiet > 0 ? "Working again after a long silence" : "Working again");
  }

  /** After a restart: tell each affected chat which agents were interrupted and that they can be resumed. */
  announceInterrupted(agents: AgentRun[]): void {
    const byChat = new Map<string, AgentRun[]>();
    for (const a of agents) if (a.chatId) byChat.set(a.chatId, [...(byChat.get(a.chatId) ?? []), a]);
    for (const [chatId, list] of byChat) {
      if (!this.d.db.getChat(chatId)) continue;
      const names = list.map((a) => { const r = this.d.roles().find((x) => x.name === a.role); return r ? `${r.icon} ${agentLabel(a, r.title)}` : agentLabel(a, a.role); });
      this.system(chatId, null, `⏸ The app closed while ${names.join(", ")} ${list.length === 1 ? "was" : "were"} working. `
        + "Resume from the agent chip above the composer or from the Agents page; nothing was lost.", "warn");
    }
  }

  /**
   * Resume an agent the app interrupted by closing. Its harness session is gone, so it starts a fresh one with its
   * original brief and a note to check what is already done before continuing.
   */
  resumeInterrupted(agentId: string): AgentRun {
    const a = this.d.db.getAgent(agentId);
    if (!a || a.status !== "interrupted") throw new Error("this agent isn't waiting to be resumed");
    const chat = a.chatId ? this.d.db.getChat(a.chatId) : null;
    if (!chat) { this.emitAgent(this.d.db.updateAgent(agentId, { status: "stopped" })); throw new Error("its chat was deleted"); }
    let l: Live;
    try { l = this.reviveLive(a, chat); } catch (e) {
      this.emitAgent(this.d.db.updateAgent(agentId, { status: "stopped", lastActivity: "Superseded: the same agent is already running again" }));
      throw e;
    }
    const { role, depth, threadRoot, key } = l;
    this.emitAgent(this.d.db.updateAgent(agentId, { status: "idle", ended: false, lastActivity: "Resuming after the app restarted" }));
    this.flow(agentId, { kind: "status", label: "resumed after restart", status: "running" });
    const kids = this.d.db.childAgents(agentId).filter((c) => c.status !== "stopped");
    const input = [
      "The app was closed while you were working on this, and it has just been reopened. Your earlier session is gone.",
      "Check what is already done (files, the task board, your specialists' results) and continue where you left off. Don't redo finished work.",
      kids.length ? `Specialists you started earlier (use get_result with these ids instead of delegating again): ${kids.map((c) => `${agentLabel(c, c.role)} ${c.id} (${c.status})`).join("; ")}.` : "",
    ].filter(Boolean).join("\n");
    void this.turn({ chat, threadRoot, role, input, skills: [], depth, brief: a.parentAgentId ? a.brief : null, liveKey: key })
      .catch((e) => this.system(chat.id, threadRoot, `⚠️ ${String(e?.message ?? e)}`, "error"));
    return this.d.db.getAgent(agentId)!;
  }

  /** Rebuild the in-memory state of an agent whose session is gone (app restart), keeping its chat, thread and worktree. */
  private reviveLive(a: AgentRun, chat: Chat): Live {
    const role = this.role(a.role);
    let depth = 0;
    for (let p = a.parentAgentId; p && depth < 10; p = this.d.db.getAgent(p)?.parentAgentId ?? null) depth++;
    const threadRoot = this.d.db.lastThreadOf(a.id);
    const key = a.parentAgentId ? `${a.parentAgentId}>${role.name}#${a.id}` : `${chat.id}|${threadRoot ?? "main"}|${role.name}`;
    if (this.live.has(key) || this.byAgent.has(a.id)) throw new Error(`${role.title} is already running again in this chat`);
    const harness = this.d.harnesses.resolve(a.harness, this.d.settings());
    // A local-only agent comes back on its local harness or not at all (never on the default, possibly hosted, one).
    if (role.local && (harness !== a.harness || !isLocalHarness(harness)))
      throw new Error(`${role.title} must run on a local model, but ${a.harness} is not available (Settings → Harnesses)`);
    const l: Live = { key, agentId: a.id, name: a.name, chatId: chat.id, threadRoot, role, harness, model: a.model, session: null, sessionTokens: 0, busy: false,
      paused: false, queue: [], depth, currentMessageId: null, waiters: [], lastResult: a.resultSummary, stopped: false, sink: null, redirect: null, awaiting: [],
      worktree: a.worktree, branch: a.branch, folder: a.folder ?? null, launchArgs: a.launchArgs ?? null, parentAgentId: a.parentAgentId ?? null,
      local: role.local ? { source: "role" } : null };
    this.live.set(key, l);
    this.byAgent.set(a.id, l);
    return l;
  }

  /** Resume every interrupted agent, specialists before the agents that delegated to them. */
  resumeAllInterrupted(): number {
    const list = this.d.db.listInterrupted();
    const depthOf = (a: AgentRun) => { let d = 0; for (let p = a.parentAgentId; p && d < 10; p = this.d.db.getAgent(p)?.parentAgentId ?? null) d++; return d; };
    let n = 0;
    for (const a of list.sort((x, y) => depthOf(y) - depthOf(x))) {
      try { this.resumeInterrupted(a.id); n++; } catch { /* superseded or chat deleted: already marked stopped */ }
    }
    return n;
  }

  /** Nothing in this chat is working or about to: no busy or queued agent and no results waiting to wake a coordinator. */
  chatSettled(chatId: string): boolean {
    for (const l of this.live.values()) {
      if (l.chatId !== chatId) continue;
      if (l.busy || l.queue.length || l.redirect || this.reports.has(l.agentId) || (l.textWaiting ?? 0) > 0) return false;
    }
    return true;
  }

  /** The chat's coordinator (depth 0): its agent id and the trace of its current request. */
  chatCoordinator(chatId: string): { agentId: string; traceId: string | null } | null {
    for (const l of this.live.values()) if (l.chatId === chatId && l.depth === 0 && !l.parentAgentId) return { agentId: l.agentId, traceId: l.traceId ?? null };
    return null;
  }

  async stopChat(chatId: string): Promise<void> {
    for (const l of [...this.live.values()]) if (l.chatId === chatId) await this.stop(l.agentId);
  }

  async stopAll(): Promise<void> {
    for (const l of [...this.live.values()]) await this.stop(l.agentId);
  }

  /**
   * Steering: harnesses with native support (Pi) receive the message inside the running turn. For the others
   * (ACP agents, GitLab Duo, mock) the current turn is interrupted at a safe point and the next turn starts at once
   * with the new direction — the session keeps its history, so no work is lost.
   */
  private async steer(l: Live, text: string, attachments: Attachment[], msgId: string): Promise<void> {
    if (!attachments.length && l.session?.steer && (await l.session.steer(text).catch(() => false))) {
      this.flow(l.agentId, { kind: "status", label: `steered: ${text.slice(0, 120)}`, status: "steer" });
      this.setStatus(l, "running", "Steering message delivered");
      this.markDelivered(l, [msgId], true);
      return;
    }
    l.redirect = l.redirect ? { ...l.redirect, input: `${l.redirect.input}\n${l.redirect.toolStop || l.redirect.nudge ? `\nThe user also says:\n` : ""}${text}`, attachments: [...l.redirect.attachments, ...attachments], msgIds: [...l.redirect.msgIds, msgId] }
      : { input: text, attachments, msgIds: [msgId] };
    this.flow(l.agentId, { kind: "status", label: `redirected: ${text.slice(0, 120)}`, status: "steer" });
    this.setStatus(l, "running", "Redirecting with your steering message…");
    await l.session?.cancel();
  }

  /** Drive mode / harness / model changed: idle sessions of the chat restart on the next message with the new setup. */
  resetChatSessions(chatId: string): void {
    for (const l of [...this.live.values()]) {
      if (l.chatId !== chatId || l.busy) continue;
      l.session?.close();
      this.live.delete(l.key);
      this.byAgent.delete(l.agentId);
      this.emitAgent(this.d.db.updateAgent(l.agentId, { status: "done", ended: true, lastActivity: "Restarted for new mode/model" }));
    }
  }

  /**
   * Reset context: every agent session of the chat is closed and forgotten (no resume), the rolling summary is cleared
   * and a boundary is set, so the next turn starts clean. Messages stay visible in the chat; a divider marks the reset.
   */
  resetContext(chatId: string): Message {
    const lives = [...this.live.values()].filter((l) => l.chatId === chatId);
    if (lives.some((l) => l.busy)) throw new Error("An agent is still working in this chat — stop it first, then reset the context.");
    for (const l of lives) {
      l.session?.close();
      this.live.delete(l.key);
      this.byAgent.delete(l.agentId);
      this.emitAgent(this.d.db.updateAgent(l.agentId, { status: "done", ended: true, sessionId: null, lastActivity: "Context reset" }));
    }
    const m = this.d.db.addMessage({ chatId, author: "system", content: "Context reset — agents start fresh from here.", marker: "context-reset" });
    this.d.db.setChatSummary(chatId, "", m.seq);
    this.d.emit({ type: "message.created", message: m });
    return m;
  }

  /** Close and forget the idle agent sessions in `pick`; refuses (throws `busyMsg`) while one of them is working. */
  private closeSessions(pick: (l: Live) => boolean, busyMsg: string, why: string): void {
    const lives = [...this.live.values()].filter(pick);
    if (lives.some((l) => l.busy)) throw new Error(busyMsg);
    for (const l of lives) {
      l.session?.close();
      this.live.delete(l.key);
      this.byAgent.delete(l.agentId);
      this.emitAgent(this.d.db.updateAgent(l.agentId, { status: "done", ended: true, sessionId: null, lastActivity: why }));
    }
  }

  private removeStored(chatId: string, ids: string[]): void {
    for (const id of ids) this.liveText.delete(id);
    const removed = this.d.db.deleteMessages(ids);
    if (removed.length) this.d.emit({ type: "messages.removed", chatId, removed });
  }

  /** Archive (hide) or restore a thread. */
  archiveThread(rootId: string, archived: boolean): Message {
    const m = this.d.db.setThreadArchived(rootId, archived);
    if (!m) throw new Error("That message is gone, or it is a reply (only a thread's first message holds the thread).");
    this.d.emit({ type: "message.updated", message: m });
    return m;
  }

  /**
   * Delete a thread's replies for good; the message it hangs off stays in the chat. The thread's idle agent sessions
   * are closed so a new reply there starts fresh.
   */
  deleteThread(rootId: string): void {
    const root = this.d.db.getMessage(rootId);
    if (!root || root.parentId) throw new Error("That thread is gone.");
    this.closeSessions((l) => l.chatId === root.chatId && l.threadRoot === rootId,
      "An agent is still working in this thread — stop it first, then delete it.", "Thread deleted");
    this.removeStored(root.chatId, this.d.db.threadReplyIds(rootId));
    const m = this.d.db.setThreadArchived(rootId, false);
    if (m) this.d.emit({ type: "message.updated", message: m });
  }

  /**
   * Delete one message (and the thread under it) to clean up a chat. Agents keep what they already read in their
   * session; Reset context or Clear chat makes them forget it too.
   */
  deleteMessage(messageId: string): void {
    const m = this.d.db.getMessage(messageId);
    if (!m) return;
    if (m.status === "streaming") throw new Error("That reply is still being written — stop the agent first, then delete it.");
    if (!m.parentId) this.closeSessions((l) => l.chatId === m.chatId && l.threadRoot === m.id,
      "An agent is still working in this message's thread — stop it first, then delete it.", "Thread deleted");
    this.removeStored(m.chatId, [m.id]);
  }

  /** Delete every message of a chat and start its agents fresh (sessions closed, rolling summary cleared). */
  clearChat(chatId: string): void {
    this.closeSessions((l) => l.chatId === chatId, "An agent is still working in this chat — stop it first, then clear it.", "Chat cleared");
    this.d.db.setChatSummary(chatId, "", 0);
    this.removeStored(chatId, this.d.db.chatMessageIds(chatId));
  }

  /** Steering/queued messages reached the agent; `native` = the harness will confirm when the model sees them. */
  private markDelivered(l: Live, ids: string[], native: boolean): void {
    for (const id of ids) {
      const m = this.d.db.setDelivery(id, "delivered");
      if (m) { this.d.emit({ type: "message.updated", message: m }); l.awaiting.push({ id, native }); }
    }
  }
  /** The model continued with the message in its context. ack = harness confirmation (native steering). */
  private markSeen(l: Live, ack: boolean): void {
    if (!l.awaiting.length) return;
    const take = ack ? l.awaiting.filter((a) => a.native).slice(0, 1) : l.awaiting.filter((a) => !a.native);
    for (const a of take) {
      l.awaiting.splice(l.awaiting.indexOf(a), 1);
      const m = this.d.db.setDelivery(a.id, "seen");
      if (m) this.d.emit({ type: "message.updated", message: m });
    }
  }

  /** A file changed by an agent: one record per path and turn (first old text, latest new text). */
  private recordChange(live: Live, projectPath: string | null, path: string, oldText: string | null, newText: string): void {
    const rel = projectPath && path.toLowerCase().startsWith(projectPath.toLowerCase()) ? path.slice(projectPath.length).replace(/^[\\/]+/, "") : path;
    const turn = (live.turnChanges ??= new Map<string, { id: string; oldText: string | null }>());
    const prev = turn.get(rel);
    const base = prev ? prev.oldText : oldText;
    const d = diffLines(base ?? "", newText, 0);
    if (prev) this.d.db.updateFileChange(prev.id, newText, d.added, d.removed);
    else turn.set(rel, { id: this.d.db.addFileChange({ chatId: live.chatId, agentId: live.agentId, role: live.role.name, path: rel, oldText: base, newText, added: d.added, removed: d.removed }), oldText: base });
    this.flow(live.agentId, { kind: "tool", label: `changed ${rel} (+${d.added} −${d.removed})`, status: "completed" });
    this.d.emit({ type: "artifacts.changed", chatId: live.chatId });
  }

  /** Reactions double as approvals for pending permission requests (✅ allow / ❌ deny). */
  onReaction(messageId: string, emoji: string, reactions: string[]): void {
    const resolve = this.pendingPermissions.get(messageId);
    if (!resolve || !reactions.includes(emoji)) return;
    if (emoji === "✅" || emoji === "👍") { this.pendingPermissions.delete(messageId); resolve(true); }
    if (emoji === "❌" || emoji === "👎") { this.pendingPermissions.delete(messageId); resolve(false); }
  }

  /** Messages as the UI should see them: streaming replies carry their live text, not the last 500 ms flush. */
  withLiveText(messages: Message[]): Message[] {
    return messages.map((m) => (m.status === "streaming" && this.liveText.has(m.id) ? { ...m, content: this.liveText.get(m.id)! } : m));
  }

  activeCount(): number {
    return [...this.live.values()].filter((l) => l.busy).length;
  }

  // ------------------------------------------------------------------ turn engine

  private async turn(t: { chat: Chat; threadRoot: string | null; role: RoleDef; input: string; attachments?: Attachment[]; skills: SkillDef[];
    depth: number; brief: string | null; taskId?: string; liveKey?: string; msgIds?: string[]; deliver?: boolean;
    /** A specialist the coordinator is blocked waiting on runs in the coordinator's slot (else both could wait on each other forever). */
    borrowSlot?: boolean;
    /** Round of text delegation this turn belongs to (results fed back to the coordinator), to stop runaway loops. */
    textRound?: number;
    /** Follow-ups sent because the turn missed a required deliverable (HTML report, diagrams); capped. */
    reportRound?: number;
    /** How many times this task was sent back because its checks failed. */
    checkRound?: number;
    /** The same request again after the harness was switched (the failed reply stays out of the history). */
    retry?: boolean;
    /** Harness / model for a new session (retry with another model); an existing session keeps its own. */
    pick?: { harness: HarnessId; model: string | null } }): Promise<void> {
    const s = this.d.settings();
    const live = t.liveKey ? this.live.get(t.liveKey)! : this.ensureLive(t.chat, t.threadRoot, t.role, t.depth, undefined, undefined, undefined, t.pick);
    if (!live) return;
    const item = { input: t.input, attachments: t.attachments ?? [], msgIds: t.msgIds };
    if (live.paused || live.busy) for (const id of t.msgIds ?? []) { const m = this.d.db.setDelivery(id, "queued"); if (m) this.d.emit({ type: "message.updated", message: m }); }
    if (live.paused) { live.queue.push(item); this.system(t.chat.id, t.threadRoot, `⏸ ${t.role.title} is paused — message queued.`); return; }
    if (live.busy) { live.queue.push(item); return; }

    // Budgets — checked before spending anything.
    const blocked = this.checkBudgets(live, t.chat);
    if (blocked) return;
    // A user's new request to a coordinator starts a new task budget for its whole tree.
    if (live.depth === 0 && !live.parentAgentId && t.msgIds?.length) {
      const me = this.d.db.getAgent(live.agentId);
      live.requestStart = { at: Date.now(), base: me ? me.tokensIn + me.tokensOut : 0 };
      live.budgetWarned = false;
      if (this.d.traces) {
        live.traceId = newTraceId();
        live.requestSpan = this.d.traces.start({ traceId: live.traceId, agentId: live.agentId, chatId: t.chat.id, kind: "request", name: t.input.replace(/\s+/g, " ").slice(0, 120) || "request",
          attrs: { "gen_ai.operation.name": "invoke_agent", "gen_ai.agent.name": t.role.title, "flash.role": t.role.name } });
      }
    }

    live.busy = true;
    live.idleSince = null;
    const turnStart = Date.now();
    let reportFix: string | null = null;
    let checkFix: string | null = null;
    if (!t.textRound) { live.askedThisTurn = false; live.pendingQuestion = null; }
    const borrowed = !!t.borrowSlot;
    if (!borrowed) {
      const max = s.agents.maxConcurrent || MAX_CONCURRENT_FALLBACK;
      // Visible right away: an agent waiting for a slot used to sit at "idle" and looked like it never started.
      if (this.running >= max) this.setStatus(live, "running", `⏳ Queued — ${this.running}/${max} agents busy; starts when one finishes (Settings → Agents)`);
      await this.acquireSlot(max);
    }
    if (live.stopped) { live.busy = false; if (!borrowed) this.releaseSlot(); return; } // stopped while queued
    const newReply = () => this.d.db.addMessage({ chatId: t.chat.id, parentId: t.threadRoot, author: "agent", agentId: live.agentId,
      role: t.role.name, content: "", status: "streaming" });
    let reply = newReply();
    live.currentMessageId = reply.id;
    live.lastReplyId = reply.id;
    if (this.d.traces) {
      live.traceId ??= this.byAgent.get(live.parentAgentId ?? "")?.traceId ?? newTraceId();
      live.toolSpans = new Map();
      live.turnSpan = this.d.traces.start({ traceId: live.traceId, parentId: live.delegateSpan ?? live.requestSpan ?? null, agentId: live.agentId, chatId: t.chat.id, kind: "turn",
        name: `${agentLabel(live, t.role.title)} turn`, attrs: { "gen_ai.operation.name": "chat", "gen_ai.agent.name": agentLabel(live, t.role.title), "flash.role": t.role.name,
          "gen_ai.provider.name": live.harness, ...(t.checkRound ? { "flash.check_round": t.checkRound } : {}), ...(t.reportRound ? { "flash.report_round": t.reportRound } : {}) } });
      this.d.emit({ type: "trace.updated", traceId: live.traceId });
    }
    live.tools = new Map();
    live.textBreak = false;
    live.thought = null;
    live.splitPending = false;
    this.d.emit({ type: "message.created", message: reply });
    this.setStatus(live, "running", "Starting…");
    live.lastOutputAt = Date.now();
    live.turnStartedAt = live.lastOutputAt;
    live.stuckSince = null;
    live.lineBuf = "";
    live.tail = "";
    this.flow(live.agentId, { kind: "turn", label: t.input.replace(/\s+/g, " ").slice(0, 160) });

    // `text` is the whole turn (results and delegations are parsed from it); the shown reply starts at `base`, which
    // moves when a steering message splits the turn into a new reply below it.
    let text = "";
    let base = 0;
    let finalStatus = "";
    let switchedToText = false;
    let crashed = false; // the harness exited and a restart did not help: offer another one
    // How the turn ended for whoever waits on it: reported once the task's last turn is over (see the end of turn()).
    let outcome: { result: string; failed: string | null; silent: boolean } | null;
    let lastFlush = Date.now();
    const project = t.chat.projectId ? this.d.db.getProject(t.chat.projectId) : null;
    let promptText: string;
    try {
      if (live.starting) await live.starting.catch(() => undefined);
      // Headless harnesses (GitLab Duo) run a new process per turn and carry the conversation only through the session id
      // they report. Without one, the next run starts from nothing: send it the rules, tools and history again.
      const firstTurn = !live.session || !live.session.alive || !!live.prestarted || (live.harness === "duo" && !live.session.sessionId);
      live.prestarted = false;
      live.turnChanges = new Map();
      live.sink = (delta) => {
        if (live.textBreak) { delta = paragraphBreak(text.slice(base)) + delta; live.textBreak = false; }
        text += delta;
        this.liveText.set(reply.id, text.slice(base));
        this.d.emit({ type: "message.delta", messageId: reply.id, chatId: t.chat.id, delta });
        if (Date.now() - lastFlush > 500) { lastFlush = Date.now(); this.d.db.updateMessage(reply.id, { content: text.slice(base) }); }
      };
      live.rollover = () => {
        this.endThought(live);
        this.flushTools(live, reply.id, t.chat.id);
        this.liveText.delete(reply.id);
        const shown = text.slice(base);
        const done = this.d.db.updateMessage(reply.id, { content: shown.trim() ? shown : "_(continued below your message)_", status: "done" });
        this.d.emit({ type: "message.updated", message: done });
        if (text && !text.endsWith("\n\n")) text += paragraphBreak(text) || "\n\n";
        base = text.length;
        reply = newReply();
        live.currentMessageId = reply.id;
        live.lastReplyId = reply.id;
        live.tools = new Map();
        live.textBreak = false;
        this.d.emit({ type: "message.created", message: reply });
      };
      if (firstTurn && live.worktree === undefined) await this.prepareWorktree(live, project?.path ?? null, t.chat.id, t.threadRoot);
      // No project: work in the no-project folder (C:\\Data\\.wt by default on Windows) rather than the home folder.
      const workDir = live.worktree ?? live.folder ?? project?.path ?? this.noProjectDir();
      if (firstTurn && live.duoCoordinator && !live.session?.alive) await this.duoCoordinatorFallback(live, workDir ?? this.d.homeDir, t.chat);
      if (firstTurn && !live.session?.alive) {
        // A CLI that dies while starting gets one more try before the turn fails.
        live.session = await this.openSession(live, workDir, t.chat).catch((e) => {
          if (live.stopped || !HARNESS_EXIT.test(String(e?.message ?? e))) throw e;
          this.flow(live.agentId, { kind: "status", label: `${live.harness} exited while starting — retrying`, status: "retry" });
          return this.openSession(live, workDir, t.chat);
        });
      }
      // Coordinator: Pi has no MCP, so text mode right away; other harnesses get a few seconds to list the tools,
      // and are checked again after the first reply (some list them only when the first prompt arrives).
      let toolsPending = false;
      const coordinator = firstTurn && this.coordinates(live, s);
      if (firstTurn && (s.agents.toolMode === "text" || live.harness === "duo") && live.harness !== "mock") {
        // Text mode (default): no MCP for the app's tools; every agent uses TOOL lines, the coordinator DELEGATE/AGENT lines.
        // GitLab Duo always: headless Duo isn't given TheFlashMaster's MCP server, so TOOL/DELEGATE lines are how it uses them.
        live.textTools = !!this.d.listTools;
        if (coordinator) live.textDelegation = true;
        live.warnedTools = true;
      } else if (firstTurn && this.d.toolsLoaded && this.d.listTools && live.harness !== "mock") {
        // Pi has no MCP; elsewhere give the harness a few seconds to list the app's tools.
        const confirmed = live.harness !== "pi" && await this.waitForTools(live, coordinator ? 5000 : 3000);
        live.textTools = !confirmed;
        if (coordinator && !live.textDelegation) {
          if (live.harness === "pi") this.enterTextDelegation(live, t);
          else toolsPending = !confirmed;
        }
      } else if (coordinator && !live.textDelegation) {
        if (live.harness === "pi") this.enterTextDelegation(live, t);
        else toolsPending = !(await this.waitForTools(live, 5000));
      }
      // On a (re)started session send a compact history instead of a transcript. `first` = the harness session is new
      // (also after a crash restart that could not resume the old session).
      const buildPrompt = (first: boolean): string => {
        let summary: string | null = null;
        let recent: Message[] = [];
        if (first && !t.brief) {
          const cs = this.d.db.getChatSummary(t.chat.id);
          const hist = this.d.db.history(t.chat.id, t.threadRoot, cs.upto).filter((m) => m.id !== reply.id && m.status !== "streaming" && !m.marker);
          // The user message we are answering is sent as the request. A retry on another harness also drops what
          // followed it (the failed reply and the switch offer).
          if (t.retry) { const u = hist.map((m) => m.author).lastIndexOf("user"); if (u >= 0) hist.splice(u); } else hist.pop();
          const plan = planCompaction(hist, s.tokens.compactAfterTokens, s.tokens.keepRecentTurns);
          summary = cs.summary || null;
          if (plan.compact) {
            summary = extractiveSummary(cs.summary, plan.summarise);
            const lastSeq = hist[hist.length - plan.keep.length - 1]?.seq ?? cs.upto;
            this.d.db.setChatSummary(t.chat.id, summary, lastSeq);
            // A model summary replaces the extractive one when it arrives (the next fresh session uses it); nothing waits for it.
            if (s.tokens.summarizer === "model" && s.tokens.summarizerModel.trim()) void this.modelSummary(t.chat.id, cs.summary, plan.summarise, lastSeq);
          }
          recent = (plan.compact ? plan.keep : hist).slice(-s.tokens.keepRecentTurns) as Message[];
        }
        // Skills declared by the role load once, on the session's first turn; slash-command skills load per message.
        const chatSkills = first ? this.skillsFor(t.chat) : [];
        const roleSkills = chatSkills.filter((k) => t.role.skills.includes(k.command) && !t.skills.includes(k));
        return buildTurnPrompt({ role: t.role, projectPath: workDir, skills: [...roleSkills, ...t.skills], summary, recent, input: t.input,
          brief: t.brief, firstTurn: first, clean: s.agents.instructionMode === "clean", memory: this.recallMemory(live, t.chat, `${t.brief ?? ""}\n${t.input}`, first),
          houseRules: [s.agents.houseRules, this.d.extraRules?.() ?? "",
            first && s.agents.unslop !== false && !t.skills.some((k) => k.command === "unslop") ? unslopRules(this.d.skills().find((k) => k.command === "unslop")) : "",
            first ? renderState(this.d.db.getAgentState(live.agentId)) : "", first ? skillsIndex(chatSkills.filter((k) => !roleSkills.includes(k) && !t.skills.includes(k))) : "", first && live.parentAgentId ? STATE_RULES : "",
            first && live.local ? localRuntimeNote(live.harness, live.model, live.local.source) : "", first && live.worktree ? `You work in your own git worktree (an isolated copy of the project) on branch ${live.branch}. Commit your changes on that branch before you finish; the user reviews and merges it. Don't push, and don't switch branches.` : "", first && s.agents.reportDiagrams ? HTML_REPORT_RULES : "", first && live.textDelegation ? TEXT_DELEGATION_RULES : "", first ? (live.parentAgentId ? SPECIALIST_ASK_RULES : NEEDS_YOU_RULES) : "", first && live.parentAgentId ? (live.harness === "duo" ? `${DUO_SPECIALIST_RULES}\n\n${DUO_REPORTING_RULES}` : STATUS_LINE_RULES) : "", first && this.duoOrchestrates(live, s) ? this.duoOrchestratorBrief(s) : first && live.depth === 0 && this.coordinates(live, s) ? COORDINATOR_FEEDBACK_RULES : "", first && this.memoryOn() ? MEMORY_RULES : "", first && live.textTools ? this.textToolsFor(live) : ""].filter((x) => x.trim()).join("\n\n") });
      };
      // Local embeddings (when on) rank recalled memories by meaning too: embed the query before the prompt is built.
      if (this.memoryOn() && s.memory?.autoInject) await this.d.memory?.prepare(`${t.brief ?? ""}\n${t.input}`.slice(0, 4000), 1500);
      promptText = buildPrompt(firstTurn);
      this.setStatus(live, "running", "Thinking…");
      // Autopilot is read per turn, so toggling it applies to the very next message.
      const chatNow = this.d.db.getChat(t.chat.id) ?? t.chat;
      if (chatNow.autopilot) promptText += "\n\n(Autopilot: work autonomously. Do not stop to ask for confirmation or feedback — make reasonable assumptions, state them briefly, and finish the task.)";
      const atts = (t.attachments ?? []).map((a) => ({ kind: a.kind, name: a.name, mime: a.mime, path: a.path }));
      if (t.deliver && t.msgIds?.length) this.markDelivered(live, t.msgIds, false);
      let res = await live.session!.prompt(promptText, atts);
      // Transient network drops between the harness and its model API (proxy resets, "other side closed"):
      // retry twice, continuing where the reply stopped instead of failing the turn.
      for (let attempt = 1; attempt <= 2 && res.stopReason === "error" && isTransientNetworkError(res.error) && !live.stopped && live.session?.alive; attempt++) {
        this.flow(live.agentId, { kind: "status", label: `network error — retrying (${attempt}/2)`, status: "retry" });
        this.setStatus(live, "running", `Connection dropped — retrying (${attempt}/2)…`);
        await new Promise((r) => setTimeout(r, 2000 * attempt));
        res = await live.session!.prompt(text.trim()
          ? "Your previous response was cut off by a network error. Continue exactly where you stopped; do not repeat what you already wrote."
          : promptText, text.trim() ? [] : atts);
      }
      // The agent CLI itself exited mid-turn (crash, out of memory, killed): restart it once, resume its session
      // and carry on instead of failing the turn. A second exit fails the turn and offers another harness.
      if (res.stopReason === "error" && !live.stopped && live.session && !live.session.alive) {
        const label = this.d.harnesses.get(live.harness).label;
        // Restarted on purpose because it kept waiting on a stopped tool call: continue with that news, not "you crashed".
        const toolStop = live.redirect?.toolStop ? live.redirect : null;
        if (toolStop) live.redirect = null;
        const prev = live.session.sessionId;
        const crash = res.error ?? "exited";
        this.d.log?.("warn", `${label} exited during a turn (${live.role.name}): ${crash}`);
        this.flow(live.agentId, { kind: "status", label: `${label} exited — restarting`, status: "retry" });
        this.setStatus(live, "running", `${label} exited — restarting and resuming…`);
        live.session.close();
        live.session = null;
        try {
          live.session = await this.openSession(live, workDir, t.chat);
        } catch (e: any) {
          res = { stopReason: "error", error: String(e?.message ?? e) };
        }
        if (live.session && !live.stopped) {
          const resumed = !!prev && !!live.session.resumed && live.session.sessionId === prev;
          const wrote = text.slice(base).trim();
          // Resumed: the agent still has the conversation, so ask it to continue. New session: send history + request again.
          const again = toolStop
            ? (resumed ? toolStop.input : buildPrompt(true) + (wrote ? `\n\nWhat you had written:\n${wrote.slice(-2000)}` : "") + `\n\n${toolStop.input}`)
            : resumed
              ? (wrote ? CRASH_CONTINUE : promptText)
              : buildPrompt(true) + (wrote ? `\n\n${CRASH_CONTINUE}\n\nWhat you had written:\n${wrote.slice(-2000)}` : "");
          if (toolStop) { live.textBreak = true; live.sink?.(`_⏹ Stopped the hung tool call **${toolStop.toolStop}** and restarted ${label} — continuing without it._`); live.textBreak = true; }
          this.setStatus(live, "running", resumed ? `Resumed ${label} session — continuing…` : `Restarted ${label} — continuing…`);
          res = await live.session.prompt(again, toolStop || (resumed && wrote) ? [] : atts);
          if (res.stopReason !== "error" && !toolStop) {
            this.flow(live.agentId, { kind: "status", label: resumed ? `${label} restarted, session resumed` : `${label} restarted in a new session`, status: "retry" });
            this.system(t.chat.id, t.threadRoot, `↻ **${label}** exited unexpectedly during ${t.role.title}'s turn; TheFlashMaster restarted it`
              + (resumed ? " and resumed the session." : " in a new session with the chat history."));
          }
        }
        if (res.stopReason === "error" && !live.stopped && !(live.session?.alive ?? false)) {
          res = { ...res, error: `${label} exited again after a restart: ${res.error ?? "exited"}` };
          crashed = true;
        }
      }
      this.d.db.updateMessage(reply.id, { content: text.slice(base) });
      // Duo reports its session id during the turn, not at start: keep it so the next turn (and an app restart) resumes it.
      if (live.session?.sessionId && live.session.sessionId !== this.d.db.getAgentSession(live.agentId)) this.d.db.updateAgent(live.agentId, { sessionId: live.session.sessionId });
      // The harness was given our MCP servers but none of them reached the app: tools did not load.
      if (toolsPending && !(await this.waitForTools(live, 3000))) { this.enterTextDelegation(live, t); switchedToText = true; }
      // The harness listed the app's tools but the model says it doesn't have `delegate` (filtered by policy, renamed…):
      // believe the model, not the tool list.
      else if (!live.textDelegation && s.agents.toolMode !== "text" && this.coordinates(live, s) && saysNoDelegate(text) && !parseTextDelegations(text).length) {
        this.enterTextDelegation(live, t, "hidden");
        live.textTools = true;
        switchedToText = true;
      }
      if (firstTurn && this.d.toolsLoaded && live.harness !== "pi" && live.harness !== "mock" && !this.d.toolsLoaded(live.agentId) && !live.warnedTools && !live.textDelegation && s.agents.toolMode !== "text") {
        live.warnedTools = true;
        this.system(t.chat.id, t.threadRoot, `⚠️ TheFlashMaster's tools (delegation, tasks, artifacts) did not load in **${live.harness}** for ${t.role.title}, so it cannot hand work to specialists. `
          + "Check **Settings → MCP → Test tool servers**; the error there tells what blocks them.", "warn");
      }
      const usage = res.usage && (res.usage.tokensIn || res.usage.tokensOut)
        ? { ...res.usage, estimated: false }
        : { tokensIn: estimateTokens(promptText), tokensOut: estimateTokens(text), estimated: true };
      this.d.db.recordUsage({ agentId: live.agentId, projectId: t.chat.projectId, harness: live.harness, role: t.role.name, ...usage });
      this.d.traces?.annotate(live.turnSpan, { "gen_ai.usage.input_tokens": usage.tokensIn, "gen_ai.usage.output_tokens": usage.tokensOut, "flash.tokens_estimated": usage.estimated,
        ...(live.model ? { "gen_ai.request.model": live.model } : {}) });
      live.sessionTokens += usage.tokensIn + usage.tokensOut;
      const redirected = !!live.redirect && !live.stopped;
      const gaveUp = live.stallGiveUp ?? null;
      live.stallGiveUp = null;
      const status = live.stopped ? "stopped" : redirected ? "done" : res.stopReason === "error" || gaveUp ? "error" : live.paused ? "paused" : res.stopReason === "cancelled" ? "stopped" : "done";
      finalStatus = redirected ? "redirected" : status;
      if (redirected) text += live.redirect!.toolStop ? `\n\n_⏹ Stopped the hung tool call **${live.redirect!.toolStop}** — continuing without it._`
        : live.redirect!.nudge ? "\n\n_↻ Interrupted by TheFlashMaster after a long silence: asked to deliver what it has._"
          : live.redirect!.fromAgent ? `\n\n_✉️ Interrupted by a message from ${live.redirect!.fromAgent}._` : "\n\n_↪ Redirected by your steering message._";
      else if (res.error) text += `\n\n⚠️ ${res.error}`;
      else if (gaveUp) text += `\n\n⚠️ Stopped by TheFlashMaster: ${gaveUp}.`;
      // Text-mode TOOL lines show in the reply's tool-call panel; don't repeat them in the prose.
      const shown = live.textTools && status === "done" && !redirected && !switchedToText && !live.queue.length
        ? stripTextToolCalls(text.slice(base), new Set(this.toolSetFor(live).map((x) => x.name))) : text.slice(base);
      const final = this.d.db.updateMessage(reply.id, { content: shown || (shown !== text.slice(base) ? "" : status === "paused" ? "_(paused)_" : "_(no output)_"),
        status: status === "error" ? "error" : "done", tokensIn: usage.tokensIn, tokensOut: usage.tokensOut, estimated: usage.estimated });
      this.d.emit({ type: "message.updated", message: final });
      const compact = resultForParent(text, t.role.maxResultTokens) + (live.branch ? `\nbranch: ${live.branch} (isolated copy; the user merges it)` : "");
      live.lastResult = compact;
      const resultLine = /summary:\s*(.+)/.exec(compact)?.[1] ?? compact.replace(/\s+/g, " ");
      if (status === "done" && !redirected) this.captureResult(live, t.chat, t.role, resultLine);
      // What the agent itself says about how it ended (status line of its <result> block).
      const said = status === "done" ? (parseResult(text).status ?? "done") : "done";
      const asks = said !== "done" ? (parseResult(text).question ?? resultLine) : null;
      this.flow(live.agentId, status === "error" ? { kind: "error", label: (res.error ?? "error").slice(0, 160) }
        : said !== "done" ? { kind: "status", label: `${SAID_LABEL[said]}: ${asks!.slice(0, 150)}`, status: said }
        : { kind: status === "done" ? "result" : "status", label: status === "done" ? resultLine.slice(0, 160) : status, status });
      this.emitAgent(this.d.db.updateAgent(live.agentId, { status: status === "done" ? "idle" : status, resultSummary: compact.slice(0, 4000),
        lastActivity: status === "done" ? (said !== "done" ? `${SAID_LABEL[said]}: ${asks}` : "Waiting for input") : status, ended: status === "stopped" }));
      if (said !== "done") this.surfaceSaid(live, t.chat.id, t.threadRoot, said, asks!, parseResult(text).options);
      if (t.taskId) {
        const task = this.d.db.updateTask(t.taskId, { status: status === "error" || said !== "done" ? "blocked" : "review" });
        this.d.emit({ type: "task.updated", task });
      }
      // Deliverables (HTML report, diagrams) are checked by the app, so they hold on every harness and whatever instruction
      // files the CLI loaded. A miss sends the agent back (twice at most) before its result goes to the coordinator.
      const check = status === "done" && !redirected && said === "done" && !live.queue.length
        ? checkReports({ workDir: this.agentWorkDir(live.agentId), since: turnStart, text, requires: t.role.requires ?? [], diagrams: s.agents.reportDiagrams !== false,
          artifacts: this.d.db.agentArtifactsSince(live.agentId, turnStart) })
        : null;
      if (check?.problems.length && (t.reportRound ?? 0) < MAX_REPORT_FIXES) {
        reportFix = reportFixPrompt(check, t.role.title);
        this.flow(live.agentId, { kind: "status", label: `deliverable check: ${check.problems.length} item(s) missing — sent back to fix`, status: "retry" });
        this.system(t.chat.id, t.threadRoot, `↩ **${agentLabel(live, t.role.title)}** didn't follow its instructions yet (${check.problems.map((x) => x.split(/[.:]/)[0]).join("; ")}), so it was sent back to finish them.`);
      } else if (check?.problems.length) {
        this.system(t.chat.id, t.threadRoot, `⚠️ **${agentLabel(live, t.role.title)}** still misses: ${check.problems.join(" ")}`, "warn");
      }
      // Checks before merge: the project's own commands run in the specialist's worktree. A failure goes back to it (up to
      // maxFixRounds) before its result reaches the coordinator; the result then says how the checks went.
      let checksNote = "";
      if (status === "done" && !redirected && said === "done" && !live.queue.length && !reportFix && live.parentAgentId && live.worktree && !live.stopped) {
        const run = await this.autoChecks(live);
        const maxRounds = Math.max(0, s.checks?.maxFixRounds ?? 2);
        if (run && !run.ok && (t.checkRound ?? 0) < maxRounds && !live.stopped) {
          checkFix = checksFixPrompt(run, (t.checkRound ?? 0) + 1, maxRounds);
          this.system(t.chat.id, t.threadRoot, `↩ **${agentLabel(live, t.role.title)}**: ${checksLine(run)}, so it was sent back to fix them.`);
        } else if (run) {
          checksNote = `\n${checksForParent(run, !run.ok)}`;
          if (!run.ok) this.system(t.chat.id, t.threadRoot, `⚠️ **${agentLabel(live, t.role.title)}**: ${checksLine(run)} after ${maxRounds} fix round(s).`, "warn");
        }
      }
      const asked = said === "needs_decision" || said === "blocked" || !!live.askedThisTurn;
      outcome = {
        result: compact + checksNote + (live.pendingQuestion ? `\n${live.pendingQuestion}` : "") + (asked && live.parentAgentId ? `\n${UNTANGLE_NOTE(agentLabel(live, t.role.title), live.agentId)}` : "")
          + (said === "blocked" && live.parentAgentId ? this.localityHint(live, text) : ""),
        failed: status === "error" ? (gaveUp ?? res.error ?? "error") : null,
        silent: status === "done" && !redirected && !asked && isSilentReply(text, live.depth > 0 ? 20 : 1),
      };
      // Rollover compaction: a long-lived harness session re-sends its whole history every turn. Past the
      // threshold we close it; the next turn starts fresh with summary + recent turns only.
      if (s.tokens.compactAfterTokens > 0 && live.sessionTokens > s.tokens.compactAfterTokens * 2) {
        live.session?.close();
        live.session = null;
        live.sessionTokens = 0;
      }
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      this.d.log?.("error", `turn failed (${live.role.name}/${live.harness}): ${msg}`);
      this.flow(live.agentId, live.stopped ? { kind: "status", label: "stopped", status: "stopped" } : { kind: "error", label: msg.slice(0, 160) });
      const final = this.d.db.updateMessage(reply.id, { content: (text.slice(base) ? text.slice(base) + "\n\n" : "") + `⚠️ ${msg}`, status: "error" });
      this.d.emit({ type: "message.updated", message: final });
      this.emitAgent(this.d.db.updateAgent(live.agentId, live.stopped ? { status: "stopped", lastActivity: "Stopped" } : { status: "error", lastActivity: msg }));
      live.session?.close();
      live.session = null;
      if (!live.stopped && HARNESS_EXIT.test(msg)) crashed = true;
      outcome = { result: live.stopped ? "stopped" : `error: ${msg}`, failed: live.stopped ? null : msg, silent: false };
      if (t.taskId) this.d.emit({ type: "task.updated", task: this.d.db.updateTask(t.taskId, { status: "blocked" }) });
    } finally {
      this.endThought(live);
      this.liveText.delete(reply.id);
      this.flushTools(live, reply.id, t.chat.id);
      live.sink = null;
      live.rollover = null;
      live.splitPending = false;
      live.busy = false;
      live.idleSince = Date.now();
      live.currentMessageId = null;
      if (!borrowed) this.releaseSlot();
      if (live.parentAgentId) this.teamSlotFreed(live.parentAgentId);
      if (this.d.traces && live.turnSpan) {
        for (const id of live.toolSpans?.values() ?? []) this.d.traces.end(id, { status: "stopped" });
        this.d.traces.end(live.turnSpan, { status: finalStatus === "error" ? "error" : live.stopped ? "stopped" : "ok", attrs: { "flash.status": finalStatus } });
        this.d.traces.end(live.requestSpan, { touch: true });
        const parentLive = live.parentAgentId ? this.byAgent.get(this.teamRoot(live.agentId)) : null;
        if (parentLive?.requestSpan) this.d.traces.end(parentLive.requestSpan, { touch: true });
        live.turnSpan = undefined;
        if (live.traceId) this.d.emit({ type: "trace.updated", traceId: live.traceId });
      }
    }
    if (this.hooks.has("turn_end")) {
      void this.hooks.fire({ event: "turn_end", agentId: live.agentId, agent: agentLabel(live, t.role.title), role: t.role.name, cwd: this.agentWorkDir(live.agentId),
        status: live.stopped ? "stopped" : "done", result: text.slice(-4000) }).catch(() => {});
    }
    // What continues this task: a re-plan in text mode, text-mode calls (TOOL / DELEGATE lines) or a steering redirect.
    // Only the task's last turn reports back: reporting the first part (a reply of TOOL lines) used to hand the delegating
    // agent an empty result and drop the specialist's real report.
    let next: (() => void) | null = null;
    if (switchedToText && finalStatus === "done" && !live.stopped && !live.paused && !parseTextDelegations(text).length) {
      // The first reply was written without the delegate tool: have the coordinator re-plan with DELEGATE lines.
      const extra = live.textTools ? this.textToolsFor(live) : "";
      next = () => void this.turn({ ...t, retry: false, input: `${TEXT_DELEGATION_RULES}${extra ? `\n\n${extra}` : ""}\n\nYour tools are not available, so use this text mode. Re-plan the user's last request now and delegate it with DELEGATE lines.`,
        attachments: [], skills: [], brief: null, taskId: undefined, liveKey: live.key, msgIds: undefined, deliver: false, borrowSlot: false, textRound: 1 });
    } else if ((live.textDelegation || live.textTools) && finalStatus === "done" && !live.stopped && !live.paused && !live.queue.length) {
      live.lastText = text;
      const reqs = live.textDelegation ? parseTextDelegations(text) : [];
      const agents = live.textDelegation ? parseTextAgents(text).length : 0;
      const calls = live.textTools ? parseTextToolCalls(text, new Set(this.toolSetFor(live).map((x) => x.name))) : [];
      if (reqs.length || agents || calls.length) next = () => void this.runTextDelegations(live, t, reqs, calls);
    }
    // The app's deliverable check sent the agent back to finish (HTML report, diagrams) before its result goes anywhere.
    if (!next && reportFix && !live.stopped && !live.paused) {
      const input = reportFix;
      next = () => void this.turn({ ...t, retry: false, input, attachments: [], skills: [], brief: null, taskId: t.taskId, liveKey: live.key, msgIds: undefined,
        deliver: false, borrowSlot: t.borrowSlot, textRound: 0, reportRound: (t.reportRound ?? 0) + 1 });
    }
    if (!next && checkFix && !live.stopped && !live.paused) {
      const input = checkFix;
      next = () => void this.turn({ ...t, retry: false, input, attachments: [], skills: [], brief: null, taskId: t.taskId, liveKey: live.key, msgIds: undefined,
        deliver: false, borrowSlot: t.borrowSlot, textRound: 0, checkRound: (t.checkRound ?? 0) + 1 });
    }
    if (!next && live.redirect && !live.stopped) {
      const r = live.redirect;
      live.redirect = null;
      next = () => void this.turn({ ...t, retry: false, input: r.toolStop || r.nudge || r.fromAgent ? r.input : `The user interrupted you with new direction:\n${r.input}\n\nContinue the task taking this into account.`,
        attachments: r.attachments, skills: [], brief: null, taskId: undefined, liveKey: live.key, msgIds: r.msgIds, deliver: true, borrowSlot: false, textRound: 0 });
    }
    if (next) { next(); return; }
    if (outcome) {
      // A specialist that ended without a report is reminded, then restarted; past the cap the user gets a card.
      const result = this.recoverOrReport(live, t, outcome);
      if (result === null) return;
      this.finishDelegated(live, result);
      if (crashed && !live.stopped) this.offerHarnessSwitch(live, t);
      if (this.coordinatorFeedback(live, t, outcome)) return;
    }
    if (!live.paused && !live.stopped && live.queue.length) {
      const items = live.queue.splice(0);
      // A message from the delegating agent (message_agent) starts a follow-up whose result goes back to it.
      if (items.some((q) => q.fromAgent) && live.parentAgentId) { live.delegated = true; live.resultTaken = false; live.recoveries = 0; }
      void this.turn({ ...t, retry: false, input: items.map((q) => q.input).join("\n\n"), attachments: items.flatMap((q) => q.attachments), skills: [], brief: null,
        taskId: undefined, liveKey: live.key, msgIds: items.flatMap((q) => q.msgIds ?? []), deliver: true, borrowSlot: false, textRound: 0 });
    }
  }

  /**
   * A delegated specialist's task ended. Returns the result to report to its delegating agent, or null when a recovery
   * turn was started instead: the first time it ended without a report it is reminded to deliver (same session); after
   * an error or a second silent end it is restarted on the task. Past agents.recoveryAttempts the user gets a card.
   */
  private recoverOrReport(live: Live, t: Parameters<Orchestrator["turn"]>[0], o: { result: string; failed: string | null; silent: boolean }): string | null {
    if (!o.failed && !o.silent) { live.recoveries = 0; return o.result; }
    if (!live.delegated || live.depth === 0 || !live.parentAgentId || live.stopped || live.paused) return o.result;
    const cap = Math.max(0, this.d.settings().agents.recoveryAttempts ?? 2);
    const n = (live.recoveries ?? 0) + 1;
    const name = agentLabel(live, live.role.title);
    const who = `${live.role.icon} ${name}`;
    const why = o.failed ? `failed (${o.failed.replace(/\s+/g, " ").slice(0, 200)})` : "ended without a report";
    const goal = live.task?.goal ?? t.input;
    if (n > cap) {
      live.recoveries = 0;
      const tried = cap ? ` TheFlashMaster tried ${cap === 1 ? "once" : `${cap} times`} to recover it (a reminder${cap > 1 ? ", then a restart" : ""}).` : "";
      this.flow(live.agentId, { kind: "error", label: `gave up: ${why}`.slice(0, 160) });
      if (live.task?.taskId) this.d.emit({ type: "task.updated", task: this.d.db.updateTask(live.task.taskId, { status: "blocked" }) });
      // The coordinator owns the plan: it decides what happens next (restart, reassign, go on); the user hears from it.
      this.system(t.chat.id, t.threadRoot, `⚠️ **${who}** ${why} and delivered no result${tried ? ` (${tried.trim().replace(/\.$/, "")})` : ""}. Its result went to the agent that delegated to it, to decide what's next.`);
      return `status: failed\nsummary: ${name} ${why} and delivered no result${cap ? ` after ${cap} recovery attempt${cap === 1 ? "" : "s"}` : ""}. Its task: ${goal.replace(/\s+/g, " ").slice(0, 220)}\n`
        + `Untangle this yourself: restart it with a narrower brief or the missing context (a follow-up: delegate with agentId ${live.agentId}, or in text mode DELEGATE ${live.role.name} agent "${live.agentId}": …), `
        + "give the task to another specialist, or continue without it, and tell the user in one line which call you made. "
        + "Ask the user (ask_user) only if none of that can work: missing access or credentials, a change to what they asked for, or an irreversible step.";
    }
    live.recoveries = n;
    const restart = !!o.failed || n >= 2 || !live.session?.alive;
    this.flow(live.agentId, { kind: "status", label: `${why}: ${restart ? "restarting it" : "asking it to deliver"} (${n}/${cap})`.slice(0, 160), status: "retry" });
    this.system(t.chat.id, t.threadRoot, `↻ **${who}** ${why}, so TheFlashMaster ${restart ? "restarted it on its task" : "asked it to deliver its result"} (recovery ${n} of ${cap}).`);
    this.setStatus(live, "running", restart ? "Restarting: the last attempt delivered nothing" : "Asked to deliver its result");
    if (restart) { live.session?.close(); live.session = null; live.sessionTokens = 0; }
    const parent = this.byAgent.get(live.parentAgentId);
    void this.turn({ chat: t.chat, threadRoot: t.threadRoot, role: live.role, input: restart ? `${RESTART_NOTE(why)}\n\n${goal}` : DELIVER_NUDGE,
      attachments: [], skills: [], depth: live.depth, brief: restart ? (live.task?.brief ?? t.brief) : null, taskId: undefined, liveKey: live.key,
      msgIds: undefined, deliver: false, borrowSlot: live.waiters.length > 0 && !!parent?.busy, textRound: 0 })
      .catch((e) => this.finishDelegated(live, `error: ${String(e?.message ?? e)}`));
    return null;
  }

  /**
   * The coordinator (any agent the user talks to directly) must never end a turn with nothing for the user: a silent
   * turn gets one reminder; a second one raises a "needs you" card. Returns true when a reminder turn was started.
   */
  private coordinatorFeedback(live: Live, t: Parameters<Orchestrator["turn"]>[0], o: { failed: string | null; silent: boolean }): boolean {
    if (live.depth > 0 || live.parentAgentId || live.stopped || live.paused || o.failed) return false;
    if (!o.silent) { live.coordNudged = false; return false; }
    if (live.queue.length) return false; // the user already wrote again: that turn answers them
    const still = this.ownWorking(live.agentId).map((l) => agentLabel(l, l.role.title));
    if (!live.coordNudged) {
      live.coordNudged = true;
      this.flow(live.agentId, { kind: "status", label: "ended without a reply: reminded to report", status: "retry" });
      void this.turn({ ...t, retry: false, input: COORD_NUDGE + (still.length ? `\n\nStill working: ${still.join(", ")}.` : ""), attachments: [], skills: [], brief: null,
        taskId: undefined, liveKey: live.key, msgIds: undefined, deliver: false, borrowSlot: false, textRound: 0 });
      return true;
    }
    live.coordNudged = false;
    const name = agentLabel(live, t.role.title);
    this.raiseAsk(live, t.chat.id, {
      kind: "silent", agentId: live.agentId, who: `${t.role.icon} ${name}`,
      question: `${name} ended its turn without telling you anything. Should it try again, or do you want to steer it?`,
      why: `It was reminded once to report and still wrote nothing.${still.length ? ` Still working: ${still.join(", ")}; their results wake it when they finish.` : ""}`,
      options: [ASK_RETRY], recommended: 0,
    });
    return false;
  }

  /**
   * Show a "needs you" card in the chat: the question, why it waits and quick answers. Cards go in the timeline the
   * user reads (the coordinator's), not deep in a specialist's thread; answerAsk sends the answer to the agent.
   */
  private raiseAsk(l: Live, chatId: string, ask: AskCard): Message {
    const root = this.byAgent.get(this.teamRoot(l.agentId)) ?? l;
    const parentId = root.chatId === chatId ? root.threadRoot : l.threadRoot;
    const label = { question: "Question", blocked: "Blocked", no_report: "No report", failed: "Failed", silent: "No reply" }[ask.kind];
    const m = this.d.db.addMessage({ chatId, parentId, author: "system", agentId: l.agentId, role: l.role.name,
      content: `❓ **Needs you** · ${ask.who} · ${label}\n\n**${ask.question}**${ask.why ? `\n\n${ask.why}` : ""}${ask.options.length ? `\n\nOptions: ${ask.options.join(" · ")}` : ""}`, ask });
    this.d.emit({ type: "message.created", message: m });
    this.d.emit({ type: "notice", level: "warn", text: `Needs you: ${ask.who} · ${ask.question}`.replace(/[*`]/g, "").slice(0, 140) });
    this.emitAgent(this.d.db.updateAgent(l.agentId, { lastActivity: `❓ Needs you: ${ask.question}`.slice(0, 300) }));
    this.flow(l.agentId, { kind: "status", label: `needs you: ${ask.question}`.slice(0, 160), status: "needs_you" });
    return m;
  }

  /** The ask_user tool: an agent puts a question to the user as a card; the answer comes back to it as a new message. */
  askUser(agentId: string, a: { question: string; why?: string; options?: string[]; recommended?: number; blocked?: boolean }): { asked: true; note: string } {
    const l = this.byAgent.get(agentId);
    if (!l) throw new Error("unknown agent");
    const question = String(a.question ?? "").trim();
    if (!question) throw new Error("question is required");
    const options = (Array.isArray(a.options) ? a.options : []).map((o) => String(o).trim()).filter(Boolean).slice(0, 6).map((o) => o.slice(0, 120));
    l.askedThisTurn = true;
    // A delegated specialist's question goes to the agent that delegated to it, which answers it or takes it to the user.
    if (l.parentAgentId && l.depth > 0) {
      const parent = this.byAgent.get(l.parentAgentId);
      l.pendingQuestion = [`question for you (${a.blocked ? "blocked" : "needs a decision"}): ${question.slice(0, 600)}`, a.why?.trim() ? `why: ${a.why.trim().slice(0, 800)}` : "",
        options.length ? `options: ${options.join(" | ")}` : ""].filter(Boolean).join("\n");
      this.flow(agentId, { kind: "status", label: `asked ${parent ? agentLabel(parent, parent.role.title) : "its delegating agent"}: ${question}`.slice(0, 160), status: "needs_decision" });
      return { asked: true, note: `Your question goes to ${parent ? agentLabel(parent, parent.role.title) : "the agent that delegated to you"}, not to the user: it answers or decides. `
        + "End your turn now with your result block (status needs_decision or blocked, the question and options); the answer comes to you as a new message." };
    }
    this.raiseAsk(l, l.chatId, { kind: a.blocked ? "blocked" : "question", agentId, who: `${l.role.icon} ${agentLabel(l, l.role.title)}`,
      question: question.slice(0, 600), why: a.why?.trim().slice(0, 800) || null, options,
      recommended: typeof a.recommended === "number" && a.recommended >= 0 && a.recommended < options.length ? a.recommended : (options.length ? 0 : null) });
    return { asked: true, note: "The user sees your question as a card in the chat. End your turn now with a short note (result status needs_decision); their answer comes to you as a new message." };
  }

  /**
   * The user answered a "needs you" card. The answer goes to the agent that asked: a specialist continues in its own
   * session and its new result goes back to its delegating agent; the coordinator gets it as a message from the user.
   * For a specialist that didn't deliver, "Restart it" (or any other words, as guidance) restarts it on its task and
   * "Continue without it" tells the coordinator to go on.
   */
  async answerAsk(messageId: string, answer: string): Promise<Message> {
    const m = this.d.db.getMessage(messageId);
    if (!m?.ask) throw new Error("That message isn't a question card.");
    if (m.ask.answer) throw new Error("This card was already answered.");
    const text = String(answer ?? "").trim();
    if (!text) throw new Error("Pick an option or type an answer.");
    const ask = m.ask;
    const done = this.d.db.setMessageAsk(m.id, { ...ask, answer: { text: text.slice(0, 4000), at: Date.now() } })!;
    this.d.emit({ type: "message.updated", message: done });
    const chat = this.mustChat(m.chatId);
    const l = ask.agentId ? this.byAgent.get(ask.agentId) : undefined;
    const alive = !!l && !l.stopped && this.live.has(l.key);
    if (ask.kind === "no_report" || ask.kind === "failed") {
      if (text !== ASK_SKIP && alive && l!.task) {
        const g = text === ASK_RESTART ? "" : `\n\nThe user adds: ${text}`;
        this.restartTask(l!, chat, `${RESTART_NOTE("delivered no result")}${g}\n\n${l!.task.goal}`);
        this.flow(l!.agentId, { kind: "status", label: "restarted by you", status: "retry" });
      } else {
        await this.sendUserMessage(chat.id, text === ASK_SKIP ? `Continue without ${ask.who}'s result.` : `About ${ask.who}, which didn't deliver: ${text}`, m.parentId);
      }
    } else if (ask.kind === "silent") {
      await this.sendUserMessage(chat.id, text === ASK_RETRY ? "Continue, and tell me where things stand." : text, m.parentId);
    } else if (alive && l!.depth > 0) {
      const um = this.d.db.addMessage({ chatId: chat.id, parentId: l!.threadRoot, author: "user", content: text });
      this.d.emit({ type: "message.created", message: um });
      l!.delegated = !!l!.parentAgentId;
      l!.resultTaken = false;
      l!.recoveries = 0;
      void this.turn({ chat, threadRoot: l!.threadRoot, role: l!.role, input: `The user answered your question "${ask.question}":\n${text}\n\nContinue the task with this answer.`,
        skills: [], depth: l!.depth, brief: null, liveKey: l!.key, msgIds: [um.id], deliver: true, textRound: 0 })
        .catch((e) => this.finishDelegated(l!, `error: ${String(e?.message ?? e)}`));
    } else {
      // The coordinator asked, or the specialist is gone (closed, app restarted): the coordinator takes the answer on.
      await this.sendUserMessage(chat.id, `Answer to ${alive && l!.depth === 0 ? "your" : `${ask.who}'s`} question "${ask.question}": ${text}`, m.parentId);
    }
    return this.d.db.getMessage(m.id) ?? done;
  }

  /** Run a specialist's delegated task again from a fresh session; its result goes back to its delegating agent. */
  private restartTask(l: Live, chat: Chat, input: string): void {
    l.session?.close();
    l.session = null;
    l.sessionTokens = 0;
    l.delegated = !!l.parentAgentId;
    l.resultTaken = false;
    l.recoveries = 0;
    void this.turn({ chat, threadRoot: l.threadRoot, role: l.role, input, skills: [], depth: l.depth, brief: l.task?.brief ?? null, liveKey: l.key, deliver: false, textRound: 0 })
      .catch((e) => this.finishDelegated(l, `error: ${String(e?.message ?? e)}`));
  }

  /** The harness keeps exiting: offer (✅ / ❌ on a chat message) to move this agent to another harness and retry. */
  private offerHarnessSwitch(live: Live, t: Parameters<Orchestrator["turn"]>[0]): void {
    const s = this.d.settings();
    const from = this.d.harnesses.get(live.harness).label;
    const alt = this.d.harnesses.alternative(live.harness, s);
    if (!alt) {
      this.system(t.chat.id, t.threadRoot, `⚠️ **${from}** keeps exiting for ${t.role.title}, and no other harness is available to switch to. `
        + "Check **Settings → Harnesses**.", "warn");
      return;
    }
    const to = this.d.harnesses.get(alt).label;
    const msg = this.d.db.addMessage({ chatId: t.chat.id, parentId: t.threadRoot, author: "system", role: live.role.name,
      content: `⚠️ **${from}** keeps exiting, so ${t.role.title}'s turn failed.\n\nReact ✅ to switch ${t.role.title} to **${to}** and retry your last message, or ❌ to stay on ${from}.` });
    this.d.emit({ type: "message.created", message: msg });
    this.d.emit({ type: "notice", level: "warn", text: `${from} keeps exiting for ${t.role.title}: switch to ${to}?` });
    this.pendingPermissions.set(msg.id, (yes) => {
      if (!yes || live.stopped) return;
      this.switchHarness(live, alt);
      void this.turn({ ...t, liveKey: live.key, msgIds: undefined, deliver: false, borrowSlot: false, retry: true });
    });
  }

  /** Moves a live agent to another harness: the old session is closed and the next turn starts a fresh one. */
  private switchHarness(live: Live, to: HarnessId): void {
    const from = this.d.harnesses.get(live.harness).label;
    live.session?.close();
    live.session = null;
    live.sessionTokens = 0;
    live.harness = to;
    live.model = null;
    live.warnedTools = false;
    this.emitAgent(this.d.db.updateAgent(live.agentId, { harness: to, model: null, sessionId: null }));
    this.flow(live.agentId, { kind: "status", label: `switched from ${from} to ${this.d.harnesses.get(to).label}`, status: "retry" });
  }

  private async openSession(live: Live, projectPath: string | null, chat: Chat): Promise<HarnessSession> {
    const s = this.d.settings();
    const adapter = this.d.harnesses.get(live.harness);
    const hs = s.harnesses[live.harness];
    const override = s.agents.roleOverrides[live.role.name];
    const chatNow = this.d.db.getChat(chat.id) ?? chat;
    const mode = chatNow.mode ? s.modes[chatNow.mode] : null;
    const model = live.model ?? (mode?.model || null) ?? (chatNow.harness === live.harness && chatNow.model ? chatNow.model : (override?.model ?? live.role.model ?? hs?.defaultModel ?? "") || null);
    const status = this.d.harnesses.cached(live.harness);
    this.setStatus(live, "running", `Starting ${adapter.label}…`);
    const ins = prepareInstructions(live.harness, { mode: s.agents.instructionMode, keepProject: s.agents.keepProjectInstructions,
      dataDir: this.d.dataDir ?? this.d.homeDir });
    const session = await adapter.start({
      cwd: projectPath ?? this.d.homeDir,
      model,
      thinking: (live.harness === "duo" ? duoModeProfile(chatNow, s)?.thinking : null) || mode?.thinking || null,
      extraArgs: [ins.args.join(" "), hs?.args ?? "", live.launchArgs ?? ""].filter(Boolean).join(" "),
      executable: status?.path ?? (hs?.path || null),
      mcpServers: this.d.mcpServersFor(live.role, live.agentId),
      env: { ...networkEnv(s), ...ins.env, ...(this.d.harnessEnv?.(live.harness) ?? {}), ...(this.d.roleEnv?.(live.role) ?? {}) },
      resumeSessionId: this.d.db.getAgentSession(live.agentId),
      onUsage: live.harness === "copilot" && this.d.onCopilotUsage ? (r) => this.d.onCopilotUsage!({ ...r, agentId: live.agentId }) : undefined,
      policy: {
        approval: s.permissions.approval, readOnly: s.permissions.readOnly, projectRoot: projectPath,
        extraRoots: this.d.attachmentRoots?.() ?? [],
        blocked: s.permissions.blockedCommands.split("\n").filter((l) => l.trim()),
        rules: parseRules(s.permissions.rules ?? "").rules, role: live.role.name,
      },
      preTool: this.hooks.has("pre_tool") ? async (r) => {
        const h = await this.hooks.preTool({ ...r, agentId: live.agentId, agent: agentLabel(live, live.role.title), role: live.role.name, cwd: this.agentWorkDir(live.agentId) });
        if (h) this.flow(live.agentId, { kind: "approval", label: `${r.kind}: ${r.title}`.slice(0, 160), status: `hook: ${h.decision}` });
        return h;
      } : undefined,
      onEvent: (e) => {
        if (e.type === "heartbeat") { live.heartbeatAt = Date.now(); return; }
        if (e.type === "activity") { this.noteActivity(live, e.text); return; }
        this.noteOutput(live);
        if (live.awaiting.length && (e.type === "text" || e.type === "tool" || e.type === "thought")) this.markSeen(live, false);
        if (e.type === "steer_ack") { this.markSeen(live, true); live.splitPending = true; }
        if (live.splitPending && (e.type === "text" || e.type === "tool" || e.type === "thought") && live.rollover) {
          live.splitPending = false;
          live.rollover();
        }
        if (e.type === "text" || e.type === "tool") this.endThought(live);
        if (e.type === "text") { live.sink?.(e.text); this.readStatusLines(live, e.text); }
        else if (e.type === "thought") this.recordThought(live, e.text);
        else if (e.type === "tool") {
          live.textBreak = true;
          // Output updates arrive often: status line and flow chart only change when the call's status does.
          if (this.recordTool(live, e)) {
            this.setStatus(live, "running", `${e.status === "completed" ? "✓" : "▸"} ${e.title}`);
            this.flow(live.agentId, { kind: "tool", label: e.title, status: e.status });
            if (this.d.traces && live.traceId && live.turnSpan) {
              const k = e.id ?? e.title;
              let sp = live.toolSpans?.get(k);
              if (!sp) {
                sp = this.d.traces.start({ traceId: live.traceId, parentId: live.turnSpan, agentId: live.agentId, chatId: live.chatId, kind: "tool", name: e.title,
                  attrs: { "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": e.title.slice(0, 120), "flash.tool.kind": e.kind } });
                live.toolSpans?.set(k, sp);
              }
              if (e.status === "completed" || e.status === "failed") { this.d.traces.end(sp, { status: e.status === "failed" ? "error" : "ok" }); live.toolSpans?.delete(k); }
            }
            if ((e.status === "completed" || e.status === "failed") && this.hooks.has("post_tool")) {
              void this.hooks.fire({ event: "post_tool", agentId: live.agentId, agent: agentLabel(live, live.role.title), role: live.role.name,
                cwd: this.agentWorkDir(live.agentId), kind: e.kind, title: e.title, command: e.kind === "execute" ? (e.input ?? e.title) : null,
                status: e.status, output: (e.output ?? "").slice(0, 4000) }).catch(() => {});
            }
          }
        } else if (e.type === "plan") this.setPlan(live.agentId, e.entries);
        else if (e.type === "diff") { this.recordChange(live, projectPath, e.path, e.oldText, e.newText); this.noteStateFile(live, projectPath, e.path); }
      },
      askPermission: (r) => this.askPermission(live, r),
    });
    if (session.sessionId) this.d.db.updateAgent(live.agentId, { sessionId: session.sessionId });
    if (session.models?.length) this.d.onModels?.(live.harness, session.models);
    return session;
  }

  private askPermission(live: Live, r: PermissionRequest): Promise<boolean> {
    // Autopilot (default) or "Auto-approve everything": never stop to ask. Blocked commands and read-only mode are
    // enforced before this point by the policy, so they still apply.
    // A permission rule or hook that says "ask" asks even on Autopilot: that is what the user wrote it for.
    if (!r.forcedBy && (this.d.db.getChat(live.chatId)?.autopilot || this.d.settings().permissions.approval === "auto-all")) {
      this.flow(live.agentId, { kind: "approval", label: `${r.kind}: ${r.title}`, status: "auto-approved (autopilot)" });
      return Promise.resolve(true);
    }
    const msg = this.d.db.addMessage({ chatId: live.chatId, parentId: live.threadRoot ?? live.currentMessageId, author: "system",
      role: live.role.name, content: `🔐 **${agentLabel(live, live.role.title)}** wants to run a **${r.kind}** action:\n\n\`${r.title}\`\n\n\`\`\`\n${r.detail}\n\`\`\`\n${r.forcedBy ? `Asking because of \`${r.forcedBy.slice(0, 200)}\`.\n` : ""}React ✅ to allow or ❌ to deny.` });
    this.d.emit({ type: "message.created", message: msg });
    this.setStatus(live, "running", "Waiting for your approval");
    live.awaitingApproval = true;
    this.flow(live.agentId, { kind: "approval", label: `${r.kind}: ${r.title}`, status: "waiting" });
    this.d.emit({ type: "notice", level: "warn", text: `${agentLabel(live, live.role.title)} is waiting for approval` });
    return new Promise((resolve) => {
      this.pendingPermissions.set(msg.id, (allow) => {
        live.awaitingApproval = false;
        live.lastOutputAt = Date.now();
        this.flow(live.agentId, { kind: "approval", label: `${r.kind}: ${r.title}`, status: allow ? "allowed" : "denied" });
        resolve(allow);
      });
      setTimeout(() => { const r2 = this.pendingPermissions.get(msg.id); if (r2) { this.pendingPermissions.delete(msg.id); r2(false); } }, 10 * 60 * 1000);
    });
  }

  private checkBudgets(live: Live, chat: Chat): boolean {
    const s = this.d.settings().tokens;
    const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
    const agent = this.d.db.getAgent(live.agentId)!;
    const checks: [string, number, number][] = [
      ["daily", this.d.db.tokensSince(startOfDay.getTime()), s.dailyBudget],
      ["project", chat.projectId ? this.d.db.tokensSince(startOfDay.getTime(), { projectId: chat.projectId }) : 0, s.projectBudget],
      ["agent", agent.tokensIn + agent.tokensOut, s.agentBudget],
    ];
    for (const [name, used, limit] of checks) {
      const st = budgetState(used, limit, s.warnAtPercent);
      if (st === "warn") this.d.emit({ type: "notice", level: "warn", text: `${name} token budget at ${Math.round((used / limit) * 100)}%` });
      if (st === "exceeded") {
        this.system(chat.id, live.threadRoot, `🛑 ${name} token budget exceeded (${used.toLocaleString()} / ${limit.toLocaleString()}). ` +
          (s.onBudgetExceeded === "warn" ? "Continuing (warn-only)." : `Agent ${s.onBudgetExceeded === "stop" ? "stopped" : "paused"}. Raise the budget in Settings → Token efficiency.`), "warn");
        if (s.onBudgetExceeded === "stop") { void this.stop(live.agentId); return true; }
        if (s.onBudgetExceeded === "pause") { live.paused = true; this.setStatus(live, "paused", `${name} budget exceeded`); return true; }
      }
    }
    return false;
  }

  // ------------------------------------------------------------------ helpers

  private ensureLive(chat: Chat, threadRoot: string | null, role: RoleDef, depth: number, keyOverride?: string,
    parentAgentId?: string, brief?: string, pick?: { harness?: HarnessId; model: string | null; local?: boolean }): Live {
    const key = keyOverride ?? `${chat.id}|${threadRoot ?? "main"}|${role.name}`;
    const existing = this.live.get(key);
    if (existing) return existing;
    const s = this.d.settings();
    // A local-only agent runs on a local model, whatever the chat, drive mode, economy routing or default harness say,
    // and is not started at all when there is none (a hosted run would only refuse the work).
    const localPick = role.local || pick?.local
      ? pickLocalRuntime({ role, pick, localMode: s.modes.local, usable: (h) => this.d.harnesses.resolve(h, s) === h })
      : null;
    if (localPick && "error" in localPick) throw new Error(`${role.title} was not started: ${localPick.error}`);
    const override = s.agents.roleOverrides[role.name];
    const mode = chat.mode ? s.modes[chat.mode] : null;
    let requested = (mode?.harness || null) ?? (chat.agentRole === role.name ? chat.harness : null) ?? override?.harness ?? role.harness ?? null;
    // The chat's own coordinator on GitLab Duo: only in project chats, where Duo starts in the project folder.
    const duoMain = depth === 0 && !parentAgentId && !pick && !keyOverride && chat.agentRole === role.name && !mode?.harness;
    const usual = this.d.harnesses.resolve((chat.harness !== "duo" ? chat.harness : null) ?? override?.harness ?? role.harness ?? null, s);
    const duoCoord = duoMain && !role.local && (s.duo.coordinator || chat.harness === "duo");
    if (duoCoord && !chat.projectId) {
      if (chat.harness === "duo") this.system(chat.id, threadRoot, `GitLab Duo runs the coordinator only in chats with a project folder, so ${role.title} runs on **${usual}** here.`);
      requested = usual;
    } else if (duoCoord) requested = "duo";
    // Economy routing: delegated specialists can run on a cheaper harness/model.
    const economy = !!parentAgentId && s.tokens.economyForDelegated && !!s.tokens.economyHarness;
    // An explicit harness from the coordinator (the user asked for "the Pi agent") wins over economy routing.
    const harness = localPick ? localPick.harness : this.d.harnesses.resolve(pick?.harness ?? (economy ? (s.tokens.economyHarness as HarnessId) : requested), s);
    // The coordinator's model goes with its harness (or with whatever harness runs the role when it named none);
    // a harness it asked for that isn't available drops the model, which belongs to that harness.
    const baseModel = localPick ? localPick.model : pick?.model && (!pick.harness || harness === pick.harness) ? pick.model
      : pick?.harness && harness === pick.harness ? null : economy && s.tokens.economyModel ? s.tokens.economyModel : null;
    const onDuo = duoCoord && !!chat.projectId && harness === "duo" && !localPick;
    // Opus 5.5 by default (Settings → Harnesses → GitLab Duo); a model picked for the chat on Duo wins, and the chat's
    // Duo mode (ECO / COMFORT / SPORT) wins over both, for every Duo agent of the chat.
    const duoPick = harness === "duo" && !localPick ? duoModeProfile(chat, s)?.model.trim() || null : null;
    const model = duoPick ?? (onDuo ? (chat.harness === "duo" && chat.model ? chat.model : s.duo.coordinatorModel.trim() || null) : baseModel);
    const askedFor = pick?.harness ?? requested;
    if (localPick && askedFor && askedFor !== harness)
      this.system(chat.id, threadRoot, `🏠 ${role.title} must run on a local model, so it runs on **${harness}** · ${model} instead of ${askedFor}.`);
    // Delegated specialists get a given name, unique in the chat, so parallel copies of one role can be told apart.
    const name = parentAgentId ? pickInstanceName(this.d.db.agentNamesInChat(chat.id)) : null;
    const agent = this.d.db.createAgent({ projectId: chat.projectId, chatId: chat.id, role: role.name, harness, model,
      parentAgentId: parentAgentId ?? null, brief: brief ?? `Chat: ${chat.title}`, name });
    const l: Live = { key, agentId: agent.id, name, chatId: chat.id, threadRoot, role, harness, model, session: null, sessionTokens: 0, busy: false,
      paused: false, queue: [], depth, currentMessageId: null, waiters: [], lastResult: null, stopped: false, sink: null, redirect: null, awaiting: [],
      parentAgentId: parentAgentId ?? null, local: localPick ? { source: localPick.source } : null,
      duoCoordinator: onDuo ? { fallback: usual !== "duo" ? usual : this.d.harnesses.alternative("duo", s) ?? "mock", explicit: chat.harness === "duo" } : null };
    this.live.set(key, l);
    this.byAgent.set(agent.id, l);
    this.emitAgent(agent);
    return l;
  }

  /**
   * A specialist on a hosted harness that stopped because its work must stay on a local model: tell the delegating agent
   * exactly how to re-run it locally (or that no local model is set up), so it fixes the blocker instead of passing it on.
   */
  private localityHint(live: Live, text: string): string {
    if (live.local || isLocalHarness(live.harness) || !needsLocalInference(text)) return "";
    const s = this.d.settings();
    const p = pickLocalRuntime({ role: live.role, localMode: s.modes.local, usable: (h) => this.d.harnesses.resolve(h, s) === h });
    return "error" in p
      ? `\nLocality: it refused because it ran on ${live.harness} (hosted) and its work must stay on a local model, but no local model is set up. That is a setup step only the user can do: ask them to set Settings → Modes → LOCAL to Pi or OpenCode with their local model.`
      : `\nLocality: it refused because it ran on ${live.harness} (hosted) and its work must stay on a local model. Re-delegate the same brief now with local: true (text mode: DELEGATE ${live.role.name}@${p.harness} model "${p.model}": …); it will run on ${p.harness} · ${p.model}. Don't ask the user.`;
  }

  /**
   * A coordinator put on GitLab Duo by the setting, in a project that isn't a GitLab repo: it runs on its usual harness
   * instead (Duo would only refuse the folder). Picking Duo for the chat keeps Duo, and its start explains the problem.
   */
  private async duoCoordinatorFallback(live: Live, folder: string, chat: Chat): Promise<void> {
    const dc = live.duoCoordinator;
    if (!dc || dc.explicit || live.harness !== "duo") return;
    const problem = await gitlabRepoProblem(folder, duoGitlabHosts(this.d.settings().duo));
    if (!problem) return;
    live.duoCoordinator = null;
    live.harness = dc.fallback;
    live.model = null;
    this.emitAgent(this.d.db.updateAgent(live.agentId, { harness: dc.fallback, model: null }));
    this.system(chat.id, live.threadRoot, `This project isn't a GitLab repository, so ${live.role.title} runs on **${dc.fallback}** here instead of GitLab Duo.`);
  }

  /** Agents expected to hand work to specialists: the coordinator (and its custom copies at depth 0). */
  private coordinates(live: Live, s: Settings): boolean {
    return live.depth === 0 && live.harness !== "mock" && s.agents.delegationDepth > 0 && (live.role.name === "flashmaster" || /delegate/i.test(live.role.description ?? "")
      || this.duoOrchestrates(live, s));
  }

  /** The chat's own coordinator on GitLab Duo is always the orchestrator (never gets the Duo specialist brief). */
  private duoOrchestrates(live: Live, s: Settings): boolean {
    return live.harness === "duo" && !!live.duoCoordinator && live.depth === 0 && !live.parentAgentId && s.agents.delegationDepth > 0;
  }

  private duoOrchestratorBrief(s: Settings): string {
    const extra = s.duo.orchestratorRules?.trim();
    return extra ? `${DUO_ORCHESTRATOR_RULES}\n\n### Your user's instructions for orchestrating\n${extra}` : DUO_ORCHESTRATOR_RULES;
  }

  private enterTextDelegation(live: Live, t: { chat: Chat; threadRoot: string | null; role: RoleDef }, why: "missing" | "hidden" = "missing"): void {
    live.textDelegation = true;
    if (live.warnedTools) return;
    live.warnedTools = true;
    const blocked = live.harness === "copilot" && copilotMcpBlocked(this.d.homeDir);
    if (why === "hidden" && !blocked) {
      this.system(t.chat.id, t.threadRoot, `⚠️ **${live.harness}** started TheFlashMaster's tool server and read its tools, but didn't give them to ${t.role.title}`
        + " (most likely an organisation policy that filters MCP tools). Delegation runs in text mode instead: the coordinator writes `DELEGATE` lines"
        + " and TheFlashMaster starts the specialists.", "warn");
      return;
    }
    this.system(t.chat.id, t.threadRoot, `⚠️ ${t.role.title}'s \`delegate\` tool did not load in **${live.harness}**`
      + (live.harness === "pi" ? " (Pi has no MCP support)" : blocked ? ": Copilot reports **MCP servers blocked by policy**. Your organisation's *MCP servers in Copilot* policy is off; ask your GitHub admin to enable it" : "")
      + ". Delegation runs in text mode instead: the coordinator writes `DELEGATE` lines and TheFlashMaster starts the specialists."
      + (blocked || live.harness === "pi" ? "" : " Check **Settings → MCP → Test tool servers** for the cause."), "warn");
  }

  /** Harnesses start their MCP servers alongside the session: give them a moment to list the app's tools. */
  private async waitForTools(live: Live, ms: number): Promise<boolean> {
    if (live.harness === "pi") return false; // Pi has no MCP support
    if (!this.d.toolsLoaded) return true;
    const t0 = Date.now();
    while (!this.d.toolsLoaded(live.agentId)) {
      if (Date.now() - t0 > ms || live.stopped) return false;
      await new Promise((r) => setTimeout(r, 200));
    }
    return true;
  }

  /** Carry out DELEGATE lines from a coordinator in text mode, then feed the results back to it. */
  /** The app's own tools this agent's role may use (sets: core, plus jazz when the role has it). */
  private toolSetFor(live: Live): (ToolInfo & { set: string })[] {
    if (!this.d.listTools) return [];
    // Vector's CANoe MCP tools (when a Vector server is connected) go to every agent, like the core set.
    const sets = ["core", ...(live.role.tools.includes("jazz") || jazzToolsOn(this.d.settings().jazz) ? ["jazz"] : []), "vector"];
    return sets.flatMap((set) => this.d.listTools!(set).map((x) => ({ ...x, set })));
  }
  private textToolsFor(live: Live): string {
    // A coordinator in text-delegation mode already has DELEGATE/AGENT; list the other tools for it.
    const list = this.toolSetFor(live).filter((x) => !(live.textDelegation && ["delegate", "create_agent", "get_result"].includes(x.name)));
    return list.length ? textToolRules(list) : "";
  }

  private async runTextDelegations(live: Live, t: Parameters<Orchestrator["turn"]>[0], reqs: TextDelegation[],
    calls: import("./context").TextToolCall[] = []): Promise<void> {
    const round = (t.textRound ?? 0) + 1;
    if (round > MAX_TEXT_ROUNDS) {
      this.system(t.chat.id, t.threadRoot, `⚠️ Stopped after ${MAX_TEXT_ROUNDS} rounds of text-mode calls. Send a message to continue.`, "warn");
      return;
    }
    const created: string[] = [];
    for (const ag of live.textDelegation ? parseTextAgents(live.lastText ?? "") : []) {
      try {
        const r = await this.createAgent(live.agentId, { name: ag.name, description: ag.description, instructions: ag.instructions, harness: ag.harness });
        created.push(`### ${r.role}\nCreated (${r.created}).`);
      } catch (e) { created.push(`### ${ag.name}\nNot created: ${String((e as Error)?.message ?? e)}`); }
    }
    const known = new Set(this.d.roles().map((r) => r.name));
    const runnable = reqs.filter((r) => known.has(r.role) && r.role !== live.role.name);
    if (runnable.length) {
      const cap = this.d.settings().agents.maxParallelSpecialists;
      const free = cap > 0 ? Math.max(0, cap - this.teamWorking(this.teamRoot(live.agentId)).length) : runnable.length;
      const later = runnable.length - free;
      this.system(t.chat.id, live.lastReplyId ?? t.threadRoot, `↪ Delegating: ${runnable.map((r) => `**${r.role}**${r.harness ? ` on ${r.harness}` : ""}${r.model ? ` (${r.model})` : ""}${r.folder ? ` in ${r.folder}` : ""}`).join(", ")}`
        + (later > 0 ? ` · ${cap} at a time, ${later} wait${later === 1 ? "s" : ""} for a free specialist` : ""));
    }
    live.textWaiting = (live.textWaiting ?? 0) + 1;
    const results = created.concat(await Promise.all(reqs.map(async (r) => {
      if (!known.has(r.role) || r.role === live.role.name) return `### ${r.role}
Not run: unknown role. Available: ${[...known].filter((n) => n !== live.role.name).join(", ")}.`;
      try {
        const x = await this.delegate(live.agentId, { role: r.role, goal: r.goal, harness: r.harness, folder: r.folder, model: r.model, args: r.args, agentId: r.agentId, mode: r.mode, attempts: r.attempts, wait: true, timeoutSec: 1800 });
        return `### ${r.role}${x.name ? ` · ${x.name}` : ""}${x.harness ? ` (${x.harness}${x.model ? ` · ${x.model}` : ""})` : ""}
${x.result ?? `status: ${x.status}`}`;
      } catch (e) { return `### ${r.role}
Failed: ${String((e as Error)?.message ?? e)}`; }
    })));
    live.textWaiting = Math.max(0, (live.textWaiting ?? 1) - 1);
    const sets = new Map(this.toolSetFor(live).map((x) => [x.name, x.set]));
    const toolResults: string[] = [];
    const runs: ToolRun[] = [];
    for (const c of calls) {
      if (c.error) { toolResults.push(`### ${c.name}\nNot run: ${c.error}`); continue; }
      const run: ToolRun = { id: `${live.lastReplyId}:t${runs.length}`, title: `${c.name} (text mode)`, kind: "other", status: "in_progress",
        input: JSON.stringify(c.args, null, 1), startedAt: Date.now() };
      runs.push(run);
      this.flow(live.agentId, { kind: "tool", label: `${c.name} (text mode)`, status: "completed" });
      try {
        const out = await this.d.callTool!(c.name, c.args, live.agentId, sets.get(c.name));
        const json = typeof out === "string" ? out : JSON.stringify(out, null, 1);
        toolResults.push(`### ${c.name}\n${json.length > 12000 ? `${json.slice(0, 12000)}\n… (truncated)` : json}`);
        const cap = capOutput(json);
        Object.assign(run, { status: "completed", output: cap.text, truncated: cap.truncated, endedAt: Date.now() });
      } catch (e) {
        toolResults.push(`### ${c.name}\nError: ${String((e as Error)?.message ?? e)}`);
        Object.assign(run, { status: "failed", output: String((e as Error)?.message ?? e), endedAt: Date.now() });
      }
    }
    if (runs.length && live.lastReplyId) {
      const m = this.d.db.getMessage(live.lastReplyId);
      if (m) { const all = [...(m.tools ?? []), ...runs]; this.d.db.setMessageTools(m.id, all); this.d.emit({ type: "message.tools", messageId: m.id, chatId: m.chatId, tools: all }); }
    }
    if (live.stopped || !this.live.has(live.key)) return;
    const parts = [results.length ? `## Specialist results\n${results.join("\n\n")}` : "", toolResults.length ? `## Tool results\n${toolResults.join("\n\n")}` : ""].filter(Boolean);
    void this.turn({ ...t, retry: false, input: `${parts.join("\n\n")}\n\nContinue: integrate these results and answer, or make further calls the same way.`,
      attachments: [], skills: [], brief: null, taskId: undefined, liveKey: live.key, msgIds: undefined, deliver: false, borrowSlot: false, textRound: round });
  }

  /**
   * Upsert a tool call of the current reply. Returns true when it is new or its status changed (worth a status line).
   * Output is capped per call (head + tail) so a noisy build can't bloat the chat or the database.
   */
  /** Reasoning chunks become one "think" run per block, shown in place between the reply's paragraphs. */
  private recordThought(live: Live, chunk: string): void {
    if (!live.thought) {
      live.thoughts = (live.thoughts ?? 0) + 1;
      live.thought = { key: `think-${live.thoughts}`, text: "" };
      this.setStatus(live, "running", "Thinking…");
    }
    live.thought.text += chunk;
    live.textBreak = true;
    this.recordTool(live, { id: live.thought.key, title: "Thinking", status: "in_progress", kind: "think", output: live.thought.text });
  }

  private endThought(live: Live): void {
    const th = live.thought;
    if (!th) return;
    live.thought = null;
    this.recordTool(live, { id: th.key, title: "Thinking", status: "completed", kind: "think" });
  }

  private recordTool(live: Live, e: { id?: string; title: string; status: string; kind: string; input?: string; output?: string }): boolean {
    const msgId = live.currentMessageId;
    if (!msgId) return true;
    const tools = (live.tools ??= new Map());
    // Without an id (mock harness), an update belongs to the newest unfinished call with the same title.
    let key = e.id ?? "";
    if (!key) {
      const open = [...tools.entries()].reverse().find(([, x]) => x.title === e.title && x.status !== "completed" && x.status !== "failed");
      key = open?.[0] ?? `${e.title}#${tools.size}`;
    }
    const prev = tools.get(key);
    const status = (prev?.stopped ? "failed" : ["pending", "in_progress", "completed", "failed"].includes(e.status) ? e.status : prev?.status ?? "in_progress") as ToolRun["status"];
    const capped = e.output !== undefined ? capOutput(e.output) : null;
    const run: ToolRun = {
      id: prev?.id ?? `${msgId}:${tools.size}`, title: e.title || prev?.title || "tool", kind: (e.kind && e.kind !== "other" ? e.kind : prev?.kind) || e.kind || "other", status,
      input: e.input ?? prev?.input, output: capped ? capped.text : prev?.output, truncated: capped ? capped.truncated : prev?.truncated,
      startedAt: prev?.startedAt ?? Date.now(), endedAt: status === "completed" || status === "failed" ? prev?.endedAt ?? Date.now() : undefined,
      at: prev ? prev.at : this.liveText.get(msgId)?.length ?? 0, stopped: prev?.stopped,
    };
    if (tools.size >= MAX_TOOLS_PER_REPLY && !prev) return false;
    tools.set(key, run);
    if (!live.toolsTimer) live.toolsTimer = setTimeout(() => { live.toolsTimer = null; this.flushTools(live, msgId, live.chatId); }, 400);
    return !prev || prev.status !== status;
  }

  /** Send the reply's tool calls to the UI and keep them with the message. */
  private flushTools(live: Live, messageId: string, chatId: string): void {
    if (live.toolsTimer) { clearTimeout(live.toolsTimer); live.toolsTimer = null; }
    const tools = [...(live.tools?.values() ?? [])];
    if (!tools.length) return;
    this.d.db.setMessageTools(messageId, tools);
    this.d.emit({ type: "message.tools", messageId, chatId, tools });
  }

  /** Record a progress event for the flow chart and notify the UI. */
  private flow(agentId: string, e: { kind: import("@shared/types").AgentEvent["kind"]; label: string; status?: string | null; ref?: string | null }): void {
    this.d.db.addEvent({ agentId, ...e });
    this.d.emit({ type: "flow.updated", agentId });
  }

  /** Plan published by the harness (ACP plan updates) or by the agent via report_progress. */
  setPlan(agentId: string, plan: import("@shared/types").PlanStep[]): void {
    this.d.db.setPlan(agentId, plan);
    const cur = plan.find((p) => p.status === "in_progress");
    const done = plan.filter((p) => p.status === "completed").length;
    this.emitAgent(this.d.db.updateAgent(agentId, { lastActivity: cur ? `Step ${done + 1}/${plan.length}: ${cur.title}` : `${done}/${plan.length} steps done` }));
    this.d.emit({ type: "flow.updated", agentId });
  }

  /** The coordinator at the top of an agent's delegation tree (the agent itself when nobody delegated to it). */
  private teamRoot(agentId: string): string {
    let id = agentId;
    for (let i = 0; i < 12; i++) {
      const up = this.byAgent.get(id)?.parentAgentId ?? this.d.db.getAgent(id)?.parentAgentId ?? null;
      if (!up) break;
      id = up;
    }
    return id;
  }

  /**
   * Agents of one coordinator's tree that are working or waiting to (busy, or with queued input): its specialists and
   * their helpers, at any depth. A specialist that is waiting for its own helper (delegate with wait) hands its place
   * to that helper, so a chain specialist → helper counts once and nested delegation can never wait on itself.
   */
  private teamWorking(rootAgentId: string): Live[] {
    const all = [...this.byAgent.values()];
    const working = (l: Live) => !l.stopped && (l.busy || l.queue.length > 0);
    const handedOff = (l: Live) => all.some((c) => c.parentAgentId === l.agentId && c.waiters.length > 0 && working(c));
    return all.filter((l) => l.agentId !== rootAgentId && working(l) && !handedOff(l) && this.teamRoot(l.agentId) === rootAgentId);
  }

  /** The specialists this agent itself started that are still working (for its own messages). */
  private ownWorking(parentAgentId: string): Live[] {
    return [...this.byAgent.values()].filter((l) => l.parentAgentId === parentAgentId && !l.stopped && (l.busy || l.queue.length > 0));
  }

  /**
   * Wait until the coordinator has fewer than maxParallelSpecialists specialists working. A background delegation
   * (wait: false) is refused instead, with the names of the working ones and of finished ones it can reuse.
   */
  private async waitForTeamSlot(parent: Live, background: boolean): Promise<string | null> {
    const cap = this.d.settings().agents.maxParallelSpecialists;
    if (!(cap > 0)) return null;
    // A specialist that waits for its helper lends it its own place in the team (see teamWorking): no queueing, no deadlock.
    if (parent.depth > 0 && !background) return null;
    const root = this.teamRoot(parent.agentId);
    const taken = () => this.teamWorking(root).length + (this.teamReserved.get(root) ?? 0);
    const reserve = () => { this.teamReserved.set(root, (this.teamReserved.get(root) ?? 0) + 1); return root; };
    const working = this.teamWorking(root);
    if (taken() < cap) return reserve();
    if (background) {
      const idle = [...this.byAgent.values()].filter((l) => l.parentAgentId === parent.agentId && !l.stopped && !l.busy && !l.queue.length);
      throw new Error(`${working.length} of your specialists are already working (${working.map((l) => agentLabel(l, l.role.title)).join(", ")}); `
        + `at most ${cap} work at once (Settings → Agents). Don't start more: their results come to you as they finish. `
        + (idle.length ? `Send related work to a finished one with its agentId: ${idle.map((l) => `${agentLabel(l, l.role.title)} = ${l.agentId}`).join(", ")}.` : "Delegate the rest after one finishes."));
    }
    if (parent.busy) this.setStatus(parent, "running", `⏳ ${working.length}/${cap} specialists working; the next one starts when one finishes`);
    while (taken() >= cap) {
      await new Promise<void>((r) => { const list = this.teamWaiters.get(root) ?? []; list.push(r); this.teamWaiters.set(root, list); });
      if (parent.stopped) throw new Error("stopped by user");
    }
    return reserve();
  }

  private unreserveTeamSlot(rootAgentId: string): void {
    const n = (this.teamReserved.get(rootAgentId) ?? 1) - 1;
    if (n > 0) this.teamReserved.set(rootAgentId, n); else this.teamReserved.delete(rootAgentId);
    this.teamSlotFreed(rootAgentId);
  }

  /** An agent of this coordinator's tree finished a turn: let one waiting delegation re-check. */
  private teamSlotFreed(fromAgentId: string): void {
    const rootAgentId = this.teamRoot(fromAgentId);
    const list = this.teamWaiters.get(rootAgentId);
    const next = list?.shift();
    if (list && !list.length) this.teamWaiters.delete(rootAgentId);
    if (next) queueMicrotask(next);
  }

  /**
   * A delegated task ended. A delegating agent still waiting for it (delegate with wait) gets the result directly;
   * otherwise (background delegation, timed-out wait, a harness that dropped the tool call) the result is sent to it as
   * a new message, so the coordinator continues instead of sitting idle. Results that finish close together go in one message.
   */
  private finishDelegated(l: Live, result: string): void {
    if (l.delegateSpan) {
      this.d.traces?.end(l.delegateSpan, { status: /^error:|^failed/.test(result) ? "error" : result === "stopped" ? "stopped" : "ok", attrs: { "flash.result": result.slice(0, 300) } });
      l.delegateSpan = undefined;
    }
    const parent = l.parentAgentId ? this.byAgent.get(l.parentAgentId) : undefined;
    const listening = l.waiters.length > 0 && !!parent && (parent.busy || (parent.textWaiting ?? 0) > 0);
    this.finishWaiters(l, result);
    if (l.inPlan) { l.inPlan = false; l.delegated = false; return; }
    if (!l.delegated) return;
    l.delegated = false;
    if (listening || !parent || parent.stopped || l.stopped || result === "stopped") return;
    const r = this.reports.get(parent.agentId) ?? { live: parent, result: "", timer: null, items: [] };
    r.items = r.items.filter((x) => x.l !== l).concat({ l, result });
    this.reports.set(parent.agentId, r);
    this.scheduleReport(parent.agentId, REPORT_DEBOUNCE_MS);
  }

  private scheduleReport(parentAgentId: string, ms: number): void {
    const r = this.reports.get(parentAgentId);
    if (!r) return;
    if (r.timer) clearTimeout(r.timer);
    r.timer = setTimeout(() => this.deliverReports(parentAgentId), ms);
  }

  /** Wake the coordinator with the results that arrived while it wasn't waiting (once it is free). */
  private deliverReports(parentAgentId: string): void {
    const r = this.reports.get(parentAgentId);
    if (!r) return;
    r.timer = null;
    const parent = this.byAgent.get(parentAgentId);
    if (!parent || parent.stopped || !this.live.has(parent.key)) { this.reports.delete(parentAgentId); return; }
    // Busy (or the app is still collecting its text-mode results): try again when it is free, so nothing is lost.
    if (parent.busy || (parent.textWaiting ?? 0) > 0) { this.scheduleReport(parentAgentId, REPORT_DEBOUNCE_MS); return; }
    this.reports.delete(parentAgentId);
    const items = r.items.filter((x) => !x.l.resultTaken);
    if (!items.length) return;
    const chat = this.d.db.getChat(parent.chatId);
    if (!chat) return;
    const still = this.ownWorking(parentAgentId).map((l) => agentLabel(l, l.role.title));
    const names = items.map((x) => agentLabel(x.l, x.l.role.title));
    this.flow(parentAgentId, { kind: "status", label: `woken: ${names.join(", ")} finished`, status: "running" });
    const input = [`## Specialist results`, ...items.map((x) => `### ${agentLabel(x.l, x.l.role.title)} (${x.l.role.name}, agentId ${x.l.agentId})\n${x.result}`),
      still.length ? `Still working: ${still.join(", ")}. Their results come in a later message.` : "All your specialists have finished.",
      "Continue: integrate these results. If the request is complete, answer the user; otherwise delegate the next step (a follow-up with agentId when it builds on this work). "
        + "A specialist that asks, is blocked or failed is yours to untangle first; go to the user only for access, a change to their goal, or an irreversible step."].join("\n\n");
    void this.turn({ chat, threadRoot: parent.threadRoot, role: parent.role, input, skills: [], depth: parent.depth, brief: null, liveKey: parent.key, deliver: false, textRound: 0 })
      .catch((e) => this.system(chat.id, parent.threadRoot, `⚠️ ${String(e?.message ?? e)}`, "error"));
  }

  private finishWaiters(l: Live, result: string): void {
    for (const w of l.waiters.splice(0)) w(result);
  }

  /**
   * A specialist reported that it needs a decision, is blocked, or failed. Its delegating agent gets this in the
   * result as usual; the user also sees it right away in the thread and as a notice, without waiting for the coordinator.
   */
  private surfaceSaid(l: Live, chatId: string, threadRoot: string | null, said: Exclude<ResultStatus, "done">, asks: string, options: string[] = []): void {
    const who = `${l.role.icon} ${agentLabel(l, l.role.title)}`;
    // A question or blocker is a "needs you" card (unless the agent already raised one with ask_user this turn).
    // A delegated specialist's question, blocker or failure goes to the agent that delegated to it (in its result), which
    // untangles it; the thread shows it, but the user isn't pinged: they hear from the coordinator when it needs them.
    if (l.parentAgentId && l.depth > 0) {
      const parent = this.byAgent.get(l.parentAgentId);
      this.system(chatId, threadRoot, `${said === "failed" ? "⚠️" : "↪"} **${who}** ${SAID_LABEL[said].toLowerCase()}: ${asks}. Sent to ${parent ? agentLabel(parent, parent.role.title) : "the agent that delegated to it"} to handle.`);
      this.emitAgent(this.d.db.updateAgent(l.agentId, { lastActivity: `${SAID_LABEL[said]} (sent to ${parent ? agentLabel(parent, parent.role.title) : "its delegating agent"}): ${asks}`.slice(0, 300) }));
      return;
    }
    if (said === "needs_decision" || said === "blocked") {
      if (!l.askedThisTurn) this.raiseAsk(l, chatId, { kind: said === "blocked" ? "blocked" : "question", agentId: l.agentId, who, question: asks.slice(0, 600),
        why: said === "blocked" ? `${agentLabel(l, l.role.title)} is blocked and can't go on without you.` : null, options, recommended: options.length ? 0 : null });
      this.emitAgent(this.d.db.updateAgent(l.agentId, { lastActivity: `${SAID_LABEL[said]}: ${asks}` }));
      return;
    }
    if (l.depth > 0) this.system(chatId, threadRoot, `⚠️ **${who}** ${SAID_LABEL[said].toLowerCase()}: ${asks}`);
    this.d.emit({ type: "notice", level: "error", text: `${who} ${SAID_LABEL[said].toLowerCase()}: ${asks}`.replace(/[*`]/g, "").slice(0, 140) });
  }

  private setStatus(l: Live, status: AgentRun["status"], activity: string): void {
    this.emitAgent(this.d.db.updateAgent(l.agentId, { status, lastActivity: activity }));
  }

  private emitAgent(a: AgentRun): void {
    this.d.emit({ type: "agent.updated", agent: a });
  }

  private system(chatId: string, parentId: string | null, content: string, level: "info" | "warn" | "error" = "info"): void {
    const m = this.d.db.addMessage({ chatId, parentId, author: "system", content });
    this.d.emit({ type: "message.created", message: m });
    if (level !== "info") this.d.emit({ type: "notice", level, text: content.replace(/[*`]/g, "").slice(0, 140) });
  }

  private role(name: string): RoleDef {
    const roles = this.d.roles();
    const r = roles.find((x) => x.name === name) ?? roles.find((x) => x.name === "flashmaster") ?? roles[0] ?? FALLBACK_ROLE;
    const o = this.d.settings().agents.roleOverrides[r.name];
    return o?.maxResultTokens ? { ...r, maxResultTokens: o.maxResultTokens } : r;
  }

  private threadRole(threadRoot: string): string | null {
    const root = this.d.db.getMessage(threadRoot);
    return root?.author === "agent" ? root.role : null;
  }

  private activeSkills(chat: Chat, command: string | null): SkillDef[] {
    const skills = this.skillsFor(chat);
    if (command) {
      const s = skills.find((k) => k.command === command);
      if (s) return [s];
    }
    // Superpowers on: only the compact workflow index is sent; individual skills load via slash commands.
    if (chat.superpowers) return skills.filter((k) => k.command === "superpowers-index");
    return [];
  }

  private mustChat(id: string): Chat {
    const c = this.d.db.getChat(id);
    if (!c) throw new Error("chat not found");
    return c;
  }

  private helpText(): string {
    const cmds = this.d.skills().filter((s) => s.command !== "superpowers-index").map((s) => `\`/${s.command}\` — ${s.description}`);
    const roles = this.d.roles().map((r) => `\`@${r.name}\` — ${r.title}`);
    return ["**Commands**", "`/superpowers` — toggle the superpowers workflow for this chat", "`/stop` — stop agents in this chat",
      "`/kb` — build or update this project's knowledge base (add words to focus it)", "`/kb-sync` — sync the knowledge base with .flashmaster/knowledge in the repo",
      ...cmds, "", "**Specialists** (mention to route a message)", ...roles].join("\n");
  }

  private acquireSlot(max: number): Promise<void> {
    if (this.running < max) { this.running++; return Promise.resolve(); }
    return new Promise((r) => this.slotWaiters.push(() => { this.running++; r(); }));
  }

  private releaseSlot(): void {
    this.running = Math.max(0, this.running - 1);
    this.slotWaiters.shift()?.();
  }

  private memoryOn(): boolean {
    return !!this.d.memory && this.d.settings().memory?.enabled !== false;
  }

  /**
   * Memories to put in front of the agent for this turn: on a new session the pinned ones and the best matches for the
   * request; on later turns only relevant ones it has not been shown yet (so a long chat is not re-sent the same lines).
   */
  private recallMemory(live: Live, chat: Chat, query: string, first: boolean): string {
    const ms = this.d.settings().memory;
    if (!this.memoryOn() || !ms?.autoInject) return "";
    if (first || !live.memoryShown) live.memoryShown = new Set();
    try {
      const r = this.d.memory!.recall(query.slice(0, 4000), { projectId: chat.projectId, chatId: chat.id },
        { max: first ? ms.maxInjected : Math.ceil(ms.maxInjected / 2), exclude: live.memoryShown, minRelevance: first ? 0.25 : 0.4 });
      for (const id of r.ids) live.memoryShown.add(id);
      return r.text;
    } catch (e) {
      this.d.log?.("warn", `memory recall: ${String(e)}`);
      return "";
    }
  }

  /** A delegated specialist's result becomes a short-term memory of the chat, so the other agents there know what it did. */
  private captureResult(live: Live, chat: Chat, role: RoleDef, summary: string): void {
    if (!live.name || !this.memoryOn() || !this.d.settings().memory?.captureResults) return;
    const text = summary.replace(/\s+/g, " ").trim();
    if (text.length < 20) return;
    try {
      this.d.memory!.save({ content: `${live.name} (${role.title}) finished: ${text.slice(0, 600)}`, scope: "session", kind: "episode", importance: 2, tags: [role.name] },
        { projectId: chat.projectId, chatId: chat.id, agentId: live.agentId, role: role.name });
      this.d.emit({ type: "memory.changed" });
    } catch (e) {
      this.d.log?.("warn", `memory capture: ${String(e)}`);
    }
  }

  /** Used by the bridge: tasks created by agents get the agent's project. */
  agentProject(agentId: string): string | null {
    return this.d.db.getAgent(agentId)?.projectId ?? null;
  }

  /** Folder an agent works in (its worktree, delegated folder, the project root, or the no-project folder); null when it has none. */
  agentWorkDir(agentId: string): string | null {
    const live = [...this.live.values()].find((l) => l.agentId === agentId);
    const a = this.d.db.getAgent(agentId);
    const project = a?.projectId ? this.d.db.getProject(a.projectId)?.path ?? null : null;
    return live?.worktree ?? live?.folder ?? project ?? (a && !a.projectId ? this.noProjectDir() : null);
  }

  runTask(task: Task, roleName?: string): Promise<AgentRun> {
    const brief = buildBrief({ goal: task.title, context: [task.description, task.jazzId ? `Jazz work item: ${task.jazzId} (use jazz_get for details)` : ""].filter(Boolean).join("\n") });
    return this.startAgent(task.projectId, roleName ?? task.assigneeRole ?? "flashmaster", brief, task.id);
  }
}

const FALLBACK_ROLE: RoleDef = {
  name: "flashmaster", title: "TheFlashMaster", icon: "⚡", description: "Coordinator", tools: ["flashmaster-core"], maxResultTokens: 400,
  skills: [], prompt: "You are TheFlashMaster, the coordinating agent.", source: "builtin",
};

export function isTransientNetworkError(e: string | undefined): boolean {
  return !!e && /connection error|UND_ERR_SOCKET|other side closed|ECONNRESET|socket hang up|ETIMEDOUT|EAI_AGAIN|\b50[234]\b|stream (closed|ended)|network/i.test(e);
}

/** How agents use the shared memory (sent once per session when memory is on). */
export const MEMORY_RULES = "Memory: you share a memory with the user's other agents (memory_search, memory_save, memory_update, memory_delete, memory_promote, memory_list). "
  + "Search it before asking the user something they may have told an agent before. Save durable knowledge as one self-contained fact per call: "
  + "the user's preferences and conventions → scope user; this project's decisions, facts, procedures and gotchas → scope project (shared with every specialist); "
  + "working notes for this chat → scope session (short-term, expires; promote what turns out to matter). "
  + "When a memory is wrong or outdated, update or delete it instead of saving a contradicting one. Never store secrets, tokens or passwords.";

/** Sent after a crash restart that resumed the session (or with the partial reply, when it could not). */
const CRASH_CONTINUE = "Your previous response was interrupted because the agent process exited. Continue exactly where you stopped; do not repeat what you already wrote.";
/** The model a delegation asks for: `provider/model` when a provider is given separately (Pi, OpenCode), else the model as is. */
export function delegateModel(model?: string | null, provider?: string | null): string | null {
  const m = model?.trim() || "";
  const p = provider?.trim().replace(/\/+$/, "") || "";
  if (!m) return null;
  return p && !m.toLowerCase().startsWith(`${p.toLowerCase()}/`) ? `${p}/${m}` : m;
}

/** Launch flags the app sets itself (protocol, session, read-only tools, permission bypasses): a delegation can't override them. */
const RESERVED_LAUNCH_FLAGS = /^--?(mode|session|no-session|tools|no-tools|acp|stdio|resume|continue|yolo|allow-all-tools|allow-all|dangerously[\w-]*|permission-mode)(=|$)/i;

/** Extra launch arguments from a delegation, or an error naming a flag the app owns. */
export function checkLaunchArgs(args?: string | null): string | null {
  const a = args?.trim();
  if (!a) return null;
  const bad = a.split(/\s+/).map((x) => x.replace(/^["']/, "")).filter((x) => RESERVED_LAUNCH_FLAGS.test(x));
  if (bad.length) throw new Error(`args can't set ${bad.join(", ")}: TheFlashMaster sets those itself. Pass only model options such as --provider, --model or --thinking.`);
  return a;
}

/** Errors that mean the harness process itself is gone (not a model or protocol error). */
const HARNESS_EXIT = /harness exited|failed to start|exited again after a restart/i;

export function networkEnv(s: Settings): Record<string, string> {
  const env: Record<string, string> = {};
  // The MCP servers reach the app over 127.0.0.1: make sure an inherited corporate proxy never intercepts that.
  const inherited = process.env.no_proxy || process.env.NO_PROXY || "";
  const local = "localhost,127.0.0.1";
  const np = [s.network.noProxy || inherited, local].filter(Boolean).join(",");
  Object.assign(env, { NO_PROXY: np, no_proxy: np });
  const proxy = cliProxyUrl(s.network.proxy); // "" for a PAC file: the CLIs can't use one, they keep the inherited environment
  if (proxy) Object.assign(env, { HTTPS_PROXY: proxy, HTTP_PROXY: proxy, https_proxy: proxy, http_proxy: proxy });
  if (s.network.caBundlePath) Object.assign(env, { NODE_EXTRA_CA_CERTS: s.network.caBundlePath, SSL_CERT_FILE: s.network.caBundlePath, REQUESTS_CA_BUNDLE: s.network.caBundlePath });
  return env;
}

/** The chat's GitLab Duo mode (Settings → Harnesses → GitLab Duo → modes), or null when it has none. */
export function duoModeProfile(chat: Pick<Chat, "duoMode">, s: Settings): DuoModeProfile | null {
  return chat.duoMode ? s.duo.modes?.[chat.duoMode] ?? null : null;
}
