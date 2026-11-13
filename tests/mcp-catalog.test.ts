import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { McpBootstrap, venvPython } from "../src/main/mcp";
import { DEFAULT_SETTINGS, mergeSettings, type Settings } from "../src/shared/settings";
import { MCP_CATALOG, catalogState } from "../src/shared/mcp-catalog";
import type { RoleDef } from "../src/shared/types";

const role = (name: string, tools: string[] = ["flashmaster-core"]): RoleDef =>
  ({ name, title: name, icon: "", description: "", tools, maxResultTokens: 800, skills: [], prompt: "", source: "builtin" });

function setup(patch: unknown = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "flash-cat-"));
  // pretend context7 (npm) and markitdown (pip) are installed
  const pkg = join(dataDir, "mcp", "npm", "context7", "node_modules", "@upstash", "context7-mcp");
  mkdirSync(join(pkg, "dist"), { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@upstash/context7-mcp", bin: { "context7-mcp": "dist/index.js" } }));
  writeFileSync(join(pkg, "dist", "index.js"), "");
  writeFileSync(join(dataDir, "mcp", "npm", "context7", ".installed"), "x");
  const vpy = venvPython(join(dataDir, "mcp", ".venv"));
  mkdirSync(join(vpy, ".."), { recursive: true });
  writeFileSync(vpy, "");
  mkdirSync(join(dataDir, "mcp", "pip"), { recursive: true });
  writeFileSync(join(dataDir, "mcp", "pip", "markitdown.installed"), "x");
  let settings: Settings = mergeSettings(DEFAULT_SETTINGS, patch);
  const boot = new McpBootstrap({ nodeEntry: (n) => `/app/${n}.mjs`, nodeExec: "/electron", nodeEnv: { ELECTRON_RUN_AS_NODE: "1" }, pythonSrc: "/none", dataDir },
    () => settings, () => {});
  boot.setBridge("http://127.0.0.1:1", "t");
  return { boot, dataDir, set: (p: unknown) => { settings = mergeSettings(settings, p); } };
}

describe("recommended MCP servers", () => {
  it("defaults: Context7, Sequential Thinking and MarkItDown on; others off", () => {
    const on = MCP_CATALOG.filter((c) => catalogState(c, {}).enabled).map((c) => c.id);
    expect(on).toEqual(["context7", "sequential-thinking", "markitdown"]);
  });

  it("attaches installed servers only to their roles", () => {
    const { boot } = setup();
    const names = (r: string) => boot.specsFor(role(r), "a1").map((s) => s.name);
    expect(names("software-expert")).toEqual(["flashmaster-core", "context7"]);
    expect(names("analyst")).toEqual(["flashmaster-core", "markitdown"]); // sequential-thinking not installed → skipped
    expect(names("presentation-expert")).toEqual(["flashmaster-core", "markitdown"]);
    const c7 = boot.specsFor(role("software-expert"), "a1").find((s) => s.name === "context7")!;
    expect(c7.command).toBe("/electron");
    expect(c7.args[0]).toMatch(/context7-mcp[\\/]dist[\\/]index\.js$/);
    expect(c7.env.ELECTRON_RUN_AS_NODE).toBe("1");
    const md = boot.specsFor(role("analyst"), "a1").find((s) => s.name === "markitdown")!;
    expect(md.args).toEqual(["-m", "markitdown_mcp"]);
  });

  it("honours role overrides, '*', API keys and disabling", () => {
    const { boot, set } = setup({ mcp: { catalog: { context7: { roles: "*", env: "CONTEXT7_API_KEY=ctx7sk_1" } } } });
    const c7 = boot.specsFor(role("presentation-expert"), "a").find((s) => s.name === "context7");
    expect(c7?.env.CONTEXT7_API_KEY).toBe("ctx7sk_1");
    set({ mcp: { catalog: { context7: { roles: "*", enabled: false } } } });
    expect(boot.specsFor(role("software-expert"), "a").map((s) => s.name)).not.toContain("context7");
    expect(boot.list().find((s) => s.id === "context7")?.state).toBe("disabled");
  });

  it("custom servers can be attached by role list", () => {
    const { boot } = setup({ mcp: { external: [{ id: "drawio", label: "", command: "drawio-mcp", args: "--x", env: "A=1", roles: "architect, reviewer" }] } });
    expect(boot.specsFor(role("architect"), "a").find((s) => s.name === "drawio")).toMatchObject({ command: "drawio-mcp", args: ["--x"], env: { A: "1" } });
    expect(boot.specsFor(role("tester"), "a").map((s) => s.name)).not.toContain("drawio");
  });
});

describe("tool server self-test", () => {
  it("starts a server with only the given environment and lists its tools; reports crashes", async () => {
    const { selfTestServer, baseEnv } = await import("../src/main/mcp");
    const fixture = join(__dirname, "fixtures", "fake-mcp.mjs");
    expect(Object.keys(baseEnv())).toContain(process.platform === "win32" ? "SystemRoot" : "PATH");
    expect(await selfTestServer({ name: "fake", command: process.execPath, args: [fixture], env: baseEnv() })).toEqual({ name: "fake", ok: true, tools: 2, detail: "ok" });
    const bad = await selfTestServer({ name: "crash", command: process.execPath, args: [fixture, "--crash"], env: {} });
    expect(bad.ok).toBe(false);
    expect(bad.detail).toMatch(/exited \(3\).*missing SystemRoot/);
  });

  it("app tool servers get the essential environment and bridge settings as arguments", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "flash-env-"));
    const boot = new McpBootstrap({ nodeEntry: (n) => `/app/${n}.mjs`, nodeExec: "/electron", nodeEnv: { ELECTRON_RUN_AS_NODE: "1" }, pythonSrc: "/none", dataDir },
      () => DEFAULT_SETTINGS, () => {});
    boot.setBridge("http://127.0.0.1:9", "tok");
    const core = boot.specsFor(role("flashmaster"), "agent-1").find((x) => x.name === "flashmaster-core")!;
    expect(core.args).toEqual(["/app/flashmaster-core.mjs", "--bridge", "http://127.0.0.1:9", "--token", "tok", "--agent", "agent-1"]);
    expect(core.env.PATH ?? core.env.Path).toBeTruthy();
    expect(core.env.ELECTRON_RUN_AS_NODE).toBe("1");
    expect(core.env.NO_PROXY).toContain("127.0.0.1");
  });
});
