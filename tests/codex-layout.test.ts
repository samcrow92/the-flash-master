import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Chat } from "../src/shared/types";
import { chatToOpen, sheetTab, switcherChats } from "../src/renderer/layout";
import { matchShortcut } from "../src/renderer/commands";

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
  it("project rows expand to list their chats, remembered across launches; threads never show there", () => {
    const tsx = read("src/renderer/components/Sidebar.tsx");
    expect(tsx).toContain('className="new-chat-btn"');
    // Regression (2026-11-20): layout A dropped the chat lists, so a project row only jumped to a chat and never expanded.
    expect(tsx).toMatch(/className="project-name"[^>]*aria-expanded=\{!!open\[p\.id\]\} onClick=\{\(\) => setOpen\(p\.id, !open\[p\.id\]\)\}/);
    expect(tsx).toContain("{open[p.id] && chatList(p.id)}");
    expect(tsx).toContain('className={`chat-link');
    expect(tsx).toMatch(/localStorage\.setItem\(OPEN_PREF/);
    expect(tsx).toContain("switcherChats(st.chats[key]");
    expect(tsx).not.toMatch(/thread/i);
    expect(read("src/renderer/styles.css")).toMatch(/\.chat-link \{ cursor: pointer;/);
  });
});

describe("composer", () => {
  it("keeps the drive modes and Duo's strip in the bar beside Send, nothing under the box", () => {
    const tsx = read("src/renderer/components/Composer.tsx");
    const bar = tsx.slice(tsx.indexOf('<div className="composer-bar">'), tsx.indexOf('className="primary send"'));
    expect(bar).toContain("<ModeBar");
    expect(bar).toContain("<DuoStrip");
    expect(tsx.split("<ModeBar ").length - 1).toBe(1);
    // A Duo chat shows only Duo's strip, never both (Mari, 2026-11-20: "replace the default one with the duo one").
    expect(bar).toContain("settings && !duo && <ModeBar");
    expect(tsx).toContain("if (!compact && duo && chat.mode) void patchChat({ mode: null })");
    const css = read("src/renderer/styles.css");
    expect(css).not.toContain(".composer-wrap > .mode-bar");
    // Drive modes on any chat use the same slanted strip as Duo's (Mari, 2026-11-20).
    const modeBar = tsx.slice(tsx.indexOf("function ModeBar("), tsx.indexOf("function DuoStrip("));
    expect(modeBar).toContain('className={`duo-strip drive-strip');
    expect(modeBar).toContain('className={`ds-seg ds-${m}');
    expect(modeBar).not.toContain("mode-btn");
    // The rest of the row speaks the same language (Mari, 2026-11-20): every button is a slanted ds-seg, Send included.
    const buttons = bar.match(/<button className=\{?["`][^"`]*["`]/g) ?? [];
    expect(buttons.length).toBeGreaterThan(5);
    for (const b of buttons) expect(b, b).toMatch(/ds-seg/);
    expect(css).toMatch(/\.composer2 \.composer-bar \.send \{[^}]*transform: skewX\(-18deg\)/);
    // Duo's strip keeps its full labels at the chat column's width (it is 780px wide).
    expect(css).toMatch(/@container \(max-width: 560px\) \{ \.ds-rev/);
  });
});

describe("collapsible sidebar", () => {
  it("Ctrl+B (Cmd+B on macOS) shows or hides it", () => {
    const k = (over: object) => ({ key: "b", ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...over });
    expect(matchShortcut(k({ ctrlKey: true }), false)).toBe("sidebar");
    expect(matchShortcut(k({ metaKey: true }), true)).toBe("sidebar");
    expect(matchShortcut(k({ ctrlKey: true, shiftKey: true }), false)).toBeNull();
  });

  it("is remembered across launches and leaves a toggle on screen while folded", () => {
    const store = read("src/renderer/store.ts");
    expect(store).toContain("sidebarCollapsed: readSidebarPref()");
    expect(store).toMatch(/localStorage\?\.setItem\(SIDEBAR_PREF/);
    const app = read("src/renderer/App.tsx");
    expect(app).toContain("{!sidebarCollapsed && <Sidebar />}");
    expect(app).toContain("<TitleBar terminal sidebar />");
    expect(read("src/renderer/components/TitleBar.tsx")).toContain('className="sidebar-toggle"');
    expect(read("src/renderer/styles.css")).toContain(".app.sidebar-collapsed { grid-template-columns: minmax(0, 1fr); }");
  });
});
