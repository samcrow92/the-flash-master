import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockAdapter } from "../src/main/harness/mock";
import { HarnessRegistry } from "../src/main/harness/registry";
import { Db, likeSnippet, searchTerms } from "../src/main/db";
import { Orchestrator } from "../src/main/orchestrator";
import { loadRoles, loadSkills } from "../src/main/roles";
import { DEFAULT_SETTINGS, mergeSettings, type Settings } from "../src/shared/settings";
import { planEdit, planRetry } from "../src/shared/rewind";
import type { AppEvent, Message } from "../src/shared/types";
import { matchShortcut, shortcutLabel, SHORTCUTS } from "../src/renderer/commands";

const until = async (fn: () => boolean, ms = 8000) => {
  const t = Date.now();
  while (!fn()) { if (Date.now() - t > ms) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 10)); }
};

function setup() {
  const db = new Db(":memory:");
  const settings = mergeSettings(DEFAULT_SETTINGS, { general: { defaultHarness: "mock" }, agents: { toolMode: "auto" } } as any) as Settings;
  const harnesses = new HarnessRegistry([new MockAdapter(0)]);
  const events: AppEvent[] = [];
  const orch = new Orchestrator({ db, harnesses, settings: () => settings, roles: () => loadRoles(join(__dirname, "..", "agents"), "/none"),
    skills: () => loadSkills(join(__dirname, "..", "skills", "superpowers")), emit: (e) => events.push(e), mcpServersFor: () => [], homeDir: tmpdir() });
  const p = db.createProject("p", mkdtempSync(join(tmpdir(), "proj-")));
  const chat = db.createChat({ projectId: p.id, title: "Brake ECU", kind: "project", agentRole: "flashmaster" });
  return { db, orch, events, chat };
}
const main = (db: Db, chatId: string) => db.listMessages(chatId, null);
const settled = (db: Db, chatId: string, agents: number) => () => {
  const a = main(db, chatId).filter((m) => m.author === "agent");
  return a.length === agents && a.every((m) => m.status === "done");
};

describe("chat search", () => {
  it("finds messages in every chat by word prefix, with the match highlighted", () => {
    const { db, chat } = setup();
    const other = db.createChat({ projectId: null, title: "Notes", kind: "project", agentRole: "flashmaster" });
    db.addMessage({ chatId: chat.id, author: "user", content: "Why does the CAN bus time out on wakeup?" });
    const reply = db.addMessage({ chatId: chat.id, author: "agent", role: "flashmaster", content: "", status: "streaming" });
    db.updateMessage(reply.id, { content: "The CANoe trace shows the bus-off recovery takes 200 ms.", status: "done" });
    db.addMessage({ chatId: other.id, author: "user", content: "Unrelated: lunch at noon" });
    db.addMessage({ chatId: chat.id, author: "system", content: "CAN system notice" });

    expect(db.searchIndex).toBe("fts");
    const hits = db.searchMessages("can");
    expect(hits.map((h) => h.messageId).sort()).toEqual([main(db, chat.id)[0]!.id, reply.id].sort()); // prefix: CAN + CANoe, not system
    expect(hits[0]!.chatTitle).toBe("Brake ECU");
    expect(hits.find((h) => h.messageId === reply.id)!.snippet).toContain("\u0002CANoe\u0003");
    expect(db.searchMessages("lunch noon").map((h) => h.chatId)).toEqual([other.id]);
    expect(db.searchMessages("lunch wakeup")).toEqual([]); // every word must match
  });

  it("follows edits and deletes, and never passes FTS syntax through", () => {
    const { db, chat } = setup();
    const m = db.addMessage({ chatId: chat.id, author: "user", content: "flash the bootloader" });
    db.editMessage(m.id, "erase the calibration");
    expect(db.searchMessages("bootloader")).toEqual([]);
    expect(db.searchMessages("calibration")).toHaveLength(1);
    expect(() => db.searchMessages('"calib* OR NEAR( -x')).not.toThrow();
    expect(db.searchMessages("")).toEqual([]);
    db.deleteChat(chat.id);
    expect(db.searchMessages("calibration")).toEqual([]);
    expect(searchTerms('a "b" c* OR')).toEqual(["a", "b", "c", "OR"]);
  });

  it("indexes messages that existed before search shipped", () => {
    const file = join(mkdtempSync(join(tmpdir(), "db-")), "f.db");
    const a = new Db(file);
    const c = a.createChat({ projectId: null, title: "old", kind: "project", agentRole: "flashmaster" });
    a.addMessage({ chatId: c.id, author: "user", content: "legacy watchdog question" });
    a.raw.exec("DROP TRIGGER messages_fts_ai; DROP TRIGGER messages_fts_ad; DROP TRIGGER messages_fts_au; DROP TABLE messages_fts;");
    a.addMessage({ chatId: c.id, author: "user", content: "another watchdog note" });
    a.close();
    const b = new Db(file);
    expect(b.searchMessages("watchdog")).toHaveLength(2);
    b.close();
  });

  it("opens with Ctrl+Shift+F (Cmd+Shift+F on macOS), not Ctrl+F", () => {
    const k = (o: Partial<{ ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }>) => ({ key: "F", ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...o });
    expect(matchShortcut(k({ ctrlKey: true, shiftKey: true }), false)).toBe("search");
    expect(matchShortcut(k({ metaKey: true, shiftKey: true }), true)).toBe("search");
    expect(matchShortcut({ ...k({ ctrlKey: true }), key: "f" }, false)).toBeNull();
    expect(shortcutLabel(SHORTCUTS.search.keys, true)).toBe("⌘⇧F");
  });

  it("builds a highlighted snippet without FTS5", () => {
    const s = likeSnippet(`${"x ".repeat(80)}the Watchdog fired ${"y ".repeat(80)}`, ["watchdog"]);
    expect(s).toContain("\u0002Watchdog\u0003");
    expect(s.startsWith("…") && s.endsWith("…")).toBe(true);
  });
});

