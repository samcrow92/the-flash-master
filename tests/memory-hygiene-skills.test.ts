import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../src/main/db";
import { MemoryStore } from "../src/main/memory";
import { duplicateGroups, memoryHealth, mentionedPaths, pickKeeper } from "../src/main/memory-health";
import { ollamaEmbedder, type Embedder } from "../src/main/embeddings";
import { loadAgentSkills, skillsIndex } from "../src/main/roles";
import { Orchestrator } from "../src/main/orchestrator";
import { HarnessRegistry } from "../src/main/harness/registry";
import { MockAdapter } from "../src/main/harness/mock";
import type { HarnessSession, SessionOptions } from "../src/main/harness/types";
import { loadRoles } from "../src/main/roles";
import { DEFAULT_SETTINGS, mergeSettings, type Settings } from "../src/shared/settings";

const DAY = 86_400_000;
const ctx = { projectId: "p1", chatId: null };

describe("memory hygiene", () => {
  it("finds the files a memory mentions", () => {
    expect(mentionedPaths("The debounce lives in src/brake_light.c (see `docs/lamp.md`), not https://x.org/a.html or /etc/hosts.conf; v1.2.3 too"))
      .toEqual(["src/brake_light.c", "docs/lamp.md"]);
  });

  it("flags near-duplicates, memories whose files are gone or changed, and unused ones", () => {
    let t = 1_000 * DAY;
    const store = new MemoryStore(new Db(":memory:"), () => t);
    const a = store.save({ content: "Brake light debounce is 20 ms, set in src/brake_light.c", scope: "project", importance: 4, commit: "abc1234def" }, ctx).memory;
    const b = store.save({ content: "src/brake_light.c sets the brake lamp debounce to 20 ms", scope: "project", importance: 2 }, ctx).memory;
    const gone = store.save({ content: "CAN ids are listed in can/ids_old.dbc", scope: "project" }, ctx).memory;
    const old = store.save({ content: "Lunch is at noon on Fridays", scope: "project", importance: 1 }, ctx).memory;
    const you = store.save({ content: "Mari prefers src/x.c style names", scope: "user" }, ctx).memory;
    expect(a.commit).toBe("abc1234def");
    expect(you.commit ?? null).toBeNull();
    t += 120 * DAY;
    const ms = store.list(null, { projectId: "p1" });
    const groups = duplicateGroups(ms);
    expect(groups.map((g) => g.ids)).toEqual([[a.id, b.id]]); // the more important one first: it is kept
    expect(duplicateGroups([store.get(b.id)!, store.get(a.id)!])[0]!.ids).toEqual([a.id, b.id]);
    const h = memoryHealth(ms, { exists: (p) => p !== "can/ids_old.dbc", changedSince: (c, paths) => (c === "abc1234def" ? paths : []), now: t });
    expect(h.stale).toEqual([
      { id: a.id, reason: "src/brake_light.c changed since it was saved (abc1234)" },
      { id: gone.id, reason: "mentions can/ids_old.dbc, which no longer exists" },
    ].sort((x, y) => ms.findIndex((m) => m.id === x.id) - ms.findIndex((m) => m.id === y.id)));
    expect(h.unused).toEqual([b.id, old.id]);
    expect(pickKeeper([b, a]).id).toBe(a.id);
    // Merge keeps the chosen one with the union of tags and the highest importance; confirm stamps a new commit.
    const kept = store.merge([a.id, b.id], a.id);
    expect(store.get(b.id)).toBeNull();
    expect(kept.importance).toBe(4);
    expect(store.confirm(a.id, "fff0000").commit).toBe("fff0000");
    expect(() => store.merge([a.id], a.id)).toThrow(/at least two/);
  });
});

/** A toy embedder: words of one meaning share a dimension, so "automobile" finds "car" though they share no letters. */
const toy: Embedder = {
  model: "toy",
  embed: async (texts) => texts.map((t) => {
    const v = new Float32Array(4);
    if (/\b(car|automobile|vehicle)\b/i.test(t)) v[0] = 1;
    if (/\b(lunch|meal)\b/i.test(t)) v[1] = 1;
    v[3] = 0.05;
    return v;
  }),
};

