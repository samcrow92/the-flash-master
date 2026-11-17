import { describe, expect, it } from "vitest";
import { EtmClient, QmDoc, addValidates, idOf, parseFeed, parseProjects, qmType, removeValidates, summarize, type JazzHttp } from "../src/main/etm";

const BASE = "https://alm/qm";
const SVC = `${BASE}/service/com.ibm.rqm.integration.service.IIntegrationService`;
const PROJECTS = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>${SVC}/projects/Body+%28QM%29</id><title type="text">Body (QM)</title></entry>
<entry><id>${SVC}/projects/Chassis</id><title>Chassis</title></entry></feed>`;
const TESTCASE = `<?xml version="1.0" encoding="UTF-8"?>
<ns2:testcase xmlns:ns2="http://jazz.net/xmlns/alm/qm/v0.1/" xmlns:ns4="http://purl.org/dc/elements/1.1/" xmlns:ns5="http://jazz.net/xmlns/alm/v0.1/">
<ns4:title>CAN bus-off recovery</ns4:title><ns2:webId>12</ns2:webId><ns4:description>Old text</ns4:description>
<ns5:state>com.ibm.rqm.planning.state.draft</ns5:state><ns5:owner>ana</ns5:owner><ns2:weight>3</ns2:weight>
<ns2:category term="Component" value="CAN"/><ns2:testscript href="${SVC}/resources/Body+%28QM%29/testscript/urn:com.ibm.rqm:testscript:7"/>
<ns2:customAttributes><ns2:customAttribute><ns2:name>ASIL</ns2:name><ns2:value>B</ns2:value></ns2:customAttribute></ns2:customAttributes>
</ns2:testcase>`;

type Call = { method: string; url: string; body?: string; headers: Record<string, string> };
type Resp = { status?: number; body?: string; headers?: Record<string, string> };
function fakeHttp(route: (c: Call) => Resp | undefined) {
  const calls: Call[] = [];
  const http: JazzHttp = {
    baseUrl: BASE,
    request: async (method, url, body, headers = {}) => {
      const c = { method, url, body, headers };
      calls.push(c);
      const r = route(c) ?? { status: 404, body: "" };
      const h = new Map(Object.entries(r.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
      const status = r.status ?? 200;
      return { status, ok: status < 400, headers: { get: (n: string) => h.get(n.toLowerCase()) ?? null }, text: async () => r.body ?? "" };
    },
  };
  return { http, calls };
}
const cfg = (projectArea = "Body (QM)", config = "") => () => ({ projectArea, config });
const projects = (c: Call): Resp | undefined => c.url.startsWith(`${SVC}/projects`) ? { body: PROJECTS } : undefined;

describe("ETM types and XML", () => {
  it("accepts friendly type names", () => {
    expect(qmType("Test Case")).toBe("testcase");
    expect(qmType("plans")).toBe("testplan");
    expect(qmType("tcer")).toBe("executionworkitem");
    expect(() => qmType("bogus")).toThrow(/unknown ETM type/);
  });

  it("reads ids from ETM URLs", () => {
    expect(idOf(`${SVC}/resources/X/testcase/urn:com.ibm.rqm:testcase:12`)).toBe("12");
    expect(idOf(`${SVC}/resources/X/testcase/my_slug`)).toBe("my_slug");
  });

  it("parses project areas with their URL alias", () => {
    expect(parseProjects(PROJECTS)).toEqual([{ title: "Body (QM)", alias: "Body+%28QM%29" }, { title: "Chassis", alias: "Chassis" }]);
  });

  it("summarises a test case compactly, links included, nested custom attributes not flattened", () => {
    const s = summarize("testcase", TESTCASE, "u");
    expect(s).toMatchObject({ id: "12", title: "CAN bus-off recovery", description: "Old text", state: "draft", owner: "ana", fields: { weight: "3" } });
    expect(s.links?.testscript?.[0]?.id).toBe("7");
    expect(s.fields?.customAttributes).toBeUndefined();
  });

  it("edits keep unknown elements and the server's own prefixes", () => {
    const d = new QmDoc(TESTCASE).set("title", "New <title>").set("description", "x").set("weight", "5");
    const out = d.toString();
    expect(out).toContain("<ns4:title>New &lt;title&gt;</ns4:title>");
    expect(out).toContain("<ns2:weight>5</ns2:weight>");
    expect(out).toContain('<ns2:category term="Component" value="CAN"/>');
    expect(out).toContain("<ns2:customAttributes>");
    expect(out.match(/<ns4:title>/g)).toHaveLength(1);
  });

  it("only touches top-level elements (a step description is not the script description)", () => {
    const script = `<testscript xmlns="http://jazz.net/xmlns/alm/qm/v0.1/"><title xmlns="http://purl.org/dc/elements/1.1/">S</title>
