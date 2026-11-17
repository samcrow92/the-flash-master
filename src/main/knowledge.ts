/**
 * Project knowledge base, kept in step with the project's git repo.
 *
 * Entries are project-scope memories with a slug (so recall, search and the Memory page work on them as on any
 * memory), and each one is also a Markdown file in `<project>/.flashmaster/knowledge/<slug>.md` that the team reviews,
 * edits and shares through git. `manifest.json` in that folder is the checkpoint: the commit the knowledge base was
 * last built or updated from, so the next update only looks at what changed since.
 *
 * Sync is a three-way merge per entry: the database, the file, and the hash both had at the last sync (the base).
 * Only the file changed → import it (a teammate's edit, a pull). Only the database changed → write the file (an agent's
 * or your edit). Both changed differently → a conflict you resolve by keeping one side; nothing is overwritten.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { KnowledgeConflict, KnowledgeStatus, KnowledgeSyncResult, Memory, MemoryKind } from "@shared/types";
import { MEMORY_KINDS } from "@shared/types";
import type { Db } from "./db";
import { clampImportance, MAX_KNOWLEDGE_CHARS, parseTags, type KnowledgeEntry, type MemoryStore } from "./memory";
import { defaultGit, type Git } from "./worktree";

/** Repo-relative folder (posix, as git prints it). */
export const KNOWLEDGE_DIR = ".flashmaster/knowledge";
export const MANIFEST = "manifest.json";
const INDEX = "README.md";

/**
 * `.flashmaster/.gitignore`: chat attachments and other local files stay out of git, the knowledge base is shared.
 * (Before the knowledge base the file was a bare `*`, which also hid the knowledge folder; ensureFlashmasterIgnore upgrades it.)
 */
export const FLASHMASTER_GITIGNORE = "# TheFlashMaster: local files (chat attachments…) stay out of git; the knowledge base is shared with the team.\n*\n!.gitignore\n!knowledge/\n!knowledge/**\n";

export function ensureFlashmasterIgnore(projectPath: string): void {
  const dir = join(projectPath, ".flashmaster");
  const file = join(dir, ".gitignore");
  let cur: string | null = null;
  try { cur = readFileSync(file, "utf8"); } catch { /* missing */ }
  if (cur !== null && cur.trim() !== "*") return; // ours already, or edited by the team: leave it
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, FLASHMASTER_GITIGNORE);
}

/** kebab-case, a–z 0–9 and dashes, at most 64 characters. */
export function slugify(s: string): string {
  return String(s ?? "").normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64).replace(/-+$/, "");
}

/** The entry's title: its first `# ` heading, else the slug. */
export function entryTitle(content: string, slug: string): string {
  return /^#\s+(.+)$/m.exec(content)?.[1]?.trim() || slug;
}

/** Canonical file text (LF, fixed key order): the same entry always gives the same bytes, so hashes compare content. */
export function serializeEntry(e: KnowledgeEntry): string {
  const head = [
    ...(e.tags.length ? [`tags: ${e.tags.join(", ")}`] : []),
    ...(e.kind !== "fact" ? [`kind: ${e.kind}`] : []),
    `importance: ${e.importance}`,
    ...(e.pinned ? ["pinned: true"] : []),
  ];
  return `---\n${head.join("\n")}\n---\n\n${e.content.replace(/\r\n?/g, "\n").trim()}\n`;
}

