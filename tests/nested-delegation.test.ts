// Specialists can hand sub-tasks to helpers (nested delegation), bounded by the delegation depth and by the
// coordinator's specialists-at-once cap, which covers its whole tree. Any agent can read an earlier agent's
// full report with read_report, so nobody has to delegate a helper just to recover one.
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockAdapter } from "../src/main/harness/mock";
import { HarnessRegistry } from "../src/main/harness/registry";
import { Db } from "../src/main/db";
import { Orchestrator } from "../src/main/orchestrator";
import { buildBrief } from "../src/main/context";
import { loadRoles, loadSkills } from "../src/main/roles";
import { DEFAULT_SETTINGS, mergeSettings, type DeepPartial, type Settings } from "../src/shared/settings";

const until = async (fn: () => boolean, ms = 10000) => {
  const t = Date.now();
  while (!fn()) { if (Date.now() - t > ms) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 10)); }
};

function setup(over: DeepPartial<Settings> = {}) {
  const db = new Db(":memory:");
  const settings = mergeSettings(mergeSettings(DEFAULT_SETTINGS, { general: { defaultHarness: "mock" }, agents: { toolMode: "auto" } } as any), over as any) as Settings;
  const harnesses = new HarnessRegistry([new MockAdapter(2)]);
  const roles = loadRoles(join(__dirname, "..", "agents"), "/nonexistent");
  const skills = loadSkills(join(__dirname, "..", "skills", "superpowers"));
  const orch = new Orchestrator({ db, harnesses, settings: () => settings, roles: () => roles, skills: () => skills, emit: () => {},
    mcpServersFor: () => [], homeDir: tmpdir() });
  const project = db.createProject("demo", mkdtempSync(join(tmpdir(), "proj-")));
  const chat = db.createChat({ projectId: project.id, title: "General", kind: "project", agentRole: "flashmaster" });
  return { db, orch, chat };
}

const coordReplies = (db: Db, chatId: string) => db.listMessages(chatId, null).filter((m) => m.author === "agent" && m.role === "flashmaster");
async function idleCoordinator(db: Db, orch: Orchestrator, chatId: string): Promise<string> {
  await orch.sendUserMessage(chatId, "Plan the brake light feature", null);
  await until(() => coordReplies(db, chatId)[0]?.status === "done" && db.getAgent(coordReplies(db, chatId)[0]!.agentId!)!.status === "idle");
  return coordReplies(db, chatId)[0]!.agentId!;
}

describe("specialists delegate to helpers", () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { await cleanup?.(); cleanup = null; });

  it("defaults let a specialist's helper start one more helper, and stop there", async () => {
    expect(DEFAULT_SETTINGS.agents.delegationDepth).toBe(3);
    const { db, orch, chat } = setup();
    cleanup = () => orch.stopAll();
    const coord = await idleCoordinator(db, orch, chat.id);
    const spec = await orch.delegate(coord, { role: "analyst", goal: "Analyse" });
    const helper = await orch.delegate(spec.agentId, { role: "tester", goal: "Recover the report" });
    expect(helper.result).toBeTruthy();
    const sub = await orch.delegate(helper.agentId, { role: "reviewer", goal: "Check it" });
    expect(sub.result).toBeTruthy();
    expect(db.getAgent(sub.agentId)!.parentAgentId).toBe(helper.agentId);
    const err = await orch.delegate(sub.agentId, { role: "tester", goal: "Deeper" }).catch((e: Error) => e.message);
    expect(err).toMatch(/depth limit \(3 levels/);
    expect(err).toContain("read_report"); // points at the way to get an earlier report without delegating
  });

  it("a specialist waiting for its helper lends it its place, so a full team never deadlocks", async () => {
    const { db, orch, chat } = setup({ agents: { maxParallelSpecialists: 1 } });
    cleanup = () => orch.stopAll();
    const coord = await idleCoordinator(db, orch, chat.id);
    const spec = await orch.delegate(coord, { role: "analyst", goal: "Long job [hang]", wait: false });
    await until(() => (orch as any).byAgent.get(spec.agentId).busy);
    // The team is full (1 of 1), yet the specialist's own waiting helper starts and returns.
    const helper = await orch.delegate(spec.agentId, { role: "tester", goal: "Fetch the earlier report" });
    expect(helper.result).toBeTruthy();
    // A background helper is extra work, though: it counts against the coordinator's cap like any specialist.
    const err = await orch.delegate(spec.agentId, { role: "tester", goal: "More", wait: false }).catch((e: Error) => e.message);
    expect(err).toMatch(/at most 1 work at once/);
  });

  it("the brief tells a specialist it may use helpers and read_report", () => {
    expect(buildBrief({ goal: "x", parentRole: "flashmaster", helperLevels: 1 })).toMatch(/helper with delegate.*read_report/);
    expect(buildBrief({ goal: "x", parentRole: "flashmaster", helperLevels: 0 })).toMatch(/can't delegate further.*read_report/);
  });
});

describe("read_report", () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { await cleanup?.(); cleanup = null; });

  it("any agent of the project reads another agent's full report by id or name, in slices", async () => {
    const { db, orch, chat } = setup();
    cleanup = () => orch.stopAll();
    const coord = await idleCoordinator(db, orch, chat.id);
    const writer = await orch.delegate(coord, { role: "analyst", goal: "Write the accepted report" });
    const other = await orch.delegate(coord, { role: "tester", goal: "Turn it into HTML" });
    const full = db.agentReplies(writer.agentId, 1)[0]!.content;
    expect(full.length).toBeGreaterThan(0);
    const byId = orch.readReport(other.agentId, { agentId: writer.agentId });
    expect(byId.report).toBe(full.slice(0, 12000));
    expect(byId.role).toBe("analyst");
    expect(orch.readReport(other.agentId, { name: writer.name! }).agentId).toBe(writer.agentId);
    const slice = orch.readReport(other.agentId, { agentId: writer.agentId, offset: 5, limit: 500 });
    expect(slice.report).toBe(full.slice(5, 505));
    expect(slice.chars).toBe(full.length);
  });

  it("does not reach agents of another project", async () => {
    const a = setup();
    cleanup = () => a.orch.stopAll();
    const coord = await idleCoordinator(a.db, a.orch, a.chat.id);
    const writer = await a.orch.delegate(coord, { role: "analyst", goal: "Write" });
    const p2 = a.db.createProject("other", mkdtempSync(join(tmpdir(), "proj-")));
    const stranger = a.db.createAgent({ projectId: p2.id, chatId: null, role: "tester", harness: "mock", model: null, parentAgentId: null, brief: "" } as any);
    expect(() => a.orch.readReport(stranger.id, { agentId: writer.agentId })).toThrow(/no such agent in this project/);
  });
});
