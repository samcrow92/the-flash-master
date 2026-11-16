import { describe, expect, it } from "vitest";
import { LiveLedger, creditDelta } from "../src/main/copilot-ledger";
import { Db } from "../src/main/db";
import { chatCredits, creditsText } from "../src/shared/usage-label";

describe("counting Copilot credits per agent and chat", () => {
  it("counts only what a turn added to the session's cumulative /usage total", () => {
    expect(creditDelta(null, { total: 3 })).toBe(3);
    expect(creditDelta({ total: 3 }, { total: 4.5 })).toBe(1.5);
    expect(creditDelta({ total: 4.5 }, { total: 4.5 })).toBe(0);
    // A resumed session starts counting again from zero: all of it is new.
    expect(creditDelta({ total: 10 }, { total: 2 })).toBe(2);
    expect(creditDelta({ total: 1 }, { total: 0 })).toBe(0);
  });

  it("LiveLedger.record returns each turn's credits, per session", () => {
    const l = new LiveLedger(() => null, () => undefined);
    expect(l.record("a", { total: 2, models: {} })).toBe(2);
    expect(l.record("b", { total: 1, models: {} })).toBe(1);
    expect(l.record("a", { total: 5, models: {} })).toBe(3);
  });

  it("stores credits on the agent and adds them up per chat", () => {
    const db = new Db(":memory:");
    const chat = db.createChat({ projectId: null, title: "c", kind: "project", agentRole: "flashmaster" });
    const a = db.createAgent({ projectId: null, chatId: chat.id, role: "reviewer", harness: "copilot", model: null, brief: "" });
    const b = db.createAgent({ projectId: null, chatId: chat.id, role: "architect", harness: "copilot", model: null, brief: "" });
    expect(a.credits).toBe(0);
    db.addAgentCredits(a.id, 2);
    db.addAgentCredits(a.id, 1.5);
    db.addAgentCredits(b.id, 0);
    expect(db.getAgent(a.id)!.credits).toBe(3.5);
    db.addAgentCredits(b.id, 1);
    const sum = chatCredits(db.listAgents(), chat.id);
    expect(sum.total).toBe(4.5);
    expect(sum.agents.map((x) => x.role)).toEqual(["reviewer", "architect"]);
    expect(chatCredits(db.listAgents(), "other").total).toBe(0);
  });

  it("writes counts with the right unit", () => {
    expect(creditsText(1)).toBe("1 credit");
    expect(creditsText(12)).toBe("12 credits");
    expect(creditsText(2, "requests")).toBe("2 premium requests");
  });
});
