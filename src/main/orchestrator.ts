/**
 * Orchestrator — runs every agent turn in the app.
 *
 * Everything is a chat turn: a user message in a chat (or thread) goes to the chat's role, or to the role
 * named with @mention. Delegated specialists run as thread replies under the delegating message, so the
 * user sees them without the coordinator's context ever containing their transcript.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { AgentRun, AppEvent, Attachment, Chat, HarnessId, Message, RoleDef, SkillDef, Task, ToolRun } from "@shared/types";
import { HARNESS_IDS } from "@shared/types";
import { cliProxyUrl } from "./proxy";
import type { Settings } from "@shared/settings";
import { diffLines } from "@shared/diff";
import type { Db } from "./db";
import type { HarnessRegistry } from "./harness/registry";
import type { HarnessSession, McpServerSpec, PermissionRequest } from "./harness/types";
import { canIsolate, createWorktree, defaultGit, mergeWorktree, removeWorktree, worktreeState, type Git, type WorkResult } from "./worktree";
import { prepareInstructions } from "./harness/instructions";
import { slugRole, type AgentSpec } from "./roles";
import {
  budgetState, buildBrief, buildTurnPrompt, estimateTokens, extractiveSummary, parseMention, parseSlash, planCompaction,
  parseResult, type ResultStatus, parseTextAgents, parseTextDelegations, parseTextToolCalls, resultForParent, textToolRules, type ToolInfo, TEXT_DELEGATION_RULES, type TextDelegation,
} from "./context";

export interface OrchestratorDeps {
  /** Git runner for agent worktrees (tests inject a fake). */
  git?: Git;
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
  log?: (level: "error" | "warn" | "info" | "debug", msg: string) => void;
  db: Db;
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
  chatId: string;
  threadRoot: string | null;
  role: RoleDef;
  harness: HarnessId;
  model: string | null; // forced model (economy routing); null = chat/role/harness default
  session: HarnessSession | null;
  sessionTokens: number; // estimated tokens accumulated in the harness session (drives rollover compaction)
  busy: boolean;
  paused: boolean;
  queue: { input: string; attachments: Attachment[]; msgIds?: string[] }[];
  /** Delivered steering/queued messages waiting to be seen: native = wait for the harness ack, else first model output. */
  awaiting: { id: string; native: boolean }[];
  redirect: { input: string; attachments: Attachment[]; msgIds: string[] } | null; // steering by interrupt: next turn input
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
  /** Last time the harness sent anything (text, tool update, plan…) during a turn; drives the stuck-agent watchdog. */
  lastOutputAt?: number;
  /** The watchdog already warned about this silence (cleared when output resumes). */
  stuckSince?: number | null;
  /** Waiting for the user to answer a permission request: silence is expected. */
  awaitingApproval?: boolean;
  currentMessageId: string | null;
  waiters: ((result: string) => void)[];
  lastResult: string | null;
  stopped: boolean;
  /** Where streamed text goes for the *current* turn. Sessions outlive turns, so this is swapped per turn. */
  sink: ((delta: string) => void) | null;
}

