import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Markdown } from "../src/renderer/components/Markdown";
import { isLocalHtml } from "../src/shared/links";
import { REPORT_CSP, ReportFolders, reportFile, reportMime, reportNavigation, resolveHtml } from "../src/main/html-preview";
import { HTML_SANDBOX } from "../src/renderer/htmlPreview";
import type { LinkEnv } from "../src/main/links";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const md = (t: string) => renderToStaticMarkup(createElement(Markdown, { text: t }));
const winEnv = (files: string[], bases: string[] = []): LinkEnv => ({ platform: "win32", bases, home: "C:\\Users\\me", exists: (p) => files.includes(p) });
const posixEnv = (files: string[], bases: string[] = []): LinkEnv => ({ platform: "linux", bases, home: "/home/me", exists: (p) => files.includes(p) });

describe("HTML report cards in chat replies", () => {
  it("a link to a local .html report gets a report card with Preview, Full view and Browser", () => {
    const h = md("Report: [rca.html](file:///C:/work/out/rca.html)");
    expect(h).toContain('class="file-link"');
    expect(h).toContain('class="html-card" data-html="file:///C:/work/out/rca.html" hidden');
    expect(h).toContain('data-html-act="inline"');
    expect(h).toContain('data-html-act="full"');
    expect(h).toContain('data-html-act="browser"');
    expect(h).toContain(">rca.html<");
  });
  it("bare paths, relative paths and paths in backticks get a card too", () => {
    expect(md("Wrote C:\\out\\brake-rca.htm.")).toContain('data-html="C:\\out\\brake-rca.htm"');
    expect(md("See [report](reports/rca.html)")).toContain('data-html="reports/rca.html"');
    expect(md("Open `C:\\out\\rca.html`")).toContain('data-html="C:\\out\\rca.html"');
  });
  it("web pages, other files and raw HTML never get a card", () => {
    expect(md("[site](https://example.com/index.html)")).not.toContain("html-card");
    expect(md("[notes](C:\\out\\notes.md)")).not.toContain("html-card");
    expect(md("<iframe src=\"x.html\"></iframe>")).not.toContain("<iframe");
  });
  it("isLocalHtml matches local .html/.htm paths only", () => {
    expect(isLocalHtml("C:\\out\\a.html")).toBe(true);
    expect(isLocalHtml("file:///tmp/a.HTM")).toBe(true);
    expect(isLocalHtml("/tmp/reports/a.html")).toBe(true);
    expect(isLocalHtml("https://x.dev/a.html")).toBe(false);
    expect(isLocalHtml("C:\\out\\a.htmlx")).toBe(false);
  });
});

describe("which pages may be previewed", () => {
  it("local HTML files resolve to their folder and file name", () => {
    expect(resolveHtml("file:///C:/work/out/rca.html", winEnv(["C:\\work\\out\\rca.html"]))).toEqual({ ok: true, path: "C:\\work\\out\\rca.html", dir: "C:\\work\\out", file: "rca.html" });
    expect(resolveHtml("reports/rca.html", posixEnv(["/p/reports/rca.html"], ["/p"]))).toMatchObject({ ok: true, dir: "/p/reports", file: "rca.html" });
  });
  it("refuses web pages, other files, missing files, network paths and paths leaving the project", () => {
    expect(resolveHtml("https://x.dev/a.html", winEnv([]))).toMatchObject({ ok: false });
    expect(resolveHtml("C:\\out\\a.md", winEnv(["C:\\out\\a.md"]))).toEqual({ ok: false, reason: "not an HTML file" });
    expect(resolveHtml("C:\\out\\a.html", winEnv([]))).toMatchObject({ ok: false });
    expect(resolveHtml("\\\\server\\share\\a.html", winEnv(["\\\\server\\share\\a.html"]))).toMatchObject({ ok: false });
    expect(resolveHtml("../../etc/a.html", posixEnv(["/etc/a.html"], ["/p/x"]))).toMatchObject({ ok: false });
  });
});

