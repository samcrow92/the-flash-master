import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../src/main/db";
import { MemoryStore } from "../src/main/memory";
import {
  FLASHMASTER_GITIGNORE, KnowledgeBase, describeSync, ensureFlashmasterIgnore, hashEntry, parseEntry, parseManifest, serializeEntry, slugify,
} from "../src/main/knowledge";
import { defaultGit } from "../src/main/worktree";
import { buildTools } from "../src/main/tools";
import { Bridge } from "../src/main/bridge";
import { Orchestrator } from "../src/main/orchestrator";
import { HarnessRegistry } from "../src/main/harness/registry";
import { MockAdapter, MockSession } from "../src/main/harness/mock";
import { loadRoles } from "../src/main/roles";
import { DEFAULT_SETTINGS, mergeSettings, type Settings } from "../src/shared/settings";
import type { Message } from "../src/shared/types";

const ID = ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", "-c", "core.autocrlf=false"];
const git = (cwd: string, ...args: string[]) => execFileSync("git", [...ID, ...args], { cwd, encoding: "utf8" }).trim();
const commitAll = (dir: string, msg: string) => { git(dir, "add", "-A"); git(dir, "commit", "-qm", msg); };

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "kb-repo-"));
  git(dir, "init", "-q");
  writeFileSync(join(dir, "main.c"), "int main(void) { return 0; }\n");
  commitAll(dir, "init");
  return dir;
}

/** One teammate: their own clone of the project and their own app database. */
function teammate(path: string) {
  const db = new Db(":memory:");
  const store = new MemoryStore(db);
  const kb = new KnowledgeBase(db, store, defaultGit);
  const p = db.createProject("proj", path);
  return { db, store, kb, p, dir: join(path, ".flashmaster", "knowledge") };
}

describe("knowledge files", () => {
  it("round-trips an entry and ignores CRLF, a BOM and front-matter spacing", () => {
    const e = { slug: "build", content: "# Build\n\nRun `npm run ci`.", kind: "procedure" as const, tags: ["ci", "windows"], importance: 4, pinned: true };
    const text = serializeEntry(e);
    expect(text).toBe("---\ntags: ci, windows\nkind: procedure\nimportance: 4\npinned: true\n---\n\n# Build\n\nRun `npm run ci`.\n");
    expect(parseEntry("build", text)).toEqual(e);
    // A Windows checkout (core.autocrlf) is the same entry, not a change.
    const crlf = `\uFEFF${text.replace(/\n/g, "\r\n")}`;
    expect(hashEntry(parseEntry("build", crlf))).toBe(hashEntry(e));
    // Hand-written files without front matter are fine.
    expect(parseEntry("notes", "# Notes\nsome text\n")).toMatchObject({ content: "# Notes\nsome text", importance: 3, tags: [], kind: "fact", pinned: false });
    expect(() => parseEntry("empty", "---\ntags: a\n---\n\n")).toThrow(/empty/);
  });

  it("slugs are kebab-case", () => {
    expect(slugify("Build & Release (Windows)")).toBe("build-release-windows");
    expect(slugify("--")).toBe("");
  });

  it("reads the checkpoint even from a manifest left with merge markers", () => {
    expect(parseManifest('{"version":1,"indexedCommit":"abcdef1234567","indexedAt":"2026-11-16T10:00:00Z"}')).toEqual({ commit: "abcdef1234567", at: "2026-11-16T10:00:00Z" });
    expect(parseManifest('<<<<<<< HEAD\n  "indexedCommit": "aaaaaaa1",\n=======\n  "indexedCommit": "bbbbbbb2",\n>>>>>>> x\n')).toEqual({ commit: "aaaaaaa1", at: null });
    expect(parseManifest("nonsense")).toBeNull();
    expect(parseManifest(null)).toBeNull();
  });
});

