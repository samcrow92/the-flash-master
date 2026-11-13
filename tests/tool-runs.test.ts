import { describe, expect, it } from "vitest";
import { toolInputText, toolOutputText } from "../src/main/harness/acp";
import { piToolInput, piToolOutput } from "../src/main/harness/pi";
import { capOutput } from "../src/main/orchestrator";

describe("tool call input/output", () => {
  it("ACP: command lines, arguments, content and raw output", () => {
    expect(toolInputText({ command: ["git", "status"] })).toBe("git status");
    expect(toolInputText({ command: "npm", args: ["test"] })).toBe("npm test");
    expect(toolInputText({ path: "a.c" })).toContain('"path": "a.c"');
    expect(toolInputText({})).toBeUndefined();
    expect(toolOutputText([{ type: "content", content: { type: "text", text: "ok" } }, { type: "diff", path: "a.c" }], null)).toBe("ok\n(edited a.c)");
    expect(toolOutputText([], { stdout: "out", stderr: "err" })).toBe("out\nerr");
    expect(toolOutputText(undefined, "plain")).toBe("plain");
    expect(toolOutputText(undefined, undefined)).toBeUndefined();
  });
  it("Pi: bash command as is, result text", () => {
    expect(piToolInput("bash", { command: "ls -la" })).toBe("ls -la");
    expect(piToolInput("read", { path: "x" })).toContain('"path"');
    expect(piToolOutput({ content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] })).toBe("a\nb");
    expect(piToolOutput(undefined)).toBeUndefined();
  });
  it("caps long output keeping the start and the end", () => {
    const long = "S".repeat(100) + "x".repeat(50000) + "END-ERROR";
    const c = capOutput(long, 1000);
    expect(c.truncated).toBe(true);
    expect(c.text.startsWith("S")).toBe(true);
    expect(c.text.endsWith("END-ERROR")).toBe(true);
    expect(c.text.length).toBeLessThan(1100);
    expect(capOutput("short")).toEqual({ text: "short", truncated: false });
  });
});
