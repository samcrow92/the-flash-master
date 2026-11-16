import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadRoles } from "../src/main/roles";
import { Db } from "../src/main/db";
import { Orchestrator } from "../src/main/orchestrator";
import { HarnessRegistry } from "../src/main/harness/registry";
import { MockAdapter } from "../src/main/harness/mock";
import { DEFAULT_SETTINGS, mergeSettings, type Settings } from "../src/shared/settings";
import type { AppEvent, Message, ToolRun } from "../src/shared/types";

const AGENTS = join(__dirname, "..", "agents");
const until = async (fn: () => boolean, ms = 6000) => {
  const t = Date.now();
  while (!fn()) { if (Date.now() - t > ms) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 10)); }
};

function setup(extra: Partial<Settings["agents"]> = {}) {
  const db = new Db(":memory:");
  const settings = mergeSettings(DEFAULT_SETTINGS, { general: { defaultHarness: "mock" }, agents: extra }) as Settings;
  const events: AppEvent[] = [];
  const prompts: string[] = [];
  const adapter = new MockAdapter(1);
  const start = adapter.start.bind(adapter);
  // Record every prompt the agent receives, to check what it was told after the stop.
  adapter.start = async (o) => { const s = await start(o); const p = s.prompt.bind(s); s.prompt = (text, a) => { prompts.push(text); return p(text, a); }; return s; };
  const orch = new Orchestrator({ db, harnesses: new HarnessRegistry([adapter]), settings: () => settings, roles: () => loadRoles(AGENTS, "/none"),
    skills: () => [], emit: (e) => events.push(e), mcpServersFor: () => [], homeDir: tmpdir() });
  return { db, orch, events, prompts };
}

const hungCall = (db: Db, chatId: string): { msg: Message; run: ToolRun } | null => {
  for (const msg of db.listMessages(chatId, null)) {
    const run = msg.tools?.find((r) => r.title === "Waiting for the build server");
    if (run && msg.status === "streaming" && run.status === "in_progress") return { msg, run };
  }
  return null;
};

describe("stopping a hung tool call", () => {
  it("stops only that call: the agent keeps its session, is told why, and continues", async () => {
    const { db, orch, prompts } = setup();
    const a = await orch.startAgent(null, "tester", "Flash the ECU [hang]");
    const chatId = db.getAgent(a.id)!.chatId!;
    await until(() => !!hungCall(db, chatId));
    const { msg, run } = hungCall(db, chatId)!;
    const before = prompts.length;
    await orch.stopToolCall(msg.id, run.id);
    // The next turn runs in the same session (no restart) with the news, and the agent finishes normally.
    await until(() => db.getAgent(a.id)!.status === "idle" && prompts.length > before);
    const stopped = db.listMessages(chatId, null).find((m) => m.id === msg.id)!;
    const row = stopped.tools!.find((r) => r.id === run.id)!;
    expect(row.status).toBe("failed");
    expect(row.stopped).toBe("Stopped by you");
    expect(stopped.content).toMatch(/Stopped the hung tool call \*\*Waiting for the build server\*\*/);
    const told = prompts[before]!;
    expect(told).toMatch(/^The user stopped your tool call "Waiting for the build server" \(make flash --wait\)/);
    expect(told).not.toMatch(/interrupted you with new direction/);
    expect(db.listEvents(a.id).some((e) => e.label.startsWith("stopped by you: Waiting for the build server"))).toBe(true);
    expect(db.listEvents(a.id).some((e) => /restarting/.test(e.label))).toBe(false);
    await orch.stop(a.id);
  });

  it("refuses a reply that has already finished", async () => {
    const { db, orch } = setup();
    const a = await orch.startAgent(null, "tester", "Quick answer");
    await until(() => db.getAgent(a.id)!.status === "idle");
    const reply = db.listMessages(db.getAgent(a.id)!.chatId!, null).find((m) => m.author === "agent")!;
    await expect(orch.stopToolCall(reply.id, reply.tools![0]!.id)).rejects.toThrow(/finished/);
    await orch.stop(a.id);
  });

  it("restarts and resumes an agent that keeps waiting after the cancel", async () => {
    const { db, orch, prompts } = setup();
    orch.toolStopGraceMs = 50;
    const a = await orch.startAgent(null, "tester", "Flash the ECU [hang-hard]");
    const chatId = db.getAgent(a.id)!.chatId!;
    await until(() => !!hungCall(db, chatId));
    const { msg, run } = hungCall(db, chatId)!;
    const before = prompts.length;
    await orch.stopToolCall(msg.id, run.id);
    await until(() => db.getAgent(a.id)!.status === "idle");
    expect(db.listEvents(a.id).some((e) => e.label === "agent kept waiting — restarting it")).toBe(true);
    // The restarted agent is told about the stop, not that it crashed, and no crash notice is posted.
    expect(prompts.slice(before).join("\n")).toMatch(/The user stopped your tool call "Waiting for the build server"/);
    expect(prompts.slice(before).join("\n")).not.toMatch(/exited|crash/i);
    const all = db.listMessages(chatId, null);
    expect(all.some((m) => m.author === "system" && /exited unexpectedly/.test(m.content))).toBe(false);
    expect(all.find((m) => m.id === msg.id)!.content).toMatch(/Stopped the hung tool call \*\*Waiting for the build server\*\* and restarted/);
    await orch.stop(a.id);
  });

  it("tool call timeout: stops a call that runs too long, off when 0", async () => {
    const off = setup();
    const b = await off.orch.startAgent(null, "tester", "Flash the ECU [hang]");
    await until(() => !!hungCall(off.db, off.db.getAgent(b.id)!.chatId!));
    expect(off.orch.checkToolTimeouts(Date.now() + 120 * 60_000)).toEqual([]);
    await off.orch.stop(b.id);

    const { db, orch, prompts } = setup({ toolTimeoutMinutes: 5 });
    const a = await orch.startAgent(null, "tester", "Flash the ECU [hang]");
    const chatId = db.getAgent(a.id)!.chatId!;
    await until(() => !!hungCall(db, chatId));
    const { msg, run } = hungCall(db, chatId)!;
    expect(orch.checkToolTimeouts(Date.now() + 60_000)).toEqual([]); // not yet
    expect(orch.checkToolTimeouts(Date.now() + 6 * 60_000)).toEqual([run.id]);
    await until(() => db.getAgent(a.id)!.status === "idle");
    const row = db.listMessages(chatId, null).find((m) => m.id === msg.id)!.tools!.find((r) => r.id === run.id)!;
    expect(row.stopped).toBe("Stopped after 6 min (tool call timeout)");
    expect(prompts.join("\n")).toMatch(/ran for 6 min without finishing, so TheFlashMaster stopped it \(tool call timeout\)/);
    await orch.stop(a.id);
  });
});
