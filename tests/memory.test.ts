import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../src/main/db";
import { MemoryStore, cosine, fuse, vectorize, type MemoryContext } from "../src/main/memory";
import { buildTools } from "../src/main/tools";
import { Bridge } from "../src/main/bridge";
import { Orchestrator, MEMORY_RULES } from "../src/main/orchestrator";
import { HarnessRegistry } from "../src/main/harness/registry";
import { MockAdapter, MockSession } from "../src/main/harness/mock";
import { loadRoles } from "../src/main/roles";
import { buildTurnPrompt } from "../src/main/context";
import { DEFAULT_SETTINGS, mergeSettings, type Settings } from "../src/shared/settings";

const DAY = 86_400_000;

function world() {
  let t = 1_700_000_000_000;
  const clock = { now: () => t, advance: (ms: number) => { t += ms; } };
  const db = new Db(":memory:");
  const store = new MemoryStore(db, clock.now);
  const p1 = db.createProject("alpha", "/tmp/alpha");
  const p2 = db.createProject("beta", "/tmp/beta");
  const c1 = db.createChat({ projectId: p1.id, title: "a1", kind: "project", agentRole: "flashmaster" });
  const c2 = db.createChat({ projectId: p1.id, title: "a2", kind: "project", agentRole: "flashmaster" });
  const c3 = db.createChat({ projectId: p2.id, title: "b1", kind: "project", agentRole: "flashmaster" });
  const ctx = (chat: { id: string; projectId: string | null }): MemoryContext => ({ projectId: chat.projectId, chatId: chat.id });
  return { db, store, clock, p1, p2, c1, c2, c3, ctx };
}

describe("memory scopes", () => {
  it("user memory is global, project memory is shared by the project's chats, short-term memory stays in its chat", () => {
    const { store, c1, c2, c3, ctx } = world();
    store.save({ content: "Mari prefers a minimal glass UI", scope: "user", kind: "preference" }, ctx(c1));
    store.save({ content: "The CAN driver lives in src/can and uses a 500 kbit/s bus", scope: "project" }, ctx(c1));
    store.save({ content: "Currently checking the brake light flicker", scope: "session" }, ctx(c1));
    const seen = (c: typeof c1) => store.list(ctx(c)).map((m) => m.scope).sort();
    expect(seen(c1)).toEqual(["project", "session", "user"]);
    expect(seen(c2)).toEqual(["project", "user"]); // same project, other chat
    expect(seen(c3)).toEqual(["user"]); // other project
  });

  it("defaults to short-term inside a chat and to project scope without one; aliases work", () => {
    const { store, c1, p1 } = world();
    expect(store.save({ content: "note one about timers" }, { projectId: p1.id, chatId: c1.id }).memory.scope).toBe("session");
    expect(store.save({ content: "note two about flashing" }, { projectId: p1.id, chatId: null }).memory.scope).toBe("project");
    expect(store.save({ content: "global note on reviews", scope: "global" as any }, { projectId: null, chatId: null }).memory.scope).toBe("user");
    expect(() => store.save({ content: "x", scope: "session" }, { projectId: null, chatId: null })).toThrow(/needs a chat/);
    expect(() => store.save({ content: "   " }, { projectId: null, chatId: null })).toThrow(/empty/);
  });
});

