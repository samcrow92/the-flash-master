import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { estimateHeight, indexAt, prefixOffsets, visibleRange } from "../src/renderer/components/virtual";

const keys = ["a", "b", "c", "d", "e"];

describe("virtual message list", () => {
  it("offsets use measured heights and fall back to the estimate", () => {
    const off = prefixOffsets(keys, new Map([["a", 100], ["c", 50]]), 20);
    expect(off).toEqual([0, 100, 120, 170, 190, 210]);
    expect(prefixOffsets([], new Map(), 20)).toEqual([0]);
  });

  it("finds the item under a pixel, clamped to the list", () => {
    const off = [0, 100, 120, 170, 190, 210];
    expect(indexAt(off, -5)).toBe(0);
    expect(indexAt(off, 0)).toBe(0);
    expect(indexAt(off, 99)).toBe(0);
    expect(indexAt(off, 100)).toBe(1);
    expect(indexAt(off, 175)).toBe(3);
    expect(indexAt(off, 10_000)).toBe(4);
    expect(indexAt([0], 10)).toBe(0);
  });

  it("mounts only the slice around the viewport", () => {
    const n = 1000;
    const off = Array.from({ length: n + 1 }, (_, i) => i * 100); // 1000 messages of 100 px
    const [s, e] = visibleRange(off, 50_000, 800, 300);
    expect(s).toBe(497);
    expect(e).toBe(512);
    expect(e - s).toBeLessThan(20);
    expect(visibleRange(off, 0, 800, 300)).toEqual([0, 12]);
    expect(visibleRange(off, 99_200, 800, 300)[1]).toBe(n);
    expect(visibleRange([0], 0, 800, 300)).toEqual([0, 0]);
  });

  it("estimates unseen items from what was measured", () => {
    expect(estimateHeight(new Map(), 140)).toBe(140);
    expect(estimateHeight(new Map([["a", 100], ["b", 300]]), 140)).toBe(200);
    expect(estimateHeight(new Map([["a", 1]]), 140)).toBe(24);
  });

  it("the chat renders through the virtual list, not every message", () => {
    const src = readFileSync("src/renderer/views/ChatView.tsx", "utf8");
    expect(src).toContain("useVirtualList(");
    expect(src).not.toMatch(/\{messages\.map\(\(m\) => <MessageItem/);
    expect(src).toMatch(/export const MessageItem = memo\(/);
  });
});
