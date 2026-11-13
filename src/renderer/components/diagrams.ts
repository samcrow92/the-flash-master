// Diagram renderers used inside chat markdown. All text is escaped; output is static SVG.
const esc = (s: unknown) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export interface Fishbone {
  problem: string;
  categories: Record<string, string[]> | { name: string; causes: string[] }[];
}

export function fishboneSvg(f: Fishbone): string {
  const entries: [string, string[]][] = Array.isArray(f.categories)
    ? f.categories.map((c) => [c.name, c.causes ?? []])
    : Object.entries(f.categories ?? {});
  const cats = entries.slice(0, 8).map(([n, cs]) => [String(n).slice(0, 40), (cs ?? []).slice(0, 6).map(String)] as [string, string[]]);
  const W = 1320, H = 560, spine = 280, headW = 220, x0 = 230, x1 = W - headW - 20; // x0 leaves room for left-most cause labels
  const top = cats.filter((_, i) => i % 2 === 0), bottom = cats.filter((_, i) => i % 2 === 1);
  const cols = Math.max(top.length, bottom.length, 1);
  const step = (x1 - x0) / cols;
  const out: string[] = [
    `<svg class="diagram fishbone" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" font-size="12.5">`,
    `<line x1="${x0}" y1="${spine}" x2="${x1}" y2="${spine}" class="d-spine"/>`,
    `<polygon points="${x1},${spine - 10} ${x1 + 16},${spine} ${x1},${spine + 10}" class="d-arrow"/>`,
    `<rect x="${x1 + 18}" y="${spine - 55}" width="${headW - 10}" height="110" rx="10" class="d-head"/>`,
  ];
  const words = String(f.problem ?? "").split(/\s+/);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) { if ((cur + " " + w).trim().length > 26 && cur) { lines.push(cur); cur = w; } else cur = `${cur} ${w}`.trim(); }
  if (cur) lines.push(cur);
  lines.slice(0, 5).forEach((l, i, a) => out.push(`<text x="${x1 + 18 + (headW - 10) / 2}" y="${spine - (a.length - 1) * 8 + i * 16 + 4}" text-anchor="middle" class="d-head-text">${esc(l)}</text>`));
  for (const [row, sign] of [[top, -1], [bottom, 1]] as const) {
    row.forEach(([name, causes], i) => {
      const bx = x0 + step * (i + 0.85), tx = bx - 85, ty = spine + sign * 215;
      out.push(`<line x1="${bx}" y1="${spine}" x2="${tx}" y2="${ty}" class="d-bone"/>`);
      out.push(`<text x="${tx}" y="${ty + (sign < 0 ? -10 : 20)}" text-anchor="middle" class="d-cat">${esc(name)}</text>`);
      causes.forEach((c, j) => {
        const t = (j + 1) / (causes.length + 1), cx = bx + (tx - bx) * t, cy = spine + (ty - spine) * t;
        const status = /confirmed/i.test(c) ? " d-confirmed" : /ruled out/i.test(c) ? " d-ruled" : "";
        out.push(`<line x1="${cx}" y1="${cy}" x2="${cx - 60}" y2="${cy}" class="d-sub"/>`);
        out.push(`<text x="${cx - 64}" y="${cy + 4}" text-anchor="end" class="d-cause${status}">${esc(c.slice(0, 52))}</text>`);
      });
    });
  }
  out.push("</svg>");
  return out.join("");
}
