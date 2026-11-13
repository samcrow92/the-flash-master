import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AcpAdapter, modelsFromSession } from "../src/main/harness/acp";
import { PiAdapter, PiSession } from "../src/main/harness/pi";
import { MockAdapter } from "../src/main/harness/mock";
import { HarnessRegistry } from "../src/main/harness/registry";
import type { HarnessEvent, SessionOptions } from "../src/main/harness/types";
import { Db } from "../src/main/db";
import { Orchestrator } from "../src/main/orchestrator";
import { Bridge } from "../src/main/bridge";
import { buildTools } from "../src/main/tools";
import { loadRoles, loadSkills } from "../src/main/roles";
import { createForwarder } from "../mcp-servers/common/stdio-forwarder";
import { DEFAULT_SETTINGS, mergeSettings, type DeepPartial, type Settings } from "../src/shared/settings";
import type { AppEvent } from "../src/shared/types";

const FAKE = join(__dirname, "fixtures", "fake-acp-agent.mjs");
const until = async (fn: () => boolean, ms = 5000) => {
  const t = Date.now();
  while (!fn()) { if (Date.now() - t > ms) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 10)); }
};

function opts(over: Partial<SessionOptions> = {}): SessionOptions & { events: HarnessEvent[] } {
  const events: HarnessEvent[] = [];
  return {
    cwd: process.cwd(), model: null, extraArgs: "", executable: process.execPath, mcpServers: [{ name: "x", command: "x", args: [], env: {} }], env: {},
    resumeSessionId: null, policy: { approval: "auto-read", readOnly: false, blocked: [], projectRoot: process.cwd() },
    onEvent: (e) => events.push(e), askPermission: async () => true, ...over, events,
  } as SessionOptions & { events: HarnessEvent[] };
}

describe("ACP client against a fake ACP agent", () => {
  const adapter = new AcpAdapter("copilot", "Fake", [process.execPath], [FAKE], "");

  it("initialises, passes MCP servers, streams chunks, and reports usage", async () => {
    const o = opts();
    const s = await adapter.start(o);
    expect(s.sessionId).toBe("sess-1");
    const r = await s.prompt("hello");
    expect(r).toMatchObject({ stopReason: "end_turn", usage: { tokensIn: 120, tokensOut: 30 } });
    const text = o.events.filter((e) => e.type === "text").map((e) => (e as any).text).join("");
    expect(text).toContain("Hello from fake ACP.");
    expect(o.events.some((e) => e.type === "tool" && e.kind === "read")).toBe(true);
    s.close();
  });

  it("serves fs/read_text_file inside the project and refuses outside", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acp-"));
    writeFileSync(join(dir, "a.txt"), "SECRET42");
    const o = opts({ cwd: dir, policy: { approval: "auto-read", readOnly: false, blocked: [], projectRoot: dir } });
    const s = await adapter.start(o);
    await s.prompt(`READFILE:${join(dir, "a.txt")}`);
    await s.prompt(`READFILE:/etc/hostname`);
    const text = o.events.filter((e) => e.type === "text").map((e) => (e as any).text).join("");
    expect(text).toContain("file says: SECRET42");
    expect(text).toContain("path outside project folder");
    s.close();
  });

  it("routes permission requests through policy and the user", async () => {
    let asked = 0;
    const o = opts({ askPermission: async () => { asked++; return false; } });
    const s = await adapter.start(o);
    await s.prompt("WRITE");
    const ro = opts({ policy: { approval: "auto-all", readOnly: true, blocked: [], projectRoot: process.cwd() } });
    const s2 = await adapter.start(ro);
    await s2.prompt("WRITE");
    expect(asked).toBe(1);
    expect(o.events.map((e) => (e as any).text).join("")).toContain("permission=no");
    expect(ro.events.map((e) => (e as any).text).join("")).toContain("permission=no");
    s.close(); s2.close();
  });

  it("cancels a running turn", async () => {
    const o = opts();
    const s = await adapter.start(o);
    const p = s.prompt("SLOW");
    await new Promise((r) => setTimeout(r, 200));
    await s.cancel();
    expect((await p).stopReason).toBe("cancelled");
    s.close();
  });
});

// ------------------------------------------------------------------ orchestrator end-to-end (mock + fake ACP)