const msg = (id: string, author: Message["author"], over: Partial<Message> = {}): Message => ({
  id, chatId: "c", parentId: null, author, agentId: null, role: null, content: id, status: "done", tokensIn: 0, tokensOut: 0, estimated: true,
  createdAt: 0, seq: 0, attachments: [], steer: false, reactions: [], replyCount: 0, ...over,
});

describe("edit and retry rules", () => {
  const scope = [msg("u1", "user"), msg("a1", "agent"), msg("u2", "user"), msg("a2", "agent"), msg("s", "system"), msg("a3", "agent")];
  it("edits only your last message", () => {
    expect(planEdit(scope, "u2")).toMatchObject({ ok: true, user: { id: "u2" } });
    expect((planEdit(scope, "u2") as any).remove.map((m: Message) => m.id)).toEqual(["a2", "s", "a3"]);
    expect(planEdit(scope, "u1").ok).toBe(false);
    expect(planEdit(scope, "a2").ok).toBe(false);
    expect(planEdit([msg("u", "user", { replyCount: 2 })], "u").ok).toBe(false); // has a thread
    expect(planEdit([msg("u", "user"), msg("a", "agent", { status: "streaming" })], "u").ok).toBe(false);
  });
  it("retries only the latest reply, resending the message behind it", () => {
    expect(planRetry(scope, "a3")).toMatchObject({ ok: true, user: { id: "u2" } });
    expect((planRetry(scope, "a3") as any).remove.map((m: Message) => m.id)).toEqual(["a2", "s", "a3"]);
    expect(planRetry(scope, "a2").ok).toBe(false);
    expect(planRetry(scope, "a1").ok).toBe(false);
    expect(planRetry([msg("u", "user"), msg("r", "system", { marker: "context-reset" }), msg("a", "agent")], "a").ok).toBe(false);
  });
});

describe("edit and retry in a chat", () => {
  it("edit removes the old reply and answers the new text in a fresh session", async () => {
    const { db, orch, events, chat } = setup();
    await orch.sendUserMessage(chat.id, "first question", null);
    await until(settled(db, chat.id, 1));
    await orch.sendUserMessage(chat.id, "second questoin", null);
    await until(settled(db, chat.id, 2));
    const [u1, a1, u2, a2] = main(db, chat.id);
    expect(a2!.content).toContain("turn 2");
    await expect(orch.editAndResend(u1!.id, "nope")).rejects.toThrow(/last message/);

    await orch.editAndResend(u2!.id, "second question");
    await until(() => main(db, chat.id).length === 4 && settled(db, chat.id, 2)());
    const after = main(db, chat.id);
    expect(after.slice(0, 3).map((m) => m.id)).toEqual([u1!.id, a1!.id, u2!.id]);
    expect(after[2]!.content).toBe("second question");
    expect(after[3]!.id).not.toBe(a2!.id);
    expect(after[3]!.content).toContain("second question");
    expect(after[3]!.content).toContain("turn 1"); // the old session (which saw the typo) was closed
    expect(events.some((e) => e.type === "messages.removed" && e.removed.some((r) => r.id === a2!.id))).toBe(true);
    await orch.stopAll();
  });

  it("retry runs the last turn again, optionally on another model, and refuses while busy", async () => {
    const { db, orch, chat } = setup();
    await orch.sendUserMessage(chat.id, "explain the DTC", null);
    await until(settled(db, chat.id, 1));
    const a1 = main(db, chat.id)[1]!;
    await orch.retryReply(a1.id, { harness: "mock", model: "mock-large" });
    await until(() => { const a = main(db, chat.id); return a.length === 2 && a[1]!.id !== a1.id && a[1]!.status === "done"; });
    const retried = main(db, chat.id)[1]!;
    expect(retried.content).toContain("explain the DTC");
    expect(db.getAgent(retried.agentId!)!.model).toBe("mock-large");
    expect(main(db, chat.id).filter((m) => m.author === "user")).toHaveLength(1); // not sent twice
    await expect(orch.retryReply(main(db, chat.id)[0]!.id)).rejects.toThrow(/agent replies/);
    await orch.stopAll();
  });

  it("retries a thread reply inside its thread", async () => {
    const { db, orch, chat } = setup();
    const root = db.addMessage({ chatId: chat.id, author: "user", content: "root" });
    await orch.sendUserMessage(chat.id, "thread question", root.id);
    const thread = () => db.listMessages(chat.id, root.id);
    await until(() => thread().some((m) => m.author === "agent" && m.status === "done"));
    const reply = thread().find((m) => m.author === "agent")!;
    await orch.retryReply(reply.id);
    await until(() => { const t = thread(); return t.length === 3 && t[2]!.id !== reply.id && t[2]!.status === "done"; });
    expect(thread()[2]!.content).toContain("thread question");
    expect(main(db, chat.id)).toHaveLength(1);
    await orch.stopAll();
  });
});
