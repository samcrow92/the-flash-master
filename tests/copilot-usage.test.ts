import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseCopilotUsage } from "../src/main/copilot-usage";
import { AcpAdapter } from "../src/main/harness/acp";

const FAKE = join(__dirname, "fixtures", "fake-acp-agent.mjs");

describe("Copilot /usage parser", () => {
  it("reads used / limit, percent and reset", () => {
    const u = parseCopilotUsage("\x1b[1mUsage\x1b[0m\n  Premium requests: 1,234 / 1,500 (82.3%)\n  Resets on: Dec 1, 2026\n  Plan: Copilot Enterprise");
    expect(u.ok).toBe(true);
    expect(u.premium).toEqual({ used: 1234, limit: 1500, percent: 82.3, unlimited: false });
    expect(u.resetAt).toBe("Dec 1, 2026");
    expect(u.entries).toContainEqual({ label: "Plan", value: "Copilot Enterprise" });
  });

  it("computes percent and handles 'remaining', 'of' and unlimited", () => {
    expect(parseCopilotUsage("Premium requests used: 30 of 300").premium).toMatchObject({ used: 30, limit: 300, percent: 10 });
    expect(parseCopilotUsage("Premium requests: 40 used, 260 remaining").premium).toMatchObject({ used: 40, limit: 300 });
    expect(parseCopilotUsage("Premium requests: unlimited (12 used)").premium).toMatchObject({ unlimited: true, limit: null, percent: null });
  });

  it("keeps session-only output (no quota) and reports unreadable text", () => {
    const s = parseCopilotUsage("Total usage est:        3 Premium requests\nAPI time spent:         12s\nUsage by model:\n    gpt-5   1.2k input, 300 output");
    expect(s.premium.used).toBe(3);
    expect(s.premium.limit).toBeNull();
    expect(s.entries.map((e) => e.label)).toContain("API time spent");
    const bad = parseCopilotUsage("");
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/no text/);
  });
});

describe("running /usage over ACP", () => {
  const probe = (env: Record<string, string> = {}) => ({ executable: process.execPath, cwd: tmpdir(), env, extraArgs: "" });
  const adapter = new AcpAdapter("copilot", "Fake Copilot", [process.execPath], [FAKE], "");

  it("sends /usage when the agent advertises it and returns the printed text", async () => {
    const r = await adapter.runCommand(probe(), "usage", true);
    expect(r.advertised).toBe(true);
    expect(parseCopilotUsage(r.text).premium).toMatchObject({ used: 123, limit: 300, percent: 41 });
  });

  it("does not send it when not advertised (no premium request spent)", async () => {
    const r = await adapter.runCommand(probe({ FAKE_COMMANDS: "none" }), "usage", true);
    expect(r).toMatchObject({ advertised: false, text: "" });
  }, 15000);
});
