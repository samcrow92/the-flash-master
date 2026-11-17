import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { Markdown } from "../src/renderer/components/Markdown";
import { isLocalPathLink } from "../src/shared/links";
import { resolveLink, type LinkEnv } from "../src/main/links";
import { REPLY_STYLE } from "../src/main/context";

const html = (t: string) => renderToStaticMarkup(createElement(Markdown, { text: t }));

describe("links in chat replies are clickable", () => {
  it("web links open through openLink", () => {
    const h = html("See [the docs](https://example.com/a?b=1) and https://example.org.");
    expect(h).toContain('data-link="https://example.com/a?b=1"');
    expect(h).toContain('data-link="https://example.org"');
  });
  it("Markdown links to local files and file:// URLs become file links", () => {
    const h = html("Report: [rca.html](file:///C:/work/out/rca%20report.html), also [notes](reports/notes.md) and [win](<C:\\work\\out\\rca.html>)");
    expect(h).toContain('class="file-link" data-link="file:///C:/work/out/rca%20report.html"');
    expect(h).toContain('data-link="reports/notes.md"');
    expect(h).toContain('data-link="C:\\work\\out\\rca.html"');
  });
  it("bare Windows paths and file:// URLs in text are auto-linked without trailing punctuation", () => {
    const h = html("I wrote C:\\work\\out\\rca.html. Open file:///home/me/r.html now.");
    expect(h).toContain('data-link="C:\\work\\out\\rca.html"');
    expect(h).toContain('data-link="file:///home/me/r.html"');
  });
  it("paths and URLs in backticks open; other inline code stays click-to-copy", () => {
    const h = html("`C:\\out\\report.html` and `src/app.ts` but `npm ci`");
    expect(h).toContain('data-link="C:\\out\\report.html"');
    expect(h).toContain('<code class="inline-code">C:\\out\\report.html</code></a>');
    expect(h).toContain('data-link="src/app.ts"');
    expect(h).toContain('<code class="inline-code" title="Click to copy">npm ci</code>');
  });
  it("dangerous schemes stay plain text and attributes are escaped", () => {
    const h = html('[x](javascript:alert(1)) [y](data:text/html,hi) [z](vbscript:msgbox) [q](C:\\a"onclick="x.html)');
    expect(h).not.toContain("javascript:");
    expect(h).not.toMatch(/href="data:/);
    expect(h).not.toContain('"onclick="');
  });
  it("only path-like text counts as a local path", () => {
    for (const s of ["C:\\x\\y.html", "file:///tmp/a.html", "/home/me/r.html", "./a", "../b/c.txt", "docs/report.html", "~/out/r.pdf"]) expect(isLocalPathLink(s), s).toBe(true);
    for (const s of ["e.g.", "v1.2", "readme", "javascript:alert(1)", "\\\\server\\share\\x.html", "//host/x", "ms-settings:", "and/or"]) expect(isLocalPathLink(s), s).toBe(false);
  });
});

describe("resolveLink decides what a click may open", () => {
  const files = new Set(["C:\\proj\\out\\rca.html", "C:\\proj\\tool.exe", "C:\\proj\\src\\app.ts", "/home/me/proj/report.html", "/home/me/proj/run.sh", "C:\\My Reports\\r.html"]);
  const win: LinkEnv = { platform: "win32", bases: ["C:\\proj"], home: "C:\\Users\\me", exists: (p) => files.has(p) };
  const nix: LinkEnv = { platform: "linux", bases: ["/home/me/proj"], home: "/home/me", exists: (p) => files.has(p) };

  it("opens web links and local reports", () => {
    expect(resolveLink("https://example.com/x", win)).toEqual({ kind: "web", url: "https://example.com/x" });
    expect(resolveLink("C:\\proj\\out\\rca.html", win)).toEqual({ kind: "open", path: "C:\\proj\\out\\rca.html" });
    expect(resolveLink("C:/proj/out/rca.html", win)).toEqual({ kind: "open", path: "C:\\proj\\out\\rca.html" });
    expect(resolveLink("file:///C:/My%20Reports/r.html", win)).toEqual({ kind: "open", path: "C:\\My Reports\\r.html" });
    expect(resolveLink("out/rca.html", win)).toEqual({ kind: "open", path: "C:\\proj\\out\\rca.html" });
    expect(resolveLink("src/app.ts:42", win)).toEqual({ kind: "open", path: "C:\\proj\\src\\app.ts" });
    expect(resolveLink("file:///home/me/proj/report.html", nix)).toEqual({ kind: "open", path: "/home/me/proj/report.html" });
    expect(resolveLink("~/proj/report.html", nix)).toEqual({ kind: "open", path: "/home/me/proj/report.html" });
  });
  it("never runs programs: shows them in their folder", () => {
    expect(resolveLink("C:\\proj\\tool.exe", win)).toEqual({ kind: "reveal", path: "C:\\proj\\tool.exe" });
    expect(resolveLink("run.sh", nix)).toEqual({ kind: "reveal", path: "/home/me/proj/run.sh" });
  });
  it("refuses other schemes, network paths, escapes from the project and missing files", () => {
    for (const l of ["javascript:alert(1)", "data:text/html,x", "ms-settings:", "vbscript:x", "\\\\evil\\share\\a.html", "file://evil/share/a.html", "//evil/a.html",
      "..\\..\\Windows\\win.ini", "C:\\proj\\missing.html", "c:relative.html"]) expect(resolveLink(l, win).kind, l).toBe("refuse");
    expect(resolveLink("../../etc/passwd", nix).kind).toBe("refuse");
    expect(resolveLink("out/rca.html", { ...win, bases: [] }).kind).toBe("refuse");
  });
});

describe("agents are told to link the files they create", () => {
  it("reply style asks for a clickable link to every file the agent creates", () => {
    expect(REPLY_STYLE).toMatch(/link/i);
    expect(REPLY_STYLE).toContain("file:///");
  });
});
