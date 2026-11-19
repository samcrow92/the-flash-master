import { describe, expect, it } from "vitest";
import { RdfDoc, RmWriter, NS, attributeWrite, changesetUri, parseServices, parseShape, textToXhtml } from "../src/main/rm-write";
import type { JazzHttp } from "../src/main/etm";
import { buildTools } from "../src/main/tools";
import { Db } from "../src/main/db";
import type { Orchestrator } from "../src/main/orchestrator";

const RM = "https://alm/rm";
const CS = `${RM}/cm/changeset/_CS1`;
const COMP = `${RM}/cm/component/_C1`;
const SHAPE = `${RM}/types/_SysReq`;
const HEAD_SHAPE = `${RM}/types/_Heading`;
const PRIO = `${RM}/types/_prio`;
const HIGH = `${RM}/types/_prio#high`;
const LOW = `${RM}/types/_prio#low`;
const REQ = `${RM}/resources/_R42`;
const FACTORY = `${RM}/requirementFactory?projectURL=${encodeURIComponent(`${RM}/process/project-areas/_P1`)}`;
const QUERY = `${RM}/views?oslc.query=true&projectURL=${encodeURIComponent(`${RM}/process/project-areas/_P1`)}`;

const CHANGESET = `<rdf:RDF xmlns:rdf="${NS.rdf}" xmlns:dcterms="${NS.dcterms}" xmlns:oslc_config="${NS.oslc_config}">
<oslc_config:ChangeSet rdf:about="${CS}"><dcterms:title>SRS update for CAN</dcterms:title><oslc_config:component rdf:resource="${COMP}"/></oslc_config:ChangeSet></rdf:RDF>`;
const COMPONENT = `<rdf:RDF xmlns:rdf="${NS.rdf}" xmlns:dcterms="${NS.dcterms}" xmlns:oslc="${NS.oslc}">
<oslc_config:Component xmlns:oslc_config="${NS.oslc_config}" rdf:about="${COMP}"><dcterms:title>Body SRS</dcterms:title>
<oslc:serviceProvider rdf:resource="${RM}/oslc_rm/_P1/services.xml"/><process:projectArea xmlns:process="http://jazz.net/ns/process#" rdf:resource="${RM}/process/project-areas/_P1"/></oslc_config:Component></rdf:RDF>`;
const SERVICES = `<rdf:RDF xmlns:rdf="${NS.rdf}" xmlns:oslc="${NS.oslc}" xmlns:dcterms="${NS.dcterms}"><oslc:ServiceProvider rdf:about="${RM}/oslc_rm/_P1/services.xml"><oslc:service><oslc:Service>
<oslc:creationFactory><oslc:CreationFactory><dcterms:title>Collection factory</dcterms:title><oslc:resourceType rdf:resource="http://open-services.net/ns/rm#RequirementCollection"/><oslc:creation rdf:resource="${RM}/collectionFactory"/></oslc:CreationFactory></oslc:creationFactory>
<oslc:creationFactory><oslc:CreationFactory><dcterms:title>Requirement factory</dcterms:title><oslc:resourceType rdf:resource="http://open-services.net/ns/rm#Requirement"/>
<oslc:creation rdf:resource="${FACTORY.replace(/&/g, "&amp;")}"/><oslc:resourceShape rdf:resource="${SHAPE}"/><oslc:resourceShape rdf:resource="${HEAD_SHAPE}"/></oslc:CreationFactory></oslc:creationFactory>
<oslc:queryCapability><oslc:QueryCapability><oslc:resourceType rdf:resource="http://open-services.net/ns/rm#Requirement"/><oslc:queryBase rdf:resource="${QUERY.replace(/&/g, "&amp;")}"/></oslc:QueryCapability></oslc:queryCapability>
</oslc:Service></oslc:service></oslc:ServiceProvider></rdf:RDF>`;
const SYSREQ = `<rdf:RDF xmlns:rdf="${NS.rdf}" xmlns:oslc="${NS.oslc}" xmlns:dcterms="${NS.dcterms}" xmlns:rdfs="${NS.rdfs}">
<oslc:ResourceShape rdf:about="${SHAPE}"><dcterms:title>System Requirement</dcterms:title>
<oslc:property><oslc:Property><oslc:name>title</oslc:name><dcterms:title>Title</dcterms:title><oslc:propertyDefinition rdf:resource="http://purl.org/dc/terms/title"/></oslc:Property></oslc:property>
<oslc:property><oslc:Property><oslc:name>prio</oslc:name><dcterms:title>Priority</dcterms:title><oslc:propertyDefinition rdf:resource="${PRIO}"/>
<oslc:allowedValues><oslc:AllowedValues><oslc:allowedValue rdf:resource="${HIGH}"/><oslc:allowedValue rdf:resource="${LOW}"/></oslc:AllowedValues></oslc:allowedValues></oslc:Property></oslc:property>
<oslc:property><oslc:Property><dcterms:title>Verification Notes</dcterms:title><oslc:propertyDefinition rdf:resource="${RM}/types/_notes"/><oslc:valueType rdf:resource="http://www.w3.org/2001/XMLSchema#string"/></oslc:Property></oslc:property>
</oslc:ResourceShape>
<rdf:Description rdf:about="${HIGH}"><rdfs:label>High</rdfs:label></rdf:Description><rdf:Description rdf:about="${LOW}"><rdfs:label>Low</rdfs:label></rdf:Description></rdf:RDF>`;
const HEADING = `<rdf:RDF xmlns:rdf="${NS.rdf}" xmlns:oslc="${NS.oslc}" xmlns:dcterms="${NS.dcterms}"><oslc:ResourceShape rdf:about="${HEAD_SHAPE}"><dcterms:title>Heading</dcterms:title></oslc:ResourceShape></rdf:RDF>`;
/** The server's own prefixes (j.0, j.1) and properties the tools don't know about must survive an edit. */
const ARTIFACT = `<?xml version="1.0" encoding="UTF-8"?>
<rdf:RDF xmlns:rdf="${NS.rdf}" xmlns:dcterms="${NS.dcterms}" xmlns:oslc="${NS.oslc}" xmlns:j.0="${NS.jazz_rm}" xmlns:j.1="${RM}/types/" xmlns:oslc_rm="${NS.oslc_rm}">
  <rdf:Description rdf:about="${REQ}">
    <rdf:type rdf:resource="http://open-services.net/ns/rm#Requirement"/>
    <dcterms:identifier>42</dcterms:identifier>
    <dcterms:title rdf:parseType="Literal">Bus-off recovery</dcterms:title>
    <j.0:primaryText rdf:parseType="Literal"><div xmlns="${NS.xhtml}"><p>The ECU shall recover from bus-off.</p></div></j.0:primaryText>
    <oslc:instanceShape rdf:resource="${SHAPE}"/>
    <j.1:_prio rdf:resource="${LOW}"/>
    <j.1:_secret>keep me</j.1:_secret>
    <oslc_rm:satisfies rdf:resource="${RM}/resources/_R1"/>
  </rdf:Description>
</rdf:RDF>`;
const QUERY_RESULT = `<rdf:RDF xmlns:rdf="${NS.rdf}" xmlns:dcterms="${NS.dcterms}" xmlns:oslc="${NS.oslc}"><oslc:ResponseInfo rdf:about="${QUERY}"/>
<rdf:Description rdf:about="${REQ}"><dcterms:identifier>42</dcterms:identifier><dcterms:title>Bus-off recovery</dcterms:title></rdf:Description></rdf:RDF>`;

