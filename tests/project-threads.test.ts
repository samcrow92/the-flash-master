// Project threads: each project has a coordinator chat that starts thread chats (grouped by feature) the user can
// open and steer; a thread's result wakes the coordinator chat that started it.
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockAdapter } from "../src/main/harness/mock";
import { HarnessRegistry } from "../src/main/harness/registry";
import { Db } from "../src/main/db";
import { Orchestrator } from "../src/main/orchestrator";
import { loadRoles, loadSkills } from "../src/main/roles";
import { DEFAULT_SETTINGS, mergeSettings, type Settings } from "../src/shared/settings";
import type { AppEvent } from "../src/shared/types";

const until = async (fn: () => boolean, ms = 10000) => {
  const t = Date.now();
  while (!fn()) { if (Date.now() - t > ms) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 10)); }
};

function setup() {
  const db = new Db(":memory:");
  const settings = mergeSettings(DEFAULT_SETTINGS, { general: { defaultHarness: "mock" }, agents: { toolMode: "auto" } } as any) as Settings;
  const roles = loadRoles(join(__dirname, "..", "agents"), "/nonexistent");
  const skills = loadSkills(join(__dirname, "..", "skills", "superpowers"));
  const events: AppEvent[] = [];
  const orch = new Orchestrator({ db, harnesses: new HarnessRegistry([new MockAdapter(2)]), settings: () => settings, roles: () => roles, skills: () => skills,
    emit: (e) => events.push(e), mcpServersFor: () => [], homeDir: tmpdir() });
  const project = db.createProject("demo", mkdtempSync(join(tmpdir(), "proj-")));
  return { db, orch, project, events };
}

const agentReplies = (db: Db, chatId: string) => db.listMessages(chatId, null).filter((m) => m.author === "agent");

async function idleCoordinator(db: Db, orch: Orchestrator, chatId: string): Promise<string> {
  await orch.sendUserMessage(chatId, "Add CAN log export", null);
  await until(() => agentReplies(db, chatId)[0]?.status === "done" && db.getAgent(agentReplies(db, chatId)[0]!.agentId!)!.status === "idle");
  return agentReplies(db, chatId)[0]!.agentId!;
}

describe("coordinator chat", () => {
  it("is created once per project, and an empty first chat becomes it", () => {
    const { db, project } = setup();
    const general = db.createChat({ projectId: project.id, title: "General", kind: "project", agentRole: "flashmaster" });
    const c = db.ensureCoordinator(project.id);
    expect(c.id).toBe(general.id);
    expect(c).toMatchObject({ coordinator: true, title: "Coordinator", pinned: true, parentChatId: null });
    expect(db.ensureCoordinator(project.id).id).toBe(c.id);
  });

  it("is a new chat when the project's chats already have messages", () => {
    const { db, project } = setup();
    const old = db.createChat({ projectId: project.id, title: "General", kind: "project", agentRole: "flashmaster" });
    db.addMessage({ chatId: old.id, author: "user", content: "hi" });
    const c = db.ensureCoordinator(project.id);
    expect(c.id).not.toBe(old.id);
    expect(db.getChat(old.id)!.coordinator).toBe(false);
  });

  it("deleting it keeps its threads as top-level chats", () => {
    const { db, project } = setup();
    const c = db.ensureCoordinator(project.id);
    const t = db.createChat({ projectId: project.id, title: "BLF writer", kind: "project", agentRole: "flashmaster", parentChatId: c.id, feature: "CAN log export" });
    db.deleteChat(c.id);
    expect(db.getChat(t.id)).toMatchObject({ parentChatId: null, feature: "CAN log export" });
  });
});

