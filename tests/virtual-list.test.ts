import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { MAX_SYNC_PASSES, estimateHeight, heightChanged, indexAt, nextPass, prefixOffsets, visibleRange } from "../src/renderer/components/virtual";

/**
 * Replays the list's measure loop while pinned to the bottom, the way Chromium lays it out: items have fractional
 * heights, offsetHeight is rounded from the item's position, and the slice above it is stood in for by a spacer sized
 * from the cached (rounded) heights. Returns the passes until nothing changed, or Infinity past React's limit of 50.
 */
function measureLoop(changed: (prev: number | undefined, next: number) => boolean, seed: number): number {
  const n = 60;
  const keys = Array.from({ length: n }, (_, i) => `m${i}`);
  let r = seed;
  const rnd = () => (r = (r * 1103515245 + 12345) % 2147483648) / 2147483648;
  const real = keys.map(() => 20 + rnd() * 400);
  const viewport = 600 + (seed % 37) * 7.37;
  const heights = new Map<string, number>();
  for (let pass = 1; pass <= 50; pass++) {
    const off = prefixOffsets(keys, heights, estimateHeight(heights, 140));
    const [s, e] = visibleRange(off, Math.max(0, off[n]! - viewport), viewport, 900);
    let y = 16.3 + off[s]!; // list padding + top spacer
    let any = false;
    for (let i = s; i < e; i++) {
      const h = Math.round(y + real[i]!) - Math.round(y);
      y += real[i]!;
      if (changed(heights.get(keys[i]!), h)) { heights.set(keys[i]!, h); any = true; }
    }
    if (!any) return pass;
  }
  return Infinity;
}

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

  it("measuring settles even when rounding makes an item read 1 px apart (blank gray window)", () => {
    // These layouts never settled with exact comparison: React threw "Maximum update depth exceeded" and the chat unmounted.
    for (const seed of [1039, 19905]) expect(measureLoop((a, b) => a !== b, seed)).toBe(Infinity);
    let worst = 0;
    for (let seed = 1; seed < 20_000; seed++) worst = Math.max(worst, measureLoop(heightChanged, seed));
    expect(worst).toBeLessThanOrEqual(MAX_SYNC_PASSES);
  });

  it("treats a 1 px rounding difference as unchanged, but a real resize or a first measurement as a change", () => {
    expect(heightChanged(undefined, 100)).toBe(true);
    expect(heightChanged(100, 101)).toBe(false);
    expect(heightChanged(101, 100)).toBe(false);
    expect(heightChanged(100, 102)).toBe(true);
    expect(heightChanged(100, 60)).toBe(true);
  });

  it("caps synchronous re-measure passes and hands the rest to the next frame", () => {
    let passes = 0;
    for (let i = 0; i < MAX_SYNC_PASSES; i++) {
      const s = nextPass(passes, true);
      expect(s.run).toBe("now");
      passes = s.passes;
    }
    expect(MAX_SYNC_PASSES).toBeLessThan(50); // React's nested-update limit
    expect(nextPass(passes, true).run).toBe("next-frame");
    expect(nextPass(passes, false)).toEqual({ passes: 0, run: "none" });
  });

  it("the chat renders through the virtual list, not every message", () => {
    const src = readFileSync("src/renderer/views/ChatView.tsx", "utf8");
    expect(src).toContain("useVirtualList(");
    expect(src).not.toMatch(/\{messages\.map\(\(m\) => <MessageItem/);
    expect(src).toMatch(/export const MessageItem = memo\(/);
  });
});
