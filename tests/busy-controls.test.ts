/**
 * Stop, Steer and Queue while an agent is working, on every harness kind: ACP (Copilot, OpenCode, Cursor, Claude Code
 * share one client), Pi RPC, GitLab Duo (headless) and the mock. Pi runs with --linger, so it refuses a prompt for a
 * moment after agent_end like the real CLI ("Agent is already processing. Specify streamingBehavior…").
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AcpAdapter } from "../src/main/harness/acp";
import { PiAdapter, PiSession, STEER_FOLLOW_UP } from "../src/main/harness/pi";
import { DuoAdapter, DuoSession } from "../src/main/harness/duo";
import { MockAdapter } from "../src/main/harness/mock";
import { HarnessRegistry } from "../src/main/harness/registry";
import { Db } from "../src/main/db";
import { Orchestrator } from "../src/main/orchestrator";
import { loadRoles, loadSkills } from "../src/main/roles";
import { DEFAULT_SETTINGS, mergeSettings, type Settings } from "../src/shared/settings";
import type { AppEvent, HarnessId } from "../src/shared/types";
import type { HarnessEvent, SessionOptions } from "../src/main/harness/types";

const FAKE_ACP = join(__dirname, "fixtures", "fake-acp-agent.mjs");
const FAKE_PI = join(__dirname, "fixtures", "fake-pi.mjs");
const FAKE_DUO = join(__dirname, "fixtures", "fake-duo.mjs");
const until = async (fn: () => boolean, ms = 10000) => {
  const t = Date.now();
  while (!fn()) { if (Date.now() - t > ms) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 10)); }
};

class FakePi extends PiAdapter {
  override async start(o: SessionOptions) {
    const s = new PiSession(process.execPath, [FAKE_PI, "--mode", "rpc", "--linger", "200"], o);
    await s.init();
    return s;
  }
}
class FakeDuo extends DuoAdapter {
  override async start(o: SessionOptions) { return new DuoSession(process.execPath, [FAKE_DUO], o); }
}

function setup(harness: HarnessId) {
  const db = new Db(":memory:");
  const settings = mergeSettings(DEFAULT_SETTINGS, { general: { defaultHarness: "mock" }, agents: { toolMode: "auto" } } as any) as Settings;
  const harnesses = new HarnessRegistry([new MockAdapter(15), new AcpAdapter("opencode", "Fake ACP", [process.execPath], [FAKE_ACP], ""), new FakePi(), new FakeDuo()]);
  for (const id of ["opencode", "pi", "duo"]) (harnesses as any).status.set(id, { id, available: true, path: process.execPath });
  const events: AppEvent[] = [];
  const orch = new Orchestrator({ db, harnesses, settings: () => settings, roles: () => loadRoles(join(__dirname, "..", "agents"), "/none"),
    skills: () => loadSkills(join(__dirname, "..", "skills", "superpowers")), emit: (e) => events.push(e), mcpServersFor: () => [], homeDir: tmpdir() });
  const p = db.createProject("p", mkdtempSync(join(tmpdir(), "proj-")));
  const chat = db.createChat({ projectId: p.id, title: "c", kind: "project", agentRole: "flashmaster" });
  db.updateChat(chat.id, { harness });
  const replies = () => db.listMessages(chat.id, null).filter((m) => m.author === "agent");
  const settled = () => replies().length > 0 && replies().every((m) => m.status !== "streaming") && !db.listAgents().some((a) => a.status === "running");
  const startSlow = async () => {
    await orch.sendUserMessage(chat.id, "SLOW long analysis", null);
    await until(() => events.some((e) => e.type === "message.delta"));
  };
  return { db, orch, chat, events, replies, settled, startSlow };
}

const HARNESSES: HarnessId[] = ["opencode", "pi", "duo", "mock"];

describe.each(HARNESSES)("busy controls on %s", (harness) => {
  it("Stop ends the running turn", async () => {
    const { db, orch, replies, startSlow } = setup(harness);
    await startSlow();
    const agent = db.listAgents().find((a) => a.status === "running")!;
    expect(agent).toBeTruthy();
    await orch.stop(agent.id);
    await until(() => db.getAgent(agent.id)!.status === "stopped" && replies().every((m) => m.status !== "streaming"));
    await orch.stopAll();
  }, 20000);

  it("Steer is delivered and answered", async () => {
    const { db, orch, chat, replies, settled, startSlow } = setup(harness);
    await startSlow();
    const m = await orch.sendUserMessage(chat.id, "focus on the brake ECU only", null, { whileBusy: "steer" });
    expect(m.steer).toBe(true);
    await until(() => db.getMessage(m.id)!.delivery === "seen" && settled());
    for (const r of replies()) { expect(r.status).toBe("done"); expect(r.content).not.toContain("⚠️"); }
    await orch.stopAll();
  }, 20000);

  it("Queue waits for the turn, then runs", async () => {
    const { db, orch, chat, replies, settled, startSlow } = setup(harness);
    await startSlow();
    const q = await orch.sendUserMessage(chat.id, "and then summarise", null, { whileBusy: "queue" });
    expect(q.delivery).toBe("queued");
    await until(() => db.getMessage(q.id)!.delivery === "seen" && replies().length >= 2 && settled());
    for (const r of replies()) { expect(r.status).toBe("done"); expect(r.content).not.toContain("⚠️"); }
    await orch.stopAll();
  }, 20000);
});

describe("Pi turn bookkeeping", () => {
  const opts = (events: HarnessEvent[]) => ({ cwd: process.cwd(), model: null, extraArgs: "", executable: null, mcpServers: [], env: {}, resumeSessionId: null,
    policy: { approval: "auto-all", readOnly: false, blocked: [], projectRoot: null }, onEvent: (e: HarnessEvent) => events.push(e), askPermission: async () => true } as SessionOptions);

  it("a quick reply that arrives in one chunk with the prompt's response still ends the turn", async () => {
    const s = new PiSession(process.execPath, [FAKE_PI, "--mode", "rpc"], opts([]));
    await s.init();
    const r = await Promise.race([s.prompt("QUICK hi"), new Promise<null>((ok) => setTimeout(() => ok(null), 3000))]);
    expect(r).toMatchObject({ stopReason: "end_turn", usage: { tokensIn: 250, tokensOut: 40 } });
    s.close();
  });

  it("a steering message Pi took just as the run ended is answered in a follow-up run of the same turn", async () => {
    const events: HarnessEvent[] = [];
    const s = new PiSession(process.execPath, [FAKE_PI, "--mode", "rpc", "--linger", "100"], opts(events));
    await s.init();
    const p = s.prompt("SLOW LATESTEER");
    await new Promise((r) => setTimeout(r, 150));
    expect(await s.steer("use the CAN log")).toBe(true);
    const r = await p;
    expect(r.stopReason).toBe("end_turn");
    expect(events.map((e: any) => e.text ?? "").join("")).toContain("[steered: use the CAN log]");
    expect(events.filter((e) => e.type === "steer_ack")).toHaveLength(1);
    expect(STEER_FOLLOW_UP).toMatch(/message above/);
    s.close();
  });

  it("a quick Pi reply leaves the chat free: the next message is answered, Stop still works", async () => {
    const { db, orch, chat, replies, settled } = setup("pi");
    await orch.sendUserMessage(chat.id, "QUICK hi", null);
    await until(() => settled());
    await orch.sendUserMessage(chat.id, "QUICK again", null);
    await until(() => replies().length === 2 && settled());
    expect(replies().map((m) => m.status)).toEqual(["done", "done"]);
    await orch.sendUserMessage(chat.id, "SLOW third", null);
    await until(() => db.listAgents().some((a) => a.status === "running"));
    const agent = db.listAgents().find((a) => a.status === "running")!;
    await orch.stop(agent.id);
    await until(() => db.getAgent(agent.id)!.status === "stopped" && replies().every((m) => m.status !== "streaming"));
    await orch.stopAll();
  }, 20000);
});
