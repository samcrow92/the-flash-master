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

describe("window chrome", () => {
  // The bolt icon has gone missing twice: once from the taskbar (no AppUserModelID / .ico) and once from the window
  // when the native title bar was removed. Keep both in place.
  it("every BrowserWindow carries the app icon", () => {
    const src = read("src/main/index.ts");
    const windows = [...src.matchAll(/new BrowserWindow\(\{([\s\S]*?)webPreferences/g)].map((m) => m[1]!);
    expect(windows.length).toBeGreaterThan(2);
    expect(windows.filter((w) => !/icon: appIcon/.test(w)), "BrowserWindow without icon: appIcon").toEqual([]);
    expect(src).toMatch(/setAppUserModelId\(/);
  });
  it("the Windows .ico has the taskbar sizes, small frames as BMP, and ships with the app", () => {
    // An all-PNG .ico left the taskbar without the bolt; scripts/make-ico.py rebuilds it in this layout.
    const ico = readFileSync(join(root, "build/icon.ico"));
    expect([ico.readUInt16LE(0), ico.readUInt16LE(2)]).toEqual([0, 1]);
    const frames = Array.from({ length: ico.readUInt16LE(4) }, (_, i) => {
      const e = 6 + 16 * i;
      const off = ico.readUInt32LE(e + 12);
      return { size: ico[e] || 256, png: ico.subarray(off, off + 4).toString("latin1") === "\x89PNG" };
    });
    expect(frames.map((f) => f.size)).toEqual(expect.arrayContaining([16, 24, 32, 48, 256]));
    expect(frames.filter((f) => f.size < 256 && f.png).map((f) => f.size), "small .ico frames stored as PNG").toEqual([]);
    const builder = read("electron-builder.yml");
    expect(builder).toMatch(/from: build\/icon\.ico\s+to: build\/icon\.ico/);
    expect(builder).toMatch(/win:\s+icon: build\/icon\.ico/);
  });
  it("the app icon is resolved for packaged and source runs, and the smoke test checks it loaded", () => {
    const src = read("src/main/index.ts");
    expect(src).toMatch(/iconCandidates\(\{[^}]*process\.resourcesPath[^}]*app\.getAppPath\(\)[^}]*join\(here, "\.\.", "\.\."\)/);
    expect(src).toMatch(/runSmoke\(win!, log, appIcon\)/);
    expect(read("src/main/smoke.ts")).toMatch(/app\.exit\(ok && iconOk && [^)]*\? 0 : 1\)/);
  });
  it("the frameless title bar shows the app icon and Windows-style caption buttons", () => {
    const tsx = read("src/renderer/components/TitleBar.tsx");
    expect(tsx).toMatch(/import appIcon from "\.\.\/assets\/app-icon\.png"/);
    expect(tsx).toMatch(/<img className="titlebar-icon" src=\{appIcon\}/);
    for (const action of ["minimize", "maximize", "close"]) expect(tsx).toContain(`windowControl("${action}")`);
    expect(readFileSync(join(root, "src/renderer/assets/app-icon.png")).length).toBeGreaterThan(100);
  });
});

describe("role icons", () => {
  // Specialist icons are monochrome line glyphs like the rest of the UI, and their activity follows the glyph's shape.
  it("are monochrome: no per-role hues or gradient tiles", () => {
    expect(read("src/renderer/components/icons.tsx")).not.toMatch(/hue/i);
    const css = read("src/renderer/styles.css");
    const badgeRules = [...css.matchAll(/^[^{}\n]*\.role-badge[^{]*\{[^}]*\}/gm)].map((m) => m[0]);
    expect(badgeRules.length).toBeGreaterThan(3);
    expect(badgeRules.filter((r) => /--hue|gradient/.test(r)), "role-badge rule with a tint").toEqual([]);
  });
  it("show activity through the glyph itself, not a circular ring", () => {
    expect(read("src/renderer/components/icons.tsx")).toMatch(/className="role-echo"/);
    for (const f of ["src/renderer/components/SpecialistsPill.tsx", "src/renderer/styles.css"]) expect(read(f)).not.toContain("activity-ring");
  });
});

describe("native modules", () => {
  // The main bundle inlines devDependencies; a native module can't be inlined, so it must be a runtime dependency
  // (externalised by electron-vite, shipped by electron-builder) and unpacked from app.asar so its binaries can run.
  it("every runtime dependency is a native module that electron-builder unpacks from asar", () => {
    const pkg = JSON.parse(read("package.json")) as { dependencies?: Record<string, string> };
    const builder = read("electron-builder.yml");
    const deps = Object.keys(pkg.dependencies ?? {});
    expect(deps).toEqual(["node-pty"]);
    for (const d of deps) expect(builder, `${d} must be in asarUnpack`).toContain(`node_modules/${d}/**`);
  });
  it("node-pty's macOS spawn-helper is made executable after install", () => {
    const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
    expect(pkg.scripts.postinstall).toContain("scripts/fix-node-pty.mjs");
  });
  it("the smoke test fails when the integrated terminal can't run a command", () => {
    const smoke = read("src/main/smoke.ts");
    expect(smoke).toMatch(/const termOk = term === "ok"/);
    expect(smoke).toMatch(/app\.exit\([^)]*termOk[^)]*\? 0 : 1\)/);
    expect(smoke).toMatch(/app\.exit\([^)]*popOk \? 0 : 1\)/);
  });
});

