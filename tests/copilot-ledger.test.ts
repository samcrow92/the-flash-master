import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LiveLedger, parseSessionUsage, parseShutdowns, scanSessionLogs, summarizeLocal, toUsage, type LiveSnapshot } from "../src/main/copilot-ledger";
import { fetchQuota, findCopilotToken, parseQuota, tokenFromConfig, type Exec, type Fetch } from "../src/main/copilot-quota";
import { AcpAdapter } from "../src/main/harness/acp";
import type { HarnessEvent, SessionOptions } from "../src/main/harness/types";
import { usageLabel } from "../src/shared/usage-label";

const NOV = { year: 2026, month: 11 };
const at = (d: string) => Date.parse(`${d}T12:00:00Z`);
const USAGE_TEXT = `Usage:
  Total usage est:        7 Premium requests
  API time spent:         2m 59.626s
  claude-sonnet-4.5       453.0k in, 13.1k out, 405.7k cached (Est. 5 Premium requests)
  gpt-5                   1.2k in, 300 out (Est. 2 Premium requests)`;
const shutdown = (ts: string, metrics: Record<string, number>) => JSON.stringify({
  type: "session.shutdown", timestamp: ts,
  data: { modelMetrics: Object.fromEntries(Object.entries(metrics).map(([m, c]) => [m, { usage: { inputTokens: 1, outputTokens: 1 }, requests: { count: 1, cost: c } }])) },
});