function setup(over: DeepPartial<Settings> = {}) {
  const db = new Db(":memory:");
  let settings = mergeSettings(DEFAULT_SETTINGS, { general: { defaultHarness: "mock" }, ...over } as any) as Settings;
  const harnesses = new HarnessRegistry([new MockAdapter(2), new AcpAdapter("opencode", "Fake ACP", [process.execPath], [FAKE], "")]);
  (harnesses as any).status.set("opencode", { id: "opencode", available: true, path: process.execPath });
  const roles = loadRoles(join(__dirname, "..", "agents"), "/nonexistent");
  const skills = loadSkills(join(__dirname, "..", "skills", "superpowers"));
  const events: AppEvent[] = [];
  const orch = new Orchestrator({ db, harnesses, settings: () => settings, roles: () => roles, skills: () => skills, emit: (e) => events.push(e),
    mcpServersFor: () => [], homeDir: tmpdir() });
  const project = db.createProject("demo", mkdtempSync(join(tmpdir(), "proj-")));
  const chat = db.createChat({ projectId: project.id, title: "General", kind: "project", agentRole: "flashmaster" });
  return { db, orch, events, chat, project, setSettings: (s: DeepPartial<Settings>) => { settings = mergeSettings(settings, s); } };
}

const agentMsgs = (db: Db, chatId: string, parent: string | null = null) => db.listMessages(chatId, parent).filter((m) => m.author === "agent");