type Call = { method: string; url: string; body?: string; headers: Record<string, string> };
type Resp = { status?: number; body?: string; headers?: Record<string, string> };
function server(over: (c: Call) => Resp | undefined = () => undefined, changeset = CHANGESET) {
  const calls: Call[] = [];
  let artifact = ARTIFACT;
  const http: JazzHttp = {
    baseUrl: RM,
    request: async (method, path, body, headers = {}) => {
      const url = /^https?:/.test(path) ? path : RM + path;
      const c = { method, url, body, headers };
      calls.push(c);
      const r: Resp = over(c) ?? (
        method === "GET" && url === CS ? { body: changeset }
        : method === "GET" && url === COMP ? { body: COMPONENT }
        : method === "GET" && url === `${RM}/oslc_rm/_P1/services.xml` ? { body: SERVICES }
        : method === "GET" && url === SHAPE ? { body: SYSREQ }
        : method === "GET" && url === HEAD_SHAPE ? { body: HEADING }
        : method === "GET" && url.startsWith(`${RM}/views?`) ? { body: QUERY_RESULT }
        : method === "GET" && url === REQ ? { body: artifact, headers: { ETag: '"v1"' } }
        : method === "POST" && url === FACTORY ? (() => { artifact = ARTIFACT; return { status: 201, headers: { Location: REQ } }; })()
        : method === "PUT" && url === REQ ? (() => { artifact = body!; return { status: 200 }; })()
        : method === "DELETE" && url === REQ ? { status: 204 }
        : { status: 404, body: "" });
      const h = new Map(Object.entries(r.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
      const status = r.status ?? 200;
      return { status, ok: status < 400, headers: { get: (n: string) => h.get(n.toLowerCase()) ?? null }, text: async () => r.body ?? "" };
    },
  };
  return { http, calls, writer: new RmWriter(() => http) };
}
const writes = (calls: Call[]) => calls.filter((c) => c.method !== "GET");

describe("DOORS Next changesets", () => {
  it("accepts a changeset URL or a DOORS Next link opened in one", () => {
    expect(changesetUri(CS)).toBe(CS);
    expect(changesetUri(`${RM}/web#action=com.ibm.rdm.web.pages.showArtifact&artifactURI=x&oslc_config.context=${encodeURIComponent(CS)}`)).toBe(CS);
    expect(changesetUri(encodeURIComponent(CS))).toBe(CS);
  });

  it("refuses to write without a changeset: streams, baselines, global configurations and blanks", () => {
    expect(() => changesetUri("")).toThrow(/changeset is required/);
    expect(() => changesetUri(`${RM}/cm/stream/_S1`)).toThrow(/is a stream/);
    expect(() => changesetUri(`${RM}/cm/baseline/_B1`)).toThrow(/is a baseline/);
    expect(() => changesetUri("https://alm/gc/configuration/51068")).toThrow(/global configuration/);
  });

  it("resolves the changeset's component, project, creation factory and artifact types", async () => {
    const { writer } = server();
    const i = await writer.changeset(CS);
    expect(i).toMatchObject({ title: "SRS update for CAN", componentTitle: "Body SRS", projectId: "_P1", factory: FACTORY, queryBase: QUERY });
    expect(i.shapes.map((x) => x.title)).toEqual(["System Requirement", "Heading"]);
  });

  it("refuses a changeset that was already delivered", async () => {
    const { writer, calls } = server(undefined, CHANGESET.replace("</dcterms:title>", "</dcterms:title><oslc_config:committed>2026-11-01T10:00:00Z</oslc_config:committed>"));
    await expect(writer.create(CS, { title: "x" })).rejects.toThrow(/already delivered/);
    expect(writes(calls)).toEqual([]);
  });
});

describe("services and shapes", () => {
  it("picks the requirement factory, not the collection one", () => {
    expect(parseServices(SERVICES)).toEqual({ factory: FACTORY, shapes: [SHAPE, HEAD_SHAPE], queryBase: QUERY });
  });

  it("maps attribute names and enumeration labels to the shape's properties", () => {
    const shape = parseShape(SYSREQ, SHAPE);
    expect(attributeWrite(shape, "priority", "high")).toEqual({ ns: `${RM}/types/`, local: "_prio", body: { resource: HIGH } });
    expect(attributeWrite(shape, "Verification Notes", "HIL")).toEqual({ ns: `${RM}/types/`, local: "_notes", body: { literal: "HIL" } });
    expect(() => attributeWrite(shape, "Priority", "Urgent")).toThrow(/use one of High, Low/);
    expect(() => attributeWrite(shape, "ASIL", "B")).toThrow(/no attribute "ASIL" — attributes: Title, Priority/);
  });

  it("writes text as escaped XHTML paragraphs", () => {
    expect(textToXhtml("a < b\nsame para\n\nnext")).toBe(`<div xmlns="${NS.xhtml}"><p>a &lt; b<br/>same para</p><p>next</p></div>`);
  });

  it("edits only the properties asked for, using the server's prefixes", () => {
    const doc = new RdfDoc(ARTIFACT, REQ);
    doc.set(NS.dcterms, "title", { literal: "New & better" });
    doc.add(NS.oslc_rm, "elaborates", `${RM}/resources/_R7`);
    expect(doc.remove(NS.oslc_rm, "satisfies", `${RM}/resources/_R1`)).toBe(true);
    doc.set("http://example.com/ns#", "extra", { literal: "1" });
    expect(doc.xml).toContain("<dcterms:title>New &amp; better</dcterms:title>");
    expect(doc.xml).not.toContain("Bus-off recovery</dcterms:title>");
    expect(doc.xml).toContain(`<oslc_rm:elaborates rdf:resource="${RM}/resources/_R7"/>`);
    expect(doc.xml).not.toContain("oslc_rm:satisfies");
    expect(doc.xml).toContain('<fm:extra xmlns:fm="http://example.com/ns#">1</fm:extra>');
    expect(doc.xml).toContain("<j.1:_secret>keep me</j.1:_secret>");
    expect(doc.xml).toContain("<j.0:primaryText");
  });
});

describe("RmWriter", () => {
  it("creates a requirement in the changeset with type, text, attributes and links", async () => {
    const { writer, calls } = server();
    const r = await writer.create(CS, { type: "system", title: "Bus-off recovery", text: "The ECU shall recover from bus-off.", attributes: { Priority: "High" },
      addLinks: [{ type: "satisfies", target: `${RM}/resources/_R1` }], folder: `${RM}/folders/_F1` });
    expect(r).toMatchObject({ id: "42", url: REQ, type: "System Requirement", title: "Bus-off recovery" });
    const post = writes(calls)[0]!;
    expect(post.url).toBe(FACTORY);
    expect(post.body).toContain(`<oslc:instanceShape rdf:resource="${SHAPE}"/>`);
    expect(post.body).toContain(`<jazz_rm:primaryText rdf:parseType="Literal"><div xmlns="${NS.xhtml}"><p>The ECU shall recover from bus-off.</p></div></jazz_rm:primaryText>`);
    expect(post.body).toContain(`rdf:resource="${HIGH}"/>`);
    expect(post.body).toContain(`<oslc_rm:satisfies rdf:resource="${RM}/resources/_R1"/>`);
    expect(post.body).toContain(`<nav:parent rdf:resource="${RM}/folders/_F1"/>`);
  });

  it("sends the changeset as configuration context on every request", async () => {
    const { writer, calls } = server();
    await writer.create(CS, { title: "t" });
    await writer.update(CS, "42", { title: "u" });
    await writer.remove(CS, "42", "42");
    expect(calls.length).toBeGreaterThan(8);
    for (const c of calls) expect(c.headers["Configuration-Context"]).toBe(CS);
  });

  it("finds a requirement by id and updates it read-modify-write with If-Match", async () => {
    const { writer, calls } = server();
    const r = await writer.update(CS, "42", { title: "Bus-off recovery v2", attributes: { priority: "High" }, removeLinks: [{ type: "satisfies", target: `${RM}/resources/_R1` }] });
    const put = writes(calls)[0]!;
    expect(put).toMatchObject({ method: "PUT", url: REQ });
    expect(put.headers["If-Match"]).toBe('"v1"');
    expect(put.body).toContain(`<j.1:_prio rdf:resource="${HIGH}"/>`);
    expect(put.body).toContain("<j.1:_secret>keep me</j.1:_secret>");
    expect(put.body).not.toContain("satisfies");
    expect(r).toMatchObject({ id: "42", title: "Bus-off recovery v2", attributes: { Priority: "High" }, links: [] });
    expect(calls.some((c) => c.url.includes(encodeURIComponent("dcterms:identifier=42")))).toBe(true);
  });

  it("explains a conflicting edit instead of overwriting", async () => {
    const { writer } = server((c) => c.method === "PUT" ? { status: 412 } : undefined);
    await expect(writer.update(CS, REQ, { title: "x" })).rejects.toThrow(/HTTP 412 — the artifact changed since it was read/);
  });

  it("deletes only when confirm repeats the id, and never modules", async () => {
    const { writer, calls } = server();
    await expect(writer.remove(CS, "42", "")).rejects.toThrow(/not deleted: .* pass confirm: "42"/);
    await expect(writer.remove(CS, "42", "41")).rejects.toThrow(/not deleted/);
    expect(writes(calls)).toEqual([]);
    const ok = await writer.remove(CS, "42", "42");
    expect(ok).toMatchObject({ deleted: "42", title: "Bus-off recovery", changeset: "SRS update for CAN" });
    expect(writes(calls)).toMatchObject([{ method: "DELETE", url: REQ, headers: { "If-Match": '"v1"' } }]);

    const mod = server((c) => c.method === "GET" && c.url === REQ ? { body: ARTIFACT.replace("rm#Requirement", "rm#RequirementCollection"), headers: { ETag: "1" } } : undefined);
    await expect(mod.writer.remove(CS, "42", "42")).rejects.toThrow(/module or collection/);
    expect(writes(mod.calls)).toEqual([]);
  });
});

describe("rm write tools", () => {
  const tools = (o: { readOnly?: boolean } = {}) => {
    const s = server();
    const list = buildTools({ db: new Db(":memory:"), orch: {} as Orchestrator, roles: () => [], jazz: () => null, emitTask: () => {}, rmWriter: s.writer, readOnly: () => !!o.readOnly });
    return { ...s, tool: (n: string) => list.find((t) => t.name === n)! };
  };

  it("every write tool requires a changeset", () => {
    const { tool } = tools();
    for (const n of ["rm_create", "rm_update", "rm_delete"]) {
      expect(tool(n).set).toBe("jazz");
      expect((tool(n).inputSchema as { required: string[] }).required).toContain("changeset");
    }
    expect((tool("rm_delete").inputSchema as { required: string[] }).required).toContain("confirm");
  });

  it("refuse in read-only mode and with a stream, before anything is sent", async () => {
    const ro = tools({ readOnly: true });
    await expect(ro.tool("rm_create").handler({ changeset: CS, title: "x" }, { agentId: "" })).rejects.toThrow(/read-only mode/);
    expect(ro.calls).toEqual([]);
    const rw = tools();
    await expect(rw.tool("rm_update").handler({ changeset: `${RM}/cm/stream/_S1`, requirement: "42", title: "x" }, { agentId: "" })).rejects.toThrow(/is a stream/);
    expect(rw.calls).toEqual([]);
  });

  it("rm_changeset lists the types and their attributes", async () => {
    const { tool } = tools();
    expect(await tool("rm_changeset").handler({ changeset: CS }, { agentId: "" })).toMatchObject({
      title: "SRS update for CAN", component: "Body SRS", types: [{ type: "System Requirement", attributes: ["Title", "Priority", "Verification Notes"] }, { type: "Heading", attributes: [] }],
    });
  });
});
