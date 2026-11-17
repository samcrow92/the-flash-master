// Diagram renderers: static SVG, all text escaped, no scripts and no external resources.
// Used by chat markdown (```ishikawa blocks, styled by styles.css) and by the `diagram_svg` agent tool, which returns
// standalone SVG (styles embedded) that agents paste into HTML reports so the reports render offline.
const esc = (s: unknown) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const n = (v: number) => Math.round(v * 10) / 10;

export interface RenderOptions {
  /** Embed the styles in the SVG so it renders the same in any HTML file (no app stylesheet needed). */
  standalone?: boolean;
}

/** Styles for standalone SVG. Light palette with explicit colors, so it prints and reads in any viewer. */
export const DIAGRAM_CSS = [
  ".diagram{font-family:'Segoe UI',system-ui,-apple-system,sans-serif;max-width:100%;height:auto;background:#fff}",
  ".d-spine{stroke:#1f2937;stroke-width:4}.d-arrow{fill:#1f2937}",
  ".d-head{fill:#fff4cc;stroke:#d97706;stroke-width:2}.d-head-text{font-weight:600;fill:#111827}",
  ".d-bone{stroke:#374151;stroke-width:2.5}.d-sub{stroke:#9ca3af;stroke-width:1.5}",
  ".d-cat{font-weight:700;fill:#1d4ed8}.d-cause{fill:#111827}",
  ".d-confirmed{fill:#b91c1c;font-weight:600}.d-ruled{fill:#9ca3af;text-decoration:line-through}",
  ".d-node{fill:#eef2ff;stroke:#4f46e5;stroke-width:1.6}.d-node.d-start,.d-node.d-end{fill:#ecfdf5;stroke:#059669}",
  ".d-node.d-decision{fill:#fff7ed;stroke:#d97706}.d-label{fill:#111827}.d-edge{stroke:#475569;stroke-width:1.6;fill:none}",
  ".d-edge-label{fill:#475569;font-size:11px}.d-axis{stroke:#94a3b8;stroke-width:3}.d-dot{fill:#4f46e5;stroke:#fff;stroke-width:2}",
  ".d-when{font-weight:700;fill:#4f46e5}.d-muted{fill:#64748b;font-size:11px}.d-actor{fill:#f1f5f9;stroke:#334155;stroke-width:1.4}",
  ".d-life{stroke:#cbd5e1;stroke-width:1.4;stroke-dasharray:4 4}.d-msg{stroke:#334155;stroke-width:1.5;fill:none}.d-reply{stroke-dasharray:6 4}",
].join("");

function open(cls: string, w: number, h: number, o: RenderOptions, fontSize = 12.5): string {
  return `<svg class="diagram ${cls}" viewBox="0 0 ${n(w)} ${n(h)}" width="${n(w)}" height="${n(h)}" xmlns="http://www.w3.org/2000/svg" font-size="${fontSize}" role="img">`
    + (o.standalone ? `<style>${DIAGRAM_CSS}</style>` : "")
    + `<defs><marker id="fm-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">`
    + `<path d="M0,0 L10,5 L0,10 z" fill="#475569"/></marker></defs>`;
}

/** Greedy word wrap; long single words are cut. */
export function wrap(text: unknown, width: number, maxLines: number): string[] {
  const lines: string[] = [];
  let cur = "";
  for (const w of String(text ?? "").split(/\s+/).filter(Boolean)) {
    if ((cur + " " + w).trim().length > width && cur) { lines.push(cur); cur = w; } else cur = `${cur} ${w}`.trim();
  }
  if (cur) lines.push(cur);
  const out = lines.slice(0, maxLines).map((l) => (l.length > width ? l.slice(0, width - 1) + "…" : l));
  if (lines.length > maxLines) out[maxLines - 1] = out[maxLines - 1]!.replace(/.?$/, "…");
  return out;
}

const textLines = (lines: string[], x: number, cy: number, cls: string, lh = 15) =>
  lines.map((l, i) => `<text x="${n(x)}" y="${n(cy - ((lines.length - 1) * lh) / 2 + i * lh + 4)}" text-anchor="middle" class="${cls}">${esc(l)}</text>`).join("");

// ---------------------------------------------------------------- Ishikawa (fishbone)

export interface Fishbone {
  problem: string;
  categories: Record<string, string[]> | { name: string; causes: string[] }[];
}

