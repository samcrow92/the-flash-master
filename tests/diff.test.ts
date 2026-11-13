import { describe, expect, it } from "vitest";
import { diffLines, unifiedPatch, wordDiff } from "../src/shared/diff";

const A = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"].join("\n") + "\n";
const B = ["a", "b", "C", "d", "e", "f", "g", "h", "i", "j", "k"].join("\n") + "\n";

describe("diff", () => {
  it("finds minimal line changes with correct numbering", () => {
    const d = diffLines(A, B);
    expect(d).toMatchObject({ added: 2, removed: 1, identical: false, truncated: false });
    expect(d.ops.filter((o) => o.t !== "eq")).toEqual([{ t: "del", a: 3, text: "c" }, { t: "add", b: 3, text: "C" }, { t: "add", b: 11, text: "k" }]);
    expect(d.hunks).toHaveLength(2);
    expect(d.hunks[0]).toMatchObject({ aStart: 1, aLen: 6, bStart: 1, bLen: 6 });
  });
  it("produces a unified patch that git would accept", () => {
    expect(unifiedPatch("src/x.c", A, B)).toBe(
      "--- a/src/x.c\n+++ b/src/x.c\n@@ -1,6 +1,6 @@\n a\n b\n-c\n+C\n d\n e\n f\n@@ -8,3 +8,4 @@\n h\n i\n j\n+k\n");
    expect(unifiedPatch("x", A, A)).toBe("");
  });
  it("handles new and deleted files", () => {
    expect(diffLines("", "x\ny\n")).toMatchObject({ added: 2, removed: 0 });
    expect(unifiedPatch("n", "", "x\n")).toBe("--- a/n\n+++ b/n\n@@ -0,0 +1,1 @@\n+x\n");
    expect(diffLines("x\n", "")).toMatchObject({ added: 0, removed: 1 });
  });
  it("stays fast on large files with small edits", () => {
    const big = Array.from({ length: 20000 }, (_, i) => `line ${i}`).join("\n");
    const t = Date.now();
    const d = diffLines(big, big.replace("line 10000", "line 10000 changed"));
    expect(Date.now() - t).toBeLessThan(500);
    expect(d).toMatchObject({ added: 1, removed: 1 });
  });
  it("highlights changed words inside a line", () => {
    const w = wordDiff("timeout = 50; // ms", "timeout = 100; // ms");
    expect(w.a.filter(([, c]) => c).map(([t]) => t)).toEqual(["50"]);
    expect(w.b.filter(([, c]) => c).map(([t]) => t)).toEqual(["100"]);
  });
});
