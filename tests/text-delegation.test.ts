import { describe, expect, it } from "vitest";
import { parseTextAgents, parseTextDelegations, parseTextToolCalls, stripTextToolCalls, textToolRules } from "../src/main/context";
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
      "END",
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

  // Mari: the Duo orchestrator's brief to a specialist was cut after its memory list ("Blank lines end a brief in text
  // mode"). Coordinators write briefs with paragraphs, lists and code; they must reach the specialist whole.
  it("keeps paragraphs, lists and code of a brief, up to the next DELEGATE line", () => {
    const t = [
      "Starting Oscar 2 on the fix.",
      "DELEGATE software-expert: Fix issue 770724 in the brake light module.",
      "",
      "What memory says:",
      "- debounce is 20 ms",
      "- tests live in tests/bcm",
      "",
      "Steps:",
      "1. Reproduce with `make test`.",
      "2. Fix it.",
      "",
      "```c",
      "DELEGATE tester: this is code, not a delegation",
      "```",
      "",
      "Report back with the changed files and the test output.",
      "",
      "DELEGATE tester: Run the BCM suite.",
    ].join("\n");
    const d = parseTextDelegations(t);
    expect(d.map((x) => x.role)).toEqual(["software-expert", "tester"]);
    expect(d[0]!.goal).toBe(t.split("\n").slice(1, 16).join("\n").replace("DELEGATE software-expert: ", ""));
    expect(d[0]!.goal).toContain("Report back with the changed files and the test output.");
    expect(d[1]!.goal).toBe("Run the BCM suite.");
  });

  it("an END line closes a brief, so text for the user can follow it", () => {
    const t = ["DELEGATE analyst: Read the spec.", "", "Focus on timing.", "END", "", "Analyst is reading the spec now.", "More for you here."].join("\n");
    expect(parseTextDelegations(t)).toEqual([{ role: "analyst", goal: "Read the spec.\n\nFocus on timing." }]);
  });

  it("a closing one-line remark at the end of the reply stays out of the last brief, a structured line stays in", () => {
    expect(parseTextDelegations(["DELEGATE analyst: Read the spec.", "", "- timing", "", "Then I'll integrate."].join("\n")))
      .toEqual([{ role: "analyst", goal: "Read the spec.\n\n- timing" }]);
    expect(parseTextDelegations(["DELEGATE analyst: Read the spec.", "", "Done when: the timing table is filled."].join("\n")))
      .toEqual([{ role: "analyst", goal: "Read the spec.\n\nDone when: the timing table is filled." }]);
    // Nothing on the DELEGATE line: the paragraph under it is the brief.
    expect(parseTextDelegations(["DELEGATE analyst:", "", "Read the spec."].join("\n"))).toEqual([{ role: "analyst", goal: "Read the spec." }]);
  });
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
  it("strips parsed TOOL lines from the reply text so each call shows only once", () => {
    const known = new Set(["get_result", "list_agents", "jazz_get", "rm_search"]);
    const t = ["Polling the push agent and checking its current activity.", "",
      'TOOL get_result {"agentId": "5bd5b43b"}', 'TOOL list_agents {"activeOnly": true}'].join("\r\n");
    expect(stripTextToolCalls(t, known)).toBe("Polling the push agent and checking its current activity.");
    // Multi-line JSON, calls inside a fence, unknown tools and unparsable calls.
    const u = ["Before.", "TOOL jazz_get {", '  "id": "1"', "}", "", "```", 'TOOL list_agents {}', "```", "Middle.",
      'TOOL unknown {"x":1}', "TOOL rm_search not json", "After."].join("\n");
    expect(stripTextToolCalls(u, known)).toBe(["Before.", "", "Middle.", 'TOOL unknown {"x":1}', "TOOL rm_search not json", "After."].join("\n"));
    expect(stripTextToolCalls("No calls here.", known)).toBe("No calls here.");
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