describe(".flashmaster/.gitignore", () => {
  it("keeps attachments out of git but shares the knowledge folder, and upgrades the old bare '*'", () => {
    const dir = repo();
    mkdirSync(join(dir, ".flashmaster", "attachments"), { recursive: true });
    writeFileSync(join(dir, ".flashmaster", ".gitignore"), "*\n"); // what earlier versions wrote
    ensureFlashmasterIgnore(dir);
    expect(readFileSync(join(dir, ".flashmaster", ".gitignore"), "utf8")).toBe(FLASHMASTER_GITIGNORE);
    mkdirSync(join(dir, ".flashmaster", "knowledge"), { recursive: true });
    writeFileSync(join(dir, ".flashmaster", "knowledge", "build.md"), "# Build\n");
    writeFileSync(join(dir, ".flashmaster", "attachments", "a1-shot.png"), "png");
    const status = git(dir, "status", "--porcelain", "--untracked-files=all");
    expect(status).toContain(".flashmaster/knowledge/build.md");
    expect(status).toContain(".flashmaster/.gitignore");
    expect(status).not.toContain("attachments");
    // A file the team edited is left alone.
    writeFileSync(join(dir, ".flashmaster", ".gitignore"), "attachments/\n");
    ensureFlashmasterIgnore(dir);
    expect(readFileSync(join(dir, ".flashmaster", ".gitignore"), "utf8")).toBe("attachments/\n");
  });
});

