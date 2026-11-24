/**
 * Traceability: requirement → test → result, from whatever tools a team uses. Sources are pluggable and offline:
 * requirement lists (CSV / JSON / ReqIF exported from DOORS, Polarion, Jama, Codebeamer…, or cached DOORS Next modules),
 * requirement tags in test code (@req REQ-12, Verifies: 4711), and test results (JUnit XML, which most runners and
 * CANoe / VectorCAST / Tessy can write). The matrix says per requirement whether it is verified, failing, untested or
 * uncovered; the evidence report is a self-contained HTML page with diagrams.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";
import type { Requirement, TraceItem, TraceMatrix, TraceRow, TraceSourceStatus, TraceStatus } from "@shared/types";

export const TRACE_DIR = ".flashmaster/trace";
/** After a marker (@req, Verifies:, Covers:, Requirement:) an id such as REQ-12, SWR_BRK-4 or a DOORS number. */
export const DEFAULT_TAG_PATTERN = String.raw`(?:@req(?:uirement)?s?|Verifies|Covers|Requirements?|Satisfies)\s*[:=]?\s*((?:[A-Za-z][\w.]*[-_]\d+|\d{3,})(?:\s*,\s*(?:[A-Za-z][\w.]*[-_]\d+|\d{3,}))*)`;

const SKIP_DIRS = new Set(["node_modules", ".git", ".wt", "dist", "out", "build-cache", ".venv", "venv", "__pycache__", ".idea", ".vscode"]);
const TEST_EXT = new Set([".c", ".cc", ".cpp", ".h", ".hpp", ".py", ".ts", ".tsx", ".js", ".mjs", ".cs", ".java", ".kt", ".go", ".rs", ".can", ".cin", ".robot", ".feature"]);

export interface TraceSource {
  id: string;
  label: string;
  load(projectPath: string): TraceItem[];
}

// ---------- files ----------

function walk(root: string, rel: string, depth: number, out: string[], accept: (f: string) => boolean, max = 4000): string[] {
  if (depth > 8 || out.length >= max) return out;
  let entries: import("node:fs").Dirent[];
  try { entries = readdirSync(join(root, rel), { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (out.length >= max) break;
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name) && !e.name.startsWith(".")) walk(root, r, depth + 1, out, accept, max); }
    else if (accept(r)) out.push(r);
  }
  return out;
}

const read = (f: string) => { try { return readFileSync(f, "utf8"); } catch { return ""; } };

/** RFC 4180-ish CSV (quotes, doubled quotes, commas or semicolons). */
export function parseCsv(text: string): Record<string, string>[] {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  const sep = (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ";" : ",";
  const rows: string[][] = [];
  let row: string[] = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') q = false; else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === sep) { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") { if (ch === "\r" && text[i + 1] === "\n") i++; row.push(cell); rows.push(row); row = []; cell = ""; }
    else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const [head, ...body] = rows.filter((r) => r.some((c) => c.trim()));
  if (!head) return [];
  const keys = head.map((h) => h.trim().toLowerCase());
  return body.map((r) => Object.fromEntries(keys.map((k, i) => [k, (r[i] ?? "").trim()])));
}

const pick = (r: Record<string, string>, ...names: string[]) => names.map((n) => r[n]).find((v) => v !== undefined && v !== "") ?? "";
const splitIds = (s: string) => s.split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean);

/** Requirements and tests from .flashmaster/trace/*.csv and *.json. A row with a verifies column is a test. */
export const fileSource: TraceSource = {
  id: "files", label: "Trace files (.flashmaster/trace: CSV, JSON)",
  load(root) {
    const dir = join(root, TRACE_DIR);
    if (!existsSync(dir)) return [];
    const out: TraceItem[] = [];
    for (const f of readdirSync(dir).filter((x) => /\.(csv|json)$/i.test(x)).sort()) {
      const where = `${TRACE_DIR}/${f}`;
      let rows: Record<string, string>[];
      if (f.toLowerCase().endsWith(".json")) {
        try {
          const j = JSON.parse(read(join(dir, f)));
          const list = Array.isArray(j) ? j : [...(j.requirements ?? []).map((r: object) => ({ ...r })), ...(j.tests ?? []).map((t: object) => ({ kind: "test", ...t }))];
          rows = list.map((r: Record<string, unknown>) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v.join(",") : String(v ?? "")])));
        } catch { continue; }
      } else rows = parseCsv(read(join(dir, f)));
      for (const r of rows) {
        const id = pick(r, "id", "identifier", "req id", "requirement id", "test id", "key");
        if (!id) continue;
        const verifies = splitIds(pick(r, "verifies", "requirements", "requirement", "covers", "links"));
        const isTest = !!verifies.length || /test/i.test(pick(r, "kind", "type"));
        out.push({ id, kind: isTest ? "test" : "requirement", title: pick(r, "title", "name", "summary", "text", "description") || id, source: "trace files", where, links: verifies });
      }
    }
    return out;
  },
};

