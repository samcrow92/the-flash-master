import { describe, expect, it } from "vitest";
import { paragraphBreak, replySegments } from "../src/shared/replySegments";
import { rolePrefix } from "../src/main/context";
import type { ToolRun } from "../src/shared/types";

const run = (id: string, at: number | undefined, kind = "execute"): ToolRun => ({ id, title: id, kind, status: "completed", startedAt: 0, at });

describe("reply segments", () => {
  it("adds a paragraph break only where one is missing", () => {
    expect(paragraphBreak("")).toBe("");
    expect(paragraphBreak("Checking.")).toBe("\n\n");
    expect(paragraphBreak("Checking.\n")).toBe("\n");
    expect(paragraphBreak("Checking.\n\n")).toBe("");
  });

  it("places commands and reasoning between the paragraphs they came between", () => {
    const text = "Let me look.\n\nFound it.\n\nDone.";
    const segs = replySegments(text, [run("ls", 12), run("cat", 12), run("think-1", 23, "think"), run("edit", 23)]);
    expect(segs.map((s) => s.kind)).toEqual(["text", "tools", "text", "thought", "tools", "text"]);
    expect(segs[1]).toMatchObject({ tools: [{ id: "ls" }, { id: "cat" }] });
    expect(segs[2]).toMatchObject({ text: "\n\nFound it." });
    expect(segs[5]).toMatchObject({ text: "\n\nDone." });
  });

  it("keeps older replies (no offsets) with their commands on top, and tolerates bad offsets", () => {
    expect(replySegments("Hi", [run("a", undefined)]).map((s) => s.kind)).toEqual(["tools", "text"]);
    expect(replySegments("Hi", [run("a", 99)]).map((s) => s.kind)).toEqual(["text", "tools"]);
    expect(replySegments("", []).length).toBe(0);
  });

  it("asks agents for short paragraphs", () => {
    const role = { name: "r", title: "R", icon: "", description: "", tools: [], maxResultTokens: 300, skills: [], prompt: "Do it.", source: "builtin" } as any;
    expect(rolePrefix(role, "/p")).toContain("short paragraphs");
  });
});