describe("reading Copilot's own usage", () => {
  it("parses /usage text: total, unit and per-model estimates", () => {
    expect(parseSessionUsage(USAGE_TEXT)).toEqual({ total: 7, unit: "requests", models: { "claude-sonnet-4.5": 5, "gpt-5": 2 } });
    expect(parseSessionUsage("Total usage est: 12.5 credits")).toMatchObject({ total: 12.5, unit: "credits" });
    expect(parseSessionUsage("Session ID: x\nDuration: 3s")).toBeNull();
  });

  it("parses session.shutdown records of Copilot's session log", () => {
    const log = [JSON.stringify({ type: "session.start", data: {} }), shutdown("2026-11-03T10:00:00Z", { "claude-opus-4.7": 15, "gpt-5": 1 }), "not json"].join("\n");
    expect(parseShutdowns(log)).toEqual([{ at: Date.parse("2026-11-03T10:00:00Z"), total: 16, models: { "claude-opus-4.7": 15, "gpt-5": 1 } }]);
  });

  it("scans ~/.copilot/session-state and skips logs untouched this month", async () => {
    const dir = mkdtempSync(join(tmpdir(), "copilot-home-"));
    mkdirSync(join(dir, "session-state", "s1"), { recursive: true });
    writeFileSync(join(dir, "session-state", "s1", "events.jsonl"), shutdown("2026-11-03T10:00:00Z", { "gpt-5": 3 }));
    expect([...(await scanSessionLogs(dir, 0)).keys()]).toEqual(["s1"]);
    expect((await scanSessionLogs(dir, Date.now() + 60_000)).size).toBe(0);
    expect((await scanSessionLogs(join(dir, "missing"), 0)).size).toBe(0);
  });

  it("adds logs and the app's live /usage without counting a session twice", () => {
    const logs = new Map([
      ["s1", [{ at: at("2026-11-03"), total: 16, models: { "claude-opus-4.7": 15, "gpt-5": 1 } }]],
      ["old", [{ at: at("2026-10-30"), total: 99, models: { "gpt-5": 99 } }]],
    ]);
    const live: LiveSnapshot[] = [
      { sessionId: "s1", at: at("2026-11-02"), total: 10, models: { "claude-opus-4.7": 10 } }, // before its shutdown: already counted
      { sessionId: "app", at: at("2026-11-10"), total: 7, models: { "claude-sonnet-4.5": 5, "gpt-5": 2 }, unit: "requests" as const },
    ];
    const b = summarizeLocal(logs, live, NOV, { allowance: 300 });
    expect(b).toMatchObject({ used: 23, sessions: 2, appSessions: 1, allowance: 300, available: 277, availableFrom: "setting", usedOfAvailable: 23, percent: 7.7 });
    expect(b.models.map((m) => [m.model, m.quantity])).toEqual([["claude-opus-4.7", 15], ["claude-sonnet-4.5", 5], ["gpt-5", 3]]);
  });

  it("takes available credits from Copilot and computes usage from them", () => {
    const quota = { entitlement: 1500, remaining: 600, unlimited: false, overage: 0, unit: "credits" as const, resetAt: "2026-12-01", plan: "individual_pro" };
    const b = summarizeLocal(new Map(), [{ sessionId: "a", at: at("2026-11-05"), total: 800, models: { "claude-opus-5.5": 800 } }], NOV, { allowance: 50, quota, signIn: "Copilot's sign-in (system keychain)" });
    expect(b).toMatchObject({ unit: "credits", allowance: 1500, available: 600, availableFrom: "copilot", usedOfAvailable: 900, percent: 60, signIn: "Copilot's sign-in (system keychain)" });
    const u = toUsage(b, { resetAt: quota.resetAt });
    expect(u).toMatchObject({ ok: true, error: null, resetAt: "2026-12-01", premium: { used: 900, limit: 1500, percent: 60 } });
    expect(usageLabel(u)).toBe("Copilot · 600 of 1,500 credits available · 900 used (60%) · top: claude-opus-5.5 100%");
  });

  it("says why credits are missing and still shows what was used", () => {
    const u = toUsage(summarizeLocal(new Map(), [], NOV), { quotaError: "Couldn't find Copilot's sign-in on this computer.", advertised: false, commands: ["model"] });
    expect(u.error).toMatch(/Couldn't find Copilot's sign-in/);
    expect(u.error).toMatch(/does not offer \/usage to apps \(commands: model\)/);
    expect(usageLabel(u)).toBe("Copilot · 0 credits used this month");
  });

  it("keeps only the latest live snapshot per session", () => {
    let saved = "";
    const l = new LiveLedger(() => null, (j) => { saved = j; });
    l.record("a", { total: 2, models: {} }, at("2026-11-01"));
    l.record("a", { total: 5, models: {} }, at("2026-11-02"));
    expect(l.all().map((s) => s.total)).toEqual([5]);
    expect(new LiveLedger(() => saved, () => undefined).all()).toHaveLength(1);
  });
});

