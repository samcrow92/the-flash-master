import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { Marketplace, compareVersions, normaliseUrl } from "../src/main/marketplace";
import { loadRoles, loadSkills } from "../src/main/roles";
import type { FetchLike } from "../src/main/jazz";

const ROOT = join(__dirname, "..");
let server: Server;
let port = 0;
let market = "";
const seen: { url: string; auth?: string }[] = [];

beforeAll(async () => {
  market = mkdtempSync(join(tmpdir(), "mp-"));
  cpSync(join(ROOT, "marketplace-example", "plugins-src"), join(market, "plugins-src"), { recursive: true });
  const r = spawnSync(process.execPath, [join(ROOT, "scripts", "marketplace", "build-index.mjs"), market, "--name", "Body Electronics"], { encoding: "utf8" });
  expect(r.status, r.stderr).toBe(0);
  server = createServer((req, res) => {
    seen.push({ url: req.url ?? "", auth: req.headers.authorization });
    const f = join(market, decodeURIComponent((req.url ?? "/").split("?")[0]!));
    if (!f.startsWith(market) || !existsSync(f)) { res.writeHead(404).end(); return; }
    res.writeHead(200, { "Content-Type": "application/json" }).end(readFileSync(f));
  });
  await new Promise<void>((r2) => server.listen(0, "127.0.0.1", () => r2()));
  port = (server.address() as any).port;
});
afterAll(() => server?.close());

const fetchImpl: FetchLike = async (url, init) => {
  const r = await fetch(url, { headers: init?.headers });
  return { status: r.status, ok: r.ok, headers: { get: (n: string) => r.headers.get(n) }, text: () => r.text() };
};

function setup(over: Partial<{ allowMcpServers: boolean }> = {}) {
  const data = mkdtempSync(join(tmpdir(), "mpdata-"));
  const rolesDir = join(data, "agents"), skillsDir = join(data, "skills");
  mkdirSync(rolesDir, { recursive: true });
  const mcp: { added: { ids: string[]; enabled: boolean }[]; removed: string[] } = { added: [], removed: [] };
  const mp = new Marketplace({
    dataDir: data, rolesDir, skillsDir, fetch: fetchImpl,
    policy: () => ({ allowMcpServers: over.allowMcpServers ?? false }),
    knownTools: () => ["flashmaster-core", "vector-autosar", "jazz", "office", "winidea"],
    builtinRoles: () => loadRoles(join(ROOT, "agents"), "/none").map((r) => r.name),
    addMcpServers: (s, enabled) => mcp.added.push({ ids: s.map((x) => x.id), enabled }),
    removeMcpServers: (ids) => mcp.removed.push(...ids),
  });
  const src = { id: "body", name: "Body", url: `127.0.0.1:${port}`, department: "Body Electronics", enabled: true };
  return { mp, src, data, rolesDir, skillsDir, mcp };
}

