import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { DOT_PATTERNS, Dots, type DotPattern } from "../src/renderer/components/Dots";

describe("working dots", () => {
  // The Specialists pill's agent count spun with the orbit/quad patterns, which rotate the whole dots box.
  it("keep the count outside the animated dots box for every pattern", () => {
    for (const pattern of Object.keys(DOT_PATTERNS) as DotPattern[]) {
      const h = renderToStaticMarkup(createElement(Dots, { pattern, count: 3 }));
      const box = /<span class="dots dots-[^"]*"[^>]*>(.*?)<\/span>/.exec(h)?.[1] ?? "";
      expect(box, pattern).not.toContain("<b");
      expect(h, pattern).toMatch(/<\/span><b class="dots-count">3<\/b><\/span>$/);
    }
  });
  it("show no count for a single worker", () => {
    expect(renderToStaticMarkup(createElement(Dots, { pattern: "orbit", count: 1 }))).not.toContain("dots-count");
  });
});
