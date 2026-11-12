import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import type {
  AgentRun, AgentStatus, Artifact, Chat, HarnessId, Message, MessageStatus, Project, Task, TaskStatus, UsageSummary,
} from "@shared/types";

const MIGRATIONS: string[] = [
  `CREATE TABLE projects(id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL);
   CREATE TABLE chats(id TEXT PRIMARY KEY, project_id TEXT REFERENCES projects(id) ON DELETE CASCADE, title TEXT NOT NULL,
     kind TEXT NOT NULL, agent_role TEXT NOT NULL, harness TEXT, model TEXT, superpowers INTEGER NOT NULL DEFAULT 0,
     summary TEXT, summary_upto INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
   CREATE TABLE messages(id TEXT PRIMARY KEY, chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
     parent_id TEXT, author TEXT NOT NULL, agent_id TEXT, role TEXT, content TEXT NOT NULL, status TEXT NOT NULL,
     tokens_in INTEGER NOT NULL DEFAULT 0, tokens_out INTEGER NOT NULL DEFAULT 0, estimated INTEGER NOT NULL DEFAULT 1,
     seq INTEGER NOT NULL, created_at INTEGER NOT NULL);
   CREATE INDEX messages_chat ON messages(chat_id, parent_id, seq);
   CREATE TABLE reactions(message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE, emoji TEXT NOT NULL,
     created_at INTEGER NOT NULL, PRIMARY KEY(message_id, emoji));
   CREATE TABLE agents(id TEXT PRIMARY KEY, project_id TEXT, chat_id TEXT, role TEXT NOT NULL, harness TEXT NOT NULL,
     model TEXT, status TEXT NOT NULL, parent_agent_id TEXT, session_id TEXT, brief TEXT NOT NULL, result_summary TEXT,
     tokens_in INTEGER NOT NULL DEFAULT 0, tokens_out INTEGER NOT NULL DEFAULT 0, estimated INTEGER NOT NULL DEFAULT 1,
     last_activity TEXT, started_at INTEGER NOT NULL, ended_at INTEGER);
   CREATE TABLE tasks(id TEXT PRIMARY KEY, project_id TEXT, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
     status TEXT NOT NULL, priority INTEGER NOT NULL DEFAULT 3, assignee_role TEXT, agent_id TEXT, parent_id TEXT,
     jazz_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
   CREATE TABLE usage(id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT, project_id TEXT, harness TEXT NOT NULL,
     role TEXT NOT NULL, tokens_in INTEGER NOT NULL, tokens_out INTEGER NOT NULL, estimated INTEGER NOT NULL, at INTEGER NOT NULL);
   CREATE INDEX usage_at ON usage(at);
   CREATE TABLE artifacts(id TEXT PRIMARY KEY, agent_id TEXT, kind TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL,
     bytes INTEGER NOT NULL, created_at INTEGER NOT NULL);`,
];

type Row = Record<string, any>;
const now = () => Date.now();
export const newId = () => randomUUID();

export class Db {
  readonly raw: DatabaseSync;
  private seq = 0;

  constructor(file: string) {
    this.raw = new DatabaseSync(file);
    this.raw.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000;");
    this.migrate();
    const r = this.raw.prepare("SELECT COALESCE(MAX(seq),0) AS s FROM messages").get() as Row;
    this.seq = Number(r.s);
  }

  private migrate(): void {
    const v = Number((this.raw.prepare("PRAGMA user_version").get() as Row).user_version);
    for (let i = v; i < MIGRATIONS.length; i++) {
      this.raw.exec("BEGIN");
      try {
        this.raw.exec(MIGRATIONS[i]!);
        this.raw.exec(`PRAGMA user_version=${i + 1}`);
        this.raw.exec("COMMIT");
      } catch (e) {
        this.raw.exec("ROLLBACK");
        throw e;
      }
    }
  }

  close(): void {
    this.raw.close();
  }

  private all(sql: string, ...p: any[]): Row[] {
    return this.raw.prepare(sql).all(...p) as Row[];
  }
  private get(sql: string, ...p: any[]): Row | undefined {
    return this.raw.prepare(sql).get(...p) as Row | undefined;
  }
  private run(sql: string, ...p: any[]): void {
    this.raw.prepare(sql).run(...p);
  }

