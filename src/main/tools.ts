import type { Task } from "@shared/types";
import { TASK_STATUSES } from "@shared/types";
import type { Db } from "./db";
import type { Orchestrator } from "./orchestrator";
import type { ToolDef } from "./bridge";
import type { JazzClient } from "./jazz";
import type { Requirements } from "./requirements";
import type { RoleDef } from "@shared/types";

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required });
const s = (description: string) => ({ type: "string", description });

/** Tools exposed to agents through the flashmaster-core and jazz MCP servers. Results are kept compact on purpose. */
export function buildTools(d: {
  db: Db; orch: Orchestrator; roles: () => RoleDef[]; jazz: () => JazzClient | null; emitTask: (t: Task) => void;
  requirements?: Requirements; rmProjects?: () => string[]; onArtifact?: (agentId: string) => void;
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
  const brief = (t: Task) => ({ id: t.id, title: t.title, status: t.status, priority: t.priority, assignee: t.assigneeRole, jazz: t.jazzId });
  return [
    {
      set: "core", name: "delegate",
      description: "Hand a focused sub-task to a specialist agent. Send a brief (goal, context, files, acceptance), never transcripts. Returns the specialist's compact result. This is the only way to run another agent (including on Copilot/OpenCode/Pi/Duo via `harness`): it gets the project's tools and shows in the Agents tab.",
      inputSchema: obj({
        role: s("specialist role name, see list_roles"), goal: s("what to achieve, one or two sentences"),
        context: s("only the facts the specialist needs"), files: { type: "array", items: { type: "string" }, description: "relevant paths" },
        acceptance: s("done when…"), wait: { type: "boolean", description: "wait for the result (default true)" },
        timeoutSec: { type: "number", description: "max seconds to wait (default 600)" },
        harness: { type: "string", enum: ["copilot", "opencode", "pi", "duo"], description: "run the specialist on this agent CLI (e.g. the user asked for Pi). Default: the role's configured harness. Never start agent CLIs from a shell instead." },
        model: s("model id for that harness (optional)"),
      }, ["role", "goal"]),
      handler: (a, c) => d.orch.delegate(c.agentId, a),
    },
    {
      set: "core", name: "get_result", description: "Get status and compact result of a delegated agent.",
      inputSchema: obj({ agentId: s("agent id from delegate") }, ["agentId"]),
      handler: async (a) => d.orch.getResult(a.agentId),
    },
    {
      set: "core", name: "list_roles", description: "List available specialist roles.",
      inputSchema: obj({}),
      handler: async () => d.roles().map((r) => ({ name: r.name, title: r.title, description: r.description })),
    },
    {
      set: "core", name: "list_agents", description: "List agents of the current project with status.",
      inputSchema: obj({ activeOnly: { type: "boolean" } }),
      handler: async (a, c) => d.db.listAgents({ projectId: d.orch.agentProject(c.agentId), activeOnly: a.activeOnly ?? true })
        .map((x) => ({ id: x.id, role: x.role, status: x.status, activity: x.lastActivity })),
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