describe("knowledge sync", () => {
  it("exports the app's entries to the repo folder and imports a teammate's from a fresh clone", () => {
    const origin = repo();
    const a = teammate(origin);
    a.kb.write(a.p.id, { slug: "Build and Release", content: "# Build and release\n\nnpm run ci, then npm run dist:win.", tags: ["ci"], importance: 4 });
    expect(readFileSync(join(a.dir, "build-and-release.md"), "utf8")).toContain("importance: 4");
    expect(readFileSync(join(a.dir, "README.md"), "utf8")).toContain("- [Build and release](build-and-release.md)");
    commitAll(origin, "kb");

    const clone = mkdtempSync(join(tmpdir(), "kb-clone-"));
    git(clone, "clone", "-q", origin, ".");
    const b = teammate(clone);
    const r = b.kb.sync(b.p.id);
    expect(r).toMatchObject({ imported: ["build-and-release"], exported: [], conflicts: [], entries: 1 });
    const m = b.store.getKnowledge(b.p.id, "build-and-release")!;
    expect(m).toMatchObject({ scope: "project", projectId: b.p.id, importance: 4, tags: ["ci"], kbSlug: "build-and-release" });
    // Entries are memories: recall puts them in front of agents, with a pointer to the full text.
    expect(b.store.recall("how do I release a build", { projectId: b.p.id, chatId: null }).text).toMatch(/knowledge base: build-and-release; full text with knowledge_read/);
    // A second sync has nothing to do and leaves the files (and so git) untouched.
    expect(b.kb.sync(b.p.id)).toMatchObject({ imported: [], exported: [], conflicts: [] });
    expect(git(clone, "status", "--porcelain")).toBe("");
  });

  it("takes a teammate's edit and deletion after a pull, and sends local edits and deletions out", () => {
    const dir = repo();
    const t = teammate(dir);
    t.kb.write(t.p.id, { slug: "overview", content: "# Overview\n\nA flasher." });
    t.kb.write(t.p.id, { slug: "glossary", content: "# Glossary\n\nECU: control unit." });
    // Repo side (a pull): overview edited, glossary deleted.
    writeFileSync(join(t.dir, "overview.md"), "---\nimportance: 5\n---\n\n# Overview\n\nA flasher for ECUs over CAN.\n");
    unlinkSync(join(t.dir, "glossary.md"));
    const r1 = t.kb.sync(t.p.id);
    expect(r1).toMatchObject({ imported: ["overview"], deletedLocal: ["glossary"], conflicts: [] });
    expect(t.store.getKnowledge(t.p.id, "overview")).toMatchObject({ content: "# Overview\n\nA flasher for ECUs over CAN.", importance: 5 });
    expect(t.store.getKnowledge(t.p.id, "glossary")).toBeNull();
    // App side: edited on the Memory page, then deleted.
    const m = t.store.getKnowledge(t.p.id, "overview")!;
    t.store.update(m.id, { content: "# Overview\n\nA flasher for ECUs over CAN and LIN." });
    expect(t.kb.sync(t.p.id)).toMatchObject({ exported: ["overview"], imported: [] });
    expect(readFileSync(join(t.dir, "overview.md"), "utf8")).toContain("CAN and LIN");
    t.store.delete(m.id);
    expect(t.kb.sync(t.p.id)).toMatchObject({ deletedRepo: ["overview"] });
    expect(existsSync(join(t.dir, "overview.md"))).toBe(false);
  });

  it("never overwrites when both sides changed: reports a conflict, then keeps the side you pick", () => {
    const dir = repo();
    const t = teammate(dir);
    t.kb.write(t.p.id, { slug: "flashing", content: "# Flashing\n\nUse UDS 0x34." });
    writeFileSync(join(t.dir, "flashing.md"), "# Flashing\n\nUse UDS 0x34 then 0x36 (teammate).\n");
    t.store.update(t.store.getKnowledge(t.p.id, "flashing")!.id, { content: "# Flashing\n\nUse UDS 0x34, block size 4095 (mine)." });
    const r = t.kb.sync(t.p.id);
    expect(r.conflicts).toEqual([{ slug: "flashing", reason: "both-changed", detail: "changed here and in the repo" }]);
    expect(readFileSync(join(t.dir, "flashing.md"), "utf8")).toContain("(teammate)");
    expect(t.store.getKnowledge(t.p.id, "flashing")!.content).toContain("(mine)");
    expect(describeSync(r)).toMatch(/1 needs you: flashing/);

    const kept = t.kb.resolve(t.p.id, "flashing", "repo");
    expect(kept.conflicts).toEqual([]);
    expect(t.store.getKnowledge(t.p.id, "flashing")!.content).toContain("(teammate)");

    // Again, keeping mine this time.
    writeFileSync(join(t.dir, "flashing.md"), "# Flashing\n\nrepo v3\n");
    t.store.update(t.store.getKnowledge(t.p.id, "flashing")!.id, { content: "# Flashing\n\nmine v3" });
    expect(t.kb.sync(t.p.id).conflicts).toHaveLength(1);
    expect(t.kb.resolve(t.p.id, "flashing", "local").conflicts).toEqual([]);
    expect(readFileSync(join(t.dir, "flashing.md"), "utf8")).toContain("mine v3");
  });

  it("reports files with merge markers or bad names instead of importing them", () => {
    const dir = repo();
    const t = teammate(dir);
    mkdirSync(t.dir, { recursive: true });
    writeFileSync(join(t.dir, "can.md"), "# CAN\n<<<<<<< HEAD\n500k\n=======\n250k\n>>>>>>> main\n");
    writeFileSync(join(t.dir, "Build Notes.md"), "# Build\n");
    const r = t.kb.sync(t.p.id);
    expect(r.imported).toEqual([]);
    expect(r.conflicts.map((c) => [c.slug, c.reason])).toEqual([["build-notes", "invalid"], ["can", "merge-markers"]]);
    expect(() => t.kb.resolve(t.p.id, "can", "repo")).toThrow(/resolve the git merge/);
    expect(t.store.knowledgeEntries(t.p.id)).toEqual([]);
  });

  it("knowledge entries are not merged into, or promoted like, other memories, and keep long text", () => {
    const dir = repo();
    const t = teammate(dir);
    const long = `# Architecture\n\n${"The bootloader validates the image. ".repeat(150)}`;
    t.kb.write(t.p.id, { slug: "architecture", content: long });
    const m = t.store.getKnowledge(t.p.id, "architecture")!;
    expect(m.content.length).toBeGreaterThan(2000);
    // A near-identical plain memory stays a separate memory.
    const saved = t.store.save({ content: long.slice(0, 1500), scope: "project" }, { projectId: t.p.id, chatId: null });
    expect(saved.status).toBe("saved");
    expect(saved.memory.id).not.toBe(m.id);
    expect(() => t.store.promote(m.id, "user", { projectId: t.p.id, chatId: null })).toThrow(/knowledge base entries/);
    // Editing on the Memory page keeps the long text (the 2000-character limit is for plain memories).
    expect(t.store.update(m.id, { content: `${long} More.` }).content.endsWith("More.")).toBe(true);
    expect(() => t.kb.write(t.p.id, { slug: "huge", content: "x".repeat(13000) })).toThrow(/split it/);
  });
});