describe("local embeddings", () => {
  it("rank memories by meaning once the query is prepared, and fall back without them", async () => {
    const store = new MemoryStore(new Db(":memory:"));
    store.save({ content: "The car must stop within 40 m", scope: "project" }, ctx);
    store.save({ content: "Lunch is at noon", scope: "project" }, ctx);
    expect(store.search("automobile", ctx).length).toBe(0);
    store.setEmbedder(toy);
    await store.embedMissing(); // setEmbedder started embedding both
    expect(await store.embedMissing()).toBe(0);
    expect(await store.prepare("automobile")).toBe(true);
    expect(store.search("automobile", ctx).map((h) => h.content)).toEqual(["The car must stop within 40 m"]);
    store.setEmbedder(null);
    expect(store.search("automobile", ctx).length).toBe(0);
  });

  it("talk to a local Ollama server", async () => {
    const calls: { url: string; body: unknown }[] = [];
    const fake = (async (url: string, init: { body: string }) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return { ok: true, status: 200, json: async () => ({ embeddings: [[1, 0], [0, 1]] }) };
    }) as unknown as typeof fetch;
    const e = ollamaEmbedder("http://127.0.0.1:11434/", "nomic-embed-text", fake);
    const v = await e.embed(["a", "b"]);
    expect(calls[0]).toEqual({ url: "http://127.0.0.1:11434/api/embed", body: { model: "nomic-embed-text", input: ["a", "b"] } });
    expect(Array.from(v[1]!)).toEqual([0, 1]);
    const missing = ollamaEmbedder("http://x", "m", (async () => ({ ok: false, status: 404 })) as unknown as typeof fetch);
    await expect(missing.embed(["a"])).rejects.toThrow(/ollama pull m/);
  });
});

class RecordingMock extends MockAdapter {
  prompts: string[] = [];
  override async start(o: SessionOptions): Promise<HarnessSession> {
    const s = await super.start(o);
    const p = s.prompt.bind(s);
    (s as { prompt: HarnessSession["prompt"] }).prompt = (text, a) => { this.prompts.push(text); return p(text, a); };
    return s;
  }
}

function skill(root: string, folder: string, name: string, description: string, extra: Record<string, string> = {}) {
  mkdirSync(join(root, folder), { recursive: true });
  writeFileSync(join(root, folder, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nStep 1: run scripts/check.py.\n`);
  for (const [f, t] of Object.entries(extra)) { mkdirSync(join(root, folder, f, ".."), { recursive: true }); writeFileSync(join(root, folder, f), t); }
}

describe("Agent Skills (SKILL.md)", () => {
  it("load from skill folders with their files, and list only names and descriptions", () => {
    const dir = mkdtempSync(join(tmpdir(), "skills-"));
    skill(dir, "misra-check", "misra-check", "Check C code against MISRA C:2012 rules", { "scripts/check.py": "print(1)", "rules.md": "# rules" });
    mkdirSync(join(dir, "not-a-skill"));
    const ks = loadAgentSkills(dir, "user");
    expect(ks.map((k) => [k.name, k.command, k.source, k.files])).toEqual([["misra-check", "misra-check", "user", ["rules.md", "scripts/check.py"]]]);
    expect(skillsIndex(ks)).toBe("## Skills\nPackaged instructions for specific tasks. When one fits what you are doing, load it with use_skill (name) before you start, and follow it.\n- misra-check: Check C code against MISRA C:2012 rules");
    expect(loadAgentSkills(join(dir, "nope"), "user")).toEqual([]);
  });

  it("a project's skills reach its agents: listed on a new session, loaded with use_skill", async () => {
    const proj = mkdtempSync(join(tmpdir(), "proj-"));
    skill(join(proj, ".claude", "skills"), "can-decode", "can-decode", "Decode CAN frames with the project's DBC");
    const db = new Db(":memory:");
    const settings = mergeSettings(DEFAULT_SETTINGS, { general: { defaultHarness: "mock" } }) as Settings;
    const mock = new RecordingMock(0);
    const orch = new Orchestrator({ db, harnesses: new HarnessRegistry([mock]), settings: () => settings, roles: () => loadRoles(join(__dirname, "..", "agents"), "/none"),
      skills: () => [], emit: () => undefined, mcpServersFor: () => [], homeDir: tmpdir(), dataDir: mkdtempSync(join(tmpdir(), "data-")) });
    const p = db.createProject("p", proj);
    const chat = db.createChat({ projectId: p.id, title: "c", kind: "project", agentRole: "flashmaster" });
    expect(orch.skillsFor(chat).map((k) => k.name)).toEqual(["can-decode"]);
    await orch.sendUserMessage(chat.id, "Decode this frame", null);
    await new Promise((r) => setTimeout(r, 200));
    expect(mock.prompts[0]).toContain("- can-decode: Decode CAN frames with the project's DBC");
    const coord = db.listAgents({}).find((a) => a.role === "flashmaster")!;
    expect(orch.useSkill(coord.id, "can-decode")).toMatchObject({ name: "can-decode", folder: join(proj, ".claude", "skills", "can-decode"), files: [] });
    expect(orch.useSkill(coord.id, "can-decode").instructions).toContain("Step 1: run scripts/check.py.");
    expect(() => orch.useSkill(coord.id, "nope")).toThrow(/unknown skill "nope": one of can-decode/);
    await orch.stopAll();
  });
});
