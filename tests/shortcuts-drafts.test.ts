import { describe, expect, it } from "vitest";
import type { Chat } from "@shared/types";
import { chatOrder, matchShortcut, rankCommands, scoreCommand, SHORTCUTS, shortcutLabel, stepChat, type KeyLike, type ShortcutId } from "../src/renderer/commands";
import { createDraftStore, draftKey, MAX_DRAFTS } from "../src/renderer/drafts";

const key = (k: string, mods: Partial<KeyLike> = {}): KeyLike => ({ key: k, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...mods });

describe("keyboard shortcuts", () => {
  it("use Ctrl on Windows/Linux and Cmd on macOS", () => {
    expect(matchShortcut(key("k", { ctrlKey: true }), false)).toBe("palette");
    expect(matchShortcut(key("k", { metaKey: true }), true)).toBe("palette");
    expect(matchShortcut(key("k", { metaKey: true }), false)).toBeNull();
    expect(matchShortcut(key("k", { ctrlKey: true }), true)).toBeNull();
    expect(matchShortcut(key("N", { ctrlKey: true }), false)).toBe("newChat"); // Caps Lock
    expect(matchShortcut(key(",", { metaKey: true }), true)).toBe("settings");
    expect(matchShortcut(key("l", { ctrlKey: true }), false)).toBe("focusComposer");
  });

  it("leave other combinations to the page (Ctrl+Shift+K, AltGr, plain letters)", () => {
    expect(matchShortcut(key("k", { ctrlKey: true, shiftKey: true }), false)).toBeNull();
    expect(matchShortcut(key("k", { ctrlKey: true, altKey: true }), false)).toBeNull();
    expect(matchShortcut(key("k"), false)).toBeNull();
    expect(matchShortcut(key("Escape", { shiftKey: true }), false)).toBeNull();
  });

  it("Esc stops and Alt+arrows switch chats", () => {
    expect(matchShortcut(key("Escape"), false)).toBe("stop");
    expect(matchShortcut(key("ArrowUp", { altKey: true }), true)).toBe("prevChat");
    expect(matchShortcut(key("ArrowDown", { altKey: true }), false)).toBe("nextChat");
  });

  it("every listed shortcut is matched by the key it advertises", () => {
    const parse = (keys: string): KeyLike => {
      const parts = keys.split("+");
      const last = parts.pop()!;
      const k = { "↑": "ArrowUp", "↓": "ArrowDown", Esc: "Escape" }[last] ?? last.toLowerCase();
      return key(k, { altKey: parts.includes("Alt") });
    };
    for (const mac of [false, true]) {
      for (const [id, s] of Object.entries(SHORTCUTS) as [ShortcutId, { keys: string }][]) {
        const e = parse(s.keys);
        if (s.keys.startsWith("Mod+")) { if (mac) e.metaKey = true; else e.ctrlKey = true; }
        expect(matchShortcut(e, mac), `${s.keys} (${mac ? "mac" : "win"})`).toBe(id);
      }
    }
  });

  it("are labelled for the platform", () => {
    expect(shortcutLabel("Mod+K", false)).toBe("Ctrl+K");
    expect(shortcutLabel("Mod+K", true)).toBe("⌘K");
    expect(shortcutLabel("Alt+↑", true)).toBe("⌥↑");
  });
});

describe("chat switching order", () => {
  const chat = (id: string, projectId: string, createdAt: number, extra: Partial<Chat> = {}) => ({ id, projectId, createdAt, pinned: false, archived: false, ...extra }) as Chat;
  const chats = {
    p1: [chat("a", "p1", 1), chat("b", "p1", 2, { pinned: true }), chat("x", "p1", 3, { archived: true })],
    p2: [chat("c", "p2", 1)],
  };

  it("follows the sidebar: master, then pinned and open chats per project", () => {
    expect(chatOrder("m", ["p1", "p2"], chats)).toEqual(["m", "b", "a", "c"]);
  });

  it("wraps around and starts from either end when no chat is open", () => {
    const order = ["m", "b", "a", "c"];
    expect(stepChat(order, "c", 1)).toBe("m");
    expect(stepChat(order, "m", -1)).toBe("c");
    expect(stepChat(order, null, 1)).toBe("m");
    expect(stepChat(order, null, -1)).toBe("c");
    expect(stepChat([], null, 1)).toBeNull();
  });
});