  // ---------- projects ----------
  listProjects(): Project[] {
    return this.all("SELECT * FROM projects ORDER BY name COLLATE NOCASE").map(toProject);
  }
  getProject(id: string): Project | null {
    const r = this.get("SELECT * FROM projects WHERE id=?", id);
    return r ? toProject(r) : null;
  }
  createProject(name: string, path: string): Project {
    const existing = this.get("SELECT * FROM projects WHERE path=?", path);
    if (existing) return toProject(existing);
    const p: Project = { id: newId(), name, path, createdAt: now() };
    this.run("INSERT INTO projects VALUES(?,?,?,?)", p.id, p.name, p.path, p.createdAt);
    return p;
  }
  removeProject(id: string): void {
    this.run("DELETE FROM projects WHERE id=?", id);
  }

  // ---------- chats ----------
  listChats(projectId: string | null): Chat[] {
    const rows = projectId === null
      ? this.all("SELECT * FROM chats WHERE project_id IS NULL AND kind='project' ORDER BY created_at")
      : this.all("SELECT * FROM chats WHERE project_id=? ORDER BY created_at", projectId);
    return rows.map(toChat);
  }
  getChat(id: string): Chat | null {
    const r = this.get("SELECT * FROM chats WHERE id=?", id);
    return r ? toChat(r) : null;
  }
  getOrCreateMasterChat(): Chat {
    const r = this.get("SELECT * FROM chats WHERE kind='master' LIMIT 1");
    if (r) return toChat(r);
    return this.createChat({ projectId: null, title: "TheFlashMaster", kind: "master", agentRole: "flashmaster" });
  }
  createChat(i: { projectId: string | null; title: string; kind: "master" | "project"; agentRole: string }): Chat {
    const c: Chat = {
      id: newId(), projectId: i.projectId, title: i.title, kind: i.kind, agentRole: i.agentRole,
      harness: null, model: null, superpowers: false, createdAt: now(),
    };
    this.run("INSERT INTO chats(id,project_id,title,kind,agent_role,harness,model,superpowers,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
      c.id, c.projectId, c.title, c.kind, c.agentRole, null, null, 0, c.createdAt);
    return c;
  }
  updateChat(id: string, patch: Partial<Chat>): Chat {
    const c = this.getChat(id);
    if (!c) throw new Error(`chat ${id} not found`);
    const n = { ...c, ...patch };
    this.run("UPDATE chats SET title=?, agent_role=?, harness=?, model=?, superpowers=? WHERE id=?",
      n.title, n.agentRole, n.harness, n.model, n.superpowers ? 1 : 0, id);
    return n;
  }
  deleteChat(id: string): void {
    this.run("DELETE FROM chats WHERE id=?", id);
  }
  getChatSummary(id: string): { summary: string | null; upto: number } {
    const r = this.get("SELECT summary, summary_upto FROM chats WHERE id=?", id);
    return { summary: (r?.summary as string) ?? null, upto: Number(r?.summary_upto ?? 0) };
  }
  setChatSummary(id: string, summary: string, upto: number): void {
    this.run("UPDATE chats SET summary=?, summary_upto=? WHERE id=?", summary, upto, id);
  }

