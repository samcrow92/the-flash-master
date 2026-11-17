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
import { HTML_REPORT_RULES } from "../src/main/context";
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
