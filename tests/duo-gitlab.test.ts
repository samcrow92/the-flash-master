/**
 * GitLab Duo works on the GitLab project behind the folder's git remote and failed (showing only its shutdown log)
 * anywhere else. Duo agents now only start in GitLab repos, the coordinator can start one in another folder that is
 * one, and a failed run shows Duo's [error] lines.
 */
import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DuoAdapter, DuoSession, duoFailure, duoGitlabHosts, gitlabRepoProblem, hasGitLabRemote, hostList, remoteHosts } from "../src/main/harness/duo";
import { MockAdapter } from "../src/main/harness/mock";
import { HarnessRegistry } from "../src/main/harness/registry";
import { Db } from "../src/main/db";
import { Orchestrator } from "../src/main/orchestrator";
import { loadRoles, loadSkills } from "../src/main/roles";
import { parseTextDelegations } from "../src/main/context";
import { DEFAULT_SETTINGS, mergeSettings, type Settings } from "../src/shared/settings";
import type { SessionOptions } from "../src/main/harness/types";

const FAKE_DUO = join(__dirname, "fixtures", "fake-duo.mjs");
const until = async (fn: () => boolean, ms = 10000) => {
  const t = Date.now();
  while (!fn()) { if (Date.now() - t > ms) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 10)); }
};
const plainDir = () => mkdtempSync(join(tmpdir(), "duo-plain-"));
const repo = (remote: string) => {
  const d = mkdtempSync(join(tmpdir(), "duo-repo-"));
  execFileSync("git", ["init", "-q"], { cwd: d });
  execFileSync("git", ["remote", "add", "origin", remote], { cwd: d });
  return d;
};

// Mari's report: the real error scrolls away and only the shutdown lines were shown.
const FAILED_LOG = [
  "2026-11-16T15:22:05:600 [error]: Failed to initialize workflow: Workflow ID not available after initialization",
  "2026-11-16T15:22:05:700 [debug]: [HookService] Skipping SessionEnd hooks: no active session",
  "2026-11-16T15:22:05:711 [debug]: [WorkflowTokenService] Disposed token service, cleared all tokens and timeouts",
  "2026-11-16T15:22:05:714 [info]: [MCP Manager] Disposing service",
  "2026-11-16T15:22:05:735 [info]: [CliExitHandler] Shutdown complete, good bye :)",
].join("\n");

describe("what counts as a GitLab repo", () => {
  it("reads remote hosts in every git URL form", () => {
    const remotes = "origin\thttps://github.com/me/app.git (fetch)\nlab\tgit@gitlab.example.com:g/p.git (push)\nother\tssh://git@git.corp:2222/g/p.git (fetch)\n";
    expect(remoteHosts(remotes).sort()).toEqual(["git.corp", "github.com", "gitlab.example.com"]);
  });

  it("gitlab.com, hosts named gitlab, and configured self-managed hosts", () => {
    expect(hasGitLabRemote("origin\thttps://github.com/me/app.git (fetch)")).toBe(false);
    expect(hasGitLabRemote("origin\tgit@gitlab.com:me/app.git (fetch)")).toBe(true);
    expect(hasGitLabRemote("origin\thttps://gitlab.corp.net/g/p.git (fetch)")).toBe(true);
    expect(hasGitLabRemote("origin\thttps://git.corp/g/p.git (fetch)")).toBe(false);
    expect(hasGitLabRemote("origin\thttps://git.corp/g/p.git (fetch)", ["git.corp"])).toBe(true);
    expect(hostList("https://Git.Corp/x, code.lab:8443 git@other.host")).toEqual(["git.corp", "code.lab", "other.host"]);
    expect(duoGitlabHosts({ hosts: "git.corp" }, { GITLAB_BASE_URL: "https://lab.internal" })).toEqual(["git.corp", "lab.internal"]);
    expect(DEFAULT_SETTINGS.duo).toEqual({ hosts: "", coordinator: false, coordinatorModel: "claude-opus-5-5" });
  });

  it("explains why a folder isn't one", async () => {
    expect(await gitlabRepoProblem(repo("git@gitlab.com:me/app.git"))).toBeNull();
    expect(await gitlabRepoProblem(plainDir())).toMatch(/only runs in GitLab repositories.*not a git repository/);
    expect(await gitlabRepoProblem(repo("https://github.com/me/app.git"))).toContain("its remote is on github.com, not GitLab");
    expect(await gitlabRepoProblem(repo("https://git.corp/g/p.git"), ["git.corp"])).toBeNull();
  });
});