describe("memory search", () => {
  it("finds memories by keyword, by stem and despite typos (hybrid FTS + fuzzy)", () => {
    const { store, c1, ctx } = world();
    store.save({ content: "Brake light debounce is 20 ms on the BCM", scope: "project" }, ctx(c1));
    store.save({ content: "Release builds are signed with the Windows certificate", scope: "project" }, ctx(c1));
    store.save({ content: "Mari wants PRs merged once CI is green", scope: "user" }, ctx(c1));
    expect(store.search("debounce", ctx(c1))[0]!.content).toMatch(/debounce/);
    expect(store.search("debouncing time of the brake lights", ctx(c1))[0]!.content).toMatch(/debounce/);
    expect(store.search("debounse", ctx(c1))[0]!.content).toMatch(/debounce/); // typo: fuzzy ranking only
    expect(store.search("merging pull requests", ctx(c1))[0]!.content).toMatch(/merged/);
    expect(store.search("quantum chromodynamics", ctx(c1))).toEqual([]);
  });

  it("ranks equally relevant memories by importance and recency, and counts use", () => {
    const { store, clock, c1, ctx } = world();
    const old = store.save({ content: "Flash tool uses port 5053", scope: "project", importance: 3 }, ctx(c1)).memory;
    clock.advance(120 * DAY);
    const fresh = store.save({ content: "Flash tool uses port 8085", scope: "project", importance: 3 }, ctx(c1)).memory;
    const hits = store.search("flash tool port", ctx(c1));
    expect(hits.map((h) => h.id)).toEqual([fresh.id, old.id]);
    expect(store.get(fresh.id)!.accessCount).toBe(1);
    const vip = store.save({ content: "Flash tool port must never change", scope: "project", importance: 5 }, ctx(c1)).memory;
    expect(store.search("flash tool port", ctx(c1))[0]!.id).toBe(vip.id);
  });

  it("an empty query lists the most important / recent memories; filters by scope, kind and tag", () => {
    const { store, c1, ctx } = world();
    store.save({ content: "Use tabs in C files", scope: "project", kind: "procedure", tags: ["style", "c"] }, ctx(c1));
    store.save({ content: "Mari is based in Romania", scope: "user", importance: 5 }, ctx(c1));
    expect(store.search("", ctx(c1))[0]!.content).toMatch(/Romania/);
    expect(store.search("", ctx(c1), { scopes: ["project"] }).map((m) => m.kind)).toEqual(["procedure"]);
    expect(store.list(ctx(c1), { tag: "style" })).toHaveLength(1);
    expect(store.list(ctx(c1), { kind: "preference" })).toHaveLength(0);
  });

  it("still works without FTS5 (LIKE fallback)", () => {
    const { store, c1, ctx } = world();
    (store as any).index = "like";
    store.save({ content: "Requirements live in DOORS Next module 42", scope: "project" }, ctx(c1));
    expect(store.search("doors module", ctx(c1))[0]!.content).toMatch(/DOORS/);
  });

  it("fuses rankings and measures similarity", () => {
    const f = fuse([[1, 2, 3], [2, 1]]);
    expect(f.get(1)).toBeCloseTo(f.get(2)!, 1);
    expect(f.get(3)!).toBeLessThan(f.get(1)!);
    expect(cosine(vectorize("brake light debounce"), vectorize("Brake-light debounce!"))).toBeGreaterThan(0.99);
    expect(cosine(vectorize("brake light"), vectorize("signed certificate"))).toBeLessThan(0.2);
  });
});

describe("memory consolidation", () => {
  it("merges a near-duplicate instead of storing it twice, reports similar ones, and replaces corrected facts", () => {
    const { store, c1, ctx } = world();
    const a = store.save({ content: "The build uses Node 22", scope: "project", tags: ["build"] }, ctx(c1));
    const b = store.save({ content: "The build uses Node 22.", scope: "project", importance: 4, tags: ["node"] }, ctx(c1));
    expect(b.status).toBe("merged");
    expect(b.memory.id).toBe(a.memory.id);
    expect(b.memory.importance).toBe(4);
    expect(b.memory.tags.sort()).toEqual(["build", "node"]);
    const c = store.save({ content: "The build uses Node 24 now", scope: "project" }, ctx(c1));
    expect(c.status).toBe("saved");
    expect(c.similar.map((s) => s.id)).toContain(a.memory.id);
    const d = store.save({ content: "Builds run on Node 24", scope: "project", replaces: [a.memory.id, c.memory.id] }, ctx(c1));
    expect(d.replaced.sort()).toEqual([a.memory.id, c.memory.id].sort());
    expect(store.list(ctx(c1)).map((m) => m.content)).toEqual(["Builds run on Node 24"]);
  });

  it("does not merge the same text across scopes", () => {
    const { store, c1, ctx } = world();
    store.save({ content: "Use the economy model for tests", scope: "project" }, ctx(c1));
    expect(store.save({ content: "Use the economy model for tests", scope: "user" }, ctx(c1)).status).toBe("saved");
  });
});

