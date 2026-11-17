// The coordinator runs an organised team: a cap on specialists working at once, and finished background
// specialists wake it up with their results (on every harness: the orchestrator does it, not the agent CLI).
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockAdapter } from "../src/main/harness/mock";
import { HarnessRegistry } from "../src/main/harness/registry";
import { Db } from "../src/main/db";
import { Orchestrator } from "../src/main/orchestrator";
import { loadRoles, loadSkills } from "../src/main/roles";
import { DEFAULT_SETTINGS, mergeSettings, type DeepPartial, type Settings } from "../src/shared/settings";

const until = async (fn: () => boolean, ms = 10000) => {
  const t = Date.now();
  while (!fn()) { if (Date.now() - t > ms) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 10)); }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

/** Start the coordinator and return its agent id once its first reply is done (it is idle afterwards). */
async function idleCoordinator(db: Db, orch: Orchestrator, chatId: string): Promise<string> {
  await orch.sendUserMessage(chatId, "Plan the brake light feature", null);
  await until(() => coordReplies(db, chatId)[0]?.status === "done" && db.getAgent(coordReplies(db, chatId)[0]!.agentId!)!.status === "idle");
  return coordReplies(db, chatId)[0]!.agentId!;
}

describe("finished specialists wake their coordinator", () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { await cleanup?.(); cleanup = null; });

  it("a background delegation's result comes back as a new coordinator turn", async () => {
    const { db, orch, chat } = setup();
    cleanup = () => orch.stopAll();
    const parentId = await idleCoordinator(db, orch, chat.id);
    const bg = await orch.delegate(parentId, { role: "tester", goal: "Write tests", wait: false });
    expect(bg.result).toMatch(/comes to you in a new message/);
    await until(() => coordReplies(db, chat.id).length === 2 && coordReplies(db, chat.id)[1]!.status === "done");
    // The mock echoes the first line of what it was sent: the results message.
    expect(coordReplies(db, chat.id)[1]!.content).toContain("Specialist results");
    expect(db.listEvents(parentId).some((e) => /woken: .*finished/.test(e.label))).toBe(true);
  });

  it("results that finish close together wake the coordinator once", async () => {
    const { db, orch, chat } = setup();
    cleanup = () => orch.stopAll();
    const parentId = await idleCoordinator(db, orch, chat.id);
    const a = await orch.delegate(parentId, { role: "tester", goal: "Test the brake light", wait: false });
    const b = await orch.delegate(parentId, { role: "reviewer", goal: "Review brake.c", wait: false });
    await until(() => db.getAgent(a.agentId)!.status === "idle" && db.getAgent(b.agentId)!.status === "idle");
    await until(() => coordReplies(db, chat.id).length >= 2 && coordReplies(db, chat.id).at(-1)!.status === "done");
    await sleep(2500);
    expect(coordReplies(db, chat.id).length).toBe(2);
    expect(db.listEvents(parentId).filter((e) => /^woken:/.test(e.label)).length).toBe(1);
  });

  it("a waiting delegation whose caller already moved on (harness dropped the tool call) still wakes it", async () => {
    const { db, orch, chat } = setup();
    cleanup = () => orch.stopAll();
    const parentId = await idleCoordinator(db, orch, chat.id);
    // The coordinator's turn is over (not busy), so nobody reads the tool result this call returns.
    await orch.delegate(parentId, { role: "tester", goal: "Write tests" });
    await until(() => coordReplies(db, chat.id).length === 2 && coordReplies(db, chat.id)[1]!.status === "done");
  });

  it("no wake-up when the coordinator waited for the result in its turn", async () => {
    const { db, orch, chat } = setup();
    cleanup = () => orch.stopAll();
    await orch.sendUserMessage(chat.id, "Plan the brake light feature [hang]", null); // stays busy, like a coordinator blocked in delegate
    await until(() => db.getAgent(coordReplies(db, chat.id)[0]?.agentId ?? "")?.status === "running");
    const parentId = coordReplies(db, chat.id)[0]!.agentId!;
    const r = await orch.delegate(parentId, { role: "tester", goal: "Write tests" });
    expect(r.result).toContain("summary:");
    await sleep(300);
    expect((orch as any).reports.size).toBe(0);
  });

  it("no wake-up for a result the coordinator already fetched with get_result", async () => {
    const { db, orch, chat } = setup();
    cleanup = () => orch.stopAll();
    const parentId = await idleCoordinator(db, orch, chat.id);
    const bg = await orch.delegate(parentId, { role: "reviewer", goal: "Review brake.c", wait: false });
    await until(() => !(orch as any).byAgent.get(bg.agentId).busy && db.getAgent(bg.agentId)!.status === "idle");
    expect(orch.getResult(bg.agentId).result).toBeTruthy();
    await sleep(2500);
    expect(coordReplies(db, chat.id).length).toBe(1);
  });

  it("a stopped specialist doesn't wake anyone", async () => {
    const { db, orch, chat } = setup();
    cleanup = () => orch.stopAll();
    const parentId = await idleCoordinator(db, orch, chat.id);
    const bg = await orch.delegate(parentId, { role: "tester", goal: "Wait for the build server [hang]", wait: false });
    await until(() => db.getAgent(bg.agentId)!.status === "running");
    await orch.stop(bg.agentId);
    await sleep(2500);
    expect(coordReplies(db, chat.id).length).toBe(1);
  });
});

