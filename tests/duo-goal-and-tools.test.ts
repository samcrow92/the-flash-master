/**
 * Mari: "spawn ENAMETOOLONG when restarting the app and trying to continue with a duo agent", and "I want to see the tool
 * calls and what is he doing in background". A restarted chat sends Duo its rules + history as the first goal, which went
 * on the command line (`duo run --goal …`) and was far past Windows' limit. Now the goal goes in DUO_WORKFLOW_GOAL, and a
 * goal too long for one variable is saved in an ignored file in the repo that Duo is asked to read. Duo's log lines for
 * tool calls become tool-call blocks in the chat, like the other harnesses.
 */
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DUO_GOAL_DIR, DUO_GOAL_ENV_MAX, DuoAdapter, DuoSession, DuoToolLog, duoGoal, duoToolKind } from "../src/main/harness/duo";
import { MockAdapter } from "../src/main/harness/mock";
import { HarnessRegistry } from "../src/main/harness/registry";
import { Db } from "../src/main/db";
import { Orchestrator } from "../src/main/orchestrator";
import { loadRoles, loadSkills } from "../src/main/roles";
import { DEFAULT_SETTINGS, mergeSettings, type Settings } from "../src/shared/settings";
import type { HarnessEvent, SessionOptions } from "../src/main/harness/types";

const FAKE_DUO = join(__dirname, "fixtures", "fake-duo.mjs");
const until = async (fn: () => boolean, ms = 15000) => {
  const t = Date.now();
  while (!fn()) { if (Date.now() - t > ms) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 10)); }
};
const gitlabRepo = () => {
  const d = mkdtempSync(join(tmpdir(), "duo-goal-"));
  execFileSync("git", ["init", "-q"], { cwd: d });
  execFileSync("git", ["remote", "add", "origin", "git@gitlab.com:me/lab.git"], { cwd: d });
  return d;
};
const session = (cwd: string, events: HarnessEvent[], resume: string | null = null) =>
  new DuoSession(process.execPath, [FAKE_DUO], { cwd, env: {}, extraArgs: "", model: null, resumeSessionId: resume,
    onEvent: (e: HarnessEvent) => events.push(e) } as unknown as SessionOptions);
const text = (events: HarnessEvent[]) => events.filter((e) => e.type === "text").map((e) => (e as { text: string }).text).join("");
const tools = (events: HarnessEvent[]) => events.filter((e) => e.type === "tool") as Extract<HarnessEvent, { type: "tool" }>[];

