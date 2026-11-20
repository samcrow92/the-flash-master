import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dependencyContext, normaliseTasks, planReport, readyTasks, resultOk, skipBlocked, validatePlan, waves } from "../src/main/plan";
import { emptyState, mergeState, renderState } from "../src/main/agent-state";
import { Db } from "../src/main/db";
import { Orchestrator } from "../src/main/orchestrator";
import { HarnessRegistry } from "../src/main/harness/registry";
import { MockAdapter } from "../src/main/harness/mock";
import type { HarnessSession, SessionOptions } from "../src/main/harness/types";
import { loadRoles } from "../src/main/roles";
import { DEFAULT_SETTINGS, mergeSettings, type Settings } from "../src/shared/settings";
import type { AppEvent, TaskPlan } from "../src/shared/types";

const until = async (fn: () => boolean, ms = 10_000) => {
  const t = Date.now();
  while (!fn()) { if (Date.now() - t > ms) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 10)); }
};

/** The mock harness, recording every prompt it gets. */
class RecordingMock extends MockAdapter {
  prompts: string[] = [];
  override async start(o: SessionOptions): Promise<HarnessSession> {
    const s = await super.start(o);
    const p = s.prompt.bind(s);
    (s as { prompt: HarnessSession["prompt"] }).prompt = (text, a) => { this.prompts.push(text); return p(text, a); };
    return s;
  }
}

function setup(patch: Record<string, unknown> = {}) {
  const db = new Db(":memory:");
  const settings = mergeSettings(DEFAULT_SETTINGS, { general: { defaultHarness: "mock" }, agents: { isolateWriters: false }, ...patch }) as Settings;
  const roles = loadRoles(join(__dirname, "..", "agents"), "/none");
  const mock = new RecordingMock(0);
  const events: AppEvent[] = [];
  const orch = new Orchestrator({ db, harnesses: new HarnessRegistry([mock]), settings: () => settings, roles: () => roles,
    skills: () => [], emit: (e) => events.push(e), mcpServersFor: () => [], homeDir: tmpdir(), dataDir: mkdtempSync(join(tmpdir(), "data-")) });
  return { db, orch, settings, mock, events };
}

async function coordinator(db: Db, orch: Orchestrator) {
  const chat = db.createChat({ projectId: null, title: "c", kind: "project", agentRole: "flashmaster" });
  await orch.sendUserMessage(chat.id, "Look at the CAN log", null);
  await until(() => db.listAgents({}).some((x) => x.role === "flashmaster" && x.status === "idle"));
  return { chat, coord: db.listAgents({}).find((x) => x.role === "flashmaster")! };
}

describe("task plans (pure)", () => {
  const roles = ["analyst", "tester", "coder"];
  it("normalises, validates and orders a task graph", () => {
    const t = normaliseTasks([{ id: "Analyse Log", role: "analyst", goal: "a" }, { id: "fix", role: "coder", goal: "b", dependsOn: "analyse-log" },
      { role: "tester", goal: "c", dependsOn: ["fix"], attempts: 7, mode: "turbo" }]);
    expect(t.map((x) => [x.id, x.dependsOn, x.attempts, x.mode])).toEqual([["analyse-log", [], null, null], ["fix", ["analyse-log"], null, null], ["t3", ["fix"], 3, null]]);
    expect(validatePlan(t, roles)).toEqual([]);
    expect(waves(t)).toEqual([["analyse-log"], ["fix"], ["t3"]]);
    expect(validatePlan(normaliseTasks([{ id: "a", role: "x", goal: "g", dependsOn: ["b"] }, { id: "a", role: "coder", goal: "" }]), roles))
      .toEqual(['task "a": unknown role "x" (one of: analyst, tester, coder)', 'duplicate task id "a"', 'task "a" has no goal', 'task "a" depends on unknown task "b"']);
    expect(validatePlan(normaliseTasks([{ id: "a", role: "coder", goal: "g", dependsOn: ["b"] }, { id: "b", role: "coder", goal: "g", dependsOn: ["a"] }]), roles))
      .toEqual(["dependency cycle: a → b → a"]);
    expect(validatePlan([], roles)).toEqual(["the plan has no tasks"]);
  });

  it("starts what is ready, skips what depends on a failure and reports", () => {
    const plan = { id: "p", chatId: "c", agentId: "a", title: "Fix", status: "running", messageId: null, createdAt: 0, updatedAt: 0,
      tasks: normaliseTasks([{ id: "a", role: "analyst", goal: "a" }, { id: "b", role: "tester", goal: "b" }, { id: "c", role: "coder", goal: "c", dependsOn: ["a", "b"] },
        { id: "d", role: "coder", goal: "d", dependsOn: ["c"] }]) } as TaskPlan;
    expect(readyTasks(plan).map((t) => t.id)).toEqual(["a", "b"]);
    plan.tasks[0]!.status = "done"; plan.tasks[0]!.result = "summary: CAN id 0x123 floods";
    expect(readyTasks(plan).map((t) => t.id)).toEqual(["b"]);
    expect(dependencyContext(plan, plan.tasks[2]!)).toContain("CAN id 0x123 floods");
    plan.tasks[1]!.status = "failed";
    expect(skipBlocked(plan)).toEqual(["c", "d"]);
    plan.status = "failed";
    expect(planReport(plan)).toMatch(/finished with problems: 1\/4 tasks done/);
    expect([resultOk("summary: ok"), resultOk("<result>\nstatus: blocked\n</result>"), resultOk("error: boom"), resultOk("status: done")]).toEqual([true, false, false, true]);
  });
});