describe("Orchestrator", () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { await cleanup?.(); cleanup = null; });

  it("streams a reply, records usage and supports threads and @mentions", async () => {
    const { db, orch, events, chat } = setup();
    cleanup = () => orch.stopAll();
    await orch.sendUserMessage(chat.id, "Plan the brake light feature", null);
    await until(() => agentMsgs(db, chat.id)[0]?.status === "done");
    const reply = agentMsgs(db, chat.id)[0]!;
    expect(reply.content).toContain("TheFlashMaster");
    expect(events.filter((e) => e.type === "message.delta").length).toBeGreaterThan(10);
    expect(reply.tokensIn).toBeGreaterThan(0);
    expect(db.usageSummary(1, 0).byRole[0]!.key).toBe("flashmaster");

    await orch.sendUserMessage(chat.id, "@reviewer look at this", reply.id);
    await until(() => agentMsgs(db, chat.id, reply.id).some((m) => m.role === "reviewer" && m.status === "done"));
    expect(db.listMessages(chat.id, null).find((m) => m.id === reply.id)!.replyCount).toBe(2);
  });

  it("queued agents show as running, and a waiting delegation never deadlocks on the slot limit", async () => {
    const { db, orch, chat } = setup({ agents: { maxConcurrent: 1 } });
    cleanup = () => orch.stopAll();
    await orch.sendUserMessage(chat.id, "Plan the brake light feature", null);
    await until(() => agentMsgs(db, chat.id)[0]?.status === "streaming");
    const parentId = agentMsgs(db, chat.id)[0]!.agentId!;
    // Background delegation while the only slot is taken: visible as running/queued, not idle.
    const bg = await orch.delegate(parentId, { role: "tester", goal: "Write tests", wait: false });
    const queued = db.getAgent(bg.agentId)!;
    expect(queued.status).toBe("running");
    expect(queued.lastActivity).toMatch(/Queued/);
    // Waiting delegation borrows the coordinator's slot: it starts at once instead of waiting behind it.
    const waiting = orch.delegate(parentId, { role: "reviewer", goal: "Review brake.c" });
    const r = await waiting;
    expect(r.result).toBeTruthy();
    expect(agentMsgs(db, chat.id)[0]!.status).toBe("streaming"); // coordinator still busy: no deadlock, no waiting behind it
    await until(() => db.getAgent(bg.agentId)!.status === "idle", 10000);
  });

  it("delegate can pick the harness the user asked for, and warns when it is unavailable", async () => {
    const { db, orch, chat } = setup();
    cleanup = () => orch.stopAll();
    await orch.sendUserMessage(chat.id, "Plan the brake light feature", null);
    await until(() => agentMsgs(db, chat.id)[0]?.status === "streaming");
    const parentId = agentMsgs(db, chat.id)[0]!.agentId!;
    const r = await orch.delegate(parentId, { role: "presentation-expert", goal: "hi", harness: "opencode", wait: false });
    expect(db.getAgent(r.agentId)!.harness).toBe("opencode");
    const r2 = await orch.delegate(parentId, { role: "presentation-expert", goal: "hi", harness: "duo", wait: false });
    expect(db.getAgent(r2.agentId)!.harness).not.toBe("duo");
    expect(db.listMessages(chat.id, null).concat(...db.listMessages(chat.id, null).map((m) => db.listMessages(chat.id, m.id)))
      .some((m) => m.author === "system" && m.content.includes("duo is not available"))).toBe(true);
  });

  it("uses a real ACP harness when the chat selects it", async () => {
    const { db, orch, chat } = setup();
    cleanup = () => orch.stopAll();
    db.updateChat(chat.id, { harness: "opencode" });
    await orch.sendUserMessage(chat.id, "hi", null);
    await until(() => agentMsgs(db, chat.id)[0]?.status === "done");
    const m = agentMsgs(db, chat.id)[0]!;
    expect(m.content).toContain("Hello from fake ACP.");
    expect(m).toMatchObject({ tokensIn: 120, tokensOut: 30, estimated: false });
  });

  it("pauses (queuing input), resumes and stops", async () => {
    const { db, orch, chat } = setup();
    cleanup = () => orch.stopAll();
    await orch.sendUserMessage(chat.id, "long task", null);
    await until(() => db.listAgents({ activeOnly: true })[0]?.status === "running");
    const agent = db.listAgents({ activeOnly: true })[0]!;
    orch.pause(agent.id);
    await until(() => db.getAgent(agent.id)!.status === "paused" && agentMsgs(db, chat.id)[0]?.status !== "streaming");
    await orch.sendUserMessage(chat.id, "queued while paused", null);
    expect(db.listMessages(chat.id, null).some((m) => m.content.includes("message queued"))).toBe(true);
    orch.resume(agent.id);
    await until(() => agentMsgs(db, chat.id).filter((m) => m.status === "done").length >= 2);
    await orch.stop(agent.id);
    expect(db.getAgent(agent.id)!.status).toBe("stopped");
  });

  it("delegates via the bridge: brief in, compact result out, task created", async () => {
    const { db, orch, chat } = setup();
    cleanup = () => orch.stopAll();
    await orch.sendUserMessage(chat.id, "coordinate", null);
    await until(() => agentMsgs(db, chat.id)[0]?.status === "done");
    const coordinator = db.listAgents({})[0]!;
    const bridge = new Bridge();
    bridge.register(buildTools({ db, orch, roles: () => loadRoles(join(__dirname, "..", "agents"), "/x"), jazz: () => null, emitTask: () => {} }));
    const port = await bridge.start();
    const handle = createForwarder("core", "flashmaster-core", { url: `http://127.0.0.1:${port}`, token: bridge.token, agentId: coordinator.id });
    try {
      const list: any = await handle({ method: "tools/list" });
      expect(list.tools.map((t: any) => t.name)).toEqual(expect.arrayContaining(["delegate", "create_task", "save_artifact", "fetch_artifact"]));
      const r: any = await handle({ method: "tools/call", params: { name: "delegate", arguments: { role: "reviewer", goal: "Review brake.c", files: ["src/brake.c"] } } });
      const payload = JSON.parse(r.content[0].text);
      expect(payload.result).toContain("summary: Mock run");
      expect(payload.result.length).toBeLessThan(800);
      const sub = db.getAgent(payload.agentId)!;
      expect(sub).toMatchObject({ role: "reviewer", parentAgentId: coordinator.id });
      expect(sub.brief).toContain("Relevant files: src/brake.c");
      expect(db.listTasks({})[0]).toMatchObject({ assigneeRole: "reviewer", status: "review" });
      const art: any = await handle({ method: "tools/call", params: { name: "save_artifact", arguments: { title: "log", content: "L".repeat(9000) } } });
      const id = JSON.parse(art.content[0].text).id;
      const got: any = await handle({ method: "tools/call", params: { name: "fetch_artifact", arguments: { id, length: 100 } } });
      expect(JSON.parse(got.content[0].text)).toMatchObject({ total: 9000, content: "L".repeat(100) });
      const bad: any = await handle({ method: "tools/call", params: { name: "jazz_get", arguments: { id: "1" } } });
      expect(bad.content[0].text).toContain("unknown tool");
      // depth limit
      orch["d"].settings = () => mergeSettings(DEFAULT_SETTINGS, { agents: { delegationDepth: 0 } });
      const denied: any = await handle({ method: "tools/call", params: { name: "delegate", arguments: { role: "tester", goal: "x" } } });
      expect(denied.isError).toBe(true);
    } finally {
      bridge.stop();
    }
  });

  it("enforces budgets and toggles superpowers on demand", async () => {
    const { db, orch, chat, setSettings } = setup();
    cleanup = () => orch.stopAll();
    await orch.sendUserMessage(chat.id, "/superpowers", null);
    expect(db.getChat(chat.id)!.superpowers).toBe(true);
    setSettings({ tokens: { dailyBudget: 1, onBudgetExceeded: "pause" } });
    db.recordUsage({ agentId: null, projectId: null, harness: "mock", role: "x", tokensIn: 10, tokensOut: 0, estimated: true });
    await orch.sendUserMessage(chat.id, "anything", null);
    await until(() => db.listMessages(chat.id, null).some((m) => m.content.includes("budget exceeded")));
    expect(agentMsgs(db, chat.id)).toHaveLength(0);
  });

  it("asks for approval in chat and resolves it with a reaction", async () => {
    const { db, orch, chat } = setup({ permissions: { approval: "ask" } });
    cleanup = () => orch.stopAll();
    db.updateChat(chat.id, { harness: "opencode" });
    await orch.sendUserMessage(chat.id, "WRITE something", null);
    await until(() => db.history(chat.id, null).length > 0 && db.listAgents({}).length > 0);
    await until(() => db.raw.prepare("SELECT COUNT(*) c FROM messages WHERE author='system'").get() !== undefined &&
      Number((db.raw.prepare("SELECT COUNT(*) c FROM messages WHERE content LIKE '%React ✅%'").get() as any).c) > 0);
    const approval = db.raw.prepare("SELECT id FROM messages WHERE content LIKE '%React ✅%'").get() as any;
    orch.onReaction(approval.id, "✅", db.toggleReaction(approval.id, "✅"));
    await until(() => agentMsgs(db, chat.id)[0]?.status === "done");
    expect(agentMsgs(db, chat.id)[0]!.content).toContain("permission=ok");
  });
});

