/**
 * Orchestrator — runs every agent turn in the app.
 *
 * Everything is a chat turn: a user message in a chat (or thread) goes to the chat's role, or to the role
 * named with @mention. Delegated specialists run as thread replies under the delegating message, so the
 * user sees them without the coordinator's context ever containing their transcript.
 */
import type { AgentRun, AppEvent, Attachment, Chat, HarnessId, Message, RoleDef, SkillDef, Task } from "@shared/types";
import type { Settings } from "@shared/settings";
import type { Db } from "./db";
import type { HarnessRegistry } from "./harness/registry";
import type { HarnessSession, McpServerSpec, PermissionRequest } from "./harness/types";
import { prepareInstructions } from "./harness/instructions";
import {
  budgetState, buildBrief, buildTurnPrompt, estimateTokens, extractiveSummary, parseMention, parseSlash, planCompaction,
  resultForParent,
} from "./context";

export interface OrchestratorDeps {
  /** Extra environment per harness (e.g. GH_TOKEN for Copilot when signed in with a token). */
  harnessEnv?: (harness: HarnessId) => Record<string, string>;
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
  queue: { input: string; attachments: Attachment[] }[];
  redirect: { input: string; attachments: Attachment[] } | null; // steering by interrupt: next turn input
  depth: number;
  currentMessageId: string | null;
  waiters: ((result: string) => void)[];
  lastResult: string | null;
  stopped: boolean;
  /** Where streamed text goes for the *current* turn. Sessions outlive turns, so this is swapped per turn. */
  sink: ((delta: string) => void) | null;
}

