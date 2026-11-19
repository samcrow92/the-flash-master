import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dragReducer, idle, STALE_MS, type DragEvent, type DragState } from "../src/renderer/fileDrag";

const run = (events: DragEvent[], s: DragState = idle) => events.reduce(dragReducer, s);

describe("file-drag overlay", () => {
  it("shows on a file drag and ignores non-file drags", () => {
    expect(run([{ type: "enter", files: true, at: 1 }]).active).toBe(true);
    expect(run([{ type: "enter", files: false, at: 1 }, { type: "over", files: false, at: 2 }]).active).toBe(false);
  });

  it("stays up while moving between child elements and clears once every enter is left", () => {
    const inside = run([{ type: "enter", files: true, at: 1 }, { type: "enter", files: true, at: 2 }, { type: "leave", outside: false }]);
    expect(inside.active).toBe(true);
    expect(dragReducer(inside, { type: "leave", outside: false }).active).toBe(false);
  });

  it("clears when the drag leaves the window from a child element (the stuck-overlay bug)", () => {
    const s = run([{ type: "enter", files: true, at: 1 }, { type: "enter", files: true, at: 2 }, { type: "enter", files: true, at: 3 }]);
    expect(dragReducer(s, { type: "leave", outside: true })).toEqual(idle);
  });

  it("clears when dragover stops arriving (drop landed in another window, no leave sent)", () => {
    const s = run([{ type: "enter", files: true, at: 1000 }, { type: "over", files: true, at: 1050 }]);
    expect(dragReducer(s, { type: "tick", at: 1050 + STALE_MS - 1 }).active).toBe(true);
    expect(dragReducer(s, { type: "tick", at: 1050 + STALE_MS + 1 })).toEqual(idle);
  });

  it("clears on drop / dragend / blur / Esc / mouse move (all dispatch end)", () => {
    expect(run([{ type: "enter", files: true, at: 1 }, { type: "end" }])).toEqual(idle);
  });

  it("App listens on the window and offers a manual dismiss", () => {
    const app = readFileSync("src/renderer/App.tsx", "utf8");
    for (const ev of ['"dragleave"', '"drop"', '"dragend"', '"blur"', '"mousemove"', '"keydown"']) expect(app).toContain(ev);
    expect(app).toContain('"Escape"');
    expect(app).toMatch(/className="drop-hint-close"/);
    expect(app).not.toContain("e.currentTarget === e.target");
  });
});
