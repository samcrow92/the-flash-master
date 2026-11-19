import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SETTINGS, jazzToolsOn } from "../src/shared/settings";
import { DUO_GOAL_DIR, excludeGoalDir } from "../src/main/harness/duo";
import { DUO_SPECIALIST_RULES, textToolRules } from "../src/main/context";

// Bug 2026-11-19: a GitLab Duo specialist asked to check an EWM link said scm_link / scm_list were not in its tool list,
// and could not open its own goal file because a .gitignore covered it.
describe("Duo agents get the EWM source control tools", () => {
  it("agents get the Jazz tools once a Jazz server or sign-in is filled in, not only with the top switch on", () => {
    const j = DEFAULT_SETTINGS.jazz;
    expect(jazzToolsOn(j)).toBe(false);
    expect(jazzToolsOn({ ...j, username: "mari" })).toBe(true);
    expect(jazzToolsOn({ ...j, serverUrl: "https://jazz.corp/ccm" })).toBe(true);
    expect(jazzToolsOn({ ...j, enabled: true })).toBe(true);
  });

  it("Duo specialists are told their TheFlashMaster tools are the TOOL lines, not Duo's own tool list", () => {
    expect(DUO_SPECIALIST_RULES).toMatch(/scm_\*/);
    expect(DUO_SPECIALIST_RULES).toMatch(/not Duo's own tool list/);
    expect(textToolRules([{ name: "scm_link", description: "Read an EWM link.", inputSchema: { properties: { link: {} }, required: ["link"] } }]))
      .toMatch(/even when your CLI's own tool list doesn't show them[\s\S]*- scm_link\(link\)/);
  });

  it("the goal folder is kept out of git by the repository's exclude file, and an old .gitignore in it is removed", () => {
    const d = mkdtempSync(join(tmpdir(), "duo-goal-"));
    execFileSync("git", ["init", "-q"], { cwd: d });
    mkdirSync(join(d, DUO_GOAL_DIR));
    writeFileSync(join(d, DUO_GOAL_DIR, ".gitignore"), "*\n");
    writeFileSync(join(d, DUO_GOAL_DIR, "goal-x.md"), "brief");
    expect(excludeGoalDir(d)).toBe(true);
    expect(excludeGoalDir(d)).toBe(true); // once only
    expect(existsSync(join(d, DUO_GOAL_DIR, ".gitignore"))).toBe(false);
    expect(readFileSync(join(d, ".git", "info", "exclude"), "utf8").match(/\/\.flashmaster-duo\//g)).toHaveLength(1);
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: d, encoding: "utf8" })).toBe("");
    expect(excludeGoalDir(mkdtempSync(join(tmpdir(), "nogit-")))).toBe(false);
  });
});
