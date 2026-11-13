import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Requirements, parseArtifact, parseProjects, rankRequirements, splitArtifacts, type RmFetcher } from "../src/main/requirements";

const NS = `xmlns:ds="http://jazz.net/xmlns/alm/rm/datasource/v0.1" xmlns:rrm="http://www.ibm.com/xmlns/rrm/1.0/" xmlns:attribute="http://jazz.net/xmlns/alm/rm/attribute/v0.1"`;
const art = (id: number, uuid: string, title: string, text: string, type: string, section: string, depth: number, extra = "") => `
<ds:artifact attribute:itemId="${uuid}">
  <rrm:title>${title}</rrm:title><rrm:identifier>${id}</rrm:identifier><rrm:format>Text</rrm:format>
  <rrm:about>https://jazz.example/rm/resources/${uuid}</rrm:about>
  <ds:content><ds:text><div xmlns="http://www.w3.org/1999/xhtml"><p>${text}</p></div></ds:text></ds:content>
  <attribute:objectType attribute:name="${type}">
    <attribute:customAttribute attribute:name="Priority" attribute:value="High"/>
  </attribute:objectType>
  <ds:traceability><ds:links><ds:Link><rrm:title>Validated By</rrm:title><rrm:about>https://jazz.example/qm/tc/1</rrm:about></ds:Link></ds:links></ds:traceability>
  <rrm:collaboration><rrm:title>should not leak</rrm:title></rrm:collaboration>
  <rrm:section>${section}</rrm:section><rrm:depth>${depth}</rrm:depth>${extra}
</ds:artifact>`;
const MODULE_XML = `<?xml version="1.0"?><ds:dataSource ${NS}>
${art(100, "_h1", "Brake light", "Brake light", "Heading", "1", 1)}
${art(101, "_r1", "", "The brake light shall switch on within 50 ms after the brake pedal is pressed.", "System Requirement", "1.1", 2)}
${art(102, "_r2", "", "The brake light input shall be debounced for 10 ms to suppress contact bounce.", "System Requirement", "1.2", 2)}
${art(200, "_h2", "Diagnostics", "Diagnostics", "Heading", "2", 1)}
${art(201, "_r3", "", "A short circuit of the lamp output shall set DTC B1234 &amp; disable the output.", "System Requirement", "2.1", 2)}
</ds:dataSource>`;
const MODULES_XML = `<ds:dataSource ${NS}><ds:artifact><rrm:title>Lighting SRS</rrm:title><rrm:identifier>77</rrm:identifier><rrm:format>Module</rrm:format>
<rrm:about>https://jazz.example/rm/resources/MD_abc</rrm:about></ds:artifact></ds:dataSource>`;
const CATALOG = `<rdf:RDF xmlns:rdf="r" xmlns:oslc="o" xmlns:dcterms="d"><oslc:ServiceProviderCatalog>
<oslc:serviceProvider><oslc:ServiceProvider rdf:about="https://jazz.example/rm/oslc_rm/_P1/services.xml"><dcterms:title rdf:parseType="Literal">Body Requirements</dcterms:title></oslc:ServiceProvider></oslc:serviceProvider>
<oslc:serviceProvider><oslc:ServiceProvider rdf:about="https://jazz.example/rm/oslc_rm/_P2/services.xml"><dcterms:title>ADAS</dcterms:title></oslc:ServiceProvider></oslc:serviceProvider>
</oslc:ServiceProviderCatalog></rdf:RDF>`;

describe("DOORS Next parsing", () => {
  it("parses projects from the OSLC catalog", () => {
    expect(parseProjects(CATALOG)).toEqual([{ id: "_P2", title: "ADAS" }, { id: "_P1", title: "Body Requirements" }]);
  });
  it("parses artifacts with text, type, section, attributes and links", () => {
    const arts = splitArtifacts(MODULE_XML).map(parseArtifact);
    expect(arts).toHaveLength(5);
    expect(arts[1]).toMatchObject({ id: "101", type: "System Requirement", heading: false, section: "1.1", depth: 2, attrs: { Priority: "High" },
      uri: "https://jazz.example/rm/resources/_r1", links: [{ type: "Validated By", target: "https://jazz.example/qm/tc/1" }] });
    expect(arts[1]!.text).toMatch(/^The brake light shall switch on within 50 ms/);
    expect(arts[0]!.heading).toBe(true);
    expect(arts[4]!.text).toContain("DTC B1234 & disable");
    expect(arts[1]!.title).not.toContain("leak");
  });
  it("handles nested artifacts as one top-level element", () => {
    const xml = `<ds:artifact><rrm:identifier>1</rrm:identifier><ds:artifact><rrm:identifier>9</rrm:identifier></ds:artifact></ds:artifact><ds:artifact/>`;
    expect(splitArtifacts(xml)).toHaveLength(1);
    expect(parseArtifact(splitArtifacts(xml)[0]!).id).toBe("1");
  });
});

