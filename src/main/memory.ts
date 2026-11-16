/**
 * Agent memory — three scopes in the app's SQLite database (no cloud, no extra runtime dependency):
 *
 *  - user     global memory about the user (preferences, conventions); every agent in every project sees it.
 *  - project  shared between the coordinator and all specialists of one project (decisions, facts, procedures).
 *             project_id NULL = the master chat's workspace (no project folder).
 *  - session  short-term memory of one chat; expires after `shortTermDays` unless promoted to a long-term scope.
 *
 * Retrieval is hybrid, as in Mem0 / Zep / Letta archival search: a lexical ranking (FTS5 BM25, LIKE fallback) and a
 * fuzzy ranking (cosine over hashed word + character-trigram vectors, which catches inflections and typos without an
 * embedding model) are fused with Reciprocal Rank Fusion, then blended with recency (exponential decay) and
 * importance, the scoring of Generative Agents. Saving consolidates: a near-duplicate in the same scope is merged
 * instead of added (Mem0's ADD / UPDATE / NOOP), and close-but-different memories are returned so the agent can
 * update or replace them.
 */
import type { Memory, MemoryHit, MemoryKind, MemoryScope } from "@shared/types";
import { MEMORY_KINDS, MEMORY_SCOPES } from "@shared/types";
import type { Db } from "./db";

type Row = Record<string, any>;
const DAY = 86_400_000;
export const MAX_MEMORY_CHARS = 2000;
/** Above this similarity a new memory is the same fact: merge instead of adding. */
export const DUPLICATE_AT = 0.9;
/** Above this, report it as similar so the agent can decide to update / replace. */
export const SIMILAR_AT = 0.55;

/** Where an agent (or the UI) stands: decides which project / session memories it can see. */
export interface MemoryContext {
  projectId: string | null;
  chatId: string | null;
  agentId?: string | null;
  role?: string | null;
}

export interface SaveInput {
  content: string;
  scope?: MemoryScope;
  kind?: MemoryKind;
  tags?: string[] | string;
  importance?: number;
  pinned?: boolean;
  /** Ids of memories this one replaces (they are deleted), e.g. a corrected fact. */
  replaces?: number[];
}

export interface SaveResult {
  memory: Memory;
  status: "saved" | "merged";
  similar: { id: number; scope: MemoryScope; content: string; similarity: number }[];
  replaced: number[];
}

export interface SearchOptions {
  scopes?: MemoryScope[];
  kind?: MemoryKind;
  tag?: string;
  limit?: number;
  /** Minimum relevance (0…1) a hit needs (default 0.1, which drops chance fuzzy matches). */
  minRelevance?: number;
  /** Count the hits as used (recency / access statistics). Default true. */
  touch?: boolean;
  /** Hide these ids (already shown to the agent). */
  exclude?: Iterable<number>;
}

export class MemoryStore {
  readonly index: "fts" | "like";
  /** Days a short-term (session) memory lives. Read per save, so a settings change applies right away. */
  shortTermDays = () => 7;
  halfLifeDays = 30;

  constructor(private db: Db, private now: () => number = Date.now) {
    this.index = this.ensureIndex();
  }

  private get raw() { return this.db.raw; }
  private all(sql: string, ...p: any[]): Row[] { return this.raw.prepare(sql).all(...p) as Row[]; }
  private one(sql: string, ...p: any[]): Row | undefined { return this.raw.prepare(sql).get(...p) as Row | undefined; }
  private run(sql: string, ...p: any[]) { return this.raw.prepare(sql).run(...p); }

