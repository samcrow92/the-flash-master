/**
 * Deliverable check after an agent's turn: the app, not the model, verifies that HTML reports were written and carry
 * diagrams. A miss is turned into a follow-up instruction the orchestrator sends back to the same agent, so the rule holds
 * on every harness and whatever project or harness instruction files the CLI loaded.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

export interface ReportCheckInput {
  /** Folder the agent works in; null = no project folder (only artifacts count). */
  workDir: string | null;
  /** Turn start (ms): files modified at or after this count as written in the turn. */
  since: number;
  /** The agent's reply text (paths of .html files it mentions are checked too). */
  text: string;
  /** Role deliverables, e.g. ["html-report", "ishikawa"]. */
  requires: string[];
  /** Settings → Agents → Diagrams in HTML reports. */
  diagrams: boolean;
  /** HTML stored with save_artifact during the turn. */
  artifacts: { id: string; title: string; content: string }[];
}

export interface ReportCheckResult {
  /** HTML reports found for this turn (relative paths or artifact:<id>). */
  reports: string[];
  /** What is missing, one line each; empty = all good. */
  problems: string[];
}

const SKIP = new Set(["node_modules", ".git", ".svn", "out", "dist", "build", ".venv", "venv", "__pycache__", ".next", "target", "coverage"]);
const MAX_FILES = 4000, MAX_DEPTH = 5, MAX_READ = 2_000_000;

/** .html files under dir modified at or after `since` (bounded walk; build output and dependencies are skipped). */
export function recentHtml(dir: string, since: number): string[] {
  const out: string[] = [];
  let seen = 0;
  const walk = (d: string, depth: number) => {
    if (depth > MAX_DEPTH || seen > MAX_FILES) return;
    let entries: import("node:fs").Dirent[];
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (++seen > MAX_FILES) return;
      const p = join(d, e.name);
      if (e.isDirectory()) { if (!SKIP.has(e.name)) walk(p, depth + 1); continue; }
      if (!e.isFile() || !/\.html?$/i.test(e.name)) continue;
      try { if (statSync(p).mtimeMs >= since - 1000) out.push(p); } catch { /* vanished */ }
    }
  };
  walk(dir, 0);
  return out;
}

/** .html paths the reply mentions that exist inside the work folder. */
export function mentionedHtml(text: string, workDir: string | null): string[] {
  if (!workDir) return [];
  const out = new Set<string>();
  for (const m of text.matchAll(/(?:[A-Za-z]:)?[\w./\\~-]*[\w-]\.html?\b/gi)) {
    const p = isAbsolute(m[0]) ? m[0] : resolve(workDir, m[0]);
    const rel = relative(workDir, p);
    if (rel.startsWith("..") || isAbsolute(rel)) continue;
    if (existsSync(p)) out.add(p);
  }
  return [...out];
}

const svgCount = (html: string) => (html.match(/<svg[\s>]/gi) ?? []).length;
const hasIshikawa = (html: string) => /class="[^"]*\bfishbone\b/i.test(html) || (svgCount(html) > 0 && /ishikawa|fishbone/i.test(html));
const looksLikeHtml = (s: string) => /<(?:!doctype html|html|body|svg)[\s>]/i.test(s);

export function checkReports(i: ReportCheckInput): ReportCheckResult {
  const needReport = i.requires.includes("html-report");
  const needIshikawa = i.requires.includes("ishikawa");
  if (!needReport && !i.diagrams) return { reports: [], problems: [] };
  const files = new Set(mentionedHtml(i.text, i.workDir));
  // Report roles: any HTML written in the turn counts, mentioned or not. Other agents: only the files they point to,
  // so editing a web app's index.html is never mistaken for a report.
  if (needReport && i.workDir) for (const f of recentHtml(i.workDir, i.since)) files.add(f);
  const docs: { name: string; html: string }[] = [];
  for (const f of [...files].slice(0, 12)) {
    try {
      if (statSync(f).size <= MAX_READ) docs.push({ name: i.workDir ? relative(i.workDir, f).replace(/\\/g, "/") : f, html: readFileSync(f, "utf8") });
    } catch { /* unreadable: ignore */ }
  }
  for (const a of i.artifacts) if (looksLikeHtml(a.content)) docs.push({ name: `artifact:${a.id}`, html: a.content });
  const problems: string[] = [];
  if (needReport && !docs.length) {
    problems.push("No HTML report was written. Your instructions require the result as a self-contained .html report file "
      + "(or, only if you cannot write files, the full HTML stored with save_artifact). A .md file or a chat reply does not count.");
  }
  if (i.diagrams || needIshikawa) {
    const bare = docs.filter((d) => svgCount(d.html) === 0).map((d) => d.name);
    if (bare.length) problems.push(`These HTML files have no diagrams: ${bare.join(", ")}. Add inline SVG diagrams (diagram_svg tool) where they help.`);
  }
  if (needIshikawa && docs.length && !docs.some((d) => hasIshikawa(d.html))) {
    problems.push("The report has no Ishikawa (fishbone) diagram of the causes. Add it with diagram_svg kind ishikawa.");
  }
  return { reports: docs.map((d) => d.name), problems };
}

/** The follow-up the app sends back to the agent when its turn missed a required deliverable. */
export function reportFixPrompt(r: ReportCheckResult, roleTitle: string): string {
  return `TheFlashMaster checked your result and it does not yet meet your ${roleTitle} instructions:\n`
    + r.problems.map((p) => `- ${p}`).join("\n")
    + "\n\nFix this now: write or update the HTML report in the project (self-contained, inline CSS, diagrams inserted with the diagram_svg tool), "
    + "then reply with the report path and your result block. Don't ask for confirmation.";
}
