/**
 * GitLab Duo outside GitLab projects: Duo needs a GitLab project (from the folder's git remote) or a default Duo
 * namespace, and failed with only its shutdown log in GitHub repos and plain folders. Settings → Harnesses → GitLab Duo
 * names a project, passed through Duo's own GITLAB_PROJECT_PATH / GITLAB_BASE_URL, and failures show Duo's [error] lines.
 */
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DuoAdapter, DuoSession, duoContextEnv, duoFailure, hasGitLabRemote, parseDuoProject, remoteHosts, type DuoContext } from "../src/main/harness/duo";
import { DEFAULT_SETTINGS } from "../src/shared/settings";
import type { HarnessEvent, SessionOptions } from "../src/main/harness/types";

const ctx = (project: string, extra: Partial<DuoContext> = {}): DuoContext => ({ project, instanceUrl: "", always: false, ...extra });

// Mari's report: the real error scrolls away and only the shutdown lines were shown.
const NO_NAMESPACE_LOG = [
  "2026-11-16T15:22:05:500 [debug]: [GitLabBackend] No project path found in config. Falling back to user's configured default Duo namespace.",
  "2026-11-16T15:22:05:600 [error]: Failed to initialize workflow: Workflow ID not available after initialization",
  "2026-11-16T15:22:05:700 [debug]: [HookService] Skipping SessionEnd hooks: no active session",
  "2026-11-16T15:22:05:711 [debug]: [WorkflowTokenService] Disposed token service, cleared all tokens and timeouts",
  "2026-11-16T15:22:05:712 [info]: [ExecutorManager] Disposing ExecutorManager (0 active executors)",
  "2026-11-16T15:22:05:714 [info]: [MCP Manager] Disposing service",
  "2026-11-16T15:22:05:735 [info]: [CliExitHandler] Shutdown complete, good bye :)",
].join("\n");

describe("Duo project setting", () => {
  it("defaults to off", () => {
    expect(DEFAULT_SETTINGS.duo).toEqual({ project: "", instanceUrl: "", always: false });
    expect(duoContextEnv(DEFAULT_SETTINGS.duo, "")).toEqual({});
  });

  it("accepts a path or a pasted project URL", () => {
    expect(parseDuoProject("group/sub/proj")).toEqual({ path: "group/sub/proj", baseUrl: "" });
    expect(parseDuoProject(" https://gitlab.example.com/group/proj.git ")).toEqual({ path: "group/proj", baseUrl: "https://gitlab.example.com" });
    expect(parseDuoProject("https://gitlab.com/group/proj/-/merge_requests/3")).toEqual({ path: "group/proj", baseUrl: "https://gitlab.com" });
    expect(parseDuoProject("group/proj", "https://git.corp/")).toEqual({ path: "group/proj", baseUrl: "https://git.corp" });
    expect(parseDuoProject("justaname")).toBeNull();
  });

  it("reads remote hosts in every git URL form", () => {
    const remotes = "origin\thttps://github.com/me/app.git (fetch)\nlab\tgit@gitlab.example.com:g/p.git (push)\nother\tssh://git@git.corp:2222/g/p.git (fetch)\n";
    expect(remoteHosts(remotes).sort()).toEqual(["git.corp", "github.com", "gitlab.example.com"]);
    expect(hasGitLabRemote("origin\thttps://github.com/me/app.git (fetch)", "")).toBe(false);
    expect(hasGitLabRemote("origin\tgit@gitlab.com:me/app.git (fetch)", "")).toBe(true);
    expect(hasGitLabRemote("origin\thttps://git.corp/g/p.git (fetch)", "https://git.corp")).toBe(true);
  });

  it("only steps in where Duo can't find a project itself, unless told to always", () => {
    const want = { GITLAB_PROJECT_PATH: "group/proj" };
    expect(duoContextEnv(ctx("group/proj"), "")).toEqual(want); // plain folder / not git
    expect(duoContextEnv(ctx("group/proj"), "origin\thttps://github.com/me/app.git (fetch)")).toEqual(want);
    expect(duoContextEnv(ctx("group/proj"), "origin\tgit@gitlab.com:me/app.git (fetch)")).toEqual({});
    expect(duoContextEnv(ctx("group/proj", { always: true }), "origin\tgit@gitlab.com:me/app.git (fetch)")).toEqual(want);
    expect(duoContextEnv(ctx("https://git.corp/group/proj"), "")).toEqual({ GITLAB_PROJECT_PATH: "group/proj", GITLAB_BASE_URL: "https://git.corp" });
  });

  it("shows Duo's error line and what to do, not the shutdown chatter", () => {
    const msg = duoFailure(NO_NAMESPACE_LOG, 1);
    expect(msg).toContain("Workflow ID not available");
    expect(msg).toContain("Settings → Harnesses → GitLab Duo");
    expect(msg).not.toContain("good bye");
    const bad = duoFailure("2026-11-16T15:22:05:500 [warn]: [GitLabBackend] Failed to fetch project details for nope/nope. Some features may be unavailable.\n" + NO_NAMESPACE_LOG, 1, "nope/nope");
    expect(bad).toContain('could not open the GitLab project "nope/nope"');
    expect(duoFailure("boom: command not found", 127)).toBe("duo exited with 127: boom: command not found");
  });
});

