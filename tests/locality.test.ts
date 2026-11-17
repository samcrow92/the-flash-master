// Local-only agents (a "Scout" whose instructions demand local inference) run on a local model, never on a hosted
// harness like GitLab Duo, where they could only refuse the work.
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiAdapter, PiSession } from "../src/main/harness/pi";
import { MockAdapter } from "../src/main/harness/mock";
import { HarnessRegistry } from "../src/main/harness/registry";
import { Db } from "../src/main/db";
import { Orchestrator } from "../src/main/orchestrator";
import { loadRoles, loadSkills, parseRole, roleMarkdown } from "../src/main/roles";
import { localRuntimeNote, needsLocalInference, pickLocalRuntime } from "../src/main/locality";
import { DEFAULT_SETTINGS, mergeSettings, type Settings } from "../src/shared/settings";
import type { SessionOptions } from "../src/main/harness/types";

const FAKE_PI = join(__dirname, "fixtures", "fake-pi.mjs");
const until = async (fn: () => boolean, ms = 8000) => {
  const t = Date.now();
  while (!fn()) { if (Date.now() - t > ms) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 10)); }
};
class FakePi extends PiAdapter {
  started: { args: string[]; o: SessionOptions }[] = [];
  protected override session(_exe: string, args: string[], o: SessionOptions): PiSession {
    this.started.push({ args, o });
    return new PiSession(process.execPath, [FAKE_PI, ...args], o);
  }
}
const SCOUT = `---
name: scout
title: Scout
description: Maps a repository
---
You map the repository and list its knowledge entries.
Verified local inference is required before any repository content is read: never send code to a hosted model.`;

let cleanup: (() => void) | null = null;
afterEach(() => { cleanup?.(); cleanup = null; });

describe("which agents must stay local", () => {
  it("reads it from instructions that demand local inference, and from frontmatter", () => {
    expect(needsLocalInference("The brief requires verified local inference before any repository content is read.")).toBe(true);
    expect(needsLocalInference("Only use a local model; no hosted forwarding.")).toBe(true);
    expect(needsLocalInference("Run the tests locally and report.")).toBe(false);
    expect(needsLocalInference("Review the local changes. You must keep the diff small.")).toBe(false);
    expect(parseRole(SCOUT, "scout", "user").local).toBe(true);
    expect(parseRole(SCOUT.replace("description:", "local: false\ndescription:"), "scout", "user").local).toBeUndefined();
    expect(parseRole("---\nname: x\nlocal: true\n---\nDo things.", "x", "user").local).toBe(true);
    expect(parseRole(roleMarkdown({ name: "y", instructions: "Map it.", local: true }, "flashmaster"), "y", "user").local).toBe(true);
  });
  it("no built-in agent is local-only", () => {
    expect(loadRoles(join(__dirname, "..", "agents"), "/none").filter((r) => r.local).map((r) => r.name)).toEqual([]);
  });
});

describe("picking the local runtime", () => {
  const usable = (h: string) => h === "pi" || h === "opencode";
  it("prefers the delegation's model, then the role's, then the LOCAL mode, and never a hosted harness", () => {
    const localMode = { harness: "pi" as const, model: "ollama/qwen3-coder", thinking: "" as const };
    expect(pickLocalRuntime({ role: {}, pick: { harness: "duo", model: "x" }, localMode, usable }))
      .toEqual({ harness: "pi", model: "ollama/qwen3-coder", source: "local-mode" });
    expect(pickLocalRuntime({ role: {}, pick: { model: "qwen-local-8800/qwen3.8:27b" }, localMode, usable }))
      .toEqual({ harness: "pi", model: "qwen-local-8800/qwen3.8:27b", source: "delegation" });
    expect(pickLocalRuntime({ role: { harness: "opencode", model: "ollama/llama4" }, localMode, usable }))
      .toEqual({ harness: "opencode", model: "ollama/llama4", source: "role" });
  });
  it("explains what to set up when there is no local model (Pi's default model may be hosted)", () => {
    const r = pickLocalRuntime({ role: { harness: "pi" }, localMode: { harness: "opencode", model: "", thinking: "" }, usable });
    expect("error" in r && r.error).toMatch(/no local model is set up.*Settings → Modes → LOCAL/);
    const off = pickLocalRuntime({ role: {}, localMode: { harness: "pi", model: "ollama/q", thinking: "" }, usable: () => false });
    expect("error" in off && off.error).toMatch(/pi · ollama\/q\) is not available/);
  });
  it("tells the agent what it runs on, as the launcher's evidence", () => {
    expect(localRuntimeNote("pi", "ollama/q", "local-mode")).toMatch(/You run on Pi with model ollama\/q, the user's LOCAL model profile.*never routes it to a hosted harness \(GitLab Duo/s);
  });
});

