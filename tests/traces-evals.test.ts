import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TraceStore, toOtlp, waterfall } from "../src/main/traces";
import { EvalRunner, loadSuites, parseTarget, regressions, scoreCase, type Observed } from "../src/main/evals";
import { Db } from "../src/main/db";
import { Orchestrator } from "../src/main/orchestrator";
import { HarnessRegistry } from "../src/main/harness/registry";
import { MockAdapter } from "../src/main/harness/mock";
import { loadRoles } from "../src/main/roles";
import { DEFAULT_SETTINGS, mergeSettings, type Settings } from "../src/shared/settings";
import type { EvalCaseResult, EvalProgress } from "../src/shared/types";

Object.assign(process.env, { GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.com" });
const ID = ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main"];
const git = (cwd: string, ...args: string[]) => execFileSync("git", [...ID, ...args], { cwd, encoding: "utf8" });
function repo(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "te-repo-"));
  git(dir, "init", "-q");
  writeFileSync(join(dir, "a.c"), "int a;\n");
  for (const [f, t] of Object.entries(files)) { mkdirSync(join(dir, f, ".."), { recursive: true }); writeFileSync(join(dir, f), t); }
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "init");
  return dir;
}
const until = async (fn: () => boolean, ms = 8000) => {
  const t = Date.now();
  while (!fn()) { if (Date.now() - t > ms) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 10)); }
};
function setup() {
  const db = new Db(":memory:");
  const settings = mergeSettings(DEFAULT_SETTINGS, { general: { defaultHarness: "mock" } }) as Settings;
  const roles = loadRoles(join(__dirname, "..", "agents"), "/none");
  const traces = new TraceStore(db.raw);
  const orch = new Orchestrator({ db, harnesses: new HarnessRegistry([new MockAdapter(1)]), settings: () => settings, roles: () => roles, traces,
    skills: () => [], emit: () => undefined, mcpServersFor: () => [], homeDir: tmpdir(), dataDir: mkdtempSync(join(tmpdir(), "data-")) });
  return { db, orch, settings, traces };
}

describe("trace store", () => {
  it("records spans, lists traces, prunes old ones and closes dangling spans", () => {
    const db = new Db(":memory:");
    let t = 1_000;
    const ts = new TraceStore(db.raw, () => true, () => t);
    const root = ts.start({ traceId: "a".repeat(32), chatId: "c1", kind: "request", name: "Fix the flicker" });
    t = 2_000;
    const turn = ts.start({ traceId: "a".repeat(32), parentId: root, chatId: "c1", kind: "turn", name: "turn", agentId: "ag1" });
    const tool = ts.start({ traceId: "a".repeat(32), parentId: turn, chatId: "c1", kind: "tool", name: "Read a.c", agentId: "ag1" });
    t = 2_500;
    ts.end(tool, { status: "error" });
    ts.annotate(turn, { "gen_ai.usage.input_tokens": 120, "gen_ai.usage.output_tokens": 30 });
    t = 3_000;
    ts.end(turn);
    ts.end(turn, { status: "error" }); // ended once already: ignored
    ts.end(root, { touch: true });
    expect(ts.list()).toEqual([{ traceId: "a".repeat(32), chatId: "c1", name: "Fix the flicker", start: 1000, end: 3000, spans: 3, tokens: 150, agents: 1, errors: 1, running: false }]);
    expect(waterfall(ts.spans("a".repeat(32))).map((r) => [r.span.name, r.depth])).toEqual([["Fix the flicker", 0], ["turn", 1], ["Read a.c", 2]]);
    const otlp = toOtlp(ts.spans("a".repeat(32))) as any;
    const spans = otlp.resourceSpans[0].scopeSpans[0].spans;
    expect(spans[1]).toMatchObject({ parentSpanId: root, startTimeUnixNano: "2000000000", endTimeUnixNano: "3000000000", status: { code: 1 } });
    expect(spans[1].attributes).toContainEqual({ key: "gen_ai.usage.input_tokens", value: { intValue: "120" } });
    expect(spans[2]).toMatchObject({ kind: 3, status: { code: 2 } });
    ts.start({ traceId: "b".repeat(32), kind: "turn", name: "left open" });
    ts.closeDangling();
    expect(ts.spans("b".repeat(32))[0]).toMatchObject({ status: "stopped" });
    t = 3_000 + 31 * 86_400_000;
    expect(ts.prune(30)).toBe(4);
    expect(new TraceStore(db.raw, () => false).start({ traceId: "x", kind: "turn", name: "off" })).toBe("");
  });

  it("traces a request through the coordinator's turns, a delegation and the specialist's turn", async () => {
    const { db, orch, traces } = setup();
    const p = db.createProject("p", repo());
    const chat = db.createChat({ projectId: p.id, title: "c", kind: "project", agentRole: "flashmaster" });
    await orch.sendUserMessage(chat.id, "Look at the CAN log", null);
    await until(() => db.listAgents({}).some((x) => x.role === "flashmaster" && x.status === "idle"));
    const coord = db.listAgents({}).find((x) => x.role === "flashmaster")!;
    await orch.delegate(coord.id, { role: "analyst", goal: "Summarise the CAN log" });
    const [t] = traces.list({ chatId: chat.id });
    const rows = waterfall(traces.spans(t!.traceId)).filter((r) => r.span.kind !== "tool");
    expect(rows.map((r) => `${"  ".repeat(r.depth)}${r.span.kind}`)).toEqual(["request", "  turn", "  delegate", "    turn"]);
    const turn = rows[1]!.span;
    expect(turn.attrs).toMatchObject({ "gen_ai.operation.name": "chat", "gen_ai.provider.name": "mock", "flash.role": "flashmaster" });
    expect(Number(turn.attrs["gen_ai.usage.input_tokens"])).toBeGreaterThan(0);
    expect(rows[2]!.span).toMatchObject({ status: "ok", attrs: expect.objectContaining({ "gen_ai.operation.name": "invoke_agent", "flash.role": "analyst" }) });
    expect(t).toMatchObject({ agents: 2, errors: 0, running: false });
    await orch.stopAll();
  });
});