  // ---------- messages ----------
  listMessages(chatId: string, parentId: string | null): Message[] {
    const rows = parentId === null
      ? this.all("SELECT * FROM messages WHERE chat_id=? AND parent_id IS NULL ORDER BY seq", chatId)
      : this.all("SELECT * FROM messages WHERE chat_id=? AND (parent_id=? OR id=?) ORDER BY seq", chatId, parentId, parentId);
    return rows.map((r) => this.hydrate(r));
  }
  /** Messages with their seq, for context building (main thread or one thread). */
  history(chatId: string, parentId: string | null, afterSeq = 0): (Message & { seq: number })[] {
    const rows = parentId === null
      ? this.all("SELECT * FROM messages WHERE chat_id=? AND parent_id IS NULL AND seq>? ORDER BY seq", chatId, afterSeq)
      : this.all("SELECT * FROM messages WHERE chat_id=? AND (parent_id=? OR id=?) AND seq>? ORDER BY seq", chatId, parentId, parentId, afterSeq);
    return rows.map((r) => ({ ...this.hydrate(r), seq: Number(r.seq) }));
  }
  getMessage(id: string): Message | null {
    const r = this.get("SELECT * FROM messages WHERE id=?", id);
    return r ? this.hydrate(r) : null;
  }
  addMessage(i: { chatId: string; parentId?: string | null; author: Message["author"]; content: string; agentId?: string | null;
    role?: string | null; status?: MessageStatus }): Message {
    const id = newId();
    this.seq += 1;
    this.run("INSERT INTO messages(id,chat_id,parent_id,author,agent_id,role,content,status,seq,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
      id, i.chatId, i.parentId ?? null, i.author, i.agentId ?? null, i.role ?? null, i.content, i.status ?? "done", this.seq, now());
    return this.getMessage(id)!;
  }
  updateMessage(id: string, patch: { content?: string; status?: MessageStatus; tokensIn?: number; tokensOut?: number; estimated?: boolean }): Message {
    const m = this.getMessage(id);
    if (!m) throw new Error(`message ${id} not found`);
    this.run("UPDATE messages SET content=?, status=?, tokens_in=?, tokens_out=?, estimated=? WHERE id=?",
      patch.content ?? m.content, patch.status ?? m.status, patch.tokensIn ?? m.tokensIn, patch.tokensOut ?? m.tokensOut,
      (patch.estimated ?? m.estimated) ? 1 : 0, id);
    return this.getMessage(id)!;
  }
  toggleReaction(messageId: string, emoji: string): string[] {
    const exists = this.get("SELECT 1 FROM reactions WHERE message_id=? AND emoji=?", messageId, emoji);
    if (exists) this.run("DELETE FROM reactions WHERE message_id=? AND emoji=?", messageId, emoji);
    else this.run("INSERT INTO reactions VALUES(?,?,?)", messageId, emoji, now());
    return this.reactions(messageId);
  }
  reactions(messageId: string): string[] {
    return this.all("SELECT emoji FROM reactions WHERE message_id=? ORDER BY created_at", messageId).map((r) => r.emoji as string);
  }
  private hydrate(r: Row): Message {
    const replyCount = r.parent_id ? 0 : Number(this.get("SELECT COUNT(*) AS c FROM messages WHERE parent_id=?", r.id)?.c ?? 0);
    return {
      id: r.id, chatId: r.chat_id, parentId: r.parent_id ?? null, author: r.author, agentId: r.agent_id ?? null,
      role: r.role ?? null, content: r.content, status: r.status, tokensIn: Number(r.tokens_in), tokensOut: Number(r.tokens_out),
      estimated: !!r.estimated, createdAt: Number(r.created_at), reactions: this.reactions(r.id), replyCount,
    };
  }

  // ---------- agents ----------
  createAgent(i: { projectId: string | null; chatId: string | null; role: string; harness: HarnessId; model: string | null;
    parentAgentId?: string | null; brief: string }): AgentRun {
    const id = newId();
    this.run("INSERT INTO agents(id,project_id,chat_id,role,harness,model,status,parent_agent_id,brief,started_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
      id, i.projectId, i.chatId, i.role, i.harness, i.model, "idle", i.parentAgentId ?? null, i.brief, now());
    return this.getAgent(id)!;
  }
  getAgent(id: string): AgentRun | null {
    const r = this.get("SELECT * FROM agents WHERE id=?", id);
    return r ? toAgent(r) : null;
  }
  listAgents(f: { projectId?: string | null; activeOnly?: boolean } = {}): AgentRun[] {
    const where: string[] = [];
    const p: any[] = [];
    if (f.projectId !== undefined) {
      if (f.projectId === null) where.push("project_id IS NULL");
      else { where.push("project_id=?"); p.push(f.projectId); }
    }
    if (f.activeOnly) where.push("status IN ('idle','running','paused')");
    const sql = `SELECT * FROM agents ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY started_at DESC LIMIT 500`;
    return this.all(sql, ...p).map(toAgent);
  }
  updateAgent(id: string, patch: { status?: AgentStatus; sessionId?: string; resultSummary?: string; lastActivity?: string;
    ended?: boolean }): AgentRun {
    const sets: string[] = [];
    const p: any[] = [];
    if (patch.status) { sets.push("status=?"); p.push(patch.status); }
    if (patch.sessionId !== undefined) { sets.push("session_id=?"); p.push(patch.sessionId); }
    if (patch.resultSummary !== undefined) { sets.push("result_summary=?"); p.push(patch.resultSummary); }
    if (patch.lastActivity !== undefined) { sets.push("last_activity=?"); p.push(patch.lastActivity.slice(0, 200)); }
    if (patch.ended) { sets.push("ended_at=?"); p.push(now()); }
    if (sets.length) this.run(`UPDATE agents SET ${sets.join(",")} WHERE id=?`, ...p, id);
    return this.getAgent(id)!;
  }
  getAgentSession(id: string): string | null {
    return (this.get("SELECT session_id FROM agents WHERE id=?", id)?.session_id as string) ?? null;
  }
  /** Mark agents left running by a previous app session as stopped. */
  reapOrphans(): void {
    this.run("UPDATE agents SET status='stopped', ended_at=? WHERE status IN ('idle','running','paused')", now());
    this.run("UPDATE messages SET status='error' WHERE status='streaming'");
  }

