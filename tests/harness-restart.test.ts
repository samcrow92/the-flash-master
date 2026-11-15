// A crashed agent CLI is restarted once and its session resumed; when it keeps crashing the chat offers another harness.
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AcpAdapter } from "../src/main/harness/acp";
import { MockAdapter } from "../src/main/harness/mock";
import { HarnessRegistry } from "../src/main/harness/registry";
import { Db } from "../src/main/db";
import { Orchestrator } from "../src/main/orchestrator";
import { loadRoles, loadSkills } from "../src/main/roles";
import { DEFAULT_SETTINGS, mergeSettings, type Settings } from "../src/shared/settings";
import type { AppEvent } from "../src/shared/types";

const FAKE = join(__dirname, "fixtures", "fake-acp-agent.mjs");
const until = async (fn: () => boolean, ms = 10000) => {
  const t = Date.now();
  while (!fn()) { if (Date.now() - t > ms) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 20)); }
};

function setup() {
  const db = new Db(":memory:");
  const settings = mergeSettings(DEFAULT_SETTINGS, { general: { defaultHarness: "mock" }, agents: { toolMode: "text" } } as any) as Settings;
  const harnesses = new HarnessRegistry([new MockAdapter(2),
    new AcpAdapter("opencode", "Fake OpenCode", [process.execPath], [FAKE], ""),
    new AcpAdapter("cursor", "Fake Cursor", [process.execPath], [FAKE, "--steady"], "")]);
  for (const id of ["opencode", "cursor"]) (harnesses as any).status.set(id, { id, available: true, path: process.execPath });
  const events: AppEvent[] = [];
  const orch = new Orchestrator({ db, harnesses, settings: () => settings, roles: () => loadRoles(join(__dirname, "..", "agents"), "/none"),
    skills: () => loadSkills(join(__dirname, "..", "skills", "superpowers")), emit: (e) => events.push(e), mcpServersFor: () => [], homeDir: tmpdir() });
  const p = db.createProject("p", mkdtempSync(join(tmpdir(), "crash-")));
  // A specialist, not the coordinator: a new session would otherwise get the text-delegation rules and answer with DELEGATE lines.
  const chat = db.createChat({ projectId: p.id, title: "c", kind: "project", agentRole: "reviewer" });
  db.updateChat(chat.id, { harness: "opencode" });
  return { db, orch, chat, harnesses, settings };
}
const agentMsgs = (db: Db, chatId: string) => db.listMessages(chatId, null).filter((m) => m.author === "agent");
const systemMsgs = (db: Db, chatId: string) => db.listMessages(chatId, null).filter((m) => m.author === "system");
const settled = (db: Db, chatId: string, i = 0) => ["done", "error"].includes(agentMsgs(db, chatId)[i]?.status ?? "");

afterEach(() => { delete process.env.FAKE_LOAD; });

describe("crashed harness", () => {
  it("restarts a CLI that exits mid-turn and finishes the reply in a new session", async () => {
    const { db, orch, chat } = setup();
    await orch.sendUserMessage(chat.id, "CRASHONCE please analyse", null, {});
    await until(() => settled(db, chat.id));
    const m = agentMsgs(db, chat.id)[0]!;
    expect(m.status).toBe("done");
    expect(m.content).toContain("Partial answer");
    expect(m.content).toMatch(/\(continuing\)\s+Hello from fake ACP/);
    expect(m.content).not.toContain("harness exited");
    expect(systemMsgs(db, chat.id).some((x) => x.content.includes("restarted it in a new session"))).toBe(true);
    await orch.stopAll();
  }, 15000);

  it("resumes the old session when the CLI supports it, without replaying its history into the reply", async () => {
    process.env.FAKE_LOAD = "1";
    const { db, orch, chat } = setup();
    await orch.sendUserMessage(chat.id, "CRASHONCE please analyse", null, {});
    await until(() => settled(db, chat.id));
    const m = agentMsgs(db, chat.id)[0]!;
    expect(m.status).toBe("done");
    expect(m.content).toMatch(/\(continuing\)\s+Hello from fake ACP/);
    expect(m.content).not.toContain("OLD HISTORY");
    expect(systemMsgs(db, chat.id).some((x) => x.content.includes("resumed the session"))).toBe(true);
    await orch.stopAll();
  }, 15000);

  it("offers another harness when the CLI exits again after the restart, and retries there on ✅", async () => {
    const { db, orch, chat } = setup();
    await orch.sendUserMessage(chat.id, "CRASHALWAYS please analyse", null, {});
    await until(() => settled(db, chat.id));
    const failed = agentMsgs(db, chat.id)[0]!;
    expect(failed.status).toBe("error");
    expect(failed.content).toContain("exited again after a restart");
    await until(() => systemMsgs(db, chat.id).some((x) => x.content.includes("React ✅ to switch")));
    const offer = systemMsgs(db, chat.id).find((x) => x.content.includes("React ✅ to switch"))!;
    expect(offer.content).toContain("**Fake Cursor**");

    orch.onReaction(offer.id, "✅", ["✅"]);
    await until(() => settled(db, chat.id, 1));
    const retry = agentMsgs(db, chat.id)[1]!;
    expect(retry.status).toBe("done");
    expect(retry.content).toContain("Hello from fake ACP");
    expect(db.getAgent(retry.agentId!)!.harness).toBe("cursor");
    await orch.stopAll();
  }, 20000);

  it("says so when no other harness is available", async () => {
    const { db, orch, chat, harnesses } = setup();
    (harnesses as any).status.set("cursor", { id: "cursor", available: false, path: null });
    await orch.sendUserMessage(chat.id, "CRASHALWAYS please analyse", null, {});
    await until(() => systemMsgs(db, chat.id).some((x) => x.content.includes("no other harness is available")));
    await orch.stopAll();
  }, 15000);

  it("picks the default harness first as the alternative, never the crashing one or mock", () => {
    const { harnesses, settings } = setup();
    expect(harnesses.alternative("opencode", settings)).toBe("cursor");
    expect(harnesses.alternative("cursor", { ...settings, general: { ...settings.general, defaultHarness: "opencode" } })).toBe("opencode");
    expect(harnesses.alternative("cursor", { ...settings, harnesses: { ...settings.harnesses, opencode: { ...settings.harnesses.opencode, enabled: false } } })).toBeNull();
  });
});