describe("requirement retrieval", () => {
  const mod = { uri: "u", uuid: "MD_abc", identifier: "77", title: "Lighting SRS", projectId: "_P1" };
  const reqs = splitArtifacts(MODULE_XML).map(parseArtifact).map((req) => ({ req, module: mod }));
  it("ranks relevant requirements first and skips headings", () => {
    const hits = rankRequirements(reqs, "debounce contact bounce");
    expect(hits[0]!.id).toBe("102");
    expect(hits.every((h) => h.type !== "Heading")).toBe(true);
    expect(rankRequirements(reqs, "short circuit lamp DTC")[0]!.id).toBe("201");
  });
  it("puts exact ids first and handles word stems", () => {
    expect(rankRequirements(reqs, "201 brake")[0]!.id).toBe("201");
    expect(rankRequirements(reqs, "debouncing")[0]!.id).toBe("102");
  });

  it("loads modules through the API, caches them and serves search/get/outline", async () => {
    const calls: string[] = [];
    const fetcher: RmFetcher = { getText: async (path) => { calls.push(path); return path.startsWith("/oslc_rm") ? CATALOG : path.startsWith("/publish/modules") ? MODULES_XML : MODULE_XML; } };
    const dir = mkdtempSync(join(tmpdir(), "rm-"));
    const rm = new Requirements(() => fetcher, dir, () => "https://jazz.example/rm/cm/stream/_S1");
    expect((await rm.modules("_P1"))[0]).toMatchObject({ identifier: "77", title: "Lighting SRS", uuid: "MD_abc" });
    expect(calls[0]).toContain("oslc_config.context=https%3A%2F%2Fjazz.example%2Frm%2Fcm%2Fstream%2F_S1");
    const hits = await rm.search("switch on time after pedal", { modules: ["Lighting"] });
    expect(hits[0]).toMatchObject({ id: "101", moduleTitle: "Lighting SRS", section: "1.1" });
    expect(calls.filter((c) => c.startsWith("/publish/resources"))).toHaveLength(1);
    expect((await rm.get(["102"]))[0]!.text).toContain("10 ms");
    expect(await rm.outline("77")).toMatchObject({ count: 3, headings: [{ section: "1", title: "Brake light", reqs: 2 }, { section: "2", title: "Diagnostics", reqs: 1 }] });
    // cache survives a new instance (no network)
    const offline = new Requirements(() => null, dir, () => "https://jazz.example/rm/cm/stream/_S1");
    expect((await offline.search("debounce"))[0]!.id).toBe("102");
  });
});

describe("DOORS Next links and scope", () => {
  const LINK = "https://alm.hella.com/rmA1/web#action=com.ibm.rdm.web.pages.showFoundationProjectDashboard&componentURI=https%3A%2F%2Falm.hella.com%2FrmA1%2Fcm%2Fcomponent%2F_COMP1&oslc_config.context=https%3A%2F%2Falm.hella.com%2FrmA1%2Fcm%2Fstream%2F_S9";
  it("extracts server root, component and configuration from a browser link", async () => {
    const { parseRmLink } = await import("../src/main/requirements");
    expect(parseRmLink(LINK)).toEqual({ base: "https://alm.hella.com/rmA1", componentUri: "https://alm.hella.com/rmA1/cm/component/_COMP1", projectId: "", config: "https://alm.hella.com/rmA1/cm/stream/_S9" });
    expect(parseRmLink("https://alm.hella.com/rmA1/").base).toBe("https://alm.hella.com/rmA1");
  });

  it("resolves the component's project and default stream, and uses them for module reads", async () => {
    const calls: string[] = [];
    const COMP = `<rdf:RDF><oslc_config:Component rdf:about="x"><dcterms:title>BCM Lighting</dcterms:title>
      <process:projectArea rdf:resource="https://alm.hella.com/rmA1/process/project-areas/_PA7"/>
      <oslc_config:configurations rdf:resource="https://alm.hella.com/rmA1/cm/component/_COMP1/configurations"/></oslc_config:Component></rdf:RDF>`;
    const CONFIGS = `<rdf:RDF><ldp:Container><rdfs:member rdf:resource="https://alm.hella.com/rmA1/cm/baseline/_B1"/><rdfs:member rdf:resource="https://alm.hella.com/rmA1/cm/stream/_S1"/></ldp:Container></rdf:RDF>`;
    const fetcher: RmFetcher = { getText: async (path) => {
      calls.push(path);
      if (path.endsWith("/cm/component/_COMP1")) return COMP;
      if (path.endsWith("/configurations")) return CONFIGS;
      if (path.startsWith("/oslc_rm/catalog")) return `<rdf:RDF></rdf:RDF>`;
      if (path.startsWith("/process/project-areas")) return `<jp:project-areas><jp:project-area jp:name="Body &amp; Lighting" jp:url="https://alm.hella.com/rmA1/process/project-areas/_PA7"/></jp:project-areas>`;
      if (path.startsWith("/publish/modules")) return MODULES_XML;
      return MODULE_XML;
    } };
    const rm = new Requirements(() => fetcher, mkdtempSync(join(tmpdir(), "rm2-")), () => "", () => "https://alm.hella.com/rmA1/cm/component/_COMP1");
    const projects = await rm.projects();
    expect(projects[0]).toEqual({ id: "_PA7", title: "Body & Lighting" });
    await rm.modules("_PA7");
    expect(calls.find((c) => c.startsWith("/publish/modules"))).toContain("oslc_config.context=https%3A%2F%2Falm.hella.com%2FrmA1%2Fcm%2Fstream%2F_S1");
    expect((await rm.test())).toMatchObject({ ok: true });
    expect((await rm.test()).detail).toContain("BCM Lighting");
  });

  it("explains a web-page URL instead of reporting success with 0 projects", async () => {
    const rm = new Requirements(() => ({ getText: async () => "<html><body>DOORS Next</body></html>" }), mkdtempSync(join(tmpdir(), "rm3-")), () => "");
    const r = await rm.test();
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/web page/);
  });
});