  // ---------- usage ----------
  recordUsage(i: { agentId: string | null; projectId: string | null; harness: HarnessId; role: string; tokensIn: number;
    tokensOut: number; estimated: boolean }): void {
    this.run("INSERT INTO usage(agent_id,project_id,harness,role,tokens_in,tokens_out,estimated,at) VALUES(?,?,?,?,?,?,?,?)",
      i.agentId, i.projectId, i.harness, i.role, i.tokensIn, i.tokensOut, i.estimated ? 1 : 0, now());
    if (i.agentId) {
      this.run("UPDATE agents SET tokens_in=tokens_in+?, tokens_out=tokens_out+?, estimated=MIN(estimated,?) WHERE id=?",
        i.tokensIn, i.tokensOut, i.estimated ? 1 : 0, i.agentId);
    }
  }
  tokensSince(since: number, f: { projectId?: string } = {}): number {
    const r = f.projectId
      ? this.get("SELECT COALESCE(SUM(tokens_in+tokens_out),0) AS t FROM usage WHERE at>=? AND project_id=?", since, f.projectId)
      : this.get("SELECT COALESCE(SUM(tokens_in+tokens_out),0) AS t FROM usage WHERE at>=?", since);
    return Number(r?.t ?? 0);
  }
  usageSummary(days: number, dailyLimit: number): UsageSummary {
    const since = now() - days * 86400000;
    const tot = this.get(`SELECT COALESCE(SUM(tokens_in),0) ti, COALESCE(SUM(tokens_out),0) tout,
      COALESCE(SUM(CASE WHEN estimated=1 THEN tokens_in+tokens_out ELSE 0 END),0) est FROM usage WHERE at>=?`, since)!;
    const agents = this.get("SELECT COUNT(*) c, SUM(CASE WHEN status IN ('running','paused','idle') THEN 1 ELSE 0 END) r FROM agents WHERE started_at>=?", since)!;
    const group = (col: string) => this.all(`SELECT ${col} AS k, SUM(tokens_in+tokens_out) AS t FROM usage WHERE at>=? GROUP BY ${col} ORDER BY t DESC`, since);
    const projects = new Map(this.listProjects().map((p) => [p.id, p.name]));
    const all = Number(tot.ti) + Number(tot.tout);
    const day = this.all(`SELECT strftime('%Y-%m-%d', at/1000, 'unixepoch', 'localtime') AS k, SUM(tokens_in+tokens_out) AS t
      FROM usage WHERE at>=? GROUP BY k ORDER BY k`, since);
    const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
    return {
      totals: { tokensIn: Number(tot.ti), tokensOut: Number(tot.tout), estimatedShare: all ? Number(tot.est) / all : 0,
        agents: Number(agents.c ?? 0), running: Number(agents.r ?? 0) },
      byProject: group("project_id").map((r) => ({ key: r.k ?? "master", label: r.k ? (projects.get(r.k) ?? "(removed)") : "Master chat", tokens: Number(r.t) })),
      byRole: group("role").map((r) => ({ key: r.k, label: r.k, tokens: Number(r.t) })),
      byHarness: group("harness").map((r) => ({ key: r.k, label: r.k, tokens: Number(r.t) })),
      byDay: day.map((r) => ({ key: r.k, label: String(r.k).slice(5), tokens: Number(r.t) })),
      budget: { dailyLimit, usedToday: this.tokensSince(startOfDay.getTime()) },
    };
  }