describe("command palette ranking", () => {
  const items = [
    { id: "1", group: "Chat", label: "Fix login bug" },
    { id: "2", group: "Settings", label: "Settings · MCP servers", keywords: "preferences mcp" },
    { id: "3", group: "Go to", label: "Marketplace", keywords: "plugins skills" },
    { id: "4", group: "Agent", label: "Chat with Code Reviewer", keywords: "@reviewer" },
  ];

  it("ranks prefix over word start over substring over scattered letters", () => {
    expect(scoreCommand({ label: "Marketplace" }, "mar")).toBeGreaterThan(scoreCommand({ label: "Chat with Marketplace" }, "mar"));
    expect(scoreCommand({ label: "Chat with Marketplace" }, "mar")).toBeGreaterThan(scoreCommand({ label: "Summary" }, "mar"));
    expect(scoreCommand({ label: "Summary" }, "mar")).toBeGreaterThan(scoreCommand({ label: "Mobile art" }, "mar"));
    expect(scoreCommand({ label: "Dashboard" }, "zzz")).toBe(0);
  });

  it("matches keywords and multi-word queries", () => {
    expect(rankCommands(items, "plugins").map((i) => i.id)).toEqual(["3"]);
    expect(rankCommands(items, "set mcp")[0]!.id).toBe("2");
    expect(rankCommands(items, "@reviewer")[0]!.id).toBe("4");
  });

  it("keeps the given order for an empty query", () => {
    expect(rankCommands(items, "  ").map((i) => i.id)).toEqual(["1", "2", "3", "4"]);
  });
});

describe("per-chat drafts", () => {
  const memStorage = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) }; };

  it("keeps one draft per chat and per thread", () => {
    const d = createDraftStore(memStorage());
    d.set(draftKey("chat1", null), { text: "hello" });
    d.set(draftKey("chat1", "root9"), { text: "thread reply" });
    expect(d.get(draftKey("chat2", null)).text).toBe("");
    expect(d.get("chat1").text).toBe("hello");
    expect(d.get("chat1/root9").text).toBe("thread reply");
  });

  it("survives a restart (text) and clears on send", () => {
    const storage = memStorage();
    const a = createDraftStore(storage);
    a.set("c", { text: "half typed", attachments: [{ id: "x" } as never] });
    const b = createDraftStore(storage);
    expect(b.get("c")).toEqual({ text: "half typed", attachments: [] });
    b.clear("c");
    expect(createDraftStore(storage).get("c").text).toBe("");
  });

  it("does not drop drafts written by another window", () => {
    const storage = memStorage();
    const main = createDraftStore(storage);
    const popout = createDraftStore(storage);
    popout.set("c/root", { text: "from the thread window" });
    main.set("c", { text: "from the main window" });
    expect(createDraftStore(storage).keys().sort()).toEqual(["c", "c/root"]);
  });

  it("caps stored drafts, dropping the least recently edited", () => {
    const d = createDraftStore(memStorage());
    for (let i = 0; i <= MAX_DRAFTS; i++) d.set(`k${i}`, { text: "x" });
    expect(d.keys()).toHaveLength(MAX_DRAFTS);
    expect(d.get("k0").text).toBe("");
    expect(d.get(`k${MAX_DRAFTS}`).text).toBe("x");
  });

  it("works without storage", () => {
    const d = createDraftStore(null);
    d.set("c", { text: "t" });
    expect(d.get("c").text).toBe("t");
  });
});
