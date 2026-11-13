import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { Markdown } from "../src/renderer/components/Markdown";

const html = (t: string) => renderToStaticMarkup(createElement(Markdown, { text: t }));
describe("markdown rendering", () => {
  it("code blocks get a language label and a copy button; inline code is click-to-copy", () => {
    const h = html("Run this:\n\n```powershell\nnpm run dist:win\n```\n\nor `npm ci` first.");
    expect(h).toContain('<span class="code-lang">powershell</span>');
    expect(h).toContain('class="code-copy"');
    expect(h).toContain("<code>npm run dist:win</code>");
    expect(h).toContain('<code class="inline-code" title="Click to copy">npm ci</code>');
  });
  it("escapes HTML inside inline code and code blocks", () => {
    const h = html("`<img src=x onerror=alert(1)>`\n\n```\n<script>alert(1)</script>\n```");
    expect(h).not.toContain("<img");
    expect(h).not.toContain("<script>");
    expect(h).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });
});