  /** FTS5 index kept in step by triggers; created idempotently (not a migration) so a SQLite without FTS5 still works. */
  private ensureIndex(): "fts" | "like" {
    try {
      const fresh = !this.one("SELECT 1 FROM sqlite_master WHERE name='memories_fts'");
      this.raw.exec("BEGIN");
      try {
        this.raw.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(content, tags, tokenize='porter unicode61 remove_diacritics 2');
          CREATE TRIGGER IF NOT EXISTS memories_fts_ai AFTER INSERT ON memories BEGIN
            INSERT INTO memories_fts(rowid, content, tags) VALUES (new.id, new.content, new.tags); END;
          CREATE TRIGGER IF NOT EXISTS memories_fts_ad AFTER DELETE ON memories BEGIN
            DELETE FROM memories_fts WHERE rowid = old.id; END;
          CREATE TRIGGER IF NOT EXISTS memories_fts_au AFTER UPDATE OF content, tags ON memories BEGIN
            DELETE FROM memories_fts WHERE rowid = old.id;
            INSERT INTO memories_fts(rowid, content, tags) VALUES (new.id, new.content, new.tags); END;`);
        if (fresh) this.raw.exec("INSERT INTO memories_fts(rowid, content, tags) SELECT id, content, tags FROM memories");
        this.raw.exec("COMMIT");
      } catch (e) {
        this.raw.exec("ROLLBACK");
        throw e;
      }
      return "fts";
    } catch {
      return "like";
    }
  }

  get(id: number): Memory | null {
    const r = this.one("SELECT * FROM memories WHERE id=?", id);
    return r ? toMemory(r) : null;
  }

  /** May this context read / change the memory? user: always; project: same project; session: same chat. */
  visible(m: Memory, ctx: MemoryContext): boolean {
    if (m.scope === "user") return true;
    if (m.scope === "project") return m.projectId === ctx.projectId;
    return !!ctx.chatId && m.chatId === ctx.chatId;
  }

  /** The memory, or an error an agent can act on. */
  require(id: unknown, ctx: MemoryContext | null): Memory {
    const m = this.get(Number(id));
    if (!m || (ctx && !this.visible(m, ctx))) throw new Error(`unknown memory id ${String(id)}: use an id from memory_search or memory_list`);
    return m;
  }

  save(input: SaveInput, ctx: MemoryContext): SaveResult {
    const content = cleanContent(input.content);
    const scope = parseScope(input.scope, ctx);
    const kind = MEMORY_KINDS.includes(input.kind as MemoryKind) ? input.kind as MemoryKind : "fact";
    const tags = parseTags(input.tags);
    const importance = clampImportance(input.importance);
    const owner = this.owner(scope, ctx);
    const t = this.now();
    const replaced: number[] = [];
    for (const id of input.replaces ?? []) {
      const m = this.get(Number(id));
      if (m && this.visible(m, ctx)) { this.delete(m.id); replaced.push(m.id); }
    }
    // Consolidate: the same fact in the same place is merged, not stored twice.
    const peers = this.all(`SELECT * FROM memories WHERE scope=? AND project_id IS ? AND chat_id IS ?`, scope, owner.projectId, owner.chatId).map(toMemory);
    const sketch = vectorize(content);
    const scored = peers.map((m) => ({ m, sim: cosine(sketch, vectorize(m.content)) })).sort((a, b) => b.sim - a.sim);
    const dup = scored.find((x) => x.sim >= DUPLICATE_AT || normalize(x.m.content) === normalize(content));
    if (dup) {
      const keep = content.length >= dup.m.content.length ? content : dup.m.content;
      const merged = this.update(dup.m.id, {
        content: keep, kind, tags: [...new Set([...dup.m.tags, ...tags])], importance: Math.max(dup.m.importance, importance),
        pinned: dup.m.pinned || !!input.pinned,
      });
      return { memory: merged, status: "merged", similar: [], replaced };
    }
    const expires = scope === "session" ? t + Math.max(0.01, this.shortTermDays()) * DAY : null;
    const r = this.run(`INSERT INTO memories(scope, project_id, chat_id, kind, content, tags, importance, pinned, source_agent_id, source_role,
      created_at, updated_at, last_accessed_at, access_count, expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,0,?)`,
    scope, owner.projectId, owner.chatId, kind, content, tags.join(" "), importance, input.pinned ? 1 : 0, ctx.agentId ?? null, ctx.role ?? null, t, t, t, expires);
    const memory = this.get(Number(r.lastInsertRowid))!;
    const similar = scored.filter((x) => x.sim >= SIMILAR_AT).slice(0, 3)
      .map((x) => ({ id: x.m.id, scope: x.m.scope, content: clip(x.m.content, 200), similarity: round(x.sim) }));
    return { memory, status: "saved", similar, replaced };
  }

  update(id: number, patch: { content?: string; kind?: MemoryKind; tags?: string[] | string; importance?: number; pinned?: boolean }): Memory {
    const m = this.get(id);
    if (!m) throw new Error(`unknown memory id ${id}`);
    const n = {
      content: patch.content !== undefined ? cleanContent(patch.content) : m.content,
      kind: patch.kind && MEMORY_KINDS.includes(patch.kind) ? patch.kind : m.kind,
      tags: patch.tags !== undefined ? parseTags(patch.tags) : m.tags,
      importance: patch.importance !== undefined ? clampImportance(patch.importance) : m.importance,
      pinned: patch.pinned ?? m.pinned,
    };
    const t = this.now();
    // Using a short-term memory again keeps it alive for another full period.
    const expires = m.scope === "session" ? t + Math.max(0.01, this.shortTermDays()) * DAY : null;
    this.run("UPDATE memories SET content=?, kind=?, tags=?, importance=?, pinned=?, updated_at=?, expires_at=? WHERE id=?",
      n.content, n.kind, n.tags.join(" "), n.importance, n.pinned ? 1 : 0, t, expires, id);
    return this.get(id)!;
  }

  delete(id: number): boolean {
    return Number(this.run("DELETE FROM memories WHERE id=?", id).changes) > 0;
  }

  /**
   * Move a memory to a long-term scope (short-term → project or user; project → user). It stops expiring. If the target
   * already holds the same fact, the two are merged.
   */
  promote(id: number, to: MemoryScope, ctx: MemoryContext): SaveResult {
    const m = this.get(id);
    if (!m) throw new Error(`unknown memory id ${id}`);
    if (to === "session") throw new Error("promote moves a memory to a long-term scope: project or user");
    if (to === m.scope) return { memory: m, status: "saved", similar: [], replaced: [] };
    const target = { ...ctx, projectId: m.scope === "project" ? m.projectId : (m.projectId ?? ctx.projectId) };
    const owner = this.owner(to, target);
    const dup = this.all(`SELECT * FROM memories WHERE scope=? AND project_id IS ? AND chat_id IS NULL AND id<>?`, to, owner.projectId, id).map(toMemory)
      .find((x) => cosine(vectorize(x.content), vectorize(m.content)) >= DUPLICATE_AT);
    if (dup) {
      const merged = this.update(dup.id, { content: m.content.length >= dup.content.length ? m.content : dup.content,
        tags: [...new Set([...dup.tags, ...m.tags])], importance: Math.max(dup.importance, m.importance), pinned: dup.pinned || m.pinned });
      this.delete(id);
      return { memory: merged, status: "merged", similar: [], replaced: [id] };
    }
    this.run("UPDATE memories SET scope=?, project_id=?, chat_id=NULL, expires_at=NULL, updated_at=? WHERE id=?", to, owner.projectId, this.now(), id);
    return { memory: this.get(id)!, status: "saved", similar: [], replaced: [] };
  }

  /** Every memory the context can see (newest first), optionally narrowed. For the UI and memory_list. */
  list(ctx: MemoryContext | null, o: { scopes?: MemoryScope[]; kind?: MemoryKind; tag?: string; limit?: number; projectId?: string | null } = {}): Memory[] {
    const where: string[] = [];
    const p: any[] = [];
    if (ctx) {
      const vis = this.visibleSql(ctx);
      where.push(vis.sql); p.push(...vis.params);
    } else if (o.projectId !== undefined) {
      where.push("(scope='user' OR project_id IS ?)"); p.push(o.projectId);
    }
    if (o.scopes?.length) { where.push(`scope IN (${o.scopes.map(() => "?").join(",")})`); p.push(...o.scopes); }
    if (o.kind) { where.push("kind=?"); p.push(o.kind); }
    if (o.tag) { where.push("(' ' || tags || ' ') LIKE ?"); p.push(`% ${o.tag.toLowerCase()} %`); }
    const sql = `SELECT * FROM memories ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY pinned DESC, updated_at DESC LIMIT ?`;
    return this.all(sql, ...p, Math.min(Math.max(o.limit ?? 200, 1), 2000)).map(toMemory);
  }

  /** Hybrid ranked search over what the context can see. Empty query = most important / recent. */
  search(query: string, ctx: MemoryContext | null, o: SearchOptions & { projectId?: string | null } = {}): MemoryHit[] {
    const limit = Math.min(Math.max(o.limit ?? 8, 1), 50);
    const exclude = new Set(o.exclude ?? []);
    const pool = this.list(ctx, { scopes: o.scopes, kind: o.kind, tag: o.tag, limit: 2000, projectId: o.projectId }).filter((m) => !exclude.has(m.id));
    if (!pool.length) return [];
    const t = this.now();
    const q = query.trim();
    let hits: MemoryHit[];
    if (!q) {
      hits = pool.map((m) => ({ ...m, score: round(0.5 * this.recency(m, t) + 0.5 * (m.importance / 5) + (m.pinned ? 0.2 : 0)), relevance: 0 }));
    } else {
      const lexical = this.lexicalRank(q, new Set(pool.map((m) => m.id)));
      const qv = vectorize(q);
      const sims = pool.map((m) => ({ id: m.id, sim: cosine(qv, vectorize(`${m.content} ${m.tags.join(" ")}`)) }))
        .filter((x) => x.sim > FUZZY_FLOOR).sort((a, b) => b.sim - a.sim);
      // A weak fuzzy match (shared trigrams by chance) only counts a little: its rank weight grows with similarity.
      const weight = new Map(sims.map((x) => [x.id, Math.min(1, (x.sim - FUZZY_FLOOR) / 0.3)]));
      const rel = fuse([lexical, sims.map((x) => x.id)], [undefined, weight]);
      hits = pool.filter((m) => rel.has(m.id)).map((m) => {
        const relevance = rel.get(m.id)!;
        return { ...m, relevance: round(relevance), score: round(0.65 * relevance + 0.2 * this.recency(m, t) + 0.15 * (m.importance / 5) + (m.pinned ? 0.05 : 0)) };
      }).filter((h) => h.relevance >= (o.minRelevance ?? 0.1));
    }
    hits.sort((a, b) => b.score - a.score);
    const top = hits.slice(0, limit);
    if (o.touch !== false && top.length) {
      this.run(`UPDATE memories SET last_accessed_at=?, access_count=access_count+1 WHERE id IN (${top.map(() => "?").join(",")})`, t, ...top.map((h) => h.id));
    }
    return top;
  }

  /**
   * Memories worth putting in front of an agent before it works on `query`: pinned user memories always, then the
   * best relevant hits across user, project and session scope. Returns the rendered prompt block and the ids shown.
   */
  recall(query: string, ctx: MemoryContext, o: { max?: number; exclude?: Iterable<number>; minRelevance?: number } = {}): { text: string; ids: number[] } {
    const max = Math.max(0, o.max ?? 8);
    if (!max) return { text: "", ids: [] };
    const exclude = new Set(o.exclude ?? []);
    const pinned = this.list(ctx, { limit: 50 }).filter((m) => m.pinned && !exclude.has(m.id)).slice(0, Math.ceil(max / 2));
    for (const m of pinned) exclude.add(m.id);
    const hits = this.search(query, ctx, { limit: max - pinned.length, exclude, minRelevance: o.minRelevance ?? 0.25 });
    const shown = [...pinned, ...hits];
    if (!shown.length) return { text: "", ids: [] };
    const lines = shown.map((m) => `- [${m.id}] (${SCOPE_LABEL[m.scope]}${m.kind !== "fact" ? `, ${m.kind}` : ""}) ${clip(m.content, 400).replace(/\s+/g, " ")}`);
    return { text: `## Relevant memory\nSaved earlier; may be outdated. Fix wrong ones with memory_update / memory_delete.\n${lines.join("\n")}`, ids: shown.map((m) => m.id) };
  }

  /** Delete expired short-term memories and memories of chats / projects that no longer exist. Returns how many. */
  sweep(): number {
    const t = this.now();
    const r1 = this.run("DELETE FROM memories WHERE expires_at IS NOT NULL AND expires_at <= ?", t);
    const r2 = this.run("DELETE FROM memories WHERE scope='session' AND (chat_id IS NULL OR chat_id NOT IN (SELECT id FROM chats))");
    const r3 = this.run("DELETE FROM memories WHERE scope='project' AND project_id IS NOT NULL AND project_id NOT IN (SELECT id FROM projects)");
    return Number(r1.changes) + Number(r2.changes) + Number(r3.changes);
  }

  counts(projectId?: string | null): Record<MemoryScope, number> {
    const out: Record<MemoryScope, number> = { user: 0, project: 0, session: 0 };
    const rows = projectId === undefined ? this.all("SELECT scope, COUNT(*) AS c FROM memories GROUP BY scope")
      : this.all("SELECT scope, COUNT(*) AS c FROM memories WHERE scope='user' OR project_id IS ? GROUP BY scope", projectId);
    for (const r of rows) out[r.scope as MemoryScope] = Number(r.c);
    return out;
  }

  private owner(scope: MemoryScope, ctx: MemoryContext): { projectId: string | null; chatId: string | null } {
    if (scope === "user") return { projectId: null, chatId: null };
    if (scope === "project") return { projectId: ctx.projectId, chatId: null };
    if (!ctx.chatId) throw new Error("short-term (session) memory needs a chat: use scope project or user");
    return { projectId: ctx.projectId, chatId: ctx.chatId };
  }

  private visibleSql(ctx: MemoryContext): { sql: string; params: any[] } {
    return { sql: "(scope='user' OR (scope='project' AND project_id IS ?) OR (scope='session' AND chat_id=?))", params: [ctx.projectId, ctx.chatId ?? ""] };
  }

  private recency(m: Memory, t: number): number {
    const age = Math.max(0, t - Math.max(m.updatedAt, m.lastAccessedAt)) / DAY;
    return Math.pow(0.5, age / this.halfLifeDays);
  }

  /** Ids ranked by BM25 (FTS5, prefix match per term) or by how many terms a LIKE scan finds. */
  private lexicalRank(q: string, allowed: Set<number>): number[] {
    const terms = terms_(q);
    if (!terms.length) return [];
    if (this.index === "fts") {
      try {
        // OR, not AND: a memory matching some of the words is still a candidate; BM25 ranks fuller matches first.
        const match = terms.map((x) => `"${x}"*`).join(" OR ");
        return this.all("SELECT rowid AS id FROM memories_fts WHERE memories_fts MATCH ? ORDER BY bm25(memories_fts) LIMIT 200", match)
          .map((r) => Number(r.id)).filter((id) => allowed.has(id));
      } catch { /* fall through to LIKE */ }
    }
    const rows = this.all(`SELECT id, content, tags FROM memories WHERE id IN (${[...allowed].map(() => "?").join(",")})`, ...allowed);
    return rows.map((r) => {
      const hay = `${r.content} ${r.tags}`.toLowerCase();
      return { id: Number(r.id), n: terms.filter((x) => hay.includes(x)).length };
    }).filter((x) => x.n > 0).sort((a, b) => b.n - a.n).map((x) => x.id);
  }
}

export const SCOPE_LABEL: Record<MemoryScope, string> = { user: "user", project: "project", session: "short-term" };

function toMemory(r: Row): Memory {
  return {
    id: Number(r.id), scope: r.scope, projectId: r.project_id ?? null, chatId: r.chat_id ?? null, kind: r.kind, content: r.content,
    tags: String(r.tags ?? "").split(/\s+/).filter(Boolean), importance: Number(r.importance), pinned: !!r.pinned,
    sourceAgentId: r.source_agent_id ?? null, sourceRole: r.source_role ?? null, createdAt: Number(r.created_at), updatedAt: Number(r.updated_at),
    lastAccessedAt: Number(r.last_accessed_at), accessCount: Number(r.access_count), expiresAt: r.expires_at == null ? null : Number(r.expires_at),
  };
}

function parseScope(s: unknown, ctx: MemoryContext): MemoryScope {
  if (MEMORY_SCOPES.includes(s as MemoryScope)) return s as MemoryScope;
  if (s === "global") return "user";
  if (s === "short-term" || s === "short" || s === "chat") return "session";
  if (s == null || s === "") return ctx.chatId ? "session" : "project";
  throw new Error(`scope must be one of ${MEMORY_SCOPES.join(", ")}`);
}

function cleanContent(c: unknown): string {
  const s = String(c ?? "").trim();
  if (!s) throw new Error("memory content is empty");
  return s.length > MAX_MEMORY_CHARS ? s.slice(0, MAX_MEMORY_CHARS) : s;
}

export function parseTags(t: unknown): string[] {
  const list = Array.isArray(t) ? t : String(t ?? "").split(/[,\s]+/);
  return [...new Set(list.map((x) => String(x).toLowerCase().replace(/[^\p{L}\p{N}_.-]/gu, "")).filter(Boolean))].slice(0, 12);
}

function clampImportance(n: unknown): number {
  const v = Math.round(Number(n));
  return Number.isFinite(v) ? Math.min(5, Math.max(1, v)) : 3;
}

const normalize = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
const round = (n: number) => Math.round(n * 1000) / 1000;

const STOP = new Set("a an and are as at be by for from has have i in is it its of on or that the this to was were will with you your we our me my".split(" "));
function terms_(q: string): string[] {
  return [...new Set(normalize(q).split(" ").filter((w) => w.length > 1 && !STOP.has(w)))].slice(0, 16);
}

/** Below this cosine two texts share nothing meaningful. */
const FUZZY_FLOOR = 0.1;

/** Reciprocal Rank Fusion of several rankings, scaled to 0…1 (1 = first in every ranking); optional per-id weights (0…1). */
export function fuse(rankings: number[][], weights: (Map<number, number> | undefined)[] = [], k = 60): Map<number, number> {
  const out = new Map<number, number>();
  rankings.forEach((r, n) => r.forEach((id, i) => out.set(id, (out.get(id) ?? 0) + (weights[n]?.get(id) ?? 1) / (k + i + 1))));
  const best = rankings.length / (k + 1);
  for (const [id, v] of out) out.set(id, v / best);
  return out;
}

const DIM = 512;
/**
 * A tiny local "embedding": hashed bag of words plus character trigrams (sparse, L2-normalised). No model, no
 * dependency; good at paraphrases that share stems and at typos, which plain FTS misses.
 */
export function vectorize(text: string): Map<number, number> {
  const v = new Map<number, number>();
  const add = (s: string, w: number) => { const h = hash(s) % DIM; v.set(h, (v.get(h) ?? 0) + w); };
  for (const word of normalize(text).split(" ")) {
    if (!word || STOP.has(word)) continue;
    add(`w:${word}`, 1);
    const g = ` ${word} `;
    for (let i = 0; i + 3 <= g.length; i++) add(g.slice(i, i + 3), 0.5);
  }
  let norm = 0;
  for (const x of v.values()) norm += x * x;
  norm = Math.sqrt(norm) || 1;
  for (const [k, x] of v) v.set(k, x / norm);
  return v;
}

export function cosine(a: Map<number, number>, b: Map<number, number>): number {
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  let dot = 0;
  for (const [k, x] of small) { const y = big.get(k); if (y) dot += x * y; }
  return dot;
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