<steps xmlns="http://jazz.net/xmlns/alm/qm/v0.1/testscript/v0.1/"><step type="execution"><description><div xmlns="http://www.w3.org/1999/xhtml">Power on</div></description><expectedResult><div xmlns="http://www.w3.org/1999/xhtml">ECU boots</div></expectedResult></step></steps></testscript>`;
    const d = new QmDoc(script);
    expect(d.text("description")).toBeUndefined();
    expect(d.steps()).toEqual([{ description: "Power on", expected: "ECU boots" }]);
    d.setSteps([{ description: "Apply 9 V", expected: "Undervoltage DTC" }, { description: "Restore 13.5 V" }]);
    expect(d.steps()).toEqual([{ description: "Apply 9 V", expected: "Undervoltage DTC" }, { description: "Restore 13.5 V" }]);
    expect(d.toString().match(/<steps\b/g)).toHaveLength(1);
  });

  it("adds and removes suite members and plan links without duplicates", () => {
    const d = new QmDoc(`<testsuite xmlns="http://jazz.net/xmlns/alm/qm/v0.1/"><title xmlns="http://purl.org/dc/elements/1.1/">S</title></testsuite>`);
    d.addSuiteCase("https://alm/qm/x/testcase/urn:com.ibm.rqm:testcase:1").addSuiteCase("https://alm/qm/x/testcase/urn:com.ibm.rqm:testcase:2").addSuiteCase("https://alm/qm/x/testcase/urn:com.ibm.rqm:testcase:1");
    expect(d.suiteCases().map(idOf)).toEqual(["1", "2"]);
    d.removeSuiteCase((h) => idOf(h) === "1");
    expect(d.suiteCases().map(idOf)).toEqual(["2"]);
    const p = new QmDoc(`<testplan xmlns="http://jazz.net/xmlns/alm/qm/v0.1/"/>`).addLink("testcase", "u1").addLink("testcase", "u1").addLink("testcase", "u2");
    expect(p.hrefs("testcase")).toEqual(["u1", "u2"]);
  });

  it("parses feeds and their next page", () => {
    const f = parseFeed(`<feed><link rel="next" href="${SVC}/resources/B/testcase?page=1"/><entry><id>${SVC}/resources/B/testcase/urn:com.ibm.rqm:testcase:3</id><title>Door lock</title><updated>2026-11-01</updated></entry></feed>`);
    expect(f.items).toEqual([{ id: "3", title: "Door lock", updated: "2026-11-01" }]);
    expect(f.next).toContain("page=1");
  });

  it("adds a validatesRequirement link once and removes it", () => {
    const rdf = `<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:oslc_qm="http://open-services.net/ns/qm#"><oslc_qm:TestCase rdf:about="T"><x/></oslc_qm:TestCase></rdf:RDF>`;
    const one = addValidates(rdf, "T", "https://alm/rm/resources/R1");
    expect(one).toContain('<oslc_qm:validatesRequirement rdf:resource="https://alm/rm/resources/R1"/></oslc_qm:TestCase>');
    expect(addValidates(one, "T", "https://alm/rm/resources/R1")).toBe(one);
    expect(removeValidates(one, "https://alm/rm/resources/R1")).toBe(rdf);
  });
});

describe("ETM client", () => {
  it("lists with the project alias, follows pages and matches words", async () => {
    const { http, calls } = fakeHttp((c) => projects(c) ?? (c.url.includes("page=1")
      ? { body: `<feed><entry><id>x/testcase/urn:com.ibm.rqm:testcase:5</id><title>Wiper park position</title></entry></feed>` }
      : { body: `<feed><link rel="next" href="${SVC}/resources/Body+%28QM%29/testcase?page=1"/><entry><id>x/testcase/urn:com.ibm.rqm:testcase:4</id><title>Door lock</title></entry></feed>` }));
    const e = new EtmClient(http, cfg());
    expect(await e.list("testcase", { text: "wiper" })).toEqual([{ id: "5", title: "Wiper park position" }]);
    expect(calls.some((c) => c.url === `${SVC}/resources/Body+%28QM%29/testcase`)).toBe(true);
  });

  it("adds the configuration context to every request when set", async () => {
    const { http, calls } = fakeHttp((c) => projects(c) ?? { body: TESTCASE });
    await new EtmClient(http, cfg("Body (QM)", "https://alm/gc/configuration/9")).item("testcase", "12");
    expect(calls.every((c) => c.url.includes("oslc_config.context=https%3A%2F%2Falm%2Fgc%2Fconfiguration%2F9"))).toBe(true);
    expect(calls.at(-1)!.url).toContain("/testcase/urn:com.ibm.rqm:testcase:12?");
  });

  it("creates a test case linked to a script with POST and returns it from the Location", async () => {
    const loc = `${SVC}/resources/Body+%28QM%29/testcase/urn:com.ibm.rqm:testcase:12`;
    const { http, calls } = fakeHttp((c) => projects(c) ?? (c.method === "POST" ? { status: 201, headers: { Location: loc } } : c.url === loc ? { body: TESTCASE } : undefined));
    const tc = await new EtmClient(http, cfg()).create("testcase", { title: "CAN bus-off recovery", description: "d", addLinks: { testscript: ["7"] } });
    expect(tc.id).toBe("12");
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.url).toBe(`${SVC}/resources/Body+%28QM%29/testcase`);
    expect(post.body).toContain('<title xmlns="http://purl.org/dc/elements/1.1/">CAN bus-off recovery</title>');
    expect(post.body).toContain(`<testscript xmlns="http://jazz.net/xmlns/alm/qm/v0.1/" href="${SVC}/resources/Body+%28QM%29/testscript/urn:com.ibm.rqm:testscript:7"/>`);
    expect(post.headers["Content-Type"]).toMatch(/application\/xml/);
  });

  it("rejects links a type can't have, pointing requirements to qm_link_requirement", async () => {
    const { http } = fakeHttp((c) => projects(c));
    await expect(new EtmClient(http, cfg()).create("testcase", { title: "x", addLinks: { requirement: ["1"] } })).rejects.toThrow(/qm_link_requirement/);
    await expect(new EtmClient(http, cfg()).create("testcase", { title: "x", steps: [{ description: "a" }] })).rejects.toThrow(/testscript/);
  });

  it("updates read-modify-write with If-Match, keeping the rest of the XML", async () => {
    const { http, calls } = fakeHttp((c) => projects(c) ?? (c.method === "PUT" ? { status: 200 } : { body: TESTCASE, headers: { ETag: '"v3"' } }));
    await new EtmClient(http, cfg()).update("testcase", "12", { title: "Renamed" });
    const put = calls.find((c) => c.method === "PUT")!;
    expect(put.headers["If-Match"]).toBe('"v3"');
    expect(put.body).toContain("<ns4:title>Renamed</ns4:title>");
    expect(put.body).toContain("<ns2:customAttributes>");
    expect(put.body).toContain("urn:com.ibm.rqm:testscript:7");
  });

  it("records a result on the existing execution record of the test case in the plan", async () => {
    const tcUrl = `${SVC}/resources/Body+%28QM%29/testcase/urn:com.ibm.rqm:testcase:12`;
    const resLoc = `${SVC}/resources/Body+%28QM%29/executionresult/urn:com.ibm.rqm:executionresult:99`;
    const tcers = `<feed><entry><content><executionworkitem><webId>40</webId><testcase href="${SVC}/resources/B/testcase/urn:com.ibm.rqm:testcase:11"/><testplan href="x/testplan/urn:com.ibm.rqm:testplan:2"/></executionworkitem></content></entry>
