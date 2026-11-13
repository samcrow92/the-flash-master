import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { loadRoles, loadSkills, validateRole } from "../src/main/roles";
import { Db } from "../src/main/db";
import { Orchestrator } from "../src/main/orchestrator";
import { HarnessRegistry } from "../src/main/harness/registry";
import { MockAdapter } from "../src/main/harness/mock";
import { Bridge } from "../src/main/bridge";
import { buildTools } from "../src/main/tools";
import { createForwarder } from "../mcp-servers/common/stdio-forwarder";
import { DEFAULT_SETTINGS, mergeSettings, type Settings } from "../src/shared/settings";
import type { AppEvent } from "../src/shared/types";

const AGENTS = join(__dirname, "..", "agents");
const TOOLS = ["flashmaster-core", "jazz", "office", "vector-autosar", "winidea", "exam"];
const until = async (fn: () => boolean, ms = 6000) => {
  const t = Date.now();
  while (!fn()) { if (Date.now() - t > ms) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 10)); }
};

describe("new specialists", () => {
  it("ships the presentation expert and the NOW/Ishikawa analyst; the template is not loaded as an agent", () => {
    const roles = loadRoles(AGENTS, "/none");
    const byName = Object.fromEntries(roles.map((r) => [r.name, r]));
    expect(byName["presentation-expert"]!.tools).toEqual(["flashmaster-core", "office"]);
    expect(byName["rca-analyst"]!.tools).toContain("office");
    expect(byName["rca-analyst"]!.prompt).toMatch(/NOW format/);
    expect(byName["rca-analyst"]!.prompt).toMatch(/INCOSE/);
    expect(byName["rca-analyst"]!.prompt).toContain("```ishikawa");
    expect(roles.some((r) => r.name === "my-agent")).toBe(false);
  });
});

describe("agent import validation", () => {
  const builtin = loadRoles(AGENTS, "/none").map((r) => r.name);
  const skills = loadSkills(join(__dirname, "..", "skills", "superpowers")).map((s) => s.command);

  it("accepts the shipped template (with warnings to customise it)", () => {
    const v = validateRole(readFileSync(join(AGENTS, "_template.md"), "utf8"), TOOLS, builtin, skills);
    expect(v.ok).toBe(true);
    expect(v.role!.name).toBe("my-agent");
    expect(v.warnings.join(" ")).toMatch(/template default/);
    expect(v.warnings.join(" ")).toMatch(/placeholder/);
  });

  it("validates a user agent written by an LLM", () => {
    const src = `---\nname: safety-analyst\ntitle: Functional Safety Analyst\nicon: 🛡️\ndescription: ISO 26262 HARA and FMEA.\ntools: [flashmaster-core, custom-fmea]\nmaxResultTokens: 500\nskills: [plan, nope]\n---\nYou perform ISO 26262 hazard analysis and FMEA on the given item.`;
    const v = validateRole(src, TOOLS, builtin, skills);
    expect(v.ok).toBe(true);
    expect(v.role).toMatchObject({ name: "safety-analyst", icon: "🛡️", skills: ["plan", "nope"], source: "user" });
    expect(v.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/custom-fmea/), expect.stringMatching(/Skill "nope"/)]));
  });

  it("rejects broken files with clear errors and flags overrides", () => {
    expect(validateRole("just text", TOOLS, builtin).errors[0]).toMatch(/header/);
    const bad = validateRole("---\nname: Bad Name\nmaxResultTokens: 9\nharness: gpt\n---\nshort", TOOLS, builtin);
    expect(bad.ok).toBe(false);
    expect(bad.errors.join("\n")).toMatch(/name.*lowercase/);
    expect(bad.errors.join("\n")).toMatch(/title/);
    expect(bad.errors.join("\n")).toMatch(/too short/);
    expect(bad.errors.join("\n")).toMatch(/maxResultTokens/);
    expect(bad.errors.join("\n")).toMatch(/harness/);
    const override = validateRole("---\nname: reviewer\ntitle: Strict Reviewer\n---\nReview everything with MISRA C:2023 in mind.", TOOLS, builtin);
    expect(override.ok).toBe(true);
    expect(override.warnings.join(" ")).toMatch(/Overrides the built-in/);
  });
});

