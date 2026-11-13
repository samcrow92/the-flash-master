import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canIsolate, createWorktree, mergeWorktree, removeWorktree, worktreeState } from "../src/main/worktree";
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
    expect(a.resultSummary).toMatch(/branch: flash\/tester-/);
    expect(db.listMessages(chat.id, null).some((m) => m.author === "system" && /own copy of the project/.test(m.content))).toBe(true);
    expect((await orch.discardWork(a.id)).ok).toBe(true); // nothing committed: nothing to lose
    expect(db.getAgent(a.id)!.worktree).toBeNull();

    await orch.sendUserMessage(chat.id, "hello", null);
    await until(() => db.listAgents({}).some((x) => x.role === "flashmaster" && !!x.resultSummary));
    expect(db.listAgents({}).find((x) => x.role === "flashmaster")!.worktree).toBeNull();
  });
});