describe("short-term memory", () => {
  it("expires after the configured days unless used again or promoted; promote merges into an existing long-term fact", () => {
    const { store, clock, c1, ctx } = world();
    store.shortTermDays = () => 2;
    const a = store.save({ content: "Investigating flicker at -20 °C", scope: "session" }, ctx(c1)).memory;
    const b = store.save({ content: "HIL bench 3 is broken this week", scope: "session" }, ctx(c1)).memory;
    const c = store.save({ content: "The team decided on calibration set A", scope: "session", kind: "decision" }, ctx(c1)).memory;
    expect(a.expiresAt).toBe(clock.now() + 2 * DAY);
    clock.advance(1.5 * DAY);
    store.update(b.id, { importance: 4 }); // used again: another full period
    const kept = store.promote(c.id, "project", ctx(c1));
    expect(kept.memory).toMatchObject({ scope: "project", chatId: null, expiresAt: null });
    clock.advance(1 * DAY);
    expect(store.sweep()).toBe(1);
    expect(store.get(a.id)).toBeNull();
    expect(store.get(b.id)).not.toBeNull();
    expect(store.get(c.id)).not.toBeNull();
    const dup = store.save({ content: "The team decided on calibration set A", scope: "session" }, ctx(c1)).memory;
    const merged = store.promote(dup.id, "project", ctx(c1));
    expect(merged).toMatchObject({ status: "merged", replaced: [dup.id] });
    expect(merged.memory.id).toBe(c.id);
    expect(() => store.promote(c.id, "session", ctx(c1))).toThrow(/long-term/);
  });

  it("is removed with its chat; project memory with its project", () => {
    const { db, store, c1, p2, c3, ctx } = world();
    const s = store.save({ content: "temp note about the chat", scope: "session" }, ctx(c1)).memory;
    const p = store.save({ content: "beta project uses CANoe 17", scope: "project" }, ctx(c3)).memory;
    const u = store.save({ content: "user likes concise replies", scope: "user" }, ctx(c3)).memory;
    db.deleteChat(c1.id);
    db.removeProject(p2.id);
    store.sweep();
    expect([store.get(s.id), store.get(p.id), store.get(u.id)?.id]).toEqual([null, null, u.id]);
  });
});

describe("memory recall (auto-injection)", () => {
  it("shows pinned memories always and relevant ones for the request, skipping ones already shown", () => {
    const { store, c1, ctx } = world();
    const pin = store.save({ content: "Always answer in English", scope: "user", pinned: true }, ctx(c1)).memory;
    const rel = store.save({ content: "Brake light debounce is 20 ms", scope: "project" }, ctx(c1)).memory;
    store.save({ content: "Release notes go in CHANGELOG.md", scope: "project" }, ctx(c1));
    const r = store.recall("why does the brake light flicker?", ctx(c1), { max: 4 });
    expect(r.ids).toEqual([pin.id, rel.id]);
    expect(r.text).toContain("## Relevant memory");
    expect(r.text).toContain(`[${rel.id}] (project) Brake light debounce is 20 ms`);
    expect(store.recall("brake light", ctx(c1), { exclude: r.ids }).ids).toEqual([]);
    expect(store.recall("brake", ctx(c1), { max: 0 }).text).toBe("");
  });

  it("buildTurnPrompt puts the memory block before the request", () => {
    const role = { name: "x", title: "X", icon: "", description: "", tools: [], maxResultTokens: 100, skills: [], prompt: "Be useful.", source: "builtin" as const };
    const first = buildTurnPrompt({ role, projectPath: null, skills: [], summary: null, recent: [], input: "do it", firstTurn: true, memory: "## Relevant memory\n- [1] (user) hi" });
    expect(first.indexOf("## Relevant memory")).toBeLessThan(first.indexOf("## Request"));
    const later = buildTurnPrompt({ role, projectPath: null, skills: [], summary: null, recent: [], input: "next", firstTurn: false, memory: "## Relevant memory\n- [2] (project) x" });
    expect(later).toBe("## Relevant memory\n- [2] (project) x\n\nnext");
  });
});