describe("marketplace", () => {
  it("lists a department marketplace from a plain HTTP server (IP:port)", async () => {
    const { mp, src } = setup();
    const l = await mp.fetchIndex(src);
    expect(l.error).toBeNull();
    expect(l.url).toBe(`http://127.0.0.1:${port}`);
    expect(l.plugins.map((p) => [p.id, p.version, p.kinds])).toEqual([
      ["body-sw-test-pack", "1.0.0", ["agent", "workflow"]], ["diag-team-rules", "2.1.0", ["instructions"]]]);
    expect(l.plugins.every((p) => /^[0-9a-f]{64}$/.test(p.sha256!))).toBe(true);
  });

  it("installs agents, workflows and instructions, then uninstalls exactly them", async () => {
    const { mp, src, rolesDir, skillsDir } = setup();
    const rec = await mp.install(src, "body-sw-test-pack");
    expect(rec).toMatchObject({ agents: ["hil-tester"], workflows: ["hil-campaign"], sourceName: "Body" });
    expect(loadRoles(join(ROOT, "agents"), rolesDir).find((r) => r.name === "hil-tester")).toMatchObject({ title: "HIL Test Engineer (Body)", source: "user" });
    expect(loadSkills(skillsDir).map((s) => s.command)).toEqual(["hil-campaign"]);
    await mp.install(src, "diag-team-rules");
    expect(mp.instructions()).toContain("DID_<0xNNNN>_<Name>");
    mp.setInstructionsEnabled("diag-team-rules", false);
    expect(mp.instructions()).toBe("");
    mp.uninstall("body-sw-test-pack");
    expect(existsSync(join(rolesDir, "hil-tester.md"))).toBe(false);
    expect(existsSync(join(skillsDir, "hil-campaign.md"))).toBe(false);
    expect(mp.installed().map((p) => p.id)).toEqual(["diag-team-rules"]);
  });

  it("detects and applies updates, keeping the user's instruction toggle", async () => {
    const { mp, src } = setup();
    await mp.install(src, "diag-team-rules");
    mp.setInstructionsEnabled("diag-team-rules", false);
    const meta = join(market, "plugins-src", "diag-team-rules", "plugin.json");
    const orig = readFileSync(meta, "utf8");
    writeFileSync(meta, orig.replace('"2.1.0"', '"2.2.0"'));
    try {
      spawnSync(process.execPath, [join(ROOT, "scripts", "marketplace", "build-index.mjs"), market]);
      await mp.refresh([src]);
      expect(mp.updates().map((u) => [u.plugin.version, u.entry.version])).toEqual([["2.1.0", "2.2.0"]]);
      const rec = await mp.install(src, "diag-team-rules");
      expect(rec).toMatchObject({ version: "2.2.0", instructionsEnabled: false });
      expect(mp.updates()).toEqual([]);
    } finally {
      writeFileSync(meta, orig);
      spawnSync(process.execPath, [join(ROOT, "scripts", "marketplace", "build-index.mjs"), market]);
    }
  });

  it("rejects a package that does not match its published checksum, and installs without one", async () => {
    const { mp, src, rolesDir } = setup();
    const idxFile = join(market, "index.json");
    const orig = readFileSync(idxFile, "utf8");
    try {
      const idx = JSON.parse(orig);
      idx.plugins[0].sha256 = "0".repeat(64);
      writeFileSync(idxFile, JSON.stringify(idx));
      await mp.refresh([src]);
      await expect(mp.install(src, "body-sw-test-pack")).rejects.toThrow(/does not match the marketplace index/);
      expect(existsSync(join(rolesDir, "hil-tester.md"))).toBe(false);
      delete idx.plugins[0].sha256; // hand-written index without checksums is fine on an internal server
      writeFileSync(idxFile, JSON.stringify(idx));
      await mp.refresh([src]);
      expect((await mp.install(src, "body-sw-test-pack")).agents).toEqual(["hil-tester"]);
    } finally {
      writeFileSync(idxFile, orig);
    }
  });

  it("refuses to overwrite the user's own agent and validates package contents", async () => {
    const { mp, src, rolesDir } = setup();
    writeFileSync(join(rolesDir, "hil-tester.md"), "---\nname: hil-tester\ntitle: Mine\n---\nMy own HIL tester instructions here.");
    await expect(mp.install(src, "body-sw-test-pack")).rejects.toThrow(/already exists as one of your own agents/);
    expect(readFileSync(join(rolesDir, "hil-tester.md"), "utf8")).toContain("title: Mine");
  });

  it("reports unreachable marketplaces", async () => {
    const { mp, src } = setup();
    seen.length = 0;
    await mp.fetchIndex(src);
    expect(seen[0]).toMatchObject({ url: "/index.json" });
    const down = await mp.fetchIndex({ ...src, id: "x", url: "127.0.0.1:1" });
    expect(down.error).toBeTruthy();
  });

  it("adds plugin MCP servers only as allowed by policy", async () => {
    const dir = join(market, "plugins-src", "tool-pack");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "plugin.json"), JSON.stringify({ id: "tool-pack", name: "Tools", version: "1.0.0", team: "Tools" }));
    writeFileSync(join(dir, "mcp.json"), JSON.stringify([{ id: "a2l", label: "A2L tools", command: "a2l-mcp", args: "--stdio" }]));
    spawnSync(process.execPath, [join(ROOT, "scripts", "marketplace", "build-index.mjs"), market]);
    const strict = setup();
    expect((await strict.mp.install(strict.src, "tool-pack")).mcpServers).toEqual(["tool-pack.a2l"]);
    expect(strict.mcp.added).toEqual([{ ids: ["tool-pack.a2l"], enabled: false }]);
    strict.mp.uninstall("tool-pack");
    expect(strict.mcp.removed).toEqual(["tool-pack.a2l"]);
    const open = setup({ allowMcpServers: true });
    await open.mp.install(open.src, "tool-pack");
    expect(open.mcp.added[0]!.enabled).toBe(true);
  });

  it("compares versions and normalises server addresses", () => {
    expect(compareVersions("1.10.0", "1.9.3")).toBeGreaterThan(0);
    expect(compareVersions("2.0.0", "2.0.0")).toBe(0);
    expect(compareVersions("1.0.0-beta", "1.0.0")).toBeLessThan(0);
    expect(normaliseUrl("10.1.2.3:8080/")).toBe("http://10.1.2.3:8080");
    expect(normaliseUrl("https://mp.corp/body")).toBe("https://mp.corp/body");
    expect(createHash("sha256").update("x").digest("hex")).toHaveLength(64);
  });
});
