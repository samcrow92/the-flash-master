/**
 * Mari: a setting to run the coordinator chat on GitLab Duo, on Opus 5.5 by default; with Duo set, the harness starts by
 * itself in the project folder; project folders only. The master chat (no project) keeps its usual harness, a project
 * that isn't a GitLab repo falls back too, and the coordinator on Duo is never told it is "a specialist, not the orchestrator".
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DuoAdapter, DuoSession } from "../src/main/harness/duo";
import { MockAdapter } from "../src/main/harness/mock";
import { HarnessRegistry } from "../src/main/harness/registry";
import { Db } from "../src/main/db";
import { Orchestrator } from "../src/main/orchestrator";
import { loadRoles, loadSkills } from "../src/main/roles";
import { DEFAULT_SETTINGS, mergeSettings, type DeepPartial, type Settings } from "../src/shared/settings";
import type { SessionOptions } from "../src/main/harness/types";
import type { AppEvent } from "../src/shared/types";

const FAKE_DUO = join(__dirname, "fixtures", "fake-duo.mjs");
const until = async (fn: () => boolean, ms = 15000) => {
  const t = Date.now();
  while (!fn()) { if (Date.now() - t > ms) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 10)); }
};
const repo = (remote: string | null) => {
  const d = mkdtempSync(join(tmpdir(), "duo-coord-"));
  execFileSync("git", ["init", "-q"], { cwd: d });
  if (remote) execFileSync("git", ["remote", "add", "origin", remote], { cwd: d });
  return d;
};

const starts: SessionOptions[] = [];
class FakeDuo extends DuoAdapter {
  override async start(o: SessionOptions) {
    await super.start(o);
    starts.push(o);
    return new DuoSession(process.execPath, [FAKE_DUO], o);
  }
}

function setup(over: DeepPartial<Settings> = {}, remote: string | null = "git@gitlab.com:me/lab.git") {
  starts.length = 0;
  const db = new Db(":memory:");
  const settings = mergeSettings(mergeSettings(DEFAULT_SETTINGS, { general: { defaultHarness: "mock" } } as any), over as any) as Settings;
  const harnesses = new HarnessRegistry([new MockAdapter(5), new FakeDuo()]);
  (harnesses as any).status.set("duo", { id: "duo", available: true, path: process.execPath });
  const events: AppEvent[] = [];
  const orch = new Orchestrator({ db, harnesses, settings: () => settings, roles: () => loadRoles(join(__dirname, "..", "agents"), "/none"),
    skills: () => loadSkills(join(__dirname, "..", "skills", "superpowers")), emit: (e: AppEvent) => events.push(e), mcpServersFor: () => [], homeDir: tmpdir() } as any);
  const project = db.createProject("lab", repo(remote));
  const chat = db.createChat({ projectId: project.id, title: "c", kind: "project", agentRole: "flashmaster" });
  return { db, orch, chat, project, events };
}

const coordReplies = (db: Db, chatId: string) => db.listMessages(chatId, null).filter((m) => m.author === "agent" && m.role === "flashmaster");
const systemNotes = (db: Db, chatId: string) => db.listMessages(chatId, null).filter((m) => m.author === "system").map((m) => m.content);

let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => { await cleanup?.(); cleanup = null; vi.restoreAllMocks(); });

describe("coordinator on GitLab Duo", () => {
  it("is off by default and defaults to Opus 5.5", () => {
    expect(DEFAULT_SETTINGS.duo.coordinator).toBe(false);
    expect(DEFAULT_SETTINGS.duo.coordinatorModel).toBe("claude_opus_5_5");
  });

  it("with the setting on, Duo starts by itself in the project folder on Opus 5.5, and its first turn still gets the coordinator brief", async () => {
    const prompts: string[] = [];
    const real = DuoSession.prototype.prompt;
    vi.spyOn(DuoSession.prototype, "prompt").mockImplementation(function (this: DuoSession, text: string, att?: any) {
      prompts.push(text);
      return real.call(this, text, att);
    });
    const { db, orch, chat, project } = setup({ duo: { coordinator: true } });
    cleanup = () => orch.stopAll();
    const r = await orch.prepareChat(chat.id);
    expect(r).toEqual({ harness: "duo", folder: project.path, ready: true });
    expect(starts).toHaveLength(1);
    expect(starts[0]!.cwd).toBe(project.path);
    expect(starts[0]!.model).toBe("claude_opus_5_5");
    const agent = db.listAgents().find((a) => a.chatId === chat.id)!;
    expect(agent).toMatchObject({ harness: "duo", model: "claude_opus_5_5", status: "idle" });
    // Opening the chat again doesn't start a second session.
    await orch.prepareChat(chat.id);
    expect(starts).toHaveLength(1);

    await orch.sendUserMessage(chat.id, "Plan the brake light feature", null);
    await until(() => coordReplies(db, chat.id)[0]?.status === "done");
    expect(starts).toHaveLength(1); // the turn used the session Duo started with
    expect(prompts[0]).toContain("## Delegation (text mode)");
    expect(prompts[0]).not.toContain("## You run the crew"); // the Duo orchestrator brief takes its place
    // The master chat's coordinator is the orchestrator: none of the Duo specialist brief.
    expect(prompts[0]).not.toContain("You are a specialist, not the orchestrator");
    // Mari: the Duo coordinator always knows it is the orchestrator, and uses TheFlashMaster's tools to do it.
    expect(prompts[0]).toContain("## You are the orchestrator");
    expect(prompts[0]).toMatch(/always the orchestrator, never a specialist/);
    for (const tool of ["agent_status", "message_agent", "list_roles", "memory_search", "knowledge_read", "code_graph", "ask_user"])
      expect(prompts[0]).toContain(tool);
    expect(prompts[0]).toMatch(/DELEGATE, AGENT and TOOL lines run when your turn ends/);
    expect(coordReplies(db, chat.id)[0]!.content).toContain("Goal was:");
  }, 30000);

  it("a model picked for the chat on Duo wins over the default", async () => {
    const { db, orch, chat } = setup();
    cleanup = () => orch.stopAll();
    db.updateChat(chat.id, { harness: "duo", model: "claude-sonnet-5-5" });
    expect((await orch.prepareChat(chat.id)).ready).toBe(true);
    expect(starts[0]!.model).toBe("claude-sonnet-5-5");
  }, 30000);

  it("picking duo for the chat starts Duo without the setting, on Opus 5.5 when the chat names no model", async () => {
    const { db, orch, chat, project } = setup();
    cleanup = () => orch.stopAll();
    expect((await orch.prepareChat(chat.id)).ready).toBe(false); // setting off, chat on auto: nothing to start
    db.updateChat(chat.id, { harness: "duo" });
    expect(await orch.prepareChat(chat.id)).toEqual({ harness: "duo", folder: project.path, ready: true });
    expect(starts[0]!.model).toBe("claude_opus_5_5");
  }, 30000);

  it("the master chat has no project folder: it keeps its usual harness", async () => {
    const { db, orch } = setup({ duo: { coordinator: true } });
    cleanup = () => orch.stopAll();
    const master = db.getOrCreateMasterChat();
    db.updateChat(master.id, { harness: "duo" });
    expect((await orch.prepareChat(master.id)).ready).toBe(false);
    await orch.sendUserMessage(master.id, "hello", null);
    await until(() => coordReplies(db, master.id)[0]?.status === "done");
    expect(starts).toHaveLength(0);
    expect(db.getAgent(coordReplies(db, master.id)[0]!.agentId!)!.harness).toBe("mock");
    expect(systemNotes(db, master.id).join("\n")).toMatch(/only in chats with a project folder/);
  }, 30000);

  it("with the setting on, a project that isn't a GitLab repo runs the coordinator on its usual harness", async () => {
    const { db, orch, chat } = setup({ duo: { coordinator: true } }, "git@github.com:me/lab.git");
    cleanup = () => orch.stopAll();
    expect((await orch.prepareChat(chat.id)).ready).toBe(false);
    expect(starts).toHaveLength(0);
    expect(systemNotes(db, chat.id).join("\n")).toMatch(/isn't a GitLab repository, so TheFlashMaster runs on \*\*mock\*\*/);
    await orch.sendUserMessage(chat.id, "hello", null);
    await until(() => coordReplies(db, chat.id)[0]?.status === "done");
    expect(db.getAgent(coordReplies(db, chat.id)[0]!.agentId!)!.harness).toBe("mock");
  }, 30000);

  it("duo picked for a chat whose project isn't a GitLab repo says why it didn't start", async () => {
    const { db, orch, chat } = setup({}, null);
    cleanup = () => orch.stopAll();
    db.updateChat(chat.id, { harness: "duo" });
    const r = await orch.prepareChat(chat.id);
    expect(r.ready).toBe(false);
    expect(r.error).toMatch(/only runs in GitLab repositories/);
    expect(systemNotes(db, chat.id).join("\n")).toMatch(/GitLab Duo didn't start in/);
  }, 30000);

  it("the Duo coordinator gets the orchestrator brief with your own instructions after it, also in auto tool mode", async () => {
    const prompts: string[] = [];
    const real = DuoSession.prototype.prompt;
    vi.spyOn(DuoSession.prototype, "prompt").mockImplementation(function (this: DuoSession, text: string, att?: any) {
      prompts.push(text);
      return real.call(this, text, att);
    });
    const { db, orch, chat } = setup({ agents: { toolMode: "auto" }, duo: { coordinator: true, orchestratorRules: "Always start a reviewer after a coder." } });
    cleanup = () => orch.stopAll();
    await orch.sendUserMessage(chat.id, "Plan it", null);
    await until(() => coordReplies(db, chat.id)[0]?.status === "done");
    expect(prompts[0]).toContain("## You are the orchestrator");
    expect(prompts[0]).toMatch(/### Your user's instructions for orchestrating\nAlways start a reviewer after a coder\./);
    // Headless Duo has no MCP server for TheFlashMaster's tools: it delegates with DELEGATE lines whatever the tool mode.
    expect(prompts[0]).toContain("## Delegation (text mode)");
  }, 30000);

  it("a Duo specialist delegated by the coordinator keeps the specialist brief, not the orchestrator one", async () => {
    const prompts: string[] = [];
    const real = DuoSession.prototype.prompt;
    vi.spyOn(DuoSession.prototype, "prompt").mockImplementation(function (this: DuoSession, text: string, att?: any) {
      prompts.push(text);
      return real.call(this, text, att);
    });
    const { db, orch, chat } = setup();
    cleanup = () => orch.stopAll();
    const parent = await orch.sendUserMessage(chat.id, "Plan it", null);
    await until(() => coordReplies(db, chat.id)[0]?.status === "done");
    expect(parent).toBeTruthy();
    const coordId = coordReplies(db, chat.id)[0]!.agentId!;
    await until(() => db.getAgent(coordId)!.status === "idle");
    await orch.delegate(coordId, { role: "tester", goal: "review the MR", harness: "duo", timeoutSec: 20 });
    expect(prompts[0]).toContain("## You are a specialist, not the orchestrator");
    expect(prompts[0]).not.toContain("## You are the orchestrator");
  }, 30000);
});
