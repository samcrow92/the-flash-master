import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RESULT_DIRS, TRACE_DIR, buildMatrix, codeTagSource, collect, evidenceReport, fileSource, junitSource, matrixText, parseCsv, parseJunit, parseReqif, reqifSource, splitDirs,
} from "../src/main/traceability";
import { buildInbox } from "../src/main/inbox";
import type { AgentRun, CheckRun, Message, TaskPlan, TraceItem } from "../src/shared/types";

const project = () => {
  const root = mkdtempSync(join(tmpdir(), "fm-trace-"));
  const put = (rel: string, text: string) => { mkdirSync(join(root, rel, ".."), { recursive: true }); writeFileSync(join(root, rel), text); };
  return { root, put };
};

const REQIF = `<?xml version="1.0"?><REQ-IF><CORE-CONTENT><REQ-IF-CONTENT><SPEC-TYPES><SPEC-OBJECT-TYPE>
<SPEC-ATTRIBUTES><ATTRIBUTE-DEFINITION-STRING IDENTIFIER="ad-id" LONG-NAME="ReqIF.ForeignID"/>
<ATTRIBUTE-DEFINITION-XHTML IDENTIFIER="ad-text" LONG-NAME="ReqIF.Text"/></SPEC-ATTRIBUTES></SPEC-OBJECT-TYPE></SPEC-TYPES>
<SPEC-OBJECTS><SPEC-OBJECT IDENTIFIER="so-1"><VALUES>
<ATTRIBUTE-VALUE-STRING THE-VALUE="SYS-7"><DEFINITION><ATTRIBUTE-DEFINITION-STRING-REF>ad-id</ATTRIBUTE-DEFINITION-STRING-REF></DEFINITION></ATTRIBUTE-VALUE-STRING>
<ATTRIBUTE-VALUE-XHTML><DEFINITION><ATTRIBUTE-DEFINITION-XHTML-REF>ad-text</ATTRIBUTE-DEFINITION-XHTML-REF></DEFINITION>
<THE-VALUE><xhtml:div>The ECU shall wake on CAN &amp; LIN</xhtml:div></THE-VALUE></ATTRIBUTE-VALUE-XHTML>
</VALUES></SPEC-OBJECT></SPEC-OBJECTS></REQ-IF-CONTENT></CORE-CONTENT></REQ-IF>`;

const JUNIT = `<testsuites><testsuite name="s">
<testcase classname="wake" name="test_wake_on_can"/>
<testcase classname="wake" name="test_sleep_timeout"><failure message="timeout">late</failure></testcase>
<testcase name="test_skipped"><skipped/></testcase>
</testsuite></testsuites>`;

describe("trace sources", () => {
  it("parses CSV with quotes and semicolons, and tells tests from requirements by the verifies column", () => {
    expect(parseCsv('ID;Title\nREQ-1;"Wake; on ""CAN"""\n')).toEqual([{ id: "REQ-1", title: 'Wake; on "CAN"' }]);
    const { root, put } = project();
    put(`${TRACE_DIR}/reqs.csv`, "ID,Title\nREQ-1,Wake on CAN\nREQ-2,Sleep after 5 s\n");
    put(`${TRACE_DIR}/tests.json`, JSON.stringify({ tests: [{ id: "HIL-3", title: "hil wake", verifies: ["REQ-1"] }] }));
    const items = fileSource.load(root);
    expect(items.map((i) => [i.id, i.kind])).toEqual([["REQ-1", "requirement"], ["REQ-2", "requirement"], ["HIL-3", "test"]]);
    expect(items[2]!.links).toEqual(["REQ-1"]);
  });

  it("reads requirements from a ReqIF export, using the foreign id and the text", () => {
    const [r] = parseReqif(REQIF, "x.reqif");
    expect(r).toMatchObject({ id: "SYS-7", kind: "requirement", title: "The ECU shall wake on CAN & LIN" });
    const { root, put } = project();
    put(`${TRACE_DIR}/sys.reqif`, REQIF);
    expect(reqifSource.load(root).map((i) => i.id)).toEqual(["SYS-7"]);
  });

  it("links a requirement tag in test code to the nearest test declaration", () => {
    const { root, put } = project();
    put("tests/test_wake.py", [
      "import pytest", "",
      "# @req REQ-1, REQ-9", "def test_wake_on_can():", "    assert True", "",
      "def test_sleep_timeout():", "    # Verifies: REQ-2", "    assert True",
    ].join("\n"));
    put("src/helpers.py", "# @req REQ-5\ndef test_x(): pass\n");
    const tests = codeTagSource().load(root);
    expect(tests.map((t) => [t.title, t.links])).toEqual([["test_wake_on_can", ["REQ-1", "REQ-9"]], ["test_sleep_timeout", ["REQ-2"]]]);
    expect(tests[0]!.where).toBe("tests/test_wake.py:4");
  });

  it("reads JUnit outcomes", () => {
    expect(parseJunit(JUNIT, "r.xml").map((r) => [r.id, r.outcome])).toEqual([
      ["wake.test_wake_on_can", "passed"], ["wake.test_sleep_timeout", "failed"], ["test_skipped", "skipped"]]);
    const { root, put } = project();
    put("test-results/junit.xml", JUNIT);
    put("test-results/other.xml", "<project/>");
    expect(junitSource().load(root)).toHaveLength(3);
    expect(splitDirs("")).toEqual(RESULT_DIRS);
    expect(splitDirs("out/junit; ci\nlogs")).toEqual(["out/junit", "ci", "logs"]);
  });
});

