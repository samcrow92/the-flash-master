import { describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../src/main/db";
import { MemoryStore, MAX_KNOWLEDGE_CHARS } from "../src/main/memory";
import { KnowledgeBase } from "../src/main/knowledge";
import { CODE_MAP_SLUG, CodeGraph, codeMapEntry, graphMeta } from "../src/main/graphify";
import { buildTools } from "../src/main/tools";
import type { CodeGraphStatus } from "../src/shared/types";

const REPORT = `# Graph Report - proj  (2026-11-17)

## Corpus Check
- 3 files · ~200 words

## Summary
- 4 nodes · 3 edges · 2 communities

## Graph Freshness
- Built from commit: \`abc1234\`

## Community Hubs (Navigation)
- Engine

## God Nodes (most connected - your core abstractions)
1. \`Engine\` - 3 edges
2. \`Db\` - 2 edges

## Surprising Connections (you probably didn't know these)
- \`README\` --references--> \`Engine\`  [INFERRED]

## Import Cycles
- 2-file cycle: \`a.ts -> b.ts -> a.ts\`

## Communities (2 total, 0 thin omitted)

### Community 0 - "Engine"
Cohesion: 0.5
Nodes (3): Engine, start(), stop()

### Community 1 - "Db"
Cohesion: 0.4
Nodes (2): Db, query()

## Knowledge Gaps
- none

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does \`Engine\` connect to \`Db\`?**
`;

const GRAPH = JSON.stringify({
  directed: false, multigraph: false, graph: { schema_version: 1, graphify_version: "0.9.112" },
  nodes: [{ id: "a", community: 0 }, { id: "b", community: 0 }, { id: "c", community: 1 }, { id: "d", community: 1 }],
  links: [{ source: "a", target: "b" }, { source: "b", target: "c" }, { source: "c", target: "d" }],
  built_at_commit: "abc1234def5678",
});

const META = graphMeta(GRAPH);

describe("code map entry", () => {
  it("reads the counts and the commit from graph.json", () => {
    expect(META).toEqual({ nodes: 4, edges: 3, communities: 2, commit: "abc1234def5678", version: "0.9.112" });
  });

  it("summarises the report into a knowledge entry with a title, hubs and compact communities", () => {
    const e = codeMapEntry(REPORT, META);
    expect(e.startsWith("# Code map (graphify)\n")).toBe(true);
    expect(e).toContain("from commit abc1234def");
    expect(e).toContain("code_graph");
    expect(e).toContain("## Most connected (core abstractions)\n\n1. `Engine` - 3 edges");
    expect(e).toContain("## Import cycles");
    expect(e).toContain("- **Engine** (3): Engine, start(), stop()");
    expect(e).toContain("Why does `Engine` connect to `Db`?");
    // Navigation noise and graphify's own instructions stay out.
    expect(e).not.toContain("Community Hubs");
    expect(e).not.toContain("Graph Freshness");
    expect(e).not.toContain("uniquely positioned");
    // Deterministic: the same report gives the same bytes (two teammates scanning one commit write the same file).
    expect(codeMapEntry(REPORT, META)).toBe(e);
  });

  it("cuts communities to fit the knowledge entry size limit", () => {
    const many = Array.from({ length: 600 }, (_, i) => `### Community ${i} - "mod${i}"\nCohesion: 0.1\nNodes (9): ${"symbolName(), ".repeat(8)}x`).join("\n\n");
    const big = REPORT.replace(/## Communities[\s\S]*?## Knowledge Gaps/, `## Communities (600 total)\n\n${many}\n\n## Knowledge Gaps`);
    const e = codeMapEntry(big, META);
    expect(e.length).toBeLessThanOrEqual(MAX_KNOWLEDGE_CHARS);
    expect(e).toMatch(/- … and \d+ more \(ask code_graph\)/);
    expect(e).toContain("- **mod0** (9)");
  });
});

function setup(opts: { installed?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "graphify-"));
  writeFileSync(join(dir, "main.ts"), "export const x = 1;\n");
  const db = new Db(":memory:");
  const store = new MemoryStore(db);
  const kb = new KnowledgeBase(db, store);
  const p = db.createProject("proj", dir);
  let python: string | null = opts.installed === false ? null : "/venv/python";
  const calls: { cmd: string; args: string[]; cwd?: string; env?: Record<string, string> }[] = [];
  let answer = (args: string[], env?: Record<string, string>): { code: number | null; out: string } => {
    if (args[2] === "update") {
      mkdirSync(env!.GRAPHIFY_OUT!, { recursive: true });
      writeFileSync(join(env!.GRAPHIFY_OUT!, "GRAPH_REPORT.md"), REPORT);
      writeFileSync(join(env!.GRAPHIFY_OUT!, "graph.json"), GRAPH);
      writeFileSync(join(env!.GRAPHIFY_OUT!, "graph.html"), "<html></html>");
    }
    return { code: 0, out: "[graphify] note: old id scheme\nNODE Engine [src=main.ts]" };
  };
  const run = vi.fn(async (cmd: string, args: string[], _t?: number, cwd?: string, env?: Record<string, string>) => {
    calls.push({ cmd, args, cwd, env });
    return answer(args, env);
  });
  const install = vi.fn(async (onPhase: (p: string) => void) => { onPhase("Installing graphify…"); python = "/venv/python"; return python; });
  const events: CodeGraphStatus[] = [];
  const cg = new CodeGraph({ db, knowledge: kb, python: () => python, install, run, onStatus: (s) => events.push(s) });
  return { dir, db, store, kb, p, cg, calls, install, events, setAnswer: (f: typeof answer) => { answer = f; } };
}

describe("code graph scan", () => {
  it("installs graphify on the first scan, runs it in the project and writes the code-map knowledge entry", async () => {
    const t = setup({ installed: false });
    expect(t.cg.status(t.p.id)).toMatchObject({ installed: false, graph: null, running: null, html: null });
    const st = await t.cg.scan(t.p.id);
    expect(t.install).toHaveBeenCalledOnce();
    const update = t.calls.find((c) => c.args.includes("update"))!;
    expect(update.args).toEqual(["-m", "graphify", "update", ".", "--force"]);
    expect(update.cwd).toBe(t.dir);
    expect(update.env!.GRAPHIFY_OUT).toBe(join(t.dir, ".flashmaster", "graphify"));
    // graphify must not scan its own output or the knowledge files; the graph stays out of git.
    expect(readFileSync(join(t.dir, ".flashmaster", ".graphifyignore"), "utf8")).toMatch(/^\*$/m);
    expect(readFileSync(join(t.dir, ".flashmaster", ".gitignore"), "utf8")).toContain("!knowledge/");
    expect(st).toMatchObject({ installed: true, running: null, error: null, graph: { nodes: 4, edges: 3, communities: 2, commit: "abc1234def5678" } });
    expect(st.html).toBe(join(t.dir, ".flashmaster", "graphify", "graph.html"));
    // The summary is a knowledge entry like any other: in the database (recall, Memory page) and in the repo folder.
    const m = t.store.getKnowledge(t.p.id, CODE_MAP_SLUG)!;
    expect(m.content).toContain("# Code map (graphify)");
    expect(m.tags).toContain("graphify");
    expect(readFileSync(join(t.dir, ".flashmaster", "knowledge", `${CODE_MAP_SLUG}.md`), "utf8")).toContain("- **Engine** (3)");
    // Progress is visible while it runs, and ends idle.
    expect(t.events.map((e) => e.running)).toEqual(expect.arrayContaining(["Installing graphify…", "Scanning the code…", "Writing the knowledge base…"]));
    expect(t.events.at(-1)!.running).toBeNull();
  });

  it("reports a failed run, keeps no half entry and refuses a second scan of the same project while one runs", async () => {
    const t = setup();
    t.setAnswer(() => ({ code: 1, out: "Traceback…\nModuleNotFoundError: tree_sitter" }));
    await expect(t.cg.scan(t.p.id)).rejects.toThrow(/graphify failed: .*tree_sitter/);
    expect(t.cg.status(t.p.id).error).toMatch(/tree_sitter/);
    expect(t.store.getKnowledge(t.p.id, CODE_MAP_SLUG)).toBeNull();

    let release!: () => void;
    const slow = setup();
    const gate = new Promise<void>((r) => { release = r; });
    const cg = new CodeGraph({ db: slow.db, knowledge: slow.kb, python: () => "/py", install: vi.fn(), run: async () => { await gate; return { code: 0, out: "" }; } });
    const first = cg.scan(slow.p.id).catch((e) => e);
    await expect(cg.scan(slow.p.id)).rejects.toThrow(/already running/);
    release();
    expect(String(await first)).toMatch(/wrote no graph/);
  });
});

describe("code_graph questions", () => {
  it("maps commands to graphify's CLI against the project's graph and strips its notes", async () => {
    const t = setup();
    await expect(t.cg.ask(t.p.id, "query", { question: "how" })).rejects.toThrow(/Scan code/);
    await t.cg.scan(t.p.id);
    const graph = join(t.dir, ".flashmaster", "graphify", "graph.json");
    const out = await t.cg.ask(t.p.id, "query", { question: "how does the engine start", budget: 999999 });
    expect(out).toBe("NODE Engine [src=main.ts]");
    expect(t.calls.at(-1)!.args).toEqual(["-m", "graphify", "query", "how does the engine start", "--budget", "8000", "--graph", graph]);
    await t.cg.ask(t.p.id, "path", { from: "Engine", to: "Db" });
    expect(t.calls.at(-1)!.args.slice(2)).toEqual(["path", "Engine", "Db", "--undirected", "--graph", graph]);
    await t.cg.ask(t.p.id, "god_nodes", {});
    expect(t.calls.at(-1)!.args.slice(2, 5)).toEqual(["god-nodes", "--top", "15"]);
    await expect(t.cg.ask(t.p.id, "explain", {})).rejects.toThrow(/explain needs a node/);
    // Exit 4 (no match) and 3 (ambiguous) are answers, not failures.
    t.setAnswer(() => ({ code: 4, out: "no node matches 'Nope'" }));
    expect(await t.cg.ask(t.p.id, "explain", { node: "Nope" })).toContain("no node matches");
    t.setAnswer(() => ({ code: 2, out: "boom" }));
    await expect(t.cg.ask(t.p.id, "affected", { node: "Db" })).rejects.toThrow(/graphify affected failed/);
  });

  it("is a core agent tool scoped to the agent's project", async () => {
    const t = setup();
    await t.cg.scan(t.p.id);
    const tools = buildTools({ db: t.db, orch: {} as any, roles: () => [], jazz: () => null, emitTask: () => undefined, codeGraph: t.cg });
    const tool = tools.find((x) => x.name === "code_graph")!;
    expect(tool.set).toBe("core");
    const chat = t.db.createChat({ projectId: t.p.id, title: "c", kind: "project", agentRole: "flashmaster" });
    const agent = t.db.createAgent({ chatId: chat.id, projectId: t.p.id, role: "flashmaster", harness: "mock", model: null, brief: "b", parentAgentId: null });
    expect(await tool.handler({ command: "query", question: "engine" }, { agentId: agent.id } as any)).toEqual({ result: "NODE Engine [src=main.ts]" });
    await expect(tool.handler({ command: "drop" }, { agentId: agent.id } as any)).rejects.toThrow(/command must be one of/);
    expect(existsSync(join(t.dir, ".flashmaster", "graphify", "graph.json"))).toBe(true);
  });
});
