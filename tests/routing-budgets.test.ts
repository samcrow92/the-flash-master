import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attemptsReport, rankAttempts, routeByDifficulty, type Attempt } from "../src/main/routing";
import { parseTextDelegations } from "../src/main/context";
import { Db } from "../src/main/db";
import { Orchestrator } from "../src/main/orchestrator";
import { HarnessRegistry } from "../src/main/harness/registry";
import { MockAdapter } from "../src/main/harness/mock";
import { loadRoles } from "../src/main/roles";
import { DEFAULT_SETTINGS, mergeSettings, type DeepPartial, type Settings } from "../src/shared/settings";
import type { CheckRun } from "../src/shared/types";

Object.assign(process.env, { GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.com" });
const ID = ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main"];
const git = (cwd: string, ...args: string[]) => execFileSync("git", [...ID, ...args], { cwd, encoding: "utf8" });
function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "rt-repo-"));
  git(dir, "init", "-q");
  writeFileSync(join(dir, "a.c"), "int a;\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "init");
  return dir;
}
const until = async (fn: () => boolean, ms = 8000) => {
  const t = Date.now();
  while (!fn()) { if (Date.now() - t > ms) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 10)); }
};
const run = (ok: boolean): CheckRun => ({ ok, head: "h", dirty: false, at: 1, results: [] });

describe("routing by difficulty", () => {
  it("sends simple lookups to ECO, hard problems to SPORT, the rest to COMFORT", () => {
    expect(routeByDifficulty("Find where BrakeLightReq is read and list the files")).toMatchObject({ mode: "eco" });
    expect(routeByDifficulty("Find the root cause of the intermittent CAN timeout")).toMatchObject({ mode: "sport", reason: 'looks hard ("root cause")' });
    expect(routeByDifficulty("Add a unit test for the pedal switch module")).toMatchObject({ mode: "comfort" });
    expect(routeByDifficulty(`Summarise ${"long context ".repeat(80)}`).mode).toBe("comfort"); // long briefs aren't "simple"
  });

  it("reads mode and attempts from text-mode DELEGATE lines", () => {
    const [d] = parseTextDelegations('DELEGATE coder attempts "3" mode "sport": Rework the scheduler');
    expect(d).toEqual({ role: "coder", mode: "sport", attempts: 3, goal: "Rework the scheduler" });
  });
});