describe("knowledge checkpoint", () => {
  it("records HEAD and reports commits and files changed since, for incremental updates", async () => {
    const dir = repo();
    const t = teammate(dir);
    t.kb.write(t.p.id, { slug: "overview", content: "# Overview\n\nmain.c only." });
    const head = git(dir, "rev-parse", "HEAD");
    const cp = await t.kb.checkpoint(t.p.id);
    expect(cp.commit).toBe(head);
    expect(JSON.parse(readFileSync(join(t.dir, "manifest.json"), "utf8"))).toMatchObject({ version: 1, indexedCommit: head });
    commitAll(dir, "knowledge base");
    writeFileSync(join(dir, "can.c"), "void can(void) {}\n");
    commitAll(dir, "add can");
    const st = await t.kb.status(t.p.id);
    expect(st).toMatchObject({ repo: true, entries: 1, behind: 2, uncommitted: 0, checkpoint: { commit: head } });
    expect(st.changedFiles).toEqual(["can.c"]); // .flashmaster itself is not "code that changed"

    const brief = await t.kb.prompt(t.p.id, "the CAN stack");
    expect(brief).toMatch(/incremental update since checkpoint/);
    expect(brief).toContain("- can.c");
    expect(brief).toContain("- overview: Overview");
    expect(brief).toContain("knowledge_checkpoint");
    expect(brief).toContain("focus on: the CAN stack");

    // Uncommitted knowledge edits are counted for the "to commit" hint.
    t.kb.write(t.p.id, { slug: "can", content: "# CAN\n\ncan.c" });
    expect((await t.kb.status(t.p.id)).uncommitted).toBe(2); // can.md and the README index
  });

  it("asks for a full build without a checkpoint, or when the folder is not a git repo", async () => {
    const t = teammate(repo());
    expect(await t.kb.prompt(t.p.id)).toMatch(/full build \(no checkpoint yet\)/);
    const plain = teammate(mkdtempSync(join(tmpdir(), "kb-plain-")));
    expect(await plain.kb.prompt(plain.p.id)).toMatch(/not a git repository/);
    expect((await plain.kb.checkpoint(plain.p.id)).commit).toBeNull();
  });
});

describe("knowledge tools", () => {
  it("lets an agent list, write, read, delete and checkpoint its project's knowledge base", async () => {
    const dir = repo();
    const t = teammate(dir);
    const chat = t.db.createChat({ projectId: t.p.id, title: "c", kind: "project", agentRole: "flashmaster" });
    const agent = t.db.createAgent({ projectId: t.p.id, chatId: chat.id, role: "flashmaster", harness: "mock", model: null, brief: "b" });
    const loose = t.db.createAgent({ projectId: null, chatId: null, role: "coder", harness: "mock", model: null, brief: "b" });
    const bridge = new Bridge();
    let changes = 0;
    bridge.register(buildTools({ db: t.db, orch: {} as Orchestrator, roles: () => [], jazz: () => null, emitTask: () => {}, memory: t.store, knowledge: t.kb, onMemory: () => { changes++; } }));
    expect(bridge.list("core").map((x) => x.name)).toEqual(expect.arrayContaining(["knowledge_list", "knowledge_read", "knowledge_write", "knowledge_delete", "knowledge_checkpoint"]));
    expect(await bridge.call("knowledge_write", { slug: "overview", content: "# Overview\n\nFlasher.", tags: ["intro"] }, agent.id)).toMatchObject({ slug: "overview", file: ".flashmaster/knowledge/overview.md" });
    expect(existsSync(join(t.dir, "overview.md"))).toBe(true);
    expect(t.store.getKnowledge(t.p.id, "overview")).toMatchObject({ sourceRole: "flashmaster", sourceAgentId: agent.id });
    expect(await bridge.call("knowledge_list", {}, agent.id)).toMatchObject({ checkpoint: null, entries: [{ slug: "overview", title: "Overview", tags: ["intro"] }] });
    expect(await bridge.call("knowledge_read", { slug: "overview" }, agent.id)).toMatchObject({ content: "# Overview\n\nFlasher." });
    expect(await bridge.call("knowledge_checkpoint", {}, agent.id)).toMatchObject({ checkpoint: git(dir, "rev-parse", "HEAD"), entries: 1 });
    expect(await bridge.call("knowledge_delete", { slug: "overview" }, agent.id)).toMatchObject({ deleted: true });
    expect(existsSync(join(t.dir, "overview.md"))).toBe(false);
    await expect(bridge.call("knowledge_read", { slug: "overview" }, agent.id)).rejects.toThrow(/no knowledge entry/);
    await expect(bridge.call("knowledge_list", {}, loose.id)).rejects.toThrow(/no project folder/);
    expect(changes).toBe(3);
  });
});

