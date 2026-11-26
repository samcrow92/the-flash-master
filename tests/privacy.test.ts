import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TELEMETRY_OPT_OUT, telemetryOptOutEnv } from "../src/main/privacy";
import { cleanOpencodeConfig } from "../src/main/harness/instructions";

describe("telemetry opt-outs for child processes", () => {
  it("adds every opt-out the user hasn't set", () => {
    const env = telemetryOptOutEnv({});
    expect(env).toEqual(TELEMETRY_OPT_OUT);
    expect(env).toMatchObject({ DO_NOT_TRACK: "1", DISABLE_TELEMETRY: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", POWERSHELL_TELEMETRY_OPTOUT: "1" });
  });
  it("never overrides a value the user set", () => {
    const env = telemetryOptOutEnv({ DO_NOT_TRACK: "0", NPM_CONFIG_AUDIT: "true" });
    expect(env.DO_NOT_TRACK).toBeUndefined();
    expect(env.NPM_CONFIG_AUDIT).toBeUndefined();
    expect(env.DISABLE_TELEMETRY).toBe("1");
  });
});

describe("OpenCode session sharing", () => {
  it("is disabled in the clean config, even when the user's config shares automatically", () => {
    const home = mkdtempSync(join(tmpdir(), "fm-oc-"));
    mkdirSync(join(home, "opencode"));
    writeFileSync(join(home, "opencode", "opencode.jsonc"), '{ "share": "auto", "model": "x" }');
    const r = cleanOpencodeConfig(join(home, "data"), { XDG_CONFIG_HOME: home });
    expect(r.ok).toBe(true);
    expect(JSON.parse(readFileSync(join(r.dir, "opencode", "opencode.json"), "utf8"))).toMatchObject({ share: "disabled", model: "x" });
  });
  it("is disabled when the user has no OpenCode config", () => {
    const home = mkdtempSync(join(tmpdir(), "fm-oc-"));
    const r = cleanOpencodeConfig(join(home, "data"), { XDG_CONFIG_HOME: home });
    expect(JSON.parse(readFileSync(join(r.dir, "opencode", "opencode.json"), "utf8"))).toEqual({ share: "disabled" });
  });
});