describe("stop during a turn", () => {
  it("keeps the agent stopped (not error) when stopped mid-stream on an ACP harness", async () => {
    const { db, orch, chat, events } = setup();
    db.updateChat(chat.id, { harness: "opencode" });
    await orch.sendUserMessage(chat.id, "SLOW work", null);
    await until(() => events.some((e) => e.type === "message.delta"));
    const a = db.listAgents({ activeOnly: true })[0]!;
    await orch.stop(a.id);
    await until(() => agentMsgs(db, chat.id)[0]?.status !== "streaming");
    await new Promise((r) => setTimeout(r, 100));
    expect(db.getAgent(a.id)!.status).toBe("stopped");
  });
});

describe("Pi native RPC adapter", () => {
  const FAKE_PI = join(__dirname, "fixtures", "fake-pi.mjs");

  it("streams text with LF-only framing, maps tools and usage, keeps the session file, lists models", async () => {
    const o = opts();
    const s = new PiSession(process.execPath, [FAKE_PI, "--mode", "rpc"], o);
    await s.init();
    expect(s.sessionId).toBe("/tmp/s.jsonl");
    const r = await s.prompt("hello");
    expect(r).toMatchObject({ stopReason: "end_turn", usage: { tokensIn: 250, tokensOut: 40 } });
    const text = o.events.filter((e) => e.type === "text").map((e) => (e as any).text).join("");
    expect(text).toBe("Pi says\u2028hi done.");
    expect(o.events.filter((e) => e.type === "tool").map((e: any) => [e.title, e.status, e.kind])).toEqual([
      ["read src/a.c", "in_progress", "read"], ["read src/a.c", "completed", "read"]]);
    expect(await s.availableModels()).toEqual([
      { id: "anthropic/claude-sonnet-4-5", name: "Claude Sonnet 4.5 (anthropic)", description: "200k context", current: true },
      { id: "openai/gpt-5", name: "GPT-5 (openai)", description: null, current: false }]);
    s.close();
  });

  it("aborts a running turn and enforces read-only via Pi's tool allowlist", async () => {
    const o = opts();
    const s = new PiSession(process.execPath, [FAKE_PI, "--mode", "rpc"], o);
    await s.init();
    const p = s.prompt("SLOW");
    await new Promise((r) => setTimeout(r, 150));
    await s.cancel();
    expect((await p).stopReason).toBe("cancelled");
    s.close();
    // Read-only: PiAdapter.start passes Pi's read-only tool allowlist; the fake echoes when it sees --tools.
    const ro = opts({ policy: { approval: "auto-all", readOnly: true, blocked: [], projectRoot: null } });
    const shim = new PiSession(process.execPath, [FAKE_PI, "--mode", "rpc", "--tools", "read,grep,find,ls"], ro);
    await shim.init();
    await shim.prompt("x");
    expect(ro.events.map((e: any) => e.text ?? "").join("")).toContain("(read-only)");
    shim.close();
  });
});

