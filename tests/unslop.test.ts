import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../src/main/db";
import { Orchestrator } from "../src/main/orchestrator";
import { HarnessRegistry } from "../src/main/harness/registry";
import { MockAdapter, MockSession } from "../src/main/harness/mock";
import { loadRoles, loadSkills } from "../src/main/roles";
import { DEFAULT_SETTINGS, mergeSettings, type Settings } from "../src/shared/settings";

const until = async (fn: () => boolean, ms = 8000) => {
  const t = Date.now();
  while (!fn()) { if (Date.now() - t > ms) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 10)); }
};

describe("unslop writing rules", () => {
  afterEach(() => vi.restoreAllMocks());

  function setup(unslop?: boolean) {
    const db = new Db(":memory:");
    const settings = mergeSettings(DEFAULT_SETTINGS, { general: { defaultHarness: "mock" }, agents: unslop === undefined ? {} : { unslop } }) as Settings;
    const roles = loadRoles(join(__dirname, "..", "agents"), "/none");
    const skills = ["superpowers", "pstack"].flatMap((d) => loadSkills(join(__dirname, "..", "skills", d)));
    const prompts: string[] = [];
    const orig = MockSession.prototype.prompt;
    vi.spyOn(MockSession.prototype, "prompt").mockImplementation(function (this: MockSession, text, atts) { prompts.push(text); return orig.call(this, text, atts); });
    const orch = new Orchestrator({ db, harnesses: new HarnessRegistry([new MockAdapter(1)]), settings: () => settings, roles: () => roles,
      skills: () => skills, emit: () => undefined, mcpServersFor: () => [], homeDir: tmpdir(), dataDir: mkdtempSync(join(tmpdir(), "unslop-data-")) });
    const p = db.createProject("p", mkdtempSync(join(tmpdir(), "unslop-proj-")));
    const chat = db.createChat({ projectId: p.id, title: "c", kind: "project", agentRole: "flashmaster" });
    return { db, orch, chat, prompts };
  }

  it("are sent to every agent by default, covering text written through tools, once per session", async () => {
    const { db, orch, chat, prompts } = setup();
    await orch.sendUserMessage(chat.id, "Write the release notes", null);
    await until(() => db.listAgents({}).some((x) => x.status === "idle"));
    expect(prompts[0]).toContain("## Writing style (unslop)");
    expect(prompts[0]).toMatch(/text you write through tools \(commit messages, PR descriptions/);
    expect(prompts[0]).toContain("No em dashes");
    await orch.sendUserMessage(chat.id, "And a changelog", null);
    await until(() => prompts.length === 2 && db.listAgents({}).every((x) => x.status === "idle"));
    expect(prompts[1]).not.toContain("## Writing style (unslop)"); // part of the stable first-turn prefix only
  });

  it("are left out when turned off in settings", async () => {
    const { db, orch, chat, prompts } = setup(false);
    await orch.sendUserMessage(chat.id, "Write the release notes", null);
    await until(() => db.listAgents({}).some((x) => x.status === "idle"));
    expect(prompts[0]).not.toContain("## Writing style (unslop)");
    expect(prompts[0]).not.toContain("No em dashes");
  });
});