describe("integrated terminal", () => {
  // Esc used to stop the chat's agents and Ctrl+K/L/N opened app features while typing in the shell.
  it("app-wide shortcuts ignore keys typed in the terminal", () => {
    const src = read("src/renderer/components/CommandPalette.tsx");
    const handler = src.slice(src.indexOf("export function useShortcuts"), src.indexOf("matchShortcut(e, isMac())"));
    expect(handler).toMatch(/closest\("\.term-panel"\)\) return;/);
  });
});

describe("running-agent chip", () => {
  // The icon, label and round pause/stop buttons must share one centre line (they drifted when the label was inline text).
  it("lays out icon, label and buttons as a centred flex row with fixed-size round buttons", () => {
    const css = read("src/renderer/styles.css");
    const rule = (sel: string) => css.match(new RegExp(`^${sel.replace(/\./g, "\\.")} \\{([^}]*)\\}`, "m"))?.[1] ?? "";
    expect(rule(".agent-chip")).toMatch(/display: inline-flex;.*align-items: center;.*height: \d+px/);
    expect(rule(".agent-chip .chip-main")).toMatch(/display: inline-flex;.*align-items: center/);
    expect(rule(".agent-chip .chip-act")).toMatch(/place-items: center;.*width: (\d+)px; height: \1px;.*border-radius: 50%/);
    expect(css).not.toMatch(/\.agent-chip \.role-badge \{[^}]*vertical-align/);
    const tsx = read("src/renderer/components/AgentsPill.tsx");
    expect(tsx).toContain('<span className="chip-label">');
    expect(tsx.match(/className="chip-act"/g)?.length).toBe(4);
  });
});

describe("agents without a project", () => {
  // Starting an agent or chat with no project selected must not fall back to the first project in the list.
  it("no renderer code that starts chats picks projects[0]", () => {
    for (const f of ["src/renderer/agentChat.ts", "src/renderer/components/SpecialistsPill.tsx", "src/renderer/components/CommandPalette.tsx", "src/renderer/store.ts"]) {
      expect(read(f), f).not.toMatch(/projects\[0\]|projectIds\[0\]/);
    }
  });
  it("the sidebar shows a No project section and the store loads its chats", () => {
    expect(read("src/renderer/components/Sidebar.tsx")).toContain("<NoProjectSection");
    expect(read("src/renderer/store.ts")).toMatch(/refreshChats\(null\)/);
  });
});

describe("specialists pill", () => {
  // Clicking a specialist in the pill's list opens its chat (the one it works in, its latest, or a new one), not always a new chat.
  it("opens the specialist's own chat", () => {
    const tsx = read("src/renderer/components/SpecialistsPill.tsx");
    expect(tsx).toMatch(/st\.chatWithAgent\(r\.name, \{ showFlow: false \}\)/);
    expect(tsx).not.toMatch(/createChat\(/);
  });
});