describe("available credits with Copilot's existing sign-in", () => {
  const none: Exec = async () => { throw new Error("no"); };
  const noFile = async () => { throw new Error("ENOENT"); };
  const base = { env: {}, appToken: "", copilotDir: "/c", exec: none, readText: noFile, platform: "darwin" };

  it("finds the token in Copilot's own order", async () => {
    expect(await findCopilotToken({ ...base, env: { GH_TOKEN: "gho_env", COPILOT_GITHUB_TOKEN: "gho_first" } })).toEqual({ token: "gho_first", from: "COPILOT_GITHUB_TOKEN" });
    const keychain: Exec = async (cmd, args) => (cmd === "security" && args.includes("copilot-cli") ? "gho_abcdefghijklmnopqrstuvwxyz0123\n" : Promise.reject(new Error("x")));
    expect(await findCopilotToken({ ...base, exec: keychain })).toMatchObject({ token: "gho_abcdefghijklmnopqrstuvwxyz0123", from: expect.stringMatching(/keychain/) });
    const cfg = async (p: string) => (p.endsWith("config.json") ? JSON.stringify({ model: "x", copilot_tokens: { "https://github.com:me": "gho_fromconfig0123456789abcdefgh" } }) : "");
    expect(await findCopilotToken({ ...base, readText: cfg })).toMatchObject({ token: "gho_fromconfig0123456789abcdefgh", from: expect.stringMatching(/config\.json/) });
    const gh: Exec = async (cmd) => (cmd === "gh" ? "gho_ghcli0123456789abcdefghijklm" : Promise.reject(new Error("x")));
    expect(await findCopilotToken({ ...base, exec: gh })).toMatchObject({ from: "GitHub CLI's sign-in" });
    expect(await findCopilotToken(base)).toBeNull();
    expect(tokenFromConfig("{ not json")).toBeNull();
  });

  it("reads remaining credits from Copilot's entitlement", async () => {
    expect(parseQuota({ copilot_plan: "individual", quota_reset_date: "2026-12-01", quota_snapshots: { premium_interactions: { entitlement: 300, remaining: 120, overage_count: 0, unlimited: false } } }))
      .toEqual({ entitlement: 300, remaining: 120, unlimited: false, overage: 0, unit: "requests", resetAt: "2026-12-01", plan: "individual" });
    expect(parseQuota({ quota_snapshots: { ai_credits: { entitlement: 1500, percent_remaining: 40 } } })).toMatchObject({ unit: "credits", remaining: 600 });
    expect(parseQuota({ quota_snapshots: { chat: { unlimited: true } } })).toBeNull();
    const ok: Fetch = async (url, init) => ({ ok: true, status: 200, json: async () => ({ url, auth: init?.headers?.Authorization, quota_snapshots: { ai_credits: { entitlement: 10, remaining: 4 } } }) });
    expect(await fetchQuota(ok, "gho_x")).toMatchObject({ entitlement: 10, remaining: 4 });
    await expect(fetchQuota(async () => ({ ok: false, status: 401, json: async () => ({}) }), "t")).rejects.toThrow(/expired/);
    await expect(fetchQuota(async () => ({ ok: false, status: 404, json: async () => ({}) }), "t")).rejects.toThrow(/not be a Copilot login/);
  });
});

describe("silent /usage after each Copilot turn", () => {
  const FAKE = join(__dirname, "fixtures", "fake-acp-agent.mjs");
  const adapter = new AcpAdapter("copilot", "Fake", [process.execPath], [FAKE], "");
  const opts = (onUsage: SessionOptions["onUsage"], env: Record<string, string> = {}) => {
    const events: HarnessEvent[] = [];
    const o: SessionOptions = {
      cwd: process.cwd(), model: null, extraArgs: "", executable: process.execPath, mcpServers: [], env, resumeSessionId: null,
      policy: { approval: "auto-read", readOnly: false, blocked: [], projectRoot: process.cwd() },
      onEvent: (e) => events.push(e), askPermission: async () => true, onUsage,
    };
    return { o, events };
  };

  it("reports /usage without showing it in the chat, and the next turn waits for it", async () => {
    const got: { text: string | null }[] = [];
    const { o, events } = opts((r) => got.push(r));
    const s = await adapter.start(o);
    await new Promise((r) => setTimeout(r, 100)); // commands arrive just after session/new
    await s.prompt("hello");
    await s.prompt("hello again");
    s.close();
    expect(got.length).toBeGreaterThanOrEqual(1);
    expect(parseSessionUsage(got[0]!.text!)).toMatchObject({ total: 7 });
    const chat = events.filter((e) => e.type === "text").map((e) => (e as { text: string }).text).join("");
    expect(chat).not.toMatch(/Total usage est/);
    expect(chat).toContain("Hello from fake ACP.");
  });

  it("never sends /usage when Copilot doesn't list it", async () => {
    const got: { text: string | null; commands: string[] }[] = [];
    const { o } = opts((r) => got.push(r), { FAKE_COMMANDS: "none" });
    const s = await adapter.start(o);
    await s.prompt("hello");
    await new Promise((r) => setTimeout(r, 50));
    s.close();
    expect(got[0]).toMatchObject({ text: null, commands: [] });
  });
});
