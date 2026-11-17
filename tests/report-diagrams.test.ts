import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../src/main/db";
import { buildTools } from "../src/main/tools";
import { Bridge } from "../src/main/bridge";
import { Orchestrator } from "../src/main/orchestrator";
import { HarnessRegistry } from "../src/main/harness/registry";
import { MockAdapter, MockSession } from "../src/main/harness/mock";
import { loadRoles } from "../src/main/roles";
import { HTML_REPORT_RULES, rolePrefix } from "../src/main/context";
import { checkReports } from "../src/main/report-check";
import { mkdirSync, utimesSync } from "node:fs";
import { DIAGRAM_KINDS, renderDiagram, wrap } from "../src/shared/diagrams";
import { DEFAULT_SETTINGS, mergeSettings, type Settings } from "../src/shared/settings";

const SPECS: Record<string, unknown> = {
  ishikawa: { problem: "Brake light flickers at cold start", categories: { Requirements: ["No cold-start timing req (confirmed)"], Design: ["Shared PWM timer (plausible)"] } },
  flowchart: { nodes: [{ id: "a", label: "Ignition on", kind: "start" }, { id: "b", label: "Supply < 9 V?", kind: "decision" }, { id: "c", label: "PWM reset" }, { id: "d", label: "Flicker", kind: "end" }],
    edges: [{ from: "a", to: "b" }, { from: "b", to: "c", label: "yes" }, { from: "c", to: "d" }, { from: "c", to: "b", label: "retry" }] },
  timeline: { events: [{ when: "Day 1", label: "Field report" }, { when: "Day 3", label: "Reproduced at -20 °C", detail: "Bench, 8.7 V" }] },
  sequence: { participants: ["BCM", "Lamp driver"], messages: [{ from: "BCM", to: "Lamp driver", label: "PWM on" }, { from: "Lamp driver", to: "BCM", label: "fault", reply: true }] },
};

describe("diagram rendering for HTML reports", () => {
  it.each(DIAGRAM_KINDS)("%s renders standalone, offline SVG", (kind) => {
    const svg = renderDiagram(kind, SPECS[kind]);
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain("<style>"); // styles embedded: renders the same in any HTML file
    expect(svg).not.toMatch(/<script|href=|https?:\/\/(?!www\.w3\.org\/2000\/svg)/); // nothing loaded from the web
  });

  it("escapes text and accepts a JSON string spec", () => {
    const svg = renderDiagram("timeline", JSON.stringify({ events: [{ when: "<b>", label: "x & <script>" }] }));
    expect(svg).not.toContain("<script>");
    expect(svg).toContain("&lt;script&gt;");
    expect(() => renderDiagram("pie", {})).toThrow(/unknown diagram kind/);
  });

  it("wraps long labels within the line limit", () => {
    expect(wrap("one two three four five six seven", 10, 2)).toEqual(["one two", "three fou…"]);
  });
});

describe("diagram_svg tool", () => {
  const setup = (readOnly = false) => {
    const dir = mkdtempSync(join(tmpdir(), "report-"));
    const bridge = new Bridge();
    bridge.register(buildTools({ db: new Db(":memory:"), orch: { agentWorkDir: () => dir } as unknown as Orchestrator, roles: () => [], jazz: () => null,
      emitTask: () => {}, readOnly: () => readOnly }));
    return { dir, bridge };
  };

  it("inserts the diagram at its marker in the report and returns only a confirmation", async () => {
    const { dir, bridge } = setup();
    writeFileSync(join(dir, "rca.html"), "<html><body><h2>Causes</h2><!-- diagram:causes --><p>end</p></body></html>");
    const r = await bridge.call("diagram_svg", { kind: "ishikawa", spec: SPECS.ishikawa, file: "rca.html", marker: "causes" }, "a1") as Record<string, unknown>;
    expect(r).toMatchObject({ ok: true, file: "rca.html" });
    expect(r).not.toHaveProperty("svg");
    const html = readFileSync(join(dir, "rca.html"), "utf8");
    expect(html).toMatch(/<h2>Causes<\/h2><figure class="diagram-figure"><svg class="diagram fishbone"[\s\S]*<\/svg><\/figure><p>end<\/p>/);
  });

  it("returns the SVG without a file, and refuses files outside the work folder, missing markers and read-only mode", async () => {
    const { dir, bridge } = setup();
    expect((await bridge.call("diagram_svg", { kind: "sequence", spec: SPECS.sequence }, "a1") as { svg: string }).svg).toContain("<svg");
    writeFileSync(join(dir, "r.html"), "<p>no marker</p>");
    await expect(bridge.call("diagram_svg", { kind: "timeline", spec: SPECS.timeline, file: "r.html", marker: "t" }, "a1")).rejects.toThrow(/not found/);
    await expect(bridge.call("diagram_svg", { kind: "timeline", spec: SPECS.timeline, file: "../x.html", marker: "t" }, "a1")).rejects.toThrow();
    const ro = setup(true);
    writeFileSync(join(ro.dir, "r.html"), "<!-- diagram:t -->");
    await expect(ro.bridge.call("diagram_svg", { kind: "timeline", spec: SPECS.timeline, file: "r.html", marker: "t" }, "a1")).rejects.toThrow(/read-only/);
  });
});