describe("evals", () => {
  it("loads suites, reads targets and scores runs against their expectations", () => {
    const dir = repo({ ".flashmaster/evals/golden.json": JSON.stringify({ name: "Golden", targets: ["", "pi/qwen-local/qwen3"], cases: [
      { id: "c1", prompt: "Do it", expect: { status: "done" } }, { id: "bad" }] }), ".flashmaster/evals/broken.json": "{" });
    const suites = loadSuites(dir);
    expect(suites.map((s) => [s.file, s.name, s.cases.length, !!s.error])).toEqual([["broken.json", "broken.json", 0, true], ["golden.json", "Golden", 1, false]]);
    expect(parseTarget("pi/qwen-local/qwen3")).toEqual({ harness: "pi", model: "qwen-local/qwen3", label: "pi/qwen-local/qwen3" });
    expect(parseTarget("")).toEqual({ harness: null, model: null, label: "default" });
    const o: Observed = { status: "done", reply: "Debounce fixed: 20 ms", tokens: 5000, ms: 90_000, timedOut: false, checksOk: true, files: { "t.c": true, "u.c": false } };
    const s = scoreCase({ status: "done", checks: true, files: ["t.c", "u.c"], contains: ["debounce"], regex: "20\\s*ms", maxTokens: 4000, maxMinutes: 2 }, o);
    expect(s.assertions.filter((a) => !a.ok).map((a) => a.name)).toEqual(["file u.c", "≤ 4,000 tokens"]);
    expect(s).toMatchObject({ passed: false, score: 7 / 9 });
  });

  it("flags a case that passed in the previous batch and fails now, or costs much more", () => {
    const r = (id: string, batch: string, passed: boolean, tokens: number, caseId = "c1"): EvalCaseResult =>
      ({ id, suite: "g.json", caseId, target: "", batch, projectId: "p", passed, score: passed ? 1 : 0, tokens, ms: 1, traceId: null, at: 1, assertions: [], reply: "" });
    const flags = regressions([r("n1", "b2", false, 100), r("n2", "b2", true, 90_000, "c2"), r("n3", "b2", true, 100, "c3")],
      [r("o1", "b1", true, 100), r("o2", "b1", true, 40_000, "c2"), r("o3", "b1", false, 100, "c3")]);
    expect([...flags]).toEqual([["n1", "passed before, fails now"], ["n2", "tokens up 125%"]]);
  });

  it("runs a case in a throwaway copy on its target, scores it, stores it and cleans up", async () => {
    const { db, orch, settings, traces } = setup();
    const dir = repo({ ".flashmaster/evals/golden.json": JSON.stringify({ name: "Golden", targets: [""], cases: [
      { id: "summary", title: "Summarise", prompt: "Summarise the CAN log", timeoutMinutes: 1, expect: { status: "done", contains: ["mock"], checks: true, maxTokens: 10_000_000 } }] }) });
    settings.checks.commands = "Tests: run-tests";
    const p = db.createProject("brake", dir);
    const progress: EvalProgress[] = [];
    const runner = new EvalRunner({ db, orch, settings: () => settings, emit: (x) => progress.push(x), traces, pollMs: 20, checkRunner: async () => ({ code: 0, out: "ok", timedOut: false }) });
    const [res] = await runner.run(p.id);
    expect(res).toMatchObject({ caseId: "summary", target: "", passed: true, score: 1 });
    expect(res!.assertions.map((a) => a.name)).toEqual(["finished", "status done", "checks pass", 'reply mentions "mock"', "≤ 10,000,000 tokens"]);
    expect(res!.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(traces.list().find((t) => t.traceId === res!.traceId)?.name).toBe("Eval · Summarise (default)");
    expect(db.listEvalRuns(p.id).map((r) => r.id)).toEqual([res!.id]);
    expect(db.listProjects().map((x) => x.name)).toEqual(["brake"]); // the eval project and chat are gone
    expect(existsSync(join(dir, ".wt", `eval-${res!.id.slice(0, 8)}`))).toBe(false);
    expect(git(dir, "branch", "--list", "flash/eval-*").trim()).toBe("");
    expect(progress.at(-1)).toMatchObject({ running: false, done: 1, total: 1 });
    await orch.stopAll();
  });
});
