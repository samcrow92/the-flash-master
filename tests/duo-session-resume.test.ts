/**
 * Mari: "duo is giving me these things like not having access to tools". The Duo coordinator said "this session has no
 * Jazz/ALM or delegation tools". Cause: headless Duo runs a new process per turn, and the app looked for a "Session ID: …"
 * line that duo-cli never prints (it logs "Workflow source=local (fresh); created <id>"). So every turn after the first
 * started a brand-new Duo session that had never seen the orchestrator brief, the TOOL/DELEGATE lines or the chat.
 * Now the workflow id is read from Duo's real log lines and resumed; if Duo reports none, the next turn is sent the rules,
 * tools and history again. The brief also tells Duo to take another route instead of asking the user to enable tools.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DuoAdapter, DuoSession, duoSessionId } from "../src/main/harness/duo";
import { MockAdapter } from "../src/main/harness/mock";
import { HarnessRegistry } from "../src/main/harness/registry";
import { Db } from "../src/main/db";
import { Orchestrator } from "../src/main/orchestrator";
import { loadRoles, loadSkills } from "../src/main/roles";
import { DUO_ORCHESTRATOR_RULES } from "../src/main/context";
import { DEFAULT_SETTINGS, mergeSettings, type DeepPartial, type Settings } from "../src/shared/settings";
import type { HarnessEvent, SessionOptions } from "../src/main/harness/types";

const FAKE_DUO = join(__dirname, "fixtures", "fake-duo.mjs");
const until = async (fn: () => boolean, ms = 15000) => {
  const t = Date.now();
  while (!fn()) { if (Date.now() - t > ms) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 10)); }
};
const gitlabRepo = () => {
  const d = mkdtempSync(join(tmpdir(), "duo-resume-"));
  execFileSync("git", ["init", "-q"], { cwd: d });
  execFileSync("git", ["remote", "add", "origin", "git@gitlab.com:me/lab.git"], { cwd: d });
  return d;
};
const text = (events: HarnessEvent[]) => events.filter((e) => e.type === "text").map((e) => (e as { text: string }).text).join("");

class FakeDuo extends DuoAdapter {
  override async start(o: SessionOptions) {
    await super.start(o);
    return new DuoSession(process.execPath, [FAKE_DUO], o);
  }
}

function setup(over: DeepPartial<Settings> = {}) {
  const db = new Db(":memory:");
  const settings = mergeSettings(mergeSettings(DEFAULT_SETTINGS, { general: { defaultHarness: "mock" } } as any), over as any) as Settings;
  const harnesses = new HarnessRegistry([new MockAdapter(5), new FakeDuo()]);
  (harnesses as any).status.set("duo", { id: "duo", available: true, path: process.execPath });
  const orch = new Orchestrator({ db, harnesses, settings: () => settings, roles: () => loadRoles(join(__dirname, "..", "agents"), "/none"),
    skills: () => loadSkills(join(__dirname, "..", "skills", "superpowers")), emit: () => undefined, mcpServersFor: () => [], homeDir: tmpdir(),
    listTools: (set: string) => set === "core"
      ? [{ name: "agent_status", description: "Look at a specialist.", inputSchema: { properties: { agentId: {} }, required: ["agentId"] } }]
      : [{ name: "jazz_get", description: "Read a Jazz work item.", inputSchema: { properties: { id: {} }, required: ["id"] } }] } as any);
  const project = db.createProject("lab", gitlabRepo());
  const chat = db.createChat({ projectId: project.id, title: "c", kind: "project", agentRole: "flashmaster" });
  return { db, orch, chat };
}
const coordReplies = (db: Db, chatId: string) => db.listMessages(chatId, null).filter((m) => m.author === "agent" && m.role === "flashmaster");
const spyPrompts = () => {
  const prompts: string[] = [];
  const real = DuoSession.prototype.prompt;
  vi.spyOn(DuoSession.prototype, "prompt").mockImplementation(function (this: DuoSession, t: string, att?: any) {
    prompts.push(t);
    return real.call(this, t, att);
  });
  return prompts;
};

let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => { await cleanup?.(); cleanup = null; vi.restoreAllMocks(); });

describe("Duo's session id comes from the lines duo-cli really logs", () => {
  it("reads a new, a resumed and an initialized workflow, and nothing else", () => {
    expect(duoSessionId("2026-11-19T07:30:00.000Z [info]: Workflow source=local (fresh); created 4122303 (flow: chat), capabilities=[none]")).toBe("4122303");
    expect(duoSessionId("2026-11-19T07:30:00.000Z [info]: Workflow source=local (resume); attaching to 4122303 (definition: chat, flow: chat)")).toBe("4122303");
    expect(duoSessionId("[info]: Initialized workflow 998877 capabilities: [a, b]")).toBe("998877");
    expect(duoSessionId("[info]: Tool started: read_file")).toBeNull();
    expect(duoSessionId("[debug]: created 12 files")).toBeNull();
  });

  it("a second turn resumes the session the first one created", async () => {
    const events: HarnessEvent[] = [];
    const s = new DuoSession(process.execPath, [FAKE_DUO], { cwd: gitlabRepo(), env: {}, extraArgs: "", model: null, resumeSessionId: null,
      onEvent: (e: HarnessEvent) => events.push(e) } as unknown as SessionOptions);
    await s.prompt("first");
    expect(s.sessionId).toBe("4122303");
    await s.prompt("second");
    expect(text(events)).toContain("(resumed) Goal was: second");
  });
});

describe("the Duo coordinator keeps its tools after the first turn", () => {
  it("the next message resumes Duo's session, and the session id is kept for an app restart", async () => {
    const prompts = spyPrompts();
    const { db, orch, chat } = setup({ duo: { coordinator: true } });
    cleanup = () => orch.stopAll();
    await orch.sendUserMessage(chat.id, "Look at issue 770724", null);
    await until(() => coordReplies(db, chat.id)[0]?.status === "done");
    expect(prompts[0]).toContain("## You are the orchestrator");
    expect(prompts[0]).toContain("TOOL <name>");
    const agent = db.listAgents().find((a) => a.chatId === chat.id)!;
    expect(db.getAgentSession(agent.id)).toBe("4122303");

    await orch.sendUserMessage(chat.id, "Enable Jazz tools for this session", null);
    await until(() => coordReplies(db, chat.id)[1]?.status === "done");
    expect(coordReplies(db, chat.id)[1]!.content).toContain("(resumed) Goal was:");
  }, 30000);

  it("when Duo reports no session id, the next message brings the brief, the tools and the history again", async () => {
    const prompts = spyPrompts();
    const { db, orch, chat } = setup({ duo: { coordinator: true }, jazz: { enabled: true } });
    cleanup = () => orch.stopAll();
    await orch.sendUserMessage(chat.id, "NOSESSION look at issue 770724", null);
    await until(() => coordReplies(db, chat.id)[0]?.status === "done");
    await orch.sendUserMessage(chat.id, "NOSESSION go on", null);
    await until(() => coordReplies(db, chat.id)[1]?.status === "done");
    expect(prompts).toHaveLength(2);
    for (const p of prompts) {
      expect(p).toContain("## You are the orchestrator");
      expect(p).toContain("## Delegation (text mode)");
      expect(p).toContain("- jazz_get(id)");
    }
    expect(prompts[1]).toContain("look at issue 770724"); // the earlier message, as history
  }, 30000);
});

describe("the Duo orchestrator brief", () => {
  it("never sends the user off to enable tools, and names the routes to take instead", () => {
    expect(DUO_ORCHESTRATOR_RULES).toMatch(/they work in every turn of this chat/);
    expect(DUO_ORCHESTRATOR_RULES).toMatch(/never ask them to\s+enable tools, set up MCP servers, edit \.gitlab\/duo files or start a new session/);
    expect(DUO_ORCHESTRATOR_RULES).toMatch(/Take the next route yourself, without asking/);
    expect(DUO_ORCHESTRATOR_RULES).toContain("DELEGATE jazz-analyst:");
  });
});