describe("matrix and evidence", () => {
  const req = (id: string): TraceItem => ({ id, kind: "requirement", title: `req ${id}`, source: "csv", links: [] });
  const test = (title: string, links: string[]): TraceItem => ({ id: `tests/t.py::${title}`, kind: "test", title, source: "code tags", links });
  const items = [
    req("REQ-1"), req("REQ-2"), req("REQ-3"), req("REQ-4"),
    test("test_wake_on_can", ["REQ-1"]), test("test_sleep_timeout", ["req-2"]), test("test_never_run", ["REQ-3"]), test("test_orphan", ["REQ-99"]),
    ...parseJunit(JUNIT, "r.xml", 10),
  ];

  it("gives each requirement a status and lists orphan tests", () => {
    const m = buildMatrix("p", items, [], 1);
    expect(Object.fromEntries(m.rows.map((r) => [r.req.id, r.status]))).toEqual({ "REQ-1": "verified", "REQ-2": "failed", "REQ-3": "untested", "REQ-4": "uncovered" });
    expect(m.counts).toEqual({ verified: 1, failed: 1, untested: 1, uncovered: 1 });
    expect(m.orphanTests.map((t) => t.title)).toEqual(["test_orphan"]);
  });

  it("uses the newest result for a test", () => {
    const newer = parseJunit('<testsuite><testcase classname="wake" name="test_sleep_timeout"/></testsuite>', "new.xml", 20);
    const m = buildMatrix("p", [...items, ...newer], [], 1);
    expect(m.rows.find((r) => r.req.id === "REQ-2")!.status).toBe("verified");
  });

  it("keeps going when a source fails, and reports it", () => {
    const bad = { id: "bad", label: "Bad", load: () => { throw new Error("boom"); } };
    const ok = { id: "ok", label: "Ok", load: () => items };
    const m = collect("p", "/nowhere", [bad, ok], 1);
    expect(m.sources).toEqual([{ id: "bad", label: "Bad", items: 0, detail: "boom" }, { id: "ok", label: "Ok", items: items.length, detail: null }]);
    expect(m.rows).toHaveLength(4);
  });

  it("shows agents the gaps and writes an evidence report with diagrams", () => {
    const m = buildMatrix("p", items, [], Date.UTC(2026, 10, 20));
    const text = matrixText(m);
    expect(text).toContain("4 requirements: 1 verified, 1 failing");
    expect(text).not.toContain("REQ-1 [");
    expect(text).toContain("REQ-4 [uncovered]");
    expect(matrixText(m, "all")).toContain("REQ-1 [verified]");
    const html = evidenceReport(m, { project: "Body <ECU>", commit: "abc1234" });
    expect(html.match(/<svg/g)?.length).toBeGreaterThanOrEqual(2);
    expect(html).toContain("Body &lt;ECU&gt;");
    expect(html).toContain("25%");
    expect(html).toContain("abc1234");
  });
});

describe("review inbox", () => {
  const ask = { id: "m1", chatId: "c1", createdAt: 5, ask: { agentId: "a1", who: "Nova", question: "Which bus?" } } as unknown as Message;
  const plan = { id: "p1", chatId: "c1", messageId: "m2", agentId: "a0", title: "Port", tasks: [{}, {}], createdAt: 9 } as unknown as TaskPlan;
  const agent = (id: string, over: Partial<AgentRun> = {}) => ({ id, chatId: "c1", name: id, role: "coder", status: "done", branch: `fm/${id}`, worktree: "/w",
    startedAt: 1, endedAt: 2, ...over }) as AgentRun;
  const failing: CheckRun = { ok: false, head: "h", dirty: false, at: 3, results: [{ name: "test", ok: false } as CheckRun["results"][number]] };

  it("orders asks, plans, failing checks, then merges, and skips running or branchless agents", () => {
    const items = buildInbox({
      asks: [ask], plans: [plan],
      agents: [agent("x"), agent("y"), agent("busy", { status: "running" }), agent("plain", { branch: null, worktree: null })],
      checks: (id) => (id === "y" ? failing : null), chatTitle: () => "Chat",
    });
    expect(items.map((i) => i.id)).toEqual(["ask:m1", "plan:p1", "checks:y", "merge:x"]);
    expect(items[0]!.detail).toBe("Nova · Chat");
    expect(items[2]!.detail).toContain("test");
    expect(items[3]!.detail).toContain("no checks run");
  });
});
