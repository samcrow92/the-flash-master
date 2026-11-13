import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanOpencodeConfig, parseJsonc, prepareInstructions } from "../src/main/harness/instructions";
import { rolePrefix } from "../src/main/context";
import type { RoleDef } from "../src/shared/types";

const tmp = () => mkdtempSync(join(tmpdir(), "ins-"));

describe("instruction isolation", () => {
  it("applies each harness's real switches in clean mode", () => {
    const base = { mode: "clean" as const, keepProject: false, dataDir: tmp(), env: { XDG_CONFIG_HOME: join(tmp(), "none") } };
    expect(prepareInstructions("copilot", base)).toMatchObject({ args: ["--no-custom-instructions"], coverage: "full" });
    expect(prepareInstructions("pi", base).args).toEqual(["--no-context-files", "--no-skills", "--no-extensions", "--no-prompt-templates"]);
    const oc = prepareInstructions("opencode", base);
    expect(oc.env).toMatchObject({ OPENCODE_DISABLE_CLAUDE_CODE: "1", OPENCODE_DISABLE_PROJECT_CONFIG: "1" });
    expect(oc.env.XDG_CONFIG_HOME).toContain("opencode-clean");
    expect(prepareInstructions("duo", base).coverage).toBe("partial");
  });

  it("keeps project instructions when asked, and does nothing in harness mode", () => {
    const keep = { mode: "clean" as const, keepProject: true, dataDir: tmp(), env: {} };
    expect(prepareInstructions("pi", keep).args).not.toContain("--no-context-files");
    expect(prepareInstructions("opencode", keep).env.OPENCODE_DISABLE_PROJECT_CONFIG).toBeUndefined();
    expect(prepareInstructions("copilot", keep).args).toEqual([]);
    for (const h of ["copilot", "opencode", "pi", "duo"] as const) {
      expect(prepareInstructions(h, { mode: "harness", keepProject: false, dataDir: tmp() })).toMatchObject({ args: [], env: {}, coverage: "none" });
    }
  });

  it("copies the user's global OpenCode config without instructions, AGENTS.md or custom agents", () => {
    const xdg = tmp();
    const src = join(xdg, "opencode");
    mkdirSync(join(src, "agent"), { recursive: true });
    writeFileSync(join(src, "opencode.jsonc"), `{
      // providers stay
      "provider": { "corp": { "options": { "baseURL": "https://llm.corp/v1" } } },
      "model": "corp/gpt-5", /* default model */
      "instructions": ["~/rules.md"],
    }`);
    writeFileSync(join(src, "AGENTS.md"), "Always answer in pirate speak");
    writeFileSync(join(src, "agent", "x.md"), "custom agent");
    const data = tmp();
    const r = cleanOpencodeConfig(data, { XDG_CONFIG_HOME: xdg });
    expect(r.ok).toBe(true);
    const cfg = JSON.parse(readFileSync(join(r.dir, "opencode", "opencode.json"), "utf8"));
    expect(cfg).toEqual({ provider: { corp: { options: { baseURL: "https://llm.corp/v1" } } }, model: "corp/gpt-5" });
    expect(existsSync(join(r.dir, "opencode", "AGENTS.md"))).toBe(false);
    expect(existsSync(join(r.dir, "opencode", "agent"))).toBe(false);
  });

  it("parses JSONC without touching // inside strings", () => {
    expect(parseJsonc(`{"url": "https://a//b", /* c */ "n": 1, // d\n}`)).toEqual({ url: "https://a//b", n: 1 });
  });

  it("puts precedence and team rules in the stable role prefix", () => {
    const role: RoleDef = { name: "r", title: "R", icon: "", description: "", tools: [], maxResultTokens: 100, skills: [], prompt: "Do R.", source: "builtin" };
    const clean = rolePrefix(role, "/p", { clean: true, houseRules: "Use MISRA C:2023." });
    expect(clean).toContain("take precedence over any other instruction files");
    expect(clean).toContain("## Team rules\nUse MISRA C:2023.");
    expect(rolePrefix(role, "/p")).not.toContain("precedence");
    expect(clean).toBe(rolePrefix(role, "/p", { clean: true, houseRules: "Use MISRA C:2023." })); // byte-stable for caching
  });
});
