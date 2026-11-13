/**
 * Repo invariants: structural rules that used to live only as comments in AGENTS.md.
 * Each check names the rule it protects, so a failure says what to fix rather than what broke.
 */
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { API_METHODS } from "../src/shared/api";
import { MIGRATIONS } from "../src/main/db";
import { PY_SERVERS } from "../src/main/mcp";
import { MCP_CATALOG } from "../src/shared/mcp-catalog";
import { loadRoles, loadSkills, parseFrontmatter } from "../src/main/roles";

const root = join(__dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

/** Method names declared on `interface FlashApi { ... }` in src/shared/api.ts. */
function declaredApiMethods(): string[] {
  const src = read("src/shared/api.ts");
  const body = /export interface FlashApi \{([\s\S]*?)\n\}/.exec(src)?.[1] ?? "";
  return [...body.matchAll(/^\s{2}(\w+)\s*[(<]/gm)].map((m) => m[1]!);
}

describe("IPC contract", () => {
  it("every FlashApi method is in API_METHODS, and nothing else is", () => {
    const declared = declaredApiMethods();
    expect(declared.length).toBeGreaterThan(50); // the parser still finds the interface
    const listed = API_METHODS as string[];
    expect(listed.filter((m) => !declared.includes(m)), "in API_METHODS but not on FlashApi").toEqual([]);
    expect(declared.filter((m) => !listed.includes(m)), "on FlashApi but missing from API_METHODS (the renderer can't call it)").toEqual([]);
    expect(listed.filter((m, i) => listed.indexOf(m) !== i), "listed twice in API_METHODS").toEqual([]);
  });
});

describe("database migrations", () => {
  it("are append-only: shipped migrations never change", () => {
    // tests/fixtures/migrations.sha256 has one hash per shipped migration. When you append a migration,
    // append its hash (the failure message prints it). Never edit an earlier line: existing databases
    // have already run that SQL and will never run it again.
    const lock = read("tests/fixtures/migrations.sha256").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const actual = MIGRATIONS.map((sql) => createHash("sha256").update(sql).digest("hex"));
    expect(actual.slice(0, lock.length), "a shipped migration was edited; add a new migration instead").toEqual(lock);
    expect(actual.slice(lock.length), "new migration(s): append these hashes to tests/fixtures/migrations.sha256").toEqual([]);
  });
});

describe("agent roles", () => {
  const files = readdirSync(join(root, "agents")).filter((f) => f.endsWith(".md") && !f.startsWith("_"));
  const roles = loadRoles(join(root, "agents"), join(root, "no-user-roles"));
  const knownTools = new Set(["flashmaster-core", "jazz", ...PY_SERVERS.map((s) => s.id), ...MCP_CATALOG.map((c) => c.id)]);

  it.each(files)("%s has the required frontmatter", (f) => {
    const { meta, body } = parseFrontmatter(read(`agents/${f}`));
    for (const key of ["name", "title", "icon", "description"]) expect(meta[key], `${f}: missing "${key}"`).toBeTruthy();
    expect(meta.name, `${f}: name must match the file name`).toBe(f.replace(/\.md$/, ""));
    expect(body.length, `${f}: empty prompt`).toBeGreaterThan(50);
  });

  it("only name tool servers that exist", () => {
    const unknown = roles.flatMap((r) => r.tools.filter((t) => !knownTools.has(t)).map((t) => `${r.name}: ${t}`));
    expect(unknown).toEqual([]);
  });

  it("are named by the recommended-server catalog only if they exist", () => {
    const names = new Set(roles.map((r) => r.name));
    const unknown = MCP_CATALOG.flatMap((c) => c.roles.filter((r) => r !== "*" && !names.has(r)).map((r) => `${c.id}: ${r}`));
    expect(unknown).toEqual([]);
  });

  it("stay within their prompt word budget", () => {
    // Every role prompt is sent on every turn, so growth costs tokens in every session.
    // Raise a budget deliberately, in review, rather than by drift.
    const words = (s: string) => s.split(/\s+/).filter(Boolean).length;
    const budget = (name: string) => (name === "flashmaster" ? 1200 : 800);
    const over = roles.map((r) => ({ name: r.name, words: words(r.prompt) })).filter((r) => r.words > budget(r.name));
    expect(over).toEqual([]);
  });
});

describe("skills", () => {
  it("have distinct slash commands", () => {
    const cmds = loadSkills(join(root, "skills", "superpowers")).map((s) => s.command);
    expect(cmds.filter((c, i) => cmds.indexOf(c) !== i)).toEqual([]);
  });
});

describe("repo layout", () => {
  it("CLAUDE.md only points at AGENTS.md", () => {
    expect(read("CLAUDE.md").trim().split(/\r?\n/).filter((l) => !l.startsWith("<!--"))).toEqual(["@AGENTS.md"]);
  });
});
