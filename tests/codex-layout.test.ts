import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Chat } from "../src/shared/types";
import { chatToOpen, sheetTab, switcherChats } from "../src/renderer/layout";

const read = (f: string) => readFileSync(join(__dirname, "..", f), "utf8");
const chat = (id: string, over: Partial<Chat> = {}): Chat => ({
  id, projectId: "p", title: id, kind: "project", agentRole: "flashmaster", harness: null, model: null, superpowers: false, mode: null,
  autopilot: false, archived: false, pinned: false, createdAt: 0, ...over,
});

describe("chat switcher and project rows", () => {
  const a = chat("a", { createdAt: 1 });
  const b = chat("b", { createdAt: 3 });
  const c = chat("c", { createdAt: 2, pinned: true });
  const old = chat("old", { createdAt: 4, archived: true });

  it("lists pinned chats first, then newest first, with archived chats apart", () => {
    const { active, archived } = switcherChats([a, b, c, old]);
    expect(active.map((x) => x.id)).toEqual(["c", "b", "a"]);
    expect(archived.map((x) => x.id)).toEqual(["old"]);
  });

  it("a project row reopens the chat you last had open there, else its first listed chat", () => {
    expect(chatToOpen([a, b, c], "a")?.id).toBe("a");
    expect(chatToOpen([a, b, c], "gone")?.id).toBe("c");
    expect(chatToOpen([a, b, c, old], "old")?.id).toBe("c"); // an archived last chat isn't reopened
    expect(chatToOpen([old], null)).toBeNull(); // nothing open: the caller starts a new chat
  });
});

describe("side sheet", () => {
  const base = { chatId: "x", flowChat: null, artifactsChat: null, threadsOpen: false, threadCount: 0, shownEmptyFor: null };

  it("shows Progress or Artifacts when opened for this chat, and only for this chat", () => {
    expect(sheetTab({ ...base, flowChat: "x", threadsOpen: true, threadCount: 3 })).toBe("progress");
    expect(sheetTab({ ...base, artifactsChat: "x" })).toBe("artifacts");
    expect(sheetTab({ ...base, flowChat: "y", artifactsChat: "y" })).toBeNull();
  });

  it("opens Threads on its own only in chats with threads, or when you opened it for this chat", () => {
    expect(sheetTab({ ...base, threadsOpen: true, threadCount: 2 })).toBe("threads");
    expect(sheetTab({ ...base, threadsOpen: true })).toBeNull();
    expect(sheetTab({ ...base, threadsOpen: true, shownEmptyFor: "x" })).toBe("threads");
    expect(sheetTab({ ...base, threadsOpen: false, threadCount: 2 })).toBeNull();
  });

  it("Threads, Progress and Artifacts render inside the one floating sheet, never as fixed columns", () => {
    const tsx = read("src/renderer/views/ChatView.tsx");
    const sheet = tsx.slice(tsx.indexOf('<div className="side-sheet"'));
    for (const panel of ["<ThreadsPanel", "<ArtifactsPanel", "<FlowPanel"]) {
      expect(tsx.split(panel).length - 1, panel).toBe(1);
      expect(sheet, panel).toContain(panel);
    }
    for (const f of ["ThreadsPanel.tsx", "ArtifactsPanel.tsx", "FlowView.tsx"]) expect(read(`src/renderer/views/${f}`), f).toContain("<SheetTabs");
    expect(read("src/renderer/styles.css")).toMatch(/\.side-sheet \{ position: absolute;/);
  });

  it("threads open in the sheet: the chat shows only the reply chip, no inline thread", () => {
    const tsx = read("src/renderer/views/ChatView.tsx");
    expect(tsx).not.toContain("InlineThread");
    expect(tsx).toContain("openSideThread(m.chatId, m.id, { reply: true })");
    expect(read("src/renderer/store.ts")).not.toContain("openThreads");
  });
});

describe("sidebar", () => {
  it("lists projects, not their chats, and keeps New chat on top", () => {
    const tsx = read("src/renderer/components/Sidebar.tsx");
    expect(tsx).not.toMatch(/chat-link|chat-list/);
    expect(tsx).toContain('className="new-chat-btn"');
    expect(tsx).toContain("openProjectChat(p.id)");
  });
});