/** Read a knowledge file leniently: CRLF (Windows checkouts), a BOM and a missing front matter are all fine. */
export function parseEntry(slug: string, raw: string): KnowledgeEntry {
  let text = raw.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const meta: Record<string, string> = {};
  const fm = /^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(text);
  if (fm) {
    for (const line of fm[1]!.split("\n")) {
      const m = /^\s*([A-Za-z]+)\s*:\s*(.*?)\s*$/.exec(line);
      if (m) meta[m[1]!.toLowerCase()] = m[2]!.replace(/^["']|["']$/g, "");
    }
    text = text.slice(fm[0].length);
  }
  const content = text.trim();
  if (!content) throw new Error("the entry is empty");
  if (content.length > MAX_KNOWLEDGE_CHARS) throw new Error(`the entry is longer than ${MAX_KNOWLEDGE_CHARS} characters: split it`);
  const tags = parseTags((meta.tags ?? "").replace(/^\[|\]$/g, ""));
  const kind = MEMORY_KINDS.includes(meta.kind as MemoryKind) ? meta.kind as MemoryKind : "fact";
  return { slug, content, kind, tags, importance: meta.importance ? clampImportance(meta.importance) : 3, pinned: /^(true|yes|1)$/i.test(meta.pinned ?? "") };
}

export function fromMemory(m: Memory): KnowledgeEntry {
  return { slug: m.kbSlug!, content: m.content, kind: m.kind, tags: m.tags, importance: m.importance, pinned: m.pinned };
}

export function hashEntry(e: KnowledgeEntry): string {
  return createHash("sha256").update(serializeEntry(e)).digest("hex").slice(0, 16);
}

const MERGE_MARKERS = /^(<{7}|>{7})( |$)/m;

/** The checkpoint from manifest.json; tolerates a manifest left with git conflict markers (takes the first commit). */
export function parseManifest(raw: string | null): { commit: string; at: string | null } | null {
  if (!raw) return null;
  try {
    const j = JSON.parse(raw);
    if (typeof j?.indexedCommit === "string" && /^[0-9a-f]{7,64}$/i.test(j.indexedCommit)) return { commit: j.indexedCommit, at: typeof j.indexedAt === "string" ? j.indexedAt : null };
  } catch { /* fall through */ }
  const m = /"indexedCommit"\s*:\s*"([0-9a-f]{7,64})"/i.exec(raw);
  return m ? { commit: m[1]!, at: null } : null;
}

interface RepoFile { hash: string | null; entry: KnowledgeEntry | null; problem?: KnowledgeConflict }

export class KnowledgeBase {
  private last = new Map<string, KnowledgeSyncResult>();

  constructor(private db: Db, private memory: MemoryStore, private git: Git = defaultGit, private now: () => number = Date.now,
    private onChange?: (projectId: string) => void) {}

  private project(projectId: string) {
    const p = this.db.getProject(projectId);
    if (!p) throw new Error("the knowledge base needs a project folder: open a project chat");
    return p;
  }

  folder(projectId: string): string {
    return join(this.project(projectId).path, ".flashmaster", "knowledge");
  }

  lastSync(projectId: string): KnowledgeSyncResult | null { return this.last.get(projectId) ?? null; }

  /** Write (create or replace) an entry from an agent or the UI, then sync so the file follows right away. */
  write(projectId: string, input: { slug: string; content: string; kind?: MemoryKind; tags?: string[] | string; importance?: number; pinned?: boolean },
    ctx: { agentId?: string | null; role?: string | null } = {}): { memory: Memory; sync: KnowledgeSyncResult } {
    const slug = slugify(input.slug);
    if (!slug) throw new Error("slug is empty: use a short kebab-case name like build-and-release");
    const cur = this.memory.getKnowledge(projectId, slug);
    const memory = this.memory.putKnowledge(projectId, {
      slug, content: String(input.content ?? ""), kind: (input.kind ?? cur?.kind ?? "fact") as MemoryKind,
      tags: input.tags !== undefined ? parseTags(input.tags) : cur?.tags ?? [], importance: input.importance ?? cur?.importance ?? 3, pinned: input.pinned ?? cur?.pinned ?? false,
    }, ctx);
    return { memory, sync: this.sync(projectId) };
  }

  remove(projectId: string, slug: string): { deleted: boolean; sync: KnowledgeSyncResult } {
    const deleted = this.memory.deleteKnowledge(projectId, slugify(slug));
    return { deleted, sync: this.sync(projectId) };
  }

  /** The repo folder as entries; files that can't be entries come back as problems (never imported, never overwritten). */
  private readFolder(dir: string): Map<string, RepoFile> {
    const out = new Map<string, RepoFile>();
    let names: string[];
    try { names = readdirSync(dir); } catch { return out; }
    for (const name of names) {
      if (!name.toLowerCase().endsWith(".md") || name.toLowerCase() === INDEX.toLowerCase()) continue;
      const base = name.slice(0, -3);
      const slug = slugify(base);
      if (!slug) continue;
      if (slug !== base) {
        out.set(slug, { hash: null, entry: null, problem: { slug, reason: "invalid", detail: `rename ${name} to ${slug}.md (lower-case, dashes)` } });
        continue;
      }
      let raw: string;
      try { raw = readFileSync(join(dir, name), "utf8"); } catch (e) {
        out.set(slug, { hash: null, entry: null, problem: { slug, reason: "invalid", detail: String(e) } });
        continue;
      }
      if (MERGE_MARKERS.test(raw)) { out.set(slug, { hash: null, entry: null, problem: { slug, reason: "merge-markers", detail: `resolve the git merge in ${name}` } }); continue; }
      try {
        const entry = parseEntry(slug, raw);
        out.set(slug, { hash: hashEntry(entry), entry });
      } catch (e: any) {
        out.set(slug, { hash: null, entry: null, problem: { slug, reason: "invalid", detail: String(e?.message ?? e) } });
      }
    }
    return out;
  }

  /** Three-way sync of the database and the repo folder (see the file comment). Synchronous file I/O; no git needed. */
  sync(projectId: string): KnowledgeSyncResult {
    const project = this.project(projectId);
    const dir = this.folder(projectId);
    const files = this.readFolder(dir);
    const local = new Map(this.memory.knowledgeEntries(projectId).map((m) => [m.kbSlug!, m]));
    const base = this.memory.syncHashes(projectId);
    const r: KnowledgeSyncResult = { projectId, at: this.now(), imported: [], exported: [], deletedLocal: [], deletedRepo: [], conflicts: [], entries: 0 };
    const writeFile = (e: KnowledgeEntry) => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${e.slug}.md`), serializeEntry(e));
    };
    for (const slug of [...new Set([...files.keys(), ...local.keys(), ...base.keys()])].sort()) {
      const f = files.get(slug);
      if (f?.problem) { r.conflicts.push(f.problem); continue; }
      const m = local.get(slug);
      const fh = f?.hash ?? null;
      const mh = m ? hashEntry(fromMemory(m)) : null;
      const b = base.get(slug) ?? null;
      if (fh === mh) { this.memory.setSyncHash(projectId, slug, fh); continue; }
      const repoChanged = fh !== b;
      const localChanged = mh !== b;
      try {
        if (repoChanged && !localChanged) {
          if (f?.entry) { this.memory.putKnowledge(projectId, f.entry); r.imported.push(slug); }
          else { this.memory.deleteKnowledge(projectId, slug); r.deletedLocal.push(slug); }
          this.memory.setSyncHash(projectId, slug, fh);
        } else if (localChanged && !repoChanged) {
          if (m) { writeFile(fromMemory(m)); r.exported.push(slug); }
          else { try { unlinkSync(join(dir, `${slug}.md`)); } catch { /* already gone */ } r.deletedRepo.push(slug); }
          this.memory.setSyncHash(projectId, slug, mh);
        } else {
          r.conflicts.push({ slug, reason: "both-changed", detail: !f ? "deleted in the repo, changed here" : !m ? "deleted here, changed in the repo" : "changed here and in the repo" });
        }
      } catch (e: any) {
        r.conflicts.push({ slug, reason: "invalid", detail: String(e?.message ?? e) });
      }
    }
    const entries = this.memory.knowledgeEntries(projectId);
    r.entries = entries.length;
    if (entries.length || existsSync(dir)) {
      ensureFlashmasterIgnore(project.path);
      this.writeIndex(dir, entries);
    }
    this.last.set(projectId, r);
    if (r.imported.length || r.deletedLocal.length) this.onChange?.(projectId);
    return r;
  }

  /** Settle a conflict by keeping one side; the other side is overwritten with it. */
  resolve(projectId: string, slug: string, keep: "repo" | "local"): KnowledgeSyncResult {
    const dir = this.folder(projectId);
    const f = this.readFolder(dir).get(slug);
    const m = this.memory.getKnowledge(projectId, slug);
    if (keep === "repo") {
      if (f?.problem) throw new Error(`${f.problem.detail ?? "the repo file can't be read"}: fix the file, or keep your version`);
      if (f?.entry) this.memory.putKnowledge(projectId, f.entry); else this.memory.deleteKnowledge(projectId, slug);
      this.memory.setSyncHash(projectId, slug, f?.hash ?? null);
    } else {
      const file = join(dir, `${slug}.md`);
      if (m) { mkdirSync(dir, { recursive: true }); writeFileSync(file, serializeEntry(fromMemory(m))); }
      else { try { unlinkSync(file); } catch { /* gone */ } }
      this.memory.setSyncHash(projectId, slug, m ? hashEntry(fromMemory(m)) : null);
    }
    this.onChange?.(projectId);
    return this.sync(projectId);
  }

  /** README.md: a deterministic index (no timestamps, sorted), so two teammates' syncs write the same bytes. */
  private writeIndex(dir: string, entries: Memory[]): void {
    const body = ["# Project knowledge base", "",
      "Maintained by TheFlashMaster's agents and the team. Edit any entry; the app picks the change up on its next sync.",
      "`manifest.json` records the commit the knowledge base was last built from.", "",
      ...entries.map((m) => `- [${entryTitle(m.content, m.kbSlug!)}](${m.kbSlug}.md)`), ""].join("\n");
    const file = join(dir, INDEX);
    let cur: string | null = null;
    try { cur = readFileSync(file, "utf8").replace(/\r\n?/g, "\n"); } catch { /* missing */ }
    if (cur === body) return;
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, body);
  }

  readCheckpoint(projectId: string): { commit: string; at: string | null } | null {
    try { return parseManifest(readFileSync(join(this.folder(projectId), MANIFEST), "utf8")); } catch { return null; }
  }

  /** Record HEAD as the checkpoint (the knowledge base now describes it) and sync the files. */
  async checkpoint(projectId: string): Promise<{ commit: string | null; sync: KnowledgeSyncResult }> {
    const p = this.project(projectId);
    const head = await this.gitOut(p.path, ["rev-parse", "HEAD"]);
    const commit = head && /^[0-9a-f]{7,64}$/i.test(head) ? head : null;
    const dir = this.folder(projectId);
    mkdirSync(dir, { recursive: true });
    if (commit) writeFileSync(join(dir, MANIFEST), `${JSON.stringify({ version: 1, indexedCommit: commit, indexedAt: new Date(this.now()).toISOString() }, null, 2)}\n`);
    return { commit, sync: this.sync(projectId) };
  }

  private async gitOut(cwd: string, args: string[]): Promise<string | null> {
    try {
      const r = await this.git(cwd, args);
      return r.code === 0 ? r.out.trim() : null;
    } catch { return null; }
  }

  async status(projectId: string): Promise<KnowledgeStatus> {
    const p = this.project(projectId);
    const checkpoint = this.readCheckpoint(projectId);
    const head = await this.gitOut(p.path, ["rev-parse", "HEAD"]);
    let behind: number | null = null;
    let changedFiles: string[] = [];
    if (head && checkpoint) {
      const n = await this.gitOut(p.path, ["rev-list", "--count", `${checkpoint.commit}..HEAD`]);
      if (n !== null && /^\d+$/.test(n)) {
        behind = Number(n);
        const diff = await this.gitOut(p.path, ["diff", "--name-only", checkpoint.commit, "HEAD", "--", ".", ":(exclude).flashmaster"]);
        changedFiles = (diff ?? "").split(/\r?\n/).filter(Boolean);
      }
    }
    const st = head ? await this.gitOut(p.path, ["status", "--porcelain", "--untracked-files=all", "--", KNOWLEDGE_DIR]) : null;
    const last = this.lastSync(projectId);
    return {
      projectId, folder: this.folder(projectId), entries: this.memory.knowledgeEntries(projectId).length, checkpoint, head, behind, changedFiles,
      repo: !!head, uncommitted: (st ?? "").split(/\r?\n/).filter(Boolean).length, conflicts: last?.conflicts ?? [], lastSync: last,
    };
  }

  /** The brief for the coordinator when the user asks to build or update the knowledge base (button, palette, /kb). */
  async prompt(projectId: string, focus = ""): Promise<string> {
    const p = this.project(projectId);
    const sync = this.sync(projectId);
    const st = await this.status(projectId);
    const entries = this.memory.knowledgeEntries(projectId);
    const list = entries.length
      ? entries.map((m) => `- ${m.kbSlug}: ${entryTitle(m.content, m.kbSlug!)} (updated ${new Date(m.updatedAt).toISOString().slice(0, 10)})`).join("\n")
      : "(none yet)";
    const incremental = !!(st.checkpoint && st.behind !== null && entries.length);
    const MAXF = 150;
    const scope = !st.repo
      ? "Mode: full build. The folder is not a git repository, so there is no checkpoint; read the project as it is."
      : incremental && st.behind === 0
        ? `Mode: check. Nothing was committed since the checkpoint ${st.checkpoint!.commit.slice(0, 10)}. Check the entries are still right and fill gaps (uncommitted work may matter), then record the checkpoint.`
        : incremental
          ? `Mode: incremental update since checkpoint ${st.checkpoint!.commit.slice(0, 10)} (${st.behind} commit${st.behind === 1 ? "" : "s"}). Files changed since then:\n${st.changedFiles.slice(0, MAXF).map((f) => `- ${f}`).join("\n")}${st.changedFiles.length > MAXF ? `\n- … and ${st.changedFiles.length - MAXF} more (git diff --name-only ${st.checkpoint!.commit.slice(0, 10)} HEAD)` : ""}\nOnly read what changed (git log / git diff from the checkpoint help). Update the entries those changes affect, add entries for new topics, delete entries that are no longer true. Leave the other entries as they are.`
          : st.checkpoint
            ? `Mode: full build. The checkpoint ${st.checkpoint.commit.slice(0, 10)} is not in this clone (rebased or shallow), so review everything and refresh the existing entries.`
            : "Mode: full build (no checkpoint yet).";
    const conflicts = sync.conflicts.length
      ? `\n\nConflicts the user has to settle on the Memory page (don't write these slugs): ${sync.conflicts.map((c) => `${c.slug} (${c.detail ?? c.reason})`).join("; ")}.` : "";
    return `Build or update the knowledge base of the project "${p.name}" (${p.path}).

${scope}

Current entries (slug: title):
${list}${conflicts}

What the knowledge base is for: other agents get the relevant entries before they work, and the team reviews, edits and shares the entries in git (${KNOWLEDGE_DIR}/<slug>.md). Write what a capable newcomer needs and can't see at a glance: an overview (what the project is, how the parts fit), a map of the main modules and where things live, how to build, test, run and release, conventions and rules, gotchas and decisions with their reasons, and a glossary of domain terms. One topic per entry, Markdown, starting with "# Title", usually 100 to 600 words, file paths instead of pasted code, only facts you checked in the code or docs.

How:
- knowledge_list / knowledge_read to see what is there; knowledge_write(slug, content, tags?, importance?) to add or replace one entry; knowledge_delete(slug) for one that is wrong or obsolete.
- Use the tools, not file edits: they keep the app's database and the repo folder in sync. Don't commit; the user reviews and commits the folder.
- Teammates may have edited entries by hand: keep their wording where it is still right.
- If the entry code-map is there, it is graphify's map of the code (the user's Scan code button): start from it, and ask code_graph (query, explain, path, affected) to see how parts connect instead of reading file after file. Don't edit or delete code-map: the next scan replaces it.
- Delegate reading large areas to specialists if it helps, but write the entries yourself.
- When done, call knowledge_checkpoint once: it records the current commit, so the next update only looks at what changed after it.
- Reply with a short summary: entries added, updated and deleted.${focus.trim() ? `\n\nThe user asks you to focus on: ${focus.trim()}` : ""}`;
  }
}

/** One line for a chat or a toast. */
export function describeSync(r: KnowledgeSyncResult): string {
  const parts: string[] = [];
  const names = (xs: string[]) => xs.slice(0, 5).join(", ") + (xs.length > 5 ? ` and ${xs.length - 5} more` : "");
  if (r.imported.length) parts.push(`took ${r.imported.length} from the repo (${names(r.imported)})`);
  if (r.exported.length) parts.push(`wrote ${r.exported.length} to the repo folder (${names(r.exported)})`);
  if (r.deletedLocal.length) parts.push(`removed ${r.deletedLocal.length} deleted in the repo (${names(r.deletedLocal)})`);
  if (r.deletedRepo.length) parts.push(`removed ${r.deletedRepo.length} file${r.deletedRepo.length === 1 ? "" : "s"} you deleted (${names(r.deletedRepo)})`);
  const head = parts.length ? `Knowledge base synced: ${parts.join("; ")}.` : `Knowledge base in sync (${r.entries} entr${r.entries === 1 ? "y" : "ies"}).`;
  const c = r.conflicts.length ? ` ${r.conflicts.length} need${r.conflicts.length === 1 ? "s" : ""} you: ${r.conflicts.map((x) => `${x.slug} (${x.detail ?? x.reason})`).join("; ")}. Choose a side on the Memory page.` : "";
  return head + c;
}