describe("at most maxParallelSpecialists work at once", () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { await cleanup?.(); cleanup = null; });

  it("refuses a background delegation over the cap, naming who works and who can be reused", async () => {
    const { db, orch, chat } = setup({ agents: { maxParallelSpecialists: 2 } });
    cleanup = () => orch.stopAll();
    const parentId = await idleCoordinator(db, orch, chat.id);
    const done = await orch.delegate(parentId, { role: "analyst", goal: "Summarise", wait: false });
    await until(() => !(orch as any).byAgent.get(done.agentId).busy);
    const a = await orch.delegate(parentId, { role: "tester", goal: "Wait [hang]", wait: false });
    const b = await orch.delegate(parentId, { role: "tester", goal: "Wait too [hang]", wait: false });
    const before = db.listAgents({}).length;
    const err = await orch.delegate(parentId, { role: "reviewer", goal: "Review", wait: false }).catch((e: Error) => e.message);
    expect(err).toMatch(/2 of your specialists are already working/);
    expect(err).toContain(a.name!);
    expect(err).toContain(b.name!);
    expect(err).toContain(done.agentId); // the finished one can take related work via agentId
    expect(db.listAgents({}).length).toBe(before); // no instance was created
  });

  it("waiting delegations run in waves instead of all at once", async () => {
    const { db, orch, chat } = setup({ agents: { maxParallelSpecialists: 2 } });
    cleanup = () => orch.stopAll();
    const parentId = await idleCoordinator(db, orch, chat.id);
    const live = (orch as any).byAgent as Map<string, { parentAgentId?: string | null; busy: boolean }>;
    let peak = 0;
    const watch = setInterval(() => { peak = Math.max(peak, [...live.values()].filter((l) => l.parentAgentId === parentId && l.busy).length); }, 1);
    const goals = ["Test A", "Test B", "Test C", "Test D", "Test E"];
    const rs = await Promise.all(goals.map((goal) => orch.delegate(parentId, { role: "tester", goal })));
    clearInterval(watch);
    expect(rs.every((r) => r.result)).toBe(true);
    expect(peak).toBeLessThanOrEqual(2);
    expect(peak).toBe(2);
    expect(db.listAgents({}).filter((a) => a.parentAgentId === parentId).length).toBe(5);
  });

  it("0 means no limit", async () => {
    const { db, orch, chat } = setup({ agents: { maxParallelSpecialists: 0 } });
    cleanup = () => orch.stopAll();
    const parentId = await idleCoordinator(db, orch, chat.id);
    for (const g of ["A", "B", "C", "D"]) await orch.delegate(parentId, { role: "tester", goal: `${g} [hang]`, wait: false });
    expect(db.listAgents({}).filter((a) => a.parentAgentId === parentId).length).toBe(4);
  });
});