describe("the flash-report:// scheme", () => {
  it("serves only files inside the registered report folder", () => {
    const f = new ReportFolders("win32", () => "tok1");
    const url = f.urlFor("C:\\work\\out", "brake rca.html");
    expect(url).toBe("flash-report://tok1/brake%20rca.html");
    expect(f.urlFor("c:\\WORK\\out", "x.html")).toBe("flash-report://tok1/x.html"); // same folder, same token
    expect(f.fileFor(url)).toBe("C:\\work\\out\\brake rca.html");
    expect(f.fileFor("flash-report://tok1/img/fish.svg")).toBe("C:\\work\\out\\img\\fish.svg");
    expect(f.fileFor("flash-report://tok1/..%5C..%5Cwindows%5Cwin.ini")).toBeNull();
    expect(f.fileFor("flash-report://tok1/%2E%2E/secret.txt")).toBe("C:\\work\\out\\secret.txt"); // the URL parser folds it back inside
    expect(f.fileFor("flash-report://tok1/C:%5Cwindows%5Cwin.ini")).toBeNull();
    expect(f.fileFor("flash-report://other/x.html")).toBeNull();
    expect(f.fileFor("file:///C:/work/out/x.html")).toBeNull();
  });
  it("rejects traversal on POSIX too", () => {
    expect(reportFile("/r", "/a/b.css", "linux")).toBe("/r/a/b.css");
    expect(reportFile("/r", "/../etc/passwd", "linux")).toBeNull();
    expect(reportFile("/r", "/%2e%2e/etc/passwd", "linux")).toBeNull();
    expect(reportFile("/r", "/", "linux")).toBeNull();
    expect(reportFile("/r", "/a%00.html", "linux")).toBeNull();
  });
  it("pages render offline: inline scripts and styles yes, network no", () => {
    expect(REPORT_CSP).toContain("default-src 'none'");
    expect(REPORT_CSP).toContain("connect-src 'none'");
    expect(REPORT_CSP).toMatch(/script-src [^;]*'unsafe-inline'/);
    expect(REPORT_CSP).not.toMatch(/https?:|\*/);
    expect(reportMime("a.HTML")).toMatch(/^text\/html/);
    expect(reportMime("a.exe")).toBe("application/octet-stream");
  });
  it("frames move only within reports; web links go to the browser; everything else is blocked", () => {
    expect(reportNavigation("flash-report://tok/b.html")).toBe("allow");
    expect(reportNavigation("https://jira.example.com/BRK-1")).toBe("browser");
    expect(reportNavigation("file:///C:/Windows/win.ini")).toBe("block");
    expect(reportNavigation("javascript:alert(1)")).toBe("block");
  });
});

describe("report frame isolation (repo rules)", () => {
  it("the frame never gets same-origin, top navigation, forms or downloads", () => {
    for (const bad of ["allow-same-origin", "allow-top-navigation", "allow-forms", "allow-downloads", "allow-popups-to-escape-sandbox"]) expect(HTML_SANDBOX).not.toContain(bad);
    expect(read("src/renderer/components/HtmlViewer.tsx")).toContain("sandbox={HTML_SANDBOX}");
    expect(read("src/renderer/htmlPreview.ts")).toContain('setAttribute("sandbox", HTML_SANDBOX)');
  });
  it("the app page frames only flash-report:// and every window guards report frames", () => {
    const csp = /Content-Security-Policy" content="([^"]+)"/.exec(read("src/renderer/index.html"))?.[1] ?? "";
    expect(csp).toMatch(/frame-src flash-report:(;|$)/);
    const main = read("src/main/index.ts");
    expect(main.match(/guardReportFrames\((win|w)\.webContents\)/g)).toHaveLength(2);
    expect(main).toMatch(/"Content-Security-Policy": REPORT_CSP/);
  });
});
