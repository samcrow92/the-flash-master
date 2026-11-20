import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callDetails, commandParts, evaluateRules, matchPath, parseRules, splitCommand, tokenize } from "../src/main/harness/rules";
import { decideCall, decidePermission } from "../src/main/harness/policy";
import { HookRunnerHost, hookMatches, hookVerdict, parseHooks, type HookRunner } from "../src/main/hooks";
import { checksFixPrompt, checksForParent, checksLine, loadChecks, parseCheckLines, runChecks, tailOutput, type CheckRunner } from "../src/main/checks";
import { Db } from "../src/main/db";
import { Orchestrator } from "../src/main/orchestrator";
import { HarnessRegistry } from "../src/main/harness/registry";
import { MockAdapter } from "../src/main/harness/mock";
import { loadRoles } from "../src/main/roles";
import { DEFAULT_RULES, DEFAULT_SETTINGS, mergeSettings, type Settings } from "../src/shared/settings";

Object.assign(process.env, { GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.com" });
const ID = ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main"];
const git = (cwd: string, ...args: string[]) => execFileSync("git", [...ID, ...args], { cwd, encoding: "utf8" });
function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "chk-repo-"));
  git(dir, "init", "-q");
  writeFileSync(join(dir, "a.c"), "int a;\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "init");
  return dir;
}
const until = async (fn: () => boolean, ms = 8000) => {
  const t = Date.now();
  while (!fn()) { if (Date.now() - t > ms) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 10)); }
};

describe("permission rules", () => {
  const { rules } = parseRules(DEFAULT_RULES + "\nask git push *\ntester: allow npm test *\nallow git status *\nallow git diff *\ndeny edit **/*.pem\ndeny fetch *");

  it("parses roles, kinds and comments, and reports bad lines", () => {
    expect(rules.find((r) => r.role === "tester")).toMatchObject({ action: "allow", kind: "execute", pattern: "npm test *" });
    expect(rules.find((r) => r.kind === "fetch")).toMatchObject({ action: "deny", pattern: "*" });
    expect(parseRules("# only a comment\n\npermit ls\ndeny").errors).toEqual(["line 3: start with allow, ask or deny", "line 4: missing a pattern"]);
  });

  it("splits compound commands and peels wrappers, so they can't slip past a rule", () => {
    expect(splitCommand(`echo "a && b" && git push; ls | wc -l`)).toEqual([`echo "a && b"`, "git push", "ls", "wc -l"]);
    expect(tokenize(`git commit -m "fix it"`)).toEqual(["git", "commit", "-m", "fix it"]);
    expect(commandParts(`sudo  FOO=1 env -i rm   -rf /`)).toEqual([["rm", "-rf", "/"]]);
    expect(commandParts(`cmd.exe /c "git push --force"`)).toEqual([["git", "push", "--force"]]);
    expect(commandParts(`bash -lc "make && git push -f origin"`)).toEqual([["make"], ["git", "push", "-f", "origin"]]);
    const ex = (command: string, role?: string) => evaluateRules(rules, { kind: "execute", command, role })?.decision ?? null;
    expect(ex("sudo rm -rf /")).toBe("deny");
    expect(ex("rm -rf /tmp/build")).toBe(null);
    expect(ex("npm run build && git push origin main --force")).toBe("deny");
    expect(ex("powershell -Command git push -f")).toBe("deny");
    expect(ex("GIT PUSH origin main")).toBe("ask"); // case-insensitive, as on Windows
    expect(ex("git push")).toBe("ask"); // "x *" also matches x alone
    expect(ex("git pushx")).toBe(null);
  });

  it("allows by rule only when every part is allowed, and scopes rules to roles", () => {
    const ex = (command: string, role?: string) => evaluateRules(rules, { kind: "execute", command, role })?.decision ?? null;
    expect(ex("git status && git diff")).toBe("allow");
    expect(ex("git status && make")).toBe(null);
    expect(ex("npm test -- --run", "tester")).toBe("allow");
    expect(ex("npm test", "coder")).toBe(null);
  });

  it("matches path rules on edits, deletes and moves, and kind rules on titles", () => {
    expect(matchPath("**/*.pem", "C:\\proj\\certs\\key.pem")).toBe(true);
    expect(matchPath("*.pem", "/p/x/key.pem")).toBe(true);
    expect(matchPath("**/.git/**", "/p/.git/config")).toBe(true);
    expect(matchPath("src/*.c", "/p/src/a.c")).toBe(true);
    expect(matchPath("src/*.c", "/p/src/sub/a.c")).toBe(false);
    expect(evaluateRules(rules, { kind: "edit", paths: ["/p/keys/a.pem"] })?.decision).toBe("deny");
    expect(evaluateRules(rules, { kind: "delete", paths: ["/p/keys/a.pem"] })?.decision).toBe("deny");
    expect(evaluateRules(rules, { kind: "edit", paths: ["/p/src/a.c"] })).toBe(null);
    expect(evaluateRules(rules, { kind: "fetch", title: "Fetch https://x" })?.decision).toBe("deny");
  });

  it("pulls the command and paths out of tool calls from different CLIs", () => {
    expect(callDetails({ command: ["git", "push"] }, null)).toEqual({ command: "git push", paths: [] });
    expect(callDetails({ cmd: "ls", file_path: "/p/a" }, [{ path: "/p/b" }])).toEqual({ command: "ls", paths: ["/p/a", "/p/b"] });
  });

  it("puts rules into the approval order: deny and ask beat Autopilot, allow skips asking", () => {
    const base = { approval: "auto-all" as const, readOnly: false, blocked: [], projectRoot: "/p", rules, role: "coder" };
    expect(decideCall(base, "execute", "Run git push", { command: "git push origin main" })).toEqual({ decision: "ask", rule: "ask git push *" });
    expect(decideCall(base, "execute", "Run", { command: "git push --force" }).decision).toBe("deny");
    expect(decideCall({ ...base, approval: "ask" }, "execute", "Run", { command: "git status" })).toEqual({ decision: "allow", rule: "allow git status *" });
    expect(decideCall({ ...base, readOnly: true }, "execute", "Run", { command: "git status" }).decision).toBe("deny");
    expect(decidePermission({ ...base, rules: undefined, blocked: ["rm -rf /"] }, "execute", "sudo RM -RF / now")).toBe("deny");
  });
});