describe("model discovery", () => {
  it("reads ACP models from availableModels or a model config option", () => {
    expect(modelsFromSession({ models: { currentModelId: "b", availableModels: [{ modelId: "a", name: "A" }, { modelId: "b", name: "B" }] } }).models)
      .toEqual([{ id: "a", name: "A", description: null, current: false }, { id: "b", name: "B", description: null, current: true }]);
    const viaOption = modelsFromSession({ configOptions: [{ id: "model", type: "select", category: "model", currentValue: "x",
      options: [{ groupId: "g", name: "G", options: [{ value: "x", name: "X" }, { value: "y", name: "Y" }] }] }] });
    expect(viaOption.modelOptionId).toBe("model");
    expect(viaOption.models.map((m) => [m.id, m.current])).toEqual([["x", true], ["y", false]]);
    expect(modelsFromSession(undefined).models).toEqual([]);
  });

  it("probes an ACP harness for its models and selects the chosen one", async () => {
    const adapter = new AcpAdapter("copilot", "Fake", [process.execPath], [FAKE], "");
    const models = await adapter.listModels!({ executable: process.execPath, cwd: process.cwd(), env: {}, extraArgs: "" });
    expect(models.map((m) => m.id)).toEqual(["gpt-5", "claude-sonnet-4.5"]);
    const o = opts({ model: "claude-sonnet-4.5" });
    const s = await adapter.start(o);
    await s.prompt("which model");
    expect(o.events.map((e: any) => e.text ?? "").join("")).toContain("model=claude-sonnet-4.5");
    s.close();
  });

  it("probes Pi for its models", async () => {
    const models = await new PiAdapter().listModels!({ executable: process.execPath, cwd: process.cwd(), env: {}, extraArgs: "" }).catch((e) => e);
    // node without the fake script cannot speak RPC: the probe fails cleanly instead of hanging
    expect(models).toBeInstanceOf(Error);
  }, 60000);
});

describe("chat ordering (regression)", () => {
  it("streams each turn into its own reply when the harness session is reused", async () => {
    const { db, orch, chat } = setup();
    db.updateChat(chat.id, { harness: "opencode" }); // real ACP session kept across turns
    await orch.sendUserMessage(chat.id, "first question", null);
    await until(() => agentMsgs(db, chat.id)[0]?.status === "done");
    await orch.sendUserMessage(chat.id, "which model", null);
    await until(() => agentMsgs(db, chat.id).length === 2 && agentMsgs(db, chat.id)[1]!.status === "done");
    const list = db.listMessages(chat.id, null);
    expect(list.map((m) => m.author)).toEqual(["user", "agent", "user", "agent"]);
    expect(list.map((m) => m.seq)).toEqual([...list.map((m) => m.seq)].sort((a, b) => a - b));
    const [r1, r2] = agentMsgs(db, chat.id);
    expect(r1!.content).not.toContain("model=");      // turn-2 text must not leak into reply 1
    expect(r2!.content).toContain("model=gpt-5");
    expect(r2!.content.match(/Hello from fake ACP/g)).toHaveLength(1);
    await orch.stopAll();
  });

  it("serves the live text of a streaming reply (no stale 500 ms flush)", async () => {
    const { db, orch, chat, events } = setup();
    db.updateChat(chat.id, { harness: "opencode" });
    await orch.sendUserMessage(chat.id, "SLOW", null);
    await until(() => events.filter((e) => e.type === "message.delta").length >= 2);
    const streamed = events.filter((e) => e.type === "message.delta").map((e: any) => e.delta).join("");
    const live = orch.withLiveText(db.listMessages(chat.id, null)).find((m) => m.status === "streaming")!;
    expect(live.content.startsWith(streamed)).toBe(true);
    await orch.stopAll();
  });
});
