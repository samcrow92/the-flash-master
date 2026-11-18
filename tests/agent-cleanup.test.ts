import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../src/main/db";
import { Orchestrator } from "../src/main/orchestrator";
import { HarnessRegistry } from "../src/main/harness/registry";
import { MockAdapter } from "../src/main/harness/mock";
import { Bridge } from "../src/main/bridge";
import { buildTools } from "../src/main/tools";
import { loadRoles } from "../src/main/roles";
import { createForwarder } from "../mcp-servers/common/stdio-forwarder";
import { DEFAULT_SETTINGS, mergeSettings, type Settings } from "../src/shared/settings";

// Flash Master reported "cleanup could not be performed because no supported stop/delete tool is available":
// these tests cover the close_agent / close_idle_agents / delete_task tools it now has (on every harness, since all of
// them reach the app's tools through the same bridge: MCP or text-mode TOOL lines).
Object.assign(process.env, { GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.com" });
const ID = ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main"];
const git = (cwd: string, ...args: string[]) => execFileSync("git", [...ID, ...args], { cwd, encoding: "utf8" });
function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "cleanup-repo-"));
  git(dir, "init", "-q");
  writeFileSync(join(dir, "a.c"), "int a;\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "init");
  return dir;
}
// These tests create git repos and agent worktrees; with Windows antivirus each git call can take a second, so allow
// far more than CI needs (a release build on Mari's machine timed out at the 15 s default).
const until = async (fn: () => boolean, ms = 45000) => {
  const t = Date.now();
  while (!fn()) { if (Date.now() - t > ms) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 10)); }
};

async function setup(path = repo()) {
  const db = new Db(":memory:");
  const settings = mergeSettings(DEFAULT_SETTINGS, { general: { defaultHarness: "mock" } }) as Settings;
  const roles = loadRoles(join(__dirname, "..", "agents"), "/none");
  const orch = new Orchestrator({ db, harnesses: new HarnessRegistry([new MockAdapter(1)]), settings: () => settings, roles: () => roles,
    skills: () => [], emit: () => undefined, mcpServersFor: () => [], homeDir: tmpdir(), dataDir: mkdtempSync(join(tmpdir(), "data-")) });
  const p = db.createProject("p", path);
  const chat = db.createChat({ projectId: p.id, title: "c", kind: "project", agentRole: "flashmaster" });
  await orch.sendUserMessage(chat.id, "hello", null);
  await until(() => db.listAgents({}).some((x) => x.role === "flashmaster" && x.status === "idle"));
  const leadId = db.listAgents({}).find((x) => x.role === "flashmaster")!.id;
  return { db, orch, roles, leadId, p };
}

