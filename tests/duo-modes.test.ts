/**
 * Mari: an ECO / COMFORT / SPORT row for GitLab Duo only. ECO = Grok 4.7 on high thinking, COMFORT = Opus 5.5 on medium,
 * SPORT = Opus 5.5 on xhigh. Duo wants GitLab's model identifiers (claude_opus_5_5), and duo-cli 9.16 has no
 * thinking-effort option, so the level reaches the session but never Duo's command line.
 */
import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DuoAdapter, DuoSession, duoRunArgs } from "../src/main/harness/duo";
import { MockAdapter } from "../src/main/harness/mock";
import { HarnessRegistry } from "../src/main/harness/registry";
import { Db } from "../src/main/db";
import { Orchestrator } from "../src/main/orchestrator";
import { loadRoles, loadSkills } from "../src/main/roles";
import { chatOnDuo, DEFAULT_SETTINGS, DUO_COORDINATOR_MODEL, duoModelId, mergeSettings, type DeepPartial, type Settings } from "../src/shared/settings";
import type { SessionOptions } from "../src/main/harness/types";

const FAKE_DUO = join(__dirname, "fixtures", "fake-duo.mjs");
const starts: SessionOptions[] = [];
class FakeDuo extends DuoAdapter {
  override async start(o: SessionOptions) {
    await super.start(o);
    starts.push(o);
    return new DuoSession(process.execPath, [FAKE_DUO], o);
  }
}

function setup(over: DeepPartial<Settings> = {}) {
  starts.length = 0;
  const db = new Db(":memory:");
  const settings = mergeSettings(mergeSettings(DEFAULT_SETTINGS, { general: { defaultHarness: "mock" } } as any), over as any) as Settings;
  const harnesses = new HarnessRegistry([new MockAdapter(5), new FakeDuo()]);
  (harnesses as any).status.set("duo", { id: "duo", available: true, path: process.execPath });
  const orch = new Orchestrator({ db, harnesses, settings: () => settings, roles: () => loadRoles(join(__dirname, "..", "agents"), "/none"),
    skills: () => loadSkills(join(__dirname, "..", "skills", "superpowers")), emit: () => {}, mcpServersFor: () => [], homeDir: tmpdir() } as any);
  const dir = mkdtempSync(join(tmpdir(), "duo-modes-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["remote", "add", "origin", "git@gitlab.com:me/lab.git"], { cwd: dir });
  const project = db.createProject("lab", dir);
  const chat = db.createChat({ projectId: project.id, title: "c", kind: "project", agentRole: "flashmaster" });
  return { db, orch, chat };
}

let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => { await cleanup?.(); cleanup = null; });

describe("GitLab Duo modes", () => {
  it("default to Grok 4.7 high, Opus 5.5 medium and Opus 5.5 xhigh, in GitLab's model ids", () => {
    expect(DUO_COORDINATOR_MODEL).toBe("claude_opus_5_5");
    expect(DEFAULT_SETTINGS.duo.modes).toEqual({
      eco: { model: "grok_4_7", thinking: "high" },
      comfort: { model: "claude_opus_5_5", thinking: "medium" },
      sport: { model: "claude_opus_5_5", thinking: "xhigh" },
    });
  });

  it("map Anthropic-style ids to GitLab identifiers and leave the rest alone", () => {
    expect(duoModelId("claude-opus-5-5")).toBe("claude_opus_5_5");
    expect(duoModelId("claude-opus-5.5")).toBe("claude_opus_5_5");
    expect(duoModelId(" claude_opus_5_5 ")).toBe("claude_opus_5_5");
    expect(duoModelId("grok_4_7")).toBe("grok_4_7");
    expect(duoModelId("vendor/some-model")).toBe("vendor/some-model");
    expect(duoModelId("gemini")).toBe("gemini");
  });

  it("pass the model to duo run as a GitLab id and never pass a thinking flag", () => {
    expect(duoRunArgs([], "", null, "claude-opus-5-5")).toEqual(["run", "--model", "claude_opus_5_5"]);
    expect(duoRunArgs(["duo", "cli"], "--verbose", "42", null)).toEqual(["duo", "cli", "run", "--verbose", "--existing-session-id", "42"]);
  });

  it("show only in project chats whose coordinator runs on Duo", () => {
    const s = DEFAULT_SETTINGS;
    const on = mergeSettings(s, { duo: { coordinator: true } } as any) as Settings;
    const chat = { projectId: "p", harness: null, mode: null } as const;
    expect(chatOnDuo(chat, s)).toBe(false);
    expect(chatOnDuo({ ...chat, harness: "duo" }, s)).toBe(true);
    expect(chatOnDuo(chat, on)).toBe(true);
    expect(chatOnDuo({ ...chat, projectId: null, harness: "duo" }, on)).toBe(false); // master chat: never on Duo
    expect(chatOnDuo({ ...chat, harness: "copilot" }, on)).toBe(false); // another harness picked for the chat
    const local = mergeSettings(on, { modes: { local: { harness: "opencode", model: "qwen" } } } as any) as Settings;
    expect(chatOnDuo({ ...chat, mode: "local" }, local)).toBe(false); // a drive mode that moves the chat off Duo
  });

  it("are saved on the chat", () => {
    const db = new Db(":memory:");
    const c = db.createChat({ projectId: null, title: "c", kind: "project", agentRole: "flashmaster" });
    expect(c.duoMode).toBeNull();
    db.updateChat(c.id, { duoMode: "sport" });
    expect(db.getChat(c.id)!.duoMode).toBe("sport");
  });

  it("SPORT starts the coordinator on Duo with Opus 5.5 and xhigh thinking", async () => {
    const { db, orch, chat } = setup({ duo: { coordinator: true } });
    cleanup = () => orch.stopAll();
    db.updateChat(chat.id, { duoMode: "sport" });
    await orch.prepareChat(chat.id);
    expect(starts[0]).toMatchObject({ model: "claude_opus_5_5", thinking: "xhigh" });
  });

  it("ECO wins over the chat's own Duo model and runs Grok 4.7 on high", async () => {
    const { db, orch, chat } = setup();
    cleanup = () => orch.stopAll();
    db.updateChat(chat.id, { harness: "duo", model: "claude_sonnet_5_5", duoMode: "eco" });
    await orch.prepareChat(chat.id);
    expect(starts[0]).toMatchObject({ model: "grok_4_7", thinking: "high" });
  });

  it("without a Duo mode the coordinator keeps Duo's usual model and no thinking level", async () => {
    const { orch, chat } = setup({ duo: { coordinator: true } });
    cleanup = () => orch.stopAll();
    await orch.prepareChat(chat.id);
    expect(starts[0]).toMatchObject({ model: "claude_opus_5_5", thinking: null });
  });
});
