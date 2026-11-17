// Agents choose the model (and provider / extra launch arguments) of the specialists they start, e.g. Pi on a local model.
import { afterEach, describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiAdapter, PiSession, piModelArgs, piModelMismatch } from "../src/main/harness/pi";
import { MockAdapter } from "../src/main/harness/mock";
import { HarnessRegistry } from "../src/main/harness/registry";
import { Db } from "../src/main/db";
import { Orchestrator, checkLaunchArgs, delegateModel } from "../src/main/orchestrator";
import { loadRoles, loadSkills } from "../src/main/roles";
import { parseTextDelegations } from "../src/main/context";
import { DEFAULT_SETTINGS, mergeSettings, type Settings } from "../src/shared/settings";
import type { HarnessEvent, SessionOptions } from "../src/main/harness/types";

const FAKE_PI = join(__dirname, "fixtures", "fake-pi.mjs");
const until = async (fn: () => boolean, ms = 8000) => {
  const t = Date.now();
  while (!fn()) { if (Date.now() - t > ms) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 10)); }
};
const opts = (over: Partial<SessionOptions> = {}): SessionOptions & { events: HarnessEvent[] } => {
  const events: HarnessEvent[] = [];
  return { cwd: process.cwd(), model: null, extraArgs: "", executable: process.execPath, mcpServers: [], env: {}, resumeSessionId: null,
    policy: { approval: "auto-all", readOnly: false, blocked: [], projectRoot: null }, onEvent: (e) => events.push(e), askPermission: async () => true, events, ...over };
};
/** The real PiAdapter (argument building, model check) running the fake Pi. */
class FakePi extends PiAdapter {
  started: { args: string[]; o: SessionOptions }[] = [];
  protected override session(_exe: string, args: string[], o: SessionOptions): PiSession {
    this.started.push({ args, o });
    return new PiSession(process.execPath, [FAKE_PI, ...args], o);
  }
}
let cleanup: (() => void) | null = null;
afterEach(() => { cleanup?.(); cleanup = null; });