describe("Duo adapter", () => {
  const opts = (cwd: string) => ({ cwd, executable: "duo", env: {} }) as unknown as SessionOptions;

  it("refuses to start outside a GitLab repo", async () => {
    await expect(new DuoAdapter().start(opts(repo("https://github.com/me/app.git")))).rejects.toThrow(/only runs in GitLab repositories/);
    await expect(new DuoAdapter().start(opts(plainDir()))).rejects.toThrow(/Settings → Harnesses → GitLab Duo/);
  });

  it("starts in a GitLab repo, including a configured self-managed host", async () => {
    expect(await new DuoAdapter().start(opts(repo("git@gitlab.com:me/app.git")))).toBeInstanceOf(DuoSession);
    expect(await new DuoAdapter(() => ({ hosts: "git.corp" })).start(opts(repo("https://git.corp/g/p.git")))).toBeInstanceOf(DuoSession);
  });

  it("shows Duo's error line, not the shutdown chatter", () => {
    const msg = duoFailure(FAILED_LOG, 1);
    expect(msg).toContain("Workflow ID not available");
    expect(msg).toContain("signed in to the GitLab instance");
    expect(msg).not.toContain("good bye");
    expect(duoFailure("boom: command not found", 127)).toBe("duo exited with 127: boom: command not found");
  });
});

describe("coordinator starts a Duo agent in a GitLab folder", () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { await cleanup?.(); cleanup = null; });

  it("parses the folder in text mode", () => {
    expect(parseTextDelegations('DELEGATE coder@duo in "C:\\code\\lab repo": review the MR\n')).toEqual([
      { role: "coder", harness: "duo", folder: "C:\\code\\lab repo", goal: "review the MR" }]);
    expect(parseTextDelegations("DELEGATE coder@duo: review\n")[0]).not.toHaveProperty("folder");
  });

  it("runs it in the folder it was pointed at, and refuses folders that aren't GitLab repos", async () => {
    const cwds: string[] = [];
    class FakeDuo extends DuoAdapter {
      override async start(o: SessionOptions) {
        await super.start(o); // the real GitLab-repo check
        cwds.push(o.cwd);
        return new DuoSession(process.execPath, [FAKE_DUO], o);
      }
    }
    const db = new Db(":memory:");
    const settings = mergeSettings(DEFAULT_SETTINGS, { general: { defaultHarness: "mock" }, agents: { toolMode: "auto" } } as any) as Settings;
    const harnesses = new HarnessRegistry([new MockAdapter(15), new FakeDuo()]);
    (harnesses as any).status.set("duo", { id: "duo", available: true, path: process.execPath });
    const orch = new Orchestrator({ db, harnesses, settings: () => settings, roles: () => loadRoles(join(__dirname, "..", "agents"), "/none"),
      skills: () => loadSkills(join(__dirname, "..", "skills", "superpowers")), emit: () => {}, mcpServersFor: () => [], homeDir: tmpdir() });
    cleanup = () => orch.stopAll();
    const project = db.createProject("p", repo("https://github.com/me/app.git"));
    const chat = db.createChat({ projectId: project.id, title: "c", kind: "project", agentRole: "flashmaster" });
    await orch.sendUserMessage(chat.id, "SLOW plan it", null);
    await until(() => db.listAgents().some((a) => a.status === "running"));
    const parentId = db.listAgents().find((a) => a.status === "running")!.id;

    // The project is a GitHub repo: Duo can't run there, and the coordinator is told how to fix it.
    await expect(orch.delegate(parentId, { role: "presentation-expert", goal: "hi", harness: "duo", wait: false }))
      .rejects.toThrow(/only runs in GitLab repositories.*Pass folder/);
    await expect(orch.delegate(parentId, { role: "presentation-expert", goal: "hi", harness: "duo", folder: plainDir(), wait: false }))
      .rejects.toThrow(/not a git repository/);
    await expect(orch.delegate(parentId, { role: "presentation-expert", goal: "hi", harness: "duo", folder: join(tmpdir(), "no-such-dir-x9"), wait: false }))
      .rejects.toThrow(/folder not found/);

    const lab = repo("git@gitlab.com:me/lab.git");
    const r = await orch.delegate(parentId, { role: "presentation-expert", goal: "summarise", harness: "duo", folder: lab, wait: true, timeoutSec: 20 });
    expect(db.getAgent(r.agentId)).toMatchObject({ harness: "duo", folder: lab });
    expect(cwds).toEqual([lab]);
    expect(r.result).toContain("Duo is working");
  }, 30000);
});