describe("start_thread", () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { await cleanup?.(); cleanup = null; });

  it("starts a thread chat under a feature that runs the brief, and its result wakes the coordinator", async () => {
    const { db, orch, project, events } = setup();
    cleanup = () => orch.stopAll();
    const coord = db.ensureCoordinator(project.id);
    const coordAgent = await idleCoordinator(db, orch, coord.id);

    const r = await orch.startThread(coordAgent, { feature: "CAN log export", title: "Implement BLF writer", brief: "Write the BLF writer for CAN frames" });
    const thread = db.getChat(r.threadId)!;
    expect(thread).toMatchObject({ parentChatId: coord.id, feature: "CAN log export", title: "Implement BLF writer", projectId: project.id, coordinator: false });
    expect(events.some((e) => e.type === "chat.upserted" && e.chat.id === thread.id)).toBe(true);
    // The brief opens the thread as a message from the coordinator.
    const first = db.listMessages(thread.id, null)[0]!;
    expect(first).toMatchObject({ author: "user", agentId: coordAgent, content: "Write the BLF writer for CAN frames" });

    await until(() => agentReplies(db, thread.id)[0]?.status === "done");
    // The coordinator chat gets a notice with a link to the thread, and a new coordinator turn with the result.
    await until(() => agentReplies(db, coord.id).length === 2 && agentReplies(db, coord.id)[1]!.status === "done");
    expect(agentReplies(db, coord.id)[1]!.content).toContain("Thread results");
    expect(db.listMessages(coord.id, null).some((m) => m.author === "system" && m.content.includes(`flash-chat://${thread.id}`))).toBe(true);
    expect(orch.listThreads(coordAgent).threads).toEqual([expect.objectContaining({ threadId: thread.id, feature: "CAN log export", state: "done" })]);
  });

  it("a thread's own coordinator starts siblings under the same coordinator chat", async () => {
    const { db, orch, project } = setup();
    cleanup = () => orch.stopAll();
    const coord = db.ensureCoordinator(project.id);
    const coordAgent = await idleCoordinator(db, orch, coord.id);
    const a = await orch.startThread(coordAgent, { feature: "Flash over XCP", title: "Spike", brief: "Spike XCP on CAN" });
    await until(() => agentReplies(db, a.threadId)[0]?.status === "done");
    const threadAgent = agentReplies(db, a.threadId)[0]!.agentId!;
    const b = await orch.startThread(threadAgent, { feature: "Flash over XCP", title: "Progress UI", brief: "Wire the flash progress UI" });
    expect(db.getChat(b.threadId)!.parentChatId).toBe(coord.id);
    expect(db.listThreads(coord.id).map((c) => c.title)).toEqual(["Spike", "Progress UI"]);
  });

  it("refuses specialists, a missing feature or brief, and unknown roles", async () => {
    const { db, orch, project } = setup();
    cleanup = () => orch.stopAll();
    const coord = db.ensureCoordinator(project.id);
    const coordAgent = await idleCoordinator(db, orch, coord.id);
    await expect(orch.startThread(coordAgent, { feature: "", brief: "x" })).rejects.toThrow(/feature is required/);
    await expect(orch.startThread(coordAgent, { feature: "F", brief: " " })).rejects.toThrow(/brief is required/);
    await expect(orch.startThread(coordAgent, { feature: "F", brief: "x", role: "nope" })).rejects.toThrow(/unknown role/);
    const sp = await orch.delegate(coordAgent, { role: "tester", goal: "Write tests", wait: false });
    await expect(orch.startThread(sp.agentId, { feature: "F", brief: "x" })).rejects.toThrow(/only the chat's coordinator/);
  });

  it("message_thread steers or restarts one of the coordinator's own threads only", async () => {
    const { db, orch, project } = setup();
    cleanup = () => orch.stopAll();
    const coord = db.ensureCoordinator(project.id);
    const coordAgent = await idleCoordinator(db, orch, coord.id);
    const t = await orch.startThread(coordAgent, { feature: "F", title: "T", brief: "Do T" });
    await until(() => agentReplies(db, t.threadId)[0]?.status === "done");
    const r = await orch.messageThread(coordAgent, { threadId: t.threadId, message: "Use nanosecond timestamps" });
    expect(r.state).toBe("started a new turn");
    await until(() => agentReplies(db, t.threadId).length === 2);
    const other = db.createChat({ projectId: project.id, title: "Elsewhere", kind: "project", agentRole: "flashmaster" });
    await expect(orch.messageThread(coordAgent, { threadId: other.id, message: "hi" })).rejects.toThrow(/no such thread/);
  });
});
