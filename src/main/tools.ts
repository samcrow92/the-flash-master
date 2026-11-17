import type { Task } from "@shared/types";
import { TASK_STATUSES } from "@shared/types";
import type { Db } from "./db";
import type { Orchestrator } from "./orchestrator";
import type { ToolDef } from "./bridge";
import type { JazzClient } from "./jazz";
import type { Requirements } from "./requirements";
import { QM_TYPES, VERDICTS, qmType, type EtmClient, type QmWrite } from "./etm";
import { normPath, type ScmClient } from "./scm";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { RoleDef } from "@shared/types";
import { MEMORY_KINDS, MEMORY_SCOPES } from "@shared/types";
import type { Memory } from "@shared/types";
import type { MemoryContext, MemoryStore } from "./memory";
import { entryTitle, type KnowledgeBase } from "./knowledge";
import { CODE_GRAPH_COMMANDS, type CodeGraph, type CodeGraphCommand } from "./graphify";
import { DIAGRAM_KINDS, renderDiagram } from "@shared/diagrams";

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required });
const s = (description: string) => ({ type: "string", description });

/** Tools exposed to agents through the flashmaster-core and jazz MCP servers. Results are kept compact on purpose. */
export function buildTools(d: {
  db: Db; orch: Orchestrator; roles: () => RoleDef[]; jazz: () => JazzClient | null; emitTask: (t: Task) => void; deleteTask?: (id: string) => void;
  requirements?: Requirements; rmProjects?: () => string[]; onArtifact?: (agentId: string) => void; jazzAreas?: () => string[];
  memory?: MemoryStore; memoryEnabled?: () => boolean; onMemory?: () => void;
  knowledge?: KnowledgeBase; codeGraph?: CodeGraph; readOnly?: () => boolean;
  etm?: () => EtmClient | null; scm?: () => ScmClient | null;
}): ToolDef[] {
  const rm = () => {
    if (!d.requirements) throw new Error("DOORS Next requirements are not available");
    return d.requirements;
  };
  const jazz = () => {
    const j = d.jazz();
    if (!j) throw new Error("Jazz integration is not configured (Settings → Integrations → IBM Jazz)");
    return j;
  };
  const etm = () => {
    const e = d.etm?.();
    if (!e) throw new Error("ETM test management is not configured (Settings → Integrations → IBM Jazz → Test management)");
    return e;
  };
  const scm = () => {
    const c = d.scm?.();
    if (!c) throw new Error("EWM source control is not configured (Settings → Integrations → IBM Jazz → Source control)");
    return c;
  };
  /** Folder an agent works in: its worktree, else its project folder, else the no-project folder (C:\\Data\\.wt by default). */
  const agentDir = (agentId: string): string => {
    const a = agentId ? d.db.getAgent(agentId) : null;
    const dir = a?.worktree ?? (a?.projectId ? d.db.getProject(a.projectId)?.path : a ? d.orch.agentWorkDir(agentId) : null);
    if (!dir) throw new Error("this chat has no project folder to download into — read files with scm_read_file instead");
    return dir;
  };
  const mem = () => {
    if (!d.memory || d.memoryEnabled?.() === false) throw new Error("Memory is turned off (Settings → Memory)");
    return d.memory;
  };
  const memCtx = (agentId: string): MemoryContext => {
    const a = agentId ? d.db.getAgent(agentId) : null;
    return { projectId: a?.projectId ?? null, chatId: a?.chatId ?? null, agentId: a?.id ?? null, role: a?.role ?? null };
  };
  const changed = <T>(x: T): T => { d.onMemory?.(); return x; };
  const kb = (agentId: string): { kb: KnowledgeBase; projectId: string; ctx: MemoryContext } => {
    if (!d.knowledge || d.memoryEnabled?.() === false) throw new Error("Memory is turned off (Settings → Memory), and the knowledge base with it");
    const ctx = memCtx(agentId);
    if (!ctx.projectId) throw new Error("the knowledge base belongs to a project: this chat has no project folder");
    return { kb: d.knowledge, projectId: ctx.projectId, ctx };
  };
  const syncNote = (r: { conflicts: { slug: string; detail?: string; reason: string }[] }) =>
    r.conflicts.length ? { conflicts: r.conflicts.map((c) => `${c.slug}: ${c.detail ?? c.reason}`), hint: "the user settles conflicts on the Memory page; don't rewrite those entries" } : {};
  const memBrief = (m: Memory) => ({ id: m.id, scope: m.scope, kind: m.kind, content: m.content, ...(m.tags.length ? { tags: m.tags } : {}),
    importance: m.importance, ...(m.pinned ? { pinned: true } : {}), ...(m.expiresAt ? { expires: new Date(m.expiresAt).toISOString().slice(0, 10) } : {}) });
  const scopeProp = (what: string) => ({ type: "string", enum: [...MEMORY_SCOPES], description: what });
  const brief = (t: Task) => ({ id: t.id, title: t.title, status: t.status, priority: t.priority, assignee: t.assigneeRole, jazz: t.jazzId });
  return [
    {
      set: "core", name: "delegate",
      description: "Hand a focused sub-task to a specialist agent. Send a brief (goal, context, files, acceptance), never transcripts. Returns the specialist's compact result. Every call starts a new, separate instance with its own name, session and task (two calls for one role = two specialists working in parallel); pass agentId to send a follow-up to one you started earlier. This is the only way to run another agent (including on Copilot/OpenCode/Pi/Duo via `harness`): it gets the project's tools and shows in the Agents tab.",
      inputSchema: obj({
        role: s("specialist role name, see list_roles"), goal: s("what to achieve, one or two sentences"),
        context: s("only the facts the specialist needs"), files: { type: "array", items: { type: "string" }, description: "relevant paths" },
        acceptance: s("done when…"), wait: { type: "boolean", description: "wait for the result (default true)" },
        timeoutSec: { type: "number", description: "max seconds to wait (default 600)" },
        harness: { type: "string", enum: ["copilot", "opencode", "cursor", "claude", "pi", "duo"], description: "run the specialist on this agent CLI (e.g. the user asked for Pi). Default: the role's configured harness. Never start agent CLIs from a shell instead." },
        model: s("model for that harness (optional), as the harness names it. Pi: provider/model, e.g. qwen-local-8800/qwen3.8:27b (or give provider separately). Use it whenever the user or brief names a model or provider: a model named only in the goal text is not applied"),
        provider: s("Pi/OpenCode provider of that model (optional), e.g. qwen-local-8800; same as model = provider/model"),
        args: s("extra command-line arguments for the agent CLI (optional, rarely needed), e.g. \"--thinking high\" for Pi"),
        agentId: s("only for a follow-up: the agentId an earlier delegate returned; the same instance continues with its context. Leave out to start a new specialist"),
        folder: s("run the specialist in this folder instead of the project folder (absolute, ~/…, or relative to the project). GitLab Duo (harness duo) only runs in GitLab repositories, so point it at one"),
      }, ["role", "goal"]),
      handler: (a, c) => d.orch.delegate(c.agentId, a),
    },
    {
      set: "core", name: "create_agent",
      description: "Create a new custom agent (any kind of specialist you need: its own instructions, tools, harness) when no existing role fits, "
        + "and optionally run it right away with a brief. Saved to the user's agents (reusable) unless keep is false. Afterwards delegate to it by name.",
      inputSchema: obj({
        name: s("short slug, e.g. can-log-analyst"), title: s("display name"), description: s("one line: what it does"), icon: s("one emoji (optional)"),
        instructions: s("its complete operating instructions: role, how to work, what to return"),
        tools: { type: "array", items: { type: "string" }, description: "extra MCP servers it needs (e.g. jazz, office); flashmaster-core is always included" },
        harness: { type: "string", enum: ["copilot", "opencode", "cursor", "claude", "pi", "duo"], description: "agent CLI to run it on (optional)" },
        model: s("model id (optional); Pi: provider/model, e.g. qwen-local-8800/qwen3.8:27b"), provider: s("Pi/OpenCode provider (optional)"),
        args: s("extra command-line arguments for the agent CLI (optional)"),
        keep: { type: "boolean", description: "save as a reusable agent (default true); false = only until the app restarts" },
        goal: s("optional: run it now with this goal (same as delegate)"), context: s("facts it needs"), files: { type: "array", items: { type: "string" }, description: "relevant paths" },
        acceptance: s("done when…"), wait: { type: "boolean", description: "wait for the result when goal is given (default true)" },
      }, ["name", "instructions"]),
      handler: (a, c) => d.orch.createAgent(c.agentId, a),
    },
    {
      set: "core", name: "get_result", description: "Get status and compact result of a delegated agent.",
      inputSchema: obj({ agentId: s("agent id from delegate") }, ["agentId"]),
      handler: async (a) => d.orch.getResult(a.agentId),
    },
    {
      set: "core", name: "agent_status",
      description: "Where another agent of this project is right now, without interrupting it: working or not, for how long, when it last sent output, "
        + "whether its process is alive (GitLab Duo says little until it answers: quiet + processAlive = still working, not stale), its last STATUS line, "
        + "recent progress lines, current step and the end of what it is writing. Use it instead of guessing that a quiet specialist is stuck.",
      inputSchema: obj({ agentId: s("agent id from delegate or list_agents") }, ["agentId"]),
      handler: async (a, c) => d.orch.agentStatus(c.agentId, String(a.agentId ?? "")),
    },
    {
      set: "core", name: "message_agent",
      description: "Send a message to a specialist you started (any harness, GitLab Duo included): a question, new context, a correction, or \"send me your status\". "
        + "Working: it gets the message inside its running turn where the harness can, else when that turn ends; interrupt: true stops the turn now and "
        + "continues the same session with your message. Idle: starts a follow-up. Its reply comes back to you like a delegated result.",
      inputSchema: obj({
        agentId: s("agent id delegate returned"), message: s("what to tell or ask it"),
        interrupt: { type: "boolean", description: "stop its running turn and deliver the message now (default false: delivered when the turn ends, or inside it when the harness supports that)" },
        wait: { type: "boolean", description: "idle agent only: wait for its reply (default false: the reply comes to you in a new message)" },
        timeoutSec: { type: "number", description: "max seconds to wait when wait is true (default 600)" },
      }, ["agentId", "message"]),
      handler: (a, c) => d.orch.messageAgent(c.agentId, a),
    },
    {
      set: "core", name: "read_report",
      description: "Read another agent's full report (its last finished reply), not just the short result delegate returns. Works for any agent of this project, "
        + "finished or working, at any depth: use it to pick up an earlier specialist's accepted report instead of delegating a helper or redoing the work. "
        + "Long reports come in slices: pass offset to continue while more is true; index 1, 2… reads older reports of the same agent.",
      inputSchema: obj({
        agentId: s("agent id (from list_agents with activeOnly: false, delegate or a results message)"),
        name: s("or the agent's name, e.g. Nova or \"Nova · Coder\", or a role name for its latest instance"),
        offset: { type: "number", description: "character offset to start at (default 0)" },
        limit: { type: "number", description: "characters to return (default 12000, max 40000)" },
        index: { type: "number", description: "0 = latest report (default), 1 = the one before…" },
      }),
      handler: async (a, c) => d.orch.readReport(c.agentId, a),
    },
    {
      set: "core", name: "list_roles", description: "List available specialist roles.",
      inputSchema: obj({}),
      handler: async () => d.roles().map((r) => ({ name: r.name, title: r.title, description: r.description })),
    },
    {
      set: "core", name: "list_agents", description: "List agents of the current project with status. activeOnly: false also lists finished agents (with a one-line result), whose full report read_report returns.",
      inputSchema: obj({ activeOnly: { type: "boolean", description: "default true; false includes finished and closed agents" } }),
      handler: async (a, c) => d.db.listAgents({ projectId: d.orch.agentProject(c.agentId), activeOnly: a.activeOnly ?? true })
        .map((x) => ({ id: x.id, name: x.name, role: x.role, status: x.status, activity: x.lastActivity, specialist: !!x.parentAgentId,
          ...(x.branch ? { branch: x.branch } : {}),
          ...(a.activeOnly === false && x.resultSummary ? { result: (/summary:\s*(.+)/.exec(x.resultSummary)?.[1] ?? x.resultSummary).replace(/\s+/g, " ").slice(0, 160) } : {}) })),
    },
    {
      set: "core", name: "close_agent",
      description: "Close (stop) a specialist agent of this project: its CLI session ends and it leaves the agent chips (history stays). "
        + "Refused for an agent that is working, paused, waiting for approval or has queued messages, and for one whose worktree holds "
        + "uncommitted or unmerged work (it waits for review). force: true stops a working agent too; only use it when the user asked. "
        + "A worktree with work in it is always kept. Returns closed: true, or closed: false with the reason it was kept.",
      inputSchema: obj({ agentId: s("agent id from list_agents or delegate"), force: { type: "boolean", description: "stop it even if it is working (only when the user asked)" } }, ["agentId"]),
      handler: async (a, c) => d.orch.closeAgent(c.agentId, String(a.agentId ?? ""), { force: a.force === true }),
    },
    {
      set: "core", name: "close_idle_agents",
      description: "Clean up: close every specialist of this project that is idle and safe to close. Working agents and agents with "
        + "unmerged or uncommitted worktree work are kept. Returns the closed agents and the kept ones with the reason.",
      inputSchema: obj({}),
      handler: async (_a, c) => d.orch.closeIdleAgents(c.agentId),
    },
    {
      set: "core", name: "report_progress",
      description: "Publish/update your step plan for multi-step work (shown to the user as a live flow chart). Call once with all steps, then again as steps complete. Keep titles short.",
      inputSchema: obj({ steps: { type: "array", items: obj({ title: s("step"), status: { type: "string", enum: ["pending", "in_progress", "completed", "failed"] } }, ["title", "status"]) } }, ["steps"]),
      handler: async (a, c) => {
        d.orch.setPlan(c.agentId, (a.steps ?? []).slice(0, 30).map((x: any) => ({ title: String(x.title).slice(0, 120), status: x.status ?? "pending" })));
        return { ok: true };
      },
    },
    {
      set: "core", name: "ask_user",
      description: "Ask the user something you can't go on without (a decision, missing access or credentials, an unclear requirement). "
        + "They see a clear card in the chat with your question, why you're blocked and the options; their answer comes back to you as a new message. "
        + "After calling it, end your turn with a short note. Only for what you can't decide yourself: missing access or credentials, a change to what the user asked for, an irreversible step. "
        + "From a delegated specialist the question goes to the agent that delegated to you instead, which answers it or takes it to the user.",
      inputSchema: obj({
        question: s("the question, one or two sentences"), why: s("what is blocked and why you need the user (optional)"),
        options: { type: "array", items: { type: "string" }, description: "short quick answers, recommended first (optional; the user can also type their own)" },
        recommended: { type: "number", description: "index of the option you recommend (default 0)" },
        blocked: { type: "boolean", description: "true when you are blocked (missing access, broken environment) rather than asking for a decision" },
      }, ["question"]),
      handler: async (a, c) => d.orch.askUser(c.agentId, a),
    },
    {
      set: "core", name: "create_task", description: "Create a task in the project's task board.",
      inputSchema: obj({ title: s("short title"), description: s("details"), priority: { type: "number", description: "1 high … 4 low" },
        assigneeRole: s("role to assign"), jazzId: s("linked Jazz work item id"), parentId: s("parent task id") }, ["title"]),
      handler: async (a, c) => {
        const t = d.db.createTask({ ...a, projectId: d.orch.agentProject(c.agentId) });
        d.emitTask(t);
        return brief(t);
      },
    },
    {
      set: "core", name: "update_task", description: `Update a task. status: ${TASK_STATUSES.join(" | ")}`,
      inputSchema: obj({ id: s("task id"), status: { type: "string", enum: TASK_STATUSES }, title: s(""), description: s(""),
        priority: { type: "number" }, assigneeRole: s("") }, ["id"]),
      handler: async (a) => {
        const { id, ...patch } = a;
        const t = d.db.updateTask(id, patch);
        d.emitTask(t);
        return brief(t);
      },
    },
    {
      set: "core", name: "delete_task",
      description: "Delete a task of this project's task board. Refused for a task in review or one whose agent is still active, unless force: true (only when the user asked).",
      inputSchema: obj({ id: s("task id"), force: { type: "boolean", description: "delete even if in review or its agent is active" } }, ["id"]),
      handler: async (a, c) => {
        const t = d.db.getTask(String(a.id ?? ""));
        if (!t || t.projectId !== d.orch.agentProject(c.agentId)) throw new Error("unknown task id: use an id from list_tasks (this project only)");
        if (a.force !== true) {
          if (t.status === "review") return { id: t.id, deleted: false, reason: "it is in review (work waiting for the user)" };
          const ag = t.agentId ? d.db.getAgent(t.agentId) : null;
          if (ag && ag.endedAt == null && ["idle", "running", "paused", "interrupted"].includes(ag.status)) return { id: t.id, deleted: false, reason: "its agent is still active; close the agent first" };
        }
        d.db.deleteTask(t.id);
        d.deleteTask?.(t.id);
        return { id: t.id, deleted: true };
      },
    },
    {
      set: "core", name: "list_tasks", description: "List tasks of the current project (compact).",
      inputSchema: obj({ status: { type: "string", enum: TASK_STATUSES } }),
      handler: async (a, c) => d.db.listTasks({ projectId: d.orch.agentProject(c.agentId), status: a.status }).slice(0, 50).map(brief),
    },
    {
      set: "core", name: "save_artifact", description: "Store large material (logs, reports, full analyses) and get a short id to reference instead of pasting it.",
      inputSchema: obj({ title: s("title"), content: s("full content"), kind: s("report | log | diff | data") }, ["title", "content"]),
      handler: async (a, c) => {
        const id = d.db.addArtifact({ agentId: c.agentId || null, kind: a.kind ?? "report", title: a.title, content: a.content }).id;
        if (c.agentId) d.onArtifact?.(c.agentId);
        return { id };
      },
    },
    {
      set: "core", name: "fetch_artifact", description: "Read a stored artifact (optionally a slice). Fetch only what you need.",
      inputSchema: obj({ id: s("artifact id"), offset: { type: "number" }, length: { type: "number", description: "chars, default 4000" } }, ["id"]),
      handler: async (a) => {
        const art = d.db.getArtifact(a.id);
        if (!art) throw new Error("artifact not found");
        const off = a.offset ?? 0;
        const len = a.length ?? 4000;
        return { title: art.title, total: art.content.length, offset: off, content: art.content.slice(off, off + len) };
      },
    },
    {
      set: "core", name: "diagram_svg",
      description: "Render a diagram as offline inline SVG for an HTML report: ishikawa (fishbone), flowchart, timeline or sequence. "
        + "With file + marker, inserts it into that .html file in place of <!-- diagram:<marker> --> and returns only a confirmation; without file, returns the SVG.",
      inputSchema: obj({
        kind: { type: "string", enum: [...DIAGRAM_KINDS] },
        spec: { type: "object", description: "ishikawa {problem, categories: {name: [cause…]}} · flowchart {nodes: [{id, label, kind?: start|step|decision|end}], edges: [{from, to, label?}]} · "
          + "timeline {events: [{when, label, detail?}]} · sequence {participants: [name…], messages: [{from, to, label, reply?}]}" },
        file: s("optional: path of the .html file (relative to your working folder) to insert the diagram into"),
        marker: s("with file: the name in the <!-- diagram:<marker> --> comment to replace"),
      }, ["kind", "spec"]),
      handler: async (a, c) => {
        const svg = renderDiagram(a.kind, a.spec);
        if (!a.file) return { svg };
        if (d.readOnly?.()) throw new Error("read-only mode is on (Settings → Permissions): call without file and write the SVG yourself, or ask the user");
        const base = d.orch.agentWorkDir(c.agentId);
        if (!base) throw new Error("no working folder: call without file to get the SVG");
        const path = resolve(base, a.file);
        const rel = relative(realpathSync(base), realpathSync(path));
        if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("file must be inside your working folder");
        if (!/\.html?$/i.test(path)) throw new Error("file must be an .html file");
        const marker = String(a.marker ?? "").trim();
        if (!marker) throw new Error("marker is required with file");
        const html = readFileSync(path, "utf8");
        const re = new RegExp(`<!--\\s*diagram:\\s*${marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*-->`);
        if (!re.test(html)) throw new Error(`marker <!-- diagram:${marker} --> not found in ${a.file}`);
        writeFileSync(path, html.replace(re, () => `<figure class="diagram-figure">${svg}</figure>`));
        return { ok: true, file: a.file, marker, bytes: svg.length };
      },
    },
    // ---------------- Memory (user / project / short-term) ----------------
    {
      set: "core", name: "memory_save",
      description: "Remember something for later turns and other agents. One self-contained fact per call, written so it makes sense without this chat "
        + "(who/what/why, no 'this' or 'above'). scope: user = about the user, for every project (preferences, conventions, who they are); "
        + "project = shared with every agent of this project (decisions, architecture facts, procedures, gotchas); "
        + "session = short-term notes for this chat only (expires). A near-duplicate is merged automatically; similar memories are returned so you can update or replace them. "
        + "Save when the user says 'remember', states a preference, or a decision is made. Never save secrets or tokens.",
      inputSchema: obj({
        content: s("the fact, one or two sentences"), scope: scopeProp("user | project | session (default session)"),
        kind: { type: "string", enum: [...MEMORY_KINDS], description: "fact (default) | preference | decision | procedure | episode" },
        tags: { type: "array", items: { type: "string" }, description: "a few keywords (optional)" },
        importance: { type: "number", description: "1 trivia … 5 critical (default 3)" },
        pinned: { type: "boolean", description: "always show to agents, whatever they work on (use rarely)" },
        replaces: { type: "array", items: { type: "number" }, description: "ids of memories this one corrects (they are deleted)" },
      }, ["content"]),
      handler: async (a, c) => {
        const r = mem().save(a, memCtx(c.agentId));
        return changed({ id: r.memory.id, scope: r.memory.scope, status: r.status, ...(r.replaced.length ? { replaced: r.replaced } : {}),
          ...(r.similar.length ? { similar: r.similar, hint: "similar memories exist: update or delete them if this one supersedes them" } : {}) });
      },
    },
    {
      set: "core", name: "memory_search",
      description: "Find saved memories relevant to a question (hybrid keyword + fuzzy search, ranked by relevance, recency and importance). "
        + "Searches user, this project's and this chat's memories unless scope narrows it. Search before asking the user something they may have told you already.",
      inputSchema: obj({
        query: s("what you want to know, in words"), scope: scopeProp("only this scope (optional)"),
        kind: { type: "string", enum: [...MEMORY_KINDS] }, tag: s("only memories with this tag (optional)"), limit: { type: "number", description: "default 8, max 30" },
      }, ["query"]),
      handler: async (a, c) => mem().search(String(a.query ?? ""), memCtx(c.agentId), { scopes: a.scope ? [a.scope] : undefined, kind: a.kind, tag: a.tag,
        limit: Math.min(Number(a.limit) || 8, 30) }).map((h) => ({ ...memBrief(h), score: h.score })),
    },
    {
      set: "core", name: "memory_list",
      description: "List memories you can see (pinned first, then newest), optionally by scope, kind or tag. Use memory_search to find something specific.",
      inputSchema: obj({ scope: scopeProp("only this scope (optional)"), kind: { type: "string", enum: [...MEMORY_KINDS] }, tag: s("tag (optional)"),
        limit: { type: "number", description: "default 30, max 100" } }),
      handler: async (a, c) => mem().list(memCtx(c.agentId), { scopes: a.scope ? [a.scope] : undefined, kind: a.kind, tag: a.tag,
        limit: Math.min(Number(a.limit) || 30, 100) }).map(memBrief),
    },
    {
      set: "core", name: "memory_update",
      description: "Correct or refine a memory (content, kind, tags, importance, pinned). Use when a fact changed instead of saving a contradicting one.",
      inputSchema: obj({ id: { type: "number", description: "memory id" }, content: s("new text (optional)"), kind: { type: "string", enum: [...MEMORY_KINDS] },
        tags: { type: "array", items: { type: "string" } }, importance: { type: "number" }, pinned: { type: "boolean" } }, ["id"]),
      handler: async (a, c) => {
        const m = mem().require(a.id, memCtx(c.agentId));
        return changed(memBrief(mem().update(m.id, { content: a.content, kind: a.kind, tags: a.tags, importance: a.importance, pinned: a.pinned })));
      },
    },
    {
      set: "core", name: "memory_delete",
      description: "Forget a memory that is wrong, outdated or no longer useful.",
      inputSchema: obj({ id: { type: "number", description: "memory id" } }, ["id"]),
      handler: async (a, c) => {
        const m = mem().require(a.id, memCtx(c.agentId));
        return changed({ id: m.id, deleted: mem().delete(m.id) });
      },
    },
    {
      set: "core", name: "memory_promote",
      description: "Keep a short-term memory for good: move it to project (shared with this project's agents) or user (every project) scope. "
        + "Also moves a project memory to user scope. Promoted memories no longer expire; a duplicate in the target is merged.",
      inputSchema: obj({ id: { type: "number", description: "memory id" }, to: { type: "string", enum: ["project", "user"], description: "target scope" } }, ["id", "to"]),
      handler: async (a, c) => {
        const ctx = memCtx(c.agentId);
        const m = mem().require(a.id, ctx);
        const r = mem().promote(m.id, a.to, ctx);
        return changed({ ...memBrief(r.memory), status: r.status });
      },
    },
    // ---------------- Project knowledge base (synced with .flashmaster/knowledge in the repo) ----------------
    {
      set: "core", name: "knowledge_list",
      description: "List the entries of this project's knowledge base (team-reviewed docs kept in the repo under .flashmaster/knowledge): slug, title, tags, size.",
      inputSchema: obj({}),
      handler: async (_a, c) => {
        const k = kb(c.agentId);
        k.kb.sync(k.projectId);
        const cp = k.kb.readCheckpoint(k.projectId);
        return { checkpoint: cp?.commit ?? null, entries: mem().knowledgeEntries(k.projectId).map((m) => ({ slug: m.kbSlug, title: entryTitle(m.content, m.kbSlug!),
          ...(m.tags.length ? { tags: m.tags } : {}), chars: m.content.length, updated: new Date(m.updatedAt).toISOString().slice(0, 10) })) };
      },
    },
    {
      set: "core", name: "knowledge_read",
      description: "Read one knowledge base entry in full (Markdown).",
      inputSchema: obj({ slug: s("entry slug from knowledge_list") }, ["slug"]),
      handler: async (a, c) => {
        const k = kb(c.agentId);
        const m = mem().getKnowledge(k.projectId, String(a.slug ?? "").trim().toLowerCase());
        if (!m) throw new Error(`no knowledge entry '${String(a.slug)}': use a slug from knowledge_list`);
        return { slug: m.kbSlug, content: m.content, ...(m.tags.length ? { tags: m.tags } : {}), importance: m.importance };
      },
    },
    {
      set: "core", name: "knowledge_write",
      description: "Add or replace one knowledge base entry: a Markdown document on one topic, starting with '# Title' (overview, module map, build/test/release, conventions, gotchas, decisions, glossary). "
        + "It is saved in the app and written to .flashmaster/knowledge/<slug>.md in the repo for the team to review. Replaces the whole entry: read it first to keep what is still right.",
      inputSchema: obj({
        slug: s("short kebab-case name, e.g. build-and-release"), content: s("the whole entry, Markdown, starting with '# Title'"),
        tags: { type: "array", items: { type: "string" }, description: "a few keywords (optional)" },
        importance: { type: "number", description: "1 … 5 (default 3); 4–5 for what every agent should know" },
      }, ["slug", "content"]),
      handler: async (a, c) => {
        const k = kb(c.agentId);
        const r = k.kb.write(k.projectId, { slug: a.slug, content: a.content, tags: a.tags, importance: a.importance }, k.ctx);
        return changed({ slug: r.memory.kbSlug, file: `.flashmaster/knowledge/${r.memory.kbSlug}.md`, chars: r.memory.content.length, ...syncNote(r.sync) });
      },
    },
    {
      set: "core", name: "knowledge_delete",
      description: "Delete a knowledge base entry that is wrong or obsolete (its file in the repo folder goes too).",
      inputSchema: obj({ slug: s("entry slug") }, ["slug"]),
      handler: async (a, c) => {
        const k = kb(c.agentId);
        const r = k.kb.remove(k.projectId, String(a.slug ?? ""));
        return changed({ slug: a.slug, deleted: r.deleted, ...syncNote(r.sync) });
      },
    },
    {
      set: "core", name: "knowledge_checkpoint",
      description: "Call once when a knowledge base build or update is finished: records the current commit in .flashmaster/knowledge/manifest.json, so the next update only looks at changes after it.",
      inputSchema: obj({}),
      handler: async (_a, c) => {
        const k = kb(c.agentId);
        const r = await k.kb.checkpoint(k.projectId);
        return changed({ checkpoint: r.commit, entries: r.sync.entries, ...(r.commit ? {} : { note: "not a git repository: no commit to record" }), ...syncNote(r.sync) });
      },
    },
    {
      set: "core", name: "code_graph",
      description: "Ask the project's code graph (built by graphify when the user presses Scan code; summary in the knowledge entry code-map). Cheaper than reading many files to find how parts connect. "
        + "command: query (question → relevant symbols and relations), explain (one node and its neighbours), path (shortest connection from → to), god_nodes (most connected abstractions), affected (what depends on node). "
        + "Nodes are symbols, files or labels, e.g. 'Orchestrator', 'src/main/db.ts'.",
      inputSchema: obj({
        command: { type: "string", enum: [...CODE_GRAPH_COMMANDS], description: "what to ask" },
        question: s("query: the question in words"), node: s("explain / affected: a symbol, file or label"),
        from: s("path: start node"), to: s("path: end node"),
        budget: { type: "number", description: "query: output token cap (default 1500)" }, top: { type: "number", description: "god_nodes: how many (default 15)" },
      }, ["command"]),
      handler: async (a, c) => {
        if (!d.codeGraph) throw new Error("the code graph is not available");
        const projectId = memCtx(c.agentId).projectId;
        if (!projectId) throw new Error("the code graph belongs to a project: this chat has no project folder");
        if (!CODE_GRAPH_COMMANDS.includes(a.command)) throw new Error(`command must be one of ${CODE_GRAPH_COMMANDS.join(", ")}`);
        return { result: await d.codeGraph.ask(projectId, a.command as CodeGraphCommand, a) };
      },
    },
    // ---------------- Jazz ----------------
    {
      set: "jazz", name: "jazz_query",
      description: "Find IBM Jazz/EWM work items across the configured project areas. query: ids ('123,456'), a reportable-API filter (\"owner/userId='jdoe'\"), or words to match. Optional: projectArea, state open|closed|all, type, owner me|unassigned.",
      inputSchema: obj({
        query: s("ids, filter or words (may be empty with other filters)"), projectArea: s("limit to one project area"),
        state: s("open (default) | closed | all"), type: s("e.g. Defect, Task"), owner: s("me | unassigned"), max: { type: "number", description: "default 20" },
      }),
      handler: async (a) => {
        const q = String(a.query ?? "").trim();
        const list = a.state || a.type || a.owner || !q
          ? await jazz().search({ text: /[=<>]/.test(q) ? "" : q, raw: /[=<>]/.test(q) ? q : "", projectAreas: a.projectArea ? [a.projectArea] : undefined,
            state: a.state, type: a.type, owner: a.owner, max: a.max ?? 20 })
          : await jazz().query(q, a.max ?? 20, a.projectArea);
        return list.map((w) => ({ id: w.id, title: w.title, type: w.type, state: w.state, owner: w.owner, area: w.projectArea, prio: w.priority }));
      },
    },
    {
      set: "jazz", name: "jazz_get", description: "Get one work item with its description; comments: true adds the discussion (last 10).",
      inputSchema: obj({ id: s("work item id"), comments: { type: "boolean" } }, ["id"]),
      handler: async (a) => {
        if (!a.comments) return jazz().get(a.id);
        const d = await jazz().detail(a.id);
        return { ...d.item, comments: d.comments.slice(-10).map((c) => ({ ...c, text: c.text.slice(0, 1500) })) };
      },
    },
    {
      set: "jazz", name: "jazz_links",
      description: "Links of a work item: parent, children, related, blocks/depends on, duplicates, tracks, implemented/affected requirements, test cases, change sets. Linked work items come with title and state; fetch one with jazz_get.",
      inputSchema: obj({ id: s("work item id"), kind: s("only this kind, e.g. child, parent, related, requirement (optional)") }, ["id"]),
      handler: async (a) => {
        const all = await jazz().links(a.id, true);
        const k = String(a.kind ?? "").toLowerCase().trim();
        return k ? all.filter((l) => l.kind.includes(k.replace(/ren$/, ""))) : all;
      },
    },
    {
      set: "jazz", name: "jazz_project_areas", description: "List the Jazz/EWM project areas you can access, and the ones configured for searches.",
      inputSchema: obj({}),
      handler: async () => ({ configured: d.jazzAreas?.() ?? [], available: await jazz().listProjectAreas() }),
    },
    {
      set: "jazz", name: "jazz_update",
      description: "Update work item attributes via OSLC property names (e.g. {\"dcterms:title\": \"…\"}); optional workflow action id to change state.",
      inputSchema: obj({ id: s("work item id"), attributes: { type: "object" }, action: s("workflow action id, optional") }, ["id"]),
      handler: async (a) => jazz().update(a.id, a.attributes ?? {}, a.action),
    },
    {
      set: "jazz", name: "jazz_comment", description: "Add a comment to a work item (e.g. analysis results).",
      inputSchema: obj({ id: s("work item id"), text: s("comment text") }, ["id", "text"]),
      handler: async (a) => { await jazz().comment(a.id, a.text); return { ok: true }; },
    },
    // ---------------- ETM test management (Reportable REST API + OSLC QM for requirement links) ----------------
    {
      set: "jazz", name: "qm_projects", description: "List the ETM (test management) project areas you can access, and the one configured.",
      inputSchema: obj({}),
      handler: async () => ({ projects: await etm().projects(true) }),
    },
    {
      set: "jazz", name: "qm_list",
      description: `List or find ETM artifacts. type: ${QM_TYPES.join(" | ")} (also plan, suite, case, script, tcer/record, result). query: words matched in the title, or ids "12,15". filter: optional reportable-API condition, e.g. "owner='jdoe'". Returns id, title, state.`,
      inputSchema: obj({ type: s("artifact type"), query: s("words or ids, optional"), filter: s("server-side condition, optional"), max: { type: "number", description: "default 25, max 200" }, projectArea: s("ETM project area, default the configured one") }, ["type"]),
      handler: async (a) => etm().list(qmType(a.type), { text: a.query, filter: a.filter, max: Math.min(a.max ?? 25, 200), projectArea: a.projectArea }),
    },
    {
      set: "jazz", name: "qm_get",
      description: "One ETM artifact with its fields, links (test plan → test cases/suites, test case → scripts, record → case/plan, result → record) and test script steps. requirements: true adds the requirements a test case validates.",
      inputSchema: obj({ type: s("artifact type"), id: s("id or URL"), requirements: { type: "boolean" }, projectArea: s("optional") }, ["type", "id"]),
      handler: async (a) => {
        const t = qmType(a.type);
        const item = await etm().item(t, String(a.id), a.projectArea);
        if (a.requirements && t === "testcase") return { ...item, requirements: await etm().requirementLinks(item.id, a.projectArea).catch((e) => `unavailable: ${e?.message ?? e}`) };
        return item;
      },
    },
    {
      set: "jazz", name: "qm_create",
      description: "Create an ETM test plan, test suite, test case, test script (with steps) or execution record. links: target type → ids, e.g. a test plan {testcase: [\"12\"], testsuite: [\"3\"]}, a test case {testscript: [\"7\"]}, a suite {testcase: [...]}, a record {testcase: [\"12\"], testplan: [\"2\"]}. Record results with qm_record_result. Returns the new artifact with its id.",
      inputSchema: obj({
        type: s("testplan | testsuite | testcase | testscript | executionworkitem"), title: s("title"), description: s("description, optional"),
        owner: s("owner user id, optional"), fields: { type: "object", description: "other simple elements by name, e.g. {\"weight\": \"5\"}" },
        links: { type: "object", description: "target type → array of ids or URLs" },
        steps: { type: "array", description: "test script steps", items: obj({ description: s("what to do"), expected: s("expected result"), name: s("optional") }, ["description"]) },
        projectArea: s("optional"),
      }, ["type", "title"]),
      handler: async (a) => etm().create(qmType(a.type), { title: a.title, description: a.description, owner: a.owner, fields: a.fields, addLinks: a.links, steps: a.steps } as QmWrite, a.projectArea),
    },
    {
      set: "jazz", name: "qm_update",
      description: "Edit an ETM artifact: change title/description/owner/state or other fields, add or remove links (e.g. add test cases to a plan or suite, attach a script to a test case), or replace a test script's steps. Fields you don't pass stay as they are.",
      inputSchema: obj({
        type: s("artifact type"), id: s("id or URL"), title: s("optional"), description: s("optional"), owner: s("optional"), state: s("optional, full state id"),
        fields: { type: "object", description: "other simple elements by name" },
        addLinks: { type: "object", description: "target type → ids to link" }, removeLinks: { type: "object", description: "target type → ids to unlink" },
        steps: { type: "array", description: "test script only: the new full list of steps", items: obj({ description: s("what to do"), expected: s("expected result"), name: s("optional") }, ["description"]) },
        projectArea: s("optional"),
      }, ["type", "id"]),
      handler: async (a) => etm().update(qmType(a.type), String(a.id), { title: a.title, description: a.description, owner: a.owner, state: a.state, fields: a.fields, addLinks: a.addLinks, removeLinks: a.removeLinks, steps: a.steps }, a.projectArea),
    },
    {
      set: "jazz", name: "qm_record_result",
      description: `Record a test run in ETM: finds the test case's execution record in the plan (creates one if there is none) and adds an execution result. verdict: ${VERDICTS.join(" | ")}.`,
      inputSchema: obj({
        testcase: s("test case id"), testplan: s("test plan id, optional but recommended"), record: s("execution record id, optional"),
        verdict: s("passed, failed, blocked…"), title: s("optional"), notes: s("what was observed, optional"), start: s("ISO time, optional"), end: s("ISO time, optional"), projectArea: s("optional"),
      }, ["testcase", "verdict"]),
      handler: async (a) => etm().recordResult(a),
    },
    {
      set: "jazz", name: "qm_link_requirement",
      description: "Link a test case to the requirement it validates (DOORS Next: pass the requirement URL that rm_get returns), or remove the link with remove: true. Returns the test case's requirement links.",
      inputSchema: obj({ testcase: s("test case id"), requirement: s("requirement URL"), remove: { type: "boolean" }, projectArea: s("optional") }, ["testcase", "requirement"]),
      handler: async (a) => ({ requirements: await etm().linkRequirement(String(a.testcase), String(a.requirement), !!a.remove, a.projectArea) }),
    },
    // ---------------- EWM source control (read-only: nothing is checked in or delivered) ----------------
    {
      set: "jazz", name: "scm_streams", description: "List EWM source control streams (name, id). query: words in the name, optional.",
      inputSchema: obj({ query: s("optional"), max: { type: "number", description: "default 50" } }),
      handler: async (a) => scm().streams({ text: a.query, max: a.max ?? 50 }),
    },
    {
      set: "jazz", name: "scm_components", description: "Components of an EWM stream.",
      inputSchema: obj({ stream: s("stream name or id") }, ["stream"]),
      handler: async (a) => scm().components(String(a.stream)),
    },
    {
      set: "jazz", name: "scm_list", description: "Files and folders under a path of a component in a stream (needs the EWM SCM command line on this PC). depth: default 1.",
      inputSchema: obj({ stream: s("stream name or id"), component: s("component name or id"), path: s("folder, default the component root"), depth: { type: "number" } }, ["stream", "component"]),
      handler: async (a) => {
        const all = await scm().list(String(a.stream), String(a.component), a.path ?? "/", a.depth ?? 1);
        return { count: all.length, entries: all.slice(0, 500).map((e) => e.folder ? `${e.path}/` : e.path), ...(all.length > 500 ? { note: "first 500 shown; narrow the path" } : {}) };
      },
    },
    {
      set: "jazz", name: "scm_find_files", description: "Find files in a component by glob (\"*.c\", \"src/**/can_*.h\") or words in the path (needs the EWM SCM command line).",
      inputSchema: obj({ stream: s("stream name or id"), component: s("component name or id"), pattern: s("glob or words"), path: s("folder to search, optional") }, ["stream", "component", "pattern"]),
      handler: async (a) => { const hits = await scm().find(String(a.stream), String(a.component), String(a.pattern), a.path ?? "/"); return { count: hits.length, files: hits.slice(0, 200).map((e) => e.path) }; },
    },
    {
      set: "jazz", name: "scm_read_file", description: "Read a text file from an EWM stream (latest version). Big files: pass startLine and lines (default 400 lines).",
      inputSchema: obj({ stream: s("stream name or id"), component: s("component name or id"), path: s("file path inside the component"), startLine: { type: "number" }, lines: { type: "number" } }, ["stream", "component", "path"]),
      handler: async (a) => scm().readFile(String(a.stream), String(a.component), String(a.path), { startLine: a.startLine, lines: a.lines }),
    },
    {
      set: "jazz", name: "scm_download", description: "Copy text files from an EWM stream into your working folder (read-only on the EWM side). to: folder relative to your working folder, default ewm/<component>.",
      inputSchema: obj({ stream: s("stream name or id"), component: s("component name or id"), paths: { type: "array", items: { type: "string" }, description: "file paths inside the component (max 50)" }, to: s("target folder, optional") }, ["stream", "component", "paths"]),
      handler: async (a, ctx) => {
        const root = agentDir(ctx.agentId);
        const to = String(a.to ?? `ewm/${String(a.component).replace(/[^\w.-]+/g, "_")}`);
        if (isAbsolute(to)) throw new Error("to must be relative to your working folder");
        const base = resolve(root, to);
        if (relative(root, base).startsWith("..")) throw new Error("to must stay inside your working folder");
        const saved: string[] = [], failed: string[] = [];
        for (const p of (a.paths ?? []).slice(0, 50)) {
          try {
            const rel = normPath(String(p));
            const text = await scm().fileText(String(a.stream), String(a.component), rel);
            const out = join(base, rel);
            mkdirSync(dirname(out), { recursive: true });
            writeFileSync(out, text);
            saved.push(relative(root, out).replace(/\\/g, "/"));
          } catch (e: any) { failed.push(`${p}: ${e?.message ?? e}`); }
        }
        return { saved, ...(failed.length ? { failed } : {}) };
      },
    },
    // ---------------- DOORS Next requirements (targeted retrieval: search → get, never whole modules) ----------------
    {
      set: "jazz", name: "rm_modules",
      description: "List DOORS Next requirement modules. project: project name or id (default: the configured projects). Returns id, title.",
      inputSchema: obj({ project: s("project name or id, optional"), refresh: { type: "boolean" } }),
      handler: async (a) => {
        const projects = await rm().projects();
        const wanted = a.project ? projects.filter((p) => p.id === a.project || p.title.toLowerCase().includes(String(a.project).toLowerCase()))
          : projects.filter((p) => !(d.rmProjects?.() ?? []).length || (d.rmProjects?.() ?? []).includes(p.title));
        const out: { project: string; modules: { id: string; title: string }[] }[] = [];
        for (const p of wanted.slice(0, 8)) out.push({ project: p.title, modules: (await rm().modules(p.id, a.refresh)).map((m) => ({ id: m.identifier || m.uuid, title: m.title })) });
        return out;
      },
    },
    {
      set: "jazz", name: "rm_outline",
      description: "Heading structure of a requirements module (section, title, number of requirements per section). Cheap way to orient before searching.",
      inputSchema: obj({ module: s("module id, title or URL"), maxDepth: { type: "number", description: "default 3" } }, ["module"]),
      handler: async (a) => rm().outline(a.module, a.maxDepth ?? 3),
    },
    {
      set: "jazz", name: "rm_search",
      description: "Find the requirements most relevant to a question (ranked, short text). Use this instead of reading whole modules. query: words or requirement ids. modules: ids/titles to search (default: all loaded).",
      inputSchema: obj({
        query: s("what you are looking for, e.g. 'brake light debounce timing' or '1234 1240'"),
        modules: { type: "array", items: { type: "string" }, description: "module ids or titles" },
        type: s("artifact type filter, e.g. 'System Requirement'"), top: { type: "number", description: "default 10, max 40" },
      }, ["query"]),
      handler: async (a) => rm().search(a.query, { modules: a.modules, type: a.type, top: Math.min(a.top ?? 10, 40) }),
    },
    {
      set: "jazz", name: "rm_get",
      description: "Full text, attributes and links of specific requirements by id (after rm_search).",
      inputSchema: obj({ ids: { type: "array", items: { type: "string" } }, module: s("module id or title, optional") }, ["ids"]),
      handler: async (a) => (await rm().get((a.ids ?? []).slice(0, 25), a.module)).map((r) => ({
        id: r.id, module: r.module, section: r.section, type: r.type, text: r.text.slice(0, 3000), attrs: r.attrs,
        links: r.links.slice(0, 10).map((l) => `${l.type}: ${l.title ?? l.target}`), url: r.uri,
      })),
    },
  ];
}
