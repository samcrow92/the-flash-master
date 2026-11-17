// End to end, always with feedback: specialists that end without a report are reminded, restarted and finally put to
// the user as a "needs you" card; questions and blockers are cards whose answer resumes the agent that asked; the
// coordinator never ends a turn silently; and a text-mode specialist reports its real result, not its first TOOL lines.
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockAdapter } from "../src/main/harness/mock";
import { HarnessRegistry } from "../src/main/harness/registry";
import type { HarnessAdapter, HarnessSession, SessionOptions, TurnResult } from "../src/main/harness/types";
import { Db } from "../src/main/db";
import { Orchestrator } from "../src/main/orchestrator";
import { loadRoles, loadSkills } from "../src/main/roles";
import { isSilentReply, parseResult, parseTextDelegations } from "../src/main/context";
import { DEFAULT_SETTINGS, mergeSettings, type DeepPartial, type Settings } from "../src/shared/settings";
import type { AppEvent, Message } from "../src/shared/types";
import { isNoticeLine } from "../src/shared/replyParts";

const until = async (fn: () => boolean, ms = 15000) => {
  const t = Date.now();
  while (!fn()) { if (Date.now() - t > ms) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 10)); }
};

function setup(over: DeepPartial<Settings> = {}, extra: { adapter?: HarnessAdapter; deps?: Record<string, unknown> } = {}) {
  const db = new Db(":memory:");
  const settings = mergeSettings(mergeSettings(DEFAULT_SETTINGS, { general: { defaultHarness: "mock" }, agents: { toolMode: "auto" } } as any), over as any) as Settings;
  const harnesses = new HarnessRegistry([new MockAdapter(1), ...(extra.adapter ? [extra.adapter] : [])]);
  if (extra.adapter) (harnesses as any).status.set(extra.adapter.id, { id: extra.adapter.id, label: "Scripted", available: true, version: "1", path: null, protocol: "acp", detail: null });
  const roles = loadRoles(join(__dirname, "..", "agents"), "/nonexistent");
  const skills = loadSkills(join(__dirname, "..", "skills", "superpowers"));
  const events: AppEvent[] = [];
  const orch = new Orchestrator({ db, harnesses, settings: () => settings, roles: () => roles, skills: () => skills, emit: (e: AppEvent) => events.push(e),
    mcpServersFor: () => [], homeDir: tmpdir(), ...(extra.deps ?? {}) } as any);
  const project = db.createProject("demo", mkdtempSync(join(tmpdir(), "proj-")));
  const chat = db.createChat({ projectId: project.id, title: "General", kind: "project", agentRole: "flashmaster" });
  return { db, orch, chat, events, settings };
}

const coordReplies = (db: Db, chatId: string) => db.listMessages(chatId, null).filter((m) => m.author === "agent" && m.role === "flashmaster");
const allMessages = (db: Db, chatId: string): Message[] => (db.raw.prepare("SELECT id FROM messages WHERE chat_id=? ORDER BY seq").all(chatId) as { id: string }[]).map((r) => db.getMessage(r.id)!);
const cards = (db: Db, chatId: string) => allMessages(db, chatId).filter((m) => m.ask);

async function idleCoordinator(db: Db, orch: Orchestrator, chatId: string): Promise<string> {
  await orch.sendUserMessage(chatId, "Plan the brake light feature", null);
  await until(() => coordReplies(db, chatId)[0]?.status === "done" && db.getAgent(coordReplies(db, chatId)[0]!.agentId!)!.status === "idle");
  return coordReplies(db, chatId)[0]!.agentId!;
}

describe("silent replies", () => {
  it("count as silent only without a result block and with next to no prose", () => {
    expect(isSilentReply("")).toBe(true);
    expect(isSilentReply('TOOL read_report {"agentId": "a1"}\n\n_⚠️ something_')).toBe(true);
    expect(isSilentReply("DELEGATE tester: check it")).toBe(true);
    expect(isSilentReply("Ok.")).toBe(true);
    expect(isSilentReply("Ok.", 1)).toBe(false); // the coordinator may answer in a word
    expect(isSilentReply("TOOL list_agents {}", 1)).toBe(true);
    expect(isSilentReply("<result>\nsummary: done\n</result>")).toBe(false);
    expect(isSilentReply("The brake light flickers because the debounce counter overflows at cold start.")).toBe(false);
  });
  it("text-mode DELEGATE lines can follow up with a specialist by agentId", () => {
    expect(parseTextDelegations('DELEGATE tester agent "a-1": Use set A.')).toEqual([{ role: "tester", agentId: "a-1", goal: "Use set A." }]);
  });
  it("result blocks carry quick-answer options", () => {
    const r = parseResult("<result>\nstatus: needs_decision\nquestion: A or B?\noptions: Set A | Set B; none\nsummary: two sets\n</result>");
    expect(r).toMatchObject({ status: "needs_decision", question: "A or B?", options: ["Set A", "Set B"] });
  });
});

