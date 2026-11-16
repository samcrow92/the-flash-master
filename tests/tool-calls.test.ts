import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { toolArgsPreview, toolCallsSummary, toolKindLabel } from "../src/renderer/components/toolCalls";

describe("tool calls stand apart from reply prose", () => {
  it("labels each call with a verb badge", () => {
    expect(toolKindLabel("execute")).toBe("Run");
    expect(toolKindLabel("read")).toBe("Read");
    expect(toolKindLabel("search")).toBe("Search");
    expect(toolKindLabel("something-new")).toBe("Tool");
  });
  it("previews arguments on one line, skipping ones that repeat the title", () => {
    expect(toolArgsPreview({ title: "Reading files", input: "git ls-files\n  src" })).toBe("git ls-files src");
    expect(toolArgsPreview({ title: "ls -la", input: "ls -la" })).toBe("");
    expect(toolArgsPreview({ title: "x" })).toBe("");
    const long = toolArgsPreview({ title: "x", input: "a".repeat(300) }, 20);
    expect(long).toHaveLength(20);
    expect(long.endsWith("…")).toBe(true);
  });
  it("headers a group with its count and what is still running or failed", () => {
    expect(toolCallsSummary([{ status: "completed" }])).toEqual({ label: "Tool call", detail: "" });
    expect(toolCallsSummary([{ status: "completed" }, { status: "in_progress" }, { status: "failed" }]))
      .toEqual({ label: "3 tool calls", detail: "1 running · 1 failed" });
    // A call the user (or the timeout) stopped counts as stopped, not failed.
    expect(toolCallsSummary([{ status: "failed", stopped: "Stopped by you" }, { status: "failed" }]))
      .toEqual({ label: "2 tool calls", detail: "1 stopped · 1 failed" });
  });
  it("renders as a labelled, tinted section, not as another line of text", () => {
    const tsx = readFileSync("src/renderer/components/ToolRuns.tsx", "utf8");
    expect(tsx).toContain('className="tool-runs-head"');
    expect(tsx).toContain('className="tool-run-badge"');
    const css = readFileSync("src/renderer/styles.css", "utf8");
    const section = css.match(/^\.tool-runs \{[^}]*\}/m)?.[0] ?? "";
    expect(section).toContain("--tool-tint");
    expect(section).toContain("border-left");
    expect(section).toContain("background");
  });
});