/** ReqIF (the requirements exchange format DOORS, Polarion, Jama, Codebeamer and PTC export): SPEC-OBJECTS with their attributes. */
export function parseReqif(xml: string, where: string): TraceItem[] {
  const defs = new Map<string, string>();
  for (const m of xml.matchAll(/<ATTRIBUTE-DEFINITION-[\w-]+\b[^>]*\bIDENTIFIER="([^"]+)"[^>]*\bLONG-NAME="([^"]*)"/g)) defs.set(m[1]!, m[2]!.toLowerCase());
  for (const m of xml.matchAll(/<ATTRIBUTE-DEFINITION-[\w-]+\b[^>]*\bLONG-NAME="([^"]*)"[^>]*\bIDENTIFIER="([^"]+)"/g)) defs.set(m[2]!, m[1]!.toLowerCase());
  const out: TraceItem[] = [];
  for (const so of xml.matchAll(/<SPEC-OBJECT\b([^>]*)>([\s\S]*?)<\/SPEC-OBJECT>/g)) {
    const ident = /\bIDENTIFIER="([^"]+)"/.exec(so[1]!)?.[1] ?? "";
    const attrs: Record<string, string> = {};
    for (const v of so[2]!.matchAll(/<ATTRIBUTE-VALUE-(STRING|XHTML|INTEGER|ENUMERATION)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/ATTRIBUTE-VALUE-\1>)/g)) {
      const ref = /<ATTRIBUTE-DEFINITION-[\w-]+-REF>([^<]+)</.exec(v[3] ?? "")?.[1]?.trim() ?? "";
      const name = defs.get(ref) ?? ref.toLowerCase();
      const val = /\bTHE-VALUE="([^"]*)"/.exec(v[2]!)?.[1] ?? (v[3] ?? "").replace(/<ATTRIBUTE-DEFINITION[\s\S]*?<\/DEFINITION>/, "").replace(/<[^>]+>/g, " ");
      if (name) attrs[name] = decode(val).replace(/\s+/g, " ").trim();
    }
    const id = attrs["reqif.foreignid"] || attrs["id"] || attrs["identifier"] || attrs["object identifier"] || attrs["absolute number"] || ident;
    if (!id) continue;
    const title = attrs["reqif.name"] || attrs["reqif.chaptername"] || attrs["title"] || attrs["name"] || attrs["reqif.text"] || attrs["text"] || attrs["object text"] || id;
    out.push({ id, kind: "requirement", title: title.slice(0, 300), source: "reqif", where, links: [] });
  }
  return out;
}
const decode = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/&amp;/g, "&");

export const reqifSource: TraceSource = {
  id: "reqif", label: "ReqIF exports (.flashmaster/trace/*.reqif)",
  load(root) {
    const dir = join(root, TRACE_DIR);
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter((f) => /\.reqif$/i.test(f)).sort().flatMap((f) => parseReqif(read(join(dir, f)), `${TRACE_DIR}/${f}`));
  },
};

/** Cached DOORS Next modules (Jazz → Requirements): no network call, only what was loaded before. */
export function doorsSource(modules: () => { module: { title: string }; requirements: Requirement[] }[]): TraceSource {
  return {
    id: "doors", label: "DOORS Next (cached modules)",
    load: () => modules().flatMap((m) => m.requirements.filter((r) => !r.heading).map((r) => ({ id: r.id, kind: "requirement" as const, title: (r.title || r.text).slice(0, 300),
      source: "doors", where: r.uri, links: [] }))),
  };
}