describe("the goal reaches Duo without the command line", () => {
  it("a multi-line goal goes in DUO_WORKFLOW_GOAL, also when resuming", async () => {
    const events: HarnessEvent[] = [];
    const goal = `Rules:\n${"- keep it short\n".repeat(600)}Continue the brake light work.`; // ~9 KB: past cmd.exe's 8,191
    const res = await session(gitlabRepo(), events, "abc-123").prompt(goal);
    expect(res).toEqual({ stopReason: "end_turn" });
    expect(text(events)).toContain("(resumed) Goal was: Rules: - keep it short");
  });

  it("a goal too long for one variable (a restarted chat's rules + history) is read from an ignored file, then removed", async () => {
    const cwd = gitlabRepo();
    const events: HarnessEvent[] = [];
    const goal = `History:\n${"user: tune the brake light timing please\n".repeat(5000)}END`; // ~200 KB: past every limit
    expect(goal.length).toBeGreaterThan(DUO_GOAL_ENV_MAX);
    const res = await session(cwd, events).prompt(goal);
    expect(res).toEqual({ stopReason: "end_turn" });
    expect(text(events)).toContain("Goal was: (from file) History: user: tune the brake light timing please");
    expect(readdirSync(join(cwd, DUO_GOAL_DIR))).toEqual([".gitignore"]); // the goal file is gone after the turn
    expect(readFileSync(join(cwd, DUO_GOAL_DIR, ".gitignore"), "utf8")).toBe("*\n");
    expect(execFileSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8" })).toBe(""); // git never sees it
  });

  it("short goals stay in the environment and long ones point at a file inside the repo", () => {
    expect(duoGoal("hi", "/r", "x")).toEqual({ env: "hi", file: null });
    const g = duoGoal("y".repeat(DUO_GOAL_ENV_MAX + 1), "/r", "s1");
    expect(g.file?.path).toBe(join("/r", DUO_GOAL_DIR, "goal-s1.md"));
    expect(g.env).toContain(`${DUO_GOAL_DIR}/goal-s1.md`);
    expect(g.env.length).toBeLessThan(400);
  });
});

describe("Duo's tool calls show as tool-call blocks", () => {
  it("reads started, input, completed and error lines from the log", () => {
    const log = new DuoToolLog("t");
    const p = (l: string) => log.feed(`2026-11-19T07:00:00.000Z [info]: ${l}`);
    expect(p("Tool started: read_file")).toEqual([{ type: "tool", id: "t-1", title: "read_file", status: "in_progress", kind: "read" }]);
    expect(p('Tool input: {"file_path":"src/a.c"}')).toEqual([{ type: "tool", id: "t-1", title: "read_file: src/a.c", status: "in_progress", kind: "read", input: '{"file_path":"src/a.c"}' }]);
    expect(p("Tool completed: toolu_1")[0]).toMatchObject({ id: "t-1", status: "completed" });
    p("Tool started: run_command");
    expect(p("Tool completed: toolu_2")[0]).toMatchObject({ id: "t-2", status: "completed", title: "run_command" });
    expect(p("Tool error: exit 2")[0]).toMatchObject({ id: "t-2", status: "failed", output: "exit 2" });
    expect(p("Delegating to researcher...")[0]).toMatchObject({ title: "Delegate to researcher", status: "in_progress" });
    expect(p("Reading src/a.c")).toEqual([]);
    p("Tool started: grep");
    expect(log.finish(false)[0]).toMatchObject({ title: "grep", status: "failed" });
  });

  it("names the kind of common Duo tools", () => {
    expect(["read_file", "list_dir", "find_files", "grep", "edit_file", "create_file_with_contents", "run_command", "run_git_command", "mkdir"].map(duoToolKind))
      .toEqual(["read", "read", "search", "search", "edit", "edit", "execute", "execute", "edit"]);
  });

  it("a running Duo session streams its tool calls", async () => {
    const events: HarnessEvent[] = [];
    await session(gitlabRepo(), events).prompt("TOOLS please");
    const last = new Map(tools(events).map((t) => [t.id, t]));
    expect([...last.values()].map((t) => [t.title, t.status, t.kind])).toEqual([
      ["read_file: src/brake_light.c", "completed", "read"],
      ["run_command: make test", "completed", "execute"],
      ["grep: TODO", "completed", "search"],
      ["edit_file: README.md", "failed", "edit"],
    ]);
  });

  it("the chat keeps Duo's tool calls on the reply", async () => {
    class FakeDuo extends DuoAdapter {
      override async start(o: SessionOptions) { await super.start(o); return new DuoSession(process.execPath, [FAKE_DUO], o); }
    }
    const db = new Db(":memory:");
    const settings = mergeSettings(DEFAULT_SETTINGS, { general: { defaultHarness: "duo" }, agents: { toolMode: "auto" } } as any) as Settings;
    const harnesses = new HarnessRegistry([new MockAdapter(15), new FakeDuo()]);
    (harnesses as any).status.set("duo", { id: "duo", available: true, path: process.execPath });
    const orch = new Orchestrator({ db, harnesses, settings: () => settings, roles: () => loadRoles(join(__dirname, "..", "agents"), "/none"),
      skills: () => loadSkills(join(__dirname, "..", "skills", "superpowers")), emit: () => {}, mcpServersFor: () => [], homeDir: tmpdir() } as any);
    const project = db.createProject("lab", gitlabRepo());
    const chat = db.createChat({ projectId: project.id, title: "c", kind: "project", agentRole: "flashmaster", harness: "duo" } as any);
    await orch.sendUserMessage(chat.id, "TOOLS: look at the brake light", null);
    const reply = () => db.listMessages(chat.id, null).find((m) => m.author === "agent");
    await until(() => reply()?.status === "done" || reply()?.status === "error");
    expect(reply()?.status).toBe("done");
    expect((reply()?.tools ?? []).map((t) => t.title)).toEqual(["read_file: src/brake_light.c", "run_command: make test", "grep: TODO", "edit_file: README.md"]);
    expect(existsSync(join(project.path, DUO_GOAL_DIR, "goal-x.md"))).toBe(false);
  });
});
