import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScmClient, normPath, parseComponents, parseRemoteFiles, parseStreams, type CliRunner } from "../src/main/scm";
import { cmdQuote, findScmCli } from "../src/main/scm-cli";
import type { JazzHttp } from "../src/main/etm";

const STREAMS = `<scm><workspace><itemId>_S1aaaaaaaaaaaa</itemId><name>Body Main</name><description>main line</description>
<components><itemId>_C1aaaaaaaaaaaa</itemId><name>BodyCtrl</name></components><components><itemId>_C2aaaaaaaaaaaa</itemId><name>Common Libs</name></components></workspace>
<workspace><itemId>_S2aaaaaaaaaaaa</itemId><name>Body Release 2.1</name></workspace></scm>`;

function fake(route: (url: string, method: string) => { status?: number; body?: string } | undefined) {
  const calls: { url: string; method: string }[] = [];
  const http: JazzHttp = {
    baseUrl: "https://alm/ccm",
    request: async (method, url) => {
      calls.push({ url, method });
      const r = route(url, method) ?? { status: 404 };
      const status = r.status ?? 200;
      return { status, ok: status < 400, headers: { get: () => null }, text: async () => r.body ?? "" };
    },
  };
  return { http, calls };
}
const streamsRoute = (url: string) => url.startsWith("/rpt/repository/scm") ? { body: STREAMS } : undefined;

describe("EWM source control parsing", () => {
  it("reads streams without mixing up their components' names", () => {
    const s = parseStreams(STREAMS);
    expect(s.map((x) => x.name)).toEqual(["Body Main", "Body Release 2.1"]);
    expect(s[0]!.components).toEqual([{ id: "_C1aaaaaaaaaaaa", name: "BodyCtrl" }, { id: "_C2aaaaaaaaaaaa", name: "Common Libs" }]);
    expect(parseComponents(`{"components":[{"itemId":"_X1","name":"Boot"}]}`)).toEqual([{ id: "_X1", name: "Boot" }]);
  });

  it("parses remote file listings in JSON or text form", () => {
    expect(parseRemoteFiles(JSON.stringify({ "remote-files": [{ path: "/src/" }, { path: "/src/can.c" }, { nested: [{ path: "/README.md" }] }] })))
      .toEqual([{ path: "/README.md", folder: false }, { path: "/src", folder: true }, { path: "/src/can.c", folder: false }]);
    expect(parseRemoteFiles("Listing:\n  /a/\n  /a/b.h\n")).toEqual([{ path: "/a", folder: true }, { path: "/a/b.h", folder: false }]);
  });

  it("refuses parent references in paths", () => {
    expect(normPath("\\src\\.\\can.c")).toBe("src/can.c");
    expect(() => normPath("src/../../etc/passwd")).toThrow(/\.\./);
  });
});

describe("EWM source control client", () => {
  it("reads a file by stream and component name through the content service, windowed", async () => {
    const body = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\r\n");
    const { http, calls } = fake((url) => streamsRoute(url) ?? (url.includes("IFilesystemContentService") ? { body } : undefined));
    const r = await new ScmClient(http, () => null).readFile("body main", "Common Libs", "/src/my file.c", { startLine: 3, lines: 2 });
    expect(r).toMatchObject({ text: "line 3\nline 4", totalLines: 10, startLine: 3, truncated: true, stream: "Body Main", component: "Common Libs" });
    expect(calls.at(-1)!.url).toBe("/service/com.ibm.team.filesystem.service.internal.rest.IFilesystemContentService/_S1aaaaaaaaaaaa/_C2aaaaaaaaaaaa/src/my%20file.c");
  });

  it("explains missing files, unknown components and binary files", async () => {
    const { http } = fake((url) => streamsRoute(url) ?? (url.endsWith("bin.hex") ? { body: "ab\u0000cd" } : undefined));
    const c = new ScmClient(http, () => null);
    await expect(c.readFile("Body Main", "BodyCtrl", "nope.c")).rejects.toThrow(/file not found/);
    await expect(c.readFile("Body Main", "Nope", "a.c")).rejects.toThrow(/BodyCtrl, Common Libs/);
    await expect(c.readFile("Body Main", "BodyCtrl", "bin.hex")).rejects.toThrow(/binary/);
    await expect(c.readFile("Body", "BodyCtrl", "a.c")).rejects.toThrow(/did you mean: Body Main, Body Release 2.1/);
  });

  it("falls back to the web client's service for a stream's components", async () => {
    const { http } = fake((url) => url.includes("IScmRestService2/workspace?workspaceItemId=_S2aaaaaaaaaaaa")
      ? { body: `{"components":[{"itemId":"_C9","name":"Release Docs"}]}` } : url.includes("itemId%3D'_S2") ? { body: "<scm/>" } : streamsRoute(url));
    expect(await new ScmClient(http, () => null).components("Body Release 2.1")).toEqual([{ id: "_C9", name: "Release Docs" }]);
  });

  it("lists and finds files through the SCM command line, and says when it is missing", async () => {
    const seen: string[][] = [];
    const run: CliRunner = async (args) => { seen.push(args); return { code: 0, stderr: "", stdout: JSON.stringify([{ path: "/src/" }, { path: "/src/can/can_if.h" }, { path: "/src/can/can_if.c" }, { path: "/doc/can.md" }]) }; };
    const { http } = fake(streamsRoute);
    const c = new ScmClient(http, () => ({ run, repo: "https://alm/ccm" }));
    expect((await c.find("Body Main", "BodyCtrl", "src/**/can_*.h")).map((e) => e.path)).toEqual(["/src/can/can_if.h"]);
    expect((await c.find("Body Main", "BodyCtrl", "can md")).map((e) => e.path)).toEqual(["/doc/can.md"]);
    expect(seen[0]).toEqual(["list", "remotefiles", "-r", "https://alm/ccm", "--json", "--depth", "12", "Body Main", "BodyCtrl"]);
    expect(seen).toHaveLength(1); // second search reused the cached listing
    await expect(new ScmClient(http, () => null).list("Body Main", "BodyCtrl")).rejects.toThrow(/command line/);
  });

  it("never sends anything but GET to EWM", async () => {
    const { http, calls } = fake((url) => streamsRoute(url) ?? { body: "x" });
    const c = new ScmClient(http, () => null);
    await c.streams();
    await c.readFile("Body Main", "BodyCtrl", "a.c");
    await c.fileText("Body Main", "BodyCtrl", "a.c");
    expect(new Set(calls.map((x) => x.method))).toEqual(new Set(["GET"]));
  });
});

describe("EWM SCM command line", () => {
  it("finds the configured CLI file or folder", () => {
    const dir = mkdtempSync(join(tmpdir(), "scmcli-"));
    writeFileSync(join(dir, "lscm"), "");
    expect(findScmCli(dir, "", ["lscm"])).toBe(join(dir, "lscm"));
    expect(findScmCli(join(dir, "lscm"), "", ["lscm"])).toBe(join(dir, "lscm"));
    expect(findScmCli("", dir, ["lscm"])).toBe(join(dir, "lscm"));
    expect(findScmCli("", "", ["lscm"])).toBeNull();
  });

  it("quotes cmd.exe arguments and refuses ones cmd would expand", () => {
    expect(cmdQuote("Body Main")).toBe('"Body Main"');
    expect(cmdQuote("plain")).toBe("plain");
    expect(() => cmdQuote("50%off")).toThrow();
    expect(() => cmdQuote('a"b')).toThrow();
  });
});