const MAX_CONCURRENT_FALLBACK = 4;

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
    const userMsg = this.d.db.addMessage({ chatId, parentId: threadRoot, author: "user", content, attachments, steer });
    this.d.emit({ type: "message.created", message: userMsg });
    if (steer && busyLive) { await this.steer(busyLive, content, attachments); return userMsg; }

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
    void this.turn({ chat, threadRoot, role, input: text, attachments, skills, depth: 0, brief: null }).catch((e) =>
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
    wait?: boolean; timeoutSec?: number }): Promise<{ agentId: string; status: string; result?: string }> {
    const parent = this.byAgent.get(parentAgentId);
    if (!parent) throw new Error("unknown parent agent");
    const s = this.d.settings();
    if (parent.depth + 1 > s.agents.delegationDepth) throw new Error(`delegation depth limit (${s.agents.delegationDepth}) reached — do it yourself or ask the user`);
    const role = this.role(a.role);
    const chat = this.mustChat(parent.chatId);
    const brief = buildBrief({ goal: a.goal, context: a.context, files: a.files, acceptance: a.acceptance, parentRole: parent.role.name });
    // Specialist output appears as a thread under the coordinator's current reply.
    const threadRoot = parent.threadRoot ?? parent.currentMessageId;
    const live = this.ensureLive(chat, threadRoot, role, parent.depth + 1, `${parentAgentId}>${role.name}`, parentAgentId, brief);
    let taskId: string | undefined;
    if (s.agents.autoTaskFromDelegation) {
      const t = this.d.db.createTask({ projectId: chat.projectId, title: `${role.title}: ${a.goal.slice(0, 80)}`, description: brief,
        status: "in_progress", assigneeRole: role.name, agentId: live.agentId });
      taskId = t.id;
      this.d.emit({ type: "task.updated", task: t });
    }
    this.flow(parentAgentId, { kind: "delegate", label: `${role.title}: ${a.goal.slice(0, 120)}`, ref: live.agentId });
    const done = new Promise<string>((resolve) => live.waiters.push(resolve));
    void this.turn({ chat, threadRoot, role, input: a.goal, skills: [], depth: live.depth, brief, taskId, liveKey: live.key })
      .catch((e) => this.finishWaiters(live, `error: ${String(e?.message ?? e)}`));
    if (a.wait === false) return { agentId: live.agentId, status: "running" };
    const timeout = Math.min(Math.max(a.timeoutSec ?? 600, 10), 1800) * 1000;
    const result = await Promise.race([done, new Promise<null>((r) => setTimeout(() => r(null), timeout))]);
    if (result === null) return { agentId: live.agentId, status: "running", result: "Still running. Call get_result later." };
    return { agentId: live.agentId, status: this.d.db.getAgent(live.agentId)?.status ?? "done", result };
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
      brief: null, liveKey: l.key });
  }

  async stop(agentId: string): Promise<void> {
    const l = this.byAgent.get(agentId);
    if (!l) {
      const a = this.d.db.getAgent(agentId);
      if (a && ["idle", "running", "paused"].includes(a.status)) this.emitAgent(this.d.db.updateAgent(agentId, { status: "stopped", ended: true }));
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
  private async steer(l: Live, text: string, attachments: Attachment[]): Promise<void> {
    if (!attachments.length && l.session?.steer && (await l.session.steer(text).catch(() => false))) {
      this.flow(l.agentId, { kind: "status", label: `steered: ${text.slice(0, 120)}`, status: "steer" });
      this.setStatus(l, "running", "Steering message delivered");
      return;
    }
    l.redirect = l.redirect ? { input: `${l.redirect.input}\n${text}`, attachments: [...l.redirect.attachments, ...attachments] } : { input: text, attachments };
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
    depth: number; brief: string | null; taskId?: string; liveKey?: string }): Promise<void> {
    const s = this.d.settings();
    const live = t.liveKey ? this.live.get(t.liveKey)! : this.ensureLive(t.chat, t.threadRoot, t.role, t.depth);
    if (!live) return;
    const item = { input: t.input, attachments: t.attachments ?? [] };
    if (live.paused) { live.queue.push(item); this.system(t.chat.id, t.threadRoot, `⏸ ${t.role.title} is paused — message queued.`); return; }
    if (live.busy) { live.queue.push(item); return; }

    // Budgets — checked before spending anything.
    const blocked = this.checkBudgets(live, t.chat);
    if (blocked) return;

    live.busy = true;
    await this.acquireSlot(s.agents.maxConcurrent || MAX_CONCURRENT_FALLBACK);
    const reply = this.d.db.addMessage({ chatId: t.chat.id, parentId: t.threadRoot, author: "agent", agentId: live.agentId,
      role: t.role.name, content: "", status: "streaming" });
    live.currentMessageId = reply.id;
    this.d.emit({ type: "message.created", message: reply });
    this.setStatus(live, "running", "Starting…");
    this.flow(live.agentId, { kind: "turn", label: t.input.replace(/\s+/g, " ").slice(0, 160) });

    let text = "";
    let lastFlush = Date.now();
    const project = t.chat.projectId ? this.d.db.getProject(t.chat.projectId) : null;
    let promptText: string;
    try {
      const firstTurn = !live.session || !live.session.alive;
      live.sink = (delta) => {
        text += delta;
        this.liveText.set(reply.id, text);
        this.d.emit({ type: "message.delta", messageId: reply.id, chatId: t.chat.id, delta });
        if (Date.now() - lastFlush > 500) { lastFlush = Date.now(); this.d.db.updateMessage(reply.id, { content: text }); }
      };
      if (firstTurn) live.session = await this.openSession(live, project?.path ?? null, t.chat);
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
      promptText = buildTurnPrompt({ role: t.role, projectPath: project?.path ?? null, skills: [...roleSkills, ...t.skills], summary, recent, input: t.input,
        brief: t.brief, firstTurn, clean: s.agents.instructionMode === "clean",
        houseRules: [s.agents.houseRules, this.d.extraRules?.() ?? ""].filter((x) => x.trim()).join("\n\n") });
      this.setStatus(live, "running", "Thinking…");
      // Autopilot is read per turn, so toggling it applies to the very next message.
      const chatNow = this.d.db.getChat(t.chat.id) ?? t.chat;
      if (chatNow.autopilot) promptText += "\n\n(Autopilot: work autonomously. Do not stop to ask for confirmation or feedback — make reasonable assumptions, state them briefly, and finish the task.)";
      const atts = (t.attachments ?? []).map((a) => ({ kind: a.kind, name: a.name, mime: a.mime, path: a.path }));
      const res = await live.session!.prompt(promptText, atts);
      this.d.db.updateMessage(reply.id, { content: text });
      const usage = res.usage && (res.usage.tokensIn || res.usage.tokensOut)
        ? { ...res.usage, estimated: false }
        : { tokensIn: estimateTokens(promptText), tokensOut: estimateTokens(text), estimated: true };
      this.d.db.recordUsage({ agentId: live.agentId, projectId: t.chat.projectId, harness: live.harness, role: t.role.name, ...usage });
      live.sessionTokens += usage.tokensIn + usage.tokensOut;
      const redirected = !!live.redirect && !live.stopped;
      const status = live.stopped ? "stopped" : redirected ? "done" : res.stopReason === "error" ? "error" : live.paused ? "paused" : res.stopReason === "cancelled" ? "stopped" : "done";
      if (redirected) text += "\n\n_↪ Redirected by your steering message._";
      else if (res.error) text += `\n\n⚠️ ${res.error}`;
      const final = this.d.db.updateMessage(reply.id, { content: text || (status === "paused" ? "_(paused)_" : "_(no output)_"),
        status: res.stopReason === "error" ? "error" : "done", tokensIn: usage.tokensIn, tokensOut: usage.tokensOut, estimated: usage.estimated });
      this.d.emit({ type: "message.updated", message: final });
      const compact = resultForParent(text, t.role.maxResultTokens);
      live.lastResult = compact;
      const resultLine = /summary:\s*(.+)/.exec(compact)?.[1] ?? compact.replace(/\s+/g, " ");
      this.flow(live.agentId, status === "error" ? { kind: "error", label: (res.error ?? "error").slice(0, 160) }
        : { kind: status === "done" ? "result" : "status", label: status === "done" ? resultLine.slice(0, 160) : status, status });
      this.emitAgent(this.d.db.updateAgent(live.agentId, { status: status === "done" ? "idle" : status, resultSummary: compact.slice(0, 4000),
        lastActivity: status === "done" ? "Waiting for input" : status, ended: status === "stopped" }));
      if (t.taskId) {
        const task = this.d.db.updateTask(t.taskId, { status: status === "error" ? "blocked" : "review" });
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
      live.sink = null;
      live.busy = false;
      live.currentMessageId = null;
      this.releaseSlot();
    }
    if (live.redirect && !live.stopped) {
      const r = live.redirect;
      live.redirect = null;
      void this.turn({ ...t, input: `The user interrupted you with new direction:\n${r.input}\n\nContinue the task taking this into account.`,
        attachments: r.attachments, skills: [], brief: null, taskId: undefined, liveKey: live.key });
      return;
    }
    if (!live.paused && !live.stopped && live.queue.length) {
      const items = live.queue.splice(0);
      void this.turn({ ...t, input: items.map((q) => q.input).join("\n\n"), attachments: items.flatMap((q) => q.attachments), skills: [], brief: null,
        taskId: undefined, liveKey: live.key });
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
      env: { ...networkEnv(s), ...ins.env, ...(this.d.harnessEnv?.(live.harness) ?? {}) },
      resumeSessionId: this.d.db.getAgentSession(live.agentId),
      policy: {
        approval: s.permissions.approval, readOnly: s.permissions.readOnly, projectRoot: projectPath,
        extraRoots: this.d.attachmentRoots?.() ?? [],
        blocked: s.permissions.blockedCommands.split("\n").filter((l) => l.trim()),
      },
      onEvent: (e) => {
        if (e.type === "text") live.sink?.(e.text);
        else if (e.type === "tool") {
          this.setStatus(live, "running", `${e.status === "completed" ? "✓" : "▸"} ${e.title}`);
          this.flow(live.agentId, { kind: "tool", label: e.title, status: e.status });
        } else if (e.type === "plan") this.setPlan(live.agentId, e.entries);
      },
      askPermission: (r) => this.askPermission(live, r),
    });
    if (session.sessionId) this.d.db.updateAgent(live.agentId, { sessionId: session.sessionId });
    if (session.models?.length) this.d.onModels?.(live.harness, session.models);
    return session;
  }

  private askPermission(live: Live, r: PermissionRequest): Promise<boolean> {
    if (this.d.db.getChat(live.chatId)?.autopilot) {
      this.flow(live.agentId, { kind: "approval", label: `${r.kind}: ${r.title}`, status: "auto-approved (autopilot)" });
      return Promise.resolve(true);
    }
    const msg = this.d.db.addMessage({ chatId: live.chatId, parentId: live.threadRoot ?? live.currentMessageId, author: "system",
      role: live.role.name, content: `🔐 **${live.role.title}** wants to run a **${r.kind}** action:\n\n\`${r.title}\`\n\n\`\`\`\n${r.detail}\n\`\`\`\nReact ✅ to allow or ❌ to deny.` });
    this.d.emit({ type: "message.created", message: msg });
    this.setStatus(live, "running", "Waiting for your approval");
    this.flow(live.agentId, { kind: "approval", label: `${r.kind}: ${r.title}`, status: "waiting" });
    this.d.emit({ type: "notice", level: "warn", text: `${live.role.title} is waiting for approval` });
    return new Promise((resolve) => {
      this.pendingPermissions.set(msg.id, (allow) => {
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
    parentAgentId?: string, brief?: string): Live {
    const key = keyOverride ?? `${chat.id}|${threadRoot ?? "main"}|${role.name}`;
    const existing = this.live.get(key);
    if (existing) return existing;
    const s = this.d.settings();
    const override = s.agents.roleOverrides[role.name];
    const mode = chat.mode ? s.modes[chat.mode] : null;
    const requested = (mode?.harness || null) ?? (chat.agentRole === role.name ? chat.harness : null) ?? override?.harness ?? role.harness ?? null;
    // Economy routing: delegated specialists can run on a cheaper harness/model.
    const economy = !!parentAgentId && s.tokens.economyForDelegated && !!s.tokens.economyHarness;
    const harness = this.d.harnesses.resolve(economy ? (s.tokens.economyHarness as HarnessId) : requested, s);
    const model = economy && s.tokens.economyModel ? s.tokens.economyModel : null;
    const agent = this.d.db.createAgent({ projectId: chat.projectId, chatId: chat.id, role: role.name, harness, model,
      parentAgentId: parentAgentId ?? null, brief: brief ?? `Chat: ${chat.title}` });
    const l: Live = { key, agentId: agent.id, chatId: chat.id, threadRoot, role, harness, model, session: null, sessionTokens: 0, busy: false,
      paused: false, queue: [], depth, currentMessageId: null, waiters: [], lastResult: null, stopped: false, sink: null, redirect: null };
    this.live.set(key, l);
    this.byAgent.set(agent.id, l);
    this.emitAgent(agent);
    return l;
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

export function networkEnv(s: Settings): Record<string, string> {
  const env: Record<string, string> = {};
  // The MCP servers reach the app over 127.0.0.1: make sure an inherited corporate proxy never intercepts that.
  const inherited = process.env.no_proxy || process.env.NO_PROXY || "";
  const local = "localhost,127.0.0.1";
  const np = [s.network.noProxy || inherited, local].filter(Boolean).join(",");
  Object.assign(env, { NO_PROXY: np, no_proxy: np });
  if (s.network.proxy) Object.assign(env, { HTTPS_PROXY: s.network.proxy, HTTP_PROXY: s.network.proxy, https_proxy: s.network.proxy, http_proxy: s.network.proxy });
  if (s.network.caBundlePath) Object.assign(env, { NODE_EXTRA_CA_CERTS: s.network.caBundlePath, SSL_CERT_FILE: s.network.caBundlePath, REQUESTS_CA_BUNDLE: s.network.caBundlePath });
  return env;
}