describe("specialists that don't deliver are recovered", () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { await cleanup?.(); cleanup = null; });

  it("an empty reply gets a reminder, and the delivered result reaches the coordinator", async () => {
    const { db, orch, chat } = setup();
    cleanup = () => orch.stopAll();
    const parentId = await idleCoordinator(db, orch, chat.id);
    const r = await orch.delegate(parentId, { role: "tester", goal: "Check the brake light [silent]" });
    expect(r.result).toMatch(/summary: Mock run for "You ended your turn without delivering/);
    expect(db.listEvents(r.agentId).some((e) => /ended without a report: asking it to deliver \(1\/2\)/.test(e.label))).toBe(true);
    expect(allMessages(db, chat.id).some((m) => m.author === "system" && /asked it to deliver its result \(recovery 1 of 2\)/.test(m.content))).toBe(true);
    expect(cards(db, chat.id)).toEqual([]);
  });

  it("after the reminder and a restart, the coordinator gets a failed result to untangle, and the user no card", async () => {
    const { db, orch, chat, events } = setup();
    cleanup = () => orch.stopAll();
    const parentId = await idleCoordinator(db, orch, chat.id);
    const r = await orch.delegate(parentId, { role: "tester", goal: "Check the brake light [silent-always]" });
    expect(r.result).toMatch(/^status: failed\nsummary: .* ended without a report and delivered no result after 2 recovery attempts/);
    expect(r.result).toMatch(/Untangle this yourself: .*another specialist.*Ask the user \(ask_user\) only if/s);
    expect(r.result).toContain(`DELEGATE tester agent "${r.agentId}"`);
    const labels = db.listEvents(r.agentId).map((e) => e.label);
    expect(labels.some((l) => /asking it to deliver \(1\/2\)/.test(l))).toBe(true);
    expect(labels.some((l) => /restarting it \(2\/2\)/.test(l))).toBe(true);
    expect(cards(db, chat.id)).toEqual([]);
    expect(events.some((e) => e.type === "notice" && /Needs you/.test(e.text))).toBe(false);
    expect(allMessages(db, chat.id).some((m) => m.author === "system" && /delivered no result .*to decide what's next/.test(m.content))).toBe(true);
  });

  it("a specialist silent past the watchdog is interrupted and asked to deliver", async () => {
    const { db, orch, chat } = setup();
    cleanup = () => orch.stopAll();
    const parentId = await idleCoordinator(db, orch, chat.id);
    const bg = await orch.delegate(parentId, { role: "tester", goal: "Analyse the logs [stall]", wait: false });
    await until(() => db.getAgent(bg.agentId)!.status === "running" && /Thinking|Starting/.test(db.getAgent(bg.agentId)!.lastActivity ?? "") === false);
    const t0 = Date.now();
    expect(orch.checkStuck(t0 + 11 * 60_000)).toEqual([bg.agentId]); // the warning
    expect(orch.checkStuck(t0 + 22 * 60_000)).toEqual([bg.agentId]); // the recovery
    await until(() => coordReplies(db, chat.id).length === 2 && coordReplies(db, chat.id)[1]!.status === "done");
    expect(coordReplies(db, chat.id)[1]!.content).toContain("Specialist results");
    expect(db.listEvents(bg.agentId).some((e) => /silent for \d+ min: told to deliver \(1\/2\)/.test(e.label))).toBe(true);
  });
});

describe("needs-you cards", () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { await cleanup?.(); cleanup = null; });

  it("a specialist's question goes to the coordinator, not to the user; its follow-up answer resumes the specialist", async () => {
    const { db, orch, chat, events } = setup();
    cleanup = () => orch.stopAll();
    const parentId = await idleCoordinator(db, orch, chat.id);
    const r = await orch.delegate(parentId, { role: "tester", goal: "Calibrate the brake model [needs-decision]" });
    expect(r.result).toMatch(/status: needs_decision[\s\S]*options: Set A \| Set B[\s\S]*Handle it yourself if you can/);
    expect(cards(db, chat.id)).toEqual([]);
    expect(events.some((e) => e.type === "notice" && /Needs you|needs your decision/i.test(e.text))).toBe(false);
    expect(allMessages(db, chat.id).some((m) => m.author === "system" && /needs your decision: Use calibration set A or B.*Sent to .* to handle/.test(m.content))).toBe(true);
    // The coordinator answers it itself, with a follow-up to the same specialist.
    const f = await orch.delegate(parentId, { role: "tester", agentId: r.agentId, goal: "Use set A: it matches the cold-start data." });
    expect(f.agentId).toBe(r.agentId);
    expect(f.result).toMatch(/summary: Mock run for "Use set A/);
  });

  it("ask_user from a specialist goes to its coordinator, not to a card", async () => {
    const { db, orch, chat } = setup();
    cleanup = () => orch.stopAll();
    const parentId = await idleCoordinator(db, orch, chat.id);
    const r = await orch.delegate(parentId, { role: "tester", goal: "Write tests" });
    const out = orch.askUser(r.agentId, { question: "Which ECU variant?", options: ["Front", "Rear"] });
    expect(out.note).toMatch(/goes to .*not to the user/);
    expect(cards(db, chat.id)).toEqual([]);
  });

  it("ask_user raises a card without a second one from the result, and the coordinator gets the answer", async () => {
    const { db, orch, chat } = setup();
    cleanup = () => orch.stopAll();
    const parentId = await idleCoordinator(db, orch, chat.id);
    const out = orch.askUser(parentId, { question: "Which ECU variant?", why: "The two variants need different calibration.", options: ["Front", "Rear"], recommended: 1 });
    expect(out.note).toMatch(/End your turn/);
    const [card] = cards(db, chat.id);
    expect(isNoticeLine(card!)).toBe(false);
    expect(card!.parentId).toBeNull();
    expect(card!.ask).toMatchObject({ kind: "question", question: "Which ECU variant?", why: "The two variants need different calibration.", options: ["Front", "Rear"], recommended: 1 });
    await orch.answerAsk(card!.id, "Rear");
    await until(() => coordReplies(db, chat.id).length === 2 && coordReplies(db, chat.id)[1]!.status === "done");
    expect(db.listMessages(chat.id, null).some((m) => m.author === "user" && m.content === 'Answer to your question "Which ECU variant?": Rear')).toBe(true);
  });

  it("answers need text, and only cards can be answered", async () => {
    const { db, orch, chat } = setup();
    cleanup = () => orch.stopAll();
    const parentId = await idleCoordinator(db, orch, chat.id);
    orch.askUser(parentId, { question: "Go?" });
    await expect(orch.answerAsk(cards(db, chat.id)[0]!.id, "  ")).rejects.toThrow(/Pick an option/);
    await expect(orch.answerAsk(coordReplies(db, chat.id)[0]!.id, "x")).rejects.toThrow(/isn't a question card/);
  });
});

describe("the coordinator never ends silently", () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { await cleanup?.(); cleanup = null; });

  it("a silent turn gets one reminder", async () => {
    const { db, orch, chat } = setup();
    cleanup = () => orch.stopAll();
    await orch.sendUserMessage(chat.id, "Status? [silent]", null);
    await until(() => coordReplies(db, chat.id).length === 2 && coordReplies(db, chat.id)[1]!.status === "done");
    expect(coordReplies(db, chat.id)[1]!.content).toContain("Your turn ended without a reply to the user");
    expect(cards(db, chat.id)).toEqual([]);
  });

  it("a second silent turn raises a card", async () => {
    const { db, orch, chat } = setup();
    cleanup = () => orch.stopAll();
    await orch.sendUserMessage(chat.id, "Status? [silent-always]", null);
    await until(() => cards(db, chat.id).length === 1);
    expect(coordReplies(db, chat.id).length).toBe(2);
    expect(cards(db, chat.id)[0]!.ask).toMatchObject({ kind: "silent", options: ["Try again"] });
  });
});