<entry><content><executionworkitem><webId>41</webId><testcase href="${tcUrl}"/><testplan href="x/testplan/urn:com.ibm.rqm:testplan:2"/></executionworkitem></content></entry></feed>`;
    const { http, calls } = fakeHttp((c) => projects(c)
      ?? (c.url.startsWith(tcUrl) ? { body: TESTCASE } : undefined)
      ?? (c.url.includes("/executionworkitem?fields=") ? { body: tcers } : undefined)
      ?? (c.method === "POST" && c.url.endsWith("/executionresult") ? { status: 201, headers: { Location: resLoc } } : undefined)
      ?? (c.url.startsWith(resLoc) ? { body: `<executionresult xmlns="http://jazz.net/xmlns/alm/qm/v0.1/"><webId>99</webId><title xmlns="http://purl.org/dc/elements/1.1/">r</title><state xmlns="http://jazz.net/xmlns/alm/v0.1/">com.ibm.rqm.execution.common.state.failed</state></executionresult>` } : undefined));
    const r = await new EtmClient(http, cfg()).recordResult({ testcase: "12", testplan: "2", verdict: "Failed", notes: "DTC U0100 stayed active" });
    expect(r).toMatchObject({ record: "41", createdRecord: false, result: { id: "99", state: "failed" } });
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.body).toContain(">com.ibm.rqm.execution.common.state.failed</state>");
    expect(post.body).toContain("urn:com.ibm.rqm:executionworkitem:41");
    expect(post.body).toContain("DTC U0100 stayed active");
    expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/executionworkitem"))).toBe(false);
  });

  it("refuses unknown verdicts", async () => {
    const { http } = fakeHttp((c) => projects(c));
    await expect(new EtmClient(http, cfg()).recordResult({ testcase: "1", verdict: "green" })).rejects.toThrow(/verdict must be one of/);
  });

  it("links a requirement through OSLC QM with If-Match", async () => {
    const tc = `${BASE}/oslc_qm/contexts/_ctx1/resources/com.ibm.rqm.planning.VersionedTestCase/_tc12`;
    let rdf = `<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:oslc_qm="http://open-services.net/ns/qm#"><oslc_qm:TestCase rdf:about="${tc}"></oslc_qm:TestCase></rdf:RDF>`;
    const { http, calls } = fakeHttp((c) => {
      if (c.url.startsWith(`${BASE}/oslc_qm/catalog`)) return { body: `<oslc:ServiceProvider rdf:about="${BASE}/oslc_qm/contexts/_ctx1/services.xml"><dcterms:title>Body (QM)</dcterms:title></oslc:ServiceProvider>` };
      if (c.url.includes("VersionedTestCase?")) return { body: `<rdfs:member><oslc_qm:TestCase rdf:about="${tc}"/></rdfs:member>` };
      if (c.method === "PUT") { rdf = c.body!; return { status: 200 }; }
      if (c.url.startsWith(tc)) return { body: rdf, headers: { ETag: "e1" } };
      return undefined;
    });
    const links = await new EtmClient(http, cfg()).linkRequirement("12", "https://alm/rm/resources/_R1");
    expect(links).toEqual(["https://alm/rm/resources/_R1"]);
    const q = decodeURIComponent(calls.find((c) => c.url.includes("VersionedTestCase?"))!.url);
    expect(q).toContain("oslc.where=oslc:shortId=12");
    expect(calls.find((c) => c.method === "PUT")!.headers["If-Match"]).toBe("e1");
    await expect(new EtmClient(http, cfg()).linkRequirement("12", "REQ-1")).rejects.toThrow(/URL/);
  });
});
