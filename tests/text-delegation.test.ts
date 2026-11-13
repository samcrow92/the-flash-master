import { describe, expect, it } from "vitest";
import { parseTextAgents, parseTextDelegations, parseTextToolCalls, textToolRules } from "../src/main/context";
import { parseRole, roleMarkdown } from "../src/main/roles";
import { saysNoDelegate } from "../src/main/orchestrator";

describe("parseTextDelegations", () => {
  it("parses roles, harness, multi-line briefs, and ignores code fences", () => {
    const t = [
      "Plan:",
      "DELEGATE analyst: Summarise the requirements",
      "module BCM, files req/*.md",
      "",
      "- **DELEGATE** presentation-expert@pi: Build the deck",
      "```",
      "DELEGATE tester: not this one",
      "```",
      "DELEGATE reviewer:",
    ].join("\n");
    expect(parseTextDelegations(t)).toEqual([
      { role: "analyst", goal: "Summarise the requirements\nmodule BCM, files req/*.md" },
      { role: "presentation-expert", harness: "pi", goal: "Build the deck" },
    ]);
  });
  it("returns nothing for normal text", () => { expect(parseTextDelegations("I will delegate this later.")).toEqual([]); });
});

describe("parseTextAgents", () => {
  it("reads AGENT … END blocks with multi-line instructions", () => {
    const t = ["AGENT can-log-analyst@pi: Analyses CAN traces", "You analyse CAN logs.", "", "Return the top 3 anomalies.", "END",
      "DELEGATE can-log-analyst: look at trace.asc"].join("\n");
    expect(parseTextAgents(t)).toEqual([{ name: "can-log-analyst", harness: "pi", description: "Analyses CAN traces", instructions: "You analyse CAN logs.\n\nReturn the top 3 anomalies." }]);
    expect(parseTextDelegations(t)).toEqual([{ role: "can-log-analyst", goal: "look at trace.asc" }]);
  });
});

describe("text-mode tools", () => {
  it("parses TOOL lines with single- and multi-line JSON, and only known tools", () => {
    const t = ['TOOL create_task {"title": "A"}', "TOOL jazz_get {", '  "id": "123"', "}", "TOOL rm_search not json", 'TOOL unknown {"x":1}'].join("\n");
    const calls = parseTextToolCalls(t, new Set(["create_task", "jazz_get", "rm_search"]));
    expect(calls).toEqual([{ name: "create_task", args: { title: "A" } }, { name: "jazz_get", args: { id: "123" } },
      { name: "rm_search", args: {}, error: "arguments are not a JSON object" }]);
  });
  it("lists compact signatures", () => {
    const r = textToolRules([{ name: "rm_search", description: "Search requirements. Long text.", inputSchema: { properties: { q: {}, limit: {} }, required: ["q"] } }]);
    expect(r).toContain("- rm_search(q, limit?): Search requirements.");
    expect(r).toContain('TOOL <name> {"arg": "value"}');
  });
});

describe("roleMarkdown", () => {
  it("builds a loadable role file marked as agent-created", () => {
    const md = roleMarkdown({ name: "CAN Log Analyst", description: "Analyses CAN traces", instructions: "Do it.", tools: ["jazz"], harness: "pi" }, "flashmaster");
    const r = parseRole(md, "x", "user");
    expect(r).toMatchObject({ name: "can-log-analyst", title: "Can Log Analyst", tools: ["flashmaster-core", "jazz"], harness: "pi", prompt: "Do it." });
    expect(md).toContain("createdBy: flashmaster");
  });
});

describe("saysNoDelegate", () => {
  it("recognises the coordinator reporting a missing delegate tool", () => {
    expect(saysNoDelegate("I couldn't delegate this: TheFlashMaster's `delegate` tool didn't load in this session, so no task was started.")).toBe(true);
    expect(saysNoDelegate("The specialist/task-board tools aren't available; the delegate tool is unavailable.")).toBe(true);
    expect(saysNoDelegate("I have no `delegate` tool in this session.")).toBe(true);
    expect(saysNoDelegate("I'll delegate the review to the reviewer.")).toBe(false);
    expect(saysNoDelegate("DELEGATE reviewer: check the available signals")).toBe(false);
  });
});