  // ---------- tasks ----------
  listTasks(f: { projectId?: string | null; status?: TaskStatus } = {}): Task[] {
    const where: string[] = [];
    const p: any[] = [];
    if (f.projectId !== undefined) {
      if (f.projectId === null) where.push("project_id IS NULL");
      else { where.push("project_id=?"); p.push(f.projectId); }
    }
    if (f.status) { where.push("status=?"); p.push(f.status); }
    return this.all(`SELECT * FROM tasks ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY priority, updated_at DESC`, ...p).map(toTask);
  }
  getTask(id: string): Task | null {
    const r = this.get("SELECT * FROM tasks WHERE id=?", id);
    return r ? toTask(r) : null;
  }
  createTask(i: Partial<Task> & { title: string }): Task {
    const t: Task = {
      id: newId(), projectId: i.projectId ?? null, title: i.title, description: i.description ?? "", status: i.status ?? "todo",
      priority: i.priority ?? 3, assigneeRole: i.assigneeRole ?? null, agentId: i.agentId ?? null, parentId: i.parentId ?? null,
      jazzId: i.jazzId ?? null, createdAt: now(), updatedAt: now(),
    };
    this.run("INSERT INTO tasks VALUES(?,?,?,?,?,?,?,?,?,?,?,?)", t.id, t.projectId, t.title, t.description, t.status, t.priority,
      t.assigneeRole, t.agentId, t.parentId, t.jazzId, t.createdAt, t.updatedAt);
    return t;
  }
  updateTask(id: string, patch: Partial<Task>): Task {
    const t = this.getTask(id);
    if (!t) throw new Error(`task ${id} not found`);
    const n: Task = { ...t, ...patch, id, updatedAt: now() };
    this.run("UPDATE tasks SET project_id=?, title=?, description=?, status=?, priority=?, assignee_role=?, agent_id=?, parent_id=?, jazz_id=?, updated_at=? WHERE id=?",
      n.projectId, n.title, n.description, n.status, n.priority, n.assigneeRole, n.agentId, n.parentId, n.jazzId, n.updatedAt, id);
    return n;
  }
  deleteTask(id: string): void {
    this.run("DELETE FROM tasks WHERE id=?", id);
  }

  // ---------- artifacts ----------
  addArtifact(i: { agentId: string | null; kind: string; title: string; content: string }): Artifact {
    const a: Artifact = { id: newId().slice(0, 8), agentId: i.agentId, kind: i.kind, title: i.title, content: i.content,
      bytes: Buffer.byteLength(i.content), createdAt: now() };
    this.run("INSERT INTO artifacts VALUES(?,?,?,?,?,?,?)", a.id, a.agentId, a.kind, a.title, a.content, a.bytes, a.createdAt);
    return a;
  }
  getArtifact(id: string): Artifact | null {
    const r = this.get("SELECT * FROM artifacts WHERE id=?", id);
    return r ? { id: r.id, agentId: r.agent_id, kind: r.kind, title: r.title, content: r.content, bytes: Number(r.bytes), createdAt: Number(r.created_at) } : null;
  }

  // ---------- maintenance ----------
  applyRetention(days: number): void {
    if (days <= 0) return;
    const cutoff = now() - days * 86400000;
    this.run("DELETE FROM usage WHERE at<?", cutoff);
    this.run("DELETE FROM artifacts WHERE created_at<?", cutoff);
    this.run("DELETE FROM agents WHERE ended_at IS NOT NULL AND ended_at<?", cutoff);
  }
  exportAll(): Record<string, Row[]> {
    const out: Record<string, Row[]> = {};
    for (const t of ["projects", "chats", "messages", "reactions", "agents", "tasks", "usage", "artifacts"]) out[t] = this.all(`SELECT * FROM ${t}`);
    return out;
  }
}

const toProject = (r: Row): Project => ({ id: r.id, name: r.name, path: r.path, createdAt: Number(r.created_at) });
const toChat = (r: Row): Chat => ({
  id: r.id, projectId: r.project_id ?? null, title: r.title, kind: r.kind, agentRole: r.agent_role, harness: r.harness ?? null,
  model: r.model ?? null, superpowers: !!r.superpowers, createdAt: Number(r.created_at),
});
const toAgent = (r: Row): AgentRun => ({
  id: r.id, projectId: r.project_id ?? null, chatId: r.chat_id ?? null, role: r.role, harness: r.harness, model: r.model ?? null,
  status: r.status, parentAgentId: r.parent_agent_id ?? null, brief: r.brief, resultSummary: r.result_summary ?? null,
  tokensIn: Number(r.tokens_in), tokensOut: Number(r.tokens_out), estimated: !!r.estimated, startedAt: Number(r.started_at),
  endedAt: r.ended_at == null ? null : Number(r.ended_at), lastActivity: r.last_activity ?? null,
});
const toTask = (r: Row): Task => ({
  id: r.id, projectId: r.project_id ?? null, title: r.title, description: r.description, status: r.status, priority: Number(r.priority),
  assigneeRole: r.assignee_role ?? null, agentId: r.agent_id ?? null, parentId: r.parent_id ?? null, jazzId: r.jazz_id ?? null,
  createdAt: Number(r.created_at), updatedAt: Number(r.updated_at),
});