describe("memory tools", () => {
  function tools() {
    const w = world();
    const a1 = w.db.createAgent({ projectId: w.p1.id, chatId: w.c1.id, role: "coder", harness: "mock", model: null, brief: "b" });
    const a2 = w.db.createAgent({ projectId: w.p2.id, chatId: w.c3.id, role: "tester", harness: "mock", model: null, brief: "b" });
    const bridge = new Bridge();
    let changes = 0;
    let enabled = true;
    bridge.register(buildTools({ db: w.db, orch: {} as Orchestrator, roles: () => [], jazz: () => null, emitTask: () => {}, memory: w.store,
      memoryEnabled: () => enabled, onMemory: () => { changes++; } }));
    return { ...w, bridge, a1, a2, changes: () => changes, disable: () => { enabled = false; } };
  }

  it("offers save, search, list, update, delete and promote on the core set", () => {
    const { bridge } = tools();
    expect(bridge.list("core").map((t) => t.name)).toEqual(expect.arrayContaining(
      ["memory_save", "memory_search", "memory_list", "memory_update", "memory_delete", "memory_promote"]));
  });

  it("works end to end from an agent, scoped to the agent's project and chat", async () => {
    const { bridge, a1, a2, store, changes } = tools();
    const saved = await bridge.call("memory_save", { content: "Coder found that the PWM timer is shared", scope: "session", tags: ["pwm"] }, a1.id) as any;
    expect(saved).toMatchObject({ scope: "session", status: "saved" });
    expect(store.get(saved.id)).toMatchObject({ sourceRole: "coder", sourceAgentId: a1.id });
    const found = await bridge.call("memory_search", { query: "pwm timer" }, a1.id) as any[];
    expect(found[0]).toMatchObject({ id: saved.id, tags: ["pwm"] });
    expect(found[0].expires).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // The other project's agent can neither see nor touch it.
    expect(await bridge.call("memory_search", { query: "pwm timer" }, a2.id)).toEqual([]);
    await expect(bridge.call("memory_delete", { id: saved.id }, a2.id)).rejects.toThrow(/unknown memory id/);
    const promoted = await bridge.call("memory_promote", { id: saved.id, to: "project" }, a1.id) as any;
    expect(promoted).toMatchObject({ scope: "project", status: "saved" });
    expect(promoted.expires).toBeUndefined();
    expect(await bridge.call("memory_update", { id: saved.id, importance: 5, pinned: true }, a1.id)).toMatchObject({ importance: 5, pinned: true });
    expect((await bridge.call("memory_list", { scope: "project" }, a1.id) as any[]).map((m) => m.id)).toEqual([saved.id]);
    expect(await bridge.call("memory_delete", { id: saved.id }, a1.id)).toEqual({ id: saved.id, deleted: true });
    expect(changes()).toBe(4);
  });

  it("refuses when memory is turned off", async () => {
    const { bridge, a1, disable } = tools();
    disable();
    await expect(bridge.call("memory_search", { query: "x" }, a1.id)).rejects.toThrow(/turned off/);
  });
});