export function fishboneSvg(f: Fishbone, o: RenderOptions = {}): string {
  const entries: [string, string[]][] = Array.isArray(f.categories)
    ? f.categories.map((c) => [c.name, c.causes ?? []])
    : Object.entries(f.categories ?? {});
  const cats = entries.slice(0, 8).map(([nm, cs]) => [String(nm).slice(0, 40), (cs ?? []).slice(0, 6).map(String)] as [string, string[]]);
  const W = 1320, H = 560, spine = 280, headW = 220, x0 = 230, x1 = W - headW - 20; // x0 leaves room for left-most cause labels
  const top = cats.filter((_, i) => i % 2 === 0), bottom = cats.filter((_, i) => i % 2 === 1);
  const cols = Math.max(top.length, bottom.length, 1);
  const step = (x1 - x0) / cols;
  const maxChars = Math.max(14, Math.floor((step - 70) / 6.6));
  const out: string[] = [
    open("fishbone", W, H, o).replace(` width="${W}" height="${H}"`, ""),
    `<line x1="${x0}" y1="${spine}" x2="${x1}" y2="${spine}" class="d-spine"/>`,
    `<polygon points="${x1},${spine - 10} ${x1 + 16},${spine} ${x1},${spine + 10}" class="d-arrow"/>`,
    `<rect x="${x1 + 18}" y="${spine - 55}" width="${headW - 10}" height="110" rx="10" class="d-head"/>`,
  ];
  const lines = wrap(f.problem, 26, 5);
  lines.forEach((l, i, a) => out.push(`<text x="${x1 + 18 + (headW - 10) / 2}" y="${spine - (a.length - 1) * 8 + i * 16 + 4}" text-anchor="middle" class="d-head-text">${esc(l)}</text>`));
  for (const [row, sign] of [[top, -1], [bottom, 1]] as const) {
    row.forEach(([name, causes], i) => {
      const bx = x0 + step * (i + 0.85), tx = bx - 85, ty = spine + sign * 215;
      out.push(`<line x1="${n(bx)}" y1="${spine}" x2="${n(tx)}" y2="${ty}" class="d-bone"/>`);
      out.push(`<text x="${n(tx)}" y="${ty + (sign < 0 ? -10 : 20)}" text-anchor="middle" class="d-cat">${esc(name)}</text>`);
      causes.forEach((c, j) => {
        const t = (j + 1) / (causes.length + 1), cx = bx + (tx - bx) * t, cy = spine + (ty - spine) * t;
        const status = /confirmed/i.test(c) ? " d-confirmed" : /ruled out/i.test(c) ? " d-ruled" : "";
        out.push(`<line x1="${n(cx)}" y1="${n(cy)}" x2="${n(cx - 60)}" y2="${n(cy)}" class="d-sub"/>`);
        // Wrap to the space before the next bone on the left, so labels never cross it.
        const lines = wrap(c, maxChars, 2);
        const tspans = lines.map((l, k) => `<tspan x="${n(cx - 64)}" dy="${k === 0 ? n(4 - (lines.length - 1) * 7) : 14}">${esc(l)}</tspan>`).join("");
        out.push(`<text x="${n(cx - 64)}" y="${n(cy)}" text-anchor="end" class="d-cause${status}">${tspans}</text>`);
      });
    });
  }
  out.push("</svg>");
  return out.join("");
}

// ---------------------------------------------------------------- Flowchart (top → bottom, layered)

export interface Flowchart {
  nodes: { id: string; label: string; kind?: "start" | "end" | "step" | "decision" }[];
  edges: { from: string; to: string; label?: string }[];
}