describe("hooks", () => {
  it("parses hooks and matches them by event, command pattern or kind", () => {
    const { hooks, errors } = parseHooks("pre_tool git push * => node guard.js\npost_tool edit => fmt\nturn_end => notify\nbefore_all => x\npre_tool nothing");
    expect(errors).toEqual(["line 4: event must be one of pre_tool, post_tool, turn_end, checks_done", "line 5: write <event> [match] => <command>"]);
    expect(hooks.map((h) => [h.event, h.match, h.command])).toEqual([["pre_tool", "git push *", "node guard.js"], ["post_tool", "edit", "fmt"], ["turn_end", "*", "notify"]]);
    expect(hookMatches(hooks[0]!, { event: "pre_tool", kind: "execute", command: "make && git push origin" })).toBe(true);
    expect(hookMatches(hooks[0]!, { event: "pre_tool", kind: "execute", command: "git status" })).toBe(false);
    expect(hookMatches(hooks[1]!, { event: "post_tool", kind: "edit" })).toBe(true);
    expect(hookMatches(hooks[1]!, { event: "post_tool", kind: "read" })).toBe(false);
  });

  it("reads a pre_tool verdict from exit code 2 or a JSON line", () => {
    expect(hookVerdict(2, "", "pushing to main is not allowed")).toEqual({ decision: "deny", reason: "pushing to main is not allowed" });
    expect(hookVerdict(0, 'checking…\n{"decision":"ask","reason":"release branch"}', "")).toEqual({ decision: "ask", reason: "release branch" });
    expect(hookVerdict(1, "boom", "")).toEqual({ decision: null, reason: null });
  });

  it("runs matching hooks with the event on stdin and in FLASH_* variables; the strongest verdict wins", async () => {
    const calls: { command: string; stdin: string; env: Record<string, string> }[] = [];
    const runner: HookRunner = async (command, stdin, env) => {
      calls.push({ command, stdin, env });
      return command === "deny" ? { code: 2, out: "", err: "no" } : { code: 0, out: '{"decision":"allow"}', err: "" };
    };
    const logs: string[] = [];
    const host = new HookRunnerHost(() => parseHooks("pre_tool git * => allow\npre_tool git push * => deny\npost_tool => log").hooks, runner, (l) => logs.push(l));
    expect(await host.preTool({ kind: "execute", title: "Run", command: "git push", agentId: "a1", role: "coder" })).toEqual({ decision: "deny", reason: "no", hook: "pre_tool git push * => deny" });
    expect(await host.preTool({ kind: "execute", title: "Run", command: "git status" })).toMatchObject({ decision: "allow" });
    expect(JSON.parse(calls[0]!.stdin)).toMatchObject({ event: "pre_tool", command: "git push", agentId: "a1" });
    expect(calls[0]!.env).toMatchObject({ FLASH_HOOK_EVENT: "pre_tool", FLASH_COMMAND: "git push", FLASH_ROLE: "coder" });
    expect(host.has("turn_end")).toBe(false);
    expect(logs).toEqual([]);
  });
});