describe("mandatory diagrams in agents' instructions", () => {
  afterEach(() => vi.restoreAllMocks());
  const until = async (fn: () => boolean, ms = 8000) => {
    const t = Date.now();
    while (!fn()) { if (Date.now() - t > ms) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 10)); }
  };
  async function firstPrompt(reportDiagrams?: boolean): Promise<string> {
    const db = new Db(":memory:");
    const settings = mergeSettings(DEFAULT_SETTINGS, { general: { defaultHarness: "mock" }, agents: { toolMode: "mcp", ...(reportDiagrams === undefined ? {} : { reportDiagrams }) } }) as Settings;
    const roles = loadRoles(join(__dirname, "..", "agents"), "/none");
    const prompts: string[] = [];
    const orig = MockSession.prototype.prompt;
    vi.spyOn(MockSession.prototype, "prompt").mockImplementation(function (this: MockSession, text, atts) { prompts.push(text); return orig.call(this, text, atts); });
    const orch = new Orchestrator({ db, harnesses: new HarnessRegistry([new MockAdapter(1)]), settings: () => settings, roles: () => roles,
      skills: () => [], emit: () => undefined, mcpServersFor: () => [], homeDir: tmpdir(), dataDir: mkdtempSync(join(tmpdir(), "rd-data-")) });
    const p = db.createProject("p", mkdtempSync(join(tmpdir(), "rd-proj-")));
    const chat = db.createChat({ projectId: p.id, title: "c", kind: "project", agentRole: "flashmaster" });
    await orch.sendUserMessage(chat.id, "Write an HTML report on the brake light flicker", null);
    await until(() => db.listAgents({}).some((x) => x.status === "idle"));
    return prompts[0]!;
  }

  it("is on by default and tells every agent to put offline diagrams (Ishikawa for root causes) in HTML files", async () => {
    expect(DEFAULT_SETTINGS.agents.reportDiagrams).toBe(true);
    expect(HTML_REPORT_RULES).toMatch(/Ishikawa/);
    expect(HTML_REPORT_RULES).toMatch(/inline <svg>/);
    expect(HTML_REPORT_RULES).toMatch(/offline/);
    expect(HTML_REPORT_RULES).toContain("diagram_svg");
    expect(await firstPrompt()).toContain(HTML_REPORT_RULES);
  });

  it("can be turned off in Settings → Agents", async () => {
    expect(await firstPrompt(false)).not.toContain(HTML_REPORT_RULES);
  });
});