describe("model and launch arguments", () => {
  it("passes provider/model to Pi as --provider and --model, so a colon in the id stays part of it", () => {
    expect(piModelArgs("qwen-local-8800/qwen3.8:27b")).toEqual({ provider: "qwen-local-8800", model: "qwen3.8:27b",
      args: ["--provider", "qwen-local-8800", "--model", "qwen3.8:27b"] });
    expect(piModelArgs("openrouter/anthropic/claude-x").args).toEqual(["--provider", "openrouter", "--model", "anthropic/claude-x"]);
    expect(piModelArgs("sonnet").args).toEqual(["--model", "sonnet"]);
    expect(piModelArgs(null).args).toEqual([]);
  });
  it("joins a separate provider into the model, and refuses launch flags the app sets itself", () => {
    expect(delegateModel("qwen3.8:27b", "qwen-local-8800")).toBe("qwen-local-8800/qwen3.8:27b");
    expect(delegateModel("qwen-local-8800/qwen3.8:27b", "qwen-local-8800")).toBe("qwen-local-8800/qwen3.8:27b");
    expect(delegateModel("gpt-5", undefined)).toBe("gpt-5");
    expect(delegateModel("", "x")).toBeNull();
    expect(checkLaunchArgs(" --thinking high ")).toBe("--thinking high");
    expect(checkLaunchArgs(undefined)).toBeNull();
    expect(() => checkLaunchArgs("--tools bash")).toThrow(/can't set --tools/);
    expect(() => checkLaunchArgs("--mode=json --session x")).toThrow(/--mode=json, --session/);
  });
  it("notices when Pi runs on another model than the one asked for", () => {
    const want = piModelArgs("qwen-local-8800/qwen3.8:27b");
    expect(piModelMismatch(want, "qwen-local-8800/qwen3.8:27b")).toBeNull();
    expect(piModelMismatch(want, "github-copilot/gpt-6.1-sol")).toMatch(/started on github-copilot\/gpt-6.1-sol instead of qwen-local-8800\/qwen3.8:27b/);
    expect(piModelMismatch(piModelArgs("sonnet"), "anthropic/claude-sonnet-4-5")).toBeNull();
    expect(piModelMismatch(piModelArgs(null), "anthropic/x")).toBeNull();
  });
  it("reads model and args on text-mode DELEGATE lines, in any order with the folder", () => {
    expect(parseTextDelegations([
      'DELEGATE scout@pi model "qwen-local-8800/qwen3.8:27b": map the repo',
      'DELEGATE coder@pi args "--thinking high" in "C:\\code\\app" model `openai/gpt-5`: fix it',
      "DELEGATE tester: run tests",
    ].join("\n"))).toEqual([
      { role: "scout", harness: "pi", model: "qwen-local-8800/qwen3.8:27b", goal: "map the repo" },
      { role: "coder", harness: "pi", folder: "C:\\code\\app", model: "openai/gpt-5", args: "--thinking high", goal: "fix it" },
      { role: "tester", goal: "run tests" },
    ]);
  });
});

describe("Pi on the model the coordinator chose", () => {
  it("starts Pi with the provider and model, and fails clearly when Pi doesn't know them", async () => {
    const pi = new FakePi();
    const s = (await pi.start(opts({ model: "qwen-local-8800/qwen3.8:27b", extraArgs: "--thinking high" }))) as PiSession;
    expect(pi.started[0]!.args).toEqual(["--mode", "rpc", "--provider", "qwen-local-8800", "--model", "qwen3.8:27b", "--thinking", "high"]);
    expect(s.currentModel).toBe("qwen-local-8800/qwen3.8:27b");
    s.close();
    // Like Pi without that model in its models.json: it falls back to its default, and the start fails instead.
    await expect(pi.start(opts({ model: "qwen-local-8800/qwen3.8:27b", env: { FAKE_PI_KNOWN: "anthropic/claude-sonnet-4-5" } })))
      .rejects.toThrow(/Pi started on github-copilot\/gpt-6.1-sol instead of qwen-local-8800\/qwen3.8:27b/);
  });

  it("delegate passes model, provider and args through to Pi, and follow-ups keep them", async () => {
    const pi = new FakePi();
    const db = new Db(":memory:");
    const settings = mergeSettings(DEFAULT_SETTINGS, { general: { defaultHarness: "mock" }, agents: { toolMode: "auto" } } as any) as Settings;
    const harnesses = new HarnessRegistry([new MockAdapter(15), pi]);
    (harnesses as any).status.set("pi", { id: "pi", available: true, path: process.execPath });
    const orch = new Orchestrator({ db, harnesses, settings: () => settings, roles: () => loadRoles(join(__dirname, "..", "agents"), "/none"),
      skills: () => loadSkills(join(__dirname, "..", "skills", "superpowers")), emit: () => {}, mcpServersFor: () => [], homeDir: tmpdir() });
    cleanup = () => orch.stopAll();
    const chat = db.createChat({ projectId: null, title: "c", kind: "project", agentRole: "flashmaster" });
    await orch.sendUserMessage(chat.id, "SLOW plan it", null);
    await until(() => db.listAgents().some((a) => a.status === "running"));
    const parentId = db.listAgents().find((a) => a.status === "running")!.id;

    await expect(orch.delegate(parentId, { role: "presentation-expert", goal: "x", harness: "pi", args: "--tools bash" })).rejects.toThrow(/can't set --tools/);
    const r = await orch.delegate(parentId, { role: "presentation-expert", goal: "summarise", harness: "pi",
      provider: "qwen-local-8800", model: "qwen3.8:27b", args: "--thinking high", wait: true, timeoutSec: 20 });
    expect(r).toMatchObject({ harness: "pi", model: "qwen-local-8800/qwen3.8:27b" });
    expect(db.getAgent(r.agentId)).toMatchObject({ harness: "pi", model: "qwen-local-8800/qwen3.8:27b", launchArgs: "--thinking high" });
    const first = pi.started.at(-1)!;
    expect(first.o.model).toBe("qwen-local-8800/qwen3.8:27b");
    expect(first.args.join(" ")).toContain("--provider qwen-local-8800 --model qwen3.8:27b");
    expect(first.args.join(" ")).toContain("--thinking high");

    // A model without a harness goes with the role's harness (here the mock).
    const m = await orch.delegate(parentId, { role: "presentation-expert", goal: "again", model: "mock-large", wait: false });
    expect(db.getAgent(m.agentId)).toMatchObject({ harness: "mock", model: "mock-large" });
  }, 30000);
});