function setup() {
  const db = new Db(":memory:");
  const settings = mergeSettings(DEFAULT_SETTINGS, { general: { defaultHarness: "mock" } }) as Settings;
  const roles = loadRoles(AGENTS, "/none");
  const events: AppEvent[] = [];
  const orch = new Orchestrator({ db, harnesses: new HarnessRegistry([new MockAdapter(1)]), settings: () => settings, roles: () => roles,
    skills: () => loadSkills(join(__dirname, "..", "skills", "superpowers")), emit: (e) => events.push(e), mcpServersFor: () => [], homeDir: tmpdir() });
  const p = db.createProject("p", mkdtempSync(join(tmpdir(), "flow-")));
  const chat = db.createChat({ projectId: p.id, title: "c", kind: "project", agentRole: "flashmaster" });
  return { db, orch, events, chat, roles };
}

describe("progress flow", () => {
  it("records plan, tool, turn and result events and keeps the plan on the agent", async () => {
    const { db, orch, events, chat } = setup();
    await orch.sendUserMessage(chat.id, "Build the deck", null);
    await until(() => db.listMessages(chat.id, null).some((m) => m.author === "agent" && m.status === "done"));
    const a = db.listAgents({})[0]!;
    expect(a.plan.map((p) => p.status)).toEqual(["completed", "completed", "completed", "completed"]);
    const kinds = db.listEvents(a.id).map((e) => e.kind);
    expect(kinds[0]).toBe("turn");
    expect(kinds).toContain("tool");
    expect(kinds[kinds.length - 1]).toBe("result");
    expect(db.listEvents(a.id).at(-1)!.label).toMatch(/Mock run/);
    expect(events.some((e) => e.type === "flow.updated" && e.agentId === a.id)).toBe(true);
    await orch.stopAll();
  });

  it("collapses repeated tool updates and links delegations to child agents; report_progress sets the plan", async () => {
    const { db, orch, chat, roles } = setup();
    db.addEvent({ agentId: "x", kind: "tool", label: "Read a.c", status: "pending" });
    db.addEvent({ agentId: "x", kind: "tool", label: "Read a.c", status: "completed" });
    expect(db.listEvents("x")).toMatchObject([{ label: "Read a.c", status: "completed" }]);

    await orch.sendUserMessage(chat.id, "coordinate", null);
    await until(() => db.listMessages(chat.id, null).some((m) => m.author === "agent" && m.status === "done"));
    const parent = db.listAgents({})[0]!;
    const bridge = new Bridge();
    bridge.register(buildTools({ db, orch, roles: () => roles, jazz: () => null, emitTask: () => {} }));
    const port = await bridge.start();
    const call = createForwarder("core", "flashmaster-core", { url: `http://127.0.0.1:${port}`, token: bridge.token, agentId: parent.id });
    try {
      await call({ method: "tools/call", params: { name: "report_progress", arguments: { steps: [{ title: "Outline", status: "completed" }, { title: "Slides", status: "in_progress" }] } } });
      expect(db.getAgent(parent.id)!.plan).toEqual([{ title: "Outline", status: "completed" }, { title: "Slides", status: "in_progress" }]);
      expect(db.getAgent(parent.id)!.lastActivity).toBe("Step 2/2: Slides");
      const r: any = await call({ method: "tools/call", params: { name: "delegate", arguments: { role: "presentation-expert", goal: "Make 5 slides" } } });
      const child = JSON.parse(r.content[0].text).agentId;
      const del = db.listEvents(parent.id).find((e) => e.kind === "delegate")!;
      expect(del).toMatchObject({ ref: child });
      expect(del.label).toMatch(/Presentation Expert: Make 5 slides/);
      expect(db.childAgents(parent.id).map((c) => c.id)).toEqual([child]);
    } finally {
      bridge.stop();
      await orch.stopAll();
    }
  });
});