describe("Flash Master cleans up agents", { timeout: 90000 }, () => {
  it("offers close_agent, close_idle_agents and delete_task, and tells Flash Master to use them", () => {
    const names = buildTools({ db: new Db(":memory:"), orch: {} as Orchestrator, roles: () => [], jazz: () => null, emitTask: () => {} })
      .filter((t) => t.set === "core").map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["close_agent", "close_idle_agents", "delete_task"]));
    const fm = readFileSync(join(__dirname, "..", "agents", "flashmaster.md"), "utf8");
    for (const n of ["close_idle_agents", "close_agent", "delete_task"]) expect(fm).toContain(`\`${n}\``);
  });

  it("closes an idle specialist, keeps one with unmerged work until it is merged, and never closes the coordinator", async () => {
    const { db, orch, leadId } = await setup();
    const clean = await orch.delegate(leadId, { role: "tester", goal: "Look around" });
    const wip = await orch.delegate(leadId, { role: "tester", goal: "Add a test" });
    await until(() => db.getAgent(clean.agentId)!.status === "idle" && db.getAgent(wip.agentId)!.status === "idle");
    const w = db.getAgent(wip.agentId)!;
    writeFileSync(join(w.worktree!, "wip.c"), "int wip;\n");
    git(w.worktree!, "add", "-A");
    git(w.worktree!, "commit", "-qm", "wip");

    const r = await orch.closeIdleAgents(leadId);
    expect(r.closed.map((x) => x.agentId)).toEqual([clean.agentId]);
    expect(r.kept).toEqual([expect.objectContaining({ agentId: wip.agentId, closed: false, reason: expect.stringMatching(/1 unmerged commit/) })]);
    expect(db.getAgent(clean.agentId)).toMatchObject({ status: "done", worktree: null, lastActivity: expect.stringMatching(/^Closed by/) });
    // The coordinator is never closed. It can be idle or already "running": the two finished specialists wake it for a
    // new turn, which on a slow Windows runner is still going at this point (CI failed on that), so check it wasn't closed.
    expect(r.closed.map((x) => x.agentId)).not.toContain(leadId);
    expect(db.getAgent(leadId)!.status).not.toBe("done");
    expect(db.getAgent(leadId)!.lastActivity ?? "").not.toMatch(/^Closed by/);
    expect(existsSync(w.worktree!)).toBe(true);

    // force stops it but never throws its work away: the branch stays for review.
    const f = await orch.closeAgent(leadId, wip.agentId, { force: true });
    expect(f).toMatchObject({ closed: true, worktree: expect.stringMatching(/^kept/) });
    expect(db.getAgent(wip.agentId)).toMatchObject({ status: "done", worktree: w.worktree, branch: w.branch });
    expect(existsSync(w.worktree!)).toBe(true);

    expect(await orch.closeAgent(leadId, leadId)).toMatchObject({ closed: false, reason: "that is you" });
    expect(await orch.closeAgent(leadId, clean.agentId)).toMatchObject({ closed: false, reason: "already done" });
    await orch.stopAll();
  });

  it("keeps a working specialist unless forced, and a specialist can't close its coordinator or siblings", async () => {
    const { db, orch, leadId } = await setup(mkdtempSync(join(tmpdir(), "plain-")));
    const a = await orch.delegate(leadId, { role: "tester", goal: "One" });
    const b = await orch.delegate(leadId, { role: "analyst", goal: "Two" });
    await until(() => db.getAgent(a.agentId)!.status === "idle" && db.getAgent(b.agentId)!.status === "idle");
    expect(await orch.closeAgent(a.agentId, leadId)).toMatchObject({ closed: false, reason: /parent|chat's own/ });
    expect(await orch.closeAgent(a.agentId, b.agentId)).toMatchObject({ closed: false, reason: "you did not start it" });

    const live = (orch as any).byAgent.get(b.agentId);
    live.busy = true; // working right now
    expect(await orch.closeAgent(leadId, b.agentId)).toMatchObject({ closed: false, reason: expect.stringMatching(/working/) });
    expect((await orch.closeIdleAgents(leadId)).kept.map((x) => x.agentId)).toEqual([b.agentId]);
    live.busy = false;
    expect(await orch.closeAgent(leadId, b.agentId, { force: true })).toMatchObject({ closed: true });
    expect(db.getAgent(b.agentId)!.status).toBe("done");
    await orch.stopAll();
  });

  it("works through the tool bridge: close_idle_agents and delete_task, which keeps review tasks unless forced", async () => {
    const { db, orch, roles, leadId, p } = await setup(mkdtempSync(join(tmpdir(), "plain-")));
    const k = await orch.delegate(leadId, { role: "tester", goal: "One" });
    await until(() => db.getAgent(k.agentId)!.status === "idle");
    const deleted: string[] = [];
    const bridge = new Bridge();
    bridge.register(buildTools({ db, orch, roles: () => roles, jazz: () => null, emitTask: () => {}, deleteTask: (id) => deleted.push(id) }));
    const port = await bridge.start();
    const call = createForwarder("core", "flashmaster-core", { url: `http://127.0.0.1:${port}`, token: bridge.token, agentId: leadId });
    const tool = async (name: string, args: Record<string, unknown> = {}) =>
      JSON.parse(((await call({ method: "tools/call", params: { name, arguments: args } })) as any).content[0].text);
    try {
      expect((await tool("close_idle_agents")).closed.map((x: any) => x.agentId)).toEqual([k.agentId]);
      const done = db.createTask({ projectId: p.id, title: "old" });
      db.updateTask(done.id, { status: "done" });
      const rev = db.createTask({ projectId: p.id, title: "check me" });
      db.updateTask(rev.id, { status: "review" });
      expect(await tool("delete_task", { id: done.id })).toEqual({ id: done.id, deleted: true });
      expect(await tool("delete_task", { id: rev.id })).toMatchObject({ deleted: false, reason: expect.stringMatching(/review/) });
      expect(await tool("delete_task", { id: rev.id, force: true })).toMatchObject({ deleted: true });
      expect(deleted).toEqual([done.id, rev.id]);
      expect(db.getTask(done.id)).toBeNull();
      const other = db.createTask({ projectId: db.createProject("q", tmpdir()).id, title: "not yours" });
      const r: any = await call({ method: "tools/call", params: { name: "delete_task", arguments: { id: other.id } } });
      expect(JSON.stringify(r)).toMatch(/unknown task id/);
      expect(db.getTask(other.id)).not.toBeNull();
    } finally {
      bridge.stop();
      await orch.stopAll();
    }
  });
});
