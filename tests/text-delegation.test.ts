import { describe, expect, it } from "vitest";
import { parseTextDelegations } from "../src/main/context";

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