describe("agent working state", () => {
  it("merges updates and renders only when there is something to continue from", () => {
    expect(renderState(emptyState("goal only"))).toBe("");
    let s = mergeState(null, { goal: "Fix flicker", done: ["read log"], next: ["write test"], files: "src/a.c\n- src/b.c" }, 5);
    s = mergeState(s, { done: ["read log", "found cause"], next: ["fix"], decisions: ["debounce 20 ms: spec"] }, 6);
    expect(s).toMatchObject({ goal: "Fix flicker", done: ["read log", "found cause"], next: ["fix"], files: ["src/a.c", "src/b.c"], decisions: ["debounce 20 ms: spec"], updatedAt: 6 });
    expect(renderState(s)).toMatch(/Your working state[\s\S]*Done:\n- read log\n- found cause[\s\S]*Next:\n- fix/);
  });
});

describe("task plans (orchestrator)", () => {
  it("shows a proposed plan for approval, then runs it in waves with each task's dependencies in its brief", async () => {
    const { db, orch, mock, events } = setup();
    const { chat, coord } = await coordinator(db, orch);
    const r = orch.proposePlan(coord.id, { title: "CAN flood", tasks: [
      { id: "log", role: "analyst", goal: "Summarise the CAN log" }, { id: "spec", role: "analyst", goal: "Read the bus spec" },
      { id: "test", role: "tester", goal: "Write a test for the flood", dependsOn: ["log", "spec"] }] });
    expect(r.status).toBe("draft");
    const card = db.listMessages(chat.id, null).find((m) => m.planId === r.planId)!;
    expect(card.content).toContain("wave 1: log (analyst)");
    expect(() => orch.updatePlan(r.planId, { tasks: [{ id: "x", role: "nobody", goal: "g" }] as never })).toThrow(/unknown role/);
    expect(() => orch.proposePlan(coord.id, { tasks: [] })).toThrow(/no tasks/);
    const turnsBefore = mock.prompts.length;
    await orch.approvePlan(r.planId);
    await until(() => orch.getPlan(r.planId)!.status === "done");
    const plan = orch.getPlan(r.planId)!;
    expect(plan.tasks.map((t) => t.status)).toEqual(["done", "done", "done"]);
    const test = db.getAgent(plan.tasks[2]!.agentId!)!;
    const logDone = Math.max(...plan.tasks.slice(0, 2).map((t) => db.getAgent(t.agentId!)!.startedAt));
    expect(test.startedAt).toBeGreaterThanOrEqual(logDone);
    const testPrompt = mock.prompts.slice(turnsBefore).find((p) => p.includes("Write a test for the flood"))!;
    expect(testPrompt).toContain("Results of the tasks it builds on");
    expect(testPrompt).toContain('Mock run for "Summarise the CAN log');
    // The coordinator gets one combined message, not one per specialist.
    await until(() => mock.prompts.some((p) => p.includes('## Plan "CAN flood" finished: 3/3 tasks done')));
    expect(mock.prompts.filter((p) => p.includes("## Specialist results")).length).toBe(0);
    expect(events.some((e) => e.type === "plan.updated" && e.plan.status === "running")).toBe(true);
    await orch.stopAll();
  });

  it("skips what depends on a failed task, and tells the coordinator when the user declines a plan", async () => {
    const { db, orch, mock } = setup({ agents: { planApproval: "auto", isolateWriters: false } });
    const { coord } = await coordinator(db, orch);
    const r = orch.proposePlan(coord.id, { title: "Local", tasks: [{ id: "a", role: "analyst", goal: "Read it [blocked-local]" }, { id: "b", role: "tester", goal: "Test", dependsOn: ["a"] }] });
    expect(r.status).toBe("running");
    await until(() => orch.getPlan(r.planId)!.status === "failed");
    expect(orch.getPlan(r.planId)!.tasks.map((t) => t.status)).toEqual(["failed", "skipped"]);
    await until(() => mock.prompts.some((p) => p.includes('## Plan "Local" finished with problems: 0/2 tasks done')));
    expect(mock.prompts.find((p) => p.includes('## Plan "Local"'))).toMatch(/b · Test \(tester\) — skipped[\s\S]*skipped: a did not finish/);
    await until(() => db.getAgent(coord.id)!.status === "idle");
    // A declined draft never runs; the coordinator hears about it.
    const { db: db2, orch: orch2, mock: mock2 } = setup();
    const c2 = await coordinator(db2, orch2);
    const p2 = orch2.proposePlan(c2.coord.id, { title: "Again", tasks: [{ id: "a", role: "analyst", goal: "x" }] });
    orch2.cancelPlan(p2.planId);
    expect(orch2.getPlan(p2.planId)!.tasks[0]).toMatchObject({ status: "skipped" });
    await expect(orch2.approvePlan(p2.planId)).rejects.toThrow(/isn't waiting/);
    await until(() => mock2.prompts.some((p) => p.includes('The user declined your plan "Again"')));
    await orch.stopAll();
    await orch2.stopAll();
  });

  it("a fresh session of a specialist continues from its working state", async () => {
    const { db, orch, mock } = setup();
    const { coord } = await coordinator(db, orch);
    const r = await orch.delegate(coord.id, { role: "analyst", goal: "Summarise the CAN log" });
    expect(orch.agentState(r.agentId)).toMatchObject({ goal: "Summarise the CAN log" });
    orch.updateState(r.agentId, { done: ["found the 0x123 flood"], next: ["check the gateway filter"] });
    await orch.delegate(coord.id, { role: "analyst", goal: "Go on", agentId: r.agentId, model: "other-model" }); // new model: a fresh session
    expect(mock.prompts.some((p) => p.includes("Go on") && p.includes("## Your working state") && p.includes("found the 0x123 flood"))).toBe(true);
    await orch.stopAll();
  });

  it("a cheap or local model can write the chat summary", async () => {
    const { db, orch, settings } = setup();
    settings.tokens.summarizer = "model";
    settings.tokens.summarizerModel = "mock/small";
    const chat = db.createChat({ projectId: null, title: "c", kind: "project", agentRole: "flashmaster" });
    db.setChatSummary(chat.id, "extractive", 7);
    await (orch as unknown as { modelSummary: (c: string, p: string | null, m: unknown[], u: number) => Promise<void> })
      .modelSummary(chat.id, null, [{ author: "user", role: null, content: "Fix the flicker" }], 7);
    expect(db.getChatSummary(chat.id)).toMatchObject({ upto: 7, summary: expect.stringContaining("mock harness") });
    db.setChatSummary(chat.id, "newer", 9);
    await (orch as unknown as { modelSummary: (c: string, p: string | null, m: unknown[], u: number) => Promise<void> })
      .modelSummary(chat.id, null, [{ author: "user", role: null, content: "x" }], 7);
    expect(db.getChatSummary(chat.id).summary).toBe("newer"); // a newer summary is never overwritten
  });
});
