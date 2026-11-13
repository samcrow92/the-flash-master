import { describe, expect, it } from "vitest";
import { delimiter } from "node:path";
import { HarnessRegistry } from "../src/main/harness/registry";
import { prepareInstructions } from "../src/main/harness/instructions";
import { parseTextDelegations } from "../src/main/context";
import { loginShellPath, mergePaths } from "../src/main/shell-path";
import { DEFAULT_SETTINGS } from "../src/shared/settings";
import { HARNESS_IDS } from "../src/shared/types";

describe("Cursor Agent and Claude Code harnesses", () => {
  it("are registered as ACP harnesses with their launch commands", () => {
    const reg = new HarnessRegistry();
    const cursor = reg.get("cursor") as any;
    const claude = reg.get("claude") as any;
    expect(cursor.protocol).toBe("acp");
    expect(cursor.candidates[0]).toBe("cursor-agent");
    expect(cursor.baseArgs).toEqual(["acp"]);
    expect(claude.protocol).toBe("acp");
    expect(claude.candidates[0]).toBe("claude-agent-acp");
    expect(claude.baseArgs).toEqual([]);
  });

  it("have default settings and appear in the harness list", () => {
    for (const h of ["cursor", "claude"] as const) {
      expect(HARNESS_IDS).toContain(h);
      expect(DEFAULT_SETTINGS.harnesses[h].enabled).toBe(true);
    }
  });

  it("report partial instruction isolation in clean mode", () => {
    for (const h of ["cursor", "claude"] as const) {
      expect(prepareInstructions(h, { mode: "clean", keepProject: false, dataDir: "/tmp" })).toMatchObject({ args: [], coverage: "partial" });
    }
  });

  it("can be named in text delegations", () => {
    expect(parseTextDelegations("DELEGATE reviewer@claude: review the diff\nDELEGATE tester@cursor: run the tests")).toEqual([
      { role: "reviewer", harness: "claude", goal: "review the diff" },
      { role: "tester", harness: "cursor", goal: "run the tests" },
    ]);
  });
});

describe("PATH for GUI launches", () => {
  it("merges PATH lists without duplicates, keeping order", () => {
    expect(mergePaths(["/a", "/b"].join(delimiter), ["/b", "/c"].join(delimiter), "")).toBe(["/a", "/b", "/c"].join(delimiter));
  });
  it.skipIf(process.platform === "win32")("reads PATH from a login shell", () => {
    expect(loginShellPath("/bin/sh")).toContain("/bin");
    expect(loginShellPath("/no/such/shell")).toBe("");
  });
});
