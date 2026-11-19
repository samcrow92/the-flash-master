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
import { DEFAULT_SETTINGS } from "../src/shared/settings";

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
    const cmds = ["superpowers", "pstack"].flatMap((d) => loadSkills(join(root, "skills", d))).map((s) => s.command);
    expect(cmds.filter((c, i) => cmds.indexOf(c) !== i)).toEqual([]);
  });

  it("bundle pstack's unslop with its MIT license, loaded by the app and on by default", () => {
    // Mari asked for unslop as the default writing rule for every agent; the license must ship with the copied text.
    expect(loadSkills(join(root, "skills", "pstack")).map((s) => s.command)).toContain("unslop");
    expect(read("skills/pstack/LICENSE")).toMatch(/MIT License[\s\S]*Lauren Tan/);
    expect(read("src/main/index.ts")).toContain('join(resources, "skills", "pstack")');
    expect(DEFAULT_SETTINGS.agents.unslop).toBe(true);
  });
});

describe("repo layout", () => {
  it("CLAUDE.md only points at AGENTS.md", () => {
    expect(read("CLAUDE.md").trim().split(/\r?\n/).filter((l) => !l.startsWith("<!--"))).toEqual(["@AGENTS.md"]);
  });
});

describe("window chrome", () => {
  // The bolt icon has gone missing three times: twice from the taskbar (no AppUserModelID / .ico, then no relaunch icon) and once from the window
  // when the native title bar was removed. Keep both in place.
  it("every BrowserWindow carries the app icon", () => {
    const src = read("src/main/index.ts");
    const windows = [...src.matchAll(/new BrowserWindow\(\{([\s\S]*?)webPreferences/g)].map((m) => m[1]!);
    expect(windows.length).toBeGreaterThan(2);
    expect(windows.filter((w) => !/icon: appIcon/.test(w)), "BrowserWindow without icon: appIcon").toEqual([]);
    expect(src).toMatch(/setAppUserModelId\(winDetails\.appId\)/);
    // Third regression: the window had the bolt but the taskbar button showed electron.exe's atom. Every window must
    // carry the bolt as its relaunch icon too.
    expect(src).toMatch(/app\.on\("browser-window-created", \(_e, w\) => w\.setAppDetails\(winDetails\)\)/);
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
    expect(src).toMatch(/runSmoke\(win!, log, appIcon[,)]/);
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

describe("bridged tool sets", () => {
  // A tool set on the bridge reaches ACP harnesses only through a bundled forwarder of the same name.
  it("every bridge tool set has a bundled forwarder built by electron-vite", () => {
    const sets = [...read("src/main/bridge.ts").match(/set: ((?:"[a-z]+"(?: \| )?)+);/)![1]!.matchAll(/"([a-z]+)"/g)].map((m) => m[1]!);
    expect(sets).toContain("vector");
    const vite = read("electron.vite.config.ts");
    for (const set of sets) {
      const dir = set === "core" ? "flashmaster-core" : set;
      expect(vite, `mcp-${dir} entry`).toContain(`"mcp-${dir}": resolve(import.meta.dirname, "mcp-servers/${dir}/server.ts")`);
      if (set !== "core") expect(read(`mcp-servers/${dir}/server.ts`)).toContain(`runForwarder("${set}"`);
    }
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

describe("quiet UI", () => {
  // The minimal pass turned labelled buttons into icons; each must still say what it does (tooltip + screen-reader text),
  // and hiding the header's field captions must not hide the model field that sits in the same <label>.
  it("icon-only message and header actions keep a tooltip and a hidden text label", () => {
    const tsx = read("src/renderer/views/ChatView.tsx");
    const actions = tsx.slice(tsx.indexOf('<div className="msg-actions">'), tsx.indexOf("emoji-picker"));
    const buttons = actions.split("\n").filter((l) => l.includes("<button"));
    expect(buttons.length).toBeGreaterThan(4);
    for (const b of buttons) expect(b, "msg action without a title").toMatch(/title=/);
    for (const label of ["Reply", "Edit", "Retry", "Progress", "Artifacts"]) expect(tsx).toContain(`<span className="sr-only">${label}</span>`);
    expect(read("src/renderer/styles.css")).toMatch(/^\.sr-only \{[^}]*clip: rect\(0 0 0 0\)/m);
  });
  it("hides only the caption span in header fields, never the model input wrapper", () => {
    const css = read("src/renderer/styles.css");
    expect(css).not.toMatch(/^\.ctl > span \{/m);
    expect(css).toMatch(/^\.ctl > span:first-child:not\(\.model-input-wrap\) \{/m);
  });
});

describe("hung tool calls", () => {
  // Running tool calls in a streaming reply offer ■, which stops that call only (not the whole agent).
  it("the chat passes a reply's id and live state down to its tool calls, and the watchdog checks timeouts", () => {
    expect(read("src/renderer/views/ChatView.tsx")).toMatch(/<ReplyBody [^>]*messageId=\{m\.id\} live=\{m\.status === "streaming"\}/);
    expect(read("src/renderer/components/ReplyBody.tsx")).toMatch(/<ToolRuns [^>]*messageId=\{messageId\} live=\{live\}/);
    expect(read("src/renderer/components/ToolRuns.tsx")).toContain("api().stopToolCall(");
    expect(read("src/main/index.ts")).toMatch(/setInterval\(\(\) => \{[^}]*orch\.checkToolTimeouts\(\)/);
  });
});

describe("scannable coordinator replies", () => {
  // The coordinator is told to put long notes under "## Details", which the chat folds; both sides must agree.
  it("the coordinator prompt asks for the Details section the renderer folds, and agent prose goes through ReplyText", () => {
    const prompt = read("agents/flashmaster.md");
    expect(prompt).toContain("`## Details`");
    expect(read("src/shared/replyParts.ts")).toMatch(/const DETAILS = .*Details/);
    expect(read("src/renderer/components/ReplyBody.tsx")).toContain("<ReplyText ");
  });
  // Organised team: the cap and the wake-up are the app's job, so they work on every harness.
  it("delegations go through the team cap, and finished specialists report back through finishDelegated", () => {
    const orch = read("src/main/orchestrator.ts");
    expect(orch).toContain("await this.waitForTeamSlot(");
    expect(orch).not.toMatch(/this\.finishWaiters\(live, (compact|`error)/); // turn ends must also wake the coordinator
  });
  // End to end, always with feedback: a turn reports back only once its task is over (not after its first TOOL lines),
  // through the recovery check; questions and blockers are cards with an answer path the renderer offers.
  it("turns report through recoverOrReport after the continuations, and needs-you cards can be answered from the chat", () => {
    const orch = read("src/main/orchestrator.ts");
    const tail = orch.slice(orch.indexOf("let next: (() => void) | null = null;"), orch.indexOf("private recoverOrReport("));
    expect(tail.indexOf("if (next) { next(); return; }")).toBeGreaterThan(0);
    expect(tail.indexOf("this.recoverOrReport(live, t, outcome)")).toBeGreaterThan(tail.indexOf("if (next) { next(); return; }"));
    expect(orch.slice(orch.indexOf("private async turn("), orch.indexOf("let next: (() => void) | null = null;"))).not.toContain("this.finishDelegated(");
    expect(read("src/main/tools.ts")).toContain('name: "ask_user"');
    expect(read("src/renderer/views/ChatView.tsx")).toContain("<AskCard m={m} />");
    expect(read("src/renderer/components/AskCard.tsx")).toContain("api().answerAsk(");
  });
  // Mari doesn't babysit agents: a delegated specialist's question goes to its coordinator, which untangles it first.
  it("delegated specialists never raise a needs-you card themselves; the coordinator is told to untangle first", () => {
    const orch = read("src/main/orchestrator.ts");
    for (const fn of ["private surfaceSaid(", "  askUser("]) {
      const body = orch.slice(orch.indexOf(fn), orch.indexOf("\n  }\n", orch.indexOf(fn)));
      expect(body.indexOf("if (l.parentAgentId && l.depth > 0)"), fn).toBeGreaterThan(0);
      expect(body.indexOf("if (l.parentAgentId && l.depth > 0)"), fn).toBeLessThan(body.indexOf("this.raiseAsk("));
    }
    const give = orch.slice(orch.indexOf("private recoverOrReport("), orch.indexOf("private coordinatorFeedback("));
    expect(give).not.toContain("this.raiseAsk(");
    expect(read("src/main/context.ts")).toMatch(/COORDINATOR_FEEDBACK_RULES = `## You run the crew/);
  });
});

describe("EWM source control changes stay inside repository workspaces", () => {
  // 2026-11-17 Mari asked for read-only source; 2026-11-19 for full source control with the same credentials. The rules:
  // the REST client (scm.ts) still only reads; every change goes through ScmWriter.change(), which refuses in read-only
  // mode; deliver needs the "Agents may deliver" setting and the stream name as confirm.
  it("the REST SCM client only sends GET requests and only lists through the CLI", () => {
    const scm = read("src/main/scm.ts");
    expect(scm).not.toMatch(/request\(\s*"(POST|PUT|PATCH|DELETE)"/);
    const cliCalls = [...scm.matchAll(/\[\s*"(\w+)",\s*"(\w+)"/g)].map((m) => `${m[1]} ${m[2]}`);
    expect(cliCalls.every((c) => c === "list remotefiles")).toBe(true);
    expect(read("src/main/scm-cli.ts")).not.toMatch(/checkin|deliver|"(load|share)"/);
  });
  it("every changing SCM command goes through the read-only guard, and deliver checks the setting first", () => {
    const w = read("src/main/scm-write.ts");
    expect([...w.matchAll(/\.run\(/g)].length).toBe(2); // read() and change() only
    const reads = [...w.matchAll(/this\.read\(\[([^\]]*)\]/g)].map((m) => m[1]!.replace(/[\s"]/g, ""));
    expect(reads.every((c) => /^(list,(workspaces|changesets|changes)|show,status)$/.test(c)), reads.join(" | ")).toBe(true);
    const change = w.slice(w.indexOf("private async change("), w.indexOf("private async notStream("));
    expect(change.indexOf("this.d.readOnly()")).toBeGreaterThan(0);
    expect(change.indexOf("this.d.readOnly()")).toBeLessThan(change.indexOf(".run("));
    const deliver = w.slice(w.indexOf("async deliver("), w.indexOf("async discard("));
    expect(deliver.indexOf("this.d.allowDeliver()")).toBeLessThan(deliver.indexOf("this.change("));
    expect(deliver).toMatch(/confirm[^;]*!== st/);
    expect(read("src/shared/settings.ts")).toMatch(/scm: \{ enabled: false, cliPath: "", deliver: false \}/);
  });
});

describe("worktree placement", () => {
  // Mari: new worktrees go in the project's own .wt folder; without a project agents work in C:\Data\.wt (a setting).
  it("agent worktrees are made in <project>/.wt, never in the app's data folder", () => {
    const orch = read("src/main/orchestrator.ts");
    expect(orch).toMatch(/projectWorktreeDir\(projectPath, /);
    expect(orch).not.toMatch(/"worktrees"/);
    expect(read("src/main/worktree.ts")).toMatch(/platform === "win32" \? "C:\\\\Data\\\\.wt"/);
    expect(read("src/main/index.ts")).toMatch(/noProjectDir: \(\) => noProjectFolder\(settings\.get\(\)\.agents\.noProjectFolder/);
  });
});

describe("local release script", () => {
  // scripts/release.py publishes a finished release from Mari's machine; publishing pushes the tag, which starts
  // release.yml. The workflow must see that release.py already uploaded latest.json and not rebuild over it.
  it("release.yml skips the rebuild for a release that already carries latest.json", () => {
    const wf = read(".github/workflows/release.yml"); // CRLF on Windows checkouts
    expect(wf).toMatch(/grep -qx latest\.json/);
    expect(wf).toMatch(/needs: guard\r?\n\s+if: needs\.guard\.outputs\.published-locally != 'true'/);
  });
  it("release.py runs only on the Python standard library and its tests run in CI", () => {
    const imports = [...read("scripts/release.py").matchAll(/^(?:from|import) (\w+)/gm)].map((m) => m[1]!);
    const stdlib = new Set(["__future__", "argparse", "hashlib", "json", "os", "re", "shutil", "ssl", "subprocess", "sys",
      "threading", "time", "urllib", "collections", "dataclasses", "pathlib", "typing", "ctypes"]);
    expect(imports.filter((m) => !stdlib.has(m)), "third-party import in scripts/release.py").toEqual([]);
    expect(read("scripts/run-pytest.mjs")).toMatch(/"scripts\/tests"/);
  });
});

describe("Flash server deploys on a stock Ubuntu", () => {
  // install.sh copies flash-server/server to the box and runs it with the system python3: nothing is pip-installed there.
  // The admin GUI and the app may only depend on the HTTP contract, and its tests run in CI with the other Python tests.
  it("the server and the release publisher use only the Python standard library", () => {
    const stdlib = new Set(["__future__", "argparse", "base64", "contextlib", "dataclasses", "datetime", "difflib", "email", "errno",
      "functools", "hashlib", "hmac", "http", "io", "itertools", "json", "logging", "mimetypes", "os", "pathlib", "posixpath", "re",
      "secrets", "shutil", "signal", "socket", "socketserver", "sqlite3", "stat", "sys", "tarfile", "tempfile", "threading", "time",
      "typing", "urllib", "uuid", "importlib", "collections", "flashserver", "string", "math", "platform", "traceback", "copy", "enum", "textwrap"]);
    const files = [...readdirSync(join(root, "flash-server/server/flashserver")).filter((f) => f.endsWith(".py")).map((f) => `flash-server/server/flashserver/${f}`),
      "flash-server/tools/publish_release.py"];
    for (const f of files) {
      const mods = [...read(f).matchAll(/^\s*(?:from|import) (\w+)/gm)].map((m) => m[1]!).filter((m) => m !== "." );
      expect(mods.filter((m) => !stdlib.has(m)), `third-party import in ${f}`).toEqual([]);
    }
    expect(read("scripts/run-pytest.mjs")).toMatch(/"flash-server"/);
  });
});

describe("Flash server credentials", () => {
  // flash-server/API.md: the server token (Bearer) and the GitHub token belong to different hosts. A token sent to the
  // wrong host leaks it, so every update request is checked against the host it goes to — server up and server down.
  it("the updater sends the server token only to the server and the GitHub token only to the repository feed", async () => {
    const { Updater } = await import("../src/main/updater");
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const exe = Buffer.from("MZ");
    const sha = createHash("sha256").update(exe).digest("hex");
    const m = JSON.stringify({ version: "9.0.0", files: [{ kind: "setup", name: "TheFlashMaster-9.0.0-x64-setup.exe", sha256: sha, size: exe.length }] });
    const rel = JSON.stringify({ tag_name: "v9.0.0", assets: [{ name: "latest.json", url: "https://gh.corp/api/v3/a/1" }, { name: "TheFlashMaster-9.0.0-x64-setup.exe", url: "https://gh.corp/api/v3/a/2" }] });
    for (const serverUp of [true, false]) {
      const calls: { url: string; auth?: string }[] = [];
      const fetch = async (url: string, init?: { headers?: Record<string, string> }) => {
        calls.push({ url, auth: init?.headers?.Authorization });
        const r = (s: number, b: string | Buffer) => ({ ok: s < 400, status: s, headers: { get: () => "application/json" }, text: async () => b.toString(), arrayBuffer: async () => new Uint8Array(Buffer.from(b)).buffer, body: null });
        if (url.startsWith("http://flash.corp")) return serverUp ? r(200, url.endsWith("latest.json") ? m : exe) : r(502, "{}");
        return url.endsWith("/releases/latest") ? r(200, rel) : url.endsWith("/a/1") ? r(200, m) : r(200, exe);
      };
      const u = new Updater({ fetch, version: "0.1.0", mode: "installer", dataDir: mkdtempSync(join(tmpdir(), "inv-")), emit: () => {}, spawnDetached: () => {}, quit: () => {},
        feed: () => ({ url: "https://gh.corp/team/tfm", channel: "stable", token: "GH-SECRET", server: { url: "http://flash.corp", token: "FS-SECRET" } }) });
      await u.check();
      await u.download();
      expect(calls.length).toBeGreaterThanOrEqual(2);
      for (const c of calls) {
        if (c.url.startsWith("http://flash.corp/")) expect(c.auth, c.url).toBe("Bearer FS-SECRET");
        else expect(c.auth ?? "", c.url).not.toMatch(/FS-SECRET/);
        if (c.url.startsWith("http://flash.corp/")) expect(c.auth ?? "", c.url).not.toMatch(/GH-SECRET/);
      }
    }
  });

  it("the marketplace sends a source's token only to URLs under that source", () => {
    const src = read("src/main/marketplace.ts");
    expect(src).toMatch(/const own = !!src\.token && url\.startsWith\(`\$\{normaliseUrl\(src\.url\)\}\/`\)/);
    expect(src).toMatch(/\.\.\.\(own \? \{ Authorization: `Bearer \$\{src\.token\}` \} : \{\}\)/);
  });

  it("build-index.mjs and the app accept the same script and file names", async () => {
    const { SCRIPT_RE, FILE_RE } = await import("../src/main/marketplace");
    const bi = read("scripts/marketplace/build-index.mjs");
    expect(bi).toContain(`const SCRIPT_RE = /${SCRIPT_RE.source}/;`);
    expect(bi).toContain(`const FILE_RE = /${FILE_RE.source}/;`);
  });
});

describe("chat images", () => {
  it("the renderer only loads images from the app and data: URLs (local files go through api.readImage)", () => {
    const csp = /Content-Security-Policy" content="([^"]+)"/.exec(read("src/renderer/index.html"))?.[1] ?? "";
    expect(csp).toMatch(/img-src 'self' data:(;|$)/);
    expect(read("src/renderer/components/Markdown.tsx")).toContain("hydrateImages");
  });
});
