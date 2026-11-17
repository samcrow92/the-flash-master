import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canIsolate, createWorktree, defaultGit, defaultNoProjectFolder, mergeWorktree, noProjectFolder, removeWorktree, worktreeChanges, worktreeFileDiff, worktreeState } from "../src/main/worktree";
import { buildFixRequest } from "../src/shared/review";
import { Db } from "../src/main/db";
import { Orchestrator } from "../src/main/orchestrator";
import { HarnessRegistry } from "../src/main/harness/registry";
import { MockAdapter } from "../src/main/harness/mock";
import { loadRoles } from "../src/main/roles";
import { DEFAULT_SETTINGS, mergeSettings, type Settings } from "../src/shared/settings";
import type { AppEvent } from "../src/shared/types";

// The app's own git calls (merge commits) use the user's identity; CI machines have none, so give the tests one.
Object.assign(process.env, { GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.com" });
const ID = ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main"];
const git = (cwd: string, ...args: string[]) => execFileSync("git", [...ID, ...args], { cwd, encoding: "utf8" });
function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "wt-repo-"));
  git(dir, "init", "-q");
  writeFileSync(join(dir, "a.c"), "int a;\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "init");
  return dir;
}
const commitIn = (dir: string, file: string, text: string) => { writeFileSync(join(dir, file), text); git(dir, "add", "-A"); git(dir, "commit", "-qm", `edit ${file}`); };
const until = async (fn: () => boolean, ms = 8000) => {
  const t = Date.now();
  while (!fn()) { if (Date.now() - t > ms) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 10)); }
};

