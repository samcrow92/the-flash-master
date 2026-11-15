import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { clamp, dragSize, PANELS, parseSizes } from "../src/renderer/panelSize";

const read = (f: string) => readFileSync(f, "utf8");

describe("panel resize sizes", () => {
  it("clamps to the panel's min and max", () => {
    expect(clamp(50, 200, 480)).toBe(200);
    expect(clamp(900, 200, 480)).toBe(480);
    expect(clamp(300.4, 200, 480)).toBe(300);
  });

  it("grows a right edge when dragged right and a left edge when dragged left", () => {
    expect(dragSize("sidebar", 252, 40, 1)).toBe(292);
    expect(dragSize("threads", 340, -60, -1)).toBe(400);
    expect(dragSize("threads", 340, 60, -1)).toBe(280);
    expect(dragSize("termH", 420, 100, 1)).toBe(520);
  });

  it("never grows past the room the chat can give, but always allows shrinking", () => {
    expect(dragSize("side", 380, -500, -1, 100)).toBe(480);
    expect(dragSize("side", 380, 40, -1, 0)).toBe(340);
    expect(dragSize("side", 380, -40, -1, -50)).toBe(380); // no room left: holds, doesn't jump smaller
  });

  it("reads saved sizes defensively", () => {
    expect(parseSizes(null)).toEqual({});
    expect(parseSizes("not json")).toEqual({});
    expect(parseSizes("[1,2]")).toEqual({});
    expect(parseSizes(JSON.stringify({ sidebar: 320, threads: "wide", side: 99999, bogus: 3, termH: NaN }))).toEqual({ sidebar: 320, side: PANELS.side.max });
  });

  it("every panel's CSS variable is read by the stylesheet with its default as fallback", () => {
    const css = read("src/renderer/styles.css");
    for (const p of Object.values(PANELS)) expect(css).toContain(`var(${p.cssVar}, ${p.def}px)`);
  });

  it("sidebar, Threads, Progress, Artifacts and terminal each carry a resize handle", () => {
    const files: Record<string, string> = {
      "src/renderer/components/Sidebar.tsx": 'panel="sidebar"',
      "src/renderer/views/ThreadsPanel.tsx": 'panel="threads"',
      "src/renderer/views/FlowView.tsx": 'panel="side"',
      "src/renderer/views/ArtifactsPanel.tsx": 'panel="side"',
      "src/renderer/components/TerminalPanel.tsx": 'panel="termH"',
    };
    for (const [f, needle] of Object.entries(files)) expect(read(f), f).toContain(needle);
  });

  it("a narrowed chat wraps its messages instead of scrolling sideways", () => {
    const css = read("src/renderer/styles.css");
    expect(css).not.toMatch(/(^|\n)(\.inline-thread |\.thread-side )?\.msg \{[^}]*grid-template-columns: \d+px 1fr/);
  });

  it("drags don't go through React state (keeps the virtual message list out of a render cascade)", () => {
    const src = read("src/renderer/components/ResizeHandle.tsx");
    expect(src).not.toMatch(/useState|useStore|setState/);
    expect(src).toContain("requestAnimationFrame");
  });
});