export function flowchartSvg(f: Flowchart, o: RenderOptions = {}): string {
  const nodes = (f.nodes ?? []).slice(0, 40);
  const ids = new Set(nodes.map((x) => x.id));
  const edges = (f.edges ?? []).filter((e) => ids.has(e.from) && ids.has(e.to)).slice(0, 80);
  // Rank = longest path from a source, ignoring edges that close a cycle (loops back up are drawn on the side).
  const rank = new Map<string, number>(nodes.map((x) => [x.id, 0]));
  const order = new Map(nodes.map((x, i) => [x.id, i]));
  const forward = edges.filter((e) => order.get(e.to)! > order.get(e.from)!);
  for (let pass = 0; pass < nodes.length; pass++) {
    let changed = false;
    for (const e of forward) if (rank.get(e.to)! < rank.get(e.from)! + 1) { rank.set(e.to, rank.get(e.from)! + 1); changed = true; }
    if (!changed) break;
  }
  const rows: string[][] = [];
  for (const x of nodes) (rows[rank.get(x.id)!] ??= []).push(x.id);
  const NW = 190, NH = 52, GX = 50, GY = 46, PAD = 40;
  const widest = Math.max(1, ...rows.map((r) => r?.length ?? 0));
  const W = PAD * 2 + widest * NW + (widest - 1) * GX + 80;
  const rowH = NH + 18 + GY;
  const H = PAD * 2 + rows.length * rowH - GY;
  const pos = new Map<string, { x: number; y: number }>();
  rows.forEach((r, ri) => (r ?? []).forEach((id, i) => {
    const rowW = r.length * NW + (r.length - 1) * GX;
    pos.set(id, { x: (W - rowW) / 2 + i * (NW + GX) + NW / 2, y: PAD + ri * rowH + (NH + 18) / 2 });
  }));
  const out: string[] = [open("flowchart", W, H, o)];
  for (const e of edges) {
    const a = pos.get(e.from)!, b = pos.get(e.to)!;
    const down = b.y > a.y;
    const half = (id: string) => (nodes.find((x) => x.id === id)?.kind === "decision" ? (NH + 18) / 2 : NH / 2);
    let d: string, lx: number, ly: number;
    if (down) {
      const y1 = a.y + half(e.from), y2 = b.y - half(e.to) - 2, my = (y1 + y2) / 2;
      d = `M${n(a.x)},${n(y1)} C${n(a.x)},${n(my)} ${n(b.x)},${n(my)} ${n(b.x)},${n(y2)}`;
      lx = (a.x + b.x) / 2 + 6; ly = my - 4;
    } else { // loop back: leave on the right, come in on the right
      const side = Math.max(a.x, b.x) + NW / 2 + 30;
      d = `M${n(a.x + NW / 2)},${n(a.y)} C${n(side)},${n(a.y)} ${n(side)},${n(b.y)} ${n(b.x + NW / 2 + 2)},${n(b.y)}`;
      lx = side + 4; ly = (a.y + b.y) / 2;
    }
    out.push(`<path d="${d}" class="d-edge" marker-end="url(#fm-arrow)"/>`);
    if (e.label) out.push(`<text x="${n(lx)}" y="${n(ly)}" class="d-edge-label">${esc(String(e.label).slice(0, 24))}</text>`);
  }
  for (const x of nodes) {
    const p = pos.get(x.id)!, k = x.kind ?? "step";
    if (k === "decision") {
      const hw = NW / 2 + 6, hh = (NH + 18) / 2;
      out.push(`<polygon points="${n(p.x)},${n(p.y - hh)} ${n(p.x + hw)},${n(p.y)} ${n(p.x)},${n(p.y + hh)} ${n(p.x - hw)},${n(p.y)}" class="d-node d-decision"/>`);
      out.push(textLines(wrap(x.label, 20, 2), p.x, p.y, "d-label"));
    } else {
      const rx = k === "start" || k === "end" ? NH / 2 : 8;
      out.push(`<rect x="${n(p.x - NW / 2)}" y="${n(p.y - NH / 2)}" width="${NW}" height="${NH}" rx="${rx}" class="d-node d-${k}"/>`);
      out.push(textLines(wrap(x.label, 24, 2), p.x, p.y, "d-label"));
    }
  }
  out.push("</svg>");
  return out.join("");
}

// ---------------------------------------------------------------- Timeline (left → right)

export interface Timeline {
  events: { when: string; label: string; detail?: string }[];
}

export function timelineSvg(t: Timeline, o: RenderOptions = {}): string {
  const ev = (t.events ?? []).slice(0, 24);
  const STEP = 170, PAD = 90, H = 270, axis = 135;
  const W = Math.max(720, PAD * 2 + Math.max(0, ev.length - 1) * STEP);
  const step = ev.length > 1 ? (W - PAD * 2) / (ev.length - 1) : 0;
  const out: string[] = [open("timeline", W, H, o), `<line x1="${PAD - 40}" y1="${axis}" x2="${W - PAD + 40}" y2="${axis}" class="d-axis" marker-end="url(#fm-arrow)"/>`];
  ev.forEach((e, i) => {
    const x = ev.length > 1 ? PAD + i * step : W / 2, up = i % 2 === 0, s = up ? -1 : 1;
    out.push(`<line x1="${n(x)}" y1="${axis}" x2="${n(x)}" y2="${axis + s * 34}" class="d-sub"/>`);
    out.push(`<circle cx="${n(x)}" cy="${axis}" r="7" class="d-dot"/>`);
    const base = axis + s * 50;
    const label = wrap(e.label, 22, 2), detail = e.detail ? wrap(e.detail, 26, 2) : [];
    const block = [{ t: e.when, c: "d-when" }, ...label.map((l) => ({ t: l, c: "d-label" })), ...detail.map((l) => ({ t: l, c: "d-muted" }))];
    const ys = block.map((_, j) => (up ? base - (block.length - 1 - j) * 15 : base + 10 + j * 15));
    block.forEach((b, j) => out.push(`<text x="${n(x)}" y="${n(ys[j]!)}" text-anchor="middle" class="${b.c}">${esc(b.t)}</text>`));
  });
  out.push("</svg>");
  return out.join("");
}