describe("orchestrator routing for local-only agents", () => {
  const setup = (local: { harness: string; model: string }) => {
    const pi = new FakePi();
    const db = new Db(":memory:");
    const dir = mkdtempSync(join(tmpdir(), "fm-roles-"));
    writeFileSync(join(dir, "scout.md"), SCOUT);
    // Default harness = mock: the stand-in for a hosted harness (Duo) that a local-only agent must not run on.
    const settings = mergeSettings(DEFAULT_SETTINGS, { general: { defaultHarness: "mock" }, agents: { toolMode: "auto" },
      modes: { ...DEFAULT_SETTINGS.modes, local: { harness: local.harness, model: local.model, thinking: "" } } } as any) as Settings;
    const harnesses = new HarnessRegistry([new MockAdapter(5), pi]);
    (harnesses as any).status.set("pi", { id: "pi", available: true, path: process.execPath });
    const sys: string[] = [];
    const orch = new Orchestrator({ db, harnesses, settings: () => settings, roles: () => loadRoles(join(__dirname, "..", "agents"), dir),
      skills: () => loadSkills(join(__dirname, "..", "skills", "superpowers")), mcpServersFor: () => [], homeDir: tmpdir(),
      emit: (e: any) => { if (e.type === "message.created" && e.message.author === "system") sys.push(e.message.content); } });
    cleanup = () => orch.stopAll();
    return { pi, db, orch, sys };
  };
  const coordinator = async (db: Db, orch: Orchestrator) => {
    const chat = db.createChat({ projectId: null, title: "c", kind: "project", agentRole: "flashmaster" });
    await orch.sendUserMessage(chat.id, "SLOW plan it", null);
    await until(() => db.listAgents().some((a) => a.status === "running"));
    return db.listAgents().find((a) => a.status === "running")!.id;
  };

  it("runs a local-only Scout on the LOCAL model even when asked for Duo, and tells it so", async () => {
    const { pi, db, orch, sys } = setup({ harness: "pi", model: "ollama/qwen3-coder" });
    const parentId = await coordinator(db, orch);
    const r = await orch.delegate(parentId, { role: "scout", goal: "list the knowledge entries", harness: "duo", wait: true, timeoutSec: 20 });
    expect(r).toMatchObject({ harness: "pi", model: "ollama/qwen3-coder" });
    expect(pi.started.at(-1)!.args.join(" ")).toContain("--provider ollama --model qwen3-coder");
    expect(sys.some((m) => /Scout must run on a local model, so it runs on \*\*pi\*\* · ollama\/qwen3-coder instead of duo/.test(m))).toBe(true);
  }, 30000);

  it("doesn't start a local-only agent on a hosted harness when no local model is set up: the coordinator gets the reason", async () => {
    const { db, orch } = setup({ harness: "opencode", model: "" });
    const parentId = await coordinator(db, orch);
    const before = db.listAgents().length;
    await expect(orch.delegate(parentId, { role: "scout", goal: "map it", wait: true, timeoutSec: 20 }))
      .rejects.toThrow(/Scout was not started: it must run on a local model.*no local model is set up/);
    expect(db.listAgents().length).toBe(before);
  }, 30000);

  it("a brief that demands local inference goes to the LOCAL model when there is one", async () => {
    const { db, orch } = setup({ harness: "pi", model: "ollama/qwen3-coder" });
    const parentId = await coordinator(db, orch);
    const r = await orch.delegate(parentId, { role: "presentation-expert", goal: "summarise the repo",
      context: "Verified local inference is required: never send code to a hosted model.", wait: true, timeoutSec: 20 });
    expect(r).toMatchObject({ harness: "pi", model: "ollama/qwen3-coder" });
  }, 30000);

  it("a specialist that refused hosted inference comes back with how to re-run it locally, not as a question for the user", async () => {
    const { db, orch } = setup({ harness: "pi", model: "ollama/qwen3-coder" });
    const parentId = await coordinator(db, orch);
    const r = await orch.delegate(parentId, { role: "presentation-expert", goal: "[blocked-local] map the repo", wait: true, timeoutSec: 20 });
    expect(r.harness).toBe("mock");
    expect(r.result).toMatch(/Locality: it refused because it ran on mock \(hosted\).*Re-delegate the same brief now with local: true.*pi · ollama\/qwen3-coder\. Don't ask the user\./s);
  }, 30000);
});