describe("resume after restart", () => {
  it("resumes an interrupted specialist with its brief, specialists before the coordinator", async () => {
    const { db, orch, events, chat } = setup();
    const lead = db.createAgent({ projectId: chat.projectId, chatId: chat.id, role: "flashmaster", harness: "mock", model: null, brief: "Chat: c" });
    const kid = db.createAgent({ projectId: chat.projectId, chatId: chat.id, role: "tester", harness: "mock", model: null, parentAgentId: lead.id,
      brief: "Goal: run the brake suite" });
    db.updateAgent(lead.id, { status: "running" });
    db.updateAgent(kid.id, { status: "paused" });
    const interrupted = db.interruptOrphans(); // what the app does at start
    orch.announceInterrupted(interrupted);
    expect(db.listMessages(chat.id, null).some((m) => m.author === "system" && /app closed while/.test(m.content))).toBe(true);

    expect(orch.resumeAllInterrupted()).toBe(2);
    expect(db.listInterrupted()).toEqual([]);
    const resumed = events.filter((e) => e.type === "agent.updated" && e.agent.lastActivity?.startsWith("Resuming")).map((e) => (e as any).agent.id);
    expect(resumed).toEqual([kid.id, lead.id]); // deepest first
    // Both ran a fresh turn (back to idle, waiting for input) and the specialist kept its result for get_result.
    await until(() => [kid.id, lead.id].every((id) => db.getAgent(id)!.status === "idle" && !!db.getAgent(id)!.resultSummary));
    expect(db.getAgent(kid.id)!.endedAt).toBeNull();
    expect(() => orch.resumeInterrupted(kid.id)).toThrow(/isn't waiting/);
  });
});

describe("result status routing", () => {
  it("shows a specialist's question to the user and marks its task blocked", async () => {
    const { db, orch, events } = setup();
    const task = db.createTask({ title: "Calibrate", projectId: null });
    const a = await orch.startAgent(null, "tester", "Calibrate the brake model [needs-decision]", task.id);
    await until(() => db.getAgent(a.id)!.status === "idle" && !!db.getAgent(a.id)!.resultSummary);
    expect(db.getAgent(a.id)!.lastActivity).toMatch(/^Needs your decision: Use calibration set A or B/);
    expect(db.getAgent(a.id)!.resultSummary).toMatch(/^status: needs_decision\nquestion: /);
    expect(events.some((e) => e.type === "notice" && e.level === "warn" && /needs your decision/.test(e.text))).toBe(true);
    expect(db.listTasks({}).find((t) => t.id === task.id)!.status).toBe("blocked");
  });
});

describe("stuck-agent watchdog", () => {
  it("warns once about a silent working agent, and clears when output resumes", async () => {
    const db = new Db(":memory:");
    let settings = mergeSettings(DEFAULT_SETTINGS, { general: { defaultHarness: "mock" } }) as Settings;
    const events: AppEvent[] = [];
    const orch = new Orchestrator({ db, harnesses: new HarnessRegistry([new MockAdapter(25)]), settings: () => settings, roles: () => loadRoles(AGENTS, "/none"),
      skills: () => [], emit: (e) => events.push(e), mcpServersFor: () => [], homeDir: tmpdir() });
    const a = await orch.startAgent(null, "tester", "Run the suite");
    await until(() => db.getAgent(a.id)!.status === "running" && db.listMessages(db.getAgent(a.id)!.chatId!, null).some((m) => m.author === "agent"));
    const later = Date.now() + 11 * 60_000;
    expect(orch.checkStuck(later)).toEqual([a.id]);
    expect(orch.checkStuck(later)).toEqual([]); // one warning per silence
    const chatId = db.getAgent(a.id)!.chatId!;
    expect(db.listMessages(chatId, null).some((m) => m.author === "system" && /has sent nothing for 11 min/.test(m.content))).toBe(true);
    await until(() => db.listEvents(a.id).some((e) => e.label === "output resumed"));
    settings = mergeSettings(settings, { agents: { stuckAfterMinutes: 0 } }) as Settings;
    expect(orch.checkStuck(Date.now() + 60 * 60_000)).toEqual([]);
    await orch.stop(a.id);
  });
});