const TEST_DECL: RegExp[] = [
  /\bTEST(?:_F|_P)?\s*\(\s*\w+\s*,\s*(\w+)\s*\)/, // GoogleTest
  /^\s*(?:async\s+)?def\s+(test\w*)\s*\(/, // pytest
  /\b(?:it|test)\s*\(\s*["'`]([^"'`]+)["'`]/, // vitest / jest / mocha
  /^\s*(?:static\s+)?void\s+(test\w*)\s*\(\s*(?:void)?\s*\)/, // Unity / CMock
  /^\s*testcase\s+(\w+)\s*\(/, // CAPL test cases
  /^\s*(?:public\s+)?(?:void|async\s+Task)\s+(\w*[Tt]est\w*)\s*\(/, // xUnit / JUnit
  /^\s*func\s+(Test\w+)\s*\(/, // Go
  /^\s*Scenario:\s*(.+)$/, // Gherkin
];

/** Tests from requirement tags in test code: each tag belongs to the test declared nearest above it (or the file's first one). */
export function codeTagSource(pattern = DEFAULT_TAG_PATTERN): TraceSource {
  return {
    id: "code", label: "Requirement tags in tests (@req, Verifies:)",
    load(root) {
      let re: RegExp;
      try { re = new RegExp(pattern, "gi"); } catch { re = new RegExp(DEFAULT_TAG_PATTERN, "gi"); }
      const files = walk(root, "", 0, [], (r) => TEST_EXT.has(extname(r).toLowerCase()) && /(^|\/)(tests?|spec|__tests__|unittest|test_\w+|\w+_test|\w+\.test|\w+\.spec)[./]/i.test(r));
      const tests = new Map<string, TraceItem>();
      for (const f of files) {
        const lines = read(join(root, f)).split(/\r?\n/);
        if (lines.length > 20_000) continue;
        const decls: { line: number; name: string }[] = [];
        lines.forEach((l, i) => { for (const d of TEST_DECL) { const m = d.exec(l); if (m) { decls.push({ line: i, name: m[1]!.trim() }); break; } } });
        lines.forEach((l, i) => {
          for (const m of l.matchAll(re)) {
            const ids = splitIds(m[1] ?? "");
            if (!ids.length) continue;
            // The test declared nearest above (a tag right above a declaration belongs to it).
            const below = decls.find((d) => d.line > i && d.line - i <= 3);
            const above = [...decls].reverse().find((d) => d.line <= i);
            const owner = below ?? above ?? decls[0] ?? { line: 0, name: f.split("/").pop()! };
            const id = `${f}::${owner.name}`;
            const t = tests.get(id) ?? { id, kind: "test" as const, title: owner.name, source: "code tags", where: `${f}:${owner.line + 1}`, links: [] };
            t.links = [...new Set([...t.links, ...ids])];
            tests.set(id, t);
          }
        });
      }
      return [...tests.values()];
    },
  };
}

/** Test results from JUnit XML (testsuite / testcase with failure, error or skipped). */
export function parseJunit(xml: string, where: string, at = 0): TraceItem[] {
  const out: TraceItem[] = [];
  for (const m of xml.matchAll(/<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const name = decode(/\bname="([^"]*)"/.exec(m[1]!)?.[1] ?? "");
    const cls = decode(/\bclassname="([^"]*)"/.exec(m[1]!)?.[1] ?? "");
    if (!name) continue;
    const body = m[3] ?? "";
    const outcome = /<(failure|error)\b/.test(body) ? "failed" : /<skipped\b/.test(body) ? "skipped" : "passed";
    out.push({ id: `${cls ? `${cls}.` : ""}${name}`, kind: "result", title: name, source: "junit", where, links: [name, ...(cls ? [cls] : [])], outcome, at });
  }
  return out;
}

export const RESULT_DIRS = ["test-results", "reports", "build/test-results", "build/reports", "out/test-results", "TestReports"];
/** The result folders setting (comma, semicolon or line separated); empty = the defaults. */
export const splitDirs = (s?: string | null) => { const l = (s ?? "").split(/[,;\n]+/).map((x) => x.trim()).filter(Boolean); return l.length ? l : RESULT_DIRS; };

export function junitSource(dirs = RESULT_DIRS): TraceSource {
  return {
    id: "junit", label: "Test results (JUnit XML)",
    load(root) {
      const out: TraceItem[] = [];
      for (const d of dirs) {
        const abs = join(root, d);
        if (!existsSync(abs)) continue;
        for (const f of walk(abs, "", 0, [], (r) => r.toLowerCase().endsWith(".xml"), 500)) {
          const file = join(abs, f);
          const xml = read(file);
          if (!/<testsuites?\b/.test(xml)) continue;
          let at = 0;
          try { at = statSync(file).mtimeMs; } catch { /* keep 0 */ }
          out.push(...parseJunit(xml, relative(root, file).replace(/\\/g, "/"), at));
        }
      }
      return out;
    },
  };
}

// ---------- matrix ----------

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

/** Requirement → tests → latest result for each test, and a status per requirement. */
export function buildMatrix(projectId: string, items: TraceItem[], sources: TraceSourceStatus[], now = Date.now()): TraceMatrix {
  const reqs = new Map<string, TraceItem>();
  for (const r of items.filter((i) => i.kind === "requirement")) if (!reqs.has(r.id)) reqs.set(r.id, r);
  const tests = items.filter((i) => i.kind === "test");
  // A result belongs to a test with the same name (test id's last part, or its title), newest result wins.
  const results = items.filter((i) => i.kind === "result").sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
  const resultFor = (t: TraceItem) => {
    const keys = new Set([norm(t.title), norm(t.id.split("::").pop() ?? "")]);
    return results.find((r) => r.links.some((l) => keys.has(norm(l))) || keys.has(norm(r.title)));
  };
  const reqKey = new Map([...reqs.keys()].map((k) => [norm(k), k]));
  const rows: TraceRow[] = [...reqs.values()].map((req) => {
    const ts = tests.filter((t) => t.links.some((l) => reqKey.get(norm(l)) === req.id)).map((t) => ({ ...t, outcome: resultFor(t)?.outcome }));
    const status: TraceStatus = !ts.length ? "uncovered" : ts.some((t) => t.outcome === "failed") ? "failed"
      : ts.every((t) => t.outcome === "passed") ? "verified" : "untested";
    return { req, tests: ts, status };
  });
  const orphanTests = tests.filter((t) => !t.links.some((l) => reqKey.has(norm(l))));
  const counts = { verified: 0, failed: 0, untested: 0, uncovered: 0 } as Record<TraceStatus, number>;
  for (const r of rows) counts[r.status]++;
  return { projectId, at: now, rows, orphanTests, sources, counts };
}

export function collect(projectId: string, root: string, sources: TraceSource[], now = Date.now()): TraceMatrix {
  const items: TraceItem[] = [];
  const status: TraceSourceStatus[] = [];
  for (const s of sources) {
    try { const got = s.load(root); items.push(...got); status.push({ id: s.id, label: s.label, items: got.length, detail: null }); }
    catch (e) { status.push({ id: s.id, label: s.label, items: 0, detail: String((e as Error)?.message ?? e).slice(0, 200) }); }
  }
  return buildMatrix(projectId, items, status, now);
}

/** A compact text view for agents (trace_matrix tool). */
export function matrixText(m: TraceMatrix, filter: "all" | "gaps" = "gaps", max = 80): string {
  const total = m.rows.length;
  const head = `${total} requirements: ${m.counts.verified} verified, ${m.counts.failed} failing, ${m.counts.untested} tested without a result, ${m.counts.uncovered} without a test. ${m.orphanTests.length} tests trace to no known requirement.`;
  const rows = m.rows.filter((r) => filter === "all" || r.status !== "verified").slice(0, max)
    .map((r) => `- ${r.req.id} [${r.status}] ${r.req.title.slice(0, 100)}${r.tests.length ? ` ← ${r.tests.map((t) => `${t.title}${t.outcome ? ` (${t.outcome})` : ""}`).join(", ")}` : ""}`);
  return [head, ...rows].join("\n");
}

// ---------- evidence report ----------

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const COLORS: Record<TraceStatus, string> = { verified: "#2fb36b", failed: "#e5484d", untested: "#e0a100", uncovered: "#8a8f98" };
const LABEL: Record<TraceStatus, string> = { verified: "Verified", failed: "Failing", untested: "Tested, no result", uncovered: "No test" };
const ORDER: TraceStatus[] = ["verified", "failed", "untested", "uncovered"];

function donut(m: TraceMatrix): string {
  const total = Math.max(1, m.rows.length);
  let a = -Math.PI / 2;
  const arcs = ORDER.filter((s) => m.counts[s]).map((s) => {
    const frac = m.counts[s] / total;
    const a2 = a + frac * Math.PI * 2;
    const large = frac > 0.5 ? 1 : 0;
    const p = (ang: number, r: number) => `${(90 + r * Math.cos(ang)).toFixed(2)} ${(90 + r * Math.sin(ang)).toFixed(2)}`;
    const d = frac >= 0.9999 ? `M 90 20 A 70 70 0 1 1 89.99 20 L 89.99 48 A 42 42 0 1 0 90 48 Z`
      : `M ${p(a, 70)} A 70 70 0 ${large} 1 ${p(a2, 70)} L ${p(a2, 42)} A 42 42 0 ${large} 0 ${p(a, 42)} Z`;
    a = a2;
    return `<path d="${d}" fill="${COLORS[s]}"><title>${LABEL[s]}: ${m.counts[s]}</title></path>`;
  }).join("");
  const pct = Math.round((m.counts.verified / total) * 100);
  return `<svg viewBox="0 0 180 180" width="180" height="180" role="img" aria-label="Verification coverage">${arcs}
    <text x="90" y="88" text-anchor="middle" font-size="26" font-weight="700" fill="currentColor">${pct}%</text>
    <text x="90" y="108" text-anchor="middle" font-size="11" fill="currentColor" opacity=".7">verified</text></svg>`;
}

/** Requirements → tests → results as three columns joined by bands whose width is the number of links. */
function flow(m: TraceMatrix): string {
  const W = 720, H = 260, colW = 150, xs = [20, (W - colW) / 2, W - colW - 20];
  const covered = m.rows.filter((r) => r.tests.length).length;
  const testIds = new Set(m.rows.flatMap((r) => r.tests.map((t) => t.id)));
  const tested = m.rows.flatMap((r) => r.tests);
  const res = { passed: new Set<string>(), failed: new Set<string>(), skipped: new Set<string>(), none: new Set<string>() };
  for (const t of tested) res[t.outcome ?? "none"].add(t.id);
  const box = (x: number, y: number, h: number, label: string, n: number, color: string) =>
    `<rect x="${x}" y="${y}" width="${colW}" height="${Math.max(h, 22)}" rx="8" fill="${color}" opacity=".9"/><text x="${x + 10}" y="${y + 16}" font-size="12" fill="#fff" font-weight="600">${esc(label)} · ${n}</text>`;
  const scale = (n: number, of: number) => Math.max(22, (n / Math.max(1, of)) * (H - 60));
  const covH = scale(covered, m.rows.length), unH = scale(m.rows.length - covered, m.rows.length);
  const tH = scale(testIds.size, Math.max(testIds.size, m.rows.length));
  let y = 20;
  const resBoxes = (["passed", "failed", "skipped", "none"] as const).filter((k) => res[k].size).map((k) => {
    const h = scale(res[k].size, Math.max(1, testIds.size));
    const b = { k, y, h };
    y += h + 10;
    return b;
  });
  const rc = { passed: COLORS.verified, failed: COLORS.failed, skipped: COLORS.untested, none: COLORS.uncovered };
  const rl = { passed: "Passed", failed: "Failed", skipped: "Skipped", none: "No result" };
  // A band from a slice of one box (y1, height h1) to a slice of another (y2, h2).
  const band = (x1: number, y1: number, h1: number, x2: number, y2: number, h2: number, color: string) => {
    const mx = (x1 + x2) / 2;
    return `<path d="M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2} L ${x2} ${y2 + h2} C ${mx} ${y2 + h2}, ${mx} ${y1 + h1}, ${x1} ${y1 + h1} Z" fill="${color}" opacity=".3"/>`;
  };
  let from = 20;
  const resBands = resBoxes.map((b) => {
    const h1 = (res[b.k].size / Math.max(1, testIds.size)) * tH;
    const out = band(xs[1]! + colW, from, h1, xs[2]!, b.y, Math.max(b.h, 22), rc[b.k]);
    from += h1;
    return out;
  }).join("");
  const bottom = Math.max(y - 10, 20 + tH, 20 + covH + (m.rows.length - covered ? 10 + unH : 0));
  return `<svg viewBox="0 0 ${W} ${bottom + 30}" width="100%" role="img" aria-label="Requirements to tests to results">
    ${covered ? band(xs[0]! + colW, 20, covH, xs[1]!, 20, tH, "#3b6fd8") : ""}
    ${resBands}
    ${box(xs[0]!, 20, covH, "Covered", covered, "#3b6fd8")}
    ${m.rows.length - covered ? box(xs[0]!, 20 + covH + 10, unH, "No test", m.rows.length - covered, COLORS.uncovered) : ""}
    ${box(xs[1]!, 20, tH, "Tests", testIds.size, "#6b5bd2")}
    ${resBoxes.map((b) => box(xs[2]!, b.y, b.h, rl[b.k], res[b.k].size, rc[b.k])).join("")}
    <text x="${xs[0]}" y="${bottom + 20}" font-size="11" fill="currentColor" opacity=".7">Requirements (${m.rows.length})</text>
    <text x="${xs[1]}" y="${bottom + 20}" font-size="11" fill="currentColor" opacity=".7">Verifying tests</text>
    <text x="${xs[2]}" y="${bottom + 20}" font-size="11" fill="currentColor" opacity=".7">Latest results</text></svg>`;
}

export function evidenceReport(m: TraceMatrix, meta: { project: string; commit?: string | null }): string {
  const date = new Date(m.at).toISOString().slice(0, 16).replace("T", " ");
  const row = (r: TraceRow) => `<tr class="${r.status}"><td><code>${esc(r.req.id)}</code></td><td>${esc(r.req.title)}</td>
    <td>${r.tests.map((t) => `<div><code>${esc(t.title)}</code> <span class="o ${t.outcome ?? "none"}">${t.outcome ?? "no result"}</span>${t.where ? ` <span class="w">${esc(t.where)}</span>` : ""}</div>`).join("") || "<span class=\"w\">—</span>"}</td>
    <td><span class="s" style="background:${COLORS[r.status]}">${LABEL[r.status]}</span></td></tr>`;
  const gaps = m.rows.filter((r) => r.status !== "verified");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Verification evidence · ${esc(meta.project)}</title>
<style>
:root{color-scheme:light dark;--fg:#1b1d22;--bg:#fff;--mut:#6b7280;--line:#e5e7eb}
@media (prefers-color-scheme:dark){:root{--fg:#e8e9ec;--bg:#14161a;--mut:#9aa0aa;--line:#2a2e35}}
body{font:14px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;color:var(--fg);background:var(--bg);margin:0;padding:32px;max-width:1100px}
h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:28px 0 8px}.mut{color:var(--mut)}
.top{display:flex;gap:28px;align-items:center;flex-wrap:wrap}.legend div{margin:3px 0}.dot{display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:6px}
table{border-collapse:collapse;width:100%;font-size:13px}td,th{border-bottom:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top}
.s{color:#fff;border-radius:999px;padding:1px 8px;font-size:12px;white-space:nowrap}.o{font-size:11px;padding:0 6px;border-radius:6px;border:1px solid var(--line)}
.o.failed{color:#e5484d}.o.passed{color:#2fb36b}.w{color:var(--mut);font-size:11px}code{font-size:12px}
</style></head><body>
<h1>Verification evidence: ${esc(meta.project)}</h1>
<div class="mut">Generated ${date} UTC${meta.commit ? ` at commit <code>${esc(meta.commit.slice(0, 12))}</code>` : ""} by TheFlashMaster. Sources: ${m.sources.map((s) => `${esc(s.label)} (${s.items})`).join(", ")}.</div>
<h2>Summary</h2>
<p class="mut">How many requirements are verified by a passing test, as ISO 26262-8 §6 / ASPICE SWE.6 and SYS.5 expect bidirectional traceability between requirements, tests and results.</p>
<div class="top">${donut(m)}<div class="legend">${ORDER.map((s) => `<div><span class="dot" style="background:${COLORS[s]}"></span>${LABEL[s]}: <b>${m.counts[s]}</b></div>`).join("")}
<div class="mut" style="margin-top:8px">${m.orphanTests.length} test${m.orphanTests.length === 1 ? "" : "s"} trace to no known requirement.</div></div></div>
<h2>Traceability flow</h2>
<p class="mut">Requirements, the tests that verify them and the latest result of each test.</p>
${flow(m)}
<h2>Gaps (${gaps.length})</h2>
${gaps.length ? `<table><thead><tr><th>Requirement</th><th>Title</th><th>Tests</th><th>Status</th></tr></thead><tbody>${gaps.map(row).join("")}</tbody></table>` : "<p>None: every requirement is verified by a passing test.</p>"}
<h2>Full matrix (${m.rows.length})</h2>
<table><thead><tr><th>Requirement</th><th>Title</th><th>Tests</th><th>Status</th></tr></thead><tbody>${m.rows.map(row).join("")}</tbody></table>
${m.orphanTests.length ? `<h2>Tests without a known requirement (${m.orphanTests.length})</h2><table><tbody>${m.orphanTests.map((t) => `<tr><td><code>${esc(t.title)}</code></td><td>${esc(t.links.join(", ") || "no tag")}</td><td class="w">${esc(t.where ?? "")}</td></tr>`).join("")}</tbody></table>` : ""}
</body></html>`;
}