/** An ACP-like harness whose replies come from a script, so text-mode tools (TOOL lines) run as in the real app. */
class ScriptedAdapter implements HarnessAdapter {
  readonly id = "opencode" as const;
  readonly label = "Scripted";
  readonly protocol = "acp" as const;
  constructor(private reply: (text: string, turn: number) => string) {}
  async detect() { return { id: this.id, label: this.label, available: true, version: "1", path: null, protocol: this.protocol, detail: null }; }
  async start(o: SessionOptions): Promise<HarnessSession> {
    let turn = 0;
    let closed = false;
    const reply = this.reply;
    return {
      sessionId: `s-${Math.random().toString(36).slice(2, 8)}`,
      get alive() { return !closed; },
      async prompt(text: string): Promise<TurnResult> {
        turn += 1;
        o.onEvent({ type: "text", text: reply(text, turn) });
        return { stopReason: "end_turn", usage: { tokensIn: 10, tokensOut: 10 } };
      },
      async cancel() {},
      close() { closed = true; },
    };
  }
}

describe("text-mode specialists report their real result", () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { await cleanup?.(); cleanup = null; });

  it("a first reply of TOOL lines isn't taken as the result; the report after the tool results is", async () => {
    const calls: string[] = [];
    const adapter = new ScriptedAdapter((text) => {
      if (/# Role: TheFlashMaster|Specialist results/.test(text) && !/Delegated by/.test(text)) return "**Planning the brake light work.** I'll hand it to the tester.";
      if (text.includes("## Tool results")) return "Looked at the roles.\n\n<result>\nsummary: Brake light tests written and passing.\n</result>";
      return 'TOOL list_roles {}';
    });
    const { db, orch, chat } = setup({ general: { defaultHarness: "opencode" }, agents: { toolMode: "text" } }, {
      adapter,
      deps: {
        listTools: (set: string) => set === "core" ? [{ name: "list_roles", description: "List roles.", inputSchema: { properties: {} } }] : [],
        callTool: async (name: string) => { calls.push(name); return [{ name: "tester" }]; },
      },
    });
    cleanup = () => orch.stopAll();
    const parentId = await idleCoordinator(db, orch, chat.id);
    const r = await orch.delegate(parentId, { role: "tester", goal: "Write the brake light tests" });
    expect(calls).toEqual(["list_roles"]);
    expect(r.result).toBe("summary: Brake light tests written and passing.");
  });
});