describe("best of N", () => {
  const at = (agentId: string, checks: CheckRun | null, changed: number | null, result = "summary: ok"): Attempt =>
    ({ agentId, name: agentId, branch: `flash/${agentId}`, status: "idle", result, checks, changed });

  it("ranks green checks first, then a finished result, then the smallest real change", () => {
    expect(rankAttempts([at("a", run(false), 3), at("b", run(true), 90), at("c", run(true), 12)]).map((x) => x.agentId)).toEqual(["c", "b", "a"]);
    expect(rankAttempts([at("a", null, 5, "error: crashed"), at("b", null, 50)]).map((x) => x.agentId)).toEqual(["b", "a"]);
    expect(rankAttempts([at("a", null, 0), at("b", null, 40)]).map((x) => x.agentId)).toEqual(["b", "a"]); // no change ranks last
    expect(rankAttempts([at("a", null, 10), at("b", null, 10)]).map((x) => x.agentId)).toEqual(["a", "b"]);
    const rep = attemptsReport(rankAttempts([at("a", run(false), 3), at("b", run(true), 9)]));
    expect(rep).toMatch(/^## Best of 2 attempts: b wins\n\nsummary: ok[\s\S]*- b \(agentId b, branch flash\/b\): checks passed, 9 lines changed\n- a [\s\S]*Follow up on the winner with agentId b/);
  });
});

function setup(patch: DeepPartial<Settings> = {}) {
  const db = new Db(":memory:");
  const settings = mergeSettings(DEFAULT_SETTINGS, mergeSettings({ general: { defaultHarness: "mock" } }, patch)) as Settings;
  const roles = loadRoles(join(__dirname, "..", "agents"), "/none");
  const orch = new Orchestrator({ db, harnesses: new HarnessRegistry([new MockAdapter(1)]), settings: () => settings, roles: () => roles,
    skills: () => [], emit: () => undefined, mcpServersFor: () => [], homeDir: tmpdir(), dataDir: mkdtempSync(join(tmpdir(), "data-")) });
  return { db, orch, settings };
}
async function coordinator(db: Db, orch: Orchestrator, path = repo()) {
  const p = db.createProject("p", path);
  const chat = db.createChat({ projectId: p.id, title: "c", kind: "project", agentRole: "flashmaster" });
  await orch.sendUserMessage(chat.id, "hello", null);
  await until(() => db.listAgents({}).some((x) => x.role === "flashmaster" && x.status === "idle"));
  return { chat, parentId: db.listAgents({}).find((x) => x.role === "flashmaster")!.id };
}
const allContent = (db: Db, chatId: string) => (db.raw.prepare("SELECT content FROM messages WHERE chat_id=?").all(chatId) as { content: string }[]).map((m) => m.content);

describe("delegation routing, best of N and budgets in the orchestrator", () => {
  it("runs a delegation on the drive-mode profile the coordinator or the router picks", async () => {
    const { db, orch } = setup({ modes: { eco: { harness: "", model: "tiny-model", thinking: "" }, sport: { harness: "", model: "big-model", thinking: "" } }, agents: { autoRoute: true } });
    const { parentId } = await coordinator(db, orch);
    const r1 = await orch.delegate(parentId, { role: "analyst", goal: "Assess the brake light requirement", mode: "sport" });
    expect(db.getAgent(r1.agentId)!.model).toBe("big-model");
    const r2 = await orch.delegate(parentId, { role: "analyst", goal: "List the files that read BrakeLightReq" });
    expect(db.getAgent(r2.agentId)!.model).toBe("tiny-model");
    const r3 = await orch.delegate(parentId, { role: "analyst", goal: "List the files that read BrakeLightReq", model: "named-model" });
    expect(db.getAgent(r3.agentId)!.model).toBe("named-model"); // an explicit model always wins
    await orch.stopAll();
  });

  it("runs best of N in separate worktrees and returns the winner with a comparison", async () => {
    const { db, orch } = setup();
    const { chat, parentId } = await coordinator(db, orch);
    const r = await orch.delegate(parentId, { role: "tester", goal: "Add a unit test for the pedal switch", attempts: 2 });
    expect(r.result).toMatch(/^## Best of 2 attempts: \S+ wins/);
    const testers = db.listAgents({}).filter((a) => a.role === "tester");
    expect(testers).toHaveLength(2);
    expect(new Set(testers.map((a) => a.worktree)).size).toBe(2);
    expect(allContent(db, chat.id).some((c) => /^🏁 Best of 2: \*\*\S+\*\* wins \(no checks, 0 lines\)\. Kept for your review/.test(c))).toBe(true);
    await orch.stopAll();
  });

  it("stops starting specialists once a request's tree spent its task budget", async () => {
    const { db, orch, settings } = setup({ tokens: { taskBudget: 100 } });
    const { chat, parentId } = await coordinator(db, orch);
    expect(orch.requestTokens(parentId)!.used).toBeGreaterThan(100); // the mock coordinator's own reply already costs more
    await expect(orch.delegate(parentId, { role: "analyst", goal: "Assess it" })).rejects.toThrow(/task budget reached: this request used [\d,]+ of 100 tokens/);
    expect(allContent(db, chat.id).filter((c) => c.startsWith("🛑 Task budget reached")).length).toBe(1);
    settings.tokens.taskBudget = 0;
    await expect(orch.delegate(parentId, { role: "analyst", goal: "Assess it" })).resolves.toMatchObject({ status: expect.any(String) });
    await orch.stopAll();
  });

  it("tells a specialist past its time limit to wrap up, then stops it and reports to its coordinator", async () => {
    const { db, orch } = setup({ agents: { maxTaskMinutes: 1 } });
    const { chat, parentId } = await coordinator(db, orch);
    const r = await orch.delegate(parentId, { role: "analyst", goal: "Look at the logs [hang-hard]", wait: false });
    await until(() => db.getAgent(r.agentId)!.status === "running");
    const later = Date.now() + 61_000;
    expect(orch.checkTimeLimits(later)).toEqual([r.agentId]);
    expect(allContent(db, chat.id).some((c) => /reached the 1-minute limit per task/.test(c))).toBe(true);
    expect(orch.checkTimeLimits(later + 1000)).toEqual([]); // grace period
    expect(orch.checkTimeLimits(later + 4 * 60_000)).toEqual([r.agentId]);
    expect(allContent(db, chat.id).some((c) => /kept working past its time limit, so it was stopped/.test(c))).toBe(true);
    await orch.stopAll();
  });
});