describe("checks before merge", () => {
  it("reads checks from the project file first, then the settings lines", () => {
    expect(parseCheckLines("Unit tests: npm test\n# skip\nC:\\tools\\lint.exe src\nmake")).toEqual([
      { name: "Unit tests", command: "npm test" }, { name: "C:\\tools\\lint.exe src", command: "C:\\tools\\lint.exe src" }, { name: "make", command: "make" }]);
    const p = mkdtempSync(join(tmpdir(), "chk-"));
    expect(loadChecks(p, "make test")).toEqual({ checks: [{ name: "make test", command: "make test" }], source: "settings" });
    expect(loadChecks(p, "")).toEqual({ checks: [], source: "none" });
    mkdirSync(join(p, ".flashmaster"));
    writeFileSync(join(p, ".flashmaster", "checks.json"), JSON.stringify({ checks: [{ name: "Build", command: "cmake --build b", timeoutMinutes: 20 }, "ctest"] }));
    expect(loadChecks(p, "make test")).toEqual({ source: "project", checks: [{ name: "Build", command: "cmake --build b", timeoutMinutes: 20 }, { name: "ctest", command: "ctest" }] });
    writeFileSync(join(p, ".flashmaster", "checks.json"), "{ nope");
    expect(loadChecks(p, "make").error).toMatch(/not valid JSON/);
  });

  it("runs every check, keeps the end of the output and words the follow-up", async () => {
    const runner: CheckRunner = async (command) => command === "lint" ? { code: 1, out: "\x1b[31merror\x1b[0m: a.c:3 unused x", timedOut: false } : { code: 0, out: "ok", timedOut: false };
    let t = 0;
    const run = await runChecks("/w", [{ name: "Lint", command: "lint" }, { name: "Tests", command: "test" }], { runner, defaultTimeoutMinutes: 1, head: "abc", now: () => (t += 1000) });
    expect(run).toMatchObject({ ok: false, head: "abc", dirty: false });
    expect(run.results.map((r) => [r.name, r.ok, r.output])).toEqual([["Lint", false, "error: a.c:3 unused x"], ["Tests", true, "ok"]]);
    expect(checksLine(run)).toBe("✗ 1/2 checks failed: Lint");
    expect(checksFixPrompt(run, 1, 2)).toMatch(/round 1 of 2[\s\S]*### Lint — `lint` exited 1[\s\S]*a\.c:3 unused x[\s\S]*Don't weaken, skip or delete tests/);
    expect(checksForParent(run, true)).toMatch(/^checks: ✗ 1\/2[\s\S]*can't be merged/);
    expect(tailOutput("x".repeat(5000), 100)).toHaveLength(102);
  });

  function setup(runner: CheckRunner) {
    const db = new Db(":memory:");
    const settings = mergeSettings(DEFAULT_SETTINGS, { general: { defaultHarness: "mock" }, checks: { commands: "Tests: run-tests" } }) as Settings;
    const roles = loadRoles(join(__dirname, "..", "agents"), "/none");
    const orch = new Orchestrator({ db, harnesses: new HarnessRegistry([new MockAdapter(1)]), settings: () => settings, roles: () => roles, checkRunner: runner,
      skills: () => [], emit: () => undefined, mcpServersFor: () => [], homeDir: tmpdir(), dataDir: mkdtempSync(join(tmpdir(), "data-")) });
    return { db, orch, settings };
  }

  it("runs the checks when a specialist finishes new work and sends failures back to it before it reports", async () => {
    let calls = 0;
    const { db, orch } = setup(async () => (++calls === 1 ? { code: 1, out: "FAIL test_a", timedOut: false } : { code: 0, out: "ok", timedOut: false }));
    const p = db.createProject("p", repo());
    const chat = db.createChat({ projectId: p.id, title: "c", kind: "project", agentRole: "flashmaster" });
    await orch.sendUserMessage(chat.id, "hello", null);
    await until(() => db.listAgents({}).some((x) => x.role === "flashmaster" && x.status === "idle"));
    const parentId = db.listAgents({}).find((x) => x.role === "flashmaster")!.id;
    const r = await orch.delegate(parentId, { role: "tester", goal: "Add a test" });
    expect(calls).toBe(0); // nothing new on the branch yet: no checks
    const a = db.getAgent(r.agentId)!;
    writeFileSync(join(a.worktree!, "t.c"), "int t;\n");
    git(a.worktree!, "add", "-A");
    git(a.worktree!, "commit", "-qm", "test");
    const back = await orch.requestWorkFixes(a.id, [{ path: "t.c", line: 1, side: "new", code: "int t;", text: "Rename" }]);
    expect(back).toBeTruthy();
    await until(() => calls >= 2 && db.getAgent(a.id)!.status !== "running");
    const sys = (db.raw.prepare("SELECT content FROM messages WHERE chat_id=?").all(chat.id) as { content: string }[]).map((m) => m.content);
    expect(sys.some((c) => /check failed: Tests, so it was sent back to fix them/.test(c))).toBe(true);
    const st = await orch.agentChecks(a.id);
    expect(st).toMatchObject({ source: "settings", current: true, running: false, requireForMerge: true });
    expect(st.last?.ok).toBe(true);
    // A green run of the current commit: Merge doesn't run them again.
    expect((await orch.mergeWork(a.id)).ok).toBe(true);
    expect(calls).toBe(2);
    await orch.stopAll();
  });

  it("refuses to merge a branch whose checks fail, unless the user merges anyway", async () => {
    let calls = 0;
    const { db, orch } = setup(async () => { calls++; return { code: 1, out: "FAIL", timedOut: false }; });
    const p = db.createProject("p", repo());
    const chat = db.createChat({ projectId: p.id, title: "c", kind: "project", agentRole: "flashmaster" });
    const tester = loadRoles(join(__dirname, "..", "agents"), "/none").find((x) => x.name === "tester")!;
    await (orch as any).turn({ chat, threadRoot: null, role: tester, input: "Add a test", skills: [], depth: 1, brief: "Goal: add a test" });
    const a = db.listAgents({}).find((x) => x.role === "tester")!;
    writeFileSync(join(a.worktree!, "t.c"), "int t;\n");
    git(a.worktree!, "add", "-A");
    git(a.worktree!, "commit", "-qm", "t");
    const refused = await orch.mergeWork(a.id);
    expect(refused).toEqual({ ok: false, message: "Not merged: ✗ 1/1 check failed: Tests. Send it back to the agent, or merge anyway." });
    expect(calls).toBe(1);
    expect((await orch.mergeWork(a.id, true)).ok).toBe(true);
    await orch.stopAll();
  });
});
