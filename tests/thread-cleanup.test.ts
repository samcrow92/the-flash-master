import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockAdapter } from "../src/main/harness/mock";
import { HarnessRegistry } from "../src/main/harness/registry";
import { Db } from "../src/main/db";
import { Orchestrator } from "../src/main/orchestrator";
import { loadRoles, loadSkills } from "../src/main/roles";
import { DEFAULT_SETTINGS, mergeSettings, type Settings } from "../src/shared/settings";
import type { AppEvent } from "../src/shared/types";
import { chatThreads, splitArchived } from "../src/renderer/threadList";

const until = async (fn: () => boolean, ms = 8000) => {
  const t = Date.now();
  while (!fn()) { if (Date.now() - t > ms) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 10)); }
};

function setup(delayMs = 0) {
  const db = new Db(":memory:");
  const settings = mergeSettings(DEFAULT_SETTINGS, { general: { defaultHarness: "mock" }, agents: { toolMode: "auto" } } as any) as Settings;
  const harnesses = new HarnessRegistry([new MockAdapter(delayMs)]);
  const events: AppEvent[] = [];
  const orch = new Orchestrator({ db, harnesses, settings: () => settings, roles: () => loadRoles(join(__dirname, "..", "agents"), "/none"),
    skills: () => loadSkills(join(__dirname, "..", "skills", "superpowers")), emit: (e) => events.push(e), mcpServersFor: () => [], homeDir: tmpdir() });
  const p = db.createProject("p", mkdtempSync(join(tmpdir(), "proj-")));
  const chat = db.createChat({ projectId: p.id, title: "Brake ECU", kind: "project", agentRole: "flashmaster" });
  return { db, orch, events, chat };
}

describe("archive threads", () => {
  it("hides a thread in the panel's Archived section and brings it back on restore or on a new reply", () => {
    const { db, orch, events, chat } = setup();
    const root = db.addMessage({ chatId: chat.id, author: "user", content: "check the CAN log" });
    db.addMessage({ chatId: chat.id, parentId: root.id, author: "agent", role: "flashmaster", content: "on it" });

    const archived = orch.archiveThread(root.id, true);
    expect(archived.threadArchived).toBe(true);
    expect(events.at(-1)).toEqual({ type: "message.updated", message: archived });
    expect(db.listMessages(chat.id, null)[0]!.threadArchived).toBe(true); // survives a reload

    const list = chatThreads(db.listMessages(chat.id, null), {});
    expect(splitArchived(list).active).toEqual([]);
    expect(splitArchived(list).archived.map((t) => t.rootId)).toEqual([root.id]);

    expect(orch.archiveThread(root.id, false).threadArchived).toBeUndefined();
    orch.archiveThread(root.id, true);
    db.addMessage({ chatId: chat.id, parentId: root.id, author: "user", content: "any news?" });
    expect(db.getMessage(root.id)!.threadArchived).toBeUndefined();
  });

  it("only a thread's first message holds the flag", () => {
    const { db, orch, chat } = setup();
    const root = db.addMessage({ chatId: chat.id, author: "user", content: "root" });
    const reply = db.addMessage({ chatId: chat.id, parentId: root.id, author: "user", content: "reply" });
    expect(() => orch.archiveThread(reply.id, true)).toThrow();
    expect(() => orch.archiveThread("nope", true)).toThrow();
  });
});

describe("delete threads and messages", () => {
  it("deletes a thread's replies but keeps the message it hangs off", () => {
    const { db, orch, events, chat } = setup();
    const root = db.addMessage({ chatId: chat.id, author: "user", content: "root" });
    const r1 = db.addMessage({ chatId: chat.id, parentId: root.id, author: "agent", role: "flashmaster", content: "a" });
    const r2 = db.addMessage({ chatId: chat.id, parentId: root.id, author: "user", content: "b" });
    orch.archiveThread(root.id, true);

    orch.deleteThread(root.id);
    expect(db.listMessages(chat.id, root.id).map((m) => m.id)).toEqual([root.id]);
    const after = db.getMessage(root.id)!;
    expect(after.replyCount).toBe(0);
    expect(after.threadArchived).toBeUndefined(); // a new reply later starts a normal thread
    const removed = events.find((e) => e.type === "messages.removed");
    expect(removed).toMatchObject({ chatId: chat.id });
    expect((removed as any).removed.map((r: any) => r.id).sort()).toEqual([r1.id, r2.id].sort());
  });

  it("deletes one message with the thread under it", () => {
    const { db, orch, chat } = setup();
    const a = db.addMessage({ chatId: chat.id, author: "user", content: "keep me" });
    const b = db.addMessage({ chatId: chat.id, author: "user", content: "delete me" });
    db.addMessage({ chatId: chat.id, parentId: b.id, author: "user", content: "reply under it" });
    const reply = db.addMessage({ chatId: chat.id, parentId: a.id, author: "user", content: "a reply" });

    orch.deleteMessage(b.id);
    expect(db.listMessages(chat.id, null).map((m) => m.id)).toEqual([a.id]);
    expect(db.chatMessageIds(chat.id).sort()).toEqual([a.id, reply.id].sort());
    orch.deleteMessage(reply.id); // a single reply
    expect(db.getMessage(a.id)!.replyCount).toBe(0);
  });

  it("refuses to delete a reply still being written or a thread an agent is working in, and clears a whole chat", async () => {
    const { db, orch, events, chat } = setup(40);
    const root = db.addMessage({ chatId: chat.id, author: "user", content: "root" });
    await orch.sendUserMessage(chat.id, "long analysis", root.id);
    await until(() => events.some((e) => e.type === "message.delta"));
    const streaming = db.listMessages(chat.id, root.id).find((m) => m.status === "streaming")!;
    expect(() => orch.deleteMessage(streaming.id)).toThrow(/still being written/);
    expect(() => orch.deleteThread(root.id)).toThrow(/still working/);
    expect(() => orch.clearChat(chat.id)).toThrow(/still working/);
    await orch.stopChat(chat.id);
    await until(() => db.listMessages(chat.id, root.id).every((m) => m.status !== "streaming"));

    orch.clearChat(chat.id);
    expect(db.chatMessageIds(chat.id)).toEqual([]);
    expect(db.getChatSummary(chat.id)).toEqual({ summary: "", upto: 0 });
  });
});

describe("cleanup UI wiring", () => {
  const read = (f: string) => readFileSync(join(__dirname, "..", f), "utf8");
  it("offers archive / delete on threads, delete on messages and Clear chat, each delete behind a confirm", () => {
    const actions = read("src/renderer/threadActions.tsx");
    for (const fn of ["deleteThread", "deleteMessage", "clearChat"]) {
      expect(actions).toMatch(new RegExp(`export async function ${fn}\\([^)]*\\)[^{]*\\{\\s*[^\\n]*\\n?\\s*if \\(!confirm\\(`));
    }
    expect(read("src/renderer/views/ThreadsPanel.tsx")).toContain("threadMenu(r)");
    const chat = read("src/renderer/views/ChatView.tsx");
    expect(chat).toContain("deleteMessage(m)");
    expect(chat).toContain("clearChat(chat)");
  });
});