describe("/kb and /kb-sync", () => {
  afterEach(() => vi.restoreAllMocks());
  const until = async (fn: () => boolean, ms = 8000) => {
    const t = Date.now();
    while (!fn()) { if (Date.now() - t > ms) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 10)); }
  };

  function setup() {
    const dir = repo();
    const db = new Db(":memory:");
    const store = new MemoryStore(db);
    const kb = new KnowledgeBase(db, store, defaultGit);
    const settings = mergeSettings(DEFAULT_SETTINGS, { general: { defaultHarness: "mock" }, agents: { toolMode: "mcp" } }) as Settings;
    const roles = loadRoles(join(__dirname, "..", "agents"), "/none");
    const prompts: string[] = [];
    const orig = MockSession.prototype.prompt;
    vi.spyOn(MockSession.prototype, "prompt").mockImplementation(function (this: MockSession, text, atts) { prompts.push(text); return orig.call(this, text, atts); });
    const messages: Message[] = [];
    const orch = new Orchestrator({ db, memory: store, knowledge: kb, harnesses: new HarnessRegistry([new MockAdapter(1)]), settings: () => settings, roles: () => roles,
      skills: () => [], emit: (e) => { if (e.type === "message.created") messages.push(e.message); }, mcpServersFor: () => [], homeDir: tmpdir(), dataDir: mkdtempSync(join(tmpdir(), "kb-data-")) });
    const p = db.createProject("p", dir);
    const chat = db.createChat({ projectId: p.id, title: "c", kind: "project", agentRole: "flashmaster" });
    return { dir, db, store, kb, orch, p, chat, prompts, messages };
  }

  it("/kb sends the coordinator the build brief, /kb-sync reports what moved", async () => {
    const { db, orch, chat, prompts, messages, dir, kb, p } = setup();
    await orch.sendUserMessage(chat.id, "/kb focus on flashing", null);
    await until(() => db.listAgents({}).some((x) => x.status === "idle"));
    expect(prompts[0]).toContain('Build or update the knowledge base of the project "p"');
    expect(prompts[0]).toContain("focus on: focus on flashing");

    kb.write(p.id, { slug: "overview", content: "# Overview\n\nx" });
    writeFileSync(join(dir, ".flashmaster", "knowledge", "overview.md"), "# Overview\n\ny\n");
    await orch.sendUserMessage(chat.id, "/kb-sync", null);
    await until(() => messages.some((m) => m.author === "system" && /Knowledge base synced/.test(m.content)));
    expect(messages.find((m) => /Knowledge base synced/.test(m.content))!.content).toMatch(/took 1 from the repo \(overview\)/);
  });

  it("explains that the knowledge base needs a project", async () => {
    const { db, orch, messages } = setup();
    const loose = db.createChat({ projectId: null, title: "n", kind: "project", agentRole: "flashmaster" });
    await orch.sendUserMessage(loose.id, "/kb", null);
    await until(() => messages.some((m) => /belongs to a project/.test(m.content)));
  });
});

