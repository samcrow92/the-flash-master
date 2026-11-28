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

describe("delete messages and clear chats", () => {
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

  it("refuses to delete a message still being written or to clear a chat an agent works in, and clears a whole chat", async () => {
    const { db, orch, events, chat } = setup(40);
    await orch.sendUserMessage(chat.id, "long analysis", null);
    await until(() => events.some((e) => e.type === "message.delta"));
    const streaming = db.listMessages(chat.id, null).find((m) => m.status === "streaming")!;
    expect(() => orch.deleteMessage(streaming.id)).toThrow(/still being written/);
    expect(() => orch.clearChat(chat.id)).toThrow(/still working/);
    await orch.stopChat(chat.id);
    await until(() => db.listMessages(chat.id, null).every((m) => m.status !== "streaming"));

    orch.clearChat(chat.id);
    expect(db.chatMessageIds(chat.id)).toEqual([]);
    expect(db.getChatSummary(chat.id)).toEqual({ summary: "", upto: 0 });
  });
});

describe("cleanup UI wiring", () => {
  const read = (f: string) => readFileSync(join(__dirname, "..", f), "utf8");
  it("offers delete on messages and Clear chat, each behind a confirm", () => {
    const actions = read("src/renderer/threadActions.tsx");
    for (const fn of ["deleteMessage", "clearChat"]) {
      expect(actions).toMatch(new RegExp(`export async function ${fn}\\([^)]*\\)[^{]*\\{\\s*[^\\n]*\\n?\\s*if \\(!confirm\\(`));
    }
    const chat = read("src/renderer/views/ChatView.tsx");
    expect(chat).toContain("deleteMessage(m)");
    expect(chat).toContain("clearChat(chat)");
  });
});
