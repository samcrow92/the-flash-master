import { describe, expect, it } from "vitest";
import { deflateRawSync } from "node:zlib";
import { readZip } from "../src/main/scm-zip";
import { ScmClient, parseScmLink, pickEntry, scmTarget } from "../src/main/scm";
import { withScmLink } from "../src/main/tools";
import type { JazzHttp } from "../src/main/etm";
import type { ToolDef } from "../src/main/bridge";

/** A zip as EWM's "Download as zip" sends it (deflated entries, optional folder entries). */
function makeZip(files: Record<string, string | Buffer>): Buffer {
  const locals: Buffer[] = [], central: Buffer[] = [];
  let off = 0;
  for (const [name, content] of Object.entries(files)) {
    const raw = Buffer.isBuffer(content) ? content : Buffer.from(content);
    const folder = name.endsWith("/");
    const data = folder ? Buffer.alloc(0) : deflateRawSync(raw);
    const n = Buffer.from(name);
    const loc = Buffer.alloc(30); loc.writeUInt32LE(0x04034b50, 0); loc.writeUInt16LE(folder ? 0 : 8, 8); loc.writeUInt32LE(data.length, 18); loc.writeUInt32LE(raw.length, 22); loc.writeUInt16LE(n.length, 26);
    const cen = Buffer.alloc(46); cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(folder ? 0 : 8, 10); cen.writeUInt32LE(data.length, 20); cen.writeUInt32LE(folder ? 0 : raw.length, 24); cen.writeUInt16LE(n.length, 28); cen.writeUInt32LE(off, 42);
    locals.push(loc, n, data); central.push(cen, n);
    off += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, end]);
}

const STREAMS = `<scm><workspace><itemId>_PpQZIJsxEe6j6IPBMoyyTQ</itemId><name>LED ECU Main</name>
<components><itemId>_Pp2PAJsxEe6j6IPBMoyyTQ</itemId><name>Specs</name></components></workspace></scm>`;
// Mari's link (2026-11-19), host changed.
const LINK = "https://alm.corp.com/ccmA1/web/projects/E-LE%20ASM_HDLP_LED_ECU%20(CM)#action=com.ibm.team.scm.browseElement&workspaceItemId=_PpQZIJsxEe6j6IPBMoyyTQ&componentItemId=_Pp2PAJsxEe6j6IPBMoyyTQ&itemType=com.ibm.team.scm.Folder&itemId=_WqfK0DIlEfC-AdxQANSXag&oslc_config.context=https%3A%2F%2Falm.corp.com%2Fgc%2Fconfiguration%2F39043";
const PDF = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0x01, 0x02]);
const ZIP = makeZip({ "hw_removal/": "", "hw_removal/readme.txt": "line 1\nline 2\nline 3", "hw_removal/specs/": "", "hw_removal/specs/led_driver.pdf": PDF, "hw_removal/specs/notes.md": "# Notes" });

function fakeServer(zip: Buffer | null) {
  const calls: string[] = [];
  const http: JazzHttp = {
    baseUrl: "https://alm.corp.com/ccmA1",
    request: async (method, url) => {
      calls.push(`${method} ${url}`);
      const body = url.startsWith("/rpt/repository/scm") ? Buffer.from(STREAMS) : url.includes("format=zip") && zip ? zip : null;
      const status = body ? 200 : 404;
      return { status, ok: status < 400, headers: { get: () => null }, text: async () => (body ?? Buffer.alloc(0)).toString("utf8"),
        arrayBuffer: async () => { const b = body ?? Buffer.alloc(0); return b.buffer.slice(b.byteOffset, b.byteOffset + b.length) as ArrayBuffer; } };
    },
  };
  return { http, calls };
}

describe("EWM folders without the command line (zip download)", () => {
  it("reads stored and deflated zip entries", () => {
    const e = readZip(ZIP);
    expect(e.map((x) => [x.path, x.folder])).toEqual([["hw_removal", true], ["hw_removal/readme.txt", false], ["hw_removal/specs", true], ["hw_removal/specs/led_driver.pdf", false], ["hw_removal/specs/notes.md", false]]);
    expect(e[3]!.data()).toEqual(PDF);
    expect(() => readZip(Buffer.from("<html>login</html>"))).toThrow(/not a zip/);
  });

  it("takes the folder from a web UI folder link", () => {
    expect(parseScmLink(LINK)).toEqual({ repo: "https://alm.corp.com/ccmA1", stream: "_PpQZIJsxEe6j6IPBMoyyTQ", component: "_Pp2PAJsxEe6j6IPBMoyyTQ", folder: "_WqfK0DIlEfC-AdxQANSXag" });
  });

  it("lists, finds and reads the files of a folder link through the content service, with no command line", async () => {
    const { http, calls } = fakeServer(ZIP);
    const c = new ScmClient(http, () => null);
    const a = scmTarget<Record<string, any>>({ link: LINK }) as { stream: string; component: string; folder: string };
    expect((await c.list(a.stream, a.component, "/", 1, a.folder)).map((e) => `${e.path}${e.folder ? "/" : ""}`)).toEqual(["/readme.txt", "/specs/"]);
    expect((await c.find(a.stream, a.component, "*.pdf", "/", 50, a.folder)).map((e) => e.path)).toEqual(["/specs/led_driver.pdf"]);
    const r = await c.readFile(a.stream, a.component, "readme.txt", { folder: a.folder, startLine: 2, lines: 1 });
    expect(r).toMatchObject({ path: "readme.txt", stream: "LED ECU Main", component: "Specs", totalLines: 3, startLine: 2, text: "line 2" });
    expect((await c.readFile(a.stream, a.component, "notes.md", { folder: a.folder })).text).toBe("# Notes"); // by file name alone
    await expect(c.readFile(a.stream, a.component, "specs/led_driver.pdf", { folder: a.folder })).rejects.toThrow(/binary file.*scm_download/);
    expect((await c.fileBytes(a.stream, a.component, "led_driver.pdf", a.folder)).data).toEqual(PDF);
    const zips = calls.filter((u) => u.includes("format=zip"));
    expect(zips).toHaveLength(1); // one download, cached for the rest
    expect(zips[0]).toBe("GET /service/com.ibm.team.filesystem.service.internal.rest.IFilesystemContentService/_PpQZIJsxEe6j6IPBMoyyTQ/_Pp2PAJsxEe6j6IPBMoyyTQ/-?itemType=com.ibm.team.scm.Folder&contextType=com.ibm.team.scm.Stream&format=zip&itemId=_WqfK0DIlEfC-AdxQANSXag");
    expect(calls.every((u) => u.startsWith("GET "))).toBe(true);
  });

  it("names the near matches when a file is not in the folder, and asks for the full path when a name is ambiguous", () => {
    const e = readZip(makeZip({ "a/x.c": "1", "b/x.c": "2", "b/y.h": "3" }));
    expect(() => pickEntry(e, "x.c")).toThrow(/several files: a\/x.c, b\/x.c/);
    expect(() => pickEntry(e, "z.h")).toThrow(/file not found: z.h \(the folder has 3 files/);
  });

  it("a folder link without a file path asks for the file and points at scm_list", async () => {
    const tool: ToolDef = { set: "jazz", name: "scm_read_file", description: "", inputSchema: { type: "object", properties: {}, required: ["stream", "component", "path"] }, handler: async () => null };
    await expect(withScmLink(tool).handler({ link: LINK, startLine: 1, lines: 40 }, { agentId: "" })).rejects.toThrow(/the link is a folder.*scm_list/);
  });
});