const MAX_CONCURRENT_FALLBACK = 4;
const MAX_TEXT_ROUNDS = 12;
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
  private slotWaiters: (() => void)[] = [];

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
    const steer = !!busyLive && (o.whileBusy ?? this.d.settings().chat.defaultSendWhileBusy) === "steer" && !parseSlash(content).command
      && (!mentioned || mentioned === busyLive.role.name);
    const queued = !!busyLive && !steer && !parseSlash(content).command && (!mentioned || mentioned === busyLive.role.name);
    const userMsg = this.d.db.addMessage({ chatId, parentId: threadRoot, author: "user", content, attachments, steer,
      delivery: steer ? "sent" : queued ? "queued" : undefined });
    this.d.emit({ type: "message.created", message: userMsg });
    if (steer && busyLive) { await this.steer(busyLive, content, attachments, userMsg.id); return userMsg; }

    const slash = parseSlash(content);
    if (slash.command === "superpowers") {
      const on = !chat.superpowers;
      this.d.db.updateChat(chatId, { superpowers: on });
      this.system(chatId, threadRoot, on
        ? "⚡ Superpowers workflow **enabled** for this chat. Agents will brainstorm → plan → implement with TDD → review → verify. Use `/superpowers` again to turn it off."
        : "Superpowers workflow **disabled** for this chat.");
      return userMsg;
    }
    if (slash.command === "stop") { await this.stopChat(chatId); return userMsg; }
    if (slash.command === "help") { this.system(chatId, threadRoot, this.helpText()); return userMsg; }

    const roles = this.d.roles();
    const mention = parseMention(slash.command ? slash.text : content, roles.map((r) => r.name));
    const roleName = mention.role ?? (threadRoot ? this.threadRole(threadRoot) : null) ?? chat.agentRole;
    const role = this.role(roleName);
    const skills = this.activeSkills(chat, slash.command);
    const text = slash.command && skills.length ? slash.text || content : mention.text;
    void this.turn({ chat, threadRoot, role, input: text, attachments, skills, depth: 0, brief: null, msgIds: [userMsg.id] }).catch((e) =>
      this.system(chatId, threadRoot, `⚠️ ${String(e?.message ?? e)}`, "error"));
    return userMsg;
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
    wait?: boolean; timeoutSec?: number; harness?: string; model?: string }): Promise<{ agentId: string; status: string; result?: string; harness?: string }> {
    const parent = this.byAgent.get(parentAgentId);
    if (!parent) throw new Error("unknown parent agent");
    const s = this.d.settings();
    if (parent.depth + 1 > s.agents.delegationDepth)
      throw new Error(parent.depth === 0
        ? "delegation is turned off (Settings → Agents → delegation depth is 0) — tell the user; don't do the work yourself"
        : `delegation depth limit (${s.agents.delegationDepth}) reached — do it yourself or ask the user`);
    const role = this.role(a.role);
    const chat = this.mustChat(parent.chatId);
    const brief = buildBrief({ goal: a.goal, context: a.context, files: a.files, acceptance: a.acceptance, parentRole: parent.role.name });
    // Specialist output appears as a thread under the coordinator's current reply.
    const threadRoot = parent.threadRoot ?? parent.currentMessageId ?? parent.lastReplyId ?? null;
    const want = a.harness && (HARNESS_IDS as string[]).includes(a.harness) ? (a.harness as HarnessId) : undefined;
    const live = this.ensureLive(chat, threadRoot, role, parent.depth + 1, `${parentAgentId}>${role.name}${want ? `@${want}` : ""}`, parentAgentId, brief,
      want ? { harness: want, model: a.model || null } : undefined);
    if (want && live.harness !== want)
      this.system(chat.id, threadRoot, `⚠️ ${want} is not available (not installed or disabled in Settings → Harnesses); ${role.title} runs on ${live.harness}.`, "warn");
    let taskId: string | undefined;
    if (s.agents.autoTaskFromDelegation) {
      const t = this.d.db.createTask({ projectId: chat.projectId, title: `${role.title}: ${a.goal.slice(0, 80)}`, description: brief,
        status: "in_progress", assigneeRole: role.name, agentId: live.agentId });
      taskId = t.id;
      this.d.emit({ type: "task.updated", task: t });
    }
    this.flow(parentAgentId, { kind: "delegate", label: `${role.title}: ${a.goal.slice(0, 120)}`, ref: live.agentId });
    const done = new Promise<string>((resolve) => live.waiters.push(resolve));
    // Waiting delegations borrow the coordinator's slot; background ones (wait: false) queue for their own.
    const borrowSlot = a.wait !== false && parent.busy;
    void this.turn({ chat, threadRoot, role, input: a.goal, skills: [], depth: live.depth, brief, taskId, liveKey: live.key, borrowSlot })
      .catch((e) => this.finishWaiters(live, `error: ${String(e?.message ?? e)}`));
    if (a.wait === false) return { agentId: live.agentId, status: "running", harness: live.harness };
    const timeout = Math.min(Math.max(a.timeoutSec ?? 600, 10), 1800) * 1000;
    const result = await Promise.race([done, new Promise<null>((r) => setTimeout(() => r(null), timeout))]);
    if (result === null) return { agentId: live.agentId, status: "running", result: "Still running. Call get_result later." };
    return { agentId: live.agentId, status: this.d.db.getAgent(live.agentId)?.status ?? "done", result };
  }

  /** Called by the coordinator's `create_agent` tool (and text-mode AGENT blocks): define a new agent, optionally run it. */
  async createAgent(parentAgentId: string, a: AgentSpec & { keep?: boolean; goal?: string; context?: string; files?: string[]; acceptance?: string; wait?: boolean }):
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
      harness: a.harness, model: a.model });
    return { role: role.name, created, agentId: r.agentId, status: r.status, result: r.result };
  }

  getResult(agentId: string): { status: string; result: string | null } {
    const a = this.d.db.getAgent(agentId);
    if (!a) throw new Error("unknown agent");
    const l = this.byAgent.get(agentId);
    return { status: a.status, result: l?.lastResult ?? a.resultSummary };
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
    this.finishWaiters(l, "stopped by user");
    this.emitAgent(this.d.db.updateAgent(agentId, { status: "stopped", ended: true, lastActivity: "Stopped" }));
  }

  // ------------------------------------------------------------------ worktrees

  private get git(): Git { return this.d.git ?? defaultGit; }

  /** A delegated code-writing specialist in a git project gets its own worktree and branch; anyone else works in the project folder. */
  private async prepareWorktree(l: Live, projectPath: string | null, chatId: string, threadRoot: string | null): Promise<void> {
    l.worktree = null;
    if (!projectPath || l.depth === 0 || !l.role.isolate || !this.d.settings().agents.isolateWriters) return;
    if (!(await canIsolate(projectPath, this.git))) return;
    const short = l.agentId.slice(0, 8);
    const branch = `flash/${l.role.name}-${short}`;
    const dir = join(this.d.dataDir ?? this.d.homeDir, "worktrees", short);
    const r = await createWorktree(projectPath, dir, branch, this.git);
    if (!r.ok) {
      this.system(chatId, threadRoot, `⚠️ Couldn't give ${l.role.title} its own copy of the project (${r.message.split("\n")[0]}); it works in the project folder.`, "warn");
      return;
    }
    l.worktree = dir;
    l.branch = branch;
    this.emitAgent(this.d.db.setAgentWorktree(l.agentId, dir, branch));
    this.flow(l.agentId, { kind: "status", label: `working on branch ${branch}`, status: "isolated" });
    this.system(chatId, threadRoot, `🌿 **${l.role.icon} ${l.role.title}** works in its own copy of the project on branch \`${branch}\`, `
      + "so parallel agents don't overwrite each other. Merge or discard it from the Agents page when it's done.");
  }

  private agentWork(agentId: string): { repo: string; dir: string; branch: string } {
    const a = this.d.db.getAgent(agentId);
    if (!a?.worktree || !a.branch) throw new Error("this agent has no separate copy of the project");
    const p = a.projectId ? this.d.db.getProject(a.projectId) : null;
    if (!p) throw new Error("the agent's project was removed");
    if (this.byAgent.get(agentId)?.busy) throw new Error("the agent is still working; wait for it to finish or stop it first");
    return { repo: p.path, dir: a.worktree, branch: a.branch };
  }

  async workState(agentId: string) {
    const w = this.agentWork(agentId);
    return { ...(await worktreeState(w.repo, w.dir, w.branch, this.git)), branch: w.branch, dir: w.dir };
  }

  /** Merge an agent's branch into the project's current branch (user action). */
  async mergeWork(agentId: string): Promise<WorkResult> {
    const w = this.agentWork(agentId);
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
      const waitingOnSpecialist = [...this.live.values()].some((c) => c.busy && c.key.startsWith(`${l.agentId}>`));
      if (waitingOnSpecialist) continue;
      l.stuckSince = now;
      const quiet = Math.round((now - l.lastOutputAt) / 60_000);
      this.setStatus(l, "running", `⏳ No output for ${quiet} min: may be stuck`);
      this.flow(l.agentId, { kind: "status", label: `no output for ${quiet} min`, status: "stuck" });
      this.system(l.chatId, l.threadRoot, `⏳ **${l.role.icon} ${l.role.title}** has sent nothing for ${quiet} min. `
        + "It is still running: keep waiting, send a message to steer it, or stop it.", "warn");
      flagged.push(l.agentId);
    }
    return flagged;
  }

  private noteOutput(l: Live): void {
    l.lastOutputAt = Date.now();
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
      const names = list.map((a) => { const r = this.d.roles().find((x) => x.name === a.role); return r ? `${r.icon} ${r.title}` : a.role; });
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
    const role = this.role(a.role);
    let depth = 0;
    for (let p = a.parentAgentId; p && depth < 10; p = this.d.db.getAgent(p)?.parentAgentId ?? null) depth++;
    const threadRoot = this.d.db.lastThreadOf(agentId);
    const key = a.parentAgentId ? `${a.parentAgentId}>${role.name}` : `${chat.id}|${threadRoot ?? "main"}|${role.name}`;
    if (this.live.has(key)) {
      this.emitAgent(this.d.db.updateAgent(agentId, { status: "stopped", lastActivity: "Superseded: the same agent is already running again" }));
      throw new Error(`${role.title} is already running again in this chat`);
    }
    const harness = this.d.harnesses.resolve(a.harness, this.d.settings());
    const l: Live = { key, agentId, chatId: chat.id, threadRoot, role, harness, model: a.model, session: null, sessionTokens: 0, busy: false,
      paused: false, queue: [], depth, currentMessageId: null, waiters: [], lastResult: a.resultSummary, stopped: false, sink: null, redirect: null, awaiting: [],
      worktree: a.worktree, branch: a.branch };
    this.live.set(key, l);
    this.byAgent.set(agentId, l);
    this.emitAgent(this.d.db.updateAgent(agentId, { status: "idle", ended: false, lastActivity: "Resuming after the app restarted" }));
    this.flow(agentId, { kind: "status", label: "resumed after restart", status: "running" });
    const kids = this.d.db.childAgents(agentId).filter((c) => c.status !== "stopped");
    const input = [
      "The app was closed while you were working on this, and it has just been reopened. Your earlier session is gone.",
      "Check what is already done (files, the task board, your specialists' results) and continue where you left off. Don't redo finished work.",
      kids.length ? `Specialists you started earlier (use get_result with these ids instead of delegating again): ${kids.map((c) => `${c.role} ${c.id} (${c.status})`).join("; ")}.` : "",
    ].filter(Boolean).join("\n");
    void this.turn({ chat, threadRoot, role, input, skills: [], depth, brief: a.parentAgentId ? a.brief : null, liveKey: key })
      .catch((e) => this.system(chat.id, threadRoot, `⚠️ ${String(e?.message ?? e)}`, "error"));
    return this.d.db.getAgent(agentId)!;
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
    l.redirect = l.redirect ? { input: `${l.redirect.input}\n${text}`, attachments: [...l.redirect.attachments, ...attachments], msgIds: [...l.redirect.msgIds, msgId] }
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
    textRound?: number }): Promise<void> {
    const s = this.d.settings();
    const live = t.liveKey ? this.live.get(t.liveKey)! : this.ensureLive(t.chat, t.threadRoot, t.role, t.depth);
    if (!live) return;
    const item = { input: t.input, attachments: t.attachments ?? [], msgIds: t.msgIds };
    if (live.paused || live.busy) for (const id of t.msgIds ?? []) { const m = this.d.db.setDelivery(id, "queued"); if (m) this.d.emit({ type: "message.updated", message: m }); }
    if (live.paused) { live.queue.push(item); this.system(t.chat.id, t.threadRoot, `⏸ ${t.role.title} is paused — message queued.`); return; }
    if (live.busy) { live.queue.push(item); return; }

    // Budgets — checked before spending anything.
    const blocked = this.checkBudgets(live, t.chat);
    if (blocked) return;

    live.busy = true;
    const borrowed = !!t.borrowSlot;
    if (!borrowed) {
      const max = s.agents.maxConcurrent || MAX_CONCURRENT_FALLBACK;
      // Visible right away: an agent waiting for a slot used to sit at "idle" and looked like it never started.
      if (this.running >= max) this.setStatus(live, "running", `⏳ Queued — ${this.running}/${max} agents busy; starts when one finishes (Settings → Agents)`);
      await this.acquireSlot(max);
    }
    if (live.stopped) { live.busy = false; if (!borrowed) this.releaseSlot(); return; } // stopped while queued
    const reply = this.d.db.addMessage({ chatId: t.chat.id, parentId: t.threadRoot, author: "agent", agentId: live.agentId,
      role: t.role.name, content: "", status: "streaming" });
    live.currentMessageId = reply.id;
    live.lastReplyId = reply.id;
    live.tools = new Map();
    this.d.emit({ type: "message.created", message: reply });
    this.setStatus(live, "running", "Starting…");
    live.lastOutputAt = Date.now();
    live.stuckSince = null;
    this.flow(live.agentId, { kind: "turn", label: t.input.replace(/\s+/g, " ").slice(0, 160) });

    let text = "";
    let finalStatus = "";
    let switchedToText = false;
    let lastFlush = Date.now();
    const project = t.chat.projectId ? this.d.db.getProject(t.chat.projectId) : null;
    let promptText: string;
    try {
      const firstTurn = !live.session || !live.session.alive;
      live.turnChanges = new Map();
      live.sink = (delta) => {
        text += delta;
        this.liveText.set(reply.id, text);
        this.d.emit({ type: "message.delta", messageId: reply.id, chatId: t.chat.id, delta });
        if (Date.now() - lastFlush > 500) { lastFlush = Date.now(); this.d.db.updateMessage(reply.id, { content: text }); }
      };
      if (firstTurn && live.worktree === undefined) await this.prepareWorktree(live, project?.path ?? null, t.chat.id, t.threadRoot);
      const workDir = live.worktree ?? project?.path ?? null;
      if (firstTurn) live.session = await this.openSession(live, workDir, t.chat);
      // Coordinator: Pi has no MCP, so text mode right away; other harnesses get a few seconds to list the tools,
      // and are checked again after the first reply (some list them only when the first prompt arrives).
      let toolsPending = false;
      const coordinator = firstTurn && this.coordinates(live, s);
      if (firstTurn && s.agents.toolMode === "text" && live.harness !== "mock") {
        // Text mode (default): no MCP for the app's tools; every agent uses TOOL lines, the coordinator DELEGATE/AGENT lines.
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
      // On a (re)started session send a compact history instead of a transcript.
      let summary: string | null = null;
      let recent: Message[] = [];
      if (firstTurn && !t.brief) {
        const cs = this.d.db.getChatSummary(t.chat.id);
        const hist = this.d.db.history(t.chat.id, t.threadRoot, cs.upto).filter((m) => m.id !== reply.id && m.status !== "streaming" && !m.marker);
        hist.pop(); // the user message we are answering is sent as the request
        const plan = planCompaction(hist, s.tokens.compactAfterTokens, s.tokens.keepRecentTurns);
        summary = cs.summary || null;
        if (plan.compact) {
          summary = extractiveSummary(cs.summary, plan.summarise);
          const lastSeq = hist[hist.length - plan.keep.length - 1]?.seq ?? cs.upto;
          this.d.db.setChatSummary(t.chat.id, summary, lastSeq);
        }
        recent = (plan.compact ? plan.keep : hist).slice(-s.tokens.keepRecentTurns) as Message[];
      }
      // Skills declared by the role load once, on the session's first turn; slash-command skills load per message.
      const roleSkills = firstTurn ? this.d.skills().filter((k) => t.role.skills.includes(k.command) && !t.skills.includes(k)) : [];
      promptText = buildTurnPrompt({ role: t.role, projectPath: workDir, skills: [...roleSkills, ...t.skills], summary, recent, input: t.input,
        brief: t.brief, firstTurn, clean: s.agents.instructionMode === "clean",
        houseRules: [s.agents.houseRules, this.d.extraRules?.() ?? "",
          firstTurn && live.worktree ? `You work in your own git worktree (an isolated copy of the project) on branch ${live.branch}. Commit your changes on that branch before you finish; the user reviews and merges it. Don't push, and don't switch branches.` : "", firstTurn && live.textDelegation ? TEXT_DELEGATION_RULES : "", firstTurn && live.textTools ? this.textToolsFor(live) : ""].filter((x) => x.trim()).join("\n\n") });
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
      this.d.db.updateMessage(reply.id, { content: text });
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
      live.sessionTokens += usage.tokensIn + usage.tokensOut;
      const redirected = !!live.redirect && !live.stopped;
      const status = live.stopped ? "stopped" : redirected ? "done" : res.stopReason === "error" ? "error" : live.paused ? "paused" : res.stopReason === "cancelled" ? "stopped" : "done";
      finalStatus = redirected ? "redirected" : status;
      if (redirected) text += "\n\n_↪ Redirected by your steering message._";
      else if (res.error) text += `\n\n⚠️ ${res.error}`;
      const final = this.d.db.updateMessage(reply.id, { content: text || (status === "paused" ? "_(paused)_" : "_(no output)_"),
        status: res.stopReason === "error" ? "error" : "done", tokensIn: usage.tokensIn, tokensOut: usage.tokensOut, estimated: usage.estimated });
      this.d.emit({ type: "message.updated", message: final });
      const compact = resultForParent(text, t.role.maxResultTokens) + (live.branch ? `\nbranch: ${live.branch} (isolated copy; the user merges it)` : "");
      live.lastResult = compact;
      const resultLine = /summary:\s*(.+)/.exec(compact)?.[1] ?? compact.replace(/\s+/g, " ");
      // What the agent itself says about how it ended (status line of its <result> block).
      const said = status === "done" ? (parseResult(text).status ?? "done") : "done";
      const asks = said !== "done" ? (parseResult(text).question ?? resultLine) : null;
      this.flow(live.agentId, status === "error" ? { kind: "error", label: (res.error ?? "error").slice(0, 160) }
        : said !== "done" ? { kind: "status", label: `${SAID_LABEL[said]}: ${asks!.slice(0, 150)}`, status: said }
        : { kind: status === "done" ? "result" : "status", label: status === "done" ? resultLine.slice(0, 160) : status, status });
      this.emitAgent(this.d.db.updateAgent(live.agentId, { status: status === "done" ? "idle" : status, resultSummary: compact.slice(0, 4000),
        lastActivity: status === "done" ? (said !== "done" ? `${SAID_LABEL[said]}: ${asks}` : "Waiting for input") : status, ended: status === "stopped" }));
      if (said !== "done") this.surfaceSaid(live, t.chat.id, t.threadRoot, said, asks!);
      if (t.taskId) {
        const task = this.d.db.updateTask(t.taskId, { status: status === "error" || said !== "done" ? "blocked" : "review" });
        this.d.emit({ type: "task.updated", task });
      }
      this.finishWaiters(live, compact);
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
      const final = this.d.db.updateMessage(reply.id, { content: (text ? text + "\n\n" : "") + `⚠️ ${msg}`, status: "error" });
      this.d.emit({ type: "message.updated", message: final });
      this.emitAgent(this.d.db.updateAgent(live.agentId, live.stopped ? { status: "stopped", lastActivity: "Stopped" } : { status: "error", lastActivity: msg }));
      live.session?.close();
      live.session = null;
      this.finishWaiters(live, `error: ${msg}`);
      if (t.taskId) this.d.emit({ type: "task.updated", task: this.d.db.updateTask(t.taskId, { status: "blocked" }) });
    } finally {
      this.liveText.delete(reply.id);
      this.flushTools(live, reply.id, t.chat.id);
      live.sink = null;
      live.busy = false;
      live.currentMessageId = null;
      if (!borrowed) this.releaseSlot();
    }
    if (switchedToText && finalStatus === "done" && !live.stopped && !live.paused && !parseTextDelegations(text).length) {
      // The first reply was written without the delegate tool: have the coordinator re-plan with DELEGATE lines.
      const extra = live.textTools ? this.textToolsFor(live) : "";
      void this.turn({ ...t, input: `${TEXT_DELEGATION_RULES}${extra ? `\n\n${extra}` : ""}\n\nYour tools are not available, so use this text mode. Re-plan the user's last request now and delegate it with DELEGATE lines.`,
        attachments: [], skills: [], brief: null, taskId: undefined, liveKey: live.key, msgIds: undefined, deliver: false, borrowSlot: false, textRound: 1 });
      return;
    }
    if ((live.textDelegation || live.textTools) && finalStatus === "done" && !live.stopped && !live.paused && !live.queue.length) {
      live.lastText = text;
      const reqs = live.textDelegation ? parseTextDelegations(text) : [];
      const agents = live.textDelegation ? parseTextAgents(text).length : 0;
      const calls = live.textTools ? parseTextToolCalls(text, new Set(this.toolSetFor(live).map((x) => x.name))) : [];
      if (reqs.length || agents || calls.length) { void this.runTextDelegations(live, t, reqs, calls); return; }
    }
    if (live.redirect && !live.stopped) {
      const r = live.redirect;
      live.redirect = null;
      void this.turn({ ...t, input: `The user interrupted you with new direction:\n${r.input}\n\nContinue the task taking this into account.`,
        attachments: r.attachments, skills: [], brief: null, taskId: undefined, liveKey: live.key, msgIds: r.msgIds, deliver: true, borrowSlot: false, textRound: 0 });
      return;
    }
    if (!live.paused && !live.stopped && live.queue.length) {
      const items = live.queue.splice(0);
      void this.turn({ ...t, input: items.map((q) => q.input).join("\n\n"), attachments: items.flatMap((q) => q.attachments), skills: [], brief: null,
        taskId: undefined, liveKey: live.key, msgIds: items.flatMap((q) => q.msgIds ?? []), deliver: true, borrowSlot: false, textRound: 0 });
    }
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
      thinking: mode?.thinking || null,
      extraArgs: [ins.args.join(" "), hs?.args ?? ""].filter(Boolean).join(" "),
      executable: status?.path ?? (hs?.path || null),
      mcpServers: this.d.mcpServersFor(live.role, live.agentId),
      env: { ...networkEnv(s), ...ins.env, ...(this.d.harnessEnv?.(live.harness) ?? {}), ...(this.d.roleEnv?.(live.role) ?? {}) },
      resumeSessionId: this.d.db.getAgentSession(live.agentId),
      policy: {
        approval: s.permissions.approval, readOnly: s.permissions.readOnly, projectRoot: projectPath,
        extraRoots: this.d.attachmentRoots?.() ?? [],
        blocked: s.permissions.blockedCommands.split("\n").filter((l) => l.trim()),
      },
      onEvent: (e) => {
        this.noteOutput(live);
        if (live.awaiting.length && (e.type === "text" || e.type === "tool" || e.type === "thought")) this.markSeen(live, false);
        if (e.type === "steer_ack") this.markSeen(live, true);
        if (e.type === "text") live.sink?.(e.text);
        else if (e.type === "tool") {
          // Output updates arrive often: status line and flow chart only change when the call's status does.
          if (this.recordTool(live, e)) {
            this.setStatus(live, "running", `${e.status === "completed" ? "✓" : "▸"} ${e.title}`);
            this.flow(live.agentId, { kind: "tool", label: e.title, status: e.status });
          }
        } else if (e.type === "plan") this.setPlan(live.agentId, e.entries);
        else if (e.type === "diff") this.recordChange(live, projectPath, e.path, e.oldText, e.newText);
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
    if (this.d.db.getChat(live.chatId)?.autopilot || this.d.settings().permissions.approval === "auto-all") {
      this.flow(live.agentId, { kind: "approval", label: `${r.kind}: ${r.title}`, status: "auto-approved (autopilot)" });
      return Promise.resolve(true);
    }
    const msg = this.d.db.addMessage({ chatId: live.chatId, parentId: live.threadRoot ?? live.currentMessageId, author: "system",
      role: live.role.name, content: `🔐 **${live.role.title}** wants to run a **${r.kind}** action:\n\n\`${r.title}\`\n\n\`\`\`\n${r.detail}\n\`\`\`\nReact ✅ to allow or ❌ to deny.` });
    this.d.emit({ type: "message.created", message: msg });
    this.setStatus(live, "running", "Waiting for your approval");
    live.awaitingApproval = true;
    this.flow(live.agentId, { kind: "approval", label: `${r.kind}: ${r.title}`, status: "waiting" });
    this.d.emit({ type: "notice", level: "warn", text: `${live.role.title} is waiting for approval` });
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
    parentAgentId?: string, brief?: string, pick?: { harness: HarnessId; model: string | null }): Live {
    const key = keyOverride ?? `${chat.id}|${threadRoot ?? "main"}|${role.name}`;
    const existing = this.live.get(key);
    if (existing) return existing;
    const s = this.d.settings();
    const override = s.agents.roleOverrides[role.name];
    const mode = chat.mode ? s.modes[chat.mode] : null;
    const requested = (mode?.harness || null) ?? (chat.agentRole === role.name ? chat.harness : null) ?? override?.harness ?? role.harness ?? null;
    // Economy routing: delegated specialists can run on a cheaper harness/model.
    const economy = !!parentAgentId && s.tokens.economyForDelegated && !!s.tokens.economyHarness;
    // An explicit harness from the coordinator (the user asked for "the Pi agent") wins over economy routing.
    const harness = this.d.harnesses.resolve(pick?.harness ?? (economy ? (s.tokens.economyHarness as HarnessId) : requested), s);
    const model = pick && harness === pick.harness ? pick.model : economy && s.tokens.economyModel ? s.tokens.economyModel : null;
    const agent = this.d.db.createAgent({ projectId: chat.projectId, chatId: chat.id, role: role.name, harness, model,
      parentAgentId: parentAgentId ?? null, brief: brief ?? `Chat: ${chat.title}` });
    const l: Live = { key, agentId: agent.id, chatId: chat.id, threadRoot, role, harness, model, session: null, sessionTokens: 0, busy: false,
      paused: false, queue: [], depth, currentMessageId: null, waiters: [], lastResult: null, stopped: false, sink: null, redirect: null, awaiting: [] };
    this.live.set(key, l);
    this.byAgent.set(agent.id, l);
    this.emitAgent(agent);
    return l;
  }

  /** Agents expected to hand work to specialists: the coordinator (and its custom copies at depth 0). */
  private coordinates(live: Live, s: Settings): boolean {
    return live.depth === 0 && live.harness !== "mock" && s.agents.delegationDepth > 0 && (live.role.name === "flashmaster" || /delegate/i.test(live.role.description ?? ""));
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
    const sets = ["core", ...(live.role.tools.includes("jazz") || this.d.settings().jazz.enabled ? ["jazz"] : [])];
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
    if (runnable.length) this.system(t.chat.id, live.lastReplyId ?? t.threadRoot, `↪ Delegating: ${runnable.map((r) => `**${r.role}**${r.harness ? ` on ${r.harness}` : ""}`).join(", ")}`);
    const results = created.concat(await Promise.all(reqs.map(async (r) => {
      if (!known.has(r.role) || r.role === live.role.name) return `### ${r.role}
Not run: unknown role. Available: ${[...known].filter((n) => n !== live.role.name).join(", ")}.`;
      try {
        const x = await this.delegate(live.agentId, { role: r.role, goal: r.goal, harness: r.harness, wait: true, timeoutSec: 1800 });
        return `### ${r.role}${x.harness ? ` (${x.harness})` : ""}
${x.result ?? `status: ${x.status}`}`;
      } catch (e) { return `### ${r.role}
Failed: ${String((e as Error)?.message ?? e)}`; }
    })));
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
    void this.turn({ ...t, input: `${parts.join("\n\n")}\n\nContinue: integrate these results and answer, or make further calls the same way.`,
      attachments: [], skills: [], brief: null, taskId: undefined, liveKey: live.key, msgIds: undefined, deliver: false, borrowSlot: false, textRound: round });
  }

  /**
   * Upsert a tool call of the current reply. Returns true when it is new or its status changed (worth a status line).
   * Output is capped per call (head + tail) so a noisy build can't bloat the chat or the database.
   */
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
    const status = (["pending", "in_progress", "completed", "failed"].includes(e.status) ? e.status : prev?.status ?? "in_progress") as ToolRun["status"];
    const capped = e.output !== undefined ? capOutput(e.output) : null;
    const run: ToolRun = {
      id: prev?.id ?? `${msgId}:${tools.size}`, title: e.title || prev?.title || "tool", kind: (e.kind && e.kind !== "other" ? e.kind : prev?.kind) || e.kind || "other", status,
      input: e.input ?? prev?.input, output: capped ? capped.text : prev?.output, truncated: capped ? capped.truncated : prev?.truncated,
      startedAt: prev?.startedAt ?? Date.now(), endedAt: status === "completed" || status === "failed" ? prev?.endedAt ?? Date.now() : undefined,
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

  private finishWaiters(l: Live, result: string): void {
    for (const w of l.waiters.splice(0)) w(result);
  }

  /**
   * A specialist reported that it needs a decision, is blocked, or failed. Its delegating agent gets this in the
   * result as usual; the user also sees it right away in the thread and as a notice, without waiting for the coordinator.
   */
  private surfaceSaid(l: Live, chatId: string, threadRoot: string | null, said: Exclude<ResultStatus, "done">, asks: string): void {
    const icon = said === "needs_decision" ? "❓" : said === "blocked" ? "⛔" : "⚠️";
    const who = `${l.role.icon} ${l.role.title}`;
    if (l.depth > 0) this.system(chatId, threadRoot, `${icon} **${who}** ${SAID_LABEL[said].toLowerCase()}: ${asks}`);
    this.d.emit({ type: "notice", level: said === "failed" ? "error" : "warn", text: `${who} ${SAID_LABEL[said].toLowerCase()}: ${asks}`.replace(/[*`]/g, "").slice(0, 140) });
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
    const skills = this.d.skills();
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

  /** Used by the bridge: tasks created by agents get the agent's project. */
  agentProject(agentId: string): string | null {
    return this.d.db.getAgent(agentId)?.projectId ?? null;
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
