import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Markdown } from "../src/renderer/components/Markdown";
import { imagePathsIn, isLocalImage } from "../src/shared/links";
import { imageBlockMarkdown, resolveImage, saveAgentImage, setAgentImageDir } from "../src/main/images";
import { toolOutputText } from "../src/main/harness/acp";
import { piToolOutput } from "../src/main/harness/pi";
import type { LinkEnv } from "../src/main/links";

const html = (t: string) => renderToStaticMarkup(createElement(Markdown, { text: t }));
const PNG_1PX = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

describe("images in chat replies", () => {
  it("a Markdown image of a local file becomes an inline preview read by the main process", () => {
    const h = html("Here is the page:\n\n![login page](file:///C:/work/out/login.png)");
    expect(h).toContain('class="md-img"');
    expect(h).toContain('data-img="file:///C:/work/out/login.png"');
    expect(h).toContain('alt="login page"');
    expect(h).not.toContain("[image:");
  });
  it("Windows paths and relative paths work as image sources", () => {
    expect(html("![shot](C:\\out\\shot.png)")).toContain('data-img="C:\\out\\shot.png"');
    expect(html("![chart](reports/chart.svg)")).toContain('data-img="reports/chart.svg"');
  });
  it("data: images render directly; web images and other schemes are never loaded", () => {
    expect(html(`![dot](data:image/png;base64,${PNG_1PX})`)).toContain(`src="data:image/png;base64,${PNG_1PX}"`);
    const web = html("![remote](https://example.com/track.png)");
    expect(web).not.toContain("<img");
    expect(web).toContain('data-link="https://example.com/track.png"');
    const js = html("![x](javascript:alert(1))");
    expect(js).not.toContain("<img");
    expect(js).not.toContain("javascript:");
    expect(html('![x](data:text/html;base64,PHNjcmlwdD4=)')).not.toContain("<img");
  });
  it("a link or bare path to an image file keeps the link and adds a preview", () => {
    for (const h of [html("Saved C:\\out\\shot.png for you."), html("[shot](file:///C:/out/shot.png)")]) {
      expect(h).toContain('data-link=');
      expect(h).toContain('data-preview="1"');
      expect(h).toContain('class="md-img"');
    }
    expect(html("See C:\\out\\report.html")).not.toContain("<img");
  });
  it("raw HTML images from agent output stay escaped", () => {
    const h = html('<img src="file:///C:/x.png" onerror="alert(1)">');
    expect(h).not.toContain("<img");
  });
});

describe("image paths", () => {
  it("recognises local image files only", () => {
    expect(isLocalImage("C:\\out\\a.PNG")).toBe(true);
    expect(isLocalImage("file:///C:/out/a.jpeg")).toBe(true);
    expect(isLocalImage("/tmp/shot.webp")).toBe(true);
    expect(isLocalImage("C:\\out\\a.html")).toBe(false);
    expect(isLocalImage("https://x.dev/a.png")).toBe(false);
    expect(isLocalImage("\\\\server\\share\\a.png")).toBe(false);
  });
  it("finds screenshots mentioned in tool output, once each", () => {
    const out = "Saved screenshot to C:\\work\\shots\\home.png.\nAlso /tmp/pw/after.jpg and C:\\work\\shots\\home.png\nlog at C:\\work\\run.log\n![image](file:///C:/data/agent-images/ab.png)";
    expect(imagePathsIn(out)).toEqual(["C:\\work\\shots\\home.png", "/tmp/pw/after.jpg", "file:///C:/data/agent-images/ab.png"]);
  });
});

describe("main process image rules", () => {
  const env = (files: string[], platform: NodeJS.Platform = "win32"): LinkEnv => ({ platform, bases: ["C:\\proj"], home: "C:\\Users\\me", exists: (p) => files.includes(p) });
  it("resolves local images like links and gives their type", () => {
    expect(resolveImage("file:///C:/out/a.png", env(["C:\\out\\a.png"]))).toEqual({ ok: true, path: "C:\\out\\a.png", mime: "image/png" });
    expect(resolveImage("shots/b.svg", env(["C:\\proj\\shots\\b.svg"]))).toEqual({ ok: true, path: "C:\\proj\\shots\\b.svg", mime: "image/svg+xml" });
  });
  it("refuses non-images, network paths, paths leaving the project and web URLs", () => {
    expect(resolveImage("C:\\out\\a.exe", env(["C:\\out\\a.exe"])).ok).toBe(false);
    expect(resolveImage("C:\\out\\notes.txt", env(["C:\\out\\notes.txt"])).ok).toBe(false);
    expect(resolveImage("\\\\srv\\share\\a.png", env([])).ok).toBe(false);
    expect(resolveImage("../secret/a.png", env(["C:\\secret\\a.png"])).ok).toBe(false);
    expect(resolveImage("https://x.dev/a.png", env([])).ok).toBe(false);
    expect(resolveImage("C:\\out\\missing.png", env([])).ok).toBe(false);
  });
  it("images an agent sends inline are saved once and shown as Markdown images", () => {
    const dir = mkdtempSync(join(tmpdir(), "fm-img-"));
    const md = imageBlockMarkdown({ type: "image", data: PNG_1PX, mimeType: "image/png" }, dir)!;
    expect(md).toMatch(/^!\[image\]\(file:\/\/.+\.png\)$/);
    const path = fileURLToPath(/\((.+)\)/.exec(md)![1]!);
    expect(readFileSync(path).equals(Buffer.from(PNG_1PX, "base64"))).toBe(true);
    expect(saveAgentImage(PNG_1PX, "image/png", dir)).toBe(path);
    expect(readdirSync(dir)).toHaveLength(1);
    expect(saveAgentImage(PNG_1PX, "text/html", dir)).toBeNull();
    expect(imageBlockMarkdown({ type: "text", text: "hi" }, dir)).toBeNull();
  });
  it("ACP and Pi tool results keep their screenshots", () => {
    const dir = mkdtempSync(join(tmpdir(), "fm-img-"));
    setAgentImageDir(dir);
    const acp = toolOutputText([{ type: "content", content: { type: "text", text: "took a screenshot" } }, { type: "content", content: { type: "image", data: PNG_1PX, mimeType: "image/png" } }], null)!;
    expect(acp).toMatch(/^took a screenshot\n!\[image\]\(file:\/\/.+\.png\)$/);
    expect(imagePathsIn(acp)).toHaveLength(1);
    const pi = piToolOutput({ content: [{ type: "image", data: PNG_1PX, mimeType: "image/png" }] })!;
    expect(pi).toMatch(/^!\[image\]\(file:\/\//);
    expect(existsSync(fileURLToPath(/\((.+)\)/.exec(pi)![1]!))).toBe(true);
  });
});