describe("orchestrator memory", () => {
  afterEach(() => vi.restoreAllMocks());
  const until = async (fn: () => boolean, ms = 8000) => {
    const t = Date.now();
    while (!fn()) { if (Date.now() - t > ms) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 10)); }
  };

  async function setup(memory: Partial<Settings["memory"]> = {}) {
    const db = new Db(":memory:");
    const store = new MemoryStore(db);
    const settings = mergeSettings(DEFAULT_SETTINGS, { general: { defaultHarness: "mock" }, agents: { toolMode: "mcp" }, memory }) as Settings;
    const roles = loadRoles(join(__dirname, "..", "agents"), "/none");
    const prompts: string[] = [];
    const orig = MockSession.prototype.prompt;
    vi.spyOn(MockSession.prototype, "prompt").mockImplementation(function (this: MockSession, text, atts) { prompts.push(text); return orig.call(this, text, atts); });
    const orch = new Orchestrator({ db, memory: store, harnesses: new HarnessRegistry([new MockAdapter(1)]), settings: () => settings, roles: () => roles,
      skills: () => [], emit: () => undefined, mcpServersFor: () => [], homeDir: tmpdir(), dataDir: mkdtempSync(join(tmpdir(), "mem-data-")) });
    const p = db.createProject("p", mkdtempSync(join(tmpdir(), "mem-proj-")));
    const chat = db.createChat({ projectId: p.id, title: "c", kind: "project", agentRole: "flashmaster" });
    return { db, store, orch, chat, prompts, settings };
  }

  it("reminds the agent of relevant memories and how to use memory on the first turn, then only new relevant ones", async () => {
    const { db, store, orch, chat, prompts } = await setup();
    const ctx = { projectId: chat.projectId, chatId: chat.id };
    store.save({ content: "Brake light debounce must stay at 20 ms", scope: "project" }, ctx);
    store.save({ content: "Mari prefers short replies", scope: "user", pinned: true }, ctx);
    await orch.sendUserMessage(chat.id, "Why does the brake light flicker?", null);
    await until(() => db.listAgents({}).some((x) => x.status === "idle"));
    expect(prompts[0]).toContain(MEMORY_RULES);
    expect(prompts[0]).toContain("Brake light debounce must stay at 20 ms");
    expect(prompts[0]).toContain("Mari prefers short replies");
    store.save({ content: "The flicker happens only below -10 °C", scope: "project" }, ctx);
    await orch.sendUserMessage(chat.id, "What about the flicker at cold temperatures?", null);
    await until(() => prompts.length === 2 && db.listAgents({}).every((x) => x.status === "idle"));
    expect(prompts[1]).toContain("only below -10 °C");
    expect(prompts[1]).not.toContain("debounce must stay"); // already shown in this session
    expect(prompts[1]).not.toContain(MEMORY_RULES);
  });

  it("saves a delegated specialist's result as a short-term memory of the chat", async () => {
    const { db, store, orch, chat } = await setup();
    await orch.sendUserMessage(chat.id, "hello", null);
    await until(() => db.listAgents({}).some((x) => x.role === "flashmaster" && x.status === "idle"));
    const lead = db.listAgents({}).find((x) => x.role === "flashmaster")!;
    await orch.delegate(lead.id, { role: "tester", goal: "Check the brake light tests" });
    const eps = store.list({ projectId: chat.projectId, chatId: chat.id }, { scopes: ["session"] });
    expect(eps).toHaveLength(1);
    expect(eps[0]).toMatchObject({ kind: "episode", sourceRole: "tester" });
    expect(eps[0]!.content).toMatch(/finished: Mock run for/);
  });

  it("stays quiet when memory is off", async () => {
    const { db, store, orch, chat, prompts } = await setup({ enabled: false });
    store.save({ content: "Brake light debounce must stay at 20 ms", scope: "project" }, { projectId: chat.projectId, chatId: chat.id });
    await orch.sendUserMessage(chat.id, "brake light?", null);
    await until(() => db.listAgents({}).some((x) => x.status === "idle"));
    expect(prompts[0]).not.toContain("Relevant memory");
    expect(prompts[0]).not.toContain(MEMORY_RULES);
  });
});
