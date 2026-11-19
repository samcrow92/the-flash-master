/**
 * Mari: the orchestrator got no feedback from GitLab Duo agents and treated them as stale. Duo writes nothing on stdout
 * until it answers (its progress is a log on stderr), so the stall watchdog interrupted Duo agents that were working.
 * Now Duo's log lines and a heartbeat while its process runs count as working, the coordinator can check a specialist
 * (agent_status) and talk to it (message_agent), and agents report where they are with STATUS lines.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DuoAdapter, DuoSession, duoActivity } from "../src/main/harness/duo";
import { MockAdapter } from "../src/main/harness/mock";
import { HarnessRegistry } from "../src/main/harness/registry";
import { Db } from "../src/main/db";
import { Orchestrator } from "../src/main/orchestrator";
import { loadRoles, loadSkills } from "../src/main/roles";
import { DEFAULT_SETTINGS, mergeSettings, type DeepPartial, type Settings } from "../src/shared/settings";
import type { HarnessEvent, SessionOptions } from "../src/main/harness/types";
import type { AppEvent } from "../src/shared/types";

const FAKE_DUO = join(__dirname, "fixtures", "fake-duo.mjs");
const until = async (fn: () => boolean, ms = 15000) => {
  const t = Date.now();
  while (!fn()) { if (Date.now() - t > ms) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 10)); }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const gitlabRepo = () => {
  const d = mkdtempSync(join(tmpdir(), "duo-status-"));
  execFileSync("git", ["init", "-q"], { cwd: d });
  execFileSync("git", ["remote", "add", "origin", "git@gitlab.com:me/lab.git"], { cwd: d });
  return d;
};

class FakeDuo extends DuoAdapter {
  override async start(o: SessionOptions) {
    await super.start(o);
    return new DuoSession(process.execPath, [FAKE_DUO], o);
  }
}

function setup(over: DeepPartial<Settings> = {}) {
  const db = new Db(":memory:");
  const settings = mergeSettings(mergeSettings(DEFAULT_SETTINGS, { general: { defaultHarness: "mock" }, agents: { toolMode: "auto" } } as any), over as any) as Settings;
  const harnesses = new HarnessRegistry([new MockAdapter(15), new FakeDuo()]);
  (harnesses as any).status.set("duo", { id: "duo", available: true, path: process.execPath });
  const events: AppEvent[] = [];
  const orch = new Orchestrator({ db, harnesses, settings: () => settings, roles: () => loadRoles(join(__dirname, "..", "agents"), "/none"),
    skills: () => loadSkills(join(__dirname, "..", "skills", "superpowers")), emit: (e: AppEvent) => events.push(e), mcpServersFor: () => [], homeDir: tmpdir() } as any);
  const project = db.createProject("lab", gitlabRepo());
  const chat = db.createChat({ projectId: project.id, title: "c", kind: "project", agentRole: "flashmaster" });
  return { db, orch, chat, events };
}

const coordReplies = (db: Db, chatId: string) => db.listMessages(chatId, null).filter((m) => m.author === "agent" && m.role === "flashmaster");
async function idleCoordinator(db: Db, orch: Orchestrator, chatId: string): Promise<string> {
  await orch.sendUserMessage(chatId, "Plan the brake light feature", null);
  await until(() => coordReplies(db, chatId)[0]?.status === "done" && db.getAgent(coordReplies(db, chatId)[0]!.agentId!)!.status === "idle");
  return coordReplies(db, chatId)[0]!.agentId!;
}

describe("Duo progress", () => {
  it("reads progress lines from Duo's log, without the debug chatter", () => {
    expect(duoActivity("2026-11-17T10:00:01.000Z [info]: Reading src/a.c")).toBe("Reading src/a.c");
    expect(duoActivity("2026-11-17T10:00:01.000Z [debug]: polling")).toBeNull();
    expect(duoActivity("   ")).toBeNull();
    expect(duoActivity("plain line")).toBe("plain line");
    expect(duoActivity("2026-11-16T15:22:05:714 [info]: [MCP Manager] Disposing service")).toBe("[MCP Manager] Disposing service");
    expect(duoActivity("x".repeat(300))).toHaveLength(200);
  });

  it("a running Duo process sends its log as activity and a heartbeat while it is quiet", async () => {
    const before = DuoSession.heartbeatMs;
    DuoSession.heartbeatMs = 40;
    try {
      const events: HarnessEvent[] = [];
      const s = new DuoSession(process.execPath, [FAKE_DUO], { cwd: tmpdir(), env: {}, extraArgs: "", model: null, onEvent: (e: HarnessEvent) => events.push(e) } as unknown as SessionOptions);
      const turn = s.prompt("QUIET think");
      // Wait for the log lines too: on a slow or busy machine (antivirus on Windows) the process can take longer to
      // start than three heartbeats, and the test used to fail with no activity yet.
      await until(() => events.filter((e) => e.type === "heartbeat").length >= 3 && events.filter((e) => e.type === "activity").length >= 2);
      expect(events.filter((e) => e.type === "activity").map((e) => (e as { text: string }).text)).toEqual(["Workflow source=local (fresh); created 4122303 (flow: chat), capabilities=[none]", "Reading src/brake_light.c"]);
      await s.cancel();
      expect((await turn).stopReason).toBe("cancelled");
      const n = events.length;
      await sleep(150);
      expect(events.length).toBe(n); // no heartbeat once the process is gone
    } finally { DuoSession.heartbeatMs = before; }
  });
});

describe("the coordinator and a Duo specialist", () => {
  let cleanup: (() => Promise<void>) | null = null;
  const before = DuoSession.heartbeatMs;
  afterEach(async () => { DuoSession.heartbeatMs = before; await cleanup?.(); cleanup = null; });

  it("a quiet Duo agent whose process is alive is working, not stale; agent_status says so", async () => {
    DuoSession.heartbeatMs = 40;
    // The watchdog's limit is 60 ms here, so every check below is long past it.
    const { db, orch, chat, events } = setup({ agents: { stuckAfterMinutes: 0.001 } });
    cleanup = () => orch.stopAll();
    const parentId = await idleCoordinator(db, orch, chat.id);
    const r = await orch.delegate(parentId, { role: "tester", goal: "QUIET review the MR", harness: "duo", wait: false });
    await until(() => (orch as any).byAgent.get(r.agentId)?.statusNote && (orch as any).byAgent.get(r.agentId)?.heartbeatAt);
    await sleep(200);
    expect(orch.checkStuck()).toEqual([]);
    await sleep(100);
    expect(orch.checkStuck()).toEqual([]); // twice: no warning, and no recovery
    expect(db.getAgent(r.agentId)!.lastActivity).toMatch(/Working, quiet for \d+ min \(process alive\): last status "reading the brake light sources"/);
    expect(db.listEvents(r.agentId).some((e) => /no output|silent for/.test(e.label))).toBe(false);
    expect(events.some((e) => e.type === "notice" && /has sent nothing/.test(e.text))).toBe(false);

    const st = orch.agentStatus(parentId, r.agentId);
    expect(st).toMatchObject({ harness: "duo", working: true, processAlive: true, statusLine: { text: "reading the brake light sources" } });
    // stdout and stderr are separate pipes, so their lines may arrive in either order.
    expect([...(st.recent as string[])].sort()).toEqual(["Reading src/brake_light.c", "STATUS: reading the brake light sources", "Workflow source=local (fresh); created 4122303 (flow: chat), capabilities=[none]"]);
    expect(st.writingNow).toContain("STATUS: reading");
    expect(st.hint).toMatch(/Quiet is not stuck while processAlive/);
  }, 30000);

  it("message_agent with interrupt stops the Duo run and continues it with the message; the reply comes back to the coordinator", async () => {
    DuoSession.heartbeatMs = 40;
    const { db, orch, chat } = setup();
    cleanup = () => orch.stopAll();
    const parentId = await idleCoordinator(db, orch, chat.id);
    const inputs: string[] = [];
    const turn = (orch as any).turn.bind(orch);
    (orch as any).turn = (t: { input: string }) => { inputs.push(t.input); return turn(t); };
    const r = await orch.delegate(parentId, { role: "tester", goal: "QUIET review the MR", harness: "duo", wait: false });
    await until(() => !!(orch as any).byAgent.get(r.agentId)?.statusNote);
    const sent = await orch.messageAgent(parentId, { agentId: r.agentId, message: "What is your status? Also check the CAN timeout.", interrupt: true });
    expect(sent.delivered).toBe("interrupted");
    // The Duo run is stopped and the same agent continues with the message; its answer wakes the coordinator.
    await until(() => inputs.some((i) => /## Specialist results[\s\S]*\(resumed\) Goal was: .*sends you this message: What is your status\? Also check the CAN timeout\./.test(i)), 20000);
    const all = (db.raw.prepare("SELECT content FROM messages WHERE chat_id=?").all(chat.id) as { content: string }[]).map((m) => m.content).join("\n");
    expect(all).toMatch(/✉️ \*\*.*\*\* → \*\*.*\*\* \(interrupted it\): What is your status/);
    expect(all).toContain("Interrupted by a message from");
  }, 40000);

  it("message_agent queues for a busy agent without native steering, and the follow-up's result reaches the coordinator", async () => {
    const { db, orch, chat } = setup();
    cleanup = () => orch.stopAll();
    const parentId = await idleCoordinator(db, orch, chat.id);
    const inputs: string[] = [];
    const turn = (orch as any).turn.bind(orch);
    (orch as any).turn = (t: { input: string }) => { inputs.push(t.input); return turn(t); };
    const r = await orch.delegate(parentId, { role: "tester", goal: "Check the brake light", wait: false });
    await until(() => db.getAgent(r.agentId)!.status === "running");
    const sent = await orch.messageAgent(parentId, { agentId: r.agentId, message: "Use set A" });
    expect(sent.delivered).toBe("queued");
    // The follow-up turn answers the message, and its result wakes the coordinator again.
    const replies = () => (db.raw.prepare("SELECT id FROM messages WHERE chat_id=? AND role='tester' AND author='agent' ORDER BY seq").all(chat.id) as { id: string }[])
      .map((m) => db.getMessage(m.id)!);
    await until(() => replies().length === 2 && replies()[1]!.status === "done", 20000);
    expect(replies()[1]!.content).toContain("the agent that delegated to you, sends you this message");
    await until(() => inputs.some((i) => /## Specialist results[\s\S]*Mock run for "TheFlashMaster, the agent that delegated/.test(i)), 20000);
  }, 30000);

  it("Duo specialists get Duo's own specialist and reporting guidelines on their first turn; other specialists the general STATUS rule", async () => {
    const duoPrompts: string[] = [];
    const real = DuoSession.prototype.prompt;
    const spy = vi.spyOn(DuoSession.prototype, "prompt").mockImplementation(function (this: DuoSession, text: string, att?: any) {
      duoPrompts.push(text);
      return real.call(this, text, att);
    });
    try {
      const { db, orch, chat } = setup();
      cleanup = () => orch.stopAll();
      const parentId = await idleCoordinator(db, orch, chat.id);
      await orch.delegate(parentId, { role: "tester", goal: "review the MR", harness: "duo", timeoutSec: 20 });
      expect(duoPrompts[0]).toContain("## Reporting back from GitLab Duo");
      expect(duoPrompts[0]).toMatch(/STATUS: <state> \| <what you are doing> \| <next>/);
      expect(duoPrompts[0]).not.toContain("## Keep the delegating agent posted");
      // Duo is told it is a specialist: the delegating agent is the orchestrator, blockers go to it, no delegating unasked.
      expect(duoPrompts[0]).toContain("## You are a specialist, not the orchestrator");
      expect(duoPrompts[0]).toMatch(/never to the user/);
      expect(duoPrompts[0]).toMatch(/Don't plan work for other agents and don't delegate to them, unless the orchestrator asks/);
      const inputs: string[] = [];
      const mockProto = Object.getPrototypeOf((orch as any).byAgent.get(parentId).session);
      const mockReal = mockProto.prompt;
      const mspy = vi.spyOn(mockProto, "prompt").mockImplementation(function (this: unknown, text: unknown, att?: unknown) {
        inputs.push(String(text));
        return mockReal.call(this, text, att);
      });
      await orch.delegate(parentId, { role: "tester", goal: "check the brake light" });
      mspy.mockRestore();
      expect(inputs[0]).toContain("## Keep the delegating agent posted");
      expect(inputs[0]).not.toContain("Reporting back from GitLab Duo");
      expect(inputs[0]).not.toContain("You are a specialist, not the orchestrator");
    } finally { spy.mockRestore(); }
  }, 30000);

  it("a blocked STATUS line shows as blocked in the agent's flow", async () => {
    const { db, orch, chat } = setup();
    cleanup = () => orch.stopAll();
    const parentId = await idleCoordinator(db, orch, chat.id);
    const r = await orch.delegate(parentId, { role: "tester", goal: "Check the brake light", wait: false });
    const l = (orch as any).byAgent.get(r.agentId);
    (orch as any).readStatusLines(l, "STATUS: blocked | no access to the GitLab project | a token with api scope\n");
    expect(db.listEvents(r.agentId).some((e) => e.label.startsWith("status: blocked") && e.status === "blocked")).toBe(true);
    expect(orch.agentStatus(parentId, r.agentId).statusLine).toMatchObject({ text: "blocked | no access to the GitLab project | a token with api scope" });
  }, 30000);

  it("message_agent to an idle agent starts a follow-up; only the agent that started it may message it", async () => {
    const { db, orch, chat } = setup();
    cleanup = () => orch.stopAll();
    const parentId = await idleCoordinator(db, orch, chat.id);
    const r = await orch.delegate(parentId, { role: "tester", goal: "Check the brake light" });
    await until(() => db.getAgent(r.agentId)!.status !== "running");
    expect(orch.agentStatus(parentId, r.agentId)).toMatchObject({ working: false, result: expect.stringContaining("Mock run") });
    const f = await orch.messageAgent(parentId, { agentId: r.agentId, message: "Now the CAN timeout", wait: true });
    expect(f).toMatchObject({ delivered: "started", agentId: r.agentId });
    expect(String(f.result)).toContain("Mock run for");
    await expect(orch.messageAgent(r.agentId, { agentId: parentId, message: "hi" })).rejects.toThrow(/only message agents you started/);
    expect(() => orch.agentStatus(parentId, "nope")).toThrow(/unknown agentId/);
  }, 30000);
});