// ---------------------------------------------------------------- Sequence diagram

export interface Sequence {
  participants: string[];
  messages: { from: string; to: string; label: string; reply?: boolean }[];
}

export function sequenceSvg(q: Sequence, o: RenderOptions = {}): string {
  const ps = [...new Set((q.participants ?? []).map(String))].slice(0, 10);
  for (const m of q.messages ?? []) for (const p of [m.from, m.to]) if (!ps.includes(p) && ps.length < 10) ps.push(p);
  const msgs = (q.messages ?? []).filter((m) => ps.includes(m.from) && ps.includes(m.to)).slice(0, 40);
  const COL = 190, PAD = 40, BOXW = 150, BOXH = 40, ROW = 46, top = PAD + BOXH;
  const W = PAD * 2 + Math.max(1, ps.length) * COL - (COL - BOXW);
  const H = top + 30 + msgs.length * ROW + 20;
  const x = (p: string) => PAD + ps.indexOf(p) * COL + BOXW / 2;
  const out: string[] = [open("sequence", W, H, o)];
  for (const p of ps) {
    out.push(`<line x1="${n(x(p))}" y1="${top}" x2="${n(x(p))}" y2="${H - 10}" class="d-life"/>`);
    out.push(`<rect x="${n(x(p) - BOXW / 2)}" y="${PAD}" width="${BOXW}" height="${BOXH}" rx="8" class="d-actor"/>`);
    out.push(textLines(wrap(p, 20, 2), x(p), PAD + BOXH / 2, "d-label", 13));
  }
  msgs.forEach((m, i) => {
    const y = top + 36 + i * ROW, a = x(m.from), b = x(m.to), cls = `d-msg${m.reply ? " d-reply" : ""}`;
    const label = esc(String(m.label ?? "").slice(0, 44));
    if (a === b) {
      out.push(`<path d="M${n(a)},${n(y - 8)} h40 v18 h-38" class="${cls}" marker-end="url(#fm-arrow)"/>`);
      out.push(`<text x="${n(a + 46)}" y="${n(y + 4)}" class="d-edge-label">${label}</text>`);
    } else {
      out.push(`<line x1="${n(a)}" y1="${n(y)}" x2="${n(b + (b > a ? -2 : 2))}" y2="${n(y)}" class="${cls}" marker-end="url(#fm-arrow)"/>`);
      out.push(`<text x="${n((a + b) / 2)}" y="${n(y - 7)}" text-anchor="middle" class="d-edge-label">${label}</text>`);
    }
  });
  out.push("</svg>");
  return out.join("");
}

// ---------------------------------------------------------------- Dispatcher for the agent tool

export const DIAGRAM_KINDS = ["ishikawa", "flowchart", "timeline", "sequence"] as const;
export type DiagramKind = (typeof DIAGRAM_KINDS)[number];

/** Standalone SVG for an HTML report. Throws on an unknown kind or a spec that is not an object. */
export function renderDiagram(kind: string, spec: unknown): string {
  const s = (typeof spec === "string" ? JSON.parse(spec) : spec) as Record<string, unknown>;
  if (!s || typeof s !== "object") throw new Error("spec must be a JSON object");
  const o = { standalone: true };
  switch (kind === "fishbone" ? "ishikawa" : kind) {
    case "ishikawa": return fishboneSvg(s as unknown as Fishbone, o);
    case "flowchart": return flowchartSvg(s as unknown as Flowchart, o);
    case "timeline": return timelineSvg(s as unknown as Timeline, o);
    case "sequence": return sequenceSvg(s as unknown as Sequence, o);
    default: throw new Error(`unknown diagram kind "${kind}" (use ${DIAGRAM_KINDS.join(", ")})`);
  }
}
