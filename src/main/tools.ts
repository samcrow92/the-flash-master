import type { Task } from "@shared/types";
import { TASK_STATUSES } from "@shared/types";
import type { Db } from "./db";
import type { Orchestrator } from "./orchestrator";
import type { ToolDef } from "./bridge";
import type { JazzClient } from "./jazz";
import type { RoleDef } from "@shared/types";

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required });
const s = (description: string) => ({ type: "string", description });

/** Tools exposed to agents through the flashmaster-core and jazz MCP servers. Results are kept compact on purpose. */
export function buildTools(d: {
  db: Db; orch: Orchestrator; roles: () => RoleDef[]; jazz: () => JazzClient | null; emitTask: (t: Task) => void;
}): ToolDef[] {
  const jazz = () => {
    const j = d.jazz();
    if (!j) throw new Error("Jazz integration is not configured (Settings → Integrations → IBM Jazz)");
    return j;
  };
  const brief = (t: Task) => ({ id: t.id, title: t.title, status: t.status, priority: t.priority, assignee: t.assigneeRole, jazz: t.jazzId });
  return [
    {
      set: "core", name: "delegate",
      description: "Hand a focused sub-task to a specialist agent. Send a brief (goal, context, files, acceptance), never transcripts. Returns the specialist's compact result.",
      inputSchema: obj({
        role: s("specialist role name, see list_roles"), goal: s("what to achieve, one or two sentences"),
        context: s("only the facts the specialist needs"), files: { type: "array", items: { type: "string" }, description: "relevant paths" },
        acceptance: s("done when…"), wait: { type: "boolean", description: "wait for the result (default true)" },
        timeoutSec: { type: "number", description: "max seconds to wait (default 600)" },
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
      handler: async (a, c) => ({ id: d.db.addArtifact({ agentId: c.agentId || null, kind: a.kind ?? "report", title: a.title, content: a.content }).id }),
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
      description: "Find IBM Jazz/EWM work items. query: ids ('123,456'), a reportable-API filter (\"state/group='open' and owner/userId='jdoe'\"), or words to match in summaries.",
      inputSchema: obj({ query: s("query"), max: { type: "number", description: "default 20" } }, ["query"]),
      handler: async (a) => (await jazz().query(a.query, a.max ?? 20)).map((w) => ({ id: w.id, title: w.title, type: w.type, state: w.state, owner: w.owner })),
    },
    {
      set: "jazz", name: "jazz_get", description: "Get one work item with its description.",
      inputSchema: obj({ id: s("work item id") }, ["id"]),
      handler: async (a) => jazz().get(a.id),
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
  ];
}