describe("Duo session", () => {
  const dir = mkdtempSync(join(tmpdir(), "duo-ctx-"));
  // Prints the project env it got; fails like real Duo when there is none.
  const fake = join(dir, "fake-duo.mjs");
  writeFileSync(fake, `const p = process.env.GITLAB_PROJECT_PATH;
if (p) { process.stdout.write("project=" + p + " base=" + (process.env.GITLAB_BASE_URL ?? "") + "\\n"); process.exit(0); }
process.stderr.write(${JSON.stringify(NO_NAMESPACE_LOG + "\n")}); process.exit(1);`);

  const run = async (cwd: string, context?: DuoContext) => {
    const events: HarnessEvent[] = [];
    const o = { cwd, model: null, extraArgs: "", executable: null, mcpServers: [], env: {}, resumeSessionId: null,
      policy: { approval: "auto-all", readOnly: false, blocked: [], projectRoot: cwd }, onEvent: (e: HarnessEvent) => events.push(e),
      askPermission: async () => true } as SessionOptions;
    const s = new DuoSession(process.execPath, [fake], o, () => context);
    const r = await s.prompt("hi");
    return { r, text: events.map((e) => (e.type === "text" ? e.text : "")).join("") };
  };
  const repo = (remote: string) => {
    const d = mkdtempSync(join(tmpdir(), "duo-repo-"));
    execFileSync("git", ["init", "-q"], { cwd: d });
    execFileSync("git", ["remote", "add", "origin", remote], { cwd: d });
    return d;
  };

  it("runs in a GitHub repo with the configured project", async () => {
    const { r, text } = await run(repo("https://github.com/me/app.git"), ctx("https://gitlab.example.com/group/proj"));
    expect(r.stopReason).toBe("end_turn");
    expect(text).toContain("project=group/proj base=https://gitlab.example.com");
  });

  it("leaves GitLab projects to Duo's own detection", async () => {
    const { r } = await run(repo("git@gitlab.com:me/app.git"), ctx("group/proj"));
    expect(r.stopReason).toBe("error"); // the fake only succeeds when we pass a project
  });

  it("explains the failure when nothing is configured", async () => {
    const { r } = await run(mkdtempSync(join(tmpdir(), "duo-plain-")));
    expect(r.error).toContain("Workflow ID not available");
    expect(r.error).toContain("GitLab project for Duo");
  });

  it("the adapter hands the setting to its sessions", async () => {
    const a = new DuoAdapter(() => ctx("group/proj"));
    const s = await a.start({ cwd: dir, executable: "duo" } as SessionOptions);
    expect((s as any).getContext()).toEqual(ctx("group/proj"));
  });
});
