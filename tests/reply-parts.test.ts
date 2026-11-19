import { describe, expect, it } from "vitest";
import { briefHeadline, isNoticeLine, replyParts } from "../src/shared/replyParts";
import { parseTextDelegations } from "../src/main/context";

describe("replyParts: the coordinator's reply, easy to scan", () => {
  it("groups text-mode DELEGATE blocks into one card list, keeping each full brief", () => {
    const t = ["I'll split this up.", "", "DELEGATE software-expert: Add a debounce. Keep the delay.", "Files: src/brake_light.c", "",
      "- **DELEGATE** tester@pi model \"x/y\": Write tests.", "", "Then I'll integrate."].join("\n");
    expect(replyParts(t)).toEqual([
      { kind: "md", text: "I'll split this up.\n" },
      { kind: "delegations", items: [
        { role: "software-expert", harness: null, brief: "Add a debounce. Keep the delay.\nFiles: src/brake_light.c" },
        { role: "tester", harness: "pi", brief: "Write tests." }] },
      { kind: "md", text: "\nThen I'll integrate." },
    ]);
    // The cards show exactly what the app runs.
    expect(parseTextDelegations(t).map((d) => d.role)).toEqual(["software-expert", "tester"]);
  });

  it("shows a brief with blank lines and lists whole, exactly as the app runs it", () => {
    const t = ["DELEGATE software-expert: Fix it.", "", "Memory:", "- debounce 20 ms", "", "Report the test output.", "", "DELEGATE tester: Run it.", "", "Both are running."].join("\n");
    const parts = replyParts(t);
    expect(parts[0]).toEqual({ kind: "delegations", items: [
      { role: "software-expert", harness: null, brief: "Fix it.\n\nMemory:\n- debounce 20 ms\n\nReport the test output." },
      { role: "tester", harness: null, brief: "Run it." }] });
    expect(parts[1]).toEqual({ kind: "md", text: "\nBoth are running." });
    expect(parseTextDelegations(t).map((d) => d.goal)).toEqual(parts[0]!.kind === "delegations" ? parts[0]!.items.map((x) => x.brief) : []);
  });

  it("leaves DELEGATE lines inside code alone", () => {
    expect(replyParts("```\nDELEGATE tester: no\n```").map((p) => p.kind)).toEqual(["md"]);
  });

  it("turns AGENT … END into a card and the <result> block into a status card", () => {
    const t = ["AGENT can-log-analyst@pi: Analyses CAN traces", "You analyse CAN logs.", "END", "Done.", "<result>", "status: needs_decision",
      "question: A or B?", "summary: Two options.", "findings:", "- A is faster", "artifacts: none", "</result>"].join("\n");
    expect(replyParts(t)).toEqual([
      { kind: "agent", name: "can-log-analyst", description: "Analyses CAN traces", instructions: "You analyse CAN logs." },
      { kind: "md", text: "Done.\n" },
      { kind: "result", result: { status: "needs_decision", question: "A or B?", summary: "Two options.", findings: ["A is faster"], artifacts: [] } },
    ]);
  });

  it("folds everything under a trailing Details heading, but not a Details heading inside code or with nothing under it", () => {
    const t = "**Done: merge the branch.**\n- 4 tests pass\n\n## Details\n\n### Nova\nLong notes.";
    expect(replyParts(t)).toEqual([{ kind: "md", text: "**Done: merge the branch.**\n- 4 tests pass\n" },
      { kind: "details", title: "Details", text: "### Nova\nLong notes." }]);
    expect(replyParts("```\n## Details\nx\n```").map((p) => p.kind)).toEqual(["md"]);
    expect(replyParts("Text\n## Details\n").map((p) => p.kind)).toEqual(["md"]);
  });

  it("plain replies stay one markdown part", () => {
    expect(replyParts("Hello **there**.")).toEqual([{ kind: "md", text: "Hello **there**." }]);
  });

  it("headlines a brief with its first sentence", () => {
    expect(briefHeadline("Add a 10 ms debounce to the input. Context: flicker.\nmore")).toBe("Add a 10 ms debounce to the input.");
    expect(briefHeadline("x".repeat(200)).length).toBe(140);
  });

  it("short one-line system notices become slim lines; longer ones and approvals keep their card", () => {
    expect(isNoticeLine({ author: "system", content: "↪ Delegating: **tester**", reactions: [] })).toBe(true);
    expect(isNoticeLine({ author: "system", content: "⚠️ Pi keeps exiting.\n\nReact ✅ to switch", reactions: [] })).toBe(false);
    expect(isNoticeLine({ author: "system", content: "Approve?", reactions: ["✅"] })).toBe(false);
    expect(isNoticeLine({ author: "agent", content: "hi" })).toBe(false);
  });
});