describe("deliverable check (enforced by the app, on every harness)", () => {
  const base = { since: Date.now() - 5000, text: "", diagrams: true, artifacts: [] as { id: string; title: string; content: string }[] };
  const proj = () => mkdtempSync(join(tmpdir(), "chk-"));

  it("a report role that wrote only a .md fails; an HTML report with an Ishikawa passes", () => {
    const dir = proj();
    writeFileSync(join(dir, "analysis.md"), "# RCA\nNOW: ...");
    const miss = checkReports({ ...base, workDir: dir, requires: ["html-report", "ishikawa"] });
    expect(miss.problems.join(" ")).toMatch(/No HTML report/);
    mkdirSync(join(dir, "reports"));
    writeFileSync(join(dir, "reports", "rca.html"), `<html><body>${renderDiagram("ishikawa", SPECS.ishikawa)}</body></html>`);
    expect(checkReports({ ...base, workDir: dir, requires: ["html-report", "ishikawa"] })).toEqual({ reports: ["reports/rca.html"], problems: [] });
  });

  it("flags HTML without diagrams, and a report without an Ishikawa", () => {
    const dir = proj();
    writeFileSync(join(dir, "report.html"), "<html><body><h1>Findings</h1><table></table></body></html>");
    const r = checkReports({ ...base, workDir: dir, requires: ["html-report", "ishikawa"] });
    expect(r.problems.join(" ")).toMatch(/no diagrams: report.html/);
    expect(r.problems.join(" ")).toMatch(/no Ishikawa/);
  });

  it("other agents are only checked on the .html files they point to; old files and web apps are left alone", () => {
    const dir = proj();
    writeFileSync(join(dir, "index.html"), "<html><body><div id=app></div></body></html>"); // a web app page edited in the turn
    writeFileSync(join(dir, "old.html"), "<html></html>");
    utimesSync(join(dir, "old.html"), new Date(2020, 0, 1), new Date(2020, 0, 1));
    expect(checkReports({ ...base, workDir: dir, requires: [] }).problems).toEqual([]);
    expect(checkReports({ ...base, workDir: dir, requires: [], text: "Report saved to index.html" }).problems.join(" ")).toMatch(/no diagrams: index.html/);
    expect(checkReports({ ...base, workDir: dir, requires: [], diagrams: false, text: "see index.html" }).problems).toEqual([]);
    expect(checkReports({ ...base, workDir: dir, requires: ["html-report"] }).reports).toEqual(["index.html"]); // old.html is not from this turn
  });

  it("without a project folder, an HTML artifact with diagrams counts", () => {
    const art = { id: "a1", title: "RCA", content: `<!doctype html><html><body>${renderDiagram("ishikawa", SPECS.ishikawa)}</body></html>` };
    expect(checkReports({ ...base, workDir: null, requires: ["html-report", "ishikawa"], artifacts: [art] }).problems).toEqual([]);
    expect(checkReports({ ...base, workDir: null, requires: ["html-report"] }).problems).toHaveLength(1);
  });

  it("built-in instructions win over project / harness instruction files in both instruction modes", () => {
    const role = loadRoles(join(__dirname, "..", "agents"), "/none").find((r) => r.name === "rca-analyst")!;
    expect(role.requires).toEqual(["html-report", "ishikawa"]);
    expect(rolePrefix(role, "/p", { clean: true })).toMatch(/take precedence over any other instruction files/);
    expect(rolePrefix(role, "/p", { clean: false })).toMatch(/where they conflict with these instructions, these win/);
  });
});

describe("orchestrator sends an agent back until its report is delivered", () => {
  afterEach(() => vi.restoreAllMocks());
  const until = async (fn: () => boolean, ms = 10000) => {
    const t = Date.now();
    while (!fn()) { if (Date.now() - t > ms) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 10)); }
  };

  it("an rca-analyst turn in a project without an HTML report gets a fix turn; the report then exists with an Ishikawa", async () => {
    const db = new Db(":memory:");
    const settings = mergeSettings(DEFAULT_SETTINGS, { general: { defaultHarness: "mock" }, agents: { toolMode: "mcp" } }) as Settings;
    const roles = loadRoles(join(__dirname, "..", "agents"), "/none");
    const prompts: string[] = [];
    const orig = MockSession.prototype.prompt;
    vi.spyOn(MockSession.prototype, "prompt").mockImplementation(function (this: MockSession, text, atts) { prompts.push(text); return orig.call(this, text, atts); });
    const orch = new Orchestrator({ db, harnesses: new HarnessRegistry([new MockAdapter(1)]), settings: () => settings, roles: () => roles,
      skills: () => [], emit: () => undefined, mcpServersFor: () => [], homeDir: tmpdir(), dataDir: mkdtempSync(join(tmpdir(), "fix-data-")) });
    const dir = mkdtempSync(join(tmpdir(), "fix-proj-"));
    const p = db.createProject("p", dir);
    const chat = db.createChat({ projectId: p.id, title: "c", kind: "project", agentRole: "flashmaster" });
    await orch.sendUserMessage(chat.id, "@rca-analyst Analyse the brake light flicker", null);
    await until(() => prompts.length >= 2 && db.listAgents({}).every((x) => x.status === "idle"));
    expect(prompts[1]).toMatch(/TheFlashMaster checked your result/);
    expect(prompts[1]).toMatch(/No HTML report was written/);
    expect(readFileSync(join(dir, "reports", "rca-mock.html"), "utf8")).toContain("diagram fishbone");
    await new Promise((r) => setTimeout(r, 200));
    expect(prompts).toHaveLength(2); // satisfied: no third round
    const notes = db.listMessages(chat.id, null).filter((m) => m.author === "system").map((m) => m.content).join("\n");
    expect(notes).toMatch(/sent back to finish them/);
  });
});
