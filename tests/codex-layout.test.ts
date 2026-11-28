import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentRun, Chat } from "../src/shared/types";
import { chatToOpen, projectTree, sheetTab, switcherChats, threadStatus } from "../src/renderer/layout";
import { matchShortcut } from "../src/renderer/commands";

const read = (f: string) => readFileSync(join(__dirname, "..", f), "utf8");
const chat = (id: string, over: Partial<Chat> = {}): Chat => ({
  id, projectId: "p", title: id, kind: "project", agentRole: "flashmaster", harness: null, model: null, superpowers: false, mode: null,
  autopilot: false, archived: false, pinned: false, createdAt: 0, coordinator: false, parentChatId: null, feature: null, ...over,
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
  const base = { chatId: "x", flowChat: null, artifactsChat: null };

  it("shows Progress or Artifacts when opened for this chat, and only for this chat", () => {
    expect(sheetTab({ ...base, flowChat: "x" })).toBe("progress");
    expect(sheetTab({ ...base, artifactsChat: "x" })).toBe("artifacts");
    expect(sheetTab({ ...base, flowChat: "y", artifactsChat: "y" })).toBeNull();
  });

  it("Progress and Artifacts render inside the one floating sheet, never as fixed columns", () => {
    const tsx = read("src/renderer/views/ChatView.tsx");
    const sheet = tsx.slice(tsx.indexOf('<div className="side-sheet"'));
    for (const panel of ["<ArtifactsPanel", "<FlowPanel"]) {
      expect(tsx.split(panel).length - 1, panel).toBe(1);
      expect(sheet, panel).toContain(panel);
    }
    for (const f of ["ArtifactsPanel.tsx", "FlowView.tsx"]) expect(read(`src/renderer/views/${f}`), f).toContain("<SheetTabs");
    expect(read("src/renderer/styles.css")).toMatch(/\.side-sheet \{ position: absolute;/);
  });

  it("reply threads are gone: no reply chip, Threads tab or thread window (project threads replaced them, 2026-11-28)", () => {
    const tsx = read("src/renderer/views/ChatView.tsx");
    for (const gone of ["ThreadPill", "ThreadPanel", "openSideThread", "Reply in thread", "<ThreadsPanel"]) expect(tsx, gone).not.toContain(gone);
    expect(read("src/renderer/components/SheetTabs.tsx")).not.toContain('"threads"');
    expect(read("src/shared/api.ts")).not.toMatch(/openThreadWindow|archiveThread|deleteThread/);
  });
});

describe("artifacts tab", () => {
  it("keeps its Changes / Git / Saved / Code buttons when a long Git list is refreshed", () => {
    // Regression (2026-11-20): the list wasn't the part that shrank, so a refreshed Git tab squeezed the buttons away.
    const css = read("src/renderer/styles.css");
    expect(css).toContain(".artifacts-panel > .art-tabs, .artifacts-panel > .sheet-head { flex: none; }");
    expect(css).toContain(".artifacts-panel > .art-list { flex: 1 1 auto; min-height: 0; }");
    // Paths cut from the left keep their order (a leading dot stayed at the end under direction: rtl).
    const tsx = read("src/renderer/views/ArtifactsPanel.tsx");
    expect(tsx.split("<bdi>").length - 1).toBe(3);
  });
});

describe("sidebar", () => {
  it("project rows expand into their tree (coordinator, features, threads), remembered across launches", () => {
    const tsx = read("src/renderer/components/Sidebar.tsx");
    expect(tsx).toContain('className="new-chat-btn"');
    // Regression (2026-11-20): layout A dropped the chat lists, so a project row only jumped to a chat and never expanded.
    expect(tsx).toMatch(/className="project-name"[^>]*aria-expanded=\{!!open\[p\.id\]\} onClick=\{\(\) => setOpen\(p\.id, !open\[p\.id\]\)\}/);
    expect(tsx).toContain("{open[p.id] && projectList(p)}");
    expect(tsx).toContain("projectTree(st.chats[key]");
    expect(tsx).toContain('className={`chat-link');
    expect(tsx).toMatch(/localStorage\.setItem\(OPEN_PREF/);
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
    // Regression (2026-11-20): with Steer / Queue in the row the buttons spilled out of the chat box. The row may wrap,
    // the strip and Send wrap together, and the toggles drop their words while an agent runs.
    expect(css).toContain(".composer-bar { flex-wrap: wrap; row-gap: 6px; }");
    expect(css).toMatch(/\.cb-drive \{[^}]*flex: none;/);
    expect(css).toContain(".composer-bar:has(.cb-busy) .cb-toggle .cb-label { display: none; }");
    expect(tsx).toContain('<div className="cb-drive">');
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

describe("project tree", () => {
  const t = (id: string, createdAt: number, over: Partial<Chat> = {}) => chat(id, { createdAt, parentChatId: "coord", ...over });

  it("puts the coordinator first, then features (newest first) with their threads in start order, then other chats", () => {
    const coord = chat("coord", { coordinator: true, createdAt: 1 });
    const tree = projectTree([coord, t("a1", 2, { feature: "Export" }), t("b1", 3, { feature: "XCP" }), t("a2", 5, { feature: "Export" }),
      chat("loose", { createdAt: 4 }), t("nofeat", 6), t("gone", 7, { feature: "XCP", archived: true })]);
    expect(tree.coordinator?.id).toBe("coord");
    expect(tree.features.map((f) => [f.name, f.threads.map((c) => c.id)])).toEqual([["Export", ["a1", "a2"]], ["XCP", ["b1"]]]);
    expect(tree.other.map((c) => c.id)).toEqual(["nofeat", "loose"]);
    expect(tree.archived.map((c) => c.id)).toEqual(["gone"]);
  });

  it("a thread is working while one of its agents runs, and needs you while one waits on a card", () => {
    const a = (status: AgentRun["status"], lastActivity: string | null = null) => ({ chatId: "t", status, lastActivity }) as AgentRun;
    expect(threadStatus("t", [a("running")])).toBe("working");
    expect(threadStatus("t", [a("idle", "❓ Needs you: which bus?")])).toBe("needs_you");
    expect(threadStatus("t", [a("idle", "Done")])).toBe("idle");
    expect(threadStatus("other", [a("running")])).toBe("idle");
  });
});