describe("agent worktrees", () => {
  it("only isolates git repositories with a commit", async () => {
    expect(await canIsolate(repo())).toBe(true);
    expect(await canIsolate(mkdtempSync(join(tmpdir(), "plain-")))).toBe(false);
    const empty = mkdtempSync(join(tmpdir(), "empty-"));
    git(empty, "init", "-q");
    expect(await canIsolate(empty)).toBe(false);
  });

  it("never removes unmerged or uncommitted work unless forced, and merges cleanly", async () => {
    const r = repo();
    const wt = join(mkdtempSync(join(tmpdir(), "wt-")), "copy");
    expect((await createWorktree(r, wt, "flash/tester-1")).ok).toBe(true);
    commitIn(wt, "b.c", "int b;\n");
    writeFileSync(join(wt, "scratch.txt"), "wip");
    expect(await worktreeState(r, wt, "flash/tester-1")).toMatchObject({ exists: true, unmerged: 1, dirty: ["?? scratch.txt"] });

    const kept = await removeWorktree(r, wt, "flash/tester-1", false);
    expect(kept).toMatchObject({ ok: false });
    expect(kept.message).toMatch(/1 unmerged commit\(s\) and 1 uncommitted change\(s\)/);
    expect(existsSync(wt)).toBe(true);
    expect((await mergeWorktree(r, wt, "flash/tester-1")).message).toMatch(/uncommitted/); // agent's copy must be committed first

    git(wt, "clean", "-fdq");
    expect(await mergeWorktree(r, wt, "flash/tester-1")).toMatchObject({ ok: true, message: "Merged 1 commit(s) from flash/tester-1." });
    expect(existsSync(join(r, "b.c"))).toBe(true);
    expect(await removeWorktree(r, wt, "flash/tester-1", false)).toMatchObject({ ok: true });
    expect(existsSync(wt)).toBe(false);
    expect(git(r, "branch", "--list", "flash/*").trim()).toBe("");
  });

  it("aborts a conflicting merge and leaves the project as it was", async () => {
    const r = repo();
    const wt = join(mkdtempSync(join(tmpdir(), "wt-")), "copy");
    await createWorktree(r, wt, "flash/x");
    commitIn(wt, "a.c", "int agent;\n");
    commitIn(r, "a.c", "int mine;\n");
    const m = await mergeWorktree(r, wt, "flash/x");
    expect(m.ok).toBe(false);
    expect(m.message).toMatch(/conflicts/);
    expect(git(r, "status", "--porcelain").trim()).toBe("");
    expect(await removeWorktree(r, wt, "flash/x", true)).toMatchObject({ ok: true }); // the user chose to discard
  });

  it("gives a delegated code-writing specialist its own branch, and the coordinator none", async () => {
    const db = new Db(":memory:");
    const settings = mergeSettings(DEFAULT_SETTINGS, { general: { defaultHarness: "mock" } }) as Settings;
    const roles = loadRoles(join(__dirname, "..", "agents"), "/none");
    const events: AppEvent[] = [];
    const orch = new Orchestrator({ db, harnesses: new HarnessRegistry([new MockAdapter(1)]), settings: () => settings, roles: () => roles,
      skills: () => [], emit: (e) => events.push(e), mcpServersFor: () => [], homeDir: tmpdir(), dataDir: mkdtempSync(join(tmpdir(), "data-")) });
    const p = db.createProject("p", repo());
    const chat = db.createChat({ projectId: p.id, title: "c", kind: "project", agentRole: "flashmaster" });
    const tester = roles.find((x) => x.name === "tester")!;
    await (orch as any).turn({ chat, threadRoot: null, role: tester, input: "Add a test", skills: [], depth: 1, brief: "Goal: add a test" });
    const a = db.listAgents({}).find((x) => x.role === "tester")!;
    expect(a.branch).toBe(`flash/tester-${a.id.slice(0, 8)}`);
    expect(existsSync(a.worktree!)).toBe(true);
    // The worktree lives in the project's own .wt folder, which ignores itself: the project's git status stays clean.
    expect(a.worktree).toBe(join(p.path, ".wt", a.id.slice(0, 8)));
    expect(readFileSync(join(p.path, ".wt", ".gitignore"), "utf8")).toMatch(/^\*$/m);
    expect(git(p.path, "status", "--porcelain").trim()).toBe("");
    expect(a.resultSummary).toMatch(/branch: flash\/tester-/);
    expect(db.listMessages(chat.id, null).some((m) => m.author === "system" && /own copy of the project/.test(m.content))).toBe(true);
    expect((await orch.discardWork(a.id)).ok).toBe(true); // nothing committed: nothing to lose
    expect(db.getAgent(a.id)!.worktree).toBeNull();

    await orch.sendUserMessage(chat.id, "hello", null);
    await until(() => db.listAgents({}).some((x) => x.role === "flashmaster" && !!x.resultSummary));
    expect(db.listAgents({}).find((x) => x.role === "flashmaster")!.worktree).toBeNull();
  });

  it("works in the no-project folder when a chat has no project", async () => {
    expect(defaultNoProjectFolder("win32", "C:\\Users\\mari")).toBe("C:\\Data\\.wt");
    expect(defaultNoProjectFolder("linux", "/home/mari")).toBe(join("/home/mari", "Data", ".wt"));
    expect(noProjectFolder("", "darwin", "/Users/mari")).toBe(join("/Users/mari", "Data", ".wt"));
    expect(noProjectFolder("~/work", "linux", "/home/mari")).toBe(join("/home/mari", "work"));
    expect(noProjectFolder(" D:\\Scratch ", "win32", "C:\\Users\\mari")).toBe("D:\\Scratch");

    const db = new Db(":memory:");
    const settings = mergeSettings(DEFAULT_SETTINGS, { general: { defaultHarness: "mock" } }) as Settings;
    const roles = loadRoles(join(__dirname, "..", "agents"), "/none");
    const root = join(mkdtempSync(join(tmpdir(), "np-")), "Data", ".wt");
    const orch = new Orchestrator({ db, harnesses: new HarnessRegistry([new MockAdapter(1)]), settings: () => settings, roles: () => roles,
      skills: () => [], emit: () => undefined, mcpServersFor: () => [], homeDir: tmpdir(), noProjectDir: () => root });
    const chat = db.createChat({ projectId: null, title: "c", kind: "project", agentRole: "flashmaster" });
    await orch.sendUserMessage(chat.id, "hello", null);
    await until(() => db.listAgents({}).some((x) => x.role === "flashmaster" && !!x.resultSummary));
    const a = db.listAgents({}).find((x) => x.role === "flashmaster")!;
    expect(existsSync(root)).toBe(true); // created on first use
    expect(realpathSync(orch.agentWorkDir(a.id)!)).toBe(realpathSync(root));
    expect(a.worktree).toBeNull();
  });

  it("lists every change on the agent's branch for review: committed, uncommitted and new files", async () => {
    const r = repo();
    writeFileSync(join(r, "gone.c"), "int g;\n");
    git(r, "add", "-A"); git(r, "commit", "-qm", "more");
    const wt = join(mkdtempSync(join(tmpdir(), "wt-")), "copy");
    await createWorktree(r, wt, "flash/review");
    commitIn(wt, "a.c", "int a;\nint b;\n");
    git(wt, "rm", "-q", "gone.c"); git(wt, "commit", "-qm", "rm");
    writeFileSync(join(wt, "a.c"), "int a;\nint b;\nint c;\n"); // uncommitted on top of the commit
    writeFileSync(join(wt, "new file.h"), "#pragma once\nint n;\n");
    commitIn(r, "other.c", "int o;\n"); // the project moved on: not the agent's change

    const ch = await worktreeChanges(r, wt, "flash/review");
    expect(ch.files).toEqual([
      { path: "a.c", status: "modified", added: 2, removed: 0, binary: false, committed: true },
      { path: "gone.c", status: "deleted", added: 0, removed: 1, binary: false, committed: true },
      { path: "new file.h", status: "added", added: 2, removed: 0, binary: false, committed: false },
    ]);
    // Windows (core.autocrlf): git prints CRLF warnings into the same output; they are not files.
    const noisy: typeof defaultGit = async (cwd, args) => {
      const res = await defaultGit(cwd, args);
      return { ...res, out: `warning: in the working copy of 'a.c', LF will be replaced by CRLF the next time Git touches it\n${res.out}` };
    };
    expect((await worktreeChanges(r, wt, "flash/review", noisy)).files).toEqual(ch.files);
    expect(await worktreeFileDiff(r, wt, "flash/review", "a.c")).toEqual({ oldText: "int a;\n", newText: "int a;\nint b;\nint c;\n", binary: false, tooLarge: false });
    expect((await worktreeFileDiff(r, wt, "flash/review", "gone.c")).oldText).toBe("int g;\n");
    await expect(worktreeFileDiff(r, wt, "flash/review", "../../etc/passwd")).rejects.toThrow(/outside/);
  });

  it("turns line comments into one fix request with file, line and code", () => {
    const text = buildFixRequest("flash/tester-1", [
      { path: "src/b.c", line: 9, side: "new", code: "  return x;", text: "Return a copy" },
      { path: "src/a.c", line: 3, side: "old", code: "int `a`;", text: " Keep this line " },
      { path: "src/a.c", line: 4, side: "new", code: "", text: "   " },
    ], "Run the tests too.");
    expect(text).toBe([
      "**Review of your changes on `flash/tester-1`.** Please address these 2 comments, then commit on the same branch.",
      "1. `src/a.c` removed line 3 (`int 'a';`): Keep this line\n2. `src/b.c` line 9 (`return x;`): Return a copy",
      "Also: Run the tests too.",
    ].join("\n\n"));
    expect(() => buildFixRequest("b", [], " ")).toThrow(/comment/);
  });

  it("keeps an idle specialist while its worktree holds unmerged or uncommitted work, and closes it once merged", async () => {
    const db = new Db(":memory:");
    const settings = mergeSettings(DEFAULT_SETTINGS, { general: { defaultHarness: "mock" } }) as Settings;
    const roles = loadRoles(join(__dirname, "..", "agents"), "/none");
    const orch = new Orchestrator({ db, harnesses: new HarnessRegistry([new MockAdapter(1)]), settings: () => settings, roles: () => roles,
      skills: () => [], emit: () => undefined, mcpServersFor: () => [], homeDir: tmpdir(), dataDir: mkdtempSync(join(tmpdir(), "data-")) });
    const p = db.createProject("p", repo());
    const chat = db.createChat({ projectId: p.id, title: "c", kind: "project", agentRole: "flashmaster" });
    await orch.sendUserMessage(chat.id, "hello", null);
    await until(() => db.listAgents({}).some((x) => x.role === "flashmaster" && x.status === "idle"));
    const parentId = db.listAgents({}).find((x) => x.role === "flashmaster")!.id;
    const r = await orch.delegate(parentId, { role: "tester", goal: "Add a test" });
    const a = db.getAgent(r.agentId)!;
    expect(existsSync(a.worktree!)).toBe(true);
    const later = () => Date.now() + 60 * 60_000;
    writeFileSync(join(a.worktree!, "wip.c"), "int wip;\n");
    expect(await orch.closeIdle(later())).toEqual([]); // uncommitted
    git(a.worktree!, "add", "-A");
    git(a.worktree!, "commit", "-qm", "wip");
    expect(await orch.closeIdle(later())).toEqual([]); // committed but not merged
    expect(db.getAgent(a.id)!.status).toBe("idle");
    expect((await orch.mergeWork(a.id)).ok).toBe(true);
    expect(await orch.closeIdle(later())).toEqual([a.id]);
    expect(db.getAgent(a.id)).toMatchObject({ status: "done", worktree: null, branch: null });
    expect(existsSync(a.worktree!)).toBe(false);
    await orch.stopAll();
  });

  it("sends review comments to a finished specialist, which works on in its own copy", async () => {
    const db = new Db(":memory:");
    const settings = mergeSettings(DEFAULT_SETTINGS, { general: { defaultHarness: "mock" } }) as Settings;
    const roles = loadRoles(join(__dirname, "..", "agents"), "/none");
    const mk = () => new Orchestrator({ db, harnesses: new HarnessRegistry([new MockAdapter(1)]), settings: () => settings, roles: () => roles,
      skills: () => [], emit: () => undefined, mcpServersFor: () => [], homeDir: tmpdir(), dataDir: mkdtempSync(join(tmpdir(), "data-")) });
    const orch = mk();
    const p = db.createProject("p", repo());
    const chat = db.createChat({ projectId: p.id, title: "c", kind: "project", agentRole: "flashmaster" });
    const tester = roles.find((x) => x.name === "tester")!;
    await (orch as any).turn({ chat, threadRoot: null, role: tester, input: "Add a test", skills: [], depth: 1, brief: "Goal: add a test" });
    const a = db.listAgents({}).find((x) => x.role === "tester")!;
    commitIn(a.worktree!, "t.c", "int t;\n");
    expect((await orch.workChanges(a.id)).files.map((f) => f.path)).toEqual(["t.c"]);

    // After a restart the agent has no session: the request brings it back on the same branch.
    const again = mk();
    const replies = () => db.listMessages(chat.id, null).filter((m) => m.author === "agent" && m.role === "tester").length;
    const before = replies();
    const msg = await again.requestWorkFixes(a.id, [{ path: "t.c", line: 1, side: "new", code: "int t;", text: "Name it test_count" }]);
    expect(msg.content).toMatch(/`t\.c` line 1 \(`int t;`\): Name it test_count/);
    await until(() => replies() > before && db.getAgent(a.id)!.status !== "running");
    expect(db.getAgent(a.id)!.worktree).toBe(a.worktree);
    await expect(again.requestWorkFixes(a.id, [], "")).rejects.toThrow(/comment/);
  });
});
